// Pipeline orchestrator (design.md "Data Flow — src/pipeline/run.ts"). This
// is the FIRST place in the whole project that wires ingestion, entity
// resolution, enrichment, and thesis scoring together against a real
// repository — every prior phase built and tested these pieces in
// isolation. `src/pipeline/**` is infrastructure/composition, NOT under the
// core-layer ESLint boundary (eslint.config.js CORE_LAYER_GLOBS) — it is
// allowed to depend on ports AND on other infra (db/repository.ts is not
// imported here, but it's legal if it ever needs to be). No `new` on a
// concrete repository/adapter/provider class happens in this file — every
// dependency arrives via the `RunPipelineDeps` parameter object, matching
// design.md's composition-root discipline (this file itself is not the
// composition root — src/cli.ts is — it only consumes injected deps).

import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type {
  Company,
  CompanyId,
  RunId,
  RunStats,
  RunStatus,
  ScoredDeal,
  Signal,
  SourceName,
  SourceRecord,
} from '../domain/entities.js';
import type {
  CompanyRepository,
  EmbeddingProvider,
  EnrichmentResult,
  LlmProvider,
  RunRepository,
  ScoredDealRepository,
  SourceAdapter,
  SourceRecordRepository,
} from '../domain/ports.js';
import type { Thesis } from '../domain/thesis.js';
import { normalizeDomain } from '../resolution/normalize.js';
import {
  resolveFieldConflict,
  scorePair,
  type FieldObservation,
  type MatchConfidence,
  type PairCandidate,
} from '../resolution/resolver.js';
import { scoreCompanies } from '../scoring/scorer.js';

// ---------------------------------------------------------------------------
// Logging — minimal structural subset of pino's Logger, same convention as
// sources/github.ts's own LoggerLike (spec §9: "Logs estructurados con
// runId en todas las líneas" — every call site below passes `runId`
// explicitly in the first arg rather than using a child logger, keeping
// this interface's shape identical to the one already established).
// ---------------------------------------------------------------------------

export interface PipelineLogger {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}

// ---------------------------------------------------------------------------
// Blocking-key lookup — DUPLICATED (deliberately, same precedent as
// db/repository.ts's own header comment referencing scoring/scorer.ts's
// cross-module-duplication note) rather than imported from either
// resolution/resolver.ts or src/db/repository.ts.
//
// Discovered gap this phase had to resolve (documented, not silently routed
// around): resolution/resolver.ts's own `blockingKeys()` computes keys from
// the FULL normalizeName/normalizeDomain algorithm (accent-stripping,
// corporate-suffix-stripping). Both CompanyRepository implementations
// (src/db/repository.ts, tests/doubles/in-memory-repository.ts) instead
// compute and STORE keys via a simpler, naive, lowercase-only algorithm —
// documented on both as deliberate ("This module only needs to index and
// look up by whatever keys a caller supplies"). Because `save()` always
// computes storage keys internally with the NAIVE algorithm, a caller that
// queries `findByBlockingKeys` using resolver.ts's RICH algorithm would
// under-match (miss real candidates) whenever normalization diverges from
// naive lowercasing — exactly the kind of case blocking exists to catch
// (corporate suffixes, accents). This function matches the repositories'
// actual STORAGE algorithm so lookups reliably hit what's actually indexed;
// resolver.ts's real `scorePair` (which DOES apply full normalization
// internally) is still used for the actual accept/reject scoring decision
// once a shortlist is fetched — blocking's job is only to shortlist without
// missing true matches, scoring is the real determination. Flagged as a
// pre-existing architecture gap between Phase 4 (resolver.ts) and Phase 5
// (db/repository.ts) that nobody reconciled until this wiring phase; a
// cleaner long-term fix (e.g. repositories accepting externally-computed
// blocking keys, or importing resolution/normalize.ts's real normalizers)
// is out of this phase's scope and noted in the apply report.
// ---------------------------------------------------------------------------

const LOOKUP_TRIGRAM_LENGTH = 3;
const LOOKUP_NAME_PREFIX_LENGTH = 4;

export function computeLookupBlockingKeys(candidate: {
  readonly canonicalName: string;
  readonly domain?: string;
}): readonly string[] {
  const keys = new Set<string>();
  if (candidate.domain) {
    keys.add(`domain:${candidate.domain.toLowerCase()}`);
  }
  const name = candidate.canonicalName.toLowerCase();
  if (name.length >= LOOKUP_NAME_PREFIX_LENGTH) {
    keys.add(`name4:${name.slice(0, LOOKUP_NAME_PREFIX_LENGTH)}`);
  }
  for (let i = 0; i <= name.length - LOOKUP_TRIGRAM_LENGTH; i += 1) {
    keys.add(`trigram:${name.slice(i, i + LOOKUP_TRIGRAM_LENGTH)}`);
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// resolveCanonical — follows a company's `mergedInto` chain to the current
// canonical row (see CompanyRepository.merge's doc comment on ports.ts:
// "merge is a redirect, not a union"). A lookup can land on a company that
// has ITSELF since been absorbed into a later merge, so this loops rather
// than following a single hop. Bounded to guard against a corrupt/cyclic
// chain hanging the pipeline forever instead of surfacing a clear error.
// ---------------------------------------------------------------------------

const MAX_MERGE_CHAIN_HOPS = 25;

export async function resolveCanonical(
  repo: Pick<CompanyRepository, 'findById'>,
  company: Company,
): Promise<Company> {
  let current = company;
  let hops = 0;
  while (current.mergedInto) {
    hops += 1;
    if (hops > MAX_MERGE_CHAIN_HOPS) {
      throw new Error(
        `resolveCanonical: mergedInto chain exceeded ${MAX_MERGE_CHAIN_HOPS} hops ` +
          `starting from company ${company.id} — likely a cycle`,
      );
    }
    const next = await repo.findById(current.mergedInto);
    if (!next) {
      throw new Error(
        `resolveCanonical: company ${current.id} points at mergedInto=` +
          `${current.mergedInto}, which does not exist`,
      );
    }
    current = next;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Field-conflict resolution when attaching a new record onto an EXISTING
// company (spec §8.1 "Field conflicts", resolver.ts's `resolveFieldConflict`
// primitive). `resolveFieldConflict` needs a SOURCE + observedAt for both
// sides of the conflict, but `Company` stores only the current resolved
// value per field — no per-field provenance history. Documented, pragmatic
// approximation: the EXISTING side's provenance is taken from the source of
// the company's most-recently-OBSERVED signal (signals DO carry
// source+observedAt) as a proxy for "who most recently contributed to this
// aggregate". When no signal exists yet to anchor a provenance guess, the
// existing value is kept unchanged rather than guessed at — a safe default,
// not a silent bug. A real per-field-provenance model is future work, out
// of this phase's scope; flagged in the apply report.
// ---------------------------------------------------------------------------

function mostRecentSignalSource(company: Company): SourceName | undefined {
  let best: Signal | undefined;
  for (const signal of company.signals) {
    if (!best || signal.observedAt > best.observedAt) best = signal;
  }
  return best?.source;
}

function mergeConflictingField(
  existing: {
    readonly value: string | undefined;
    readonly source: SourceName | undefined;
    readonly observedAt: string;
  },
  incoming: { readonly value: string | undefined; readonly source: SourceName; readonly observedAt: string },
): string | undefined {
  if (!existing.value) return incoming.value ?? existing.value;
  if (!incoming.value || incoming.value === existing.value) return existing.value;
  if (!existing.source) return existing.value;
  const observations: readonly FieldObservation<string>[] = [
    { value: existing.value, source: existing.source, observedAt: existing.observedAt },
    { value: incoming.value, source: incoming.source, observedAt: incoming.observedAt },
  ];
  return resolveFieldConflict(observations);
}

function dedupe<T>(values: readonly T[]): readonly T[] {
  return Array.from(new Set(values));
}

/** Attaches a new SourceRecord onto an EXISTING (already-canonical) company:
 * resolves field conflicts, unions `people`, sets `merge_incierto` when the
 * match confidence was 'uncertain', and advances `lastSeenAt`. Does NOT
 * persist — caller calls `save`/`linkSourceRecord`/`appendSignals`. */
export function attachRecordToCompany(
  company: Company,
  record: SourceRecord,
  confidence: MatchConfidence,
): Company {
  const extracted = record.extracted;
  const provenanceSource = mostRecentSignalSource(company);
  const existingObservedAt = company.lastSeenAt;

  const canonicalName =
    mergeConflictingField(
      { value: company.canonicalName, source: provenanceSource, observedAt: existingObservedAt },
      { value: extracted.name, source: record.source, observedAt: record.fetchedAt },
    ) ?? company.canonicalName;

  const normalizedIncomingDomain = extracted.domain ? normalizeDomain(extracted.domain) : undefined;
  const domain = mergeConflictingField(
    { value: company.domain, source: provenanceSource, observedAt: existingObservedAt },
    { value: normalizedIncomingDomain, source: record.source, observedAt: record.fetchedAt },
  );

  const description = mergeConflictingField(
    { value: company.description, source: provenanceSource, observedAt: existingObservedAt },
    { value: extracted.description, source: record.source, observedAt: record.fetchedAt },
  );

  const people = dedupe([...(company.people ?? []), ...(extracted.people ?? [])]);
  const flags =
    confidence === 'uncertain' ? dedupe([...company.flags, 'merge_incierto']) : company.flags;
  const lastSeenAt = record.fetchedAt > company.lastSeenAt ? record.fetchedAt : company.lastSeenAt;

  return {
    ...company,
    canonicalName,
    ...(domain ? { domain } : {}),
    ...(description ? { description } : {}),
    ...(people.length > 0 ? { people } : {}),
    flags,
    lastSeenAt,
  };
}

function createCompanyFromRecord(record: SourceRecord, normalizedDomain: string | undefined): Company {
  const extracted = record.extracted;
  return {
    id: randomUUID() as CompanyId,
    canonicalName: extracted.name,
    ...(normalizedDomain ? { domain: normalizedDomain } : {}),
    ...(extracted.description ? { description: extracted.description } : {}),
    ...(extracted.people && extracted.people.length > 0 ? { people: extracted.people } : {}),
    signals: [],
    memberRecordIds: [],
    flags: [],
    firstSeenAt: record.fetchedAt,
    lastSeenAt: record.fetchedAt,
  };
}

function toPairCandidate(company: {
  readonly canonicalName: string;
  readonly domain?: string;
  readonly embedding?: readonly number[];
  readonly people?: readonly string[];
}): PairCandidate {
  return {
    canonicalName: company.canonicalName,
    ...(company.domain ? { domain: company.domain } : {}),
    ...(company.embedding ? { embedding: company.embedding } : {}),
    ...(company.people && company.people.length > 0 ? { people: company.people } : {}),
  };
}

// ---------------------------------------------------------------------------
// Step 3 — entity resolution for ONE newly-ingested record. Records are
// resolved SEQUENTIALLY (see runPipeline below), always against the LIVE
// repository state — this is a deliberate simplification of design.md's
// "STRICTLY SEQUENTIAL... union-find" step for the incremental,
// record-at-a-time shape this pipeline actually has: by the time record #2
// is resolved, record #1's newly-created (or newly-updated) company is
// already persisted and visible to a fresh findByBlockingKeys query, so two
// records arriving in the SAME run that describe the same company are
// reconciled onto ONE company without a separate batch union-find pass.
// resolver.ts's `mergeClusters`/`UnionFind` are therefore NOT invoked here —
// they remain correct, tested primitives for a possible future BATCH
// reconciliation job (e.g. "re-resolve every company against every other"),
// which this incremental per-record flow has no need for. Documented
// design decision, not an oversight.
// ---------------------------------------------------------------------------

interface ResolveDeps {
  readonly companies: CompanyRepository;
  readonly embeddings: EmbeddingProvider;
}

async function resolveRecord(
  deps: ResolveDeps,
  record: SourceRecord,
  logger: PipelineLogger,
  runId: RunId,
): Promise<CompanyId> {
  const extracted = record.extracted;
  const normalizedDomain = extracted.domain ? normalizeDomain(extracted.domain) : undefined;
  const lookupKeys = computeLookupBlockingKeys({
    canonicalName: extracted.name,
    ...(normalizedDomain ? { domain: normalizedDomain } : {}),
  });

  const rawCandidates =
    lookupKeys.length > 0 ? await deps.companies.findByBlockingKeys(lookupKeys) : [];

  const canonicalById = new Map<CompanyId, Company>();
  for (const candidate of rawCandidates) {
    const canonical = await resolveCanonical(deps.companies, candidate);
    canonicalById.set(canonical.id, canonical);
  }
  const candidates = Array.from(canonicalById.values());

  // Only pay for an embedding call when there is at least one candidate to
  // compare against (mirrors resolver.ts's EntityResolver.embedDescription
  // "avoids a wasted batch call" precedent) and a description to embed.
  let candidateEmbedding: readonly number[] | undefined;
  if (candidates.length > 0 && extracted.description) {
    const [vector] = await deps.embeddings.embed([extracted.description]);
    candidateEmbedding = vector;
  }

  const newPairCandidate = toPairCandidate({
    canonicalName: extracted.name,
    ...(normalizedDomain ? { domain: normalizedDomain } : {}),
    ...(candidateEmbedding ? { embedding: candidateEmbedding } : {}),
    ...(extracted.people ? { people: extracted.people } : {}),
  });

  let best: { readonly company: Company; readonly score: number; readonly confidence: MatchConfidence } | undefined;
  for (const candidate of candidates) {
    const result = scorePair(newPairCandidate, toPairCandidate(candidate));
    if (result.confidence === 'none') continue;
    if (!best || result.score > best.score) {
      best = { company: candidate, score: result.score, confidence: result.confidence };
    }
  }

  if (best) {
    const updated = attachRecordToCompany(best.company, record, best.confidence);
    await deps.companies.save(updated);
    await deps.companies.linkSourceRecord(updated.id, record.id);
    await deps.companies.appendSignals(updated.id, extracted.signals);
    logger.info(
      {
        runId,
        companyId: updated.id,
        source: record.source,
        confidence: best.confidence,
        score: best.score,
      },
      'entity resolution: attached record to existing company',
    );
    return updated.id;
  }

  const created = createCompanyFromRecord(record, normalizedDomain);
  await deps.companies.save(created);
  await deps.companies.linkSourceRecord(created.id, record.id);
  await deps.companies.appendSignals(created.id, extracted.signals);
  logger.info(
    { runId, companyId: created.id, source: record.source },
    'entity resolution: created new company',
  );
  return created.id;
}

// ---------------------------------------------------------------------------
// Step (d) — enrichment merge policy (documented, per this phase's own
// instruction to make the exact policy explicit rather than hiding it).
//
// A low-confidence enrichment guess should never CLOBBER good existing
// data, but it SHOULD fill a gap the company doesn't have yet — "some
// signal beats none" for an empty field, but "don't trust a guess over
// something already known" for a populated one. `MIN_ENRICH_OVERWRITE_CONFIDENCE`
// is a judgment call (not spec-numeric): RulesLlmProvider's own
// documented self-assessment caps its guesses at confidence 0.3 (a match)
// or 0 (no match) — see providers/llm/rules.ts's own header comment — so
// under this policy RulesLlmProvider's output ALWAYS only fills gaps,
// never overwrites, which is exactly consistent with that file's own
// framing of itself as "deliberately low-effort, honest about low
// confidence, not fabricating a specific guess it has no basis for".
// ---------------------------------------------------------------------------

export const MIN_ENRICH_OVERWRITE_CONFIDENCE = 0.5;

export function applyEnrichmentResult(company: Company, result: EnrichmentResult): Company {
  const canOverwrite = result.confidence >= MIN_ENRICH_OVERWRITE_CONFIDENCE;
  const sector = result.sector && (canOverwrite || !company.sector) ? result.sector : company.sector;
  const oneLiner =
    result.oneLiner && (canOverwrite || !company.oneLiner) ? result.oneLiner : company.oneLiner;
  const estimatedStage =
    result.estimatedStage && (canOverwrite || !company.estimatedStage)
      ? result.estimatedStage
      : company.estimatedStage;

  return {
    ...company,
    ...(sector ? { sector } : {}),
    ...(oneLiner ? { oneLiner } : {}),
    ...(estimatedStage ? { estimatedStage } : {}),
  };
}

async function enrichTouchedCompanies(
  companies: CompanyRepository,
  llm: LlmProvider,
  touchedIds: ReadonlySet<CompanyId>,
  logger: PipelineLogger,
  runId: RunId,
): Promise<void> {
  for (const id of touchedIds) {
    const company = await companies.findById(id);
    if (!company) continue; // defensive: shouldn't happen, nothing to enrich
    const canonical = await resolveCanonical(companies, company);
    const result = await llm.enrich({
      name: canonical.canonicalName,
      ...(canonical.description ? { description: canonical.description } : {}),
      signals: canonical.signals,
    });
    const updated = applyEnrichmentResult(canonical, result);
    await companies.save(updated);
    logger.info(
      { runId, companyId: canonical.id, confidence: result.confidence },
      'enrichment applied',
    );
  }
}

// ---------------------------------------------------------------------------
// Step (e)/(f) — scoring against the FULL known company set (`listAll`, new
// port method — see apply report), not just companies touched this run.
// `scoreCompanies` (scoring/scorer.ts) already calls `llm.rationale()`
// internally per company — verified by reading that file directly — so this
// pipeline does NOT call `rationale()` a second time itself.
// ---------------------------------------------------------------------------

async function scoreAndPersist(
  deps: Pick<RunPipelineDeps, 'companies' | 'embeddings' | 'llm' | 'scoredDeals'>,
  runId: RunId,
  thesis: Thesis,
  now: Date | undefined,
  logger: PipelineLogger,
): Promise<readonly ScoredDeal[]> {
  const all = await deps.companies.listAll();
  const canonical = all.filter((c) => c.mergedInto === undefined);
  const deals = await scoreCompanies(canonical, thesis, {
    runId,
    embeddings: deps.embeddings,
    llm: deps.llm,
    ...(now ? { now } : {}),
  });
  await deps.scoredDeals.saveAll(runId, deals);
  logger.info(
    { runId, scoredCount: deals.length, companyCount: canonical.length },
    'scoring complete',
  );
  return deals;
}

// ---------------------------------------------------------------------------
// Step 2 — ingestion for ONE source, isolated (spec "Isolated source
// failure"): a try/catch wraps this source's ENTIRE fetch+upsert loop, so a
// throw here never propagates out and never stops the other sources.
// ---------------------------------------------------------------------------

interface IngestOutcome {
  readonly source: SourceName;
  readonly failed: boolean;
  readonly records: readonly SourceRecord[];
}

async function ingestSource(
  adapter: SourceAdapter,
  deps: Pick<RunPipelineDeps, 'sourceRecords' | 'runs'>,
  runId: RunId,
  limit: number,
  signal: AbortSignal,
  logger: PipelineLogger,
): Promise<IngestOutcome> {
  const records: SourceRecord[] = [];
  try {
    const since = await deps.runs.watermark(adapter.source);
    let nextWatermark: string | undefined;

    for await (const page of adapter.fetch({
      ...(since !== undefined ? { since } : {}),
      limit,
      signal,
    })) {
      for (const record of page.records) {
        const { id, isNew } = await deps.sourceRecords.upsert(record);
        records.push({ ...record, id });
        logger.info(
          { runId, source: adapter.source, sourceId: record.sourceId, isNew },
          'ingested source record',
        );
      }
      if (page.nextWatermark !== undefined) {
        nextWatermark = page.nextWatermark;
      }
    }

    if (nextWatermark !== undefined) {
      await deps.runs.setWatermark(adapter.source, nextWatermark);
    }
    logger.info({ runId, source: adapter.source, count: records.length }, 'source ingestion complete');
    return { source: adapter.source, failed: false, records };
  } catch (err) {
    logger.error(
      { runId, source: adapter.source, err: err instanceof Error ? err.message : String(err) },
      'source ingestion failed — isolated, other sources continue',
    );
    return { source: adapter.source, failed: true, records };
  }
}

// ---------------------------------------------------------------------------
// runPipeline — the orchestrator entry point.
// ---------------------------------------------------------------------------

export interface RunPipelineDeps {
  readonly companies: CompanyRepository;
  readonly sourceRecords: SourceRecordRepository;
  readonly runs: RunRepository;
  readonly scoredDeals: ScoredDealRepository;
  readonly sources: readonly SourceAdapter[];
  readonly embeddings: EmbeddingProvider;
  readonly llm: LlmProvider;
  readonly logger?: PipelineLogger;
}

export interface RunPipelineOptions {
  readonly runId: RunId;
  readonly thesis: Thesis;
  /** Stored via RunRepository.start's thesis-identifier string param.
   * Defaults to `thesis.name`. */
  readonly thesisLabel?: string;
  /** Per-source fetch limit passed to each adapter's FetchOptions.limit. */
  readonly limitPerSource?: number;
  /** Injectable clock for deterministic recency scoring in tests. */
  readonly now?: Date;
  readonly signal?: AbortSignal;
}

export interface RunPipelineResult {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly stats: RunStats;
  readonly deals: readonly ScoredDeal[];
  /** The canonical (non-absorbed) companies that were scored this run —
   * convenience for callers (e.g. the CLI) that need to print a company
   * name alongside each deal without a second repository read. */
  readonly companies: readonly Company[];
}

const DEFAULT_LIMIT_PER_SOURCE = 50;

/**
 * Runs one full pipeline execution: ingest (all sources, isolated failures)
 * -> resolve -> enrich -> score -> persist -> finish. See design.md "Data
 * Flow — src/pipeline/run.ts" for the step-by-step design this implements.
 *
 * Run status taxonomy (spec: "the run status MUST be partial (not failed)"
 * when a source fails — documented judgment call for the 3-way RunStatus
 * union this phase had to pin down, since the spec text only pins the
 * partial-on-source-failure case explicitly):
 *   - 'completed' — every source succeeded (ingest/resolve/enrich/score/
 *     persist all completed without throwing).
 *   - 'partial'   — one or more sources failed during ingestion (including
 *     all of them), but resolution/enrichment/scoring/persistence still
 *     completed without throwing. Ingestion failures are never
 *     catastrophic: scoring still runs against the FULL known company set
 *     (`listAll`), so a run can legitimately produce a non-empty ranked
 *     deal list even when every source failed this run.
 *   - 'failed'    — something in resolve/enrich/score/persist itself threw
 *     (a genuinely catastrophic failure that prevents the run from
 *     producing ANY trustworthy result, e.g. a repository outage mid-run).
 *     This status IS actively recorded (not left as an unreachable domain
 *     value): runs.finish(runId, 'failed', stats) is called before the
 *     original error is rethrown, so a caller polling GET /runs/:id later
 *     sees an explicit 'failed' status rather than an ambiguous
 *     never-finished (NULL, per schema.ts's own documented status column)
 *     run. A thesis-validation failure or similar pre-run error happens
 *     BEFORE runPipeline is ever called (the CLI/API parses/validates the
 *     thesis first) and is therefore outside this function's own error
 *     taxonomy entirely — there is no runId yet to record against.
 */
export async function runPipeline(
  deps: RunPipelineDeps,
  options: RunPipelineOptions,
): Promise<RunPipelineResult> {
  const logger = deps.logger ?? pino({ name: 'pipeline' });
  const { runId, thesis } = options;
  const limit = options.limitPerSource ?? DEFAULT_LIMIT_PER_SOURCE;
  const signal = options.signal ?? new AbortController().signal;

  logger.info(
    { runId, sources: deps.sources.map((s) => s.source) },
    'pipeline run starting',
  );
  await deps.runs.start(runId, options.thesisLabel ?? thesis.name);

  // Step 2 — INGEST, concurrent across sources (design.md), each isolated.
  const ingestOutcomes = await Promise.all(
    deps.sources.map((adapter) => ingestSource(adapter, deps, runId, limit, signal, logger)),
  );
  const failedSources = ingestOutcomes.filter((o) => o.failed).map((o) => o.source);
  const ingestedRecords = ingestOutcomes.flatMap((o) => o.records);

  try {
    // Step 3 — RESOLVE, strictly sequential (see resolveRecord's own doc
    // comment for why this sidesteps a separate batch union-find pass).
    const touched = new Set<CompanyId>();
    for (const record of ingestedRecords) {
      const companyId = await resolveRecord(
        { companies: deps.companies, embeddings: deps.embeddings },
        record,
        logger,
        runId,
      );
      touched.add(companyId);
    }

    // Step 4 — ENRICH, over companies touched this run.
    await enrichTouchedCompanies(deps.companies, deps.llm, touched, logger, runId);

    // Step 5/6 — SCORE + persist, against the FULL known company set.
    const deals = await scoreAndPersist(deps, runId, thesis, options.now, logger);

    const stats: RunStats = { failedSources };
    const status: RunStatus = failedSources.length > 0 ? 'partial' : 'completed';
    await deps.runs.finish(runId, status, stats);
    logger.info({ runId, status, failedSources, dealCount: deals.length }, 'pipeline run finished');

    const allCompanies = await deps.companies.listAll();
    return {
      runId,
      status,
      stats,
      deals,
      companies: allCompanies.filter((c) => c.mergedInto === undefined),
    };
  } catch (err) {
    const stats: RunStats = { failedSources };
    logger.error(
      { runId, err: err instanceof Error ? err.message : String(err) },
      'pipeline run failed catastrophically during resolve/enrich/score/persist',
    );
    await deps.runs.finish(runId, 'failed', stats);
    throw err;
  }
}
