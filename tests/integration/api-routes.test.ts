// Full-stack API integration tests: real Hono app (src/api/server.ts's
// createServerApp), real Postgres (same db-test-helper.ts pattern every
// other integration suite uses), real DealReadModel/RunRepository/
// CompanyRepository. The ONE thing swapped out for a fast, deterministic
// test double is the SourceAdapter (a live HackerNews/GitHub/RSS call would
// make this suite slow and network-flaky) — everything else in the
// pipeline (ingest -> resolve -> enrich -> score -> persist) runs for
// real. This is what makes the "POST /runs returns fast, then the run
// really completes, then GET /deals shows real ranked deals" claim
// meaningful rather than mocked away.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import type { RunId, SourceName, SourceRecordId } from '../../src/domain/entities.js';
import type { SourceAdapter } from '../../src/domain/ports.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/client.js';
import { createPostgresDealReadModel } from '../../src/db/deal-read-model.js';
import {
  createPostgresCompanyRepository,
  createPostgresRunRepository,
  createPostgresScoredDealRepository,
  createPostgresSourceRecordRepository,
} from '../../src/db/repository.js';
import { createDeterministicEmbeddingProvider } from '../../src/providers/embeddings/deterministic.js';
import { createRulesLlmProvider } from '../../src/providers/llm/rules.js';
import { createServerApp } from '../../src/api/server.js';
import type { Runtime } from '../../src/runtime.js';
import { closeDatabase, setupTestDatabase, truncateAllTables } from './db-test-helper.js';

const THESIS_YAML = `
name: API Test Thesis
description: Exercises the API end to end without any hard filter rejecting the fixture company
hard_filters:
  stages: [unknown]
  exclude_sectors: []
soft_preferences:
  sectors: []
  geos: []
  keywords: []
anti_patterns: []
weights:
  semantic: 0.4
  momentum: 0.3
  keywords: 0.2
  recency: 0.1
`;

let db: Database;
let client: postgres.Sql;
let tempDir: string;
let thesisPath: string;

beforeAll(async () => {
  const setup = await setupTestDatabase();
  db = setup.db;
  client = setup.client;
  tempDir = mkdtempSync(join(tmpdir(), 'deal-signal-api-test-'));
  thesisPath = join(tempDir, 'thesis.yaml');
  writeFileSync(thesisPath, THESIS_YAML);
});

afterEach(async () => {
  await truncateAllTables(db);
});

afterAll(async () => {
  rmSync(tempDir, { recursive: true, force: true });
  await closeDatabase(client);
});

/** A single-page SourceAdapter that resolves INSTANTLY with one fixture
 * record — no network, no rate limiting, no retries. Stands in for the 3
 * real adapters (github/hackernews/rss) so this suite proves the REST of
 * the pipeline (ingest -> resolve -> enrich -> score -> persist) runs for
 * real through the HTTP layer, without depending on live third-party APIs
 * being reachable/fast in CI. */
function makeFixtureSourceAdapter(name: SourceName = 'hackernews'): SourceAdapter {
  return {
    source: name,
    async *fetch() {
      yield {
        records: [
          {
            id: randomUUID() as SourceRecordId,
            source: name,
            sourceId: 'api-test-fixture-1',
            fetchedAt: new Date().toISOString(),
            raw: {},
            extracted: {
              name: 'API Test Co',
              description: 'a fixture company seeded for API integration testing',
              signals: [],
            },
          },
        ],
      };
    },
  };
}

function makeTestRuntime(): Runtime {
  return {
    config: loadConfig(),
    db,
    companies: createPostgresCompanyRepository(db),
    sourceRecords: createPostgresSourceRecordRepository(db),
    runs: createPostgresRunRepository(db),
    scoredDeals: createPostgresScoredDealRepository(db),
    dealReadModel: createPostgresDealReadModel(db),
    embeddings: createDeterministicEmbeddingProvider(),
    llm: createRulesLlmProvider(),
    buildSourceAdapter: (name) => makeFixtureSourceAdapter(name),
    buildSourceAdapters: () => [makeFixtureSourceAdapter()],
    newRunId: () => randomUUID() as RunId,
    close: async () => {},
  };
}

describe('API routes — real Postgres, fast fixture source adapter', () => {
  it('GET /health pings the real database and returns 200', async () => {
    const app = createServerApp(makeTestRuntime());
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /deals returns an empty list before any run has completed', async () => {
    const app = createServerApp(makeTestRuntime());
    const res = await app.request('/deals');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: null, items: [], cursor: null });
  });

  it(
    'POST /runs responds fast without waiting for the pipeline, and the run eventually completes with real ranked deals visible via GET /deals, /deals/:id, and /companies/:id/provenance',
    async () => {
      const app = createServerApp(makeTestRuntime());

      const startedAt = Date.now();
      const postRes = await app.request('/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thesisPath }),
      });
      const elapsedMs = Date.now() - startedAt;

      expect(postRes.status).toBe(202);
      const { runId } = (await postRes.json()) as { runId: string };
      expect(typeof runId).toBe('string');
      // Generous but meaningful: proves the handler did NOT await the full
      // ingest->resolve->enrich->score->persist pipeline before responding
      // — only the fast thesis load/parse precondition (see server.ts's
      // createTriggerRun doc comment).
      expect(elapsedMs).toBeLessThan(2000);

      // Poll for real — proof the background run actually executes and
      // reaches a terminal status, not just that 202 came back fast.
      let status = 'running';
      for (let attempt = 0; attempt < 50 && status === 'running'; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const runRes = await app.request(`/runs/${runId}`);
        const run = (await runRes.json()) as { status: string };
        status = run.status;
      }
      expect(status).toBe('completed');

      const dealsRes = await app.request('/deals');
      const dealsBody = (await dealsRes.json()) as {
        runId: string;
        items: ReadonlyArray<{ companyId: string; canonicalName: string; score: number }>;
      };
      expect(dealsBody.runId).toBe(runId);
      expect(dealsBody.items).toHaveLength(1);
      expect(dealsBody.items[0]?.canonicalName).toBe('API Test Co');
      expect(typeof dealsBody.items[0]?.score).toBe('number');

      const companyId = dealsBody.items[0]!.companyId;

      const detailRes = await app.request(`/deals/${companyId}`);
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as {
        company: { canonicalName: string };
        sourceRecords: readonly unknown[];
      };
      expect(detail.company.canonicalName).toBe('API Test Co');
      expect(detail.sourceRecords).toHaveLength(1);

      const provenanceRes = await app.request(`/companies/${companyId}/provenance`);
      expect(provenanceRes.status).toBe(200);
      const provenance = (await provenanceRes.json()) as {
        fields: ReadonlyArray<{ field: string; value: string | undefined; method: string }>;
      };
      const nameField = provenance.fields.find((f) => f.field === 'canonicalName');
      expect(nameField?.value).toBe('API Test Co');
      expect(nameField?.method).toBe('reconstructed-from-source-precedence');
    },
    15000,
  );
});
