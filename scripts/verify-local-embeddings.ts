// Manual, explicitly-gated proof that LocalEmbeddingProvider genuinely works
// against the real transformers.js model — NOT run by `npm run test` (see
// src/providers/embeddings/local.ts's header comment for why). Run with:
//
//   npm run verify:local-embeddings
//
// First run downloads ~90MB of model weights (Xenova/all-MiniLM-L6-v2) and
// requires network access; subsequent runs use the local cache and work
// offline, per spec §9.
//
// What this proves: embeds two topically-similar sentences and two
// topically-different sentences, then asserts the similar pair's cosine
// similarity is meaningfully higher than the dissimilar pair's — i.e. the
// model produces genuinely semantic embeddings, not just 384 numbers that
// typecheck.

import { createLocalEmbeddingProvider } from '../src/providers/embeddings/local.js';

function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function main(): Promise<void> {
  const provider = createLocalEmbeddingProvider();
  console.log(`Loading model (first run downloads ~90MB, please wait)...`);

  const sentenceA1 = 'A startup building open-source developer tools for Kubernetes.';
  const sentenceA2 = 'A young company making open-source tooling for container orchestration.';
  const sentenceB1 = 'A recipe for baking sourdough bread at home.';
  const sentenceB2 = 'A history documentary about ancient Roman aqueducts.';

  const [embA1, embA2, embB1, embB2] = await provider.embed([
    sentenceA1,
    sentenceA2,
    sentenceB1,
    sentenceB2,
  ]);

  if (!embA1 || !embA2 || !embB1 || !embB2) {
    throw new Error('embed() returned fewer vectors than inputs');
  }

  console.log(`provider.id = ${provider.id}`);
  console.log(`provider.dimensions = ${provider.dimensions}`);
  console.log(`embA1.length = ${embA1.length}`);

  if (embA1.length !== provider.dimensions || embA1.length !== 384) {
    throw new Error(`Expected 384-dim vectors, got ${embA1.length}`);
  }

  const similarPairSimilarity = cosineSimilarity(embA1, embA2);
  const dissimilarPairSimilarity = cosineSimilarity(embB1, embB2);
  const crossPairSimilarity = cosineSimilarity(embA1, embB1);

  console.log(
    `\ncosine(similar pair — both about dev tooling)      = ${similarPairSimilarity.toFixed(4)}`,
  );
  console.log(
    `cosine(dissimilar pair — baking vs. Roman history) = ${dissimilarPairSimilarity.toFixed(4)}`,
  );
  console.log(
    `cosine(cross pair — dev tooling vs. baking)        = ${crossPairSimilarity.toFixed(4)}`,
  );

  if (!(similarPairSimilarity > crossPairSimilarity)) {
    throw new Error(
      `FAILED: expected the similar pair (${similarPairSimilarity.toFixed(4)}) to score higher than ` +
        `the cross pair (${crossPairSimilarity.toFixed(4)}) — the model is not producing meaningful ` +
        `semantic embeddings.`,
    );
  }

  console.log(
    '\nPASSED: similar-topic sentences score a higher cosine similarity than unrelated ones.',
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
