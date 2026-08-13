import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { STAGES } from './entities.js';

// ---------------------------------------------------------------------------
// Thesis schema
//
// Shape: hard_filters.{stages, exclude_sectors}, soft_preferences.{sectors,
// geos, keywords}, anti_patterns: string[], weights.{semantic, momentum,
// keywords, recency}.
//
// Weights sum-to-1 is enforced HERE, at parse time, rather than deferred to
// use time (scoring). Rationale: a thesis YAML is operator-edited config,
// not application data; per spec §9's fail-fast philosophy for config
// (mirrored below in config.ts), an invalid weight distribution should
// surface immediately as a clear error when the file is loaded, not as a
// silently-miscalibrated score discovered later by comparing breakdown
// components. Deferring the check to scoring time would still let a run
// complete and produce misleading `score` values (the formula
// `100 * Sum(weight_i * component_i)` degrades gracefully for any set of
// non-negative weights — it doesn't crash — which is exactly why it must be
// rejected earlier, at the boundary where the mistake was made).
// ---------------------------------------------------------------------------

const hardFiltersSchema = z.object({
  stages: z.array(z.enum(STAGES)).min(1),
  exclude_sectors: z.array(z.string()),
});

const softPreferencesSchema = z.object({
  sectors: z.array(z.string()),
  geos: z.array(z.string()),
  keywords: z.array(z.string()),
});

const WEIGHT_SUM_TOLERANCE = 0.001;

const weightsSchema = z
  .object({
    semantic: z.number().min(0).max(1),
    momentum: z.number().min(0).max(1),
    keywords: z.number().min(0).max(1),
    recency: z.number().min(0).max(1),
  })
  .refine(
    (w) =>
      Math.abs(w.semantic + w.momentum + w.keywords + w.recency - 1) <=
      WEIGHT_SUM_TOLERANCE,
    { message: `weights.semantic + momentum + keywords + recency must sum to 1 (±${WEIGHT_SUM_TOLERANCE})` },
  );

export const thesisSchema = z.object({
  hard_filters: hardFiltersSchema,
  soft_preferences: softPreferencesSchema,
  anti_patterns: z.array(z.string()),
  weights: weightsSchema,
});

export type Thesis = z.infer<typeof thesisSchema>;

export class ThesisValidationError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ThesisValidationError';
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseThesis(yamlText: string): Thesis {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    throw new ThesisValidationError(
      `Invalid thesis YAML: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  const result = thesisSchema.safeParse(raw);
  if (!result.success) {
    throw new ThesisValidationError(
      `Invalid thesis: ${formatZodError(result.error)}`,
      result.error,
    );
  }
  return result.data;
}
