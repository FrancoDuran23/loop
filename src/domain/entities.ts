// Pure domain types. Zero runtime logic, zero imports of infrastructure —
// this file is type/interface declarations only.
//
// Field provenance note: design.md references a numbered author spec
// (§4-§18) for exact field lists, but only the capability/scenario delta
// spec and the proposal were retrievable from the artifact store at apply
// time (no separate §-numbered document was persisted). Fields below are
// derived from the scenarios in the source-ingestion, entity-resolution,
// enrichment, thesis-scoring, persistence, and deals-api capabilities, plus
// design.md's Ports section. Where a field is not pinned down by an
// explicit scenario, the minimal defensible choice was made and is noted
// inline.

// ---------------------------------------------------------------------------
// Branded IDs — nominal typing over `string`, so e.g. a SourceRecordId can
// never be passed where a CompanyId is expected even though both are plain
// strings at runtime. No runtime constructor is exported here: callers cast
// at the point of creation (`someUuid as CompanyId`) once an id is actually
// generated (persistence layer, Phase 5), keeping this file free of runtime
// code per the Phase 2 check criterion ("typecheck 0 errors").
// ---------------------------------------------------------------------------

export type CompanyId = string & { readonly __brand: 'CompanyId' };
export type SourceRecordId = string & { readonly __brand: 'SourceRecordId' };
export type RunId = string & { readonly __brand: 'RunId' };

// ---------------------------------------------------------------------------
// Shared literal unions
// ---------------------------------------------------------------------------

export type SourceName = 'github' | 'hackernews' | 'rss';

// Investment stage vocabulary used by Thesis.hard_filters.stages and
// Company/ExtractedCompany/EnrichmentResult.estimatedStage. No exhaustive
// list was given in the retrievable spec text; this is the conventional
// pre-seed -> growth VC stage ladder plus 'unknown' for sources that don't
// expose a stage signal. Exported as a const tuple so thesis.ts can build a
// Zod enum from the same single source of truth.
export const STAGES = [
  'pre-seed',
  'seed',
  'series-a',
  'series-b',
  'series-c-plus',
  'growth',
  'unknown',
] as const;
export type Stage = (typeof STAGES)[number];

export type RunStatus = 'completed' | 'partial' | 'failed';

// ---------------------------------------------------------------------------
// Signals — every signal must be traceable and dated (spec: "A Signal MUST
// NEVER be stored as a bare number without a date and source").
// `kind` is kept as an open `string` (not a closed union) so a new source
// adapter can introduce new signal kinds without touching domain/ (spec:
// "New source requires no core-layer change").
// ---------------------------------------------------------------------------

export interface Signal {
  readonly kind: string; // e.g. 'github_stars_delta_30d'
  readonly value: number;
  readonly observedAt: string; // ISO 8601
  readonly source: SourceName;
  readonly evidenceUrl?: string;
}

// ---------------------------------------------------------------------------
// Ingestion — raw fetched record and the source-specific extraction taken
// from it, prior to entity resolution.
// ---------------------------------------------------------------------------

export interface ExtractedCompany {
  readonly name: string;
  readonly domain?: string;
  readonly description?: string;
  readonly url: string;
  readonly stage?: Stage;
  readonly sector?: string;
  // Founder/contributor names — used as an entity-resolution pair-scoring
  // signal ("shared person in people").
  readonly people?: readonly string[];
  readonly signals?: readonly Signal[];
}

export interface SourceRecord {
  readonly id: SourceRecordId;
  readonly source: SourceName;
  readonly sourceId: string; // native id in the source system; UNIQUE(source, sourceId)
  readonly url: string;
  readonly fetchedAt: string; // ISO 8601
  readonly raw: unknown; // original payload, kept verbatim for provenance/replay
  readonly extracted: ExtractedCompany;
}

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

export interface MergeEvidence {
  readonly pairScore: number;
  readonly matchedSignals: readonly string[]; // e.g. ['domain', 'name-similarity', 'shared-person']
  readonly confidence: 'auto' | 'uncertain';
}

// ---------------------------------------------------------------------------
// Company — the canonical, resolved entity.
// ---------------------------------------------------------------------------

export interface Company {
  readonly id: CompanyId;
  readonly name: string;
  readonly domain?: string; // UNIQUE WHERE domain IS NOT NULL
  readonly description?: string;
  readonly sector?: string;
  readonly stage?: Stage;
  readonly oneLiner?: string;
  readonly people?: readonly string[];
  readonly embedding?: readonly number[]; // 384-dim; ivfflat cosine index (Phase 5)
  // Traceability: every Company field must be traceable to >=1 SourceRecord.
  readonly memberRecordIds: readonly SourceRecordId[];
  readonly flags: readonly string[]; // e.g. ['merge_incierto']
  readonly firstSeenAt: string; // ISO 8601 — anchors the recency scoring component
  // Merge is non-destructive: an absorbed Company keeps its row and points
  // at its survivor rather than being deleted.
  readonly mergedInto?: CompanyId;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreComponent {
  readonly value: number; // normalized to [0,1]
  readonly weight: number; // thesis weight applied to this component
}

export interface ScoreBreakdown {
  readonly semantic: ScoreComponent;
  readonly momentum: ScoreComponent;
  readonly keywords: ScoreComponent;
  readonly recency: ScoreComponent;
  // Present only when score is 0 because of a failed hard filter; absent
  // otherwise (exactOptionalPropertyTypes: omit, never assign undefined).
  readonly failedHardFilter?: string;
}

export interface ScoredDeal {
  readonly runId: RunId;
  readonly companyId: CompanyId;
  readonly score: number; // 0-100
  readonly breakdown: ScoreBreakdown;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunStats {
  // Only field explicitly required by spec: "the failed source name MUST be
  // recorded in runs.stats." Kept minimal rather than inventing untested
  // counters.
  readonly failedSources: readonly SourceName[];
}

export interface Run {
  readonly id: RunId;
  readonly thesisName: string;
  readonly status: RunStatus;
  readonly startedAt: string; // ISO 8601
  readonly finishedAt?: string; // ISO 8601
  readonly stats?: RunStats;
}
