// Real pipeline entry point (Phase 9a upgrade from the Phase-3 HN-only
// demo). Spec §18's own acceptance criterion: on a clean machine with ZERO
// environment variables, `docker compose up -d && npm i && npm run
// db:migrate && npm run pipeline -- --thesis thesis.example.yaml` must
// produce ranked deals with score and rationale.
//
// Default, zero-cost providers (config.ts's own defaults — no env vars
// needed): RulesLlmProvider (LLM_PROVIDER=rules, always available, zero
// external calls) and LocalEmbeddingProvider (EMBEDDING_PROVIDER=local —
// transformers.js running Xenova/all-MiniLM-L6-v2). Note this DOWNLOADS the
// model (~90MB) on first run, then works fully offline — deliberately NOT
// DeterministicEmbeddingProvider, which spec §9 explicitly scopes to
// tests/CI only ("solo para tests"), never a real run's default.
//
// Wires real Postgres repositories (src/db/client.ts + src/db/repository.ts)
// using config.ts's already-defaulted DATABASE_URL — no env vars required
// for the docker-compose.yml-shaped local Postgres.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Company, CompanyId, RunId, ScoredDeal, SourceName } from './domain/entities.js';
import type { SourceAdapter } from './domain/ports.js';
import { parseThesis } from './domain/thesis.js';
import { loadConfig, type Config } from './config.js';
import { closeDatabase, createDatabase } from './db/client.js';
import {
  createPostgresCompanyRepository,
  createPostgresRunRepository,
  createPostgresScoredDealRepository,
  createPostgresSourceRecordRepository,
} from './db/repository.js';
import { createDeterministicEmbeddingProvider } from './providers/embeddings/deterministic.js';
import { createLocalEmbeddingProvider } from './providers/embeddings/local.js';
import { createRulesLlmProvider } from './providers/llm/rules.js';
import { runPipeline, type RunPipelineDeps } from './pipeline/run.js';
import { GithubAdapter } from './sources/github.js';
import { HackerNewsAdapter } from './sources/hackernews.js';
import { RssAdapter } from './sources/rss.js';

const DEFAULT_LIMIT_PER_SOURCE = 20;
const DEFAULT_THESIS_PATH = 'thesis.example.yaml';
const ALL_SOURCES: readonly SourceName[] = ['github', 'hackernews', 'rss'];

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CliOptions {
  readonly thesisPath: string;
  readonly limit: number;
  readonly sources: readonly SourceName[];
}

function isSourceName(value: string): value is SourceName {
  return (ALL_SOURCES as readonly string[]).includes(value);
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let thesisPath = DEFAULT_THESIS_PATH;
  let limitInput = String(DEFAULT_LIMIT_PER_SOURCE);
  let sourcesInput: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--thesis' && value !== undefined) {
      thesisPath = value;
      i += 1;
    } else if (flag === '--limit' && value !== undefined) {
      limitInput = value;
      i += 1;
    } else if (flag === '--source' && value !== undefined) {
      sourcesInput = value;
      i += 1;
    }
  }

  const limit = Number(limitInput);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive number, got "${limitInput}"`);
  }

  let sources: readonly SourceName[] = ALL_SOURCES;
  if (sourcesInput !== undefined) {
    const requested = sourcesInput.split(',').map((s) => s.trim());
    for (const name of requested) {
      if (!isSourceName(name)) {
        throw new Error(
          `Unsupported --source "${name}". Must be one of: ${ALL_SOURCES.join(', ')}.`,
        );
      }
    }
    sources = requested.filter(isSourceName);
  }

  return { thesisPath, limit, sources };
}

// ---------------------------------------------------------------------------
// Output formatting (pure — unit tested)
// ---------------------------------------------------------------------------

export function formatRankedDeals(
  deals: readonly ScoredDeal[],
  companiesById: ReadonlyMap<CompanyId, Company>,
): string {
  const ranked = [...deals].sort((a, b) => b.score - a.score);
  const lines: string[] = [];
  ranked.forEach((deal, index) => {
    const company = companiesById.get(deal.companyId);
    const name = company?.canonicalName ?? deal.companyId;
    const flagsSuffix = deal.flags.length > 0 ? ` [${deal.flags.join(', ')}]` : '';
    lines.push(`${index + 1}. ${name} — score ${deal.score.toFixed(1)}${flagsSuffix}`);
    lines.push(`   ${deal.rationale}`);
  });
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Composition — builds a real SourceAdapter for one source name. No `new`
// on a concrete class happens outside this function and `main()` (the
// composition root for this entrypoint); src/pipeline/run.ts itself never
// instantiates a concrete adapter/repository/provider.
// ---------------------------------------------------------------------------

function buildSourceAdapter(name: SourceName, config: Config): SourceAdapter {
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

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const config = loadConfig();

  if (config.LLM_PROVIDER === 'ollama') {
    // OllamaLlmProvider is explicitly out of scope (providers/llm/rules.ts's
    // own header comment) — fail fast with a clear message rather than a
    // downstream crash from a provider factory that doesn't exist.
    throw new Error(
      'LLM_PROVIDER=ollama is not implemented yet. Unset it (or set it to "rules") to use the default RulesLlmProvider.',
    );
  }

  const thesisText = await readFile(resolve(process.cwd(), options.thesisPath), 'utf-8');
  const thesis = parseThesis(thesisText);

  const { db, client } = createDatabase(config);
  try {
    const embeddings =
      config.EMBEDDING_PROVIDER === 'local'
        ? createLocalEmbeddingProvider()
        : createDeterministicEmbeddingProvider();

    const deps: RunPipelineDeps = {
      companies: createPostgresCompanyRepository(db),
      sourceRecords: createPostgresSourceRecordRepository(db),
      runs: createPostgresRunRepository(db),
      scoredDeals: createPostgresScoredDealRepository(db),
      sources: options.sources.map((name) => buildSourceAdapter(name, config)),
      embeddings,
      llm: createRulesLlmProvider(),
    };

    const runId = crypto.randomUUID() as RunId;
    console.log(
      `Starting run ${runId} — thesis "${thesis.name}" — sources: ${options.sources.join(', ')} — embeddings: ${embeddings.id}`,
    );
    if (embeddings.id === 'local-minilm') {
      console.log(
        '(LocalEmbeddingProvider downloads the model on first run, then works offline.)',
      );
    }

    const result = await runPipeline(deps, { runId, thesis, limitPerSource: options.limit });

    console.log('');
    console.log(`Run ${result.runId} finished — status: ${result.status}`);
    if (result.stats.failedSources.length > 0) {
      console.log(`Failed sources: ${result.stats.failedSources.join(', ')}`);
    }
    console.log('');

    if (result.deals.length === 0) {
      console.log('No scored deals produced.');
      return;
    }

    const companiesById = new Map(result.companies.map((c) => [c.id, c] as const));
    console.log(formatRankedDeals(result.deals, companiesById));
  } finally {
    await closeDatabase(client);
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
