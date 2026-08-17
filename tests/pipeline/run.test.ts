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
