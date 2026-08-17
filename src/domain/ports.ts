// Domain ports (hexagonal boundary). Pure interfaces + DTOs only — this file
// MUST NOT import infrastructure. The ESLint core-layer boundary rule
// (eslint.config.js, design.md D1) machine-checks this for every file under
// src/domain/**.
//
// Signatures below are copied verbatim from design.md's "Ports
// (`src/domain/ports.ts`)" section (D2-D4) — not re-derived.
//
// Repository port count: design.md's D4 decision row names 5 segregated
// ports (CompanyRepository, SourceRecordRepository, RunRepository,
// ScoredDealRepository, DealReadModel) for ISP, but the code sample in that
// same section only defines the shape of the first 4. The tasks artifact's
// Phase 2.2 entry explicitly scopes this task to "all 4 repo ports".
// DealReadModel's query/pagination shape is a deals-api (Phase 9) concern —
// defining it now would mean inventing an untested shape ahead of the
// actual GET /deals filter/cursor requirements. Deferred to Phase 9, where
// it will be pinned by the real endpoint contract. This matches D4's own
// rationale: "in-memory pipeline tests implement 4 small ports, not API
// read models."

import type {
  Company,
  CompanyId,
  MergeEvidence,
  Run,
  RunId,
  RunStats,
  RunStatus,
  ScoreBreakdown,
  ScoredDeal,
  Signal,
  SourceName,
  SourceRecord,
  SourceRecordId,
  Stage,
} from './entities.js';
import type { Thesis } from './thesis.js';

// ---------------------------------------------------------------------------
// Source ingestion
// ---------------------------------------------------------------------------

export interface SourcePage {
  readonly records: readonly SourceRecord[];
  readonly nextWatermark?: string; // opaque, per-source semantics
}

export interface FetchOptions {
  readonly since?: string; // previous watermark
  readonly limit: number;
  readonly signal: AbortSignal;
}

export interface SourceAdapter {
  readonly source: SourceName; // 'github' | 'hackernews' | 'rss'
  fetch(opts: FetchOptions): AsyncIterable<SourcePage>;
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

export interface EmbeddingProvider {
  readonly id: string; // 'local-minilm' | 'deterministic'
  readonly dimensions: number; // asserted === 384 at startup
  embed(texts: readonly string[]): Promise<readonly number[][]>; // batch
}

// ---------------------------------------------------------------------------
// LLM (enrichment + rationale)
// ---------------------------------------------------------------------------

export interface EnrichmentRequest {
  readonly name: string;
  readonly description?: string;
  readonly signals: readonly Signal[];
}

export interface EnrichmentResult {
  readonly sector?: string;
  readonly oneLiner?: string;
  readonly estimatedStage?: Stage;
  readonly confidence: number;
}

export interface RationaleRequest {
  readonly company: Company;
  readonly breakdown: ScoreBreakdown;
  readonly thesis: Thesis;
}

export interface LlmProvider {
  readonly id: string; // 'rules' | 'ollama'
  enrich(req: EnrichmentRequest): Promise<EnrichmentResult>;
  rationale(req: RationaleRequest): Promise<string>; // company + breakdown + thesis
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

// IMPORTANT — merge is a redirect, not a union: after merge(survivor,
// absorbed, ...), the ABSORBED row is kept exactly as it was (own domain,
// own blockingKeys, all intact — non-destructive per §8.1) with only a
// `mergedInto` pointer added. Neither findByDomain nor findByBlockingKeys
// "hands you the survivor" when they match on data that still lives on an
// absorbed row — they return the row that actually matched. Any caller
// that treats a lookup result as authoritative MUST check
// `result.mergedInto` and, if set, follow the chain (survivor may itself
// have since been absorbed into a later merge) to reach the live,
// currently-canonical Company before acting on it. Both the in-memory and
// Postgres implementations honor this identically — it is not a
// Postgres-specific gap. No pipeline code consumes these lookups yet
// (Phase 5); whichever phase wires entity resolution into a live run loop
// is responsible for doing the mergedInto resolution, not this port.
export interface CompanyRepository {
  findByDomain(domain: string): Promise<Company | undefined>;
  findByBlockingKeys(keys: readonly string[]): Promise<readonly Company[]>;
  // Added by the pipeline-orchestrator phase (src/pipeline/run.ts) — the
  // port originally shipped with no way to re-fetch a specific company by
  // id. That is required for a `resolveCanonical` helper to follow
  // `mergedInto` chains to the CURRENT canonical company: findByDomain and
  // findByBlockingKeys only return companies that independently match on
  // their OWN name/domain, which is not guaranteed for a survivor several
  // merges removed from whatever matched the original lookup. See the
  // CompanyRepository doc comment above `merge` for the full mergedInto
  // contract this method exists to serve.
  findById(id: CompanyId): Promise<Company | undefined>;
  save(company: Company): Promise<void>; // idempotent upsert by id
  linkSourceRecord(id: CompanyId, rec: SourceRecordId): Promise<void>;
  appendSignals(id: CompanyId, signals: readonly Signal[]): Promise<void>;
  setEmbedding(id: CompanyId, embedding: readonly number[]): Promise<void>;
  merge(survivor: CompanyId, absorbed: CompanyId, ev: MergeEvidence): Promise<void>;
  // Added by the pipeline-orchestrator phase — thesis scoring (spec §8.3)
  // must run against the FULL known company set on every run (a company
  // discovered several runs ago is still a candidate deal), not just
  // companies touched by the current run's ingestion. Neither
  // findByDomain nor findByBlockingKeys can produce that set. Returns
  // EVERY row, including absorbed ones (mergedInto set) — consistent with
  // findByDomain/findByBlockingKeys's own "return the raw matched row,
  // caller resolves mergedInto" contract; callers that only want scorable
  // canonical companies must filter out rows with `mergedInto` set
  // themselves.
  listAll(): Promise<readonly Company[]>;
}

export interface SourceRecordRepository {
  upsert(r: SourceRecord): Promise<{ readonly id: SourceRecordId; readonly isNew: boolean }>;
  // Cursor-paginated over ALL source records, not scoped to a run: per
  // schema §7, source_records has no run_id column — ingestion accumulates
  // continuously across runs (idempotent by (source, sourceId)), it is not
  // partitioned per pipeline execution. A run's own scope is what the
  // pipeline holds in memory from that execution's fetch() calls, not
  // something re-queried back out by run id afterward.
  list(after: SourceRecordId | undefined, limit: number): Promise<readonly SourceRecord[]>;
}

export interface RunRepository {
  start(id: RunId, thesis: string): Promise<void>;
  watermark(source: SourceName): Promise<string | undefined>;
  setWatermark(source: SourceName, w: string): Promise<void>;
  finish(id: RunId, status: RunStatus, stats: RunStats): Promise<void>; // completed|partial|failed
  // Added by the Hono API phase (src/api/**) — the port originally shipped
  // write-only (start/watermark/setWatermark/finish), which was enough for
  // the pipeline orchestrator but leaves no way to serve `GET /runs/:id` or
  // to discover "the latest run" for `GET /deals`. Same pattern as
  // CompanyRepository.findById/listAll (Phase 9a): a real read path exposed
  // a genuine port gap, filled here rather than routed around.
  /** Fetches one run by id, or `undefined` if no run with that id was ever
   * started. `status` is `'running'` when the run has started but
   * `finish()` has not yet been called for it (see Run.status's own doc
   * comment in entities.ts). */
  get(id: RunId): Promise<Run | undefined>;
  /** The run `GET /deals` treats as "the latest run": the most recently
   * FINISHED run whose status is `'completed'` or `'partial'` (both persist
   * real `scored_deals` — `'failed'` never does, per pipeline/run.ts's own
   * documented status taxonomy), ordered by finish time descending.
   * `undefined` when no run has ever reached one of those two statuses
   * (e.g. a fresh database, or every run so far has failed catastrophically
   * or is still in progress) — callers MUST treat that as "no deals yet",
   * not as an error. */
  findLatestWithDeals(): Promise<Run | undefined>;
}

export interface ScoredDealRepository {
  saveAll(runId: RunId, d: readonly ScoredDeal[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// DealReadModel — the 5th segregated port design.md's D4 decision row named
// but deliberately left unshaped ("deferred to Phase 9, where it will be
// pinned by the real endpoint contract"). Pinned now by GET /deals (list,
// cursor-paginated, filterable) and GET /deals/:id + GET
// /companies/:id/provenance (detail). A pure API READ concern — no in-memory
// implementation is provided (see src/api/**'s own tests, which run against
// a real ephemeral-per-test Postgres via the same integration-test pattern
// db-test-helper.ts already established for the repository contract suite).
// ---------------------------------------------------------------------------

/** Opaque-to-the-client pagination cursor. NOT an offset/page number (spec:
 * "Paginación por cursor, no por offset") — it means "everything after this
 * exact (score, companyId) position under `ORDER BY score DESC, companyId
 * ASC`", so results stay stable even if new deals are scored between page
 * requests (an offset would silently skip or repeat rows as the underlying
 * result set shifts). The HTTP-facing base64 encode/decode of this shape
 * lives in src/api/cursor.ts, not here — this port only knows the decoded
 * structural shape, never the wire encoding. */
export interface DealCursor {
  readonly score: number;
  readonly companyId: CompanyId;
}

export interface DealListFilter {
  readonly runId: RunId;
  readonly minScore?: number;
  readonly sector?: string;
  readonly stage?: Stage;
  readonly limit: number;
  readonly cursor?: DealCursor;
}

/** A list-row projection — just enough company context to render a table
 * row (name/domain/sector/stage) without the full `Company` (signals,
 * embedding, etc. are unnecessary list-view weight). */
export interface DealListItem {
  readonly deal: ScoredDeal;
  readonly company: Pick<Company, 'id' | 'canonicalName' | 'domain' | 'sector' | 'estimatedStage'>;
}

export interface DealListPage {
  readonly items: readonly DealListItem[];
  /** Present only when more results exist beyond this page. */
  readonly nextCursor?: DealCursor;
}

export interface DealDetail {
  readonly deal: ScoredDeal;
  readonly company: Company;
  readonly sourceRecords: readonly SourceRecord[];
}

/** One field's best-effort provenance reconstruction — see
 * `getCompanyProvenance`'s own doc comment for the full honesty framing. */
export interface FieldProvenance {
  readonly field: 'canonicalName' | 'domain' | 'description' | 'sector' | 'estimatedStage';
  readonly value: string | undefined;
  /**
   * - 'reconstructed-from-source-precedence': value re-derived at READ time
   *   by applying resolution/resolver.ts's own `resolveFieldConflict`
   *   source-precedence + most-recent-tiebreak logic over the company's
   *   member SourceRecords — the SAME algorithm used at merge/attach time
   *   (pipeline/run.ts's `attachRecordToCompany`), not a stored audit log.
   * - 'enrichment-not-attributable': `sector`/`estimatedStage` are LLM
   *   enrichment output (providers/llm/*.ts), never present on any
   *   `ExtractedCompany` — there is no SourceRecord to honestly attribute
   *   these to, so none is invented.
   */
  readonly method: 'reconstructed-from-source-precedence' | 'enrichment-not-attributable';
  readonly source?: SourceName;
  readonly sourceRecordId?: SourceRecordId;
  /** `ExtractedCompany.url` from the winning record, when present — the
   * closest honest analogue to a Signal's `evidenceUrl` for a scalar
   * Company field (Company fields carry no evidenceUrl of their own). */
  readonly evidenceUrl?: string;
}

/**
 * `GET /companies/:id/provenance`'s data source. Per-field write-time
 * provenance is NOT stored anywhere in this schema (a real domain-model gap,
 * flagged in Phase 9a's own risk report) — this is a deliberate, DISCLOSED
 * best-effort reconstruction, not a stored audit log. See FieldProvenance's
 * `method` field for exactly which honesty tier each field falls into.
 */
export interface CompanyProvenance {
  readonly companyId: CompanyId;
  readonly fields: readonly FieldProvenance[];
}

export interface DealReadModel {
  /** Ranked list for the given run, already sorted `score DESC, companyId
   * ASC` (the tie-break the cursor itself depends on) — callers should NOT
   * need to re-sort client-side. */
  listDeals(filter: DealListFilter): Promise<DealListPage>;
  /** A single company's deal within one run, or `undefined` if that company
   * has no `ScoredDeal` row for that run (never scored, or the run doesn't
   * exist). Callers resolve "latest run" via `RunRepository.findLatestWithDeals`
   * before calling this — this port has no opinion on which run is latest. */
  getDeal(runId: RunId, companyId: CompanyId): Promise<DealDetail | undefined>;
  getCompanyProvenance(companyId: CompanyId): Promise<CompanyProvenance | undefined>;
}
