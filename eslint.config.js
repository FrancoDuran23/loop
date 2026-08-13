// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

// Core layers per design.md D1: domain/, resolution/, enrichment/, scoring/
// MUST NOT import infrastructure. This is machine-checked, not a convention.
//
// Known limitation: this is a denylist (named packages + all Node builtins),
// not an allowlist. It catches every infra package this project actually
// uses (postgres, drizzle-orm, transformers.js, hono) plus any direct Node
// I/O, but it cannot catch an arbitrary unlisted third-party package (e.g.
// someone importing `pg` instead of the chosen `postgres` driver) — that
// would need `eslint-plugin-boundaries` or dependency-cruiser to allowlist
// per-layer instead. Deferred: this project's infra surface is fixed and
// small (see stack in README), so the realistic risk is low, and adding a
// second lint tool now would be exactly the kind of speculative abstraction
// the project's own conventions argue against.
const CORE_LAYER_GLOBS = [
  'src/domain/**/*.ts',
  'src/resolution/**/*.ts',
  'src/enrichment/**/*.ts',
  'src/scoring/**/*.ts',
];

// `group` uses gitignore-style glob matching, so it catches subpath imports too
// (e.g. `drizzle-orm/pg-core`, `hono/node-server`) — a plain `paths` exact-match
// list would silently miss those, which is how Drizzle/Hono are normally imported.
const BANNED_INFRA_IMPORT_GROUPS = [
  {
    group: ['postgres', 'postgres/*'],
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
  {
    group: ['drizzle-orm', 'drizzle-orm/*'],
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
  {
    group: ['@huggingface/transformers', '@huggingface/transformers/*'],
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
  {
    group: ['hono', 'hono/*'],
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
  {
    // Every Node builtin, not just fs — the core layer has no legitimate
    // reason to touch the filesystem, network, child processes, etc.
    // directly. `node:*` covers the `node:` protocol form; bare specifiers
    // (`fs`, `http`, ...) are covered by `no-restricted-imports`'s built-in
    // `paths` handling below, since Node core modules have no npm package
    // name collision risk.
    group: ['node:*'],
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
];

const BANNED_NODE_BUILTINS = [
  'fs',
  'http',
  'https',
  'net',
  'child_process',
  'dns',
  'worker_threads',
].map((name) => ({
  name,
  message: 'Core layers must not import infrastructure. See design.md D1.',
}));

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
      },
    },
  },
  {
    files: CORE_LAYER_GLOBS,
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: BANNED_NODE_BUILTINS, patterns: BANNED_INFRA_IMPORT_GROUPS },
      ],
    },
  },
  prettierConfig,
);
