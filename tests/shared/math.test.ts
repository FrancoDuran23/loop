import { describe, expect, it } from 'vitest';
import { clamp } from '../../src/shared/math.js';

describe('clamp', () => {
  it('returns the value unchanged when it is within the range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('returns the minimum when the value is below the range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
  });

  it('returns the maximum when the value is above the range', () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
