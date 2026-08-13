// Drizzle table definitions — spec §7 schema, column-for-column, plus 4
// additive columns on `companies` documented below. Infrastructure layer:
// imports drizzle-orm/pg-core freely, lives OUTSIDE the ESLint core-layer
// boundary (eslint.config.js CORE_LAYER_GLOBS does not include src/db/**) —
// this is exactly where Postgres/Drizzle-specific code belongs (design.md
// D1).
//
// pgvector support: `vector(384)` and the `ivfflat` / `vector_cosine_ops`
// index are BOTH first-class in the installed drizzle-orm version (checked
// directly against node_modules before writing this file — see
// `PgVectorBuilder` in drizzle-orm/pg-core/columns/vector_extension/vector.*
// and `IndexBuilderOn.using()` / `ExtraConfigColumn.op()` in
// drizzle-orm/pg-core/indexes.d.ts, which lists `vector_cosine_ops` as a
// typed `PgIndexOpClass` and `ivfflat` as a typed `PgIndexMethod`). No
// raw-SQL workaround was needed for the column or the index definition —
// only `CREATE EXTENSION IF NOT EXISTS vector;` needed a hand-edit to the
// first generated migration, since drizzle-kit has no concept of Postgres
// extensions and never generates that statement itself.

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type {
  ExtractedCompany,
  RunStats,
  RunStatus,
  ScoreBreakdown,
  SignalKind,
  SourceName,
  Stage,
} from '../domain/entities.js';

const EMBEDDING_DIMENSIONS = 384;

// ---------------------------------------------------------------------------
// source_records — spec §7 verbatim. UNIQUE(source, source_id) IS ingestion
// idempotency: SourceRecordRepository.upsert relies on this constraint via
// ON CONFLICT (repository.ts).
// ---------------------------------------------------------------------------
export const sourceRecords = pgTable(
  'source_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<SourceName>().notNull(),
    sourceId: text('source_id').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
    raw: jsonb('raw').notNull(),
    extracted: jsonb('extracted').$type<ExtractedCompany>().notNull(),
  },
  (table) => [uniqueIndex('source_records_source_source_id_key').on(table.source, table.sourceId)],
);

// ---------------------------------------------------------------------------
// companies — spec §7 verbatim columns: id, canonical_name, domain,
// description, sector, estimated_stage, embedding vector(384) + ivfflat
// cosine index, first_seen_at, last_seen_at, UNIQUE(domain) WHERE domain IS
// NOT NULL.
//
// 5 additive columns beyond the literal §7 list. 4 back a `Company` domain
// field (src/domain/entities.ts) that spec prose requires elsewhere, even
// though §7's table snippet doesn't spell out a column for it. Skipping
// these would mean a domain field silently fails to round-trip through
// persistence — real data loss, worse than not having the field at all.
// See entities.ts's own header comment for the same cross-reference:
//   - flags        text[] default '{}' — §8.1 'merge_incierto' visibility
//   - merged_into  uuid, nullable, self-FK — §8.1 "merge is non-destructive
//                  and reversible" (the absorbed row's survivor pointer)
//   - one_liner    text, nullable — §3 enrichment output
//   - people       text[], nullable — §3 enrichment output; also the
//                  entity-resolution "shared person" pair-scoring signal
//                  (resolver.ts PairCandidate.people)
// The 5th, `blocking_keys`, is NOT a Company domain field — it materializes
// `CompanyRepository.findByBlockingKeys`, which design.md's "Two Repository
// Implementations" table explicitly specifies for the Postgres impl:
// "Blocking keys via GIN/btree; findByBlockingKeys is one IN query" — so
// this column is a design-sanctioned lookup index, not an ad hoc addition.
// See repository.ts for exactly how it's computed and queried.
//
// `Company.signals` and `Company.memberRecordIds` deliberately have NO
// column here — they are relational (signals table, company_members table)
// and are reconstructed by query/join in repository.ts when a Company is
// loaded, never duplicated onto this row (see repository.ts for the exact
// read-time aggregation, including how a merge survivor's signals/members
// are assembled).
// ---------------------------------------------------------------------------
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    canonicalName: text('canonical_name').notNull(),
    domain: text('domain'),
    description: text('description'),
    sector: text('sector'),
    estimatedStage: text('estimated_stage').$type<Stage>(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    // --- additive columns, see header comment above ---
    flags: text('flags').array().notNull().default([]),
    mergedInto: uuid('merged_into').references((): AnyPgColumn => companies.id),
    oneLiner: text('one_liner'),
    people: text('people').array(),
    blockingKeys: text('blocking_keys').array().notNull().default([]),
  },
  (table) => [
    uniqueIndex('companies_domain_key')
      .on(table.domain)
      .where(sql`${table.domain} IS NOT NULL`),
    index('companies_embedding_ivfflat_idx').using(
      'ivfflat',
      table.embedding.op('vector_cosine_ops'),
    ),
    index('companies_blocking_keys_gin_idx').using('gin', table.blockingKeys),
  ],
);

// ---------------------------------------------------------------------------
// company_members — spec §7 verbatim: "el merge, auditable y reversible".
// Composite PK doubles as the uniqueness/idempotency guard for
// linkSourceRecord and for merge's record-copying (see repository.ts):
// re-linking the same (company, record) pair is a no-op via ON CONFLICT DO
// NOTHING, never a duplicate row.
// ---------------------------------------------------------------------------
export const companyMembers = pgTable(
  'company_members',
  {
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    sourceRecordId: uuid('source_record_id')
      .notNull()
      .references(() => sourceRecords.id),
  },
  (table) => [primaryKey({ columns: [table.companyId, table.sourceRecordId] })],
);

// ---------------------------------------------------------------------------
// signals — spec §7 verbatim. `value` is doublePrecision (not `real`) to
// avoid float4 precision loss on large cumulative counters (e.g. GitHub
// star counts can exceed float4's ~7 significant digits at scale).
// ---------------------------------------------------------------------------
export const signals = pgTable('signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id')
    .notNull()
    .references(() => companies.id),
  kind: text('kind').$type<SignalKind>().notNull(),
  value: doublePrecision('value').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  source: text('source').$type<SourceName>().notNull(),
  evidenceUrl: text('evidence_url'),
});

// ---------------------------------------------------------------------------
// runs — spec §7 verbatim column name is `thesis_hash`. The RunRepository
// port's `start(id, thesis: string)` parameter is stored here as-is (today
// that's the thesis NAME per entities.ts Run.thesisName — no hashing is
// performed by this phase). Reconciling the §7 column name with an actual
// content hash, if ever needed for run-level change detection, is future
// work and is not introduced speculatively here.
//
// `status` is nullable, not `.notNull()`. RunStatus (entities.ts) is
// `'completed' | 'partial' | 'failed'` — a closed, purely TERMINAL union
// with no "in progress" member. `start()` never receives a status (only
// `finish(id, status, stats)` does), so between start and finish there is
// genuinely no valid RunStatus value to store — NULL truthfully represents
// "not finished yet" rather than requiring an invented 4th status value
// that would need a domain-type change out of this phase's scope.
// ---------------------------------------------------------------------------
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  thesisHash: text('thesis_hash').notNull(),
  status: text('status').$type<RunStatus>(),
  stats: jsonb('stats').$type<RunStats>(),
});

// ---------------------------------------------------------------------------
// source_watermarks — NOT in the literal §7 six-table list. Added because
// `RunRepository.watermark(source)` / `setWatermark(source, w)` (ports.ts,
// verbatim) is source-keyed and run-INdependent — this exactly mirrors how
// tests/doubles/in-memory-repository.ts models it internally (a standalone
// `Map<SourceName, string>`, never tied to any specific `runs.id`). §7's
// `runs` table has no column that could represent this: a single run
// touches MULTIPLE sources, so no scalar column on `runs` fits, and
// `RunStats` (entities.ts) is explicitly documented there as "kept
// minimal" — not meant to carry invented fields like a watermark map.
// Skipping this table would leave two MANDATED port methods completely
// unimplementable against Postgres — a hard functional gap, not a
// nice-to-have, and the direct blocker for spec's "second run fetches only
// new data" requirement.
// ---------------------------------------------------------------------------
export const sourceWatermarks = pgTable('source_watermarks', {
  source: text('source').$type<SourceName>().primaryKey(),
  watermark: text('watermark').notNull(),
});

// ---------------------------------------------------------------------------
// scored_deals — spec §7 verbatim: PRIMARY KEY(run_id, company_id).
// ---------------------------------------------------------------------------
export const scoredDeals = pgTable(
  'scored_deals',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id),
    score: doublePrecision('score').notNull(),
    breakdown: jsonb('breakdown').$type<ScoreBreakdown>().notNull(),
    rationale: text('rationale').notNull(),
    flags: text('flags').array().notNull().default([]),
  },
  (table) => [primaryKey({ columns: [table.runId, table.companyId] })],
);
