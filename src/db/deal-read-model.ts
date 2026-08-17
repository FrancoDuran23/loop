// Postgres implementation of DealReadModel (domain/ports.ts) — the 5th
// segregated port design.md's D4 decision row named but left unshaped,
// pinned now by the real GET /deals / GET /deals/:id / GET
// /companies/:id/provenance contracts (Phase 9b). Infrastructure layer,
// outside the ESLint core-layer boundary — free to import drizzle-orm,
// db/repository.ts, and resolution/resolver.ts (core -> infra imports are
// the correct, allowed direction; only the reverse is banned).
//
// Kept in its own file rather than folded into db/repository.ts: this port
// answers a fundamentally different question (denormalized, paginated READ
// projections for the HTTP API) than the other 4 (transactional
// read/write on the domain's own aggregates), and its query shapes
// (cursor tuple comparison, cross-table joins, read-time provenance
// reconstruction) are substantial enough to warrant their own reviewable
// unit.

import { and, asc, desc, eq, gte, sql } from 'drizzle-orm';
import type { CompanyId, RunId, SourceRecord, Stage } from '../domain/entities.js';
import type {
  CompanyProvenance,
  DealDetail,
  DealListFilter,
  DealListItem,
  DealListPage,
  DealReadModel,
  FieldProvenance,
} from '../domain/ports.js';
import { resolveFieldConflict } from '../resolution/resolver.js';
import type { Database } from './client.js';
import { loadCompany, toSourceRecord } from './repository.js';
import { companies, companyMembers, scoredDeals, sourceRecords } from './schema.js';

// ---------------------------------------------------------------------------
// listDeals — cursor pagination.
//
// Cursor semantics (domain/ports.ts DealCursor doc comment): "everything
// after this exact (score, companyId) position under ORDER BY score DESC,
// companyId ASC". A single tuple `<` comparison assumes BOTH columns sort
// the SAME direction, which isn't true here (score DESC, companyId ASC) —
// so the "next page" condition is spelled out explicitly rather than as a
// row-value comparison: strictly lower score, OR equal score with a
// strictly greater companyId (the ASC tiebreak). This is what makes the
// cursor stable under insertion: a new deal scored between two page
// requests lands somewhere in the (score, companyId) order and never
// causes an already-seen row to reappear or an unseen row to be skipped.
// ---------------------------------------------------------------------------

function toDealListItem(row: {
  runId: string;
  companyId: string;
  score: number;
  breakdown: unknown;
  rationale: string;
  flags: readonly string[];
  canonicalName: string;
  domain: string | null;
  sector: string | null;
  estimatedStage: string | null;
}): DealListItem {
  return {
    deal: {
      runId: row.runId as RunId,
      companyId: row.companyId as CompanyId,
      score: row.score,
      breakdown: row.breakdown as DealListItem['deal']['breakdown'],
      rationale: row.rationale,
      flags: row.flags,
    },
    company: {
      id: row.companyId as CompanyId,
      canonicalName: row.canonicalName,
      ...(row.domain ? { domain: row.domain } : {}),
      ...(row.sector ? { sector: row.sector } : {}),
      ...(row.estimatedStage ? { estimatedStage: row.estimatedStage as Stage } : {}),
    },
  };
}

async function listDeals(db: Database, filter: DealListFilter): Promise<DealListPage> {
  const conditions = [eq(scoredDeals.runId, filter.runId)];
  if (filter.minScore !== undefined) {
    conditions.push(gte(scoredDeals.score, filter.minScore));
  }
  if (filter.sector !== undefined) {
    conditions.push(eq(companies.sector, filter.sector));
  }
  if (filter.stage !== undefined) {
    conditions.push(eq(companies.estimatedStage, filter.stage));
  }
  if (filter.cursor) {
    const { score, companyId } = filter.cursor;
    conditions.push(
      sql`(${scoredDeals.score} < ${score} OR (${scoredDeals.score} = ${score} AND ${scoredDeals.companyId} > ${companyId}))`,
    );
  }

  // Fetch one extra row beyond `limit` — a cheap, standard way to know
  // whether a next page exists without a separate COUNT query.
  const rows = await db
    .select({
      runId: scoredDeals.runId,
      companyId: scoredDeals.companyId,
      score: scoredDeals.score,
      breakdown: scoredDeals.breakdown,
      rationale: scoredDeals.rationale,
      flags: scoredDeals.flags,
      canonicalName: companies.canonicalName,
      domain: companies.domain,
      sector: companies.sector,
      estimatedStage: companies.estimatedStage,
    })
    .from(scoredDeals)
    .innerJoin(companies, eq(companies.id, scoredDeals.companyId))
    .where(and(...conditions))
    .orderBy(desc(scoredDeals.score), asc(scoredDeals.companyId))
    .limit(filter.limit + 1);

  const hasNextPage = rows.length > filter.limit;
  const pageRows = hasNextPage ? rows.slice(0, filter.limit) : rows;
  const items = pageRows.map(toDealListItem);
  const last = items.at(-1);

  return {
    items,
    ...(hasNextPage && last
      ? { nextCursor: { score: last.deal.score, companyId: last.deal.companyId } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// getDeal — one company's deal within one run, plus the full Company
// (signals/evidence live there) and its member SourceRecords.
// ---------------------------------------------------------------------------

async function getSourceRecordsForCompany(
  db: Database,
  companyId: CompanyId,
): Promise<readonly SourceRecord[]> {
  const rows = await db
    .select({ record: sourceRecords })
    .from(companyMembers)
    .innerJoin(sourceRecords, eq(sourceRecords.id, companyMembers.sourceRecordId))
    .where(eq(companyMembers.companyId, companyId));
  return rows.map((r) => toSourceRecord(r.record));
}

async function getDeal(
  db: Database,
  runId: RunId,
  companyId: CompanyId,
): Promise<DealDetail | undefined> {
  const [dealRow] = await db
    .select()
    .from(scoredDeals)
    .where(and(eq(scoredDeals.runId, runId), eq(scoredDeals.companyId, companyId)))
    .limit(1);
  if (!dealRow) return undefined;

  const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!companyRow) return undefined;

  const [company, sourceRecordsForCompany] = await Promise.all([
    loadCompany(db, companyRow),
    getSourceRecordsForCompany(db, companyId),
  ]);

  return {
    deal: {
      runId: dealRow.runId as RunId,
      companyId: dealRow.companyId as CompanyId,
      score: dealRow.score,
      breakdown: dealRow.breakdown,
      rationale: dealRow.rationale,
      flags: dealRow.flags,
    },
    company,
    sourceRecords: sourceRecordsForCompany,
  };
}

// ---------------------------------------------------------------------------
// getCompanyProvenance — best-effort, READ-TIME reconstruction (NOT a
// stored audit log — see domain/ports.ts's CompanyProvenance/FieldProvenance
// doc comments for the full honesty framing). Reuses the EXACT same
// resolveFieldConflict source-precedence + most-recent-tiebreak primitive
// pipeline/run.ts's attachRecordToCompany already applies at merge/attach
// time — this just re-runs it read-time over the company's full member
// SourceRecord set instead of incrementally over one incoming record.
// ---------------------------------------------------------------------------

/** Picks the SourceRecord that "wins" for a given ExtractedCompany field
 * under source-precedence + most-recent-tiebreak — by passing whole records
 * as the generic T to resolveFieldConflict, the winning RECORD (not just
 * the winning value) comes back, so its id/source/url can be cited. */
function pickWinningRecord(
  records: readonly SourceRecord[],
  getValue: (r: SourceRecord) => string | undefined,
): SourceRecord | undefined {
  const observations = records
    .filter((r) => getValue(r) !== undefined)
    .map((r) => ({ value: r, source: r.source, observedAt: r.fetchedAt }));
  return resolveFieldConflict(observations);
}

function toReconstructedField(
  field: FieldProvenance['field'],
  record: SourceRecord | undefined,
  getValue: (r: SourceRecord) => string | undefined,
  fallbackValue: string | undefined,
): FieldProvenance {
  if (!record) {
    return { field, value: fallbackValue, method: 'reconstructed-from-source-precedence' };
  }
  return {
    field,
    value: getValue(record) ?? fallbackValue,
    method: 'reconstructed-from-source-precedence',
    source: record.source,
    sourceRecordId: record.id,
    ...(record.extracted.url ? { evidenceUrl: record.extracted.url } : {}),
  };
}

async function getCompanyProvenance(
  db: Database,
  companyId: CompanyId,
): Promise<CompanyProvenance | undefined> {
  const [companyRow] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!companyRow) return undefined;

  const [company, records] = await Promise.all([
    loadCompany(db, companyRow),
    getSourceRecordsForCompany(db, companyId),
  ]);

  const nameRecord = pickWinningRecord(records, (r) => r.extracted.name);
  const domainRecord = pickWinningRecord(records, (r) => r.extracted.domain);
  const descriptionRecord = pickWinningRecord(records, (r) => r.extracted.description);

  const fields: FieldProvenance[] = [
    toReconstructedField('canonicalName', nameRecord, (r) => r.extracted.name, company.canonicalName),
    toReconstructedField('domain', domainRecord, (r) => r.extracted.domain, company.domain),
    toReconstructedField(
      'description',
      descriptionRecord,
      (r) => r.extracted.description,
      company.description,
    ),
    // sector/estimatedStage are LLM enrichment output (providers/llm/*.ts) —
    // never present on any ExtractedCompany, so there is genuinely no
    // SourceRecord to honestly cite. See FieldProvenance.method's own doc
    // comment for why this tier exists.
    { field: 'sector', value: company.sector, method: 'enrichment-not-attributable' },
    { field: 'estimatedStage', value: company.estimatedStage, method: 'enrichment-not-attributable' },
  ];

  return { companyId, fields };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPostgresDealReadModel(db: Database): DealReadModel {
  return {
    listDeals: (filter) => listDeals(db, filter),
    getDeal: (runId, companyId) => getDeal(db, runId, companyId),
    getCompanyProvenance: (companyId) => getCompanyProvenance(db, companyId),
  };
}
