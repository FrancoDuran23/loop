import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Phase 5: tests/integration/*.test.ts files share ONE real Postgres
    // instance (no per-file schema/transaction isolation) and each calls
    // truncateAllTables() in afterEach. Vitest's default file parallelism
    // runs test FILES concurrently in separate workers, so two integration
    // files running at once could truncate tables mid-assertion in another
    // file — found by running the full suite (isolated file runs passed,
    // the combined run didn't). Serial file execution is the correct fix
    // for tests sharing a real external resource; this project's suite is
    // small enough (~11 files) that the runtime cost is negligible.
    fileParallelism: false,
  },
});
