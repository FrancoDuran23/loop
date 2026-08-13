import { z } from 'zod';

// ---------------------------------------------------------------------------
// Environment config, Zod-validated, fail-fast (spec §9).
//
// Field scope for this phase (per the Phase 2 task breakdown):
// - LLM_PROVIDER: which LlmProvider the runtime composition root selects.
// - EMBEDDING_PROVIDER: which EmbeddingProvider the runtime composition
//   root selects.
// - DATABASE_URL: optional at this phase. Postgres/Drizzle don't exist
//   until Phase 5, so this is deliberately optional-with-no-default rather
//   than required — requiring it now would block every phase before 5 on
//   an unimplemented dependency. Phase 5 is expected to either keep it
//   optional (defaulting a local docker-compose URL) or promote it to
//   required once the DB layer exists; that decision is deferred to that
//   phase, not made here.
// - LOG_LEVEL: pino level.
// - GITHUB_TOKEN: optional, raises the GitHub adapter's unauthenticated
//   60 req/h ceiling (Phase 7) — unused until then.
//
// Note on env var names: design.md's composition-root prose uses the
// shorthand `EMBEDDINGS=` / `LLM=` when describing provider selection.
// That mention is informal narrative, not a literal contract (unlike the
// verbatim ports.ts code block). This phase's task breakdown explicitly
// names `LLM_PROVIDER` / `EMBEDDING_PROVIDER`, which is what's implemented
// here; flagged as a deviation in the apply report for the design owner to
// reconcile the shorthand shown in the runtime.ts one-liner.
// ---------------------------------------------------------------------------

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  LLM_PROVIDER: z.enum(['rules', 'ollama']).default('rules'),
  EMBEDDING_PROVIDER: z.enum(['local', 'deterministic']).default('local'),
  // TODO(Phase 5): decide default/required-ness once Postgres exists.
  DATABASE_URL: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  GITHUB_TOKEN: z.string().min(1).optional(),
});

export type Config = z.infer<typeof envSchema>;

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Parses and validates process.env (or an injected env-like object) into a
 * typed Config. Throws ConfigValidationError with a single-line, readable
 * message on malformed input — never a raw Zod stack trace. Unrelated
 * ambient env vars (PATH, HOME, ...) are ignored, not rejected.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(
      `Invalid environment configuration: ${formatZodError(result.error)}`,
      result.error,
    );
  }
  return result.data;
}
