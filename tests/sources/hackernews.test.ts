import { describe, expect, it, vi } from 'vitest';
import {
  HackerNewsAdapter,
  parseShowHnTitle,
  type FetchLike,
  type HttpResponseLike,
} from '../../src/sources/hackernews.js';

// ---------------------------------------------------------------------------
// Fixtures — hand-written, realistic Algolia `search_by_date` response shapes
// for `tags=show_hn`. Extra fields (num_comments, _tags, story_text) are
// deliberately included to prove `raw` is stored verbatim, not stripped.
// ---------------------------------------------------------------------------

const HIT_WITH_DASH = {
  objectID: '40111111',
  created_at_i: 1_700_000_100,
  title: 'Show HN: Loglane – a tiny logging library for edge functions',
  url: 'https://loglane.dev',
  points: 87,
  author: 'janedev',
  num_comments: 12,
  _tags: ['story', 'show_hn', 'author_janedev'],
};

const HIT_WITH_HYPHEN = {
  objectID: '40222222',
  created_at_i: 1_700_000_200,
  title: 'Show HN: PixelCanvas - collaborative pixel art in the browser',
  url: 'https://pixelcanvas.example.com',
  points: 42,
  author: 'artdev',
  num_comments: 3,
  _tags: ['story', 'show_hn'],
};

const HIT_NO_DASH = {
  objectID: '40333333',
  created_at_i: 1_700_000_300,
  title: 'Show HN: MyThing',
  url: null,
  points: 5,
  author: null,
  num_comments: 0,
  _tags: ['story', 'show_hn'],
};

function algoliaResponse(hits: readonly unknown[], page: number, nbPages: number): unknown {
  return { hits, nbHits: hits.length, page, nbPages, hitsPerPage: hits.length };
}

function okResponse(body: unknown): HttpResponseLike {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

describe('parseShowHnTitle', () => {
  it('splits an en-dash-separated title into name and description', () => {
    const result = parseShowHnTitle('Show HN: Loglane – a tiny logging library for edge functions');
    expect(result).toEqual({
      name: 'Loglane',
      description: 'a tiny logging library for edge functions',
    });
  });

  it('splits a hyphen-separated title into name and description', () => {
    const result = parseShowHnTitle(
      'Show HN: PixelCanvas - collaborative pixel art in the browser',
    );
    expect(result).toEqual({
      name: 'PixelCanvas',
      description: 'collaborative pixel art in the browser',
    });
  });

  it('returns name-only (no description key) when there is no dash', () => {
    const result = parseShowHnTitle('Show HN: MyThing');
    expect(result).toEqual({ name: 'MyThing' });
    expect('description' in result).toBe(false);
  });

  it('keeps the remainder after the first dash when the title has multiple dashes', () => {
    const result = parseShowHnTitle('Show HN: Foo Bar – Baz – Qux');
    expect(result).toEqual({ name: 'Foo Bar', description: 'Baz – Qux' });
  });
});

describe('HackerNewsAdapter', () => {
  it('maps a Show HN hit into a fully-populated SourceRecord', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve(okResponse(algoliaResponse([HIT_WITH_DASH], 0, 1))),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    const [record] = pages[0]!.records;
    expect(record).toBeDefined();
    expect(record!.source).toBe('hackernews');
    expect(record!.sourceId).toBe('40111111');
    expect(record!.raw).toEqual(HIT_WITH_DASH);
    expect(record!.extracted.name).toBe('Loglane');
    expect(record!.extracted.description).toBe('a tiny logging library for edge functions');
    expect(record!.extracted.url).toBe('https://loglane.dev');
    expect(record!.extracted.people).toEqual(['janedev']);
    expect(record!.extracted.signals).toEqual([
      {
        kind: 'hn_points',
        value: 87,
        observedAt: record!.fetchedAt,
        source: 'hackernews',
        evidenceUrl: 'https://news.ycombinator.com/item?id=40111111',
      },
      {
        kind: 'hn_show',
        value: 1,
        observedAt: record!.fetchedAt,
        source: 'hackernews',
        evidenceUrl: 'https://news.ycombinator.com/item?id=40111111',
      },
    ]);
  });

  it('omits url and people when the hit has no url/author', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve(okResponse(algoliaResponse([HIT_NO_DASH], 0, 1))),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
      pages.push(page);
    }

    const [record] = pages[0]!.records;
    expect('url' in record!.extracted).toBe(false);
    expect('people' in record!.extracted).toBe(false);
    expect(record!.extracted.signals[0]!.value).toBe(5);
  });

  it('paginates across multiple Algolia pages, stopping once opts.limit is reached', async () => {
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '0') {
        return Promise.resolve(okResponse(algoliaResponse([HIT_WITH_DASH, HIT_WITH_HYPHEN], 0, 2)));
      }
      return Promise.resolve(okResponse(algoliaResponse([HIT_NO_DASH], 1, 2)));
    });
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    const allRecords = [];
    for await (const page of adapter.fetch({ limit: 3, signal: controller.signal })) {
      allRecords.push(...page.records);
    }

    expect(allRecords).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(allRecords.map((r) => r.sourceId)).toEqual(['40111111', '40222222', '40333333']);
  });

  it('stops yielding once opts.limit is reached even if more hits are available on the page', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve(
        okResponse(algoliaResponse([HIT_WITH_DASH, HIT_WITH_HYPHEN, HIT_NO_DASH], 0, 1)),
      ),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    const allRecords = [];
    for await (const page of adapter.fetch({ limit: 2, signal: controller.signal })) {
      allRecords.push(...page.records);
    }

    expect(allRecords).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requests tags=show_hn and no numericFilters when opts.since is not set', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve(okResponse(algoliaResponse([HIT_WITH_DASH], 0, 1))),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
      void page;
    }

    const [calledUrl] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(calledUrl);
    expect(url.searchParams.get('tags')).toBe('show_hn');
    expect(url.searchParams.has('numericFilters')).toBe(false);
  });

  it('sends numericFilters=created_at_i>{since} when opts.since is provided', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve(okResponse(algoliaResponse([HIT_WITH_DASH], 0, 1))),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    for await (const page of adapter.fetch({
      since: '1700000000',
      limit: 10,
      signal: controller.signal,
    })) {
      void page;
    }

    const [calledUrl] = vi.mocked(fetchImpl).mock.calls[0]!;
    const url = new URL(calledUrl);
    expect(url.searchParams.get('numericFilters')).toBe('created_at_i>1700000000');
  });

  it('computes nextWatermark as the max created_at_i seen across a page', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve(okResponse(algoliaResponse([HIT_WITH_DASH, HIT_WITH_HYPHEN], 0, 1))),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
      pages.push(page);
    }

    expect(pages[0]!.nextWatermark).toBe('1700000200');
  });

  it('does not issue a further request once the signal is already aborted', async () => {
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      const page = new URL(url).searchParams.get('page');
      if (page === '0') {
        return Promise.resolve(okResponse(algoliaResponse([HIT_WITH_DASH, HIT_WITH_HYPHEN], 0, 3)));
      }
      return Promise.resolve(okResponse(algoliaResponse([HIT_NO_DASH], 1, 3)));
    });
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    await expect(async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
        void page;
        controller.abort();
      }
    }).rejects.toThrow(/abort/i);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when Algolia responds with a non-ok HTTP status', async () => {
    const fetchImpl: FetchLike = vi.fn(() =>
      Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    await expect(async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
        void page;
      }
    }).rejects.toThrow(/HackerNews adapter.*500/);
  });

  it('throws a clear error when the response body does not match the expected shape', async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse({ nope: true })));
    const adapter = new HackerNewsAdapter(fetchImpl);
    const controller = new AbortController();

    await expect(async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
        void page;
      }
    }).rejects.toThrow(/HackerNews adapter/);
  });
});
