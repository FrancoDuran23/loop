import { describe, expect, it } from 'vitest';
import {
  GENERIC_HOSTING_DOMAINS,
  normalizeDomain,
  normalizeName,
} from '../../src/resolution/normalize.js';

describe('normalizeName', () => {
  it('lowercases the name', () => {
    expect(normalizeName('Acme Corp')).toBe('acme corp');
  });

  it('strips accents (café -> cafe)', () => {
    expect(normalizeName('Café Solutions')).toBe('cafe solutions');
  });

  it('strips a trailing corporate suffix regardless of casing', () => {
    expect(normalizeName('Acme Inc.')).toBe('acme');
    expect(normalizeName('Acme INC')).toBe('acme');
    expect(normalizeName('Acme, Inc.')).toBe('acme');
  });

  it('strips every corporate suffix in the spec list', () => {
    expect(normalizeName('Acme Inc.')).toBe('acme');
    expect(normalizeName('Acme LLC')).toBe('acme');
    expect(normalizeName('Acme Ltd')).toBe('acme');
    expect(normalizeName('Acme S.A.')).toBe('acme');
    expect(normalizeName('Acme SA')).toBe('acme');
    expect(normalizeName('Acme SRL')).toBe('acme');
    expect(normalizeName('Acme GmbH')).toBe('acme');
  });

  it('strips a suffix written with interspersed periods (S.A., L.L.C.)', () => {
    expect(normalizeName('Acme S.A.')).toBe('acme');
    expect(normalizeName('Acme L.L.C.')).toBe('acme');
  });

  it('strips multiple trailing suffix-like tokens iteratively', () => {
    expect(normalizeName('Acme Ltd Inc')).toBe('acme');
  });

  it('strips punctuation without fusing adjacent words', () => {
    expect(normalizeName('Acme, Widgets & Co.')).toBe('acme widgets co');
  });

  it('collapses multiple internal spaces into one', () => {
    expect(normalizeName('Acme    Corp')).toBe('acme corp');
  });

  it('trims leading and trailing whitespace', () => {
    expect(normalizeName('  Acme Corp  ')).toBe('acme corp');
  });

  it('handles unicode beyond accents (e.g. ü, ñ) by stripping the diacritic', () => {
    expect(normalizeName('Müller Analytics')).toBe('muller analytics');
    expect(normalizeName('Peña Robotics')).toBe('pena robotics');
  });

  it('does not strip a suffix-like substring that is not a trailing token', () => {
    // "Inca" contains "inc" but is not the "inc" suffix token.
    expect(normalizeName('Inca Trail Adventures')).toBe('inca trail adventures');
  });

  it('edge case: a name that is ONLY a corporate suffix after stripping falls back to the punctuation-cleaned (suffix-intact) name, never returns empty', () => {
    // Documented decision (see normalize.ts): stripping the suffix would
    // leave nothing to normalize or block on, which is worse than keeping
    // it, so we fall back rather than degenerate to ''.
    expect(normalizeName('Inc.')).toBe('inc');
    expect(normalizeName(', Inc.')).toBe('inc');
    expect(normalizeName('LLC')).toBe('llc');
  });
});

describe('normalizeDomain', () => {
  it('strips the www. prefix', () => {
    expect(normalizeDomain('www.acme.com')).toBe('acme.com');
  });

  it('lowercases the domain', () => {
    expect(normalizeDomain('ACME.COM')).toBe('acme.com');
  });

  it('keeps a bare registrable domain unchanged', () => {
    expect(normalizeDomain('acme.com')).toBe('acme.com');
  });

  it('collapses a subdomain of a real company down to its registrable domain', () => {
    expect(normalizeDomain('blog.acme.com')).toBe('acme.com');
  });

  it.each(GENERIC_HOSTING_DOMAINS)(
    'discards the generic hosting domain %s entirely (returns undefined)',
    (host) => {
      expect(normalizeDomain(host)).toBeUndefined();
    },
  );

  it('discards a subdomain of a generic hosting domain (foo.github.io)', () => {
    expect(normalizeDomain('foo.github.io')).toBeUndefined();
  });

  it('discards a subdomain of vercel.app', () => {
    expect(normalizeDomain('my-project.vercel.app')).toBeUndefined();
  });

  it('discards a subdomain of the self-identified generic domain herokuapp.com', () => {
    expect(normalizeDomain('my-app.herokuapp.com')).toBeUndefined();
  });

  it('extracts the hostname defensively when given a full URL instead of a bare domain', () => {
    expect(normalizeDomain('https://www.acme.com/careers')).toBe('acme.com');
  });

  it('returns undefined for an empty or whitespace-only input', () => {
    expect(normalizeDomain('')).toBeUndefined();
    expect(normalizeDomain('   ')).toBeUndefined();
  });
});
