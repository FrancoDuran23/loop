// LocalEmbeddingProvider — real sentence embeddings via transformers.js
// running `Xenova/all-MiniLM-L6-v2` (spec §9: "LocalEmbeddingProvider
// (transformers.js corriendo all-MiniLM-L6-v2, se descarga el modelo la
// primera vez y después funciona offline)"). `Xenova/all-MiniLM-L6-v2` is
// the transformers.js (ONNX-converted) port of the Python
// `sentence-transformers/all-MiniLM-L6-v2` model — model naming differs
// between the two ecosystems because transformers.js requires an
// ONNX-exported copy of the weights, published under the `Xenova`
// namespace on the Hugging Face Hub. Verified working end-to-end against
// the real model (see the phase report for the live cosine-similarity
// proof) — not just typechecked against the SDK's types.
//
// This file is infrastructure (src/providers/**), NOT under the core-layer
// ESLint boundary (eslint.config.js CORE_LAYER_GLOBS) — this is exactly
// where the @huggingface/transformers import belongs, per design.md's
// module boundary diagram ("ADAPTERS (impl ports)" zone).
//
// NEVER imported by anything under tests/** that runs in the default
// `npm run test` suite: the first call downloads ~90MB of model weights and
// requires network access on a clean machine, which would make CI slow and
// flaky, contradicting spec §9's own stated purpose for
// DeterministicEmbeddingProvider ("hace que el CI sea rápido y
// reproducible, sin descargar 90MB"). The live proof this genuinely works
// is a separate, explicitly-gated script — see scripts/verify-local-embeddings.ts,
// run manually via `npm run verify:local-embeddings`, never part of `npm run test`.

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingProvider } from '../../domain/ports.js';

export const LOCAL_EMBEDDING_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
export const LOCAL_EMBEDDING_DIMENSIONS = 384;

// The extractor is expensive to construct (loads/downloads the model), so it
// is created lazily on first use and memoized — every subsequent embed()
// call across the process reuses the same pipeline instance. Module-level
// state is a deliberate, narrow exception here: this mirrors how
// transformers.js's own `pipeline()` factory is designed to be used (a
// single long-lived instance per model), and createLocalEmbeddingProvider()
// still returns a fresh EmbeddingProvider object each call — only the
// underlying model weights are shared/cached, exactly like a real ML
// runtime would.
let extractorPromise: Promise<FeatureExtractionPipeline> | undefined;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline('feature-extraction', LOCAL_EMBEDDING_MODEL_ID);
  return extractorPromise;
}

// tolist() on the SDK's Tensor type is typed `any[]` (see
// node_modules/@huggingface/transformers/types/utils/tensor.d.ts) — the only
// `any` boundary in this file. Immediately narrowed to `unknown` and
// runtime-validated here so no `any` escapes into the rest of the codebase,
// matching this project's "zero any outside validated boundaries" rule.
function toNumberMatrix(value: unknown): readonly number[][] {
  if (!Array.isArray(value)) {
    throw new TypeError('LocalEmbeddingProvider: expected embed output to be an array of vectors');
  }
  return value.map((row) => {
    if (!Array.isArray(row) || row.some((n) => typeof n !== 'number')) {
      throw new TypeError(
        'LocalEmbeddingProvider: expected each embedding to be an array of numbers',
      );
    }
    return row as number[];
  });
}

export function createLocalEmbeddingProvider(): EmbeddingProvider {
  return {
    id: 'local-minilm',
    dimensions: LOCAL_EMBEDDING_DIMENSIONS,
    async embed(texts) {
      if (texts.length === 0) return [];
      const extractor = await getExtractor();
      const output: unknown = await extractor(texts as string[], {
        pooling: 'mean',
        normalize: true,
      });
      // FeatureExtractionPipelineOutput is a Tensor (has .tolist()) when
      // called with pooling+normalize set, per feature-extraction.js.
      const tensor = output as { tolist(): unknown };
      return toNumberMatrix(tensor.tolist());
    },
  };
}
