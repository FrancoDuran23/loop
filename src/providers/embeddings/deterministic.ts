// DeterministicEmbeddingProvider — a stable, hash-seeded pseudo-embedding
// used for tests and CI (spec §9: "DeterministicEmbeddingProvider (hash
// estable, solo para tests) — hace que el CI sea rápido y reproducible, sin
// descargar 90MB"). This is deliberately NOT a semantic embedding: it makes
// no claim that similar-meaning texts produce similar vectors. It only
// guarantees:
//   1. the SAME input text always produces the SAME 384-dim unit vector
//   2. DIFFERENT texts produce (with overwhelming probability) different
//      vectors
// That is exactly what scoring/scorer.ts's cosine-similarity math needs in
// order to be exercised deterministically in unit tests, with no network
// access and no model download — unlike LocalEmbeddingProvider (local.ts),
// which is NEVER imported by anything under `tests/**` that runs in the
// default `npm run test` suite.
//
// Note: this is a DIFFERENT stub from tests/support/test-embedding.ts
// (Phase 4's 32-dim bag-of-words hash, used only by resolver tests, which
// predates this file per that file's own header comment). This provider is
// production code (`EMBEDDING_PROVIDER=deterministic` is a real, supported
// runtime configuration per config.ts — e.g. for fast local dev without a
// model download), asserts the real 384 dimension, and lives under
// src/providers/ rather than tests/.

import type { EmbeddingProvider } from '../../domain/ports.js';

export const DETERMINISTIC_EMBEDDING_DIMENSIONS = 384;

// FNV-1a: a small, well-known non-cryptographic string hash. Used only to
// turn arbitrary text into a 32-bit PRNG seed — collision resistance beyond
// "different texts almost always hash differently" is not required here.
function fnv1aHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// mulberry32 — a small, fast, widely-used PRNG (public domain). Deliberately
// non-cryptographic: determinism (same seed -> same output sequence, every
// time, on every machine) is the entire point of this provider.
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function embedOne(text: string): number[] {
  const rand = mulberry32(fnv1aHash(text));
  const vector = new Array<number>(DETERMINISTIC_EMBEDDING_DIMENSIONS);
  for (let i = 0; i < DETERMINISTIC_EMBEDDING_DIMENSIONS; i += 1) {
    vector[i] = rand() * 2 - 1; // [0,1) -> [-1,1)
  }
  // L2-normalize to a unit vector, matching what a real sentence-transformer
  // produces (and what a cosine-similarity caller reasonably expects).
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vector : vector.map((v) => v / norm);
}

export function createDeterministicEmbeddingProvider(): EmbeddingProvider {
  return {
    id: 'deterministic',
    dimensions: DETERMINISTIC_EMBEDDING_DIMENSIONS,
    async embed(texts) {
      return texts.map(embedOne);
    },
  };
}
