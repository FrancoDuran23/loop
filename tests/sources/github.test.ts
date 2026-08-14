import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubAdapter, type FetchLike, type HttpResponseLike } from '../../src/sources/github.js';
import type { TokenBucket } from '../../src/pipeline/ratelimit.js';
import type { LoggerLike } from '../../src/sources/github.js';

// ---------------------------------------------------------------------------
// Fixtures — realistic GitHub REST API shapes.
//   - Search API: https://docs.github.com/en/rest/search/search#search-repositories
//   - Stargazers with timestamps: GET /repos/{owner}/{repo}/stargazers with
//     `Accept: application/vnd.github.star+json` returns `{starred_at, user}`
//     entries instead of bare user objects.
// Extra fields (node_id, license, topics, ...) are deliberately included to
// prove `raw` on the resulting SourceRecord is stored verbatim.
// ---------------------------------------------------------------------------

function repoItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 123456789,
    node_id: 'R_kgDOAbCdEf',
    name: 'loglane',
    full_name: 'janedev/loglane',
    owner: { login: 'janedev', id: 987654, type: 'User' },
    private: false,
    html_url: 'https://github.com/janedev/loglane',
    description: 'A tiny logging library for edge functions',
    fork: false,
    created_at: '2024-01-15T12:34:56Z',
    updated_at: '2024-05-01T00:00:00Z',
    pushed_at: '2024-04-30T00:00:00Z',
    homepage: 'https://loglane.dev',
    stargazers_count: 87,
    language: 'TypeScript',
    forks_count: 4,
    archived: false,
    disabled: false,
    license: null,
    topics: ['logging', 'edge'],
    visibility: 'public',
    score: 1.0,
    ...overrides,
  };
}

function searchResponse(items: readonly unknown[], totalCount = items.length): unknown {
  return { total_count: totalCount, incomplete_results: false, items };
}

function makeHeaders(record: Record<string, string> = {}): HttpResponseLike['headers'] {
  const lower = Object.fromEntries(Object.entries(record).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

function okResponse(body: unknown, headers: Record<string, string> = {}): HttpResponseLike {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders(headers),
    json: () => Promise.resolve(body),
  };
}

function errorResponse(status: number, headers: Record<string, string> = {}): HttpResponseLike {
  return { ok: false, status, headers: makeHeaders(headers), json: () => Promise.resolve({}) };
}

function stubRateLimiter(): TokenBucket {
  return { acquire: vi.fn(() => Promise.resolve()) };
}

function stubLogger(): LoggerLike {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const NOW = new Date('2024-06-01T00:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function recentStargazers(count: number, daysAgo: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    starred_at: new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000 - i * 1000).toISOString(),
    user: { login: `stargazer${i}` },
  }));
}

describe('GithubAdapter', () => {
  it('maps a search item into a fully-populated SourceRecord with github_stars and github_stars_delta_30d', async () => {
    const item = repoItem({ stargazers_count: 5 });
    const stargazers = [...recentStargazers(3, 10), ...recentStargazers(2, 45)]; // 3 within 30d, 2 outside
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url.includes('/search/repositories')) {
        return Promise.resolve(okResponse(searchResponse([item])));
      }
      return Promise.resolve(okResponse(stargazers));
    });
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });
    const controller = new AbortController();

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    const [record] = pages[0]!.records;
    expect(record!.source).toBe('github');
    expect(record!.sourceId).toBe('123456789');
    expect(record!.raw).toEqual(item);
    expect(record!.extracted.name).toBe('loglane');
    expect(record!.extracted.description).toBe('A tiny logging library for edge functions');
    expect(record!.extracted.url).toBe('https://github.com/janedev/loglane');
    expect(record!.extracted.domain).toBe('loglane.dev');
    expect(record!.extracted.people).toEqual(['janedev']);
    expect(record!.extracted.signals).toContainEqual({
      kind: 'github_stars',
      value: 5,
      observedAt: record!.fetchedAt,
      source: 'github',
      evidenceUrl: 'https://github.com/janedev/loglane',
    });
    expect(record!.extracted.signals).toContainEqual({
      kind: 'github_stars_delta_30d',
      value: 3,
      observedAt: record!.fetchedAt,
      source: 'github',
      evidenceUrl: 'https://github.com/janedev/loglane',
    });
  });

  it('omits domain when homepage is missing or not a valid URL', async () => {
    const item = repoItem({ homepage: null, stargazers_count: 0 });
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(searchResponse([item]))));
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect('domain' in pages[0]!.records[0]!.extracted).toBe(false);
  });

  it('skips the stargazers request entirely when stargazers_count is 0, and emits delta=0', async () => {
    const item = repoItem({ stargazers_count: 0 });
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(searchResponse([item]))));
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(fetchImpl).toHaveBeenCalledTimes(1); // search only, no stargazers call
    const delta = pages[0]!.records[0]!.extracted.signals.find(
      (s) => s.kind === 'github_stars_delta_30d',
    );
    expect(delta?.value).toBe(0);
  });

  it('fetches only the last stargazers page (bounded to 1 extra request per repo)', async () => {
    // 250 stars, 100 per page -> last page = ceil(250/100) = 3.
    const item = repoItem({ stargazers_count: 250 });
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url.includes('/search/repositories')) {
        return Promise.resolve(okResponse(searchResponse([item])));
      }
      expect(new URL(url).searchParams.get('page')).toBe('3');
      return Promise.resolve(okResponse(recentStargazers(2, 5)));
    });
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      void page;
    }

    // Exactly 2 requests total: 1 search + 1 bounded stargazers page.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('builds the default discovery query with a star floor, non-fork, non-archived filters', async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(searchResponse([]))));
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      void page;
    }

    const [calledUrl] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(calledUrl as string);
    expect(url.searchParams.get('q')).toBe('stars:>=10 fork:false archived:false');
    expect(url.searchParams.has('created')).toBe(false);
  });

  it('adds created:>{since} to the query when opts.since is provided (incremental fetch)', async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(searchResponse([]))));
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    for await (const page of adapter.fetch({
      since: '2024-01-01T00:00:00Z',
      limit: 10,
      signal: new AbortController().signal,
    })) {
      void page;
    }

    const [calledUrl] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(calledUrl as string);
    expect(url.searchParams.get('q')).toBe(
      'stars:>=10 fork:false archived:false created:>2024-01-01T00:00:00Z',
    );
  });

  it('acquires a rate-limit token before every underlying HTTP request', async () => {
    const item = repoItem({ stargazers_count: 5 });
    const fetchImpl: FetchLike = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/search/repositories')
          ? okResponse(searchResponse([item]))
          : okResponse(recentStargazers(1, 5)),
      ),
    );
    const rateLimiter = stubRateLimiter();
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter });

    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      void page;
    }

    // 1 search request + 1 stargazers request = 2 acquire() calls.
    expect(rateLimiter.acquire).toHaveBeenCalledTimes(2);
  });

  it('sends Authorization: Bearer {token} when a token is configured, omits it otherwise', async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(searchResponse([]))));

    const withToken = new GithubAdapter(fetchImpl, {
      rateLimiter: stubRateLimiter(),
      token: 'ghp_abc123',
    });
    for await (const page of withToken.fetch({ limit: 10, signal: new AbortController().signal })) {
      void page;
    }
    const [, initWithToken] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect((initWithToken as { headers?: Record<string, string> }).headers?.Authorization).toBe(
      'Bearer ghp_abc123',
    );

    vi.mocked(fetchImpl).mockClear();
    const withoutToken = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });
    for await (const page of withoutToken.fetch({
      limit: 10,
      signal: new AbortController().signal,
    })) {
      void page;
    }
    const [, initWithoutToken] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(
      (initWithoutToken as { headers?: Record<string, string> }).headers?.Authorization,
    ).toBeUndefined();
  });

  it('does not issue a request when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl: FetchLike = vi.fn();
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    await expect(async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
        void page;
      }
    }).rejects.toThrow(/abort/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('paginates across search result pages, stopping once opts.limit is reached', async () => {
    const items = [
      repoItem({ id: 1, name: 'a', stargazers_count: 0 }),
      repoItem({ id: 2, name: 'b', stargazers_count: 0 }),
    ];
    const item3 = repoItem({ id: 3, name: 'c', stargazers_count: 0 });
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '1') return Promise.resolve(okResponse(searchResponse(items, 3)));
      return Promise.resolve(okResponse(searchResponse([item3], 3)));
    });
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    const all = [];
    for await (const page of adapter.fetch({ limit: 3, signal: new AbortController().signal })) {
      all.push(...page.records);
    }

    expect(all).toHaveLength(3);
    expect(all.map((r) => r.sourceId)).toEqual(['1', '2', '3']);
  });

  it('fails fast without retrying on a permanent 4xx from the search endpoint', async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(errorResponse(422)));
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    await expect(async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
        void page;
      }
    }).rejects.toThrow(/422/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a transient 5xx from the search endpoint and eventually succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = vi.fn(() => {
      calls += 1;
      if (calls < 3) return Promise.resolve(errorResponse(503));
      return Promise.resolve(okResponse(searchResponse([])));
    });
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    const promise = (async () => {
      const pages = [];
      for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
        pages.push(page);
      }
      return pages;
    })();

    await vi.runAllTimersAsync();
    const pages = await promise;
    expect(pages).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('handles a GitHub primary-rate-limit 403 (X-RateLimit-Remaining: 0) by waiting until X-RateLimit-Reset, then retrying once — not via generic backoff', async () => {
    const resetAtSeconds = Math.floor((NOW.getTime() + 15_000) / 1000); // 15s from "now"
    let calls = 0;
    const fetchImpl: FetchLike = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          errorResponse(403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetAtSeconds),
          }),
        );
      }
      return Promise.resolve(okResponse(searchResponse([])));
    });
    const logger = stubLogger();
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter(), logger });

    let resolved = false;
    const promise = (async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
        void page;
      }
      resolved = true;
    })();

    // Should still be waiting before the reset time elapses.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resolved).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Cross the reset boundary -> exactly one retry, then success.
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(resolved).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('degrades gracefully when the stargazers request permanently fails: keeps github_stars, omits the delta, logs a warning', async () => {
    const item = repoItem({ stargazers_count: 5 });
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url.includes('/search/repositories')) {
        return Promise.resolve(okResponse(searchResponse([item])));
      }
      return Promise.resolve(errorResponse(500));
    });
    const logger = stubLogger();
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter(), logger });

    const promise = (async () => {
      const pages = [];
      for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
        pages.push(page);
      }
      return pages;
    })();

    await vi.runAllTimersAsync();
    const pages = await promise;

    const signals = pages[0]!.records[0]!.extracted.signals;
    expect(signals.some((s) => s.kind === 'github_stars')).toBe(true);
    expect(signals.some((s) => s.kind === 'github_stars_delta_30d')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('treats a 200 OK with an empty stargazers array as unavailable, not a real zero, and omits the delta', async () => {
    // Regression case: starCount > 0 guarantees the computed "last page"
    // must contain at least one real stargazer. An empty 200 response
    // (rather than an error status) is itself a sign of an unreliable
    // result — e.g. GitHub's stargazers endpoint being access-restricted
    // and silently returning no data instead of an error — and must not
    // be recorded as a confirmed "0 stars in the last 30 days".
    const item = repoItem({ stargazers_count: 5 });
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url.includes('/search/repositories')) {
        return Promise.resolve(okResponse(searchResponse([item])));
      }
      return Promise.resolve(okResponse([])); // 200 OK, empty body
    });
    const logger = stubLogger();
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter(), logger });

    const promise = (async () => {
      const pages = [];
      for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
        pages.push(page);
      }
      return pages;
    })();

    await vi.runAllTimersAsync();
    const pages = await promise;

    const signals = pages[0]!.records[0]!.extracted.signals;
    expect(signals.some((s) => s.kind === 'github_stars')).toBe(true);
    expect(signals.some((s) => s.kind === 'github_stars_delta_30d')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('computes nextWatermark as the max created_at seen across a page', async () => {
    const items = [
      repoItem({ id: 1, created_at: '2024-01-01T00:00:00Z', stargazers_count: 0 }),
      repoItem({ id: 2, created_at: '2024-03-15T00:00:00Z', stargazers_count: 0 }),
    ];
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(searchResponse(items))));
    const adapter = new GithubAdapter(fetchImpl, { rateLimiter: stubRateLimiter() });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages[0]!.nextWatermark).toBe('2024-03-15T00:00:00Z');
  });
});
