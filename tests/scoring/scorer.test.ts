import { describe, expect, it } from 'vitest';
import type { Company, CompanyId, RunId, Signal } from '../../src/domain/entities.js';
import type { Thesis } from '../../src/domain/thesis.js';
import { createDeterministicEmbeddingProvider } from '../../src/providers/embeddings/deterministic.js';
import { createRulesLlmProvider } from '../../src/providers/llm/rules.js';
import {
  checkHardFilters,
  combineWeightedScore,
  cosineSimilarity,
  keywordsComponent,
  percentileRanks,
  rawMomentum,
  recencyComponent,
  scoreCompanies,
  scoreSingleCompanyForTesting,
  semanticComponent,
  type ScoreCompaniesOptions,
} from '../../src/scoring/scorer.js';

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: crypto.randomUUID() as CompanyId,
    canonicalName: 'Example Co',
    signals: [],
    memberRecordIds: [],
    flags: [],
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeThesis(overrides: Partial<Thesis> = {}): Thesis {
  return {
    name: 'Dev tools B2B',
    description: 'Investing in developer tools with an open-source-first go-to-market.',
    hard_filters: { stages: ['seed', 'series-a'], exclude_sectors: ['gambling'] },
    soft_preferences: {
      sectors: ['devtools'],
      geos: ['latam'],
      keywords: ['open-source', 'api-first'],
    },
    anti_patterns: ['no code in public repo'],
    weights: { semantic: 0.4, momentum: 0.3, keywords: 0.2, recency: 0.1 },
    ...overrides,
  };
}

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    kind: 'github_stars_delta_30d',
    value: 10,
    observedAt: '2026-01-01T00:00:00.000Z',
    source: 'github',
    ...overrides,
  };
}

function makeOptions(overrides: Partial<ScoreCompaniesOptions> = {}): ScoreCompaniesOptions {
  return {
    runId: crypto.randomUUID() as RunId,
    embeddings: createDeterministicEmbeddingProvider(),
    llm: createRulesLlmProvider(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkHardFilters — disqualification short-circuit
// ---------------------------------------------------------------------------

describe('checkHardFilters', () => {
  it('fails when stage is not in hard_filters.stages', () => {
    const company = makeCompany({ estimatedStage: 'later' });
    const thesis = makeThesis({ hard_filters: { stages: ['seed'], exclude_sectors: [] } });

    const result = checkHardFilters(company, thesis);

    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toContain('later');
      expect(result.stageWasUnknown).toBe(false);
    }
  });

  it('fails when sector is in hard_filters.exclude_sectors', () => {
    const company = makeCompany({ estimatedStage: 'seed', sector: 'gambling' });
    const thesis = makeThesis({
      hard_filters: { stages: ['seed'], exclude_sectors: ['gambling'] },
    });

    const result = checkHardFilters(company, thesis);

    expect(result.failed).toBe(true);
    if (result.failed) expect(result.reason).toContain('gambling');
  });

  it('does NOT fail on sector when company.sector is undefined (absence is not exclusion evidence)', () => {
    const company = makeCompany({ estimatedStage: 'seed' }); // no sector
    const thesis = makeThesis({
      hard_filters: { stages: ['seed'], exclude_sectors: ['gambling'] },
    });

    const result = checkHardFilters(company, thesis);

    expect(result.failed).toBe(false);
  });

  it('treats an undefined estimatedStage as unknown and fails when "unknown" is not an allowed stage', () => {
    const company = makeCompany(); // no estimatedStage
    const thesis = makeThesis({ hard_filters: { stages: ['seed'], exclude_sectors: [] } });

    const result = checkHardFilters(company, thesis);

    expect(result.failed).toBe(true);
    expect(result.stageWasUnknown).toBe(true);
    if (result.failed) expect(result.reason).toContain('unconfirmed');
  });

  it('passes an undefined estimatedStage when the operator explicitly allows "unknown"', () => {
    const company = makeCompany(); // no estimatedStage
    const thesis = makeThesis({
      hard_filters: { stages: ['seed', 'unknown'], exclude_sectors: [] },
    });

    const result = checkHardFilters(company, thesis);

    expect(result.failed).toBe(false);
    expect(result.stageWasUnknown).toBe(true);
  });

  it('treats a literal estimatedStage of "unknown" identically to a missing one', () => {
    const withLiteralUnknown = makeCompany({ estimatedStage: 'unknown' });
    const withMissing = makeCompany();
    const thesis = makeThesis({ hard_filters: { stages: ['seed'], exclude_sectors: [] } });

    expect(checkHardFilters(withLiteralUnknown, thesis)).toEqual(
      checkHardFilters(withMissing, thesis),
    );
  });
});

// ---------------------------------------------------------------------------
// semanticComponent / cosineSimilarity — pure math
// ---------------------------------------------------------------------------

describe('semanticComponent', () => {
  it('maps identical vectors (cosine=1) to 1', () => {
    expect(semanticComponent([1, 0], [1, 0])).toBeCloseTo(1, 5);
  });

  it('maps opposite vectors (cosine=-1) to 0', () => {
    expect(semanticComponent([1, 0], [-1, 0])).toBeCloseTo(0, 5);
  });

  it('maps orthogonal vectors (cosine=0) to 0.5', () => {
    expect(semanticComponent([1, 0], [0, 1])).toBeCloseTo(0.5, 5);
  });

  it('cosineSimilarity returns 0 for empty or mismatched-length vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Momentum — raw log transform + batch percentile ranking
// ---------------------------------------------------------------------------

describe('rawMomentum', () => {
  it('uses log1p of momentum-relevant signal values, ignoring absolute github_stars', () => {
    const spiky = makeCompany({
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 200 })],
    });
    const accumulatedOnly = makeCompany({
      // Absolute cumulative counter — spec's own explicit counter-example of
      // what NOT to treat as momentum.
      signals: [makeSignal({ kind: 'github_stars', value: 5000 })],
    });

    expect(rawMomentum(spiky)).toBeGreaterThan(0);
    expect(rawMomentum(accumulatedOnly)).toBe(0);
  });

  it('sums log1p across DIFFERENT signal kinds (more channels of activity = more momentum)', () => {
    const oneSignal = makeCompany({ signals: [makeSignal({ kind: 'hn_points', value: 50 })] });
    const twoSignals = makeCompany({
      signals: [
        makeSignal({ kind: 'hn_points', value: 50 }),
        makeSignal({ kind: 'launch', value: 1 }),
      ],
    });

    expect(rawMomentum(twoSignals)).toBeGreaterThan(rawMomentum(oneSignal));
  });

  it('uses only the MOST RECENT observation per kind, not a sum of every historical observation', () => {
    const company = makeCompany({
      signals: [
        makeSignal({
          kind: 'github_stars_delta_30d',
          value: 10,
          observedAt: '2026-01-01T00:00:00.000Z',
        }),
        makeSignal({
          kind: 'github_stars_delta_30d',
          value: 200,
          observedAt: '2026-02-01T00:00:00.000Z',
        }),
      ],
    });

    expect(rawMomentum(company)).toBeCloseTo(Math.log1p(200), 10);
  });
});

describe('percentileRanks', () => {
  it('returns 0.5 for a single-item batch — no distribution to rank against', () => {
    expect(percentileRanks([42])).toEqual([0.5]);
  });

  it('returns an empty array for an empty batch', () => {
    expect(percentileRanks([])).toEqual([]);
  });

  it('ranks strictly higher values with strictly higher percentiles', () => {
    const [low, mid, high] = percentileRanks([1, 5, 10]);
    expect(low).toBeLessThan(mid!);
    expect(mid).toBeLessThan(high!);
  });

  it('gives tied values equal percentile ranks', () => {
    const [a, b, c] = percentileRanks([3, 3, 9]);
    expect(a).toBe(b);
    expect(c).toBeGreaterThan(a!);
  });
});

describe('scoreCompanies — momentum percentile within the batch', () => {
  it('ranks a company with clearly higher recent signal velocity above one with clearly lower velocity', async () => {
    const highMomentum = makeCompany({
      canonicalName: 'Spiky Co',
      estimatedStage: 'seed',
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 500 })],
    });
    const lowMomentum = makeCompany({
      canonicalName: 'Quiet Co',
      estimatedStage: 'seed',
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 1 })],
    });
    // Isolate momentum: weight everything else at 0.
    const thesis = makeThesis({
      weights: { semantic: 0, momentum: 1, keywords: 0, recency: 0 },
    });

    const deals = await scoreCompanies([highMomentum, lowMomentum], thesis, makeOptions());
    const highDeal = deals.find((d) => d.companyId === highMomentum.id)!;
    const lowDeal = deals.find((d) => d.companyId === lowMomentum.id)!;

    expect(highDeal.breakdown.momentum.value).toBeGreaterThan(lowDeal.breakdown.momentum.value);
    expect(highDeal.score).toBeGreaterThan(lowDeal.score);
  });

  it('is a PERCENTILE WITHIN THE RUN, not a global/absolute measure — the same raw momentum ranks differently in a different batch', async () => {
    const company = makeCompany({
      estimatedStage: 'seed',
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 50 })],
    });
    const strongerPeer = makeCompany({
      estimatedStage: 'seed',
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 5000 })],
    });
    const weakerPeer = makeCompany({
      estimatedStage: 'seed',
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 1 })],
    });
    const thesis = makeThesis({ weights: { semantic: 0, momentum: 1, keywords: 0, recency: 0 } });

    const dealsWithStrongerPeer = await scoreCompanies(
      [company, strongerPeer],
      thesis,
      makeOptions(),
    );
    const dealsWithWeakerPeer = await scoreCompanies([company, weakerPeer], thesis, makeOptions());

    const momentumWithStrongerPeer = dealsWithStrongerPeer.find((d) => d.companyId === company.id)!
      .breakdown.momentum.value;
    const momentumWithWeakerPeer = dealsWithWeakerPeer.find((d) => d.companyId === company.id)!
      .breakdown.momentum.value;

    expect(momentumWithWeakerPeer).toBeGreaterThan(momentumWithStrongerPeer);
  });
});

// ---------------------------------------------------------------------------
// Keywords coverage + anti-pattern penalty
// ---------------------------------------------------------------------------

describe('keywordsComponent', () => {
  it('scores full coverage when every soft_preference keyword appears in name+description', () => {
    const company = makeCompany({
      canonicalName: 'OpenAPI Co',
      description: 'An open-source, api-first developer platform.',
    });
    const thesis = makeThesis({
      soft_preferences: { sectors: [], geos: [], keywords: ['open-source', 'api-first'] },
      anti_patterns: [],
    });

    expect(keywordsComponent(company, thesis)).toBe(1);
  });

  it('scores partial coverage when only some keywords match', () => {
    const company = makeCompany({ canonicalName: 'Acme', description: 'An open-source toolkit.' });
    const thesis = makeThesis({
      soft_preferences: { sectors: [], geos: [], keywords: ['open-source', 'api-first'] },
      anti_patterns: [],
    });

    expect(keywordsComponent(company, thesis)).toBeCloseTo(0.5, 5);
  });

  it('treats an empty keywords list as full coverage (nothing required, nothing missing)', () => {
    const company = makeCompany({ canonicalName: 'Acme', description: 'Whatever it does.' });
    const thesis = makeThesis({
      soft_preferences: { sectors: [], geos: [], keywords: [] },
      anti_patterns: [],
    });

    expect(keywordsComponent(company, thesis)).toBe(1);
  });

  it('penalizes coverage when an anti_pattern phrase is present, clamped to [0,1]', () => {
    const company = makeCompany({
      canonicalName: 'Acme',
      description: 'open-source but sadly no code in public repo yet.',
    });
    const thesis = makeThesis({
      soft_preferences: { sectors: [], geos: [], keywords: ['open-source'] },
      anti_patterns: ['no code in public repo'],
    });

    // coverage=1, one anti-pattern match -> 1 - 0.5 = 0.5
    expect(keywordsComponent(company, thesis)).toBeCloseTo(0.5, 5);
  });

  it('never goes below 0 even with multiple anti-pattern matches', () => {
    const company = makeCompany({
      canonicalName: 'Acme',
      description: 'no code in public repo, and also vaporware with no traction.',
    });
    const thesis = makeThesis({
      soft_preferences: { sectors: [], geos: [], keywords: [] },
      anti_patterns: ['no code in public repo', 'vaporware', 'no traction'],
    });

    expect(keywordsComponent(company, thesis)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Recency — exponential decay from firstSeenAt
// ---------------------------------------------------------------------------

describe('recencyComponent', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('gives a company first seen today a value close to 1', () => {
    const company = makeCompany({ firstSeenAt: now.toISOString() });
    expect(recencyComponent(company, now)).toBeCloseTo(1, 5);
  });

  it('gives a company first seen at exactly one half-life (30 days) a value of ~0.5', () => {
    const company = makeCompany({ firstSeenAt: '2026-05-02T00:00:00.000Z' }); // 30 days before `now`
    expect(recencyComponent(company, now)).toBeCloseTo(0.5, 2);
  });

  it('ranks a more recently seen company above an older one, all else equal', () => {
    const newer = makeCompany({ firstSeenAt: '2026-05-25T00:00:00.000Z' });
    const older = makeCompany({ firstSeenAt: '2025-01-01T00:00:00.000Z' });

    expect(recencyComponent(newer, now)).toBeGreaterThan(recencyComponent(older, now));
  });
});

// ---------------------------------------------------------------------------
// Weighted combination arithmetic — exact, given known component values
// ---------------------------------------------------------------------------

describe('combineWeightedScore', () => {
  it('computes 100 * Sum(weight_i * component_i) exactly', () => {
    const score = combineWeightedScore(
      { semantic: 0.8, momentum: 0.5, keywords: 1, recency: 0.2 },
      { semantic: 0.4, momentum: 0.3, keywords: 0.2, recency: 0.1 },
    );
    // 100 * (0.4*0.8 + 0.3*0.5 + 0.2*1 + 0.1*0.2) = 100 * (0.32+0.15+0.2+0.02) = 69
    expect(score).toBeCloseTo(69, 8);
  });

  it('returns 0 when every component is 0', () => {
    const score = combineWeightedScore(
      { semantic: 0, momentum: 0, keywords: 0, recency: 0 },
      { semantic: 0.4, momentum: 0.3, keywords: 0.2, recency: 0.1 },
    );
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scoreCompanies — end-to-end batch behavior
// ---------------------------------------------------------------------------

describe('scoreCompanies', () => {
  it('scores 0 and sets breakdown.failedHardFilter for an excluded-sector company, skipping weighted computation', async () => {
    const company = makeCompany({ estimatedStage: 'seed', sector: 'gambling' });
    const thesis = makeThesis({
      hard_filters: { stages: ['seed'], exclude_sectors: ['gambling'] },
    });

    const [deal] = await scoreCompanies([company], thesis, makeOptions());

    expect(deal!.score).toBe(0);
    expect(deal!.breakdown.failedHardFilter).toContain('gambling');
    expect(deal!.breakdown.semantic.value).toBe(0);
    expect(deal!.breakdown.momentum.value).toBe(0);
  });

  it('produces a breakdown independently recomputable to the same score (auditability)', async () => {
    const company = makeCompany({
      estimatedStage: 'seed',
      description: 'An open-source, api-first developer platform.',
      signals: [makeSignal({ kind: 'launch', value: 1 })],
    });
    const thesis = makeThesis();

    const [deal] = await scoreCompanies([company], thesis, makeOptions());
    const { semantic, momentum, keywords, recency } = deal!.breakdown;
    const recomputed =
      100 *
      (semantic.weight * semantic.value +
        momentum.weight * momentum.value +
        keywords.weight * keywords.value +
        recency.weight * recency.value);

    expect(deal!.score).toBeCloseTo(recomputed, 8);
  });

  it('carries over pre-existing company flags and adds "etapa incierta" when stage was unknown but explicitly allowed', async () => {
    const company = makeCompany({ flags: ['merge_incierto'] }); // no estimatedStage
    const thesis = makeThesis({ hard_filters: { stages: ['unknown'], exclude_sectors: [] } });

    const [deal] = await scoreCompanies([company], thesis, makeOptions());

    expect(deal!.flags).toContain('merge_incierto');
    expect(deal!.flags).toContain('etapa incierta');
    expect(deal!.score).toBeGreaterThanOrEqual(0);
  });

  it('produces a non-empty rationale for every company, including hard-filtered ones', async () => {
    const passing = makeCompany({ estimatedStage: 'seed' });
    const filtered = makeCompany({ estimatedStage: 'later' });
    const thesis = makeThesis({ hard_filters: { stages: ['seed'], exclude_sectors: [] } });

    const deals = await scoreCompanies([passing, filtered], thesis, makeOptions());

    for (const deal of deals) {
      expect(deal.rationale.length).toBeGreaterThan(0);
    }
    const filteredDeal = deals.find((d) => d.companyId === filtered.id)!;
    expect(filteredDeal.rationale).toContain('0');
  });

  it('returns an empty array for an empty company batch', async () => {
    const deals = await scoreCompanies([], makeThesis(), makeOptions());
    expect(deals).toEqual([]);
  });
});

describe('scoreSingleCompanyForTesting', () => {
  it('treats momentum as the median (0.5) — no batch to compare against', async () => {
    const company = makeCompany({
      estimatedStage: 'seed',
      signals: [makeSignal({ kind: 'github_stars_delta_30d', value: 999 })],
    });
    const thesis = makeThesis();

    const deal = await scoreSingleCompanyForTesting(company, thesis, makeOptions());

    expect(deal.breakdown.momentum.value).toBe(0.5);
  });
});
