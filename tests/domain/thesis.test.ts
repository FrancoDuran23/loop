import { describe, expect, it } from 'vitest';
import { parseThesis, ThesisValidationError } from '../../src/domain/thesis.js';

const VALID_THESIS_YAML = `
name: "Dev tools B2B, etapa temprana"
description: >
  Invertimos en herramientas para desarrolladores con modelo B2B o
  open-source-first, entre pre-seed y Serie A.
hard_filters:
  stages: [seed, series-a]
  exclude_sectors: [gambling]
soft_preferences:
  sectors: [devtools, fintech]
  geos: [latam, us]
  keywords: [open-source, api-first]
anti_patterns:
  - "no code in public repo"
weights:
  semantic: 0.4
  momentum: 0.3
  keywords: 0.2
  recency: 0.1
`;

describe('parseThesis', () => {
  it('parses a valid thesis YAML into a typed Thesis object', () => {
    const thesis = parseThesis(VALID_THESIS_YAML);

    expect(thesis.name).toBe('Dev tools B2B, etapa temprana');
    expect(thesis.description).toContain('open-source-first');
    expect(thesis.hard_filters.stages).toEqual(['seed', 'series-a']);
    expect(thesis.hard_filters.exclude_sectors).toEqual(['gambling']);
    expect(thesis.soft_preferences.keywords).toEqual(['open-source', 'api-first']);
    expect(thesis.weights.semantic).toBe(0.4);
  });

  it('throws ThesisValidationError when name is missing', () => {
    const missingName = VALID_THESIS_YAML.replace(
      'name: "Dev tools B2B, etapa temprana"\n',
      '',
    );

    expect(() => parseThesis(missingName)).toThrow(ThesisValidationError);
  });

  it('throws ThesisValidationError on an unrecognized top-level key', () => {
    const extraKey = `${VALID_THESIS_YAML}\nunexpected_field: "should be rejected"\n`;

    expect(() => parseThesis(extraKey)).toThrow(ThesisValidationError);
  });

  it('throws ThesisValidationError on malformed YAML syntax', () => {
    const malformed = 'hard_filters: [this is not: valid: yaml';

    expect(() => parseThesis(malformed)).toThrow(ThesisValidationError);
  });

  it('throws ThesisValidationError when weights is missing entirely', () => {
    const missingWeights = `
hard_filters:
  stages: [seed]
  exclude_sectors: []
soft_preferences:
  sectors: []
  geos: []
  keywords: []
anti_patterns: []
`;

    expect(() => parseThesis(missingWeights)).toThrow(ThesisValidationError);
  });

  it('throws ThesisValidationError when a weight is the wrong type', () => {
    const wrongType = VALID_THESIS_YAML.replace('semantic: 0.4', 'semantic: "high"');

    expect(() => parseThesis(wrongType)).toThrow(ThesisValidationError);
  });

  it('throws ThesisValidationError when weights do not sum to 1', () => {
    const badSum = VALID_THESIS_YAML.replace('semantic: 0.4', 'semantic: 0.9');

    expect(() => parseThesis(badSum)).toThrow(ThesisValidationError);
  });

  it('throws ThesisValidationError when hard_filters.stages has an unrecognized stage', () => {
    const badStage = VALID_THESIS_YAML.replace('stages: [seed, series-a]', 'stages: [banana]');

    expect(() => parseThesis(badStage)).toThrow(ThesisValidationError);
  });
});
