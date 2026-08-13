// Runs the SAME shared contracts (tests/contract/*.contract.ts) against the
// REAL Postgres implementation (src/db/repository.ts) that
// tests/doubles/in-memory-repository.test.ts runs against the in-memory
// double — design.md: "Identical behavior is proven, not asserted." A
// divergence between the two implementations fails here even though the
// test bodies are identical to the in-memory suite's.
//
// Requires a reachable Postgres (docker-compose.yml locally, a GitHub
// Actions service in CI — see .github/workflows/ci.yml). No testcontainers
// (spec §14).

import { afterAll, afterEach, beforeAll } from 'vitest';
import type postgres from 'postgres';
import type { SourceRecordId } from '../../src/domain/entities.js';
import type { Database } from '../../src/db/client.js';
import {
  computeCompanyBlockingKeys,
  createPostgresCompanyRepository,
  createPostgresSourceRecordRepository,
} from '../../src/db/repository.js';
import { runCompanyRepositoryContract } from '../contract/company-repository.contract.js';
import { runSourceRecordRepositoryContract } from '../contract/source-record-repository.contract.js';
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

// Real Postgres enforces company_members.source_record_id -> source_records
// FK integrity (the in-memory double has none), so the CompanyRepository
// contract's `linkSourceRecord`/`merge` tests need a REAL backing
// source_records row here, unlike the in-memory suite's bare
// crypto.randomUUID(). Found by running the contract against this real
// implementation (Phase 5) — see company-repository.contract.ts's own
// header comment.
async function createBackedSourceRecordId(): Promise<SourceRecordId> {
  const sourceRecordRepo = createPostgresSourceRecordRepository(db);
  const { id } = await sourceRecordRepo.upsert({
    id: crypto.randomUUID() as SourceRecordId,
    source: 'hackernews',
    sourceId: crypto.randomUUID(),
    fetchedAt: new Date().toISOString(),
    raw: {},
    extracted: { name: 'Contract Test Fixture', signals: [] },
  });
  return id;
}

runCompanyRepositoryContract({
  createRepository: () => createPostgresCompanyRepository(db),
  computeBlockingKeys: computeCompanyBlockingKeys,
  createSourceRecordId: createBackedSourceRecordId,
});

runSourceRecordRepositoryContract({
  createRepository: () => createPostgresSourceRecordRepository(db),
});
