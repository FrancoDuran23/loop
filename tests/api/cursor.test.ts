import { describe, expect, it } from 'vitest';
import type { CompanyId } from '../../src/domain/entities.js';
import { decodeDealCursor, encodeDealCursor } from '../../src/api/cursor.js';
import { ApiError } from '../../src/api/errors.js';

describe('encodeDealCursor / decodeDealCursor', () => {
  it('round-trips a cursor through encode then decode', () => {
    const companyId = crypto.randomUUID() as CompanyId;
    const token = encodeDealCursor({ score: 42.5, companyId });

    const decoded = decodeDealCursor(token);

    expect(decoded).toEqual({ score: 42.5, companyId });
  });

  it('produces an opaque token, not a readable offset/page number', () => {
    const companyId = crypto.randomUUID() as CompanyId;
    const token = encodeDealCursor({ score: 10, companyId });

    expect(token).not.toMatch(/^\d+$/); // not a bare page/offset integer
    expect(token).not.toContain(companyId); // not plaintext-embedded
  });

  it('two different (score, companyId) pairs produce different tokens', () => {
    const companyIdA = crypto.randomUUID() as CompanyId;
    const companyIdB = crypto.randomUUID() as CompanyId;

    const tokenA = encodeDealCursor({ score: 10, companyId: companyIdA });
    const tokenB = encodeDealCursor({ score: 10, companyId: companyIdB });

    expect(tokenA).not.toBe(tokenB);
  });

  it('decodeDealCursor throws a VALIDATION_ERROR ApiError for garbage input', () => {
    expect(() => decodeDealCursor('not-a-valid-cursor-!!!')).toThrow(ApiError);
    try {
      decodeDealCursor('not-a-valid-cursor-!!!');
      expect.unreachable('decodeDealCursor should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('VALIDATION_ERROR');
      expect((err as ApiError).status).toBe(400);
    }
  });

  it('decodeDealCursor throws for valid base64 that decodes to the wrong JSON shape', () => {
    const wrongShape = Buffer.from(JSON.stringify({ foo: 'bar' }), 'utf-8').toString('base64url');
    expect(() => decodeDealCursor(wrongShape)).toThrow(ApiError);
  });
});
