import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpError,
  TransientNetworkError,
  computeBackoffDelayMs,
  isTransientError,
  withRetry,
} from '../../src/pipeline/retry.js';

// ---------------------------------------------------------------------------
// Spec §9: "Reintentos con backoff exponencial y jitter, solo sobre errores
// transitorios (5xx, 429, timeouts). Nunca reintentar un 4xx de validación."
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isTransientError', () => {
  it('treats 5xx HttpErrors as transient', () => {
    expect(isTransientError(new HttpError('boom', 500))).toBe(true);
    expect(isTransientError(new HttpError('boom', 503))).toBe(true);
  });

  it('treats 429 as transient', () => {
    expect(isTransientError(new HttpError('rate limited', 429))).toBe(true);
  });

  it('does NOT treat other 4xx as transient', () => {
    expect(isTransientError(new HttpError('bad request', 400))).toBe(false);
    expect(isTransientError(new HttpError('not found', 404))).toBe(false);
    expect(isTransientError(new HttpError('unprocessable', 422))).toBe(false);
  });

  it('treats TransientNetworkError (timeouts/network) as transient', () => {
    expect(isTransientError(new TransientNetworkError('ETIMEDOUT'))).toBe(true);
  });

  it('does not treat an unrecognized plain Error as transient', () => {
    expect(isTransientError(new Error('unknown'))).toBe(false);
  });

  it('does not treat a genuine AbortError as transient', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTransientError(err)).toBe(false);
  });
});

describe('computeBackoffDelayMs', () => {
  it('grows with each attempt, capped at maxDelayMs', () => {
    const zeroJitter = () => 0;
    const d1 = computeBackoffDelayMs(1, 100, 10_000, zeroJitter);
    const d2 = computeBackoffDelayMs(2, 100, 10_000, zeroJitter);
    const d3 = computeBackoffDelayMs(3, 100, 10_000, zeroJitter);
    expect(d1).toBe(50); // (100 * 2^0) / 2
    expect(d2).toBe(100); // (100 * 2^1) / 2
    expect(d3).toBe(200); // (100 * 2^2) / 2
    expect(d1).toBeLessThan(d2);
    expect(d2).toBeLessThan(d3);
  });

  it('never exceeds maxDelayMs even at a large attempt number', () => {
    const d = computeBackoffDelayMs(20, 100, 5_000, () => 1);
    expect(d).toBeLessThanOrEqual(5_000);
  });

  it('adds jitter within [half, exponential] of the capped exponential value', () => {
    const dMin = computeBackoffDelayMs(3, 100, 10_000, () => 0);
    const dMax = computeBackoffDelayMs(3, 100, 10_000, () => 1);
    expect(dMax).toBeGreaterThan(dMin);
    expect(dMax).toBeLessThanOrEqual(400); // full exponential at attempt 3
  });
});

describe('withRetry', () => {
  it('fails fast on a permanent 4xx (single attempt, no retry)', async () => {
    const fn = vi.fn(async () => {
      throw new HttpError('bad request', 400);
    });

    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 }),
    ).rejects.toThrow(HttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx that eventually succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new HttpError('server error', 503);
      return 'ok';
    });

    const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries a 429 that eventually succeeds', async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new HttpError('rate limited', 429);
      return 'ok';
    });

    const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exhausts maxAttempts and rethrows the last transient error', async () => {
    const fn = vi.fn(async () => {
      throw new HttpError('server error', 503);
    });

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
    const assertion = expect(promise).rejects.toThrow(HttpError);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('backoff delays grow between successive retries', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 4) throw new HttpError('server error', 503);
      return 'ok';
    });

    const promise = withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 0,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');

    const delays = setTimeoutSpy.mock.calls.map(([, ms]) => ms as number);
    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays[0]).toBeLessThan(delays[1]!);
    expect(delays[1]).toBeLessThan(delays[2]!);
  });

  it('calls onRetry with attempt number and error for each transient retry', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new HttpError('server error', 503);
      return 'ok';
    });

    const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, onRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1);
    expect(onRetry.mock.calls[0]![2]).toBeInstanceOf(HttpError);
  });
});
