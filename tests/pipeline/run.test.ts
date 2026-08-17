// In-memory pipeline tests (spec §14: "implementación en memoria de todos
// los repos + embeddings deterministas + fuentes fixtureadas -> corrida
// completa sin red ni base de datos"). Fixtured `SourceAdapter` fakes are
// used here — NOT the real HN/GitHub/RSS adapters — injected the same way
// the real adapters' own tests fake `fetch` (no global mocking anywhere in
// this project).
//
// Covers this phase's two top acceptance criteria (spec, pipeline-orchestration):
//   - idempotent re-run: running the SAME fixtures twice does not duplicate
//     companies
//   - isolated source failure: one source throwing does not stop the other
//     two, and the run finishes 'partial' with the failed source recorded

import { describe, expect, it } from 'vitest';
import type {
  ExtractedCompany,
  RunId,
  SourceName,
  SourceRecord,
  SourceRecordId,
} from '../../src/domain/entities.js';
import type { SourceAdapter, SourcePage } from '../../src/domain/ports.js';
import { parseThesis, type Thesis } from '../../src/domain/thesis.js';
import { createDeterministicEmbeddingProvider } from '../../src/providers/embeddings/deterministic.js';
import { createRulesLlmProvider } from '../../src/providers/llm/rules.js';
import {
  createInMemoryCompanyRepository,
  createInMemoryRunRepository,
  createInMemoryScoredDealRepository,
  createInMemorySourceRecordRepository,
} from '../doubles/in-memory-repository.js';
import { runPipeline, type RunPipelineDeps } from '../../src/pipeline/run.js';

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
  extracted: ExtractedCompany,
  fetchedAt = '2026-01-01T00:00:00.000Z',
): SourceRecord {
  return {
    id: crypto.randomUUID() as SourceRecordId,
    source,
    sourceId,
    fetchedAt,
    raw: { sourceId },
    extracted,
  };
}

/** A fixtured SourceAdapter — pages are rebuilt fresh on every fetch() call
 * (ignores `since`), so the SAME fixture can be reused across two separate
 * pipeline runs to test idempotency without needing real watermark logic. */
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

// Silences pino's default stdout logging for these tests — the pipeline
// under test IS exercising real structured logging (that's covered by
// inspecting log calls where it matters), but a full run's log volume adds
// noise to `npm run test` output otherwise.
const silentLogger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined };

function makeDeps(sources: readonly SourceAdapter[]): RunPipelineDeps & {
  readonly companiesRepo: ReturnType<typeof createInMemoryCompanyRepository>;
} {
  const companiesRepo = createInMemoryCompanyRepository();
  return {
    companies: companiesRepo,
    companiesRepo,
    sourceRecords: createInMemorySourceRecordRepository(),
    runs: createInMemoryRunRepository(),
    scoredDeals: createInMemoryScoredDealRepository(),
    sources,
    embeddings: createDeterministicEmbeddingProvider(),
    llm: createRulesLlmProvider(),
    logger: silentLogger,
  };
}

describe('runPipeline (in-memory, fixtured sources)', () => {
  it('produces ranked scored deals with a numeric score and a non-empty rationale', async () => {
    const hn = fakeAdapter('hackernews', () => [
      {
        records: [
          makeRecord('hackernews', 'hn-1', {
            name: 'Loglane',
            description: 'open-source logging for developers',
            signals: [
              { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
            ],
          }),
        ],
      },
    ]);
    const deps = makeDeps([hn]);

    const result = await runPipeline(deps, {
      runId: crypto.randomUUID() as RunId,
      thesis: testThesis(),
      now: new Date('2026-01-02T00:00:00.000Z'),
    });

    expect(result.status).toBe('completed');
    expect(result.deals.length).toBeGreaterThan(0);
    const deal = result.deals[0]!;
    expect(typeof deal.score).toBe('number');
    expect(deal.rationale.length).toBeGreaterThan(0);
  });

  it('merges two records sharing a domain across DIFFERENT sources into one company', async () => {
    const hn = fakeAdapter('hackernews', () => [
      {
        records: [
          makeRecord('hackernews', 'hn-acme', {
            name: 'Acme',
            domain: 'acme.com',
            signals: [
              { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
            ],
          }),
        ],
      },
    ]);
    const github = fakeAdapter('github', () => [
      {
        records: [
          makeRecord('github', 'github-acme', {
            name: 'Acme Corp',
            domain: 'acme.com',
            description: 'the acme platform',
            signals: [
              {
                kind: 'github_stars_delta_30d',
                value: 50,
                observedAt: '2026-01-01T00:00:00.000Z',
                source: 'github',
              },
            ],
          }),
        ],
      },
    ]);
    const deps = makeDeps([hn, github]);

    await runPipeline(deps, { runId: crypto.randomUUID() as RunId, thesis: testThesis() });

    const all = await deps.companiesRepo.listAll();
    const canonical = all.filter((c) => c.mergedInto === undefined);
    const acmeCompanies = canonical.filter((c) => c.domain === 'acme.com');

    expect(acmeCompanies).toHaveLength(1);
    expect(acmeCompanies[0]!.memberRecordIds.length).toBe(2);
    expect(acmeCompanies[0]!.signals.map((s) => s.kind).sort()).toEqual(
      ['github_stars_delta_30d', 'hn_show'].sort(),
    );
  });

  it('flags a merge as merge_incierto when domain is unavailable on both sides', async () => {
    const hn = fakeAdapter('hackernews', () => [
      {
        records: [
          makeRecord('hackernews', 'hn-loglane', {
            name: 'Loglane',
            people: ['Jane Doe'],
            signals: [
              { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
            ],
          }),
        ],
      },
    ]);
    const rss = fakeAdapter('rss', () => [
      {
        records: [
          makeRecord('rss', 'rss-loglane', {
            name: 'Loglane',
            people: ['Jane Doe'],
            signals: [
              { kind: 'launch', value: 1, observedAt: '2026-01-02T00:00:00.000Z', source: 'rss' },
            ],
          }),
        ],
      },
    ]);
    const deps = makeDeps([hn, rss]);

    await runPipeline(deps, { runId: crypto.randomUUID() as RunId, thesis: testThesis() });

    const all = await deps.companiesRepo.listAll();
    const canonical = all.filter((c) => c.mergedInto === undefined && c.canonicalName.includes('Loglane'));

    expect(canonical).toHaveLength(1);
    expect(canonical[0]!.flags).toContain('merge_incierto');
  });

  it('idempotency: running the SAME fixtures twice does not create duplicate companies', async () => {
    const buildPages = (): readonly SourcePage[] => [
      {
        records: [
          makeRecord('hackernews', 'hn-idempotent', {
            name: 'Idempo',
            domain: 'idempo.dev',
            signals: [
              { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
            ],
          }),
        ],
      },
    ];
    const deps = makeDeps([fakeAdapter('hackernews', buildPages)]);
    const thesis = testThesis();

    await runPipeline(deps, { runId: crypto.randomUUID() as RunId, thesis });
    const afterFirstRun = await deps.companiesRepo.listAll();

    await runPipeline(deps, { runId: crypto.randomUUID() as RunId, thesis });
    const afterSecondRun = await deps.companiesRepo.listAll();

    expect(afterSecondRun).toHaveLength(afterFirstRun.length);
    const company = afterSecondRun.find((c) => c.domain === 'idempo.dev');
    // Same source record re-delivered twice (upsert dedupes it to the SAME
    // id) -> linkSourceRecord is itself idempotent -> exactly one member.
    expect(company?.memberRecordIds).toHaveLength(1);
  });

  it('partial-run isolation: one source throwing does not stop the other two', async () => {
    const github = fakeAdapter('github', () => [], { error: new Error('GitHub is down') });
    const hn = fakeAdapter('hackernews', () => [
      {
        records: [makeRecord('hackernews', 'hn-survivor', { name: 'Fjordwatch', signals: [] })],
      },
    ]);
    const rss = fakeAdapter('rss', () => [
      {
        records: [makeRecord('rss', 'rss-survivor', { name: 'Nectarine Robotics', signals: [] })],
      },
    ]);
    const deps = makeDeps([github, hn, rss]);

    const result = await runPipeline(deps, {
      runId: crypto.randomUUID() as RunId,
      thesis: testThesis(),
    });

    expect(result.status).toBe('partial');
    expect(result.stats.failedSources).toEqual(['github']);

    const all = await deps.companiesRepo.listAll();
    const names = all.map((c) => c.canonicalName).sort();
    expect(names).toEqual(['Fjordwatch', 'Nectarine Robotics']);

    // The survivors must not just persist as companies (already asserted
    // above) but actually reach the scored, ranked output the caller
    // consumes -- scoreAndPersist scores off listAll(), so a survivor
    // that made it into the company set but was somehow excluded from
    // scoring would be a real regression this alone wouldn't catch.
    const dealNames = result.deals
      .map((d) => all.find((c) => c.id === d.companyId)?.canonicalName)
      .sort();
    expect(dealNames).toEqual(['Fjordwatch', 'Nectarine Robotics']);
  });

  it('cross-run matching by NAME ALONE (no domain on either record) does not create a duplicate company', async () => {
    // Regression test for the blocking-key lookup/storage alignment fixed
    // in this same batch: computeLookupBlockingKeys (repository-query
    // side) must use the SAME naive scheme as the keys actually stored on
    // a Company row, or a second run's name-only candidate would never be
    // found and would silently create a duplicate company instead of
    // merging. Deliberately uses TWO SEPARATE runPipeline() calls (not two
    // records within one run, unlike the merge_incierto test above) to
    // exercise the storage -> lookup round trip across runs, and
    // deliberately gives neither record a domain, forcing resolution to
    // rely on the name4:/trigram blocking keys exclusively.
    const companiesRepo = createInMemoryCompanyRepository();
    const sharedDeps = {
      companies: companiesRepo,
      sourceRecords: createInMemorySourceRecordRepository(),
      runs: createInMemoryRunRepository(),
      scoredDeals: createInMemoryScoredDealRepository(),
      embeddings: createDeterministicEmbeddingProvider(),
      llm: createRulesLlmProvider(),
      logger: silentLogger,
    };

    await runPipeline(
      {
        ...sharedDeps,
        sources: [
          fakeAdapter('hackernews', () => [
            {
              records: [
                makeRecord('hackernews', 'hn-quantstack', { name: 'Quantstack', signals: [] }),
              ],
            },
          ]),
        ],
      },
      { runId: crypto.randomUUID() as RunId, thesis: testThesis() },
    );

    // Re-run with a DIFFERENT adapter set (github instead of hackernews)
    // against the SAME repository, matching by name similarity only.
    await runPipeline(
      {
        ...sharedDeps,
        sources: [
          fakeAdapter('github', () => [
            {
              records: [
                makeRecord('github', 'github-quantstack', { name: 'Quantstack Labs', signals: [] }),
              ],
            },
          ]),
        ],
      },
      { runId: crypto.randomUUID() as RunId, thesis: testThesis() },
    );

    const all = await companiesRepo.listAll();
    const canonical = all.filter((c) => c.mergedInto === undefined);
    const quantstackCompanies = canonical.filter((c) => c.canonicalName.includes('Quantstack'));

    expect(quantstackCompanies).toHaveLength(1);
    expect(quantstackCompanies[0]!.memberRecordIds.length).toBe(2);
  });

  it('status is "failed" (not silently swallowed) when persistence throws after ingestion succeeds', async () => {
    const hn = fakeAdapter('hackernews', () => [
      { records: [makeRecord('hackernews', 'hn-doomed', { name: 'Doomed Co', signals: [] })] },
    ]);
    const deps = makeDeps([hn]);
    const finishedCalls: Array<{ status: string }> = [];
    const spyingRuns: RunPipelineDeps['runs'] = {
      ...deps.runs,
      async finish(id, status, stats) {
        finishedCalls.push({ status });
        await deps.runs.finish(id, status, stats);
      },
    };
    const brokenScoredDeals: RunPipelineDeps['scoredDeals'] = {
      async saveAll(): Promise<void> {
        throw new Error('scored_deals write failed');
      },
    };

    await expect(
      runPipeline(
        { ...deps, runs: spyingRuns, scoredDeals: brokenScoredDeals },
        { runId: crypto.randomUUID() as RunId, thesis: testThesis() },
      ),
    ).rejects.toThrow('scored_deals write failed');

    // A caller polling GET /runs/:id later must see an explicit 'failed'
    // status, not an ambiguous never-finished run -- runs.finish() must
    // have been called with 'failed' BEFORE the error was rethrown, not
    // left silently unfinished.
    expect(finishedCalls).toEqual([{ status: 'failed' }]);
  });

  it('completed status when every source succeeds', async () => {
    const hn = fakeAdapter('hackernews', () => [
      { records: [makeRecord('hackernews', 'hn-ok', { name: 'OkCo', signals: [] })] },
    ]);
    const deps = makeDeps([hn]);

    const result = await runPipeline(deps, {
      runId: crypto.randomUUID() as RunId,
      thesis: testThesis(),
    });

    expect(result.status).toBe('completed');
    expect(result.stats.failedSources).toEqual([]);
  });
});
