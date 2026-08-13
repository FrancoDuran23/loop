// Entity-resolution normalization (spec §8.1 step 1). Pure functions, no I/O,
// no infrastructure — this file lives under the core-layer ESLint boundary
// (eslint.config.js CORE_LAYER_GLOBS) and is machine-checked to import
// nothing from postgres/drizzle/transformers/hono/node builtins.
//
// Two independent normalizers:
//   normalizeName   — for Company.canonicalName / ExtractedCompany.name
//   normalizeDomain — for Company.domain / ExtractedCompany.domain
// Both feed resolver.ts's blocking-key derivation and pair scoring.

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

// Corporate suffixes to strip, per spec §8.1 verbatim list. Order does not
// matter — stripTrailingCorporateSuffixes() loops over all of them until
// none apply, so "Acme Ltd Inc" strips both.
const CORPORATE_SUFFIXES = ['inc', 'llc', 'ltd', 'sa', 'srl', 'gmbh'] as const;

function stripAccents(input: string): string {
  // NFD decomposes accented characters into base + combining diacritical
  // marks (U+0300-U+036F), which we then drop. "café" -> "cafe", "Müller" ->
  // "Muller", "Peña" -> "Pena".
  return input.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function stripPunctuation(input: string): string {
  // Replace anything that is not a Unicode letter, digit, or whitespace with
  // a space — never delete it outright — so punctuation never fuses two
  // words together ("Acme,Inc" -> "acme inc", not "acmeinc").
  return input.replace(/[^\p{L}\p{N}\s]/gu, ' ');
}

function collapseWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

// Builds a suffix-matching pattern that:
//   - requires letters optionally separated by periods, so it matches both
//     "sa" and "s.a." / "S.A." for the same "sa" suffix entry
//   - requires a preceding comma/space boundary ([\s,]+), so it only strips
//     a TRAILING suffix TOKEN, never a substring inside an unrelated word
//     ("Inca Trail" must not lose its "inc")
//   - is anchored at the END of the string ($) — corporate suffixes appear
//     at the end of a company name, not in the middle
//   - tolerates a trailing period after the last letter ("Inc.")
// A side effect of requiring a preceding [\s,]+ boundary: a name that is
// JUST the suffix with nothing before it (e.g. "Inc" alone, no separator to
// match) is left untouched here — see the empty-fallback comment in
// normalizeName() for the one case where a leading comma DOES let this
// pattern consume the whole string.
function buildSuffixPattern(suffix: string): RegExp {
  const lettersWithOptionalDots = suffix.split('').join('\\.?');
  return new RegExp(`[\\s,]+${lettersWithOptionalDots}\\.?\\s*$`, 'i');
}

const SUFFIX_PATTERNS = CORPORATE_SUFFIXES.map(buildSuffixPattern);

function stripTrailingCorporateSuffixes(input: string): string {
  let result = input;
  // Bounded by CORPORATE_SUFFIXES.length: at most one suffix can be stripped
  // per full pass in the worst realistic case (e.g. "Acme Ltd Inc" needs 2
  // passes), and the string strictly shrinks on each successful strip, so
  // this terminates well before the cap — the cap only guards against an
  // unforeseen pathological pattern looping forever.
  for (let pass = 0; pass < CORPORATE_SUFFIXES.length; pass += 1) {
    let changedThisPass = false;
    for (const pattern of SUFFIX_PATTERNS) {
      const next = result.replace(pattern, '');
      if (next !== result) {
        result = next;
        changedThisPass = true;
      }
    }
    if (!changedThisPass) break;
  }
  return result;
}

/**
 * Normalizes a company name for entity-resolution comparison (spec §8.1):
 * lowercase, strip corporate suffixes, strip punctuation/accents, collapse
 * whitespace.
 *
 * Edge case — a name that is ONLY a corporate suffix after stripping (e.g.
 * ", Inc." with a leading comma, which lets the suffix pattern's `[\s,]+`
 * boundary consume the entire string): stripping it would leave an empty
 * string, which is worse than keeping the suffix — an empty normalized name
 * would be a universal wildcard blocking key that silently collides every
 * such record together. Decision: fall back to the punctuation-cleaned
 * (suffix-INTACT) name instead of returning ''.
 */
export function normalizeName(name: string): string {
  const lowerTrimmed = stripAccents(name.toLowerCase()).trim();

  const suffixStripped = stripTrailingCorporateSuffixes(lowerTrimmed);
  const cleaned = collapseWhitespace(stripPunctuation(suffixStripped));
  if (cleaned.length > 0) {
    return cleaned;
  }

  return collapseWhitespace(stripPunctuation(lowerTrimmed));
}

// ---------------------------------------------------------------------------
// Domain normalization
// ---------------------------------------------------------------------------

/**
 * Generic hosting domains: platforms where thousands of unrelated
 * projects/companies publish under the SAME root domain, so the domain
 * alone cannot identify a specific company. This is a documented, clearly
 * named, easily-extended constant — not a magic list buried in logic.
 *
 * Spec §8.1 names three explicitly (github.io, vercel.app, notion.site).
 * Two more of the same category, identified here:
 *   - herokuapp.com — Heroku assigns every deployed app a subdomain of this
 *     root regardless of who owns the app; it is a hosting default, not a
 *     company identity.
 *   - netlify.app   — Netlify's default per-site/per-deploy subdomain, same
 *     reasoning as herokuapp.com.
 */
export const GENERIC_HOSTING_DOMAINS: readonly string[] = [
  'github.io',
  'vercel.app',
  'notion.site',
  'herokuapp.com',
  'netlify.app',
];

const WWW_PREFIX = /^www\./i;

function extractHostname(input: string): string {
  // Defensive: the expected shape is a bare hostname (Company.domain /
  // ExtractedCompany.domain), but if a full URL slips through, extract just
  // the hostname instead of normalizing garbage like "https://acme.com".
  if (!input.includes('://')) {
    return input;
  }
  try {
    return new URL(input).hostname.toLowerCase();
  } catch {
    return input;
  }
}

/**
 * Normalizes a domain for entity-resolution comparison (spec §8.1): strip
 * `www.`, keep the registrable domain, discard generic hosting domains.
 * Returns `undefined` when the domain does not identify a specific company
 * (empty input, or a generic hosting domain / subdomain of one).
 *
 * Known limitation: "registrable domain" is approximated as "the last two
 * dot-separated labels", not a full Public Suffix List lookup. This is
 * wrong for multi-part TLDs (e.g. "acme.co.uk" would be truncated to
 * "co.uk" instead of "acme.co.uk"). Accepted tradeoff for this project's
 * scope — every GENERIC_HOSTING_DOMAINS entry is exactly two labels, so the
 * naive truncation and the exclusion check agree for all documented cases.
 * A production system resolving many ccTLD-style domains would need a real
 * PSL library here.
 */
export function normalizeDomain(domain: string): string | undefined {
  const trimmed = domain.trim().toLowerCase();
  if (trimmed.length === 0) {
    return undefined;
  }

  const hostname = extractHostname(trimmed);
  const withoutWww = hostname.replace(WWW_PREFIX, '');

  const labels = withoutWww.split('.').filter((label) => label.length > 0);
  const registrable = labels.length > 2 ? labels.slice(-2).join('.') : withoutWww;

  if (GENERIC_HOSTING_DOMAINS.includes(registrable)) {
    return undefined;
  }
  return registrable;
}
