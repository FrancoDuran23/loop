// Pipeline-level idempotency + partial-run isolation, run against REAL
// Postgres (not just the in-memory suite in tests/pipeline/run.test.ts) —
// spec's own top two acceptance criteria for pipeline-orchestration, proven
// against the actual repository implementation the CLI wires up in
// production, matching the existing pattern
// (tests/integration/idempotency.test.ts did the same for
// SourceRecordRepository alone; this does it for the FULL pipeline).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { RunId, SourceName, SourceRecord, SourceRecordId } from '../../src/domain/entities.js';
import type { SourceAdapter, SourcePage } from '../../src/domain/ports.js';
import type { Database } from '../../src/db/client.js';
import {
  createPostgresCompanyRepository,
  createPostgresRunRepository,
  createPostgresScoredDealRepository,
  createPostgresSourceRecordRepository,
} from '../../src/db/repository.js';
import { parseThesis, type Thesis } from '../../src/domain/thesis.js';
import { createDeterministicEmbeddingProvider } from '../../src/providers/embeddings/deterministic.js';
import { createRulesLlmProvider } from '../../src/providers/llm/rules.js';
import { runPipeline, type RunPipelineDeps } from '../../src/pipeline/run.js';
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

const TEST_THESIS_YAML = `
name: "Dev tools B2B, etapa temprana"
description: >
  Herramientas para desarrolladores, open-source-first, pre-seed a Series A.
hard_filters:
  stages: [pre-seed, seed, series-a, unknown]
  exclude_sectors: [gambling]
soft_preferences:
  sectors: [devtools]
  geos: [us]
  keywords: [open-source]
anti_patterns:
  - "no code in public repo"
weights:
  semantic: 0.4
  momentum: 0.3
  keywords: 0.2
  recency: 0.1
`;

function testThesis(): Thesis {
  return parseThesis(TEST_THESIS_YAML);
}

function makeRecord(
  source: SourceName,
  sourceId: string,
  name: string,
  domain?: string,
): SourceRecord {
  return {
    id: crypto.randomUUID() as SourceRecordId,
    source,
    sourceId,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    raw: { sourceId },
    extracted: {
      name,
      ...(domain ? { domain } : {}),
      signals: [
        { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source },
      ],
    },
  };
}

function fakeAdapter(
  source: SourceName,
  buildPages: () => readonly SourcePage[],
  options: { readonly error?: Error } = {},
): SourceAdapter {
  return {
    source,
    async *fetch() {
      if (options.error) throw options.error;
      for (const page of buildPages()) {
        yield page;
      }
    },
  };
}

const silentLogger = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

function makePostgresDeps(sources: readonly SourceAdapter[]): RunPipelineDeps {
  return {
    companies: createPostgresCompanyRepository(db),
    sourceRecords: createPostgresSourceRecordRepository(db),
    runs: createPostgresRunRepository(db),
    scoredDeals: createPostgresScoredDealRepository(db),
    sources,
    embeddings: createDeterministicEmbeddingProvider(),
    llm: createRulesLlmProvider(),
    logger: silentLogger,
  };
}

describe('runPipeline against real Postgres', () => {
  it('idempotency: running the SAME fixture twice does not duplicate companies or source_records', async () => {
    const buildPages = (): readonly SourcePage[] => [
      { records: [makeRecord('hackernews', 'hn-pg-idempotent', 'PgIdempo', 'pgidempo.dev')] },
    ];
    const deps = makePostgresDeps([fakeAdapter('hackernews', buildPages)]);
    const thesis = testThesis();

    const first = await runPipeline(deps, { runId: crypto.randomUUID() as RunId, thesis });
    expect(first.status).toBe('completed');
    const companiesAfterFirst = await deps.companies.listAll();

    const second = await runPipeline(deps, { runId: crypto.randomUUID() as RunId, thesis });
    expect(second.status).toBe('completed');
    const companiesAfterSecond = await deps.companies.listAll();

    expect(companiesAfterSecond).toHaveLength(companiesAfterFirst.length);
    const company = companiesAfterSecond.find((c) => c.domain === 'pgidempo.dev');
    expect(company).toBeDefined();
    expect(company?.memberRecordIds).toHaveLength(1);
  });

  it('partial-run isolation: one source failing does not stop the others, and is recorded in stats', async () => {
    const github = fakeAdapter('github', () => [], { error: new Error('GitHub is down') });
    const hn = fakeAdapter('hackernews', () => [
      { records: [makeRecord('hackernews', 'hn-pg-survivor', 'PgFjordwatch')] },
    ]);
    const rss = fakeAdapter('rss', () => [
      { records: [makeRecord('rss', 'rss-pg-survivor', 'PgNectarineRobotics')] },
    ]);
    const deps = makePostgresDeps([github, hn, rss]);

    const result = await runPipeline(deps, {
      runId: crypto.randomUUID() as RunId,
      thesis: testThesis(),
    });

    expect(result.status).toBe('partial');
    expect(result.stats.failedSources).toEqual(['github']);

    const all = await deps.companies.listAll();
    const names = all.map((c) => c.canonicalName).sort();
    expect(names).toEqual(['PgFjordwatch', 'PgNectarineRobotics']);
  });
});
