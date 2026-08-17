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
}

export interface ScoredDealRepository {
  saveAll(runId: RunId, d: readonly ScoredDeal[]): Promise<void>;
}
