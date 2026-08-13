// Entity resolution (spec §8.1 steps 2-3): blocking, weighted pair scoring,
// union-find merge, and field-conflict resolution. Pure functions wherever
// possible — this file lives under the core-layer ESLint boundary
// (eslint.config.js CORE_LAYER_GLOBS), so it imports nothing from
// postgres/drizzle/transformers/hono/node builtins.
//
// The orchestration class (`EntityResolver`) depends ONLY on the
// `CompanyRepository` and `EmbeddingProvider` PORTS (design.md D1/D2),
// injected via its constructor — never a concrete implementation. The real
// `LocalEmbeddingProvider` (transformers.js) does not exist yet (Phase 6);
// this file has no idea it will ever exist, by construction.

import type { Company, CompanyId, MergeEvidence, SourceName } from '../domain/entities.js';
import type { CompanyRepository, EmbeddingProvider } from '../domain/ports.js';
import { normalizeDomain, normalizeName } from './normalize.js';

// ---------------------------------------------------------------------------
// Step 2 — Blocking
//
// Why blocking at all: comparing every candidate against every other
// candidate is O(n^2) and does not survive real volume (thousands of
// source records per run across 3+ sources). Blocking trades a small risk
// of missing a true match that shares NO key with its duplicate (accepted —
// the three key types below are chosen to be complementary: a domain
// rename, a company renamed, AND a name typo would all have to happen
// simultaneously to slip through all three) for comparing only candidates
// that share at least one of: exact normalized domain, the first 4
// characters of the normalized name, or a normalized-name trigram. Only
// pairs sharing a blocking key are ever scored.
// ---------------------------------------------------------------------------

// Key-length choice for the name-prefix block: 4 characters balances two
// failure modes. Shorter (e.g. 2-3 chars) creates enormous blocks for common
// prefixes ("ac", "acm" match hundreds of unrelated "Acme*"/"Active*"/etc.
// names), defeating the point of blocking. Longer (e.g. 5-6 chars) starts
// missing genuine near-duplicates that diverge early ("Loglane" vs
// "Loglabs" already differ at character 4). 4 is a common choice in
// practical record-linkage systems for this exact tradeoff; not derived
// from a formal analysis of this project's real data (there is none yet).
const NAME_PREFIX_LENGTH = 4;
// Trigram length is fixed at 3 by definition ("tri" = three) — not a tuning
// knob, but named here so it never appears as a bare magic number below.
const TRIGRAM_LENGTH = 3;

export interface BlockingCandidate {
  readonly canonicalName: string;
  readonly domain?: string;
}

export function blockingKeys(candidate: BlockingCandidate): readonly string[] {
  const keys = new Set<string>();

  const normalizedDomain = candidate.domain ? normalizeDomain(candidate.domain) : undefined;
  if (normalizedDomain) {
    keys.add(`domain:${normalizedDomain}`);
  }

  const name = normalizeName(candidate.canonicalName);
  if (name.length >= NAME_PREFIX_LENGTH) {
    keys.add(`name4:${name.slice(0, NAME_PREFIX_LENGTH)}`);
  }
  for (let i = 0; i <= name.length - TRIGRAM_LENGTH; i += 1) {
    keys.add(`trigram:${name.slice(i, i + TRIGRAM_LENGTH)}`);
  }

  return Array.from(keys);
}

/**
 * Given a list of candidates, returns every index PAIR that shares at least
 * one blocking key — i.e. exactly the set of pairs step 3 (pair scoring) is
 * allowed to compare. This is the machine-checkable proof that resolution
 * never performs full O(n^2) comparison: for a batch of N candidates where
 * only a handful share blocks, this returns far fewer than N*(N-1)/2 pairs.
 */
export function candidatesToCompare(
  candidates: readonly BlockingCandidate[],
): ReadonlyArray<readonly [number, number]> {
  const blockToIndices = new Map<string, number[]>();
  candidates.forEach((candidate, index) => {
    for (const key of blockingKeys(candidate)) {
      const bucket = blockToIndices.get(key);
      if (bucket) {
        bucket.push(index);
      } else {
        blockToIndices.set(key, [index]);
      }
    }
  });

  const seenPairs = new Set<string>();
  const pairs: Array<readonly [number, number]> = [];
  for (const indices of blockToIndices.values()) {
    for (let i = 0; i < indices.length; i += 1) {
      for (let j = i + 1; j < indices.length; j += 1) {
        const lo = Math.min(indices[i]!, indices[j]!);
        const hi = Math.max(indices[i]!, indices[j]!);
        const dedupeKey = `${lo}:${hi}`;
        // A pair sharing MULTIPLE blocking keys (e.g. same domain AND same
        // name4) must be counted once, not once per shared key.
        if (!seenPairs.has(dedupeKey)) {
          seenPairs.add(dedupeKey);
          pairs.push([lo, hi]);
        }
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Pure similarity math — no domain knowledge, independently testable.
// ---------------------------------------------------------------------------

// Standard Jaro-Winkler constants: 0.1 prefix scaling factor, common-prefix
// bonus capped at 4 characters. These are the textbook values from Winkler's
// original formulation, not project-specific tuning.
const JARO_WINKLER_PREFIX_SCALE = 0.1;
const JARO_WINKLER_MAX_PREFIX_LENGTH = 4;

function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(lenA, lenB) / 2) - 1);
  const aMatches = new Array<boolean>(lenA).fill(false);
  const bMatches = new Array<boolean>(lenB).fill(false);
  let matches = 0;

  for (let i = 0; i < lenA; i += 1) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, lenB);
    for (let j = start; j < end; j += 1) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < lenA; i += 1) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions = Math.floor(transpositions / 2);

  return (matches / lenA + matches / lenB + (matches - transpositions) / matches) / 3;
}

/** Jaro-Winkler string similarity, [0,1]. Rewards a shared prefix. */
export function jaroWinklerSimilarity(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  const maxPrefix = Math.min(JARO_WINKLER_MAX_PREFIX_LENGTH, a.length, b.length);
  let prefixLength = 0;
  while (prefixLength < maxPrefix && a[prefixLength] === b[prefixLength]) {
    prefixLength += 1;
  }
  return jaro + prefixLength * JARO_WINKLER_PREFIX_SCALE * (1 - jaro);
}

/** Cosine similarity, [-1,1]. Returns 0 for empty or mismatched-length vectors
 * (defensive default rather than throwing — callers treat "no signal" the
 * same as "signal unavailable"). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Step 3 — Pair scoring
//
// Weighted combination of 4 signals. `domain` carries the DOMINANT weight
// (0.5 — equal to the other three combined) per spec §8.1's explicit
// instruction that identical domain is "a strong match,
// dominant weight": two records on the same registrable domain are, in
// practice, almost never two different companies. The remaining 0.5 splits
// across name similarity (0.25 — the next most reliable signal, always
// computable), embedding cosine (0.15 — useful but noisier, and only
// available once a description has been embedded), and shared person
// (0.10 — high-precision when present, but rarely present).
//
// IMPORTANT: not every signal is available for every pair (a record may
// have no domain, no embedding yet, no people). Missing signals are
// EXCLUDED from the weighted average and the remaining weights are
// renormalized to sum to 1, rather than treated as a 0 contribution. This
// is a deliberate design decision: treating "no domain on this record" the
// same as "domain present but different" would unfairly punish records
// from sources that never carry a domain (e.g. HN posts), even when every
// signal that IS available points to a match.
// ---------------------------------------------------------------------------

export const PAIR_SCORE_WEIGHTS = {
  domain: 0.5,
  name: 0.25,
  embedding: 0.15,
  sharedPerson: 0.1,
} as const;

// Judgment call — not specified numerically by the spec prose, only as
// "high threshold" / "middle band" / "below". Chosen so that: (a) a
// genuine match — identical domain plus a name that is at least
// recognizably similar (name similarity is always computed, never skipped,
// even when domain also matches) — clears autoMerge; a domain match alone
// against a MAXIMALLY dissimilar name does NOT reach autoMerge on its own
// (0.5 domain + ~0 name/embedding/person renormalized ≈0.5-0.8, below the
// 0.82 floor), which is intentional: domain match plus a wildly different
// name is exactly the shape of a false positive a naive "domain is
// everything" rule would fall for; (b) a domain match paired with a
// materially different-but-plausible name still clears the merge floor
// (matches the "domain is dominant" spec framing) without necessarily
// reaching auto-merge; (c) name-only matches on a shared prefix land in the
// uncertain band, never auto-merge, because name alone is not reliable
// enough for silent merging. Tuned against this phase's unit + golden
// tests, not against production data (there is none yet) — flagged as a
// judgment call worth revisiting once real resolution data exists.
export const PAIR_SCORE_THRESHOLDS = {
  autoMerge: 0.82,
  uncertainMerge: 0.55,
} as const;

// A name similarity or embedding similarity below this value is not counted
// as a "matched signal" in MergeEvidence.matchedSignals, even though it
// still contributes its (possibly small, possibly negative-pulling) value
// to the weighted average. This keeps matchedSignals meaningful ("what
// pushed this toward a merge") rather than listing every signal that merely
// existed.
const NAME_SIMILARITY_MATCH_THRESHOLD = 0.85;
const EMBEDDING_SIMILARITY_MATCH_THRESHOLD = 0.85;

export interface PairCandidate {
  readonly canonicalName: string;
  readonly domain?: string;
  readonly embedding?: readonly number[];
  readonly people?: readonly string[];
}

export type MatchConfidence = 'auto' | 'uncertain' | 'none';

export interface PairScoreResult {
  readonly score: number;
  readonly matchedSignals: readonly string[];
  readonly confidence: MatchConfidence;
}

export function classifyBand(score: number): MatchConfidence {
  if (score >= PAIR_SCORE_THRESHOLDS.autoMerge) return 'auto';
  if (score >= PAIR_SCORE_THRESHOLDS.uncertainMerge) return 'uncertain';
  return 'none';
}

function normalizePerson(person: string): string {
  return person.trim().toLowerCase();
}

export function scorePair(a: PairCandidate, b: PairCandidate): PairScoreResult {
  const matchedSignals: string[] = [];
  const contributions: Array<{ readonly weight: number; readonly value: number }> = [];

  const domainA = a.domain ? normalizeDomain(a.domain) : undefined;
  const domainB = b.domain ? normalizeDomain(b.domain) : undefined;
  if (domainA && domainB) {
    const domainMatches = domainA === domainB;
    contributions.push({ weight: PAIR_SCORE_WEIGHTS.domain, value: domainMatches ? 1 : 0 });
    if (domainMatches) matchedSignals.push('domain');
  }

  // Name similarity is always computable — both sides always have a name.
  const nameSimilarity = jaroWinklerSimilarity(
    normalizeName(a.canonicalName),
    normalizeName(b.canonicalName),
  );
  contributions.push({ weight: PAIR_SCORE_WEIGHTS.name, value: nameSimilarity });
  if (nameSimilarity >= NAME_SIMILARITY_MATCH_THRESHOLD) matchedSignals.push('name-similarity');

  if (a.embedding && b.embedding) {
    const cosine = cosineSimilarity(a.embedding, b.embedding);
    // Map [-1,1] -> [0,1] to combine linearly with the other [0,1] signals.
    const normalizedCosine = (cosine + 1) / 2;
    contributions.push({ weight: PAIR_SCORE_WEIGHTS.embedding, value: normalizedCosine });
    if (normalizedCosine >= EMBEDDING_SIMILARITY_MATCH_THRESHOLD) {
      matchedSignals.push('embedding-similarity');
    }
  }

  if (a.people && a.people.length > 0 && b.people && b.people.length > 0) {
    const bPeople = new Set(b.people.map(normalizePerson));
    const shared = a.people.some((person) => bPeople.has(normalizePerson(person)));
    contributions.push({ weight: PAIR_SCORE_WEIGHTS.sharedPerson, value: shared ? 1 : 0 });
    if (shared) matchedSignals.push('shared-person');
  }

  const totalWeight = contributions.reduce((sum, c) => sum + c.weight, 0);
  const score =
    totalWeight > 0
      ? contributions.reduce((sum, c) => sum + c.weight * c.value, 0) / totalWeight
      : 0;

  const domainAvailable = Boolean(domainA && domainB);
  const rawBand = classifyBand(score);
  // Domain carries the DOMINANT weight specifically because an identical
  // domain is near-certain proof of common ownership (spec §8.1). The
  // inverse also holds: without ANY domain signal to corroborate, name
  // similarity alone (even boosted by embedding/person) is not reliable
  // enough to silently auto-merge — a company name that happens to be a
  // literal prefix of another's (e.g. "DevTools" / "DevToolsPro") can
  // otherwise cross the auto-merge threshold on name+embedding alone. When
  // domain could not be compared (missing or excluded generic-hosting on
  // either side), cap confidence at 'uncertain' so the merge still happens
  // but is visibly flagged, never silent. This was found and fixed via this
  // phase's golden test (see tests/golden/entity-resolution.golden.test.ts,
  // pair-19).
  const confidence: MatchConfidence =
    !domainAvailable && rawBand === 'auto' ? 'uncertain' : rawBand;

  return { score, matchedSignals, confidence };
}

// ---------------------------------------------------------------------------
// Union-find — collapses accepted pairs transitively (A≈B, B≈C => A,B,C are
// one entity, even though A≈C was never directly scored, because A and C
// may never have shared a blocking key). Generic over any comparable key
// type so it can operate on CompanyId at the merge-orchestration layer.
// ---------------------------------------------------------------------------

export class UnionFind<T> {
  private readonly parent = new Map<T, T>();

  find(x: T): T {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    const p = this.parent.get(x)!;
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }

  union(a: T, b: T): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) {
      this.parent.set(rootA, rootB);
    }
  }

  /** Groups every element that has been `find`/`union`ed, keyed by root. */
  groups(): ReadonlyMap<T, readonly T[]> {
    const result = new Map<T, T[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const bucket = result.get(root);
      if (bucket) {
        bucket.push(key);
      } else {
        result.set(root, [key]);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Merge orchestration — turns accepted pairs into CompanyRepository.merge()
// calls via union-find clustering.
// ---------------------------------------------------------------------------

export interface AcceptedPair {
  readonly a: CompanyId;
  readonly b: CompanyId;
  readonly evidence: MergeEvidence;
}

function pickSurvivor(members: readonly Company[]): Company {
  // Deterministic survivor choice: the company we have known about the
  // LONGEST (earliest firstSeenAt) anchors the merged identity, tie-broken
  // by lexicographically smallest id so the choice never depends on
  // iteration/insertion order (reproducible across runs on the same data).
  return [...members].sort((x, y) => {
    if (x.firstSeenAt !== y.firstSeenAt) {
      return x.firstSeenAt < y.firstSeenAt ? -1 : 1;
    }
    return x.id < y.id ? -1 : 1;
  })[0]!;
}

function strongestEvidenceFor(companyId: CompanyId, pairs: readonly AcceptedPair[]): MergeEvidence {
  // A company inside a multi-member cluster is guaranteed to appear in at
  // least one accepted pair (that is how it entered the cluster). When it
  // was united into the cluster transitively rather than scored directly
  // against the chosen survivor (A and C in an A-B-C chain), we record its
  // STRONGEST direct pairwise evidence within the cluster rather than
  // inventing an evidence value for a comparison that never happened. This
  // is a documented approximation: the persisted evidence describes why
  // this company joined SOME member of the cluster, not necessarily the
  // specific survivor it ends up pointing at.
  const relevant = pairs.filter((p) => p.a === companyId || p.b === companyId);
  return relevant.reduce((best, p) => (p.evidence.pairScore > best.evidence.pairScore ? p : best))
    .evidence;
}

/**
 * Resolves accepted pairwise matches into merged companies via union-find,
 * then applies each merge through `CompanyRepository.merge` (non-destructive
 * — see design.md "merge is non-destructive"). Returns a map from every
 * ABSORBED company id to the id of its surviving company. Companies with no
 * accepted pair are left untouched and are absent from the returned map.
 */
export async function mergeClusters(
  companies: readonly Company[],
  acceptedPairs: readonly AcceptedPair[],
  companyRepo: CompanyRepository,
): Promise<ReadonlyMap<CompanyId, CompanyId>> {
  const uf = new UnionFind<CompanyId>();
  for (const company of companies) {
    uf.find(company.id); // ensure every company has its own singleton group
  }
  for (const pair of acceptedPairs) {
    uf.union(pair.a, pair.b);
  }

  const byId = new Map(companies.map((c) => [c.id, c] as const));
  const survivorOf = new Map<CompanyId, CompanyId>();

  for (const members of uf.groups().values()) {
    if (members.length < 2) continue; // no accepted pair touched this company

    const memberCompanies = members
      .map((id) => byId.get(id))
      .filter((c): c is Company => c !== undefined);
    const survivor = pickSurvivor(memberCompanies);

    for (const member of memberCompanies) {
      if (member.id === survivor.id) continue;
      const evidence = strongestEvidenceFor(member.id, acceptedPairs);
      // Awaited sequentially (not Promise.all'd): repository.merge() mutates
      // shared company state, and design.md's data-flow step 3 is
      // explicitly "STRICTLY SEQUENTIAL" for this exact reason (parallel
      // merges would race).
      await companyRepo.merge(survivor.id, member.id, evidence);
      survivorOf.set(member.id, survivor.id);
    }
  }

  return survivorOf;
}

// ---------------------------------------------------------------------------
// Field-conflict resolution (spec §8.1 "Field conflicts") — kept as its own
// small, independently unit-tested function rather than buried inside merge
// logic, per this phase's explicit instruction.
//
// Source precedence is a DOMAIN POLICY constant, not an env var: per spec's
// explicit allowance, this is operator/architect-level judgment about which
// sources produce more trustworthy structured data, not a deployment-time
// concern (env vars answer "which environment am I in", not "which source
// do I trust more"). Order, most to least trusted:
//   1. github     — structured API data, maintainer-authored fields
//      (description, name) tend to be accurate and current.
//   2. rss        — publisher-authored press/blog content; curated, but
//      self-reported by the company or a journalist, not machine-verified.
//   3. hackernews — crowd-submitted free text (Show HN titles); highest
//      variance, most prone to marketing spin, typos, or stale info.
// ---------------------------------------------------------------------------

export const FIELD_SOURCE_PRECEDENCE: readonly SourceName[] = ['github', 'rss', 'hackernews'];

export interface FieldObservation<T> {
  readonly value: T;
  readonly source: SourceName;
  readonly observedAt: string; // ISO 8601
}

function precedenceRank(source: SourceName): number {
  const index = FIELD_SOURCE_PRECEDENCE.indexOf(source);
  return index === -1 ? FIELD_SOURCE_PRECEDENCE.length : index;
}

export function resolveFieldConflict<T>(
  observations: readonly FieldObservation<T>[],
): T | undefined {
  if (observations.length === 0) return undefined;

  const bestRank = Math.min(...observations.map((o) => precedenceRank(o.source)));
  const topTier = observations.filter((o) => precedenceRank(o.source) === bestRank);

  // Tie-break: most recently observed value wins (spec §8.1 verbatim).
  return topTier.reduce((latest, o) => (o.observedAt > latest.observedAt ? o : latest)).value;
}

// ---------------------------------------------------------------------------
// EntityResolver — thin orchestration class. Constructor-injected PORTS
// only (never a concrete provider/repository class), so this file has zero
// knowledge of Postgres or transformers.js.
// ---------------------------------------------------------------------------

export class EntityResolver {
  constructor(
    private readonly companies: CompanyRepository,
    private readonly embeddings: EmbeddingProvider,
  ) {}

  /** Finds existing companies sharing at least one blocking key with the
   * given candidate — the set of candidates step-3 pair scoring compares
   * against. */
  async findCandidateCompanies(candidate: BlockingCandidate): Promise<readonly Company[]> {
    const keys = blockingKeys(candidate);
    return this.companies.findByBlockingKeys(keys);
  }

  /** Embeds a description via the injected EmbeddingProvider, or returns
   * `undefined` without calling the provider when there is no description
   * to embed (avoids a wasted batch call for e.g. a signal-only record). */
  async embedDescription(description: string | undefined): Promise<readonly number[] | undefined> {
    if (!description) return undefined;
    const [vector] = await this.embeddings.embed([description]);
    return vector;
  }

  /** Applies a batch of accepted pairwise matches as merges, via union-find
   * clustering, through the injected CompanyRepository. */
  async mergeAcceptedPairs(
    companies: readonly Company[],
    acceptedPairs: readonly AcceptedPair[],
  ): Promise<ReadonlyMap<CompanyId, CompanyId>> {
    return mergeClusters(companies, acceptedPairs, this.companies);
  }
}
