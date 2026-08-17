// cli.ts Phase 9a rewrite: from a Phase-3 HN-only demo into the real
// pipeline entry point (spec §18: `npm run pipeline -- --thesis
// thesis.example.yaml` must produce ranked deals with score + rationale on
// a clean machine, zero env vars). These tests cover the pure,
// unit-testable pieces (arg parsing, deal formatting) — main()'s real
// Postgres + real pipeline wiring is proven by actually running
// `npm run pipeline` for real (see apply-progress), not re-mocked here.

import { describe, expect, it } from 'vitest';
import type { Company, CompanyId, RunId, ScoreBreakdown, ScoredDeal } from '../src/domain/entities.js';
import { formatRankedDeals, parseCliArgs } from '../src/cli.js';

describe('parseCliArgs', () => {
  it('defaults to thesis.example.yaml, all 3 sources, and a positive limit when no flags are given', () => {
    const options = parseCliArgs([]);

    expect(options.thesisPath).toBe('thesis.example.yaml');
    expect(options.sources).toEqual(['github', 'hackernews', 'rss']);
    expect(options.limit).toBeGreaterThan(0);
  });

  it('reads --thesis, --limit, and a comma-separated --source list', () => {
    const options = parseCliArgs([
      '--thesis',
      'custom-thesis.yaml',
      '--limit',
      '10',
      '--source',
      'hackernews,rss',
    ]);

    expect(options).toEqual({
      thesisPath: 'custom-thesis.yaml',
      limit: 10,
      sources: ['hackernews', 'rss'],
    });
  });

  it('throws for an unsupported --source value', () => {
    expect(() => parseCliArgs(['--source', 'reddit'])).toThrow(/reddit/i);
  });

  it('throws for a non-positive --limit value', () => {
    expect(() => parseCliArgs(['--limit', '0'])).toThrow(/positive/i);
    expect(() => parseCliArgs(['--limit', 'notanumber'])).toThrow(/positive/i);
  });
});

describe('formatRankedDeals', () => {
  function makeDeal(overrides: Partial<ScoredDeal> = {}): ScoredDeal {
    const zero = { value: 0, weight: 0 };
    const breakdown: ScoreBreakdown = {
      semantic: zero,
      momentum: zero,
      keywords: zero,
      recency: zero,
    };
    return {
      runId: 'run-1' as RunId,
      companyId: 'company-1' as CompanyId,
      score: 50,
      breakdown,
      rationale: 'A reasonable rationale.',
      flags: [],
      ...overrides,
    };
  }

  function makeCompany(id: string, canonicalName: string): Company {
    return {
      id: id as CompanyId,
      canonicalName,
      signals: [],
      memberRecordIds: [],
      flags: [],
      firstSeenAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('sorts deals by score descending and includes the company name, score, and rationale', () => {
    const low = makeDeal({ companyId: 'a' as CompanyId, score: 20, rationale: 'Low scorer rationale' });
    const high = makeDeal({ companyId: 'b' as CompanyId, score: 90, rationale: 'High scorer rationale' });
    const companiesById = new Map([
      ['a' as CompanyId, makeCompany('a', 'LowCo')],
      ['b' as CompanyId, makeCompany('b', 'HighCo')],
    ]);

    const output = formatRankedDeals([low, high], companiesById);
    const highIndex = output.indexOf('HighCo');
    const lowIndex = output.indexOf('LowCo');

    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(lowIndex).toBeGreaterThan(highIndex);
    expect(output).toContain('90.0');
    expect(output).toContain('High scorer rationale');
  });

  it('falls back to the raw companyId when no matching company is found', () => {
    const deal = makeDeal({ companyId: 'missing-id' as CompanyId });

    const output = formatRankedDeals([deal], new Map());

    expect(output).toContain('missing-id');
  });

  it('appends flags in brackets when present', () => {
    const deal = makeDeal({ companyId: 'a' as CompanyId, flags: ['merge_incierto'] });
    const companiesById = new Map([['a' as CompanyId, makeCompany('a', 'FlaggedCo')]]);

    const output = formatRankedDeals([deal], companiesById);

    expect(output).toContain('merge_incierto');
  });
});
