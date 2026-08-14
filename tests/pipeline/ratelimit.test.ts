import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTokenBucket } from '../../src/pipeline/ratelimit.js';

// ---------------------------------------------------------------------------
// Token bucket shape (Phase 7, spec §9 "Rate limiting por fuente con token
// bucket"): capacity = max burst size, refillPerSecond = continuous fractional
// refill rate. `acquire(tokens?)` resolves once enough tokens are available —
// it DELAYS (via setTimeout under real timers, or fake timers in tests), it
// NEVER throws/rejects just because the bucket is empty. This matches "si no
// lo manejás, el pipeline se cae" — the bucket must make the caller wait
// instead of erroring.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createTokenBucket', () => {
  it('does not block when acquiring within capacity', async () => {
    const bucket = createTokenBucket({ capacity: 5, refillPerSecond: 1 });

    let resolved = false;
    void bucket.acquire().then(() => {
      resolved = true;
    });

    // Flush microtasks/zero-delay timers without advancing simulated time —
    // if this needed a real setTimeout(ms>0) to resolve, `resolved` would
    // still be false here.
    await vi.advanceTimersByTimeAsync(0);

    expect(resolved).toBe(true);
  });

  it('blocks until refill when the bucket is empty, then resolves', async () => {
    const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 1 });

    // Drain the full capacity immediately (both within budget).
    await bucket.acquire();
    await bucket.acquire();

    let resolved = false;
    void bucket.acquire().then(() => {
      resolved = true;
    });

    // Only half the refill time has passed — must still be waiting.
    await vi.advanceTimersByTimeAsync(500);
    expect(resolved).toBe(false);

    // Now enough time has passed for 1 token to refill (1 token/sec).
    await vi.advanceTimersByTimeAsync(600);
    expect(resolved).toBe(true);
  });

  it('scales the wait to the configured refill rate (not hardcoded)', async () => {
    // 1 token every 2 seconds.
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 0.5 });

    await bucket.acquire();

    let resolved = false;
    void bucket.acquire().then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(1900);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(true);
  });

  it('blocks proportionally longer when acquiring more than one token at once', async () => {
    const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1 });
    await bucket.acquire(3); // drain fully

    let resolved = false;
    void bucket.acquire(3).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(2900);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(true);
  });

  it('serializes concurrent acquire() calls rather than double-spending tokens', async () => {
    const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1 });

    const order: number[] = [];
    const p1 = bucket.acquire().then(() => order.push(1));
    const p2 = bucket.acquire().then(() => order.push(2));
    const p3 = bucket.acquire().then(() => order.push(3));

    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });
});
