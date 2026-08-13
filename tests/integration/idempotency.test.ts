// Spec's own explicit acceptance criterion (source-ingestion capability,
// "Idempotent persistence"): "correr el pipeline dos veces seguidas no
// puede duplicar ninguna empresa — verificado por test, no a ojo."
//
// This test goes beyond the contract suite's own upsert-idempotency
// scenario (tests/contract/source-record-repository.contract.ts, which
// trusts `upsert()`'s own return value) by querying `source_records`
// DIRECTLY via a raw COUNT — proving the row count in the real table,
// not just what the repository's return value claims. Runs against the
// REAL Postgres implementation only (this is explicitly a Postgres
// acceptance test, not a contract-equivalence test).

import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { SourceRecord } from '../../src/domain/entities.js';
import type { Database } from '../../src/db/client.js';
import { createPostgresSourceRecordRepository } from '../../src/db/repository.js';
import { sourceRecords } from '../../src/db/schema.js';
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

function makeSourceRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: crypto.randomUUID() as SourceRecord['id'],
    source: 'hackernews',
    sourceId: 'show-hn-idempotency-1',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    raw: { objectID: 'show-hn-idempotency-1', title: 'Show HN: Example' },
    extracted: { name: 'Example', signals: [] },
    ...overrides,
  };
}

async function countSourceRecords(): Promise<number> {
  const [row] = await db.select({ count: sql<string>`count(*)` }).from(sourceRecords);
  return Number(row?.count ?? 0);
}

describe('SourceRecordRepository idempotency (real Postgres)', () => {
  it('running the same upsert twice does not duplicate the source_records row', async () => {
    const repo = createPostgresSourceRecordRepository(db);
    // Each of these mimics two separate pipeline RUNS re-fetching the SAME
    // upstream item: same (source, sourceId), a FRESH SourceRecordId each
    // time (real adapters always crypto.randomUUID() a new id per fetch —
    // see sources/hackernews.ts), and a later fetchedAt on the second call.
    const firstRunFetch = makeSourceRecord({ fetchedAt: '2026-01-01T00:00:00.000Z' });
    const secondRunFetch = makeSourceRecord({ fetchedAt: '2026-01-02T00:00:00.000Z' });

    const firstResult = await repo.upsert(firstRunFetch);
    expect(firstResult.isNew).toBe(true);
    expect(await countSourceRecords()).toBe(1);

    const secondResult = await repo.upsert(secondRunFetch);

    expect(secondResult.isNew).toBe(false);
    expect(secondResult.id).toBe(firstResult.id);
    // The direct COUNT is the actual acceptance criterion — not trusting
    // the repository's own return value ("no a ojo").
    expect(await countSourceRecords()).toBe(1);

    // The single row now reflects the SECOND (most recent) fetch, proving
    // the ON CONFLICT path genuinely updated rather than silently no-oping.
    const rows = await repo.list(undefined, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fetchedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('running the same logical ingestion THREE times still leaves exactly one row', async () => {
    const repo = createPostgresSourceRecordRepository(db);
    const sourceId = 'show-hn-idempotency-triple';

    for (let i = 0; i < 3; i += 1) {
      await repo.upsert(
        makeSourceRecord({ sourceId, fetchedAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
      );
    }

    expect(await countSourceRecords()).toBe(1);
  });
});
