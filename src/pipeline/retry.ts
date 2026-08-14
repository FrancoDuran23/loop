// Exponential backoff + jitter retry wrapper (spec §9: "Reintentos con
// backoff exponencial y jitter, solo sobre errores transitorios (5xx, 429,
// timeouts). Nunca reintentar un 4xx de validación."). Source-agnostic, like
// `pipeline/ratelimit.ts` — any adapter can wrap a request with `withRetry`.

// ---------------------------------------------------------------------------
// Error taxonomy. Callers (adapters) throw these specific types so
// `isTransientError` can classify by TYPE, not by re-parsing a generic
// Error's message string.
// ---------------------------------------------------------------------------

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HttpError';
  }
}

export class TransientNetworkError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'TransientNetworkError';
  }
}

/**
 * Named, independently testable transient/permanent classification —
 * spec's own retry rule made explicit rather than buried inline in the
 * retry loop. Deliberately an ALLOW-list (recognizes known transient error
 * types), not a deny-list: an error type this function has never heard of
 * (e.g. a source-specific error like GitHub's rate-limit-exceeded 403 quirk,
 * which needs wait-until-reset handling instead of generic backoff) falls
 * through to `false` — NOT retried by this generic mechanism, by design.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status >= 500 || error.status === 429;
  }
  if (error instanceof TransientNetworkError) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Backoff + jitter
// ---------------------------------------------------------------------------

/**
 * Equal jitter: `delay = half(exponential) + random() * half(exponential)`.
 * Chosen over "full jitter" (`random() * exponential`) specifically because
 * it guarantees a monotonically non-decreasing MINIMUM delay per attempt
 * (`half(exponential)` alone already grows) — spec's "backoff exponencial"
 * is satisfied even under adversarial randomness, while still adding real
 * jitter on top to avoid a thundering herd of synchronized retries.
 * `random` is injectable (defaults to `Math.random`) purely for
 * deterministic unit testing.
 */
export function computeBackoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  const half = exponential / 2;
  return half + random() * half;
}

// Exported so callers with their own bounded, non-generic wait logic (e.g.
// the GitHub adapter's "wait until X-RateLimit-Reset" path, which is
// deliberately NOT routed through the generic exponential-backoff loop
// below — see github.ts) can reuse the same fake-timer-friendly primitive.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Total attempts including the first (non-retry) call. */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Defaults to `isTransientError`. Override to customize classification. */
  readonly isTransient?: (error: unknown) => boolean;
  /** Injectable for deterministic tests; defaults to `Math.random`. */
  readonly random?: () => number;
  /** Called before each retry sleep — the adapter's hook for structured logging. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const isTransient = options.isTransient ?? isTransientError;
  let attempt = 0;

  for (;;) {
    attempt += 1;
    try {
      return await fn();
    } catch (err) {
      const attemptsRemain = attempt < options.maxAttempts;
      if (!isTransient(err) || !attemptsRemain) {
        throw err;
      }
      const delayMs = computeBackoffDelayMs(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs,
        options.random,
      );
      options.onRetry?.(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }
}
