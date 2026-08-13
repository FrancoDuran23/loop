// Shared SourceRecordRepository behavioral contract (design.md "Two
// Repository Implementations"). Extracted verbatim (no behavioral changes
// needed — unlike company-repository.contract.ts) from
// tests/doubles/in-memory-repository.test.ts's original inline
// SourceRecordRepository describe block (Phase 3). Runs the IDENTICAL test
// bodies against any SourceRecordRepository implementation, including the
// exact upsert-idempotency scenario spec's own acceptance criterion is
// built on ("run twice, zero duplicates").

import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '../../src/domain/entities.js';
import type { SourceRecordRepository } from '../../src/domain/ports.js';

function makeSourceRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: crypto.randomUUID() as SourceRecord['id'],
    source: 'hackernews',
    sourceId: 'abc123',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    raw: {},
    extracted: { name: 'Example', signals: [] },
    ...overrides,
  };
}

export interface SourceRecordRepositoryContractOptions {
  /** Creates a fresh, empty SourceRecordRepository instance for a single test. */
  readonly createRepository: () => SourceRecordRepository | Promise<SourceRecordRepository>;
}

export function runSourceRecordRepositoryContract(
  options: SourceRecordRepositoryContractOptions,
): void {
  const { createRepository } = options;

  describe('SourceRecordRepository contract', () => {
    it('upsert on a new (source, sourceId) returns isNew: true', async () => {
      const repo = await createRepository();
      const record = makeSourceRecord({ sourceId: 'hn-1' });

      const result = await repo.upsert(record);

      expect(result.isNew).toBe(true);
      expect(result.id).toBe(record.id);
    });

    it('upsert twice with the same (source, sourceId) is idempotent: isNew false, no duplicate row', async () => {
      const repo = await createRepository();
      const first = makeSourceRecord({ sourceId: 'hn-1', fetchedAt: '2026-01-01T00:00:00.000Z' });
      const second = makeSourceRecord({ sourceId: 'hn-1', fetchedAt: '2026-01-02T00:00:00.000Z' });

      const firstResult = await repo.upsert(first);
      const secondResult = await repo.upsert(second);

      expect(firstResult.isNew).toBe(true);
      expect(secondResult.isNew).toBe(false);
      expect(secondResult.id).toBe(firstResult.id);

      const all = await repo.list(undefined, 10);
      expect(all).toHaveLength(1);
      expect(all[0]!.fetchedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('upsert with a different sourceId (same source) creates a distinct record', async () => {
      const repo = await createRepository();
      await repo.upsert(makeSourceRecord({ sourceId: 'hn-1' }));
      await repo.upsert(makeSourceRecord({ sourceId: 'hn-2' }));

      const all = await repo.list(undefined, 10);
      expect(all).toHaveLength(2);
    });

    it('upsert with the same sourceId but a different source creates a distinct record', async () => {
      const repo = await createRepository();
      await repo.upsert(makeSourceRecord({ source: 'hackernews', sourceId: 'shared-id' }));
      await repo.upsert(makeSourceRecord({ source: 'github', sourceId: 'shared-id' }));

      const all = await repo.list(undefined, 10);
      expect(all).toHaveLength(2);
    });

    it('list paginates via the after cursor with no gaps or duplicates', async () => {
      const repo = await createRepository();
      const r1 = makeSourceRecord({ sourceId: 'hn-1', fetchedAt: '2026-01-01T00:00:00.000Z' });
      const r2 = makeSourceRecord({ sourceId: 'hn-2', fetchedAt: '2026-01-01T00:00:01.000Z' });
      const r3 = makeSourceRecord({ sourceId: 'hn-3', fetchedAt: '2026-01-01T00:00:02.000Z' });
      await repo.upsert(r1);
      await repo.upsert(r2);
      await repo.upsert(r3);

      const firstPage = await repo.list(undefined, 2);
      expect(firstPage.map((r) => r.sourceId)).toEqual(['hn-1', 'hn-2']);

      const secondPage = await repo.list(firstPage[1]!.id, 2);
      expect(secondPage.map((r) => r.sourceId)).toEqual(['hn-3']);
    });
  });
}
