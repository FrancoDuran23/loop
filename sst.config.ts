// sst.config.ts — INFRASTRUCTURE SKETCH, NOT APPLIED, NOT DEPLOYED
//
// This file shows the INTENDED shape of a real AWS deployment for Deal
// Signal Engine. It is deliberately NOT wired up to run: `sst` is not a
// project dependency (see package.json — it is not listed, on purpose), this
// file is outside every tsconfig's `include` (tsconfig.json / .build.json
// both scope to src/tests/scripts only), and the two Lambda handler paths it
// references (`src/api/lambda.ts`, `src/pipeline/lambda.ts`) do not exist
// yet. `npm run typecheck` / `lint` / `test` / `build` never touch this
// file, and nobody has ever run `sst deploy` against it — that is
// intentional, matching the project brief's own instruction to show the
// design of an AWS deployment without incurring AWS cost or claiming a
// tested one.
//
// Written against SST v3 ("ion") syntax from memory/documentation, not
// verified against a real `sst dev`/`sst deploy` run — treat every resource
// name, prop, and default below as a first draft for a human (or a follow-up
// phase) to actually stand up and correct against the real SST CLI/docs,
// not as a working deployment.
//
// Why these 3 pieces, and why they map cleanly onto what already exists:
//   1. Hono API on Lambda   — Hono ships a first-class `hono/aws-lambda`
//      adapter specifically because Hono's router has no Node-server
//      coupling (see src/api/routes.ts's `createApp(deps): Hono` factory,
//      already framework-agnostic — src/api/server.ts is the ONLY place a
//      real `@hono/node-server` listener is created today). Swapping the
//      entrypoint for Lambda needs one new thin file
//      (`src/api/lambda.ts`, NOT created in this phase) that imports
//      `createApp` + `handle` from `hono/aws-lambda` — zero changes to
//      routes.ts itself.
//   2. RDS/Aurora Postgres + pgvector — same schema already committed under
//      drizzle/, no migration changes needed; see the engine-version caveat
//      below.
//   3. EventBridge-scheduled pipeline run — mirrors `POST /runs`'s existing
//      fire-and-dispatch shape (src/api/routes.ts, src/api/server.ts's
//      `createTriggerRun`): load a thesis, call `runPipeline` with the real
//      Postgres-backed `Runtime` from src/runtime.ts. A scheduled Lambda is
//      the natural serverless analogue of "someone calls POST /runs on a
//      timer" — same composition root, different trigger.
//
// What is explicitly OUT of scope for this sketch (see README "Roadmap"):
// a real Next.js frontend, auth/multi-tenancy, a production job queue for
// the pipeline (a single Lambda invocation is fine at this project's scale,
// not at 100x — see README "Scale"), and CI/CD wiring to actually run
// `sst deploy`.

// This is SST's own required convention (a real `sst init` scaffolds
// exactly this line); the referenced file does not exist because `sst init`
// was never run, so this reference resolves to nothing today, harmlessly.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: 'deal-signal-engine',
      // "remove" on every stage except production: this is a portfolio/demo
      // project, not a service with real users — nothing here should
      // survive `sst remove` by default, including whatever stage a
      // reviewer might spin up to poke at this file.
      removal: input?.stage === 'production' ? 'retain' : 'remove',
      home: 'aws',
    };
  },

  async run() {
    // -------------------------------------------------------------------
    // Network — Lambda needs VPC access to reach RDS/Aurora on a private
    // subnet (Postgres is never exposed to the public internet in this
    // sketch, unlike docker-compose.yml's local `0.0.0.0:5432` convenience
    // binding, which only makes sense on a laptop).
    // -------------------------------------------------------------------
    const vpc = new sst.aws.Vpc('DealSignalVpc');

    // -------------------------------------------------------------------
    // Database — Aurora Postgres (Serverless v2) via SST's `sst.aws.Postgres`
    // construct, chosen over a fixed-size RDS instance so an idle demo
    // deployment scales to near-zero capacity instead of paying for a
    // constantly-running instance.
    //
    // pgvector caveat (spec's own explicit ask — do not overclaim this):
    // pgvector is available on Aurora PostgreSQL and RDS PostgreSQL, but
    // only from specific engine versions onward (Aurora PostgreSQL 15.3+,
    // RDS PostgreSQL 15.2+, with earlier 13.x/14.x minor versions also
    // gaining support later) — this sketch does NOT pin an exact engine
    // version, and `CREATE EXTENSION IF NOT EXISTS vector;` (already the
    // first line of the committed drizzle/ migration, docker-compose.yml's
    // pgvector/pgvector:pg16 image bakes it in locally) would need to be
    // re-verified against whatever engine version SST/Aurora provisions by
    // default at deploy time — a real deploy is the only way to confirm
    // this, which is exactly what this phase does not do.
    const db = new sst.aws.Postgres('DealSignalDb', {
      vpc,
    });

    // -------------------------------------------------------------------
    // API — the existing Hono app (src/api/routes.ts's createApp) behind a
    // Lambda Function URL. `handler` points at a file that does not exist
    // yet: a ~10-line shim wrapping createApp(realDeps) with
    // `handle()` from `hono/aws-lambda`, following the exact same
    // dependency-injection shape src/api/server.ts already uses for the
    // Node entrypoint — creating that file is future work, not part of
    // this phase.
    const api = new sst.aws.Function('DealSignalApi', {
      handler: 'src/api/lambda.handler',
      url: true,
      vpc,
      link: [db],
      // Real deploy would also need: DATABASE_URL sourced from `db`'s
      // linked connection info (SST's `Resource` binding), LOG_LEVEL, and
      // whichever LLM_PROVIDER/EMBEDDING_PROVIDER the deployed environment
      // should default to — none of that is wired here, same "sketch, not
      // a working deploy" caveat as the rest of this file.
      timeout: '30 seconds',
    });

    // -------------------------------------------------------------------
    // Scheduled pipeline run — the serverless analogue of POST /runs,
    // triggered by EventBridge instead of an HTTP call. `handler` again
    // points at a not-yet-created shim (`src/pipeline/lambda.ts`) that
    // would call `createRuntime(loadConfig())` (src/runtime.ts) +
    // `runPipeline(...)` (src/pipeline/run.ts) directly — the SAME
    // composition root cli.ts and api/server.ts already share, per
    // design.md's own D6 decision. A daily cadence is a placeholder, not a
    // researched cadence for this domain.
    new sst.aws.Cron('DealSignalPipelineCron', {
      schedule: 'rate(1 day)',
      job: {
        handler: 'src/pipeline/lambda.handler',
        vpc,
        link: [db],
        // The real pipeline run against 3 live sources + a local embedding
        // model took low single-digit seconds to a few minutes in this
        // phase's own manual verification (see README "Demo") — 30s is
        // almost certainly too short for a cold Lambda downloading the
        // ~90MB MiniLM model on its first invocation; a real deploy would
        // need to either raise this substantially or bake the model into
        // the deployment package/layer ahead of time. Flagged, not solved,
        // here.
        timeout: '5 minutes',
      },
    });

    return {
      api: api.url,
      database: db.host,
    };
  },
});
