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
import type { Company, CompanyId, ScoredDeal, SourceName } from './domain/entities.js';
import { parseThesis } from './domain/thesis.js';
import { loadConfig } from './config.js';
import { runPipeline, type RunPipelineDeps } from './pipeline/run.js';
import { ALL_SOURCES, createRuntime } from './runtime.js';

const DEFAULT_LIMIT_PER_SOURCE = 20;
const DEFAULT_THESIS_PATH = 'thesis.example.yaml';

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
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  // createRuntime (src/runtime.ts) fails fast on LLM_PROVIDER=ollama and
  // owns all real composition (Postgres repos, DealReadModel, embeddings,
  // LLM, source-adapter factory) — the SAME graph src/api/server.ts's
  // POST /runs route now builds, extracted here in Phase 9b to avoid two
  // independently-maintained copies of this wiring (see runtime.ts's own
  // header comment for the full rationale).
  const runtime = createRuntime(loadConfig());

  const thesisText = await readFile(resolve(process.cwd(), options.thesisPath), 'utf-8');
  const thesis = parseThesis(thesisText);

  try {
    const deps: RunPipelineDeps = {
      companies: runtime.companies,
      sourceRecords: runtime.sourceRecords,
      runs: runtime.runs,
      scoredDeals: runtime.scoredDeals,
      sources: runtime.buildSourceAdapters(options.sources),
      embeddings: runtime.embeddings,
      llm: runtime.llm,
    };

    const runId = runtime.newRunId();
    console.log(
      `Starting run ${runId} — thesis "${thesis.name}" — sources: ${options.sources.join(', ')} — embeddings: ${runtime.embeddings.id}`,
    );
    if (runtime.embeddings.id === 'local-minilm') {
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
    await runtime.close();
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
