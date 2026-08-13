import { describe, expect, it } from 'vitest';
import type {
  Company,
  CompanyId,
  RunId,
  ScoredDeal,
  SourceRecord,
  SourceRecordId,
} from '../../src/domain/entities.js';
import {
  computeCompanyBlockingKeys,
  createInMemoryCompanyRepository,
  createInMemoryRunRepository,
  createInMemoryScoredDealRepository,
  createInMemorySourceRecordRepository,
} from './in-memory-repository.js';

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

function makeSourceRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: crypto.randomUUID() as SourceRecordId,
    source: 'hackernews',
    sourceId: 'abc123',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    raw: {},
    extracted: { name: 'Example', signals: [] },
    ...overrides,
  };
}

describe('createInMemorySourceRecordRepository', () => {
  it('upsert on a new (source, sourceId) returns isNew: true', async () => {
    const repo = createInMemorySourceRecordRepository();
    const record = makeSourceRecord({ sourceId: 'hn-1' });

    const result = await repo.upsert(record);

    expect(result.isNew).toBe(true);
    expect(result.id).toBe(record.id);
  });

  it('upsert twice with the same (source, sourceId) is idempotent: isNew false, no duplicate row', async () => {
    const repo = createInMemorySourceRecordRepository();
    const first = makeSourceRecord({ sourceId: 'hn-1', fetchedAt: '2026-01-01T00:00:00.000Z' });
    const second = makeSourceRecord({ sourceId: 'hn-1', fetchedAt: '2026-01-02T00:00:00.000Z' });

    const firstResult = await repo.upsert(first);
    const secondResult = await repo.upsert(second);

    expect(firstResult.isNew).toBe(true);
    expect(secondResult.isNew).toBe(false);
    expect(secondResult.id).toBe(firstResult.id);

    const all = await repo.listByRun('run-1' as RunId, undefined, 10);
    expect(all).toHaveLength(1);
    expect(all[0]!.fetchedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('upsert with a different sourceId (same source) creates a distinct record', async () => {
    const repo = createInMemorySourceRecordRepository();
    await repo.upsert(makeSourceRecord({ sourceId: 'hn-1' }));
    await repo.upsert(makeSourceRecord({ sourceId: 'hn-2' }));

    const all = await repo.listByRun('run-1' as RunId, undefined, 10);
    expect(all).toHaveLength(2);
  });

  it('upsert with the same sourceId but a different source creates a distinct record', async () => {
    const repo = createInMemorySourceRecordRepository();
    await repo.upsert(makeSourceRecord({ source: 'hackernews', sourceId: 'shared-id' }));
    await repo.upsert(makeSourceRecord({ source: 'github', sourceId: 'shared-id' }));

    const all = await repo.listByRun('run-1' as RunId, undefined, 10);
    expect(all).toHaveLength(2);
  });

  it('listByRun paginates via the after cursor with no gaps or duplicates', async () => {
    const repo = createInMemorySourceRecordRepository();
    const r1 = makeSourceRecord({ sourceId: 'hn-1' });
    const r2 = makeSourceRecord({ sourceId: 'hn-2' });
    const r3 = makeSourceRecord({ sourceId: 'hn-3' });
    await repo.upsert(r1);
    await repo.upsert(r2);
    await repo.upsert(r3);

    const firstPage = await repo.listByRun('run-1' as RunId, undefined, 2);
    expect(firstPage.map((r) => r.sourceId)).toEqual(['hn-1', 'hn-2']);

    const secondPage = await repo.listByRun('run-1' as RunId, firstPage[1]!.id, 2);
    expect(secondPage.map((r) => r.sourceId)).toEqual(['hn-3']);
  });
});

describe('createInMemoryCompanyRepository', () => {
  it('save + findByDomain round-trips a company', async () => {
    const repo = createInMemoryCompanyRepository();
    const company = makeCompany({ domain: 'acme.com', canonicalName: 'Acme Corp' });

    await repo.save(company);
    const found = await repo.findByDomain('acme.com');

    expect(found?.id).toBe(company.id);
  });

  it('findByDomain returns undefined for an unknown domain', async () => {
    const repo = createInMemoryCompanyRepository();
    const found = await repo.findByDomain('nope.io');
    expect(found).toBeUndefined();
  });

  it('findByBlockingKeys matches companies sharing a computed key, and excludes unrelated ones', async () => {
    const repo = createInMemoryCompanyRepository();
    const loglane = makeCompany({ canonicalName: 'Loglane' });
    const loglaneAnalytics = makeCompany({ canonicalName: 'Loglane Analytics' });
    const unrelated = makeCompany({ canonicalName: 'Zephyr Robotics', domain: 'zephyr.io' });
    await repo.save(loglane);
    await repo.save(loglaneAnalytics);
    await repo.save(unrelated);

    const sharedKeys = computeCompanyBlockingKeys({ canonicalName: 'Loglane' });
    const matches = await repo.findByBlockingKeys(sharedKeys);
    const matchedIds = matches.map((c) => c.id).sort();

    expect(matchedIds).toEqual([loglane.id, loglaneAnalytics.id].sort());
    expect(matchedIds).not.toContain(unrelated.id);
  });

  it('findByBlockingKeys returns an empty array when no company matches', async () => {
    const repo = createInMemoryCompanyRepository();
    await repo.save(makeCompany({ canonicalName: 'Zephyr Robotics' }));

    const matches = await repo.findByBlockingKeys(['trigram:xyz']);
    expect(matches).toEqual([]);
  });

  it('linkSourceRecord appends a member record id without duplicating on repeat calls', async () => {
    const repo = createInMemoryCompanyRepository();
    const company = makeCompany();
    await repo.save(company);
    const recordId = crypto.randomUUID() as SourceRecordId;

    await repo.linkSourceRecord(company.id, recordId);
    await repo.linkSourceRecord(company.id, recordId);

    const found = await repo.findByDomain(company.domain ?? '');
    void found;
    const [again] = await repo.findByBlockingKeys(computeCompanyBlockingKeys(company));
    expect(again?.memberRecordIds).toEqual([recordId]);
  });

  it('appendSignals appends new signals onto the existing signal history', async () => {
    const repo = createInMemoryCompanyRepository();
    const company = makeCompany();
    await repo.save(company);

    await repo.appendSignals(company.id, [
      {
        kind: 'hn_points',
        value: 10,
        observedAt: '2026-01-01T00:00:00.000Z',
        source: 'hackernews',
      },
    ]);
    await repo.appendSignals(company.id, [
      { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
    ]);

    const [found] = await repo.findByBlockingKeys(computeCompanyBlockingKeys(company));
    expect(found?.signals).toHaveLength(2);
    expect(found?.signals.map((s) => s.kind)).toEqual(['hn_points', 'hn_show']);
  });

  it('setEmbedding sets the embedding vector on the company', async () => {
    const repo = createInMemoryCompanyRepository();
    const company = makeCompany();
    await repo.save(company);

    await repo.setEmbedding(company.id, [0.1, 0.2, 0.3]);

    const [found] = await repo.findByBlockingKeys(computeCompanyBlockingKeys(company));
    expect(found?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('merge is non-destructive: the absorbed company remains retrievable with a mergedInto pointer', async () => {
    const repo = createInMemoryCompanyRepository();
    const survivor = makeCompany({ domain: 'acme.com', canonicalName: 'Acme Corp' });
    const absorbed = makeCompany({ domain: 'acmewidgets.io', canonicalName: 'Acme Widgets' });
    await repo.save(survivor);
    await repo.save(absorbed);

    await repo.merge(survivor.id, absorbed.id, {
      pairScore: 0.95,
      matchedSignals: ['domain'],
      confidence: 'auto',
    });

    const stillFound = await repo.findByDomain('acmewidgets.io');
    expect(stillFound).toBeDefined();
    expect(stillFound?.id).toBe(absorbed.id);
    expect(stillFound?.mergedInto).toBe(survivor.id);
  });

  it('merge combines memberRecordIds and signals from both companies onto the survivor', async () => {
    const repo = createInMemoryCompanyRepository();
    const sharedRecordId = crypto.randomUUID() as SourceRecordId;
    const survivor = makeCompany({
      domain: 'acme.com',
      memberRecordIds: [crypto.randomUUID() as SourceRecordId],
      signals: [
        {
          kind: 'hn_points',
          value: 5,
          observedAt: '2026-01-01T00:00:00.000Z',
          source: 'hackernews',
        },
      ],
    });
    const absorbed = makeCompany({
      domain: 'acme-alt.io',
      memberRecordIds: [sharedRecordId],
      signals: [
        { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
      ],
    });
    await repo.save(survivor);
    await repo.save(absorbed);

    await repo.merge(survivor.id, absorbed.id, {
      pairScore: 0.9,
      matchedSignals: ['domain'],
      confidence: 'auto',
    });

    const mergedSurvivor = await repo.findByDomain('acme.com');
    expect(mergedSurvivor?.memberRecordIds).toEqual(
      expect.arrayContaining([...survivor.memberRecordIds, sharedRecordId]),
    );
    expect(mergedSurvivor?.signals).toHaveLength(2);
  });

  it('merge with uncertain confidence flags the survivor with merge_incierto; auto confidence does not', async () => {
    const repo = createInMemoryCompanyRepository();
    const survivorAuto = makeCompany({ domain: 'auto-survivor.com' });
    const absorbedAuto = makeCompany({ domain: 'auto-absorbed.com' });
    const survivorUncertain = makeCompany({ domain: 'uncertain-survivor.com' });
    const absorbedUncertain = makeCompany({ domain: 'uncertain-absorbed.com' });
    await repo.save(survivorAuto);
    await repo.save(absorbedAuto);
    await repo.save(survivorUncertain);
    await repo.save(absorbedUncertain);

    await repo.merge(survivorAuto.id, absorbedAuto.id, {
      pairScore: 0.95,
      matchedSignals: ['domain'],
      confidence: 'auto',
    });
    await repo.merge(survivorUncertain.id, absorbedUncertain.id, {
      pairScore: 0.6,
      matchedSignals: ['name-similarity'],
      confidence: 'uncertain',
    });

    const mergedAuto = await repo.findByDomain('auto-survivor.com');
    const mergedUncertain = await repo.findByDomain('uncertain-survivor.com');

    expect(mergedAuto?.flags).not.toContain('merge_incierto');
    expect(mergedUncertain?.flags).toContain('merge_incierto');
  });

  it('merge throws a clear error when the survivor or absorbed id is unknown', async () => {
    const repo = createInMemoryCompanyRepository();
    const known = makeCompany({ domain: 'known.com' });
    await repo.save(known);
    const unknownId = crypto.randomUUID() as CompanyId;

    await expect(
      repo.merge(known.id, unknownId, { pairScore: 0.9, matchedSignals: [], confidence: 'auto' }),
    ).rejects.toThrow(/unknown company id/i);
  });
});

describe('createInMemoryRunRepository', () => {
  it('watermark returns undefined for a source that was never set', async () => {
    const repo = createInMemoryRunRepository();
    expect(await repo.watermark('hackernews')).toBeUndefined();
  });

  it('setWatermark then watermark round-trips the value, and a later call overwrites it', async () => {
    const repo = createInMemoryRunRepository();
    await repo.setWatermark('hackernews', '1700000000');
    expect(await repo.watermark('hackernews')).toBe('1700000000');

    await repo.setWatermark('hackernews', '1700000500');
    expect(await repo.watermark('hackernews')).toBe('1700000500');
  });

  it('finish succeeds after start (no throw)', async () => {
    const repo = createInMemoryRunRepository();
    const runId = crypto.randomUUID() as RunId;
    await repo.start(runId, 'thesis-a');

    await expect(repo.finish(runId, 'completed', { failedSources: [] })).resolves.toBeUndefined();
  });

  it('finish throws when called on a run id that was never started', async () => {
    const repo = createInMemoryRunRepository();
    const runId = crypto.randomUUID() as RunId;

    await expect(repo.finish(runId, 'completed', { failedSources: [] })).rejects.toThrow(
      /never started/i,
    );
  });
});

describe('createInMemoryScoredDealRepository', () => {
  function makeScoredDeal(runId: RunId, companyId: CompanyId, score: number): ScoredDeal {
    return {
      runId,
      companyId,
      score,
      breakdown: {
        semantic: { value: 0.5, weight: 0.4 },
        momentum: { value: 0.5, weight: 0.3 },
        keywords: { value: 0.5, weight: 0.2 },
        recency: { value: 0.5, weight: 0.1 },
      },
      rationale: 'test rationale',
      flags: [],
    };
  }

  it('saveAll stores deals retrievable via all(runId)', async () => {
    const repo = createInMemoryScoredDealRepository();
    const runId = crypto.randomUUID() as RunId;
    const deal = makeScoredDeal(runId, crypto.randomUUID() as CompanyId, 72);

    await repo.saveAll(runId, [deal]);

    expect(repo.all(runId)).toEqual([deal]);
  });

  it('saveAll replaces (not appends) on a second call for the same run — idempotent re-run', async () => {
    const repo = createInMemoryScoredDealRepository();
    const runId = crypto.randomUUID() as RunId;
    const first = makeScoredDeal(runId, crypto.randomUUID() as CompanyId, 40);
    const second = makeScoredDeal(runId, crypto.randomUUID() as CompanyId, 90);

    await repo.saveAll(runId, [first]);
    await repo.saveAll(runId, [second]);

    expect(repo.all(runId)).toEqual([second]);
  });

  it('saveAll for a different runId does not affect another run’s deals', async () => {
    const repo = createInMemoryScoredDealRepository();
    const runA = crypto.randomUUID() as RunId;
    const runB = crypto.randomUUID() as RunId;
    const dealA = makeScoredDeal(runA, crypto.randomUUID() as CompanyId, 55);
    const dealB = makeScoredDeal(runB, crypto.randomUUID() as CompanyId, 65);

    await repo.saveAll(runA, [dealA]);
    await repo.saveAll(runB, [dealB]);

    expect(repo.all(runA)).toEqual([dealA]);
    expect(repo.all(runB)).toEqual([dealB]);
  });
});
