// Validation + error-shape coverage for src/api/routes.ts using hand-built
// fake ApiDeps and Hono's own `app.request()` testing utility — no real
// listening socket, no real Postgres (spec: "Todo query param validado con
// Zod... Errores con un shape consistente"). Full happy-path coverage
// against real Postgres lives in tests/integration/api-routes.test.ts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Run, RunId } from '../../src/domain/entities.js';
import type { ApiDeps } from '../../src/api/routes.js';
import { createApp } from '../../src/api/routes.js';
import type { DealReadModel, RunRepository } from '../../src/domain/ports.js';

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: crypto.randomUUID() as RunId,
    thesisName: 'fixture-thesis',
    status: 'completed',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeFakeRunRepository(overrides: Partial<RunRepository> = {}): RunRepository {
  return {
    start: vi.fn(async () => {}),
    watermark: vi.fn(async () => undefined),
    setWatermark: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
    get: vi.fn(async () => undefined),
    findLatestWithDeals: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeFakeDealReadModel(overrides: Partial<DealReadModel> = {}): DealReadModel {
  return {
    listDeals: vi.fn(async () => ({ items: [] })),
    getDeal: vi.fn(async () => undefined),
    getCompanyProvenance: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeApp(overrides: Partial<ApiDeps> = {}) {
  const deps: ApiDeps = {
    runs: makeFakeRunRepository(),
    dealReadModel: makeFakeDealReadModel(),
    pingDb: vi.fn(async () => {}),
    triggerRun: vi.fn(async () => crypto.randomUUID() as RunId),
    ...overrides,
  };
  return { app: createApp(deps), deps };
}

async function expectApiError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
}

describe('GET /health', () => {
  it('returns 200 { status: "ok" } when pingDb resolves', async () => {
    const { app } = makeApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns a 500 INTERNAL_ERROR with the consistent shape when pingDb rejects', async () => {
    const { app } = makeApp({
      pingDb: vi.fn(async () => {
        throw new Error('connection refused');
      }),
    });
    const res = await app.request('/health');
    await expectApiError(res, 500, 'INTERNAL_ERROR');
  });
});

describe('GET /deals', () => {
  it('rejects a non-numeric minScore with a 400 and the consistent error shape', async () => {
    const { app } = makeApp();
    const res = await app.request('/deals?minScore=notanumber');
    await expectApiError(res, 400, 'VALIDATION_ERROR');
  });

  it('rejects a garbage cursor with a 400', async () => {
    const { app, deps } = makeApp({
      runs: makeFakeRunRepository({
        findLatestWithDeals: vi.fn(async () => makeRun()),
      }),
    });
    const res = await app.request('/deals?cursor=%21%21%21not-valid%21%21%21');
    await expectApiError(res, 400, 'VALIDATION_ERROR');
    expect(deps.dealReadModel.listDeals).not.toHaveBeenCalled();
  });

  it('returns an empty list with 200 (not an error) when no run has ever completed', async () => {
    const { app } = makeApp();
    const res = await app.request('/deals');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ runId: null, items: [], cursor: null });
  });

  it('passes parsed filters through to dealReadModel.listDeals', async () => {
    const runId = crypto.randomUUID() as RunId;
    const listDeals = vi.fn(async () => ({ items: [] }));
    const { app } = makeApp({
      runs: makeFakeRunRepository({
        findLatestWithDeals: vi.fn(async () => makeRun({ id: runId })),
      }),
      dealReadModel: makeFakeDealReadModel({ listDeals }),
    });

    await app.request('/deals?minScore=40&sector=devtools&stage=seed&limit=5');

    expect(listDeals).toHaveBeenCalledWith({
      runId,
      limit: 5,
      minScore: 40,
      sector: 'devtools',
      stage: 'seed',
    });
  });
});

describe('GET /deals/:id', () => {
  it('rejects a non-UUID id with a 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/deals/not-a-uuid');
    await expectApiError(res, 400, 'VALIDATION_ERROR');
  });

  it('returns 404 when no run has ever completed', async () => {
    const { app } = makeApp();
    const res = await app.request(`/deals/${crypto.randomUUID()}`);
    await expectApiError(res, 404, 'NOT_FOUND');
  });

  it('returns 404 when the company has no deal in the latest run', async () => {
    const { app } = makeApp({
      runs: makeFakeRunRepository({
        findLatestWithDeals: vi.fn(async () => makeRun()),
      }),
      dealReadModel: makeFakeDealReadModel({ getDeal: vi.fn(async () => undefined) }),
    });
    const res = await app.request(`/deals/${crypto.randomUUID()}`);
    await expectApiError(res, 404, 'NOT_FOUND');
  });
});

describe('GET /companies/:id/provenance', () => {
  it('rejects a non-UUID id with a 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/companies/not-a-uuid/provenance');
    await expectApiError(res, 400, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown company', async () => {
    const { app } = makeApp();
    const res = await app.request(`/companies/${crypto.randomUUID()}/provenance`);
    await expectApiError(res, 404, 'NOT_FOUND');
  });
});

describe('POST /runs', () => {
  it('rejects a negative limitPerSource with a 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limitPerSource: -1 }),
    });
    await expectApiError(res, 400, 'VALIDATION_ERROR');
  });

  it('returns 202 with the runId that triggerRun resolves, for an empty body', async () => {
    // This unit test proves the RESPONSE SHAPE (202 + the exact runId
    // triggerRun produced) using a fake triggerRun that resolves as soon as
    // it's called — matching what server.ts's real triggerRun does (it only
    // awaits thesis load/parse, never the pipeline run itself). The actual
    // "doesn't block on the background run" TIMING claim is proven against
    // a real, slow pipeline in tests/integration/api-routes.test.ts, where
    // there's a genuine multi-second run to race the response against.
    const runId = crypto.randomUUID() as RunId;
    const triggerRun = vi.fn(async () => runId);
    const { app } = makeApp({ triggerRun });

    const res = await app.request('/runs', { method: 'POST' });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId });
    expect(triggerRun).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit thesisPath and limitPerSource, forwarding them to triggerRun', async () => {
    const triggerRun = vi.fn(async () => crypto.randomUUID() as RunId);
    const { app } = makeApp({ triggerRun });

    await app.request('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ thesisPath: 'custom-thesis.yaml', limitPerSource: '15' }),
    });

    expect(triggerRun).toHaveBeenCalledWith({ thesisPath: 'custom-thesis.yaml', limitPerSource: 15 });
  });
});

describe('GET /runs/:id', () => {
  it('rejects a non-UUID id with a 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/runs/not-a-uuid');
    await expectApiError(res, 400, 'VALIDATION_ERROR');
  });

  it('returns 404 for an unknown run', async () => {
    const { app } = makeApp();
    const res = await app.request(`/runs/${crypto.randomUUID()}`);
    await expectApiError(res, 404, 'NOT_FOUND');
  });

  it('returns the run when found', async () => {
    const run: Run = {
      id: crypto.randomUUID() as RunId,
      thesisName: 'thesis',
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    const { app } = makeApp({
      runs: makeFakeRunRepository({ get: vi.fn(async () => run) }),
    });
    const res = await app.request(`/runs/${run.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(run);
  });
});

describe('GET /ui', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('redirects /ui to /ui/', async () => {
    const { app } = makeApp();
    const res = await app.request('/ui', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ui/');
  });

  it('serves the static index.html at /ui/ from the configured uiRoot', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'deal-signal-ui-test-'));
    writeFileSync(join(tempDir, 'index.html'), '<!doctype html><title>Fixture UI</title>');
    const { app } = makeApp({ uiRoot: tempDir });

    const res = await app.request('/ui/');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Fixture UI');
  });
});

