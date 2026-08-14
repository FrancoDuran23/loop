// Token-bucket rate limiter (spec §9: "Rate limiting por fuente con token
// bucket. GitHub sin token son 60 req/h: si no lo manejás, el pipeline se
// cae."). Lives under `src/pipeline/` (not `src/sources/github.ts`) so it is
// source-agnostic and reusable — HN/RSS don't need it as urgently today, but
// nothing here is GitHub-specific.
//
// Bucket shape (a design call, since the spec does not pin the exact model):
// a CONTINUOUS fractional-refill bucket. `capacity` tokens can be spent in a
// burst; tokens then refill smoothly at `refillPerSecond` (fractional, not
// "one whole token every N seconds") rather than in discrete steps. This is
// the standard token-bucket model and, for GitHub's unauthenticated ceiling,
// is configured as `{ capacity: 60, refillPerSecond: 60 / 3600 }` — i.e. a
// full 60-request burst is allowed up front (matching "60 req/h" read as an
// hourly allowance, not a strict 1-req-per-60s trickle), and it takes a full
// hour to refill from empty back to capacity.
//
// `acquire()` NEVER throws because the bucket is empty — it resolves once
// enough tokens exist, waiting via a real (or, in tests, fake) timer. This is
// deliberate: a rate limiter that throws on exhaustion just pushes the
// "handle this" problem onto every caller; a rate limiter that queues is the
// actual point of spec §9's "si no lo manejás, el pipeline se cae" — the
// caller can `await bucket.acquire()` and simply proceed once it resolves.

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface TokenBucket {
  /** Resolves once `tokens` tokens are available, waiting (never throwing) if not. */
  acquire(tokens?: number): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class TokenBucketImpl implements TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  // Serializes concurrent acquire() calls so two callers racing for the last
  // token can't both read "enough tokens available" before either deducts —
  // each acquire() call queues behind the previous one's full completion
  // (including any wait), not just its synchronous portion.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  acquire(tokens = 1): Promise<void> {
    const next = this.queue.then(() => this.acquireOne(tokens));
    // Keep the queue alive even if this acquisition somehow rejects, so a
    // failed caller doesn't permanently wedge every acquire() after it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefillMs = now;
    }
  }

  private async acquireOne(tokens: number): Promise<void> {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return;
    }

    const deficit = tokens - this.tokens;
    const waitMs = (deficit / this.refillPerSecond) * 1000;
    await sleep(waitMs);

    this.refill();
    this.tokens = Math.max(0, this.tokens - tokens);
  }
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  return new TokenBucketImpl(options.capacity, options.refillPerSecond);
}
