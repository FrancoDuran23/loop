// Applies committed SQL migrations (drizzle/) to DATABASE_URL. Invoked via
// `npm run db:migrate` (tsx src/db/migrate.ts). Deliberately a plain
// postgres.js + drizzle-orm/postgres-js migrator script rather than the
// `drizzle-kit migrate` CLI subcommand: this keeps migration application
// using the exact same driver (postgres.js) as the app's own runtime
// connection, with no separate CLI-internal connection/config resolution
// to keep in sync.

import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { loadConfig } from '../config.js';
import { closeDatabase, createDatabase } from './client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, client } = createDatabase(config);
  try {
    await migrate(db, { migrationsFolder: './drizzle' });
    console.log('Migrations applied successfully.');
  } finally {
    await closeDatabase(client);
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exitCode = 1;
});
