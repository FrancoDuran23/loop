// GitHub SourceAdapter — REST Search API (`GET /search/repositories`), the
// first adapter in this project that actually NEEDS the rate limiter +
// retry framework (spec §9): unauthenticated GitHub is 60 req/h, tight
// enough that "handle it or the pipeline falls over" is a real constraint,
// not a hypothetical one.
//
// No global `fetch` mocking (design.md "Testing Strategy", same convention
// as `sources/hackernews.ts`): the adapter receives an injectable `FetchLike`
// via its constructor. `pipeline/ratelimit.ts` (token bucket) and
// `pipeline/retry.ts` (backoff+jitter retry) are also constructor-injectable
// so tests can swap in a non-blocking rate limiter double and drive retries
// with fake timers, without waiting on a real 60/h bucket.
//
// ---------------------------------------------------------------------------
// Design decision: github_stars_delta_30d (documented, per this phase's own
// instruction to make this tradeoff explicit rather than hiding it)
// ---------------------------------------------------------------------------
// GitHub's repo/search response only gives a CURRENT cumulative star count
// (`stargazers_count`) — momentum scoring (Phase 6) reads the DERIVATIVE
// (`github_stars_delta_30d`), not the absolute value. GitHub exposes
// per-star timestamps via `GET /repos/{owner}/{repo}/stargazers` with
// `Accept: application/vnd.github.star+json`, paginated oldest-first.
// Fetching every page to count 30-day-recent stars is unbounded — a popular
// repo can have thousands of pages, which would exhaust the 60/h budget on
// a SINGLE repo.
//
// Bounded-cost approach actually implemented: exactly ONE extra request per
// repo (with stars > 0), for the LAST page only:
//   lastPage = ceil(stargazers_count / 100)
// Since the endpoint returns oldest-first, the last page holds the MOST
// RECENT stargazers. We count how many of those have `starred_at` within
// the last 30 days. Repos with stargazers_count === 0 skip the request
// entirely (delta is trivially 0, zero extra cost).
//
// Documented limitation, not a bug: if a repo gained MORE than 100 stars in
// the last 30 days (i.e. the 30-day-recent window spans more than the final
// page), this UNDERCOUNTS — stars recorded on earlier pages within the
// window are invisible to us. For the discovery use case here (finding
// early-stage/momentum signals, not auditing every star), a repo gaining
// >100 stars/month is already an extreme outlier whose momentum will read
// as high regardless of exact precision. Budget-wise: 1 search request +
// up to `opts.limit` stargazers requests per `fetch()` call; every one of
// those goes through the SAME token bucket as the search requests, so a
// caller who sets `limit` too high for the hourly budget doesn't fail —
// the bucket queues (blocks) the run until capacity frees up, per
// `pipeline/ratelimit.ts`'s "wait, never throw" contract.
//
// ---------------------------------------------------------------------------
// Design decision: discovery query (documented)
// ---------------------------------------------------------------------------
// "Discovering early-stage startups from GitHub activity" needs a bounded
// query, not a firehose. Chosen filter: `stars:>={GITHUB_MIN_STARS}
// fork:false archived:false`, sorted by stars descending — a minimal star
// floor cuts obvious noise (empty template repos, one-off scripts) without
// excluding genuinely early projects; forks and archived repos are excluded
// because they are not standalone, active projects. `created:>{since}` is
// appended when a watermark exists (incremental fetch — spec §9 "corridas
// incrementales"), narrowing subsequent runs to repos created after the
// last successful run instead of re-scanning the same top-starred set.
//
// ---------------------------------------------------------------------------
// Design decision: GITHUB_TOKEN / rate-limit bucket sizing (documented)
// ---------------------------------------------------------------------------
// If `GITHUB_TOKEN` is configured, requests send `Authorization: Bearer
// {token}`, which raises GitHub's REAL ceiling to 5,000 req/h. This adapter
// deliberately does NOT resize the token bucket based on token presence —
// the bucket stays at the conservative unauthenticated 60/h shape
// regardless. Rationale: dynamically sizing the bucket is a legitimate
// future improvement, but out of this phase's scope, and erring
// conservative is safe (a token just means more real headroom than the
// bucket enforces, never less) rather than risky.
//
// ---------------------------------------------------------------------------
// Design decision: GitHub's 403-vs-429 rate-limit quirk (documented,
// verified against GitHub's own REST API docs, not guessed)
// ---------------------------------------------------------------------------
// GitHub's PRIMARY rate limit (the 60/h or 5000/h REST ceiling) is signaled
// by an HTTP 403 response carrying `X-RateLimit-Remaining: 0` and
// `X-RateLimit-Reset` (epoch seconds when the window resets) — NOT a 429.
// A 429 from GitHub instead signals a SECONDARY (abuse-detection) rate
// limit, and per GitHub's own docs, secondary-limit responses (403 or 429)
// carry a `Retry-After` header (seconds to wait) instead of/alongside
// `X-RateLimit-Reset`. Treating the primary-limit 403 as a generic 5xx and
// retrying it with exponential backoff+jitter would be WRONG: exponential
// backoff might retry well before the window actually resets (wasting
// requests against an already-exhausted budget) or, worse, might give up
// before the deterministic reset time is reached. So this adapter classifies
// that SPECIFIC 403 shape separately from `pipeline/retry.ts`'s generic
// `isTransientError` (which does not — and should not — know about this
// GitHub-specific quirk): it computes the wait from `X-RateLimit-Reset`
// (falling back to `Retry-After`, then a fixed fallback) and waits exactly
// that long via `pipeline/retry.ts`'s `sleep`, then retries the SAME
// request exactly ONCE more — a single bounded retry, not a loop, so a
// second consecutive rate-limit response fails the request with a clear
// typed error instead of hanging indefinitely.

import { z } from 'zod';
import pino from 'pino';
import type { FetchOptions, SourceAdapter, SourcePage } from '../domain/ports.js';
import type { ExtractedCompany, Signal, SourceRecord, SourceRecordId } from '../domain/entities.js';
import { type TokenBucket, createTokenBucket } from '../pipeline/ratelimit.js';
import {
  HttpError,
  TransientNetworkError,
  isTransientError,
  sleep,
  withRetry,
} from '../pipeline/retry.js';

const GITHUB_SEARCH_URL = 'https://api.github.com/search/repositories';
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_SEARCH_MAX_PER_PAGE = 100;
const GITHUB_SEARCH_MAX_INDEXABLE_RESULTS = 1000; // GitHub Search API's own hard cap
const STARGAZERS_PER_PAGE = 100;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GITHUB_MIN_STARS = 10; // discovery floor — see module doc comment above

// Unauthenticated GitHub REST ceiling (spec §2: "Sin token: 60 req/h").
// Bucket shape: full 60-request burst allowed, refilling continuously over
// an hour — see pipeline/ratelimit.ts's own doc comment for the rationale.
export const GITHUB_UNAUTH_RATE_LIMIT = { capacity: 60, refillPerSecond: 60 / 3600 } as const;

const RETRY_OPTIONS = { maxAttempts: 4, baseDelayMs: 300, maxDelayMs: 8_000 } as const;
const DEFAULT_RATE_LIMIT_FALLBACK_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// Injectable HTTP boundary — structurally compatible with the global
// `fetch`'s `Response`, but tests never touch the network or mock a global.
// Extends HN's `HttpResponseLike` with `headers` because this adapter needs
// to read `X-RateLimit-Remaining`/`X-RateLimit-Reset`/`Retry-After`.
// ---------------------------------------------------------------------------

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers?: Record<string, string> },
) => Promise<HttpResponseLike>;

// Minimal structural subset of pino's Logger — real `pino()` instances
// satisfy this. Spec §9 "Logs estructurados con runId en todas las líneas":
// runId threading is a pipeline-level (later phase) concern; this adapter's
// own responsibility is just using structured/leveled logging instead of
// `console.log`.
export interface LoggerLike {
  info(obj: Record<string, unknown> | string, msg?: string): void;
  warn(obj: Record<string, unknown> | string, msg?: string): void;
  error(obj: Record<string, unknown> | string, msg?: string): void;
}

export interface GithubAdapterOptions {
  readonly token?: string;
  readonly rateLimiter?: TokenBucket;
  readonly logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// GitHub's primary-rate-limit-exceeded 403 — see module doc comment. NOT
// classified as transient by `pipeline/retry.ts`'s `isTransientError`
// (it's a type that function has never heard of, so it correctly falls
// through to `false` there) — this adapter handles it itself, separately.
// ---------------------------------------------------------------------------

class GithubRateLimitExceededError extends Error {
  constructor(
    message: string,
    readonly resetAtMs: number,
  ) {
    super(message);
    this.name = 'GithubRateLimitExceededError';
  }
}

// ---------------------------------------------------------------------------
// Response validation. Mirrors hackernews.ts's pattern: keep each raw item
// as an unknown record (so `raw` on the SourceRecord stays byte-for-byte
// verbatim for provenance/replay) and separately parse only the fields this
// adapter actually reads via a narrow, strict schema.
// ---------------------------------------------------------------------------

const searchResponseSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(z.record(z.string(), z.unknown())),
});

const searchItemFieldsSchema = z.object({
  id: z.number(),
  name: z.string(),
  html_url: z.string(),
  description: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  created_at: z.string(),
  stargazers_count: z.number(),
  owner: z.object({ login: z.string() }).nullable().optional(),
});

type SearchItemFields = z.infer<typeof searchItemFieldsSchema>;
type RawItem = Record<string, unknown>;

const stargazersResponseSchema = z.array(
  z.object({
    starred_at: z.string(),
  }),
);

// ---------------------------------------------------------------------------
// Homepage -> domain extraction. Pragmatic heuristic (not full validation):
// requires a hostname containing a dot. Further cleanup (www./registrable
// domain/generic-hosting exclusion) is entity resolution's job
// (resolution/normalize.ts), not this adapter's.
// ---------------------------------------------------------------------------

function extractHomepageDomain(homepage: string | null | undefined): string | undefined {
  if (!homepage || !homepage.trim()) return undefined;
  const candidate = homepage.includes('://') ? homepage : `https://${homepage}`;
  try {
    const url = new URL(candidate);
    if (!url.hostname.includes('.')) return undefined;
    return url.hostname;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

function buildSearchQuery(since: string | undefined): string {
  const parts = [`stars:>=${GITHUB_MIN_STARS}`, 'fork:false', 'archived:false'];
  if (since) parts.push(`created:>${since}`);
  return parts.join(' ');
}

function buildSearchUrl(params: {
  readonly since?: string;
  readonly page: number;
  readonly perPage: number;
}): string {
  const url = new URL(GITHUB_SEARCH_URL);
  url.searchParams.set('q', buildSearchQuery(params.since));
  url.searchParams.set('sort', 'stars');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('per_page', String(params.perPage));
  url.searchParams.set('page', String(params.page));
  return url.toString();
}

function buildStargazersUrl(owner: string, repo: string, page: number): string {
  const url = new URL(`${GITHUB_API_BASE}/repos/${owner}/${repo}/stargazers`);
  url.searchParams.set('per_page', String(STARGAZERS_PER_PAGE));
  url.searchParams.set('page', String(page));
  return url.toString();
}

function parseResetAtMs(headers: { get(name: string): string | null }): number {
  const resetHeader = headers.get('x-ratelimit-reset');
  if (resetHeader) {
    const seconds = Number(resetHeader);
    if (Number.isFinite(seconds)) return seconds * 1000;
  }
  const retryAfterHeader = headers.get('retry-after');
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
  }
  return Date.now() + DEFAULT_RATE_LIMIT_FALLBACK_WAIT_MS;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GithubAdapter implements SourceAdapter {
  readonly source = 'github' as const;

  private readonly token: string | undefined;
  private readonly rateLimiter: TokenBucket;
  private readonly logger: LoggerLike;

  constructor(
    private readonly fetchImpl: FetchLike,
    options: GithubAdapterOptions = {},
  ) {
    this.token = options.token;
    this.rateLimiter =
      options.rateLimiter ??
      createTokenBucket({
        capacity: GITHUB_UNAUTH_RATE_LIMIT.capacity,
        refillPerSecond: GITHUB_UNAUTH_RATE_LIMIT.refillPerSecond,
      });
    this.logger = options.logger ?? pino({ name: 'github-adapter' });
  }

  async *fetch(opts: FetchOptions): AsyncIterable<SourcePage> {
    const perPage = Math.max(1, Math.min(opts.limit, GITHUB_SEARCH_MAX_PER_PAGE));
    let page = 1;
    let yielded = 0;
    let watermark = opts.since;

    while (yielded < opts.limit) {
      if (opts.signal.aborted) {
        throw new Error('GitHub adapter: fetch aborted', { cause: opts.signal.reason });
      }

      const url = buildSearchUrl({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        page,
        perPage,
      });
      const parsed = await this.fetchSearchPage(url, opts.signal, page);

      const remaining = opts.limit - yielded;
      const rawItems = parsed.items.slice(0, remaining);
      if (rawItems.length === 0) {
        break;
      }

      let fields: SearchItemFields[];
      try {
        fields = rawItems.map((item) => searchItemFieldsSchema.parse(item));
      } catch (err) {
        throw new Error(
          `GitHub adapter: malformed search item on page ${page}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const fetchedAt = new Date().toISOString();
      const records: SourceRecord[] = [];
      for (let i = 0; i < rawItems.length; i += 1) {
        records.push(
          await this.itemToSourceRecord(rawItems[i]!, fields[i]!, fetchedAt, opts.signal),
        );
      }

      const maxCreatedAt = fields.reduce(
        (max, f) => (f.created_at > max ? f.created_at : max),
        watermark ?? fields[0]!.created_at,
      );
      watermark = maxCreatedAt;
      yielded += records.length;

      yield { records, nextWatermark: watermark };

      // Completion checks use the CUMULATIVE `yielded` count, not
      // `page * perPage` — a page is not guaranteed to return exactly
      // `perPage` items (the real API's last page naturally returns
      // fewer), so comparing against actual progress is the correct,
      // fixture-and-reality-agnostic check.
      const reachedOptsLimit = rawItems.length < parsed.items.length;
      const reachedTotalCount = yielded >= parsed.total_count;
      const reachedIndexableCap = yielded >= GITHUB_SEARCH_MAX_INDEXABLE_RESULTS;
      if (reachedOptsLimit || reachedTotalCount || reachedIndexableCap) {
        break;
      }
      page += 1;
    }
  }

  // -------------------------------------------------------------------------
  // Item extraction
  // -------------------------------------------------------------------------

  private async itemToSourceRecord(
    raw: RawItem,
    fields: SearchItemFields,
    fetchedAt: string,
    signal: AbortSignal,
  ): Promise<SourceRecord> {
    const domain = extractHomepageDomain(fields.homepage);
    const signals: Signal[] = [
      {
        kind: 'github_stars',
        value: fields.stargazers_count,
        observedAt: fetchedAt,
        source: 'github',
        evidenceUrl: fields.html_url,
      },
    ];

    const delta = await this.fetchStarDelta30d(
      fields.owner?.login,
      fields.name,
      fields.stargazers_count,
      signal,
    );
    if (delta !== undefined) {
      signals.push({
        kind: 'github_stars_delta_30d',
        value: delta,
        observedAt: fetchedAt,
        source: 'github',
        evidenceUrl: fields.html_url,
      });
    }

    const extracted: ExtractedCompany = {
      name: fields.name,
      ...(domain !== undefined ? { domain } : {}),
      ...(fields.description ? { description: fields.description } : {}),
      url: fields.html_url,
      ...(fields.owner?.login ? { people: [fields.owner.login] } : {}),
      signals,
    };

    return {
      id: crypto.randomUUID() as SourceRecordId,
      source: 'github',
      sourceId: String(fields.id),
      fetchedAt,
      raw,
      extracted,
    };
  }

  // -------------------------------------------------------------------------
  // github_stars_delta_30d — bounded-cost approach, see module doc comment.
  // Degrades gracefully: a failure fetching/parsing stargazers omits the
  // signal (github_stars from the search response is unaffected) rather
  // than failing the whole record — this is a per-repo enrichment nicety,
  // not core identity data.
  // -------------------------------------------------------------------------

  private async fetchStarDelta30d(
    owner: string | undefined,
    repo: string,
    starCount: number,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    if (starCount <= 0) return 0;
    if (!owner) return undefined;

    const lastPage = Math.max(1, Math.ceil(starCount / STARGAZERS_PER_PAGE));
    const url = buildStargazersUrl(owner, repo, lastPage);

    try {
      const body = await this.requestJson(url, signal, {
        Accept: 'application/vnd.github.star+json',
      });
      const stargazers = stargazersResponseSchema.parse(body);
      // A genuinely empty array here is itself a red flag, not a confirmed
      // "zero stars in the last 30 days": we only reach this call when
      // starCount > 0, so the page this code computed as "the last page"
      // must contain at least one real stargazer. An empty result means
      // either a benign star-count race (fluctuated between the search
      // snapshot and this request) or — per GitHub's 2026 policy change
      // restricting this endpoint to admins/collaborators — a silent
      // access restriction returning 200 + [] instead of an error status.
      // Either way, treat it as "unable to determine", not as a real
      // zero, so a restricted/degraded response can't quietly poison
      // momentum scoring with a false zero instead of omitting the signal.
      if (stargazers.length === 0) {
        this.logger.warn(
          { owner, repo },
          'github adapter: stargazers page unexpectedly empty despite starCount > 0, omitting github_stars_delta_30d rather than reporting a false zero',
        );
        return undefined;
      }
      const cutoffMs = Date.now() - THIRTY_DAYS_MS;
      return stargazers.filter((s) => new Date(s.starred_at).getTime() >= cutoffMs).length;
    } catch (err) {
      this.logger.warn(
        { owner, repo, err: err instanceof Error ? err.message : String(err) },
        'github adapter: failed to compute github_stars_delta_30d, omitting signal',
      );
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP plumbing: rate limit -> retry (transient only) -> GitHub's
  // primary-rate-limit 403 quirk handled separately, one bounded retry.
  // -------------------------------------------------------------------------

  private async fetchSearchPage(
    url: string,
    signal: AbortSignal,
    page: number,
  ): Promise<z.infer<typeof searchResponseSchema>> {
    const body = await this.requestJson(url, signal);
    try {
      return searchResponseSchema.parse(body);
    } catch (err) {
      throw new Error(
        `GitHub adapter: malformed search response on page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private async requestJson(
    url: string,
    signal: AbortSignal,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const response = await this.requestWithRateLimitHandling(url, signal, extraHeaders, false);
    try {
      return await response.json();
    } catch (err) {
      throw new Error(
        `GitHub adapter: malformed JSON response from ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  private async requestWithRateLimitHandling(
    url: string,
    signal: AbortSignal,
    extraHeaders: Record<string, string> | undefined,
    alreadyWaitedForReset: boolean,
  ): Promise<HttpResponseLike> {
    try {
      return await this.rateLimitedRequest(url, signal, extraHeaders);
    } catch (err) {
      if (err instanceof GithubRateLimitExceededError && !alreadyWaitedForReset) {
        const waitMs = Math.max(0, err.resetAtMs - Date.now());
        this.logger.warn(
          { url, waitMs, resetAtMs: err.resetAtMs },
          'github adapter: primary rate limit exceeded (403, X-RateLimit-Remaining: 0), waiting for reset',
        );
        await sleep(waitMs);
        // Exactly one bounded retry after the reset window — not a loop.
        return this.requestWithRateLimitHandling(url, signal, extraHeaders, true);
      }
      throw err;
    }
  }

  private async rateLimitedRequest(
    url: string,
    signal: AbortSignal,
    extraHeaders: Record<string, string> | undefined,
  ): Promise<HttpResponseLike> {
    await this.rateLimiter.acquire();
    return withRetry(() => this.rawRequest(url, signal, extraHeaders), {
      ...RETRY_OPTIONS,
      isTransient: isTransientError,
      onRetry: (attempt, delayMs, err) => {
        this.logger.warn(
          { attempt, delayMs, url, err: err instanceof Error ? err.message : String(err) },
          'github adapter: retrying after transient error',
        );
      },
    });
  }

  private async rawRequest(
    url: string,
    signal: AbortSignal,
    extraHeaders: Record<string, string> | undefined,
  ): Promise<HttpResponseLike> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extraHeaders,
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    let response: HttpResponseLike;
    try {
      response = await this.fetchImpl(url, { signal, headers });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new TransientNetworkError(
        `GitHub adapter: request failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (response.ok) return response;

    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GithubRateLimitExceededError(
        `GitHub adapter: primary rate limit exceeded for ${url}`,
        parseResetAtMs(response.headers),
      );
    }

    throw new HttpError(`GitHub adapter: HTTP ${response.status} for ${url}`, response.status);
  }
}
