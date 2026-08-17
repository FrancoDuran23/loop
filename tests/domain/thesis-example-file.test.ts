// Spec §18's zero-config bootstrap acceptance criterion depends on a REAL
// `thesis.example.yaml` file at the repo root that actually parses against
// the real Zod schema (thesis.ts) — not just a hand-typed inline fixture
// like tests/domain/thesis.test.ts uses. This test reads the real file off
// disk (repo root, two levels up from tests/domain/) and proves it, so a
// typo in the committed YAML fails CI instead of only being caught manually.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseThesis } from '../../src/domain/thesis.js';

const THESIS_EXAMPLE_PATH = fileURLToPath(
  new URL('../../thesis.example.yaml', import.meta.url),
);

describe('thesis.example.yaml (repo root)', () => {
  it('parses successfully against the real Thesis schema', () => {
    const yamlText = readFileSync(THESIS_EXAMPLE_PATH, 'utf-8');

    const thesis = parseThesis(yamlText);

    expect(thesis.name.length).toBeGreaterThan(0);
    expect(thesis.hard_filters.stages.length).toBeGreaterThan(0);
    expect(thesis.weights.semantic + thesis.weights.momentum + thesis.weights.keywords + thesis.weights.recency).toBeCloseTo(1, 3);
  });

  it('scopes to devtools/infrastructure-flavored sectors and keywords, matching spec §8.2\'s own example', () => {
    const yamlText = readFileSync(THESIS_EXAMPLE_PATH, 'utf-8');

    const thesis = parseThesis(yamlText);

    expect(thesis.soft_preferences.sectors).toEqual(
      expect.arrayContaining(['devtools']),
    );
    expect(thesis.soft_preferences.keywords.length).toBeGreaterThan(0);
    expect(thesis.anti_patterns.length).toBeGreaterThan(0);
  });
});
