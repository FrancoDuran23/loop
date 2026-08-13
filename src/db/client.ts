// Postgres connection factory (postgres.js + drizzle). Infrastructure
// layer — src/db/** sits OUTSIDE the ESLint core-layer boundary
// (eslint.config.js CORE_LAYER_GLOBS), so importing `postgres` and
// `drizzle-orm/postgres-js` here is exactly where they belong (design.md
// D1). Core layers (domain/, resolution/, enrichment/, scoring/) never
// import this module directly — they depend on the port interfaces in
// domain/ports.ts; only the composition root (src/runtime.ts, later phase)
// and this db/ layer know Postgres exists.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Config } from '../config.js';
import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Creates a new postgres.js connection pool + drizzle instance bound to
 * `config.DATABASE_URL`. One factory call per process (or per test file) —
 * callers are responsible for calling `closeDatabase` on the returned raw
 * `sql` tagged-template client when done (tests, short-lived scripts like
 * `db:migrate`).
 */
export function createDatabase(config: Pick<Config, 'DATABASE_URL'>): {
  readonly db: Database;
  readonly client: postgres.Sql;
} {
  const client = postgres(config.DATABASE_URL, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, client };
}

/** Closes the underlying connection pool. Safe to call once per client. */
export async function closeDatabase(client: postgres.Sql): Promise<void> {
  await client.end({ timeout: 5 });
}
