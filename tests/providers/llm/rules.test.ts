import { describe, expect, it } from 'vitest';
import type { Company, CompanyId, ScoreBreakdown } from '../../../src/domain/entities.js';
import type { RationaleRequest } from '../../../src/domain/ports.js';
import type { Thesis } from '../../../src/domain/thesis.js';
import { createRulesLlmProvider } from '../../../src/providers/llm/rules.js';

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
    description: 'Investing in developer tools.',
    hard_filters: { stages: ['seed'], exclude_sectors: [] },
    soft_preferences: { sectors: [], geos: [], keywords: [] },
    anti_patterns: [],
    weights: { semantic: 0.4, momentum: 0.3, keywords: 0.2, recency: 0.1 },
    ...overrides,
  };
}

function makeBreakdown(overrides: Partial<ScoreBreakdown> = {}): ScoreBreakdown {
  return {
    semantic: { value: 0.5, weight: 0.4 },
    momentum: { value: 0.5, weight: 0.3 },
    keywords: { value: 0.5, weight: 0.2 },
    recency: { value: 0.5, weight: 0.1 },
    ...overrides,
  };
}

describe('RulesLlmProvider.id', () => {
  it('identifies as "rules"', () => {
    expect(createRulesLlmProvider().id).toBe('rules');
  });
});

describe('RulesLlmProvider.rationale', () => {
  const provider = createRulesLlmProvider();

  it('is deterministic — identical inputs produce identical output', async () => {
    const req: RationaleRequest = {
      company: makeCompany(),
      breakdown: makeBreakdown(),
      thesis: makeThesis(),
    };

    const first = await provider.rationale(req);
    const second = await provider.rationale(req);

    expect(first).toBe(second);
  });

  it('names the dominant component for a semantic-dominant breakdown', async () => {
    const req: RationaleRequest = {
      company: makeCompany({ canonicalName: 'Semantic Star' }),
      breakdown: makeBreakdown({
        semantic: { value: 1, weight: 0.7 },
        momentum: { value: 0, weight: 0.1 },
        keywords: { value: 0, weight: 0.1 },
        recency: { value: 0, weight: 0.1 },
      }),
      thesis: makeThesis(),
    };

    const rationale = await provider.rationale(req);

    expect(rationale).toContain('Semantic Star');
    expect(rationale).toContain('driven mostly by semantic fit with the thesis');
    // The component-contributions sentence intentionally lists ALL 4
    // components (full breakdown auditability) — "momentum" legitimately
    // appears there with a 0-point contribution; only the "driven mostly
    // by" clause should single out semantic as dominant.
    expect(rationale).toContain('momentum 0');
  });

  it('names the dominant component for a momentum-dominant breakdown', async () => {
    const req: RationaleRequest = {
      company: makeCompany({ canonicalName: 'Momentum Star' }),
      breakdown: makeBreakdown({
        semantic: { value: 0, weight: 0.1 },
        momentum: { value: 1, weight: 0.7 },
        keywords: { value: 0, weight: 0.1 },
        recency: { value: 0, weight: 0.1 },
      }),
      thesis: makeThesis(),
    };

    const rationale = await provider.rationale(req);

    expect(rationale).toContain('Momentum Star');
    expect(rationale).toContain('recent momentum');
  });

  it('produces a coherent, honest sentence for a hard-filtered (score=0) breakdown, not empty/garbage', async () => {
    const req: RationaleRequest = {
      company: makeCompany({ canonicalName: 'Filtered Co' }),
      breakdown: makeBreakdown({
        semantic: { value: 0, weight: 0 },
        momentum: { value: 0, weight: 0 },
        keywords: { value: 0, weight: 0 },
        recency: { value: 0, weight: 0 },
        failedHardFilter: `sector 'gambling' is in thesis.hard_filters.exclude_sectors`,
      }),
      thesis: makeThesis(),
    };

    const rationale = await provider.rationale(req);

    expect(rationale.length).toBeGreaterThan(0);
    expect(rationale).toContain('Filtered Co');
    expect(rationale).toContain('gambling');
    expect(rationale).toContain('0');
  });

  it('mentions known sector and stage when present', async () => {
    const req: RationaleRequest = {
      company: makeCompany({ sector: 'devtools', estimatedStage: 'seed' }),
      breakdown: makeBreakdown(),
      thesis: makeThesis(),
    };

    const rationale = await provider.rationale(req);

    expect(rationale).toContain('devtools');
    expect(rationale).toContain('seed');
  });

  it('mentions merge_incierto as a caveat when the company carries that flag', async () => {
    const req: RationaleRequest = {
      company: makeCompany({ flags: ['merge_incierto'] }),
      breakdown: makeBreakdown(),
      thesis: makeThesis(),
    };

    const rationale = await provider.rationale(req);

    expect(rationale).toContain('merge_incierto');
  });

  it('never falsely claims to be an LLM', async () => {
    const req: RationaleRequest = {
      company: makeCompany(),
      breakdown: makeBreakdown(),
      thesis: makeThesis(),
    };
    const rationale = await provider.rationale(req);

    expect(rationale.toLowerCase()).not.toContain('as an ai');
    expect(rationale.toLowerCase()).not.toContain('i think');
  });
});

describe('RulesLlmProvider.enrich', () => {
  const provider = createRulesLlmProvider();

  it('guesses a sector from a matching keyword in the description, with low confidence', async () => {
    const result = await provider.enrich({
      name: 'Acme',
      description: 'A fintech platform for small business lending.',
      signals: [],
    });

    expect(result.sector).toBe('fintech');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it('returns undefined sector and 0 confidence when no keyword matches (honest, not fabricated)', async () => {
    const result = await provider.enrich({
      name: 'Zyx',
      description: 'A company that does things nobody has categorized yet.',
      signals: [],
    });

    expect(result.sector).toBeUndefined();
    expect(result.confidence).toBe(0);
  });

  it('never sets estimatedStage — no defensible basis in name/description/signals alone', async () => {
    const result = await provider.enrich({
      name: 'Acme',
      description: 'A fintech company hiring aggressively.',
      signals: [],
    });

    expect(result.estimatedStage).toBeUndefined();
  });

  it('produces a truncated oneLiner from a long description', async () => {
    const longDescription = 'A'.repeat(200);
    const result = await provider.enrich({
      name: 'Acme',
      description: longDescription,
      signals: [],
    });

    expect(result.oneLiner).toBeDefined();
    expect(result.oneLiner!.length).toBeLessThanOrEqual(140);
  });
});
