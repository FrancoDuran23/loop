import { defineConfig } from 'drizzle-kit';

// drizzle-kit CLI config (generate/migrate). Root-level by drizzle-kit
// convention, outside src/ — not part of the app's own typecheck target
// (same convention as vitest.config.ts / eslint.config.js).
//
// Falls back to the same default as src/config.ts's DATABASE_URL so
// `npm run db:generate` / `npm run db:migrate` work with zero env vars set,
// matching the docker-compose.yml Postgres service (spec §18 zero-config
// bootstrap).
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/deal_signal_engine',
  },
});
