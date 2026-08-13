// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

// Core layers per design.md D1: domain/, resolution/, enrichment/, scoring/
// MUST NOT import infrastructure. This is machine-checked, not a convention.
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
    group: ['fs', 'node:fs', 'node:fs/*', 'fs/*'],
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
];

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
      'no-restricted-imports': ['error', { patterns: BANNED_INFRA_IMPORT_GROUPS }],
    },
  },
  prettierConfig,
);
