// Shared composition root — builds the full graph of real repositories,
// providers, and source adapters that both entrypoints (src/cli.ts,
// src/api/server.ts) need. This is the ONE place a concrete
// repository/provider class is instantiated for a live run against real
// Postgres; runPipeline (src/pipeline/run.ts) itself never does.
//
// Resolves design.md's own D6 open question ("src/runtime.ts is one file
// beyond §13's prescribed tree. Confirm, or fold wiring into cli.ts +
// api/server.ts and accept duplication.") — Phase 9a accepted the
// duplication because only cli.ts needed this wiring at the time. Phase 9b
// adds a SECOND caller (POST /runs) that needs the IDENTICAL graph, at
// which point duplicating a whole composition root stops being "accept a
// little repetition" and starts being "two independently-maintained copies
// of the same wiring that WILL drift" — so this phase extracts it. No
// change to db/, domain/, or any core-layer file was required to do this;
// it is a pure move of logic that already lived inline in cli.ts's main().

import type { RunId, SourceName } from './domain/entities.js';
import type {
  CompanyRepository,
  DealReadModel,
  EmbeddingProvider,
  LlmProvider,
  RunRepository,
  ScoredDealRepository,
  SourceAdapter,
  SourceRecordRepository,
} from './domain/ports.js';
import { loadConfig, type Config } from './config.js';
import { closeDatabase, createDatabase, type Database } from './db/client.js';
import { createPostgresDealReadModel } from './db/deal-read-model.js';
import {
  createPostgresCompanyRepository,
  createPostgresRunRepository,
  createPostgresScoredDealRepository,
  createPostgresSourceRecordRepository,
} from './db/repository.js';
import { createDeterministicEmbeddingProvider } from './providers/embeddings/deterministic.js';
import { createLocalEmbeddingProvider } from './providers/embeddings/local.js';
import { createRulesLlmProvider } from './providers/llm/rules.js';
import { GithubAdapter } from './sources/github.js';
import { HackerNewsAdapter } from './sources/hackernews.js';
import { RssAdapter } from './sources/rss.js';

export const ALL_SOURCES: readonly SourceName[] = ['github', 'hackernews', 'rss'];

export interface Runtime {
  readonly config: Config;
  readonly db: Database;
  readonly companies: CompanyRepository;
  readonly sourceRecords: SourceRecordRepository;
  readonly runs: RunRepository;
  readonly scoredDeals: ScoredDealRepository;
  readonly dealReadModel: DealReadModel;
  readonly embeddings: EmbeddingProvider;
  readonly llm: LlmProvider;
  /** Builds ONE fresh SourceAdapter for the given source. Fresh per call
   * (not cached) — matches the pre-existing CLI behavior (Phase 9a) of
   * constructing a new adapter set for every pipeline run, so a run's
   * per-source rate-limit/retry state never leaks across separate runs.
   * Kept as a bare factory rather than a Runtime-level cache so both
   * entrypoints share identical adapter-construction logic without
   * disagreeing on lifetime semantics. */
  buildSourceAdapter(name: SourceName): SourceAdapter;
  /** Convenience: builds a fresh adapter for every requested source name
   * (defaults to all 3). */
  buildSourceAdapters(names?: readonly SourceName[]): readonly SourceAdapter[];
  /** Generates a fresh RunId — thin wrapper so callers don't need their own
   * `crypto.randomUUID() as RunId` cast at each call site. */
  newRunId(): RunId;
  close(): Promise<void>;
}

/**
 * Builds the real composition graph: real Postgres repositories + the
 * DealReadModel, real embeddings/LLM providers selected by config, and a
 * source-adapter factory. Throws fast (before touching the database) if
 * `LLM_PROVIDER=ollama` is configured — OllamaLlmProvider remains
 * unimplemented (providers/llm/rules.ts's own scope note); Phase 9a's CLI
 * already failed fast here, this just centralizes that check so the API
 * server inherits it too instead of needing its own copy.
 */
export function createRuntime(config: Config = loadConfig()): Runtime {
  if (config.LLM_PROVIDER === 'ollama') {
    throw new Error(
      'LLM_PROVIDER=ollama is not implemented yet. Unset it (or set it to "rules") to use the default RulesLlmProvider.',
    );
  }

  const { db, client } = createDatabase(config);
  const embeddings =
    config.EMBEDDING_PROVIDER === 'local'
      ? createLocalEmbeddingProvider()
      : createDeterministicEmbeddingProvider();

  function buildSourceAdapter(name: SourceName): SourceAdapter {
    switch (name) {
      case 'github':
        return new GithubAdapter(
          (url, init) => fetch(url, init),
          config.GITHUB_TOKEN ? { token: config.GITHUB_TOKEN } : {},
        );
      case 'hackernews':
        return new HackerNewsAdapter((url, init) => fetch(url, init));
      case 'rss':
        return new RssAdapter((url, init) => fetch(url, init));
    }
  }

  return {
    config,
    db,
    companies: createPostgresCompanyRepository(db),
    sourceRecords: createPostgresSourceRecordRepository(db),
    runs: createPostgresRunRepository(db),
    scoredDeals: createPostgresScoredDealRepository(db),
    dealReadModel: createPostgresDealReadModel(db),
    embeddings,
    llm: createRulesLlmProvider(),
    buildSourceAdapter,
    buildSourceAdapters: (names = ALL_SOURCES) => names.map(buildSourceAdapter),
    newRunId: () => crypto.randomUUID() as RunId,
    close: () => closeDatabase(client),
  };
}
