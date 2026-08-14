import { describe, expect, it } from 'vitest';
import {
  createDeterministicEmbeddingProvider,
  DETERMINISTIC_EMBEDDING_DIMENSIONS,
} from '../../../src/providers/embeddings/deterministic.js';

describe('DeterministicEmbeddingProvider', () => {
  it('has id "deterministic" and 384 dimensions', () => {
    const provider = createDeterministicEmbeddingProvider();
    expect(provider.id).toBe('deterministic');
    expect(provider.dimensions).toBe(384);
    expect(DETERMINISTIC_EMBEDDING_DIMENSIONS).toBe(384);
  });

  it('returns the SAME vector for the SAME input text every time', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [first] = await provider.embed(['Acme Corp builds developer tools.']);
    const [second] = await provider.embed(['Acme Corp builds developer tools.']);

    expect(first).toEqual(second);
  });

  it('returns DIFFERENT vectors for different input texts', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [a, b] = await provider.embed([
      'Acme Corp builds developer tools.',
      'A totally unrelated sentence.',
    ]);

    expect(a).not.toEqual(b);
  });

  it('returns vectors of exactly 384 dimensions', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [vector] = await provider.embed(['hello world']);

    expect(vector).toHaveLength(384);
  });

  it('returns L2-normalized (unit) vectors', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const [vector] = await provider.embed(['normalize me']);

    const norm = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it('embeds a batch of texts in one call, preserving order', async () => {
    const provider = createDeterministicEmbeddingProvider();
    const texts = ['first', 'second', 'third'];
    const vectors = await provider.embed(texts);

    expect(vectors).toHaveLength(3);
    const [individualFirst] = await provider.embed(['first']);
    expect(vectors[0]).toEqual(individualFirst);
  });
});
