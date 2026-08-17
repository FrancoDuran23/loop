// Hono route definitions (spec §10 verbatim endpoint list). Pure app
// FACTORY — createApp(deps) takes its dependencies as a parameter object
// (same composition-root discipline as pipeline/run.ts's RunPipelineDeps),
// so tests can exercise every route via Hono's own `app.request()` testing
// utility (no real listening socket needed) against either real Postgres
// deps (tests/integration/api-routes.test.ts) or hand-built fake deps
// (tests/api/routes-validation.test.ts, for the query-validation-only
// cases that don't need a database at all). src/api/server.ts is the ONLY
// place a real Hono `serve()` listener is created.

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { CompanyId, RunId } from '../domain/entities.js';
import type { DealListItem, DealReadModel, RunRepository } from '../domain/ports.js';
import { decodeDealCursor, encodeDealCursor } from './cursor.js';
import { ApiError, internalError, notFound, toApiErrorBody, validationError } from './errors.js';
import { dealsQuerySchema, postRunsBodySchema, uuidParamSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// Dependencies — everything a route handler needs, injected. `triggerRun`
// encapsulates thesis loading + real pipeline composition + the
// fire-and-forget dispatch itself (src/api/server.ts builds the real
// closure via src/runtime.ts; tests inject a fake).
// ---------------------------------------------------------------------------

export interface TriggerRunOptions {
  readonly thesisPath?: string;
  readonly limitPerSource?: number;
}

export interface ApiDeps {
  readonly runs: RunRepository;
  readonly dealReadModel: DealReadModel;
  /** Cheap liveness check for GET /health — resolves on success, rejects on
   * failure (e.g. a real `SELECT 1` against Postgres). */
  readonly pingDb: () => Promise<void>;
  /**
   * Loads + validates the thesis, generates a RunId, and starts
   * `runPipeline(...)` WITHOUT awaiting its completion (spec: "dispara una
   * corrida" — 202 + runId, run continues in the background). The returned
   * promise resolves as soon as the thesis is loaded/validated and the
   * background run has been DISPATCHED — not when the run finishes. Thesis
   * load/parse failures (bad path, invalid YAML/schema) reject this promise
   * and surface as a synchronous 4xx/5xx to the caller — see server.ts's
   * implementation for the full rationale on why that part IS awaited.
   */
  readonly triggerRun: (options: TriggerRunOptions) => Promise<RunId>;
  /** Static UI root directory (relative to process.cwd()), passed through
   * so tests can point at a fixture directory if ever needed. Defaults to
   * './src/ui' in server.ts. */
  readonly uiRoot?: string;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function parseUuidParam(raw: string | undefined, paramName: string): string {
  const result = uuidParamSchema.safeParse(raw);
  if (!result.success) {
    throw validationError(`${paramName} must be a valid UUID, got "${String(raw)}"`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// JSON response shaping — flattens deal + company projection into one
// UI-table-friendly row.
// ---------------------------------------------------------------------------

function dealListItemToJson(item: DealListItem) {
  return {
    companyId: item.company.id,
    canonicalName: item.company.canonicalName,
    ...(item.company.domain ? { domain: item.company.domain } : {}),
    ...(item.company.sector ? { sector: item.company.sector } : {}),
    ...(item.company.estimatedStage ? { estimatedStage: item.company.estimatedStage } : {}),
    score: item.deal.score,
    breakdown: item.deal.breakdown,
    rationale: item.deal.rationale,
    flags: item.deal.flags,
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

export function createApp(deps: ApiDeps): Hono {
  const app = new Hono();

  // Central error handler (spec: consistent { error: { code, message } }
  // shape) — the ONLY place route errors are mapped to a response. Route
  // handlers throw ApiError (or let Zod .parse()/decodeDealCursor's own
  // ApiError propagate) rather than each building its own error response.
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(toApiErrorBody(err), err.status as 400 | 404 | 500);
    }
    console.error('Unhandled API error:', err);
    return c.json(toApiErrorBody(internalError('Internal server error')), 500);
  });

  app.get('/health', async (c) => {
    try {
      await deps.pingDb();
    } catch (err) {
      throw internalError(`Database unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    return c.json({ status: 'ok' });
  });

  app.get('/deals', async (c) => {
    const parsed = dealsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      throw validationError(`Invalid query: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const { minScore, sector, stage, limit, cursor } = parsed.data;

    // Design decision #1 (see brief): "latest run" is the most recently
    // FINISHED run with status completed/partial. No such run yet -> an
    // empty list with 200, NOT an error (a fresh database is a valid,
    // expected state, not a failure).
    const latestRun = await deps.runs.findLatestWithDeals();
    if (!latestRun) {
      return c.json({ runId: null, items: [], cursor: null });
    }

    const decodedCursor = cursor ? decodeDealCursor(cursor) : undefined;
    const page = await deps.dealReadModel.listDeals({
      runId: latestRun.id,
      limit,
      ...(minScore !== undefined ? { minScore } : {}),
      ...(sector !== undefined ? { sector } : {}),
      ...(stage !== undefined ? { stage } : {}),
      ...(decodedCursor ? { cursor: decodedCursor } : {}),
    });

    return c.json({
      runId: latestRun.id,
      items: page.items.map(dealListItemToJson),
      cursor: page.nextCursor ? encodeDealCursor(page.nextCursor) : null,
    });
  });

  app.get('/deals/:id', async (c) => {
    const companyId = parseUuidParam(c.req.param('id'), 'id') as CompanyId;

    const latestRun = await deps.runs.findLatestWithDeals();
    if (!latestRun) {
      throw notFound(`No completed run yet — company ${companyId} has no deal.`);
    }

    const detail = await deps.dealReadModel.getDeal(latestRun.id, companyId);
    if (!detail) {
      throw notFound(`Company ${companyId} has no deal in the latest run (${latestRun.id}).`);
    }

    return c.json({
      runId: latestRun.id,
      company: detail.company,
      deal: {
        score: detail.deal.score,
        breakdown: detail.deal.breakdown,
        rationale: detail.deal.rationale,
        flags: detail.deal.flags,
      },
      // Signals already carry evidenceUrl (entities.ts Signal.evidenceUrl)
      // — the spec's own "evidencia" for a deal detail.
      signals: detail.company.signals,
      sourceRecords: detail.sourceRecords,
    });
  });

  app.get('/companies/:id/provenance', async (c) => {
    const companyId = parseUuidParam(c.req.param('id'), 'id') as CompanyId;

    const provenance = await deps.dealReadModel.getCompanyProvenance(companyId);
    if (!provenance) {
      throw notFound(`Company ${companyId} not found.`);
    }
    return c.json(provenance);
  });

  app.post('/runs', async (c) => {
    const rawBody: unknown = await c.req.json().catch(() => ({}));
    const parsed = postRunsBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      throw validationError(`Invalid body: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }

    const runId = await deps.triggerRun({
      ...(parsed.data.thesisPath !== undefined ? { thesisPath: parsed.data.thesisPath } : {}),
      ...(parsed.data.limitPerSource !== undefined
        ? { limitPerSource: parsed.data.limitPerSource }
        : {}),
    });
    return c.json({ runId }, 202);
  });

  app.get('/runs/:id', async (c) => {
    const runId = parseUuidParam(c.req.param('id'), 'id') as RunId;

    const run = await deps.runs.get(runId);
    if (!run) {
      throw notFound(`Run ${runId} not found.`);
    }
    return c.json(run);
  });

  // Static UI (spec §10: "una página HTML estática servida desde /ui" — no
  // build step, no framework). rewriteRequestPath strips the /ui mount
  // prefix so `/ui/` (and `/ui/anything`) resolves relative to uiRoot's own
  // directory listing, matching how @hono/node-server's serveStatic joins
  // root + the (rewritten) request path (verified by reading
  // node_modules/@hono/node-server/dist/serve-static.mjs directly, not
  // guessed). GET /ui (no trailing slash) redirects to /ui/ so the relative
  // asset paths inside index.html resolve correctly.
  const uiRoot = deps.uiRoot ?? './src/ui';
  app.get('/ui', (c) => c.redirect('/ui/', 302));
  app.use(
    '/ui/*',
    serveStatic({
      root: uiRoot,
      rewriteRequestPath: (path) => path.replace(/^\/ui/, ''),
    }),
  );

  return app;
}
