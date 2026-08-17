// Pure domain types. Zero runtime logic, zero imports of infrastructure —
// this file is type/interface declarations only.
//
// Field shapes for SourceRecord/ExtractedCompany/Signal/Company/ScoredDeal
// match spec §6 verbatim. A few fields beyond the §6 snippet are additive,
// not contradictory, and exist to serve behavior the spec describes in
// prose elsewhere: `Company.flags` carries the 'merge_incierto' visibility
// requirement from §8.1, `Company.mergedInto` implements §8.1's "merge is
// non-destructive and reversible", and `Company.oneLiner`/`people` support
// the enrichment output described in §3. These are noted inline.

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
// Company.estimatedStage. Exported as a const tuple so thesis.ts can build a
// Zod enum from the same single source of truth.
export const STAGES = ['pre-seed', 'seed', 'series-a', 'later', 'unknown'] as const;
export type Stage = (typeof STAGES)[number];

export type RunStatus = 'completed' | 'partial' | 'failed';

// ---------------------------------------------------------------------------
// Signals — every signal must be traceable and dated (spec: "A Signal MUST
// NEVER be stored as a bare number without a date and source"). `kind` is a
// closed union per spec §6 — adding a new signal kind is a deliberate
// domain-level decision, not something a source adapter should be able to
// introduce silently by typing an arbitrary string.
// ---------------------------------------------------------------------------

export type SignalKind =
  | 'github_stars'
  | 'github_stars_delta_30d'
  | 'hn_points'
  | 'hn_show'
  | 'hiring'
  | 'launch';

export interface Signal {
  readonly kind: SignalKind;
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
  readonly url?: string;
  // Founder/contributor names — used as an entity-resolution pair-scoring
  // signal ("shared person in people").
  readonly people?: readonly string[];
  readonly location?: string;
  readonly signals: readonly Signal[];
}

export interface SourceRecord {
  readonly id: SourceRecordId;
  readonly source: SourceName;
  readonly sourceId: string; // native id in the source system; UNIQUE(source, sourceId)
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
  readonly canonicalName: string;
  readonly domain?: string; // UNIQUE WHERE domain IS NOT NULL
  readonly description?: string;
  readonly sector?: string;
  readonly estimatedStage?: Stage;
  readonly oneLiner?: string;
  readonly people?: readonly string[];
  // Aggregated, deduped signal history across every merged SourceRecord —
  // scoring's momentum component reads this, not a single source's signals.
  readonly signals: readonly Signal[];
  readonly embedding?: readonly number[]; // 384-dim; ivfflat cosine index (Phase 5)
  // Traceability: every Company field must be traceable to >=1 SourceRecord.
  readonly memberRecordIds: readonly SourceRecordId[];
  readonly flags: readonly string[]; // e.g. ['merge_incierto']
  readonly firstSeenAt: string; // ISO 8601 — anchors the recency scoring component
  readonly lastSeenAt: string; // ISO 8601 — most recent observation across all sources
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
  readonly flags: readonly string[]; // e.g. ['fuera de geografía', 'etapa incierta']
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
  // Phase 9b widening (documented, deliberate): RunStatus itself stays a
  // closed TERMINAL union ('completed' | 'partial' | 'failed') — finish()
  // still only ever accepts one of those three. But GET /runs/:id (Phase 9b)
  // needs to represent a run that has started but not yet finished (the
  // fire-and-forget POST /runs background execution is still in flight) —
  // db/schema.ts's `runs.status` column is nullable specifically for this
  // ("NULL truthfully represents 'not finished yet'"). Rather than inventing
  // a 4th terminal-looking RunStatus member (which would force every
  // existing exhaustive-terminal-status site to handle a non-terminal case
  // that never applies to them), the READ-side `Run.status` is widened to
  // `RunStatus | 'running'` — a small, disclosed type change scoped to this
  // one field, not a change to the RunStatus union itself.
  readonly status: RunStatus | 'running';
  readonly startedAt: string; // ISO 8601
  readonly finishedAt?: string; // ISO 8601
  readonly stats?: RunStats;
}
