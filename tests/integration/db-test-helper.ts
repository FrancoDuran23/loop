// Shared setup for tests/integration/*.test.ts — a single real Postgres
// connection (DATABASE_URL, defaulting to the docker-compose.yml service),
// migrations applied once per test run, and a truncate helper for
// per-test isolation. No testcontainers (spec §14's explicit instruction):
// locally this expects `docker compose up -d` already run; in CI it's a
// GitHub Actions service container on localhost (.github/workflows/ci.yml).

import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type postgres from 'postgres';
import { loadConfig } from '../../src/config.js';
import { closeDatabase, createDatabase, type Database } from '../../src/db/client.js';

let migrationsApplied = false;

export async function setupTestDatabase(): Promise<{
  readonly db: Database;
  readonly client: postgres.Sql;
}> {
  const config = loadConfig();
  const { db, client } = createDatabase(config);
  if (!migrationsApplied) {
    // Idempotent: drizzle-orm tracks applied migrations in its own
    // __drizzle_migrations table and skips ones already applied — safe to
    // call even when CI (or a developer) already ran `npm run db:migrate`
    // as a separate step.
    await migrate(db, { migrationsFolder: './drizzle' });
    migrationsApplied = true;
  }
  return { db, client };
}

export { closeDatabase };

/** Clears every table for test isolation between it()s. */
export async function truncateAllTables(db: Database): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE scored_deals, signals, company_members, source_watermarks, runs, companies, source_records RESTART IDENTITY CASCADE`,
  );
}
