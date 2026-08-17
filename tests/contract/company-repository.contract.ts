// Shared CompanyRepository behavioral contract (design.md "Two Repository
// Implementations": "Identical behavior is proven, not asserted"). Runs the
// IDENTICAL test bodies against any CompanyRepository implementation —
// invoked once for tests/doubles/in-memory-repository.ts (Phase 3) and once
// for the real Postgres implementation (src/db/repository.ts, Phase 5).
// A divergence between the two fails whichever one it's run against.
//
// Extracted from tests/doubles/in-memory-repository.test.ts's original
// inline CompanyRepository describe block (Phase 3). One deliberate
// behavioral refinement made during extraction: the original
// "merge combines memberRecordIds and signals..." test constructed
// companies with PRE-POPULATED `memberRecordIds`/`signals` fields and
// relied on `save()` alone to persist them. That only worked because the
// in-memory double happens to store the whole object verbatim. Per this
// phase's own reconciliation ("Company.signals and Company.memberRecordIds
// are NOT stored as columns on companies... reconstructed by
// querying/joining... when a Company is loaded"), `save()` is scalar-only —
// relational data always goes through `linkSourceRecord`/`appendSignals`,
// even on first creation. The test below now does that explicitly, which
// is consistent with how the OTHER two relational tests
// (linkSourceRecord/appendSignals) were already written, and passes
// identically against both implementations.

import { describe, expect, it } from 'vitest';
import type { Company, CompanyId, SourceRecordId } from '../../src/domain/entities.js';
import type { CompanyRepository } from '../../src/domain/ports.js';

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

export interface CompanyRepositoryContractOptions {
  /** Creates a fresh, empty CompanyRepository instance for a single test. */
  readonly createRepository: () => CompanyRepository | Promise<CompanyRepository>;
  /**
   * Must compute blocking keys IDENTICALLY to however the repository under
   * test indexes companies internally (see src/db/repository.ts's
   * `computeCompanyBlockingKeys` and tests/doubles/in-memory-repository.ts's
   * function of the same name — the contract relies on both agreeing
   * bit-for-bit on the same input).
   */
  readonly computeBlockingKeys: (
    company: Pick<Company, 'canonicalName'> & Partial<Pick<Company, 'domain'>>,
  ) => readonly string[];
  /**
   * Produces a SourceRecordId valid for `linkSourceRecord` under the
   * repository being tested. The in-memory double has no referential
   * integrity, so any random id works there — but real Postgres enforces a
   * genuine FK from `company_members.source_record_id` to `source_records`
   * (found by running this exact contract against the real implementation,
   * Phase 5), so that impl's factory must actually insert a backing
   * `source_records` row and return its id. Defaults to a bare
   * `crypto.randomUUID()` (correct for the in-memory double).
   */
  readonly createSourceRecordId?: () => SourceRecordId | Promise<SourceRecordId>;
}

const EMBEDDING_DIMENSIONS = 384;

/**
 * A deterministic, correctly-dimensioned (384) test embedding. Two
 * constraints, both found by running this contract against real Postgres:
 * (1) pgvector's `vector(384)` column rejects any other length, so a short
 * placeholder like `[0.1, 0.2, 0.3]` fails outright; (2) pgvector stores
 * `float4` (single precision), so values must be exact dyadic fractions
 * (multiples of 1/16) to round-trip bit-for-bit through storage — an
 * arbitrary double like `(i + 1) / 384` would come back very slightly
 * different after a float4 round-trip, failing `toEqual`.
 */
function makeEmbedding(): readonly number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => ((i % 16) - 8) / 16);
}

export function runCompanyRepositoryContract(options: CompanyRepositoryContractOptions): void {
  const { createRepository, computeBlockingKeys } = options;
  const createSourceRecordId =
    options.createSourceRecordId ?? (() => crypto.randomUUID() as SourceRecordId);

  describe('CompanyRepository contract', () => {
    it('save + findByDomain round-trips a company', async () => {
      const repo = await createRepository();
      const company = makeCompany({ domain: 'acme.com', canonicalName: 'Acme Corp' });

      await repo.save(company);
      const found = await repo.findByDomain('acme.com');

      expect(found?.id).toBe(company.id);
    });

    it('findByDomain returns undefined for an unknown domain', async () => {
      const repo = await createRepository();
      const found = await repo.findByDomain('nope.io');
      expect(found).toBeUndefined();
    });

    it('findByBlockingKeys matches companies sharing a computed key, and excludes unrelated ones', async () => {
      const repo = await createRepository();
      const loglane = makeCompany({ canonicalName: 'Loglane' });
      const loglaneAnalytics = makeCompany({ canonicalName: 'Loglane Analytics' });
      const unrelated = makeCompany({ canonicalName: 'Zephyr Robotics', domain: 'zephyr.io' });
      await repo.save(loglane);
      await repo.save(loglaneAnalytics);
      await repo.save(unrelated);

      const sharedKeys = computeBlockingKeys({ canonicalName: 'Loglane' });
      const matches = await repo.findByBlockingKeys(sharedKeys);
      const matchedIds = matches.map((c) => c.id).sort();

      expect(matchedIds).toEqual([loglane.id, loglaneAnalytics.id].sort());
      expect(matchedIds).not.toContain(unrelated.id);
    });

    it('findByBlockingKeys returns an empty array when no company matches', async () => {
      const repo = await createRepository();
      await repo.save(makeCompany({ canonicalName: 'Zephyr Robotics' }));

      const matches = await repo.findByBlockingKeys(['trigram:xyz']);
      expect(matches).toEqual([]);
    });

    it('linkSourceRecord appends a member record id without duplicating on repeat calls', async () => {
      const repo = await createRepository();
      const company = makeCompany();
      await repo.save(company);
      const recordId = await createSourceRecordId();

      await repo.linkSourceRecord(company.id, recordId);
      await repo.linkSourceRecord(company.id, recordId);

      const [again] = await repo.findByBlockingKeys(computeBlockingKeys(company));
      expect(again?.memberRecordIds).toEqual([recordId]);
    });

    it('appendSignals appends new signals onto the existing signal history', async () => {
      const repo = await createRepository();
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

      const [found] = await repo.findByBlockingKeys(computeBlockingKeys(company));
      expect(found?.signals).toHaveLength(2);
      expect(found?.signals.map((s) => s.kind)).toEqual(['hn_points', 'hn_show']);
    });

    it('setEmbedding sets the embedding vector on the company', async () => {
      const repo = await createRepository();
      const company = makeCompany();
      await repo.save(company);
      const embedding = makeEmbedding();

      await repo.setEmbedding(company.id, embedding);

      const [found] = await repo.findByBlockingKeys(computeBlockingKeys(company));
      expect(found?.embedding).toEqual(embedding);
    });

    it('merge is non-destructive: the absorbed company remains retrievable with a mergedInto pointer', async () => {
      const repo = await createRepository();
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
      const repo = await createRepository();
      const survivorRecordId = await createSourceRecordId();
      const absorbedRecordId = await createSourceRecordId();
      const survivor = makeCompany({ domain: 'acme.com' });
      const absorbed = makeCompany({ domain: 'acme-alt.io' });
      await repo.save(survivor);
      await repo.save(absorbed);
      await repo.linkSourceRecord(survivor.id, survivorRecordId);
      await repo.linkSourceRecord(absorbed.id, absorbedRecordId);
      await repo.appendSignals(survivor.id, [
        {
          kind: 'hn_points',
          value: 5,
          observedAt: '2026-01-01T00:00:00.000Z',
          source: 'hackernews',
        },
      ]);
      await repo.appendSignals(absorbed.id, [
        { kind: 'hn_show', value: 1, observedAt: '2026-01-01T00:00:00.000Z', source: 'hackernews' },
      ]);

      await repo.merge(survivor.id, absorbed.id, {
        pairScore: 0.9,
        matchedSignals: ['domain'],
        confidence: 'auto',
      });

      const mergedSurvivor = await repo.findByDomain('acme.com');
      expect(mergedSurvivor?.memberRecordIds).toEqual(
        expect.arrayContaining([survivorRecordId, absorbedRecordId]),
      );
      expect(mergedSurvivor?.signals).toHaveLength(2);
    });

    it('merge with uncertain confidence flags the survivor with merge_incierto; auto confidence does not', async () => {
      const repo = await createRepository();
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
      const repo = await createRepository();
      const known = makeCompany({ domain: 'known.com' });
      await repo.save(known);
      const unknownId = crypto.randomUUID() as CompanyId;

      await expect(
        repo.merge(known.id, unknownId, { pairScore: 0.9, matchedSignals: [], confidence: 'auto' }),
      ).rejects.toThrow(/unknown company id/i);
    });

    // findById / listAll — added by the pipeline-orchestrator phase
    // (src/pipeline/run.ts): the port originally had no way to (a)
    // re-fetch a specific company by id (needed to follow `mergedInto`
    // chains to the current canonical company) or (b) read the full
    // company set (needed to score every known company, not just ones
    // touched in the current run). See that phase's apply-progress for
    // the full rationale.
    it('findById returns the saved company by id', async () => {
      const repo = await createRepository();
      const company = makeCompany({ canonicalName: 'Findable Co' });
      await repo.save(company);

      const found = await repo.findById(company.id);

      expect(found?.id).toBe(company.id);
      expect(found?.canonicalName).toBe('Findable Co');
    });

    it('findById returns undefined for an unknown id', async () => {
      const repo = await createRepository();
      const found = await repo.findById(crypto.randomUUID() as CompanyId);
      expect(found).toBeUndefined();
    });

    it('findById follows to an absorbed row (caller resolves mergedInto, not the repo)', async () => {
      const repo = await createRepository();
      const survivor = makeCompany({ domain: 'findbyid-survivor.com' });
      const absorbed = makeCompany({ domain: 'findbyid-absorbed.com' });
      await repo.save(survivor);
      await repo.save(absorbed);
      await repo.merge(survivor.id, absorbed.id, {
        pairScore: 0.9,
        matchedSignals: ['domain'],
        confidence: 'auto',
      });

      const found = await repo.findById(absorbed.id);
      expect(found?.mergedInto).toBe(survivor.id);
    });

    it('listAll returns every saved company, including absorbed rows', async () => {
      const repo = await createRepository();
      const survivor = makeCompany({ canonicalName: 'ListAll Survivor', domain: 'listall-a.com' });
      const absorbed = makeCompany({ canonicalName: 'ListAll Absorbed', domain: 'listall-b.com' });
      await repo.save(survivor);
      await repo.save(absorbed);
      await repo.merge(survivor.id, absorbed.id, {
        pairScore: 0.9,
        matchedSignals: ['domain'],
        confidence: 'auto',
      });

      const all = await repo.listAll();
      const ids = all.map((c) => c.id);

      expect(ids).toEqual(expect.arrayContaining([survivor.id, absorbed.id]));
    });

    it('listAll returns an empty array when nothing has been saved', async () => {
      const repo = await createRepository();
      expect(await repo.listAll()).toEqual([]);
    });
  });
}
