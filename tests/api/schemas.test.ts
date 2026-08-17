import { describe, expect, it } from 'vitest';
import { dealsQuerySchema, postRunsBodySchema, uuidParamSchema } from '../../src/api/schemas.js';

describe('dealsQuerySchema', () => {
  it('parses a fully-populated valid query, coercing numeric strings', () => {
    const result = dealsQuerySchema.safeParse({
      minScore: '50',
      sector: 'devtools',
      stage: 'seed',
      limit: '10',
      cursor: 'some-opaque-token',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.minScore).toBe(50);
      expect(result.data.limit).toBe(10);
      expect(result.data.sector).toBe('devtools');
      expect(result.data.stage).toBe('seed');
    }
  });

  it('defaults limit to 20 when omitted', () => {
    const result = dealsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(20);
    }
  });

  it('rejects a non-numeric minScore', () => {
    const result = dealsQuerySchema.safeParse({ minScore: 'notanumber' });
    expect(result.success).toBe(false);
  });

  it('rejects an out-of-range minScore', () => {
    expect(dealsQuerySchema.safeParse({ minScore: '150' }).success).toBe(false);
    expect(dealsQuerySchema.safeParse({ minScore: '-5' }).success).toBe(false);
  });

  it('rejects a non-numeric limit', () => {
    expect(dealsQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });

  it('rejects a limit of 0 and a limit above the max', () => {
    expect(dealsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(dealsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('rejects an unknown stage value', () => {
    expect(dealsQuerySchema.safeParse({ stage: 'not-a-real-stage' }).success).toBe(false);
  });
});

describe('uuidParamSchema', () => {
  it('accepts a well-formed UUID', () => {
    expect(uuidParamSchema.safeParse(crypto.randomUUID()).success).toBe(true);
  });

  it('rejects a non-UUID string', () => {
    expect(uuidParamSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('postRunsBodySchema', () => {
  it('accepts an empty body (all fields optional)', () => {
    expect(postRunsBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts an explicit thesisPath and limitPerSource', () => {
    const result = postRunsBodySchema.safeParse({
      thesisPath: 'thesis.example.yaml',
      limitPerSource: '15',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limitPerSource).toBe(15);
    }
  });

  it('rejects a non-positive limitPerSource', () => {
    expect(postRunsBodySchema.safeParse({ limitPerSource: '0' }).success).toBe(false);
    expect(postRunsBodySchema.safeParse({ limitPerSource: '-1' }).success).toBe(false);
  });
});
