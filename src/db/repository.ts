// Real Postgres implementations of the 4 domain repository ports
// (design.md "Two Repository Implementations"), over Drizzle + postgres.js.
// Infrastructure layer — src/db/** sits OUTSIDE the ESLint core-layer
// boundary (eslint.config.js CORE_LAYER_GLOBS).
//
// Behavioral reference: tests/doubles/in-memory-repository.ts (Phase 3) —
// this file is written to be PROVABLY equivalent to it, not just
// type-compatible. tests/contract/*.contract.ts runs the identical test
// bodies against both. Every non-obvious behavioral choice below is cross-
// referenced against what the in-memory double actually does.

import { arrayOverlaps, eq, inArray, sql } from 'drizzle-orm';
import type {
  Company,
  CompanyId,
  Signal,
  SourceRecord,
  SourceRecordId,
} from '../domain/entities.js';
import type {
  CompanyRepository,
  RunRepository,
  ScoredDealRepository,
  SourceRecordRepository,
} from '../domain/ports.js';
import type { Database } from './client.js';
import {
  companies,
  companyMembers,
  runs,
  scoredDeals,
  signals,
  sourceRecords,
  sourceWatermarks,
} from './schema.js';

// ---------------------------------------------------------------------------
// Blocking keys — mirrors tests/doubles/in-memory-repository.ts's
// `computeCompanyBlockingKeys` EXACTLY (same constants, same simple
// lowercase-only algorithm — deliberately NOT resolution/normalize.ts's
// real accent/suffix-stripping normalization). This equivalence is
// REQUIRED, not incidental: the contract suite runs identical test bodies
// against both repository implementations, so both must agree bit-for-bit
// on the same input. Duplicated here rather than imported because
// src/db/** must not depend on tests/** at runtime (and tests/** is
// excluded from the production build).
// ---------------------------------------------------------------------------

const TRIGRAM_LENGTH = 3;
const NAME_PREFIX_LENGTH = 4;

export function computeCompanyBlockingKeys(
  company: Pick<Company, 'canonicalName'> & Partial<Pick<Company, 'domain'>>,
): readonly string[] {
  const keys = new Set<string>();
  if (company.domain) {
    keys.add(`domain:${company.domain.toLowerCase()}`);
  }
  const name = company.canonicalName.toLowerCase();
  if (name.length >= NAME_PREFIX_LENGTH) {
    keys.add(`name4:${name.slice(0, NAME_PREFIX_LENGTH)}`);
  }
  for (let i = 0; i <= name.length - TRIGRAM_LENGTH; i += 1) {
    keys.add(`trigram:${name.slice(i, i + TRIGRAM_LENGTH)}`);
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// Row -> domain mapping helpers
// ---------------------------------------------------------------------------

function toSignal(row: typeof signals.$inferSelect): Signal {
  return {
    kind: row.kind,
    value: row.value,
    observedAt: row.observedAt.toISOString(),
    source: row.source,
    ...(row.evidenceUrl ? { evidenceUrl: row.evidenceUrl } : {}),
  };
}

function toSourceRecord(row: typeof sourceRecords.$inferSelect): SourceRecord {
  return {
    id: row.id as SourceRecordId,
    source: row.source,
    sourceId: row.sourceId,
    fetchedAt: row.fetchedAt.toISOString(),
    raw: row.raw,
    extracted: row.extracted,
  };
}

/**
 * Assembles a full `Company` domain object from its row plus its
 * relational data (design.md: `Company.signals`/`memberRecordIds` are
 * reconstructed by query, never duplicated onto the `companies` row).
 *
 * Merge-survivor signal aggregation: rather than physically copying or
 * repointing `signals` rows at merge time, a company's signal history is
 * assembled here as "this row's own signals UNION every company whose
 * `merged_into` points at this row's id". This keeps every signal row
 * immutably tied to whichever cluster member originally observed it (MORE
 * traceable than repointing), needs zero writes at merge time, and is
 * automatically reversible: clearing `merged_into` on the absorbed row
 * stops its signals from being included here, with no signal cleanup step
 * required. `company_members`, by contrast, deliberately uses literal
 * row-copying at merge time (see `merge()` below) because spec §8.1 is
 * explicit that merge "MUST only add rows to company_members" — a stronger,
 * literal requirement that doesn't apply to `signals`.
 */
async function loadCompany(db: Database, row: typeof companies.$inferSelect): Promise<Company> {
  const [memberRows, absorbedRows] = await Promise.all([
    db
      .select({ sourceRecordId: companyMembers.sourceRecordId })
      .from(companyMembers)
      .where(eq(companyMembers.companyId, row.id)),
    db.select({ id: companies.id }).from(companies).where(eq(companies.mergedInto, row.id)),
  ]);

  const clusterIds = [row.id, ...absorbedRows.map((r) => r.id)];
  const signalRows = await db.select().from(signals).where(inArray(signals.companyId, clusterIds));

  return {
    id: row.id as CompanyId,
    canonicalName: row.canonicalName,
    ...(row.domain ? { domain: row.domain } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.sector ? { sector: row.sector } : {}),
    ...(row.estimatedStage ? { estimatedStage: row.estimatedStage } : {}),
    ...(row.oneLiner ? { oneLiner: row.oneLiner } : {}),
    ...(row.people && row.people.length > 0 ? { people: row.people } : {}),
    signals: signalRows.map(toSignal),
    ...(row.embedding ? { embedding: row.embedding } : {}),
    memberRecordIds: memberRows.map((r) => r.sourceRecordId as SourceRecordId),
    flags: row.flags,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    ...(row.mergedInto ? { mergedInto: row.mergedInto as CompanyId } : {}),
  };
}

// ---------------------------------------------------------------------------
// CompanyRepository
// ---------------------------------------------------------------------------

export function createPostgresCompanyRepository(db: Database): CompanyRepository {
  return {
    async findByDomain(domain) {
      const [row] = await db.select().from(companies).where(eq(companies.domain, domain)).limit(1);
      return row ? loadCompany(db, row) : undefined;
    },

    async findByBlockingKeys(keys) {
      if (keys.length === 0) return [];
      const rows = await db
        .select()
        .from(companies)
        .where(arrayOverlaps(companies.blockingKeys, [...keys]));
      return Promise.all(rows.map((row) => loadCompany(db, row)));
    },

    async save(company) {
      const values = {
        id: company.id,
        canonicalName: company.canonicalName,
        domain: company.domain ?? null,
        description: company.description ?? null,
        sector: company.sector ?? null,
        estimatedStage: company.estimatedStage ?? null,
        embedding: company.embedding ? [...company.embedding] : null,
        firstSeenAt: new Date(company.firstSeenAt),
        lastSeenAt: new Date(company.lastSeenAt),
        flags: [...company.flags],
        mergedInto: company.mergedInto ?? null,
        oneLiner: company.oneLiner ?? null,
        people: company.people ? [...company.people] : null,
        blockingKeys: [...computeCompanyBlockingKeys(company)],
      };
      // Idempotent upsert by id: `save` touches ONLY the companies row's own
      // scalar/array columns, never signals/company_members — those are
      // relational and owned by linkSourceRecord/appendSignals (see
      // loadCompany's header comment).
      await db
        .insert(companies)
        .values(values)
        .onConflictDoUpdate({
          target: companies.id,
          set: {
            canonicalName: values.canonicalName,
            domain: values.domain,
            description: values.description,
            sector: values.sector,
            estimatedStage: values.estimatedStage,
            embedding: values.embedding,
            firstSeenAt: values.firstSeenAt,
            lastSeenAt: values.lastSeenAt,
            flags: values.flags,
            mergedInto: values.mergedInto,
            oneLiner: values.oneLiner,
            people: values.people,
            blockingKeys: values.blockingKeys,
          },
        });
    },

    async linkSourceRecord(id, rec) {
      // Idempotent: re-linking the same (company, record) pair is a no-op,
      // never a duplicate row (matches the in-memory double's
      // `memberRecordIds.includes(rec)` guard).
      await db
        .insert(companyMembers)
        .values({ companyId: id, sourceRecordId: rec })
        .onConflictDoNothing();
    },

    async appendSignals(id, newSignals) {
      if (newSignals.length === 0) return;
      await db.insert(signals).values(
        newSignals.map((s) => ({
          companyId: id,
          kind: s.kind,
          value: s.value,
          observedAt: new Date(s.observedAt),
          source: s.source,
          evidenceUrl: s.evidenceUrl ?? null,
        })),
      );
    },

    async setEmbedding(id, embedding) {
      await db
        .update(companies)
        .set({ embedding: [...embedding] })
        .where(eq(companies.id, id));
    },

    async merge(survivorId, absorbedId, ev) {
      const [survivor] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, survivorId))
        .limit(1);
      const [absorbed] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, absorbedId))
        .limit(1);
      if (!survivor || !absorbed) {
        throw new Error(
          `merge: unknown company id (survivor=${survivorId}, absorbed=${absorbedId})`,
        );
      }

      // Non-destructive company_members: COPY the absorbed row's own links
      // onto the survivor as NEW rows — never repoint or delete the
      // absorbed row's originals. Spec §8.1: "Merge MUST only add rows to
      // company_members, and MUST be reversible by removing those rows
      // without any data loss" — reversal = delete the newly-added
      // survivor-side rows; the absorbed row's original links are
      // untouched throughout.
      const absorbedMembers = await db
        .select({ sourceRecordId: companyMembers.sourceRecordId })
        .from(companyMembers)
        .where(eq(companyMembers.companyId, absorbedId));
      if (absorbedMembers.length > 0) {
        await db
          .insert(companyMembers)
          .values(
            absorbedMembers.map((m) => ({
              companyId: survivorId,
              sourceRecordId: m.sourceRecordId,
            })),
          )
          .onConflictDoNothing();
      }

      // Signals need no write here — see loadCompany()'s merged_into
      // read-time aggregation, which already includes the absorbed
      // company's signals once `mergedInto` is set below.

      const flags =
        ev.confidence === 'uncertain'
          ? Array.from(new Set([...survivor.flags, 'merge_incierto']))
          : survivor.flags;

      // Non-destructive: the absorbed row is UPDATED in place (mergedInto
      // pointer added), never deleted — it must remain retrievable via
      // findByDomain/findByBlockingKeys exactly as before (matches the
      // in-memory double's documented contract).
      await Promise.all([
        db.update(companies).set({ flags }).where(eq(companies.id, survivorId)),
        db.update(companies).set({ mergedInto: survivorId }).where(eq(companies.id, absorbedId)),
      ]);
    },
  };
}

// ---------------------------------------------------------------------------
// SourceRecordRepository
// ---------------------------------------------------------------------------

export function createPostgresSourceRecordRepository(db: Database): SourceRecordRepository {
  return {
    async upsert(record) {
      const [row] = await db
        .insert(sourceRecords)
        .values({
          id: record.id,
          source: record.source,
          sourceId: record.sourceId,
          fetchedAt: new Date(record.fetchedAt),
          raw: record.raw,
          extracted: record.extracted,
        })
        .onConflictDoUpdate({
          target: [sourceRecords.source, sourceRecords.sourceId],
          set: {
            fetchedAt: new Date(record.fetchedAt),
            raw: record.raw,
            extracted: record.extracted,
          },
        })
        .returning({ id: sourceRecords.id });

      // isNew detection: every adapter (see sources/hackernews.ts) generates
      // a FRESH crypto.randomUUID() for `record.id` on every fetch, even for
      // an already-known (source, sourceId). ON CONFLICT DO UPDATE never
      // touches the `id` column, so a pre-existing row's original id always
      // "wins" over the caller's fresh `record.id`. Comparing the two is
      // therefore a precise, non-heuristic signal — not a coincidence-prone
      // guess — for "did this INSERT actually happen, or did ON CONFLICT
      // fire?".
      const resultId = row!.id as SourceRecordId;
      return { id: resultId, isNew: resultId === record.id };
    },

    async list(after, limit) {
      let cursor: { fetchedAt: Date; id: string } | undefined;
      if (after !== undefined) {
        const [row] = await db
          .select({ fetchedAt: sourceRecords.fetchedAt, id: sourceRecords.id })
          .from(sourceRecords)
          .where(eq(sourceRecords.id, after))
          .limit(1);
        cursor = row;
      }

      // Composite tuple ordering (fetched_at, id) gives a total, stable
      // order without needing an extra insertion-order column (not in §7's
      // literal schema): `id` is a random UUID, so it doesn't reflect real
      // insertion sequence, but it DOES make the (fetchedAt, id) pair
      // unique and deterministic, which is what cursor pagination actually
      // needs ("no gaps or duplicates" — spec's own wording — not literal
      // insertion order). If `after` doesn't resolve to an existing row,
      // pagination restarts from the beginning — matching the in-memory
      // double's own `indexOf(after) + 1` behavior, which is `0` when
      // `indexOf` returns -1 for an unknown id.
      const whereClause = cursor
        ? sql`(${sourceRecords.fetchedAt}, ${sourceRecords.id}) > (${cursor.fetchedAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
        : undefined;

      const rows = await db
        .select()
        .from(sourceRecords)
        .where(whereClause)
        .orderBy(sourceRecords.fetchedAt, sourceRecords.id)
        .limit(limit);

      return rows.map(toSourceRecord);
    },
  };
}

// ---------------------------------------------------------------------------
// RunRepository
// ---------------------------------------------------------------------------

export function createPostgresRunRepository(db: Database): RunRepository {
  return {
    async start(id, thesis) {
      await db.insert(runs).values({ id, startedAt: new Date(), thesisHash: thesis });
    },

    async watermark(source) {
      const [row] = await db
        .select({ watermark: sourceWatermarks.watermark })
        .from(sourceWatermarks)
        .where(eq(sourceWatermarks.source, source))
        .limit(1);
      return row?.watermark;
    },

    async setWatermark(source, w) {
      await db
        .insert(sourceWatermarks)
        .values({ source, watermark: w })
        .onConflictDoUpdate({ target: sourceWatermarks.source, set: { watermark: w } });
    },

    async finish(id, status, stats) {
      const result = await db
        .update(runs)
        .set({ finishedAt: new Date(), status, stats })
        .where(eq(runs.id, id))
        .returning({ id: runs.id });
      if (result.length === 0) {
        throw new Error(`finish: run ${id} was never started`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// ScoredDealRepository
// ---------------------------------------------------------------------------

export function createPostgresScoredDealRepository(db: Database): ScoredDealRepository {
  return {
    async saveAll(runId, deals) {
      // "idempotent re-run" (matches the in-memory double's documented
      // behavior): saveAll REPLACES, not appends, a run's deals on a second
      // call. Delete-then-insert inside one transaction so a concurrent
      // reader never observes a partially-cleared state.
      await db.transaction(async (tx) => {
        await tx.delete(scoredDeals).where(eq(scoredDeals.runId, runId));
        if (deals.length > 0) {
          await tx.insert(scoredDeals).values(
            deals.map((d) => ({
              runId: d.runId,
              companyId: d.companyId,
              score: d.score,
              breakdown: d.breakdown,
              rationale: d.rationale,
              flags: [...d.flags],
            })),
          );
        }
      });
    },
  };
}
