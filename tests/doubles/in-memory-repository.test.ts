import { describe, expect, it } from 'vitest';
import type { CompanyId, RunId, ScoredDeal } from '../../src/domain/entities.js';
import { runCompanyRepositoryContract } from '../contract/company-repository.contract.js';
import { runRunRepositoryContract } from '../contract/run-repository.contract.js';
import { runSourceRecordRepositoryContract } from '../contract/source-record-repository.contract.js';
import {
  computeCompanyBlockingKeys,
  createInMemoryCompanyRepository,
  createInMemoryRunRepository,
  createInMemoryScoredDealRepository,
  createInMemorySourceRecordRepository,
} from './in-memory-repository.js';

// CompanyRepository, SourceRecordRepository, and (as of Phase 9b)
// RunRepository behavioral coverage lives in the shared contract suite
// (tests/contract/*.contract.ts) — run here against the in-memory double,
// and again in tests/integration/postgres-repository.contract.test.ts
// against the real Postgres implementation. ScoredDealRepository still has
// no read method on its port (DealReadModel, Phase 9b, is a SEPARATE port
// that owns the API's read path — see domain/ports.ts), so its tests stay
// inline below against the in-memory double's own `all()` test-only
// inspector, unchanged from Phase 3.

runCompanyRepositoryContract({
  createRepository: () => createInMemoryCompanyRepository(),
  computeBlockingKeys: computeCompanyBlockingKeys,
});

runSourceRecordRepositoryContract({
  createRepository: () => createInMemorySourceRecordRepository(),
});

runRunRepositoryContract({
  createRepository: () => createInMemoryRunRepository(),
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
