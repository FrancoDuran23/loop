// Unit tests for src/pipeline/run.ts's small pure/near-pure helpers —
// written before the file exists (strict TDD RED). The full orchestration
// flow (runPipeline itself) is covered at the integration layer in
// tests/pipeline/run.test.ts, per strict-tdd.md's "Choosing Test Layer"
// guidance (multi-component flow -> integration test); these are the
// pieces small and pure enough to unit test directly.

import { describe, expect, it } from 'vitest';
import type { Company, CompanyId } from '../../src/domain/entities.js';
import type { EnrichmentResult } from '../../src/domain/ports.js';
import { createInMemoryCompanyRepository } from '../doubles/in-memory-repository.js';
import {
  applyEnrichmentResult,
  computeLookupBlockingKeys,
  resolveCanonical,
} from '../../src/pipeline/run.js';

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

describe('computeLookupBlockingKeys', () => {
  it('includes a domain key, a name4 key, and trigram keys for a normal name+domain', () => {
    const keys = computeLookupBlockingKeys({ canonicalName: 'Loglane', domain: 'loglane.dev' });

    expect(keys).toContain('domain:loglane.dev');
    expect(keys).toContain('name4:logl');
    expect(keys).toContain('trigram:log');
  });

  it('produces only name-based keys when no domain is given', () => {
    const keys = computeLookupBlockingKeys({ canonicalName: 'Zephyr' });

    expect(keys.some((k) => k.startsWith('domain:'))).toBe(false);
    expect(keys).toContain('name4:zeph');
  });

  it('two candidates sharing the same registrable domain always share a blocking key', () => {
    const a = computeLookupBlockingKeys({ canonicalName: 'Acme', domain: 'acme.com' });
    const b = computeLookupBlockingKeys({ canonicalName: 'Acme Inc', domain: 'acme.com' });

    expect(a.some((k) => b.includes(k))).toBe(true);
  });
});

describe('resolveCanonical', () => {
  it('returns the same company unchanged when it has no mergedInto pointer', async () => {
    const repo = createInMemoryCompanyRepository();
    const company = makeCompany({ canonicalName: 'Standalone Co' });
    await repo.save(company);

    const resolved = await resolveCanonical(repo, company);

    expect(resolved.id).toBe(company.id);
  });

  it('follows a single mergedInto hop to the survivor', async () => {
    const repo = createInMemoryCompanyRepository();
    const survivor = makeCompany({ canonicalName: 'Survivor', domain: 'survivor.com' });
    const absorbed = makeCompany({ canonicalName: 'Absorbed', domain: 'absorbed.com' });
    await repo.save(survivor);
    await repo.save(absorbed);
    await repo.merge(survivor.id, absorbed.id, {
      pairScore: 0.9,
      matchedSignals: ['domain'],
      confidence: 'auto',
    });
    const absorbedRow = await repo.findById(absorbed.id);

    const resolved = await resolveCanonical(repo, absorbedRow!);

    expect(resolved.id).toBe(survivor.id);
    expect(resolved.mergedInto).toBeUndefined();
  });

  it('follows a TRANSITIVE chain: A merged into B, B merged into C', async () => {
    const repo = createInMemoryCompanyRepository();
    const a = makeCompany({ canonicalName: 'A', domain: 'a-chain.com' });
    const b = makeCompany({ canonicalName: 'B', domain: 'b-chain.com' });
    const c = makeCompany({ canonicalName: 'C', domain: 'c-chain.com' });
    await repo.save(a);
    await repo.save(b);
    await repo.save(c);
    await repo.merge(b.id, a.id, { pairScore: 0.9, matchedSignals: ['domain'], confidence: 'auto' });
    await repo.merge(c.id, b.id, { pairScore: 0.9, matchedSignals: ['domain'], confidence: 'auto' });
    const aRow = await repo.findById(a.id);

    const resolved = await resolveCanonical(repo, aRow!);

    expect(resolved.id).toBe(c.id);
  });
});

describe('applyEnrichmentResult', () => {
  it('fills an empty sector even at low confidence', () => {
    const company = makeCompany();
    const result: EnrichmentResult = { sector: 'devtools', confidence: 0.3 };

    const updated = applyEnrichmentResult(company, result);

    expect(updated.sector).toBe('devtools');
  });

  it('does NOT overwrite an existing sector with a low-confidence guess', () => {
    const company = makeCompany({ sector: 'fintech' });
    const result: EnrichmentResult = { sector: 'ai', confidence: 0.3 };

    const updated = applyEnrichmentResult(company, result);

    expect(updated.sector).toBe('fintech');
  });

  it('DOES overwrite an existing sector when confidence is at/above the threshold', () => {
    const company = makeCompany({ sector: 'fintech' });
    const result: EnrichmentResult = { sector: 'ai', confidence: 0.9 };

    const updated = applyEnrichmentResult(company, result);

    expect(updated.sector).toBe('ai');
  });

  it('leaves oneLiner/estimatedStage untouched when the result provides neither', () => {
    const company = makeCompany({ oneLiner: 'existing one-liner' });
    const result: EnrichmentResult = { confidence: 0 };

    const updated = applyEnrichmentResult(company, result);

    expect(updated.oneLiner).toBe('existing one-liner');
    expect(updated.estimatedStage).toBeUndefined();
  });
});
