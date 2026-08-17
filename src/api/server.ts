// HTTP entrypoint (spec §10). Wires the real composition (src/runtime.ts)
// into src/api/routes.ts's pure app factory, then serves it via
// @hono/node-server (this project runs on Node, not an edge runtime — see
// package.json's engines field). Same `isMainModule` pattern src/cli.ts
// already uses, so this file is BOTH importable for tests
// (createServerApp) and runnable directly (`npm run serve`).

import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import type { Hono } from 'hono';
import type { RunId } from '../domain/entities.js';
import { parseThesis } from '../domain/thesis.js';
import { loadConfig } from '../config.js';
import { runPipeline, type RunPipelineDeps } from '../pipeline/run.js';
import { createRuntime, type Runtime } from '../runtime.js';
import { createApp, type ApiDeps, type TriggerRunOptions } from './routes.js';

const DEFAULT_THESIS_PATH = 'thesis.example.yaml';

/**
 * Builds the `triggerRun` closure `POST /runs` calls (routes.ts's own doc
 * comment on `ApiDeps.triggerRun` explains the awaited-vs-fire-and-forget
 * split in detail). Thesis load + parse IS awaited here — it's fast (a
 * local YAML file) and lets a misconfigured thesis surface as a synchronous
 * 4xx/5xx instead of a runId that would deterministically fail moments
 * later in the background with no way for the caller to have known ahead
 * of time. `runPipeline` itself is explicitly NOT awaited (spec: "el run
 * MUST execute without blocking the HTTP response") — errors from it are
 * caught via `.catch` and logged, never left as an unhandled rejection
 * that could crash the process.
 */
function createTriggerRun(runtime: Runtime, logger: Logger) {
  return async function triggerRun(options: TriggerRunOptions): Promise<RunId> {
    const thesisPath = options.thesisPath ?? DEFAULT_THESIS_PATH;
    const thesisText = await readFile(resolve(process.cwd(), thesisPath), 'utf-8');
    const thesis = parseThesis(thesisText);

    const runId = runtime.newRunId();
    const deps: RunPipelineDeps = {
      companies: runtime.companies,
      sourceRecords: runtime.sourceRecords,
      runs: runtime.runs,
      scoredDeals: runtime.scoredDeals,
      sources: runtime.buildSourceAdapters(),
      embeddings: runtime.embeddings,
      llm: runtime.llm,
      logger,
    };

    void runPipeline(deps, {
      runId,
      thesis,
      ...(options.limitPerSource !== undefined ? { limitPerSource: options.limitPerSource } : {}),
    }).catch((err: unknown) => {
      logger.error(
        { runId, err: err instanceof Error ? err.message : String(err) },
        'POST /runs: background pipeline run failed',
      );
    });

    return runId;
  };
}

/** Builds the real Hono app: real Postgres-backed ApiDeps over the given
 * Runtime. Exported (not just used inline below) so integration tests can
 * exercise the REAL composition via `app.request()` without a listening
 * socket, the same Hono testing pattern routes-validation.test.ts uses
 * against fakes. */
export function createServerApp(runtime: Runtime, logger: Logger = pino({ name: 'api' })): Hono {
  const deps: ApiDeps = {
    runs: runtime.runs,
    dealReadModel: runtime.dealReadModel,
    pingDb: async () => {
      await runtime.db.execute(sql`SELECT 1`);
    },
    triggerRun: createTriggerRun(runtime, logger),
  };
  return createApp(deps);
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  const config = loadConfig();
  const logger = pino({ name: 'api', level: config.LOG_LEVEL });
  const runtime = createRuntime(config);
  const app = createServerApp(runtime, logger);

  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
    logger.info({ port: info.port }, `API server listening on http://localhost:${info.port}`);
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      runtime
        .close()
        .catch((err: unknown) => logger.error({ err }, 'error closing database connection'))
        .finally(() => process.exit(0));
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
