// Thesis scoring (spec §8.3). Pure formula:
//
//   score_final = 0                              if any hard_filter fails
//               = 100 * Sum(weight_i * component_i)   otherwise
//
// This file lives under the core-layer ESLint boundary (eslint.config.js
// CORE_LAYER_GLOBS) — it imports `domain/` types/ports only, constructor/
// function-injected (design.md D1/D2), never a concrete provider class. It
// has zero knowledge that LocalEmbeddingProvider or RulesLlmProvider exist.
//
// Cross-module note: cosineSimilarity below is DUPLICATED from
// resolution/resolver.ts rather than imported. design.md's module boundary
// section states resolution/, enrichment/, scoring/, and pipeline/run.ts
// each import `domain/` ONLY, not each other — the same reasoning Phase 5
// used to duplicate computeCompanyBlockingKeys between src/db/repository.ts
// and tests/doubles/in-memory-repository.ts (see that phase's
// apply-progress). Both copies are small, pure, independently unit-tested,
// and unlikely to drift silently since either one breaking would fail its
// own module's tests.

import type {
  Company,
  RunId,
  ScoreBreakdown,
  ScoreComponent,
  ScoredDeal,
  SignalKind,
  Stage,
} from '../domain/entities.js';
import type { EmbeddingProvider, LlmProvider } from '../domain/ports.js';
import type { Thesis } from '../domain/thesis.js';

// ---------------------------------------------------------------------------
// Pure math helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Cosine similarity, [-1,1]. Returns 0 for empty/mismatched-length vectors
 * (defensive default, matches resolution/resolver.ts's own convention). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Percentile rank of each value WITHIN the given array, in [0,1]. Uses the
 * "-0.5 / n" convention (1-indexed rank, ties averaged, then
 * `(rank - 0.5) / n`): the lowest value in a large batch lands near (but not
 * at) 0, the highest lands near (but not at) 1, and — the property this
 * scorer specifically relies on — a batch of exactly 1 item ALWAYS produces
 * exactly [0.5] with no special-cased branch: rank=1, n=1,
 * (1 - 0.5) / 1 = 0.5. That is the documented, intentional "momentum is
 * meaningless with nothing to compare against, treat it as the median"
 * behavior (see scoreSingleCompanyForTesting below).
 */
export function percentileRanks(values: readonly number[]): readonly number[] {
  const n = values.length;
  if (n === 0) return [];
  const order = values.map((_, i) => i).sort((a, b) => values[a]! - values[b]!);
  const ranks = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]!] === values[order[i]!]) j += 1;
    // 1-indexed average rank across the tied group [i, j]
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) ranks[order[k]!] = avgRank;
    i = j + 1;
  }
  return ranks.map((rank) => (rank - 0.5) / n);
}

// ---------------------------------------------------------------------------
// Hard filters (spec: disqualify, do not merely subtract)
//
// Stage: `Stage` includes the literal member 'unknown' (entities.ts STAGES
// tuple) specifically so an operator can opt IN to accepting companies whose
// stage isn't confirmed, by listing 'unknown' in hard_filters.stages. A
// missing `company.estimatedStage` (never enriched) and an explicit
// `estimatedStage: 'unknown'` (enrichment ran and concluded "can't tell")
// represent the SAME real-world fact — "we don't know this company's
// stage" — so both are normalized to the same effective value here rather
// than silently passing (treats missing data as a free pass) or silently
// failing (ignores that the operator has an explicit, documented way to
// opt in). This is the resolution to the "what happens when estimatedStage
// is undefined" question this phase's own scope explicitly raised.
//
// Sector: there is no equivalent 'unknown' sentinel in exclude_sectors (an
// open string denylist, not a closed enum) — absence of a known sector is
// not evidence of membership in a specific excluded sector string, so a
// missing `company.sector` never fails this filter on its own.
// ---------------------------------------------------------------------------

type HardFilterResult =
  | { readonly failed: true; readonly reason: string; readonly stageWasUnknown: boolean }
  | { readonly failed: false; readonly stageWasUnknown: boolean };

export function checkHardFilters(company: Company, thesis: Thesis): HardFilterResult {
  const effectiveStage: Stage = company.estimatedStage ?? 'unknown';
  const stageWasUnknown = effectiveStage === 'unknown';

  if (!thesis.hard_filters.stages.includes(effectiveStage)) {
    return {
      failed: true,
      reason: stageWasUnknown
        ? `estimatedStage is unconfirmed ('unknown') and thesis.hard_filters.stages ` +
          `[${thesis.hard_filters.stages.join(', ')}] does not include 'unknown'`
        : `stage '${effectiveStage}' is not in thesis.hard_filters.stages ` +
          `[${thesis.hard_filters.stages.join(', ')}]`,
      stageWasUnknown,
    };
  }

  if (company.sector && thesis.hard_filters.exclude_sectors.includes(company.sector)) {
    return {
      failed: true,
      reason: `sector '${company.sector}' is in thesis.hard_filters.exclude_sectors`,
      stageWasUnknown,
    };
  }

  return { failed: false, stageWasUnknown };
}

// ---------------------------------------------------------------------------
// Semantic component — cosine(company embedding, thesis embedding),
// normalized [-1,1] -> [0,1] (spec verbatim).
//
// "Señales textuales" interpretation: signals (entities.ts SignalKind) are
// numeric (kind + value + date + source), not free text — there is no prose
// to embed. The honest, concrete interpretation used here is the distinct
// set of signal KINDS a company has observed (e.g. a company with 'launch'
// and 'hiring' signals appends "launch hiring" to its embedding text),
// giving the embedding a little extra topical context without inventing
// text the source data doesn't contain. In practice this mostly reduces to
// name + description, as this phase's own scope note anticipated.
// ---------------------------------------------------------------------------

export function buildCompanyEmbeddingText(company: Company): string {
  const parts = [company.canonicalName];
  if (company.description) parts.push(company.description);
  const signalKinds = Array.from(new Set(company.signals.map((s) => s.kind)));
  if (signalKinds.length > 0) parts.push(signalKinds.join(' '));
  return parts.join('. ');
}

export function buildThesisEmbeddingText(thesis: Thesis): string {
  return `${thesis.name}. ${thesis.description}`;
}

export function semanticComponent(
  companyEmbedding: readonly number[],
  thesisEmbedding: readonly number[],
): number {
  return (cosineSimilarity(companyEmbedding, thesisEmbedding) + 1) / 2;
}

// ---------------------------------------------------------------------------
// Momentum component — derivative-shaped signals only, log-transformed,
// THEN percentile-ranked within the batch (spec: "derivada... no el valor
// absoluto"; "normalizar con log y percentil dentro de la corrida").
//
// Signal kind selection: `github_stars_delta_30d` is the spec's own
// explicit example of a derivative signal. `github_stars` (the absolute
// cumulative counter) is the spec's own explicit COUNTER-example of what
// NOT to use for momentum — deliberately excluded. `hn_points`, `hn_show`,
// `launch`, and `hiring` are treated as momentum-relevant because each is
// inherently a point-in-time event (a company either hit the HN front page,
// launched, or posted hiring news on some specific date) — by nature these
// already represent "something that just happened", the same shape as a
// delta, without needing a separate before/after subtraction.
//
// Multiple observations of the SAME kind over a company's history (e.g. a
// github_stars_delta_30d recorded at several different ingestion runs) use
// only the MOST RECENT observation per kind, not a sum of every historical
// observation — 30-day delta windows recorded days apart overlap heavily,
// so summing them would double-count the same underlying stars. Using only
// the latest value per kind avoids that, while summing ACROSS DIFFERENT
// kinds is intentional: a company with both a stars spike AND a hiring
// signal AND a launch this run has genuinely more going on than one with
// only a stars spike, and momentum should reflect that.
// ---------------------------------------------------------------------------

const MOMENTUM_SIGNAL_KINDS: readonly SignalKind[] = [
  'github_stars_delta_30d',
  'hn_points',
  'hn_show',
  'launch',
  'hiring',
];

function latestValuePerMomentumKind(company: Company): ReadonlyMap<SignalKind, number> {
  const latest = new Map<SignalKind, { readonly value: number; readonly observedAt: string }>();
  for (const signal of company.signals) {
    if (!MOMENTUM_SIGNAL_KINDS.includes(signal.kind)) continue;
    const existing = latest.get(signal.kind);
    if (!existing || signal.observedAt > existing.observedAt) {
      latest.set(signal.kind, { value: signal.value, observedAt: signal.observedAt });
    }
  }
  return new Map(Array.from(latest.entries(), ([kind, v]) => [kind, v.value] as const));
}

/** Raw, log-transformed momentum for ONE company, in isolation — NOT yet
 * normalized against a batch. Exported for direct unit testing of the log
 * transform; scoreCompanies always follows this with percentileRanks(). */
export function rawMomentum(company: Company): number {
  let total = 0;
  for (const value of latestValuePerMomentumKind(company).values()) {
    total += Math.log1p(Math.max(0, value));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Keywords component — soft_preferences.keywords coverage, penalized by
// anti_patterns matches (spec verbatim).
//
// Match method: case-insensitive substring match against
// `canonicalName + description`. Substring (not whole-token) match is
// chosen because keywords/anti-patterns are configured as short free-text
// phrases (e.g. "open-source", "no code in public repo" — see
// thesis.test.ts's own fixture), which token-boundary matching would need
// extra normalization logic to handle correctly (hyphens, multi-word
// phrases); substring match is simpler, matches the operator's plain
// intent, and false-positive risk on short business-domain phrases is low.
//
// Coverage when soft_preferences.keywords is empty: defined as 1 (full
// coverage of an empty requirement — nothing was asked for, nothing is
// missing), not 0. Zeroing this component whenever an operator simply
// didn't configure any keywords would unfairly punish every company on a
// dimension the operator explicitly left unconfigured.
//
// Anti-pattern penalty: SUBTRACTIVE (coverage - matches * penalty), not
// multiplicative. Chosen because it stays linearly auditable straight from
// the breakdown (a multiplicative penalty like coverage*(1-p)^matches is
// harder to eyeball), and because presence of an anti-pattern should hurt
// in absolute terms, not just proportionally shrink whatever coverage was
// already earned. Penalty size (0.5 per match, clamped to [0,1] overall) is
// a judgment call: 1 match noticeably hurts a good match without zeroing it
// outright; 2 matches floor the component to 0.
// ---------------------------------------------------------------------------

const ANTI_PATTERN_PENALTY_PER_MATCH = 0.5;

function containsPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(phrase.toLowerCase());
}

export function keywordsComponent(company: Company, thesis: Thesis): number {
  const text = `${company.canonicalName} ${company.description ?? ''}`.toLowerCase();
  const { keywords } = thesis.soft_preferences;
  const coverage =
    keywords.length === 0
      ? 1
      : keywords.filter((k) => containsPhrase(text, k)).length / keywords.length;
  const antiMatchCount = thesis.anti_patterns.filter((p) => containsPhrase(text, p)).length;
  return clamp01(coverage - antiMatchCount * ANTI_PATTERN_PENALTY_PER_MATCH);
}

// ---------------------------------------------------------------------------
// Recency component — exponential decay from firstSeenAt (spec verbatim).
//
// Half-life choice: 30 days — not specified numerically by spec prose. A
// company first seen "today" scores ~1.0; at 30 days it has decayed to
// exactly 0.5; at 90 days (3 half-lives) to 0.125; at 180 days to ~0.016.
// Reasoning: this is a deal-sourcing tool for an investor who wants to act
// on FRESH signals — a company that just started showing up in HN/GitHub
// activity is much more actionable "on my radar right now" than one first
// seen a year ago (presumably already reviewed, passed on, or invested
// elsewhere by now). 30 days was chosen specifically (over e.g. 7 or 90) to
// reuse the SAME time unit the domain model already anchors elsewhere
// (`github_stars_delta_30d`'s own 30-day window) rather than introducing an
// unrelated third time constant; 7 days would penalize a good match that
// simply took a few weeks to review, and 90 days would make "recency" barely
// distinguish a fresh company from one three months old (still >0.79),
// undermining the point of the component.
// ---------------------------------------------------------------------------

export const RECENCY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function recencyComponent(company: Company, now: Date): number {
  const ageDays = (now.getTime() - new Date(company.firstSeenAt).getTime()) / MS_PER_DAY;
  return clamp01(Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS));
}

// ---------------------------------------------------------------------------
// Weighted combination — spec verbatim: score = 100 * Sum(weight_i * component_i)
// ---------------------------------------------------------------------------

interface Components {
  readonly semantic: number;
  readonly momentum: number;
  readonly keywords: number;
  readonly recency: number;
}

export function combineWeightedScore(components: Components, weights: Thesis['weights']): number {
  return (
    100 *
    (weights.semantic * components.semantic +
      weights.momentum * components.momentum +
      weights.keywords * components.keywords +
      weights.recency * components.recency)
  );
}

// ---------------------------------------------------------------------------
// scoreCompanies — the batch entry point. Momentum is INHERENTLY a batch
// concept ("percentil dentro de la corrida" — percentile WITHIN THE RUN): a
// single company's momentum score depends on how its raw signal activity
// compares to every OTHER company scored in the same run. This is why the
// primary API takes a batch, not a single company — see
// scoreSingleCompanyForTesting below for the single-company convenience
// wrapper and its documented momentum caveat.
// ---------------------------------------------------------------------------

export interface ScoreCompaniesOptions {
  readonly runId: RunId;
  readonly embeddings: EmbeddingProvider;
  readonly llm: LlmProvider;
  /** Injectable clock for deterministic recency tests; defaults to `new Date()`. */
  readonly now?: Date;
}

function dedupeFlags(flags: readonly string[]): readonly string[] {
  return Array.from(new Set(flags));
}

export async function scoreCompanies(
  companies: readonly Company[],
  thesis: Thesis,
  options: ScoreCompaniesOptions,
): Promise<readonly ScoredDeal[]> {
  const now = options.now ?? new Date();

  const outcomes = companies.map((company) => ({
    company,
    hardFilter: checkHardFilters(company, thesis),
  }));

  // Hard filter FIRST — spec: a failing company needs "no weighted
  // component calculation". Survivors alone are embedded (skips the
  // embedding-provider cost for rejects, per design.md's data-flow step 5
  // comment) and are the ONLY companies whose momentum enters the batch
  // percentile ranking — a hard-filtered company's momentum is never read
  // (its score is fixed at 0), so including it would only dilute the
  // percentile distribution for companies the thesis actually considers.
  const survivors = outcomes.filter((o) => !o.hardFilter.failed).map((o) => o.company);

  const semanticByCompanyId = new Map<string, number>();
  if (survivors.length > 0) {
    const [thesisEmbedding] = await options.embeddings.embed([buildThesisEmbeddingText(thesis)]);
    const companyEmbeddings = await options.embeddings.embed(
      survivors.map(buildCompanyEmbeddingText),
    );
    survivors.forEach((company, i) => {
      semanticByCompanyId.set(
        company.id,
        semanticComponent(companyEmbeddings[i]!, thesisEmbedding!),
      );
    });
  }

  const momentumPercentiles = percentileRanks(survivors.map(rawMomentum));
  const momentumByCompanyId = new Map(
    survivors.map((company, i) => [company.id, momentumPercentiles[i]!]),
  );

  interface Prepared {
    readonly company: Company;
    readonly breakdown: ScoreBreakdown;
    readonly score: number;
    readonly flags: readonly string[];
  }

  const prepared: Prepared[] = outcomes.map(({ company, hardFilter }) => {
    const flags = hardFilter.stageWasUnknown
      ? dedupeFlags([...company.flags, 'etapa incierta'])
      : company.flags;

    if (hardFilter.failed) {
      const zero: ScoreComponent = { value: 0, weight: 0 };
      const breakdown: ScoreBreakdown = {
        semantic: zero,
        momentum: zero,
        keywords: zero,
        recency: zero,
        failedHardFilter: hardFilter.reason,
      };
      return { company, breakdown, score: 0, flags };
    }

    const components: Components = {
      semantic: semanticByCompanyId.get(company.id) ?? 0,
      momentum: momentumByCompanyId.get(company.id) ?? 0.5,
      keywords: keywordsComponent(company, thesis),
      recency: recencyComponent(company, now),
    };
    const breakdown: ScoreBreakdown = {
      semantic: { value: components.semantic, weight: thesis.weights.semantic },
      momentum: { value: components.momentum, weight: thesis.weights.momentum },
      keywords: { value: components.keywords, weight: thesis.weights.keywords },
      recency: { value: components.recency, weight: thesis.weights.recency },
    };
    return { company, breakdown, score: combineWeightedScore(components, thesis.weights), flags };
  });

  // Rationale generation (design.md data-flow step 5: "llm.rationale()
  // bounded-concurrent"). Unbounded Promise.all is used here rather than a
  // real bounded-concurrency queue: RulesLlmProvider (this phase's only
  // implementation) does zero I/O, so there is no concurrency hazard to
  // bound yet. A real queue (pipeline/queue.ts, per design.md's module
  // boundary diagram) belongs to whichever future phase adds a
  // network-calling provider (OllamaLlmProvider) — explicitly out of this
  // phase's scope.
  const rationales = await Promise.all(
    prepared.map((p) =>
      options.llm.rationale({ company: p.company, breakdown: p.breakdown, thesis }),
    ),
  );

  return prepared.map((p, i) => ({
    runId: options.runId,
    companyId: p.company.id,
    score: p.score,
    breakdown: p.breakdown,
    rationale: rationales[i]!,
    flags: p.flags,
  }));
}

/**
 * Convenience wrapper for unit-testing individual score components (hard
 * filters, semantic, keywords, recency) without constructing a full batch.
 *
 * WARNING — momentum is MEANINGLESS here. Momentum is, by spec, a
 * percentile-within-the-run computation: with a batch of exactly 1 company,
 * percentileRanks() always returns [0.5] (the median) by construction —
 * there is no distribution to rank against (see percentileRanks' own doc
 * comment for why that specific value falls out of the general formula,
 * not a special case). Do NOT use this function's `breakdown.momentum` to
 * assert anything about a company's real relative momentum; use
 * scoreCompanies with a realistic multi-company batch for that.
 */
export async function scoreSingleCompanyForTesting(
  company: Company,
  thesis: Thesis,
  options: ScoreCompaniesOptions,
): Promise<ScoredDeal> {
  const [deal] = await scoreCompanies([company], thesis, options);
  return deal!;
}
