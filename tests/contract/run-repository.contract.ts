// Shared RunRepository behavioral contract (design.md "Two Repository
// Implementations": "Identical behavior is proven, not asserted") — the
// SAME pattern as company-repository.contract.ts and
// source-record-repository.contract.ts. Phase 5 explicitly deferred this
// suite ("RunRepository and ScoredDealRepository are not yet extracted into
// a shared contract... prioritized CompanyRepository/SourceRecordRepository
// since those two are what the idempotency/merge guarantees hinge on").
// Phase 9b adds real READ paths (get/findLatestWithDeals) against this port
// for the first time — a reasonable moment to finally extract the suite,
// since both implementations now have meaningfully more behavior to keep in
// sync.

import { describe, expect, it } from 'vitest';
import type { RunId } from '../../src/domain/entities.js';
import type { RunRepository } from '../../src/domain/ports.js';

export interface RunRepositoryContractOptions {
  /** Creates a fresh, empty RunRepository instance for a single test. */
  readonly createRepository: () => RunRepository | Promise<RunRepository>;
}

export function runRunRepositoryContract(options: RunRepositoryContractOptions): void {
  const { createRepository } = options;

  describe('RunRepository contract', () => {
    it('watermark returns undefined for a source that was never set', async () => {
      const repo = await createRepository();
      expect(await repo.watermark('hackernews')).toBeUndefined();
    });

    it('setWatermark then watermark round-trips the value, and a later call overwrites it', async () => {
      const repo = await createRepository();
      await repo.setWatermark('hackernews', '1700000000');
      expect(await repo.watermark('hackernews')).toBe('1700000000');

      await repo.setWatermark('hackernews', '1700000500');
      expect(await repo.watermark('hackernews')).toBe('1700000500');
    });

    it('finish succeeds after start (no throw)', async () => {
      const repo = await createRepository();
      const runId = crypto.randomUUID() as RunId;
      await repo.start(runId, 'thesis-a');

      await expect(repo.finish(runId, 'completed', { failedSources: [] })).resolves.toBeUndefined();
    });

    it('finish throws when called on a run id that was never started', async () => {
      const repo = await createRepository();
      const runId = crypto.randomUUID() as RunId;

      await expect(repo.finish(runId, 'completed', { failedSources: [] })).rejects.toThrow(
        /never started/i,
      );
    });

    it('get returns undefined for an unknown run id', async () => {
      const repo = await createRepository();
      expect(await repo.get(crypto.randomUUID() as RunId)).toBeUndefined();
    });

    it('get returns a started-but-not-finished run with status "running"', async () => {
      const repo = await createRepository();
      const runId = crypto.randomUUID() as RunId;
      await repo.start(runId, 'in-flight-thesis');

      const found = await repo.get(runId);

      expect(found?.id).toBe(runId);
      expect(found?.thesisName).toBe('in-flight-thesis');
      expect(found?.status).toBe('running');
      expect(found?.finishedAt).toBeUndefined();
    });

    it('get reflects the terminal status and stats after finish', async () => {
      const repo = await createRepository();
      const runId = crypto.randomUUID() as RunId;
      await repo.start(runId, 'finished-thesis');
      await repo.finish(runId, 'partial', { failedSources: ['github'] });

      const found = await repo.get(runId);

      expect(found?.status).toBe('partial');
      expect(found?.stats).toEqual({ failedSources: ['github'] });
      expect(found?.finishedAt).toBeDefined();
    });

    it('findLatestWithDeals returns undefined when no run has ever completed or partially completed', async () => {
      const repo = await createRepository();
      expect(await repo.findLatestWithDeals()).toBeUndefined();
    });

    it('findLatestWithDeals ignores a "failed" run and an in-progress run', async () => {
      const repo = await createRepository();
      const failedId = crypto.randomUUID() as RunId;
      const runningId = crypto.randomUUID() as RunId;
      await repo.start(failedId, 'failed-thesis');
      await repo.finish(failedId, 'failed', { failedSources: [] });
      await repo.start(runningId, 'running-thesis');

      expect(await repo.findLatestWithDeals()).toBeUndefined();
    });

    it('findLatestWithDeals returns the most recently finished completed/partial run', async () => {
      const repo = await createRepository();
      const olderId = crypto.randomUUID() as RunId;
      const newerId = crypto.randomUUID() as RunId;
      await repo.start(olderId, 'older-thesis');
      await repo.finish(olderId, 'completed', { failedSources: [] });
      // Small real delay so a real-clock-based implementation orders the two
      // finishes distinctly (Postgres orders by finishedAt DESC).
      await new Promise((resolve) => setTimeout(resolve, 5));
      await repo.start(newerId, 'newer-thesis');
      await repo.finish(newerId, 'partial', { failedSources: ['rss'] });

      const latest = await repo.findLatestWithDeals();

      expect(latest?.id).toBe(newerId);
      expect(latest?.thesisName).toBe('newer-thesis');
    });
  });
}
