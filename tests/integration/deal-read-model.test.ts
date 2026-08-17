// Integration tests for src/db/deal-read-model.ts (the DealReadModel port's
// Postgres implementation) against a real Postgres instance — same pattern
// as tests/integration/postgres-repository.contract.test.ts. No in-memory
// DealReadModel exists (domain/ports.ts's own header comment: this port is
// an API READ concern, tested here against real Postgres rather than via a
// second implementation with no production purpose).

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { Company, CompanyId, RunId, ScoredDeal, SourceRecord } from '../../src/domain/entities.js';
import type { Database } from '../../src/db/client.js';
import { createPostgresDealReadModel } from '../../src/db/deal-read-model.js';
import {
  createPostgresCompanyRepository,
  createPostgresRunRepository,
  createPostgresScoredDealRepository,
  createPostgresSourceRecordRepository,
} from '../../src/db/repository.js';
import { closeDatabase, setupTestDatabase, truncateAllTables } from './db-test-helper.js';

let db: Database;
let client: postgres.Sql;

beforeAll(async () => {
  const setup = await setupTestDatabase();
  db = setup.db;
  client = setup.client;
});

afterEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  await closeDatabase(client);
});

function zeroBreakdown(score: number): ScoredDeal['breakdown'] {
  return {
    semantic: { value: score / 100, weight: 1 },
    momentum: { value: 0.5, weight: 0 },
    keywords: { value: 0.5, weight: 0 },
    recency: { value: 0.5, weight: 0 },
  };
}

/** Seeds one company (with a backing SourceRecord + company_members link)
 * and returns its id, so tests can build a small ranked batch. */
async function seedCompany(
  overrides: Partial<Company> & { readonly canonicalName: string },
): Promise<{ readonly companyId: CompanyId; readonly sourceRecord: SourceRecord }> {
  const companies = createPostgresCompanyRepository(db);
  const sourceRecords = createPostgresSourceRecordRepository(db);

  const companyId = randomUUID() as CompanyId;
  const now = new Date().toISOString();
  const company: Company = {
    id: companyId,
    signals: [],
    memberRecordIds: [],
    flags: [],
    firstSeenAt: now,
    lastSeenAt: now,
    ...overrides,
  };
  await companies.save(company);

  const { id: sourceRecordId } = await sourceRecords.upsert({
    id: randomUUID() as SourceRecord['id'],
    source: 'github',
    sourceId: randomUUID(),
    fetchedAt: now,
    raw: {},
    extracted: {
      name: overrides.canonicalName,
      ...(overrides.domain ? { domain: overrides.domain } : {}),
      ...(overrides.description ? { description: overrides.description } : {}),
      url: `https://example.com/${overrides.canonicalName}`,
      signals: [],
    },
  });
  await companies.linkSourceRecord(companyId, sourceRecordId);
  const sourceRecord = (await sourceRecords.list(undefined, 1000)).find(
    (r) => r.id === sourceRecordId,
  )!;

  return { companyId, sourceRecord };
}

async function seedRunWithDeals(
  deals: ReadonlyArray<{ readonly companyId: CompanyId; readonly score: number }>,
): Promise<RunId> {
  const runs = createPostgresRunRepository(db);
  const scoredDeals = createPostgresScoredDealRepository(db);

  const runId = randomUUID() as RunId;
  await runs.start(runId, 'read-model-test-thesis');
  await scoredDeals.saveAll(
    runId,
    deals.map((d) => ({
      runId,
      companyId: d.companyId,
      score: d.score,
      breakdown: zeroBreakdown(d.score),
      rationale: `rationale for ${d.companyId}`,
      flags: [],
    })),
  );
  await runs.finish(runId, 'completed', { failedSources: [] });
  return runId;
}

describe('DealReadModel (Postgres)', () => {
  it('listDeals returns an empty page when the run has no scored deals', async () => {
    const readModel = createPostgresDealReadModel(db);
    const runId = randomUUID() as RunId;

    const page = await readModel.listDeals({ runId, limit: 20 });

    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });

  it('listDeals returns deals sorted by score descending, with company projection', async () => {
    const low = await seedCompany({ canonicalName: 'Low Co', sector: 'devtools' });
    const high = await seedCompany({ canonicalName: 'High Co', sector: 'devtools' });
    const runId = await seedRunWithDeals([
      { companyId: low.companyId, score: 20 },
      { companyId: high.companyId, score: 90 },
    ]);
    const readModel = createPostgresDealReadModel(db);

    const page = await readModel.listDeals({ runId, limit: 20 });

    expect(page.items.map((i) => i.company.canonicalName)).toEqual(['High Co', 'Low Co']);
    expect(page.items[0]?.deal.score).toBe(90);
  });

  it('listDeals filters by minScore, sector, and stage', async () => {
    const matches = await seedCompany({
      canonicalName: 'Matches Filter',
      sector: 'fintech',
      estimatedStage: 'seed',
    });
    const wrongSector = await seedCompany({
      canonicalName: 'Wrong Sector',
      sector: 'devtools',
      estimatedStage: 'seed',
    });
    const wrongStage = await seedCompany({
      canonicalName: 'Wrong Stage',
      sector: 'fintech',
      estimatedStage: 'later',
    });
    const tooLowScore = await seedCompany({
      canonicalName: 'Too Low Score',
      sector: 'fintech',
      estimatedStage: 'seed',
    });
    const runId = await seedRunWithDeals([
      { companyId: matches.companyId, score: 80 },
      { companyId: wrongSector.companyId, score: 85 },
      { companyId: wrongStage.companyId, score: 85 },
      { companyId: tooLowScore.companyId, score: 10 },
    ]);
    const readModel = createPostgresDealReadModel(db);

    const page = await readModel.listDeals({
      runId,
      limit: 20,
      minScore: 50,
      sector: 'fintech',
      stage: 'seed',
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.company.canonicalName).toBe('Matches Filter');
  });

  it('cursor pagination walks every deal exactly once across 2+ pages, no gaps or duplicates', async () => {
    const seeded = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        seedCompany({ canonicalName: `Company ${i}`, sector: 'devtools' }),
      ),
    );
    const runId = await seedRunWithDeals(
      seeded.map((s, i) => ({ companyId: s.companyId, score: (i + 1) * 10 })),
    );
    const readModel = createPostgresDealReadModel(db);

    const seenCompanyIds: string[] = [];
    let cursor: { readonly score: number; readonly companyId: CompanyId } | undefined;
    let pages = 0;
    do {
      const page = await readModel.listDeals({ runId, limit: 2, ...(cursor ? { cursor } : {}) });
      seenCompanyIds.push(...page.items.map((i) => i.company.id));
      cursor = page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10); // guard against an infinite loop bug
    } while (cursor);

    expect(pages).toBe(3); // 5 items, limit 2 -> 2 + 2 + 1
    expect(seenCompanyIds).toHaveLength(5);
    expect(new Set(seenCompanyIds).size).toBe(5); // no duplicates
    // Highest score first (50) through lowest (10) — cursor order preserved.
    expect(seenCompanyIds).toEqual(seeded.map((s) => s.companyId).reverse());
  });

  it('getDeal returns the deal, full company, and its source records', async () => {
    const seeded = await seedCompany({ canonicalName: 'Detail Co', domain: 'detail.example.com' });
    const runId = await seedRunWithDeals([{ companyId: seeded.companyId, score: 77 }]);
    const readModel = createPostgresDealReadModel(db);

    const detail = await readModel.getDeal(runId, seeded.companyId);

    expect(detail?.deal.score).toBe(77);
    expect(detail?.company.canonicalName).toBe('Detail Co');
    expect(detail?.sourceRecords).toHaveLength(1);
    expect(detail?.sourceRecords[0]?.id).toBe(seeded.sourceRecord.id);
  });

  it('getDeal returns undefined when the company has no deal in that run', async () => {
    const seeded = await seedCompany({ canonicalName: 'No Deal Co' });
    const runId = await seedRunWithDeals([]);
    const readModel = createPostgresDealReadModel(db);

    expect(await readModel.getDeal(runId, seeded.companyId)).toBeUndefined();
  });

  it('getCompanyProvenance attributes canonicalName/domain/description to the winning source record', async () => {
    const seeded = await seedCompany({
      canonicalName: 'Provenance Co',
      domain: 'provenance.example.com',
      description: 'a company for provenance testing',
    });
    const readModel = createPostgresDealReadModel(db);

    const provenance = await readModel.getCompanyProvenance(seeded.companyId);

    const nameField = provenance?.fields.find((f) => f.field === 'canonicalName');
    expect(nameField?.value).toBe('Provenance Co');
    expect(nameField?.method).toBe('reconstructed-from-source-precedence');
    expect(nameField?.source).toBe('github');
    expect(nameField?.sourceRecordId).toBe(seeded.sourceRecord.id);

    const sectorField = provenance?.fields.find((f) => f.field === 'sector');
    expect(sectorField?.method).toBe('enrichment-not-attributable');
    expect(sectorField?.source).toBeUndefined();
  });

  it('getCompanyProvenance returns undefined for an unknown company', async () => {
    const readModel = createPostgresDealReadModel(db);
    expect(await readModel.getCompanyProvenance(randomUUID() as CompanyId)).toBeUndefined();
  });
});
