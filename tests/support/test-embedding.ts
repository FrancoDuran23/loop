// Test-only deterministic embedding provider. Phase 6 owns the REAL
// EmbeddingProvider implementations (LocalEmbeddingProvider via
// transformers.js, DeterministicEmbeddingProvider as a production
// test-fixture provider) — neither exists yet. This stub exists ONLY so
// Phase 4's unit and golden tests can exercise resolver.ts's
// embedding-cosine-similarity signal without depending on anything from
// Phase 6, per this phase's explicit scope boundary.
//
// Deterministic bag-of-words hashing: each word in the input text is hashed
// into one of EMBEDDING_DIMENSIONS buckets and increments that bucket's
// count. Two texts sharing many words end up with high cosine similarity;
// texts with disjoint vocabularies end up close to orthogonal. This is
// intentionally crude (no semantics, just shared-token overlap) — it is a
// STAND-IN for a real sentence embedding model, good enough to prove the
// resolver's cosine-similarity wiring behaves correctly, not a claim about
// real embedding quality.

import type { EmbeddingProvider } from '../../src/domain/ports.js';

const EMBEDDING_DIMENSIONS = 32;

function hashWordToBucket(word: string): number {
  let hash = 0;
  for (let i = 0; i < word.length; i += 1) {
    hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
  }
  return hash % EMBEDDING_DIMENSIONS;
}

export function hashEmbedText(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  for (const word of words) {
    // hashWordToBucket always returns an index in [0, EMBEDDING_DIMENSIONS),
    // and `vector` was allocated with exactly that length, so this index is
    // always in-bounds.
    vector[hashWordToBucket(word)]! += 1;
  }
  return vector;
}

export function createHashEmbeddingProvider(): EmbeddingProvider {
  return {
    id: 'test-hash-stub',
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map(hashEmbedText);
    },
  };
}
