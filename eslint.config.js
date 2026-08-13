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

const BANNED_INFRA_IMPORTS = [
  { name: 'postgres', message: 'Core layers must not import infrastructure. See design.md D1.' },
  { name: 'drizzle-orm', message: 'Core layers must not import infrastructure. See design.md D1.' },
  {
    name: '@huggingface/transformers',
    message: 'Core layers must not import infrastructure. See design.md D1.',
  },
  { name: 'hono', message: 'Core layers must not import infrastructure. See design.md D1.' },
  { name: 'fs', message: 'Core layers must not import infrastructure. See design.md D1.' },
  { name: 'node:fs', message: 'Core layers must not import infrastructure. See design.md D1.' },
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
      'no-restricted-imports': ['error', { paths: BANNED_INFRA_IMPORTS }],
    },
  },
  prettierConfig,
);
