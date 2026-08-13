import { describe, expect, it } from 'vitest';
import type { Company, CompanyId } from '../../src/domain/entities.js';
import { createInMemoryCompanyRepository } from '../doubles/in-memory-repository.js';
import {
  EntityResolver,
  FIELD_SOURCE_PRECEDENCE,
  PAIR_SCORE_THRESHOLDS,
  PAIR_SCORE_WEIGHTS,
  UnionFind,
  blockingKeys,
  candidatesToCompare,
  classifyBand,
  cosineSimilarity,
  jaroWinklerSimilarity,
  mergeClusters,
  resolveFieldConflict,
  scorePair,
  type AcceptedPair,
  type PairCandidate,
} from '../../src/resolution/resolver.js';
import type { EmbeddingProvider } from '../../src/domain/ports.js';

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

// ---------------------------------------------------------------------------
// jaroWinklerSimilarity / cosineSimilarity — pure math building blocks
// ---------------------------------------------------------------------------

describe('jaroWinklerSimilarity', () => {
  it('returns 1 for identical strings', () => {
    expect(jaroWinklerSimilarity('acme', 'acme')).toBe(1);
  });

  it('returns 0 for completely dissimilar strings', () => {
    expect(jaroWinklerSimilarity('abc', 'xyz')).toBe(0);
  });

  it('matches the well-known MARTHA/MARHTA reference value (~0.961)', () => {
    expect(jaroWinklerSimilarity('martha', 'marhta')).toBeCloseTo(0.961, 2);
  });

  it('rewards a shared prefix more than a shared suffix', () => {
    const sharedPrefix = jaroWinklerSimilarity('acme corp', 'acme co');
    const sharedSuffix = jaroWinklerSimilarity('corp acme', 'co acme');
    expect(sharedPrefix).toBeGreaterThan(sharedSuffix);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it('returns 0 for mismatched-length or empty vectors (defensive, not a throw)', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// blocking
// ---------------------------------------------------------------------------

describe('blockingKeys', () => {
  it('produces a domain key from the normalized domain when present', () => {
    const keys = blockingKeys({ canonicalName: 'Acme Corp', domain: 'www.Acme.com' });
    expect(keys).toContain('domain:acme.com');
  });

  it('omits a domain key for a generic hosting domain', () => {
    const keys = blockingKeys({ canonicalName: 'Acme Corp', domain: 'acme.github.io' });
    expect(keys.some((k) => k.startsWith('domain:'))).toBe(false);
  });

  it('produces a name-prefix-4 key from the normalized name', () => {
    const keys = blockingKeys({ canonicalName: 'Acme Corp' });
    expect(keys).toContain('name4:acme');
  });

  it('produces trigram keys covering the normalized name', () => {
    const keys = blockingKeys({ canonicalName: 'Acme' });
    expect(keys).toEqual(expect.arrayContaining(['trigram:acm', 'trigram:cme']));
  });
});

describe('candidatesToCompare (blocking-driven pair generation)', () => {
  it('DOES compare two candidates that share a blocking key', () => {
    const candidates: PairCandidate[] = [
      { canonicalName: 'Loglane' },
      { canonicalName: 'Loglane Analytics' },
    ];
    const pairs = candidatesToCompare(candidates);
    expect(pairs).toContainEqual([0, 1]);
  });

  it('NEVER compares two candidates whose domain, name-prefix-4, and trigrams all differ', () => {
    const candidates: PairCandidate[] = [
      { canonicalName: 'Loglane', domain: 'loglane.com' },
      { canonicalName: 'Zephyr Robotics', domain: 'zephyr.io' },
    ];
    const pairs = candidatesToCompare(candidates);
    expect(pairs).toHaveLength(0);
  });

  it('does not produce O(n^2) comparisons for a mostly-unrelated candidate set', () => {
    // 20 candidates, only 2 of which share a block; full pairwise would be
    // 20*19/2 = 190 comparisons. The 18 "unrelated" names below are single,
    // phonetically distinct words with NO shared trigram, name-prefix-4, or
    // domain with each other or with the Loglane pair. (A naive
    // "Foo Robotics", "Bar Robotics", ... series would NOT work here — it
    // would correctly trigram-collide on the shared " robotics" suffix,
    // since that IS a genuine trigram overlap, not a blocking bug.)
    const unrelatedNames = [
      'Zephyr',
      'Ember',
      'Quokka',
      'Marmot',
      'Bison',
      'Falcon',
      'Otter',
      'Walrus',
      'Newt',
      'Ibex',
      'Toucan',
      'Gecko',
      'Puffin',
      'Yak',
      'Heron',
      'Mongoose',
      'Wombat',
      'Tapir',
    ];
    const candidates: PairCandidate[] = [
      { canonicalName: 'Loglane', domain: 'loglane.com' },
      { canonicalName: 'Loglane Inc', domain: 'loglane.com' },
      ...unrelatedNames.map((name) => ({
        canonicalName: name,
        domain: `${name.toLowerCase()}.io`,
      })),
    ];
    const pairs = candidatesToCompare(candidates);
    expect(pairs.length).toBeLessThan(10);
    expect(pairs).toContainEqual([0, 1]);
  });

  it('does not miss a true match sharing a block, and does not double-count a pair sharing multiple blocking keys', () => {
    const candidates: PairCandidate[] = [
      { canonicalName: 'Acme Corp', domain: 'acme.com' },
      { canonicalName: 'Acme Inc', domain: 'acme.com' }, // shares domain key AND name4 key
    ];
    const pairs = candidatesToCompare(candidates);
    expect(pairs).toEqual([[0, 1]]);
  });
});

// ---------------------------------------------------------------------------
// pair scoring bands
// ---------------------------------------------------------------------------

describe('scorePair', () => {
  it('scores an identical-domain, identical-name pair in the auto-merge band', () => {
    const a: PairCandidate = { canonicalName: 'Acme Corp', domain: 'acme.com' };
    const b: PairCandidate = { canonicalName: 'Acme Corp', domain: 'acme.com' };
    const result = scorePair(a, b);
    expect(result.confidence).toBe('auto');
    expect(result.score).toBeGreaterThanOrEqual(PAIR_SCORE_THRESHOLDS.autoMerge);
    expect(result.matchedSignals).toContain('domain');
  });

  it('scores two records with matching domain but very different names still in a merge band (domain is dominant)', () => {
    const a: PairCandidate = { canonicalName: 'Acme Corp', domain: 'acme.com' };
    const b: PairCandidate = { canonicalName: 'Acme AI', domain: 'acme.com' };
    const result = scorePair(a, b);
    expect(result.score).toBeGreaterThanOrEqual(PAIR_SCORE_THRESHOLDS.uncertainMerge);
  });

  it('scores two records that share only a moderate name-prefix similarity, no domain, in the uncertain band', () => {
    const a: PairCandidate = { canonicalName: 'Acme Robotics' };
    const b: PairCandidate = { canonicalName: 'Acme Plumbing' };
    const result = scorePair(a, b);
    expect(result.confidence).toBe('uncertain');
    expect(result.score).toBeGreaterThanOrEqual(PAIR_SCORE_THRESHOLDS.uncertainMerge);
    expect(result.score).toBeLessThan(PAIR_SCORE_THRESHOLDS.autoMerge);
  });

  it('scores two completely unrelated companies with different domains below the uncertain threshold', () => {
    const a: PairCandidate = { canonicalName: 'Acme Corp', domain: 'acme.com' };
    const b: PairCandidate = { canonicalName: 'Zephyr Robotics', domain: 'zephyr.io' };
    const result = scorePair(a, b);
    expect(result.confidence).toBe('none');
    expect(result.score).toBeLessThan(PAIR_SCORE_THRESHOLDS.uncertainMerge);
  });

  it('records a shared-person match as a matched signal and raises the score', () => {
    const withoutPerson = scorePair(
      { canonicalName: 'Acme Robotics' },
      { canonicalName: 'Acme Plumbing' },
    );
    const withPerson = scorePair(
      { canonicalName: 'Acme Robotics', people: ['Jane Doe'] },
      { canonicalName: 'Acme Plumbing', people: ['Jane Doe'] },
    );
    expect(withPerson.matchedSignals).toContain('shared-person');
    expect(withPerson.score).toBeGreaterThan(withoutPerson.score);
  });

  it('records an embedding-similarity match and raises the score for otherwise-dissimilar names', () => {
    const similarEmbedding = [1, 0, 0];
    const dissimilarEmbedding = [0, 1, 0];
    const withoutEmbedding = scorePair(
      { canonicalName: 'Acme Robotics' },
      { canonicalName: 'Zephyr Devices' },
    );
    const withMatchingEmbedding = scorePair(
      { canonicalName: 'Acme Robotics', embedding: similarEmbedding },
      { canonicalName: 'Zephyr Devices', embedding: similarEmbedding },
    );
    const withMismatchedEmbedding = scorePair(
      { canonicalName: 'Acme Robotics', embedding: similarEmbedding },
      { canonicalName: 'Zephyr Devices', embedding: dissimilarEmbedding },
    );
    expect(withMatchingEmbedding.score).toBeGreaterThan(withoutEmbedding.score);
    expect(withMatchingEmbedding.score).toBeGreaterThan(withMismatchedEmbedding.score);
  });

  it('domain contributes the dominant (largest) weight among the four signals', () => {
    const weights = Object.values(PAIR_SCORE_WEIGHTS);
    expect(PAIR_SCORE_WEIGHTS.domain).toBe(Math.max(...weights));
  });

  it('never reaches auto confidence without a domain signal, even when the raw weighted score would clear the auto threshold', () => {
    // "DevTools" is a literal prefix of "DevToolsPro" — high name similarity
    // — and both sides share an embedding, but NEITHER has a comparable
    // domain (missing on both). Without domain corroboration, this must cap
    // at 'uncertain', never silently auto-merge.
    const sharedEmbedding = [1, 1, 0];
    const result = scorePair(
      { canonicalName: 'DevTools', embedding: sharedEmbedding },
      { canonicalName: 'DevToolsPro', embedding: sharedEmbedding },
    );
    expect(result.confidence).not.toBe('auto');
  });

  it('reaches auto confidence when domain matches, even though it would also reach auto without the cap', () => {
    const result = scorePair(
      { canonicalName: 'Acme Corp', domain: 'acme.com' },
      { canonicalName: 'Acme Corp', domain: 'acme.com' },
    );
    expect(result.confidence).toBe('auto');
  });
});

describe('classifyBand', () => {
  it('classifies a score at or above the auto-merge threshold as auto', () => {
    expect(classifyBand(PAIR_SCORE_THRESHOLDS.autoMerge)).toBe('auto');
    expect(classifyBand(1)).toBe('auto');
  });

  it('classifies a score between the two thresholds as uncertain', () => {
    const midpoint = (PAIR_SCORE_THRESHOLDS.autoMerge + PAIR_SCORE_THRESHOLDS.uncertainMerge) / 2;
    expect(classifyBand(midpoint)).toBe('uncertain');
  });

  it('classifies a score below the uncertain threshold as none', () => {
    expect(classifyBand(0)).toBe('none');
    expect(classifyBand(PAIR_SCORE_THRESHOLDS.uncertainMerge - 0.01)).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// UnionFind
// ---------------------------------------------------------------------------

describe('UnionFind', () => {
  it('two never-unioned elements are in different groups', () => {
    const uf = new UnionFind<string>();
    expect(uf.find('a')).not.toBe(uf.find('b'));
  });

  it('union(a,b) puts a and b in the same group', () => {
    const uf = new UnionFind<string>();
    uf.union('a', 'b');
    expect(uf.find('a')).toBe(uf.find('b'));
  });

  it('is transitive: union(a,b) + union(b,c) puts a and c in the same group, even though a and c were never unioned directly', () => {
    const uf = new UnionFind<string>();
    uf.union('a', 'b');
    uf.union('b', 'c');
    expect(uf.find('a')).toBe(uf.find('c'));
  });
});

// ---------------------------------------------------------------------------
// mergeClusters — union-find over accepted pairs, orchestrating
// CompanyRepository.merge
// ---------------------------------------------------------------------------

describe('mergeClusters', () => {
  it('merges a transitive A-B-C chain into a single surviving company, even though A and C were never directly scored', async () => {
    const repo = createInMemoryCompanyRepository();
    const a = makeCompany({
      canonicalName: 'Acme Corp',
      domain: 'acme.com',
      firstSeenAt: '2026-01-01T00:00:00.000Z',
    });
    const b = makeCompany({
      canonicalName: 'Acme Corporation',
      domain: 'acme-alt.com',
      firstSeenAt: '2026-01-02T00:00:00.000Z',
    });
    const c = makeCompany({
      canonicalName: 'Acme AI',
      domain: 'acme-ai.com',
      firstSeenAt: '2026-01-03T00:00:00.000Z',
    });
    await repo.save(a);
    await repo.save(b);
    await repo.save(c);

    const acceptedPairs: AcceptedPair[] = [
      {
        a: a.id,
        b: b.id,
        evidence: { pairScore: 0.9, matchedSignals: ['name-similarity'], confidence: 'auto' },
      },
      {
        a: b.id,
        b: c.id,
        evidence: { pairScore: 0.85, matchedSignals: ['name-similarity'], confidence: 'auto' },
      },
    ];

    const survivorOf = await mergeClusters([a, b, c], acceptedPairs, repo);

    // a is the earliest firstSeenAt -> deterministic survivor
    expect(survivorOf.get(b.id)).toBe(a.id);
    expect(survivorOf.get(c.id)).toBe(a.id);

    const survivor = await repo.findByDomain('acme.com');
    expect(survivor?.memberRecordIds).toBeDefined();
  });

  it('never destroys an absorbed company: it remains retrievable after the merge (non-destructive)', async () => {
    const repo = createInMemoryCompanyRepository();
    const a = makeCompany({ domain: 'acme.com', firstSeenAt: '2026-01-01T00:00:00.000Z' });
    const b = makeCompany({ domain: 'acme-alt.com', firstSeenAt: '2026-01-02T00:00:00.000Z' });
    await repo.save(a);
    await repo.save(b);

    const acceptedPairs: AcceptedPair[] = [
      {
        a: a.id,
        b: b.id,
        evidence: { pairScore: 0.9, matchedSignals: ['domain'], confidence: 'auto' },
      },
    ];
    await mergeClusters([a, b], acceptedPairs, repo);

    const stillFound = await repo.findByDomain('acme-alt.com');
    expect(stillFound).toBeDefined();
    expect(stillFound?.mergedInto).toBe(a.id);
  });

  it('leaves an isolated company (no accepted pairs) untouched', async () => {
    const repo = createInMemoryCompanyRepository();
    const solo = makeCompany({ domain: 'solo.com' });
    await repo.save(solo);

    const survivorOf = await mergeClusters([solo], [], repo);

    expect(survivorOf.size).toBe(0);
    const found = await repo.findByDomain('solo.com');
    expect(found?.mergedInto).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveFieldConflict — source precedence + recency tiebreak
// ---------------------------------------------------------------------------

describe('resolveFieldConflict', () => {
  it('picks the value from the higher-precedence source', () => {
    const winner = resolveFieldConflict([
      { value: 'from github', source: 'github', observedAt: '2026-01-01T00:00:00.000Z' },
      { value: 'from hackernews', source: 'hackernews', observedAt: '2026-01-05T00:00:00.000Z' },
    ]);
    expect(winner).toBe('from github');
  });

  it('ties on precedence break by the most recently observed value', () => {
    const winner = resolveFieldConflict([
      { value: 'older', source: 'github', observedAt: '2026-01-01T00:00:00.000Z' },
      { value: 'newer', source: 'github', observedAt: '2026-01-05T00:00:00.000Z' },
    ]);
    expect(winner).toBe('newer');
  });

  it('returns undefined for an empty observation list', () => {
    expect(resolveFieldConflict([])).toBeUndefined();
  });

  it('respects the full documented precedence order: github > rss > hackernews', () => {
    expect(FIELD_SOURCE_PRECEDENCE).toEqual(['github', 'rss', 'hackernews']);
    const winner = resolveFieldConflict([
      { value: 'from rss', source: 'rss', observedAt: '2026-01-10T00:00:00.000Z' },
      { value: 'from hackernews', source: 'hackernews', observedAt: '2026-01-20T00:00:00.000Z' },
    ]);
    expect(winner).toBe('from rss');
  });
});

// ---------------------------------------------------------------------------
// EntityResolver — constructor-injected ports, never a concrete impl
// ---------------------------------------------------------------------------

function makeStubEmbeddingProvider(vector: readonly number[]): EmbeddingProvider {
  return {
    id: 'test-stub',
    dimensions: vector.length,
    async embed(texts) {
      return texts.map(() => [...vector]);
    },
  };
}

describe('EntityResolver', () => {
  it('findCandidateCompanies looks up existing companies via the injected CompanyRepository.findByBlockingKeys', async () => {
    const repo = createInMemoryCompanyRepository();
    const existing = makeCompany({ canonicalName: 'Loglane', domain: 'loglane.com' });
    await repo.save(existing);
    const resolver = new EntityResolver(repo, makeStubEmbeddingProvider([1, 0]));

    const candidates = await resolver.findCandidateCompanies({ canonicalName: 'Loglane Inc' });

    expect(candidates.map((c) => c.id)).toContain(existing.id);
  });

  it('embedDescription calls the injected EmbeddingProvider and returns its vector', async () => {
    const repo = createInMemoryCompanyRepository();
    const resolver = new EntityResolver(repo, makeStubEmbeddingProvider([0.1, 0.2, 0.3]));

    const vector = await resolver.embedDescription('an AI-powered widget analytics platform');

    expect(vector).toEqual([0.1, 0.2, 0.3]);
  });

  it('embedDescription returns undefined without calling the provider when there is no description', async () => {
    const repo = createInMemoryCompanyRepository();
    let called = false;
    const provider: EmbeddingProvider = {
      id: 'test-stub',
      dimensions: 3,
      async embed(texts) {
        called = true;
        return texts.map(() => [0, 0, 0]);
      },
    };
    const resolver = new EntityResolver(repo, provider);

    const vector = await resolver.embedDescription(undefined);

    expect(vector).toBeUndefined();
    expect(called).toBe(false);
  });
});
