// RSS/Atom SourceAdapter — public tech-news feeds, no auth, $0 (spec §2:
// "Fuente: RSS — Feeds públicos de medios tech — $0"). Spec §16 step 8 names
// this adapter but does not prescribe specific feed URLs or an extraction
// algorithm — both are this phase's own documented judgment calls.
//
// ---------------------------------------------------------------------------
// Chosen feeds (verified live and real during Phase 8 implementation, not
// guessed): TechCrunch's Startups category feed, The Verge's main feed, and
// Ars Technica's main feed. All three are free, public, no API key, no
// paywall, and were curled directly to confirm HTTP 200 + a genuine RSS/Atom
// content type before being hardcoded here. They cover exactly the
// "startups/launches getting press coverage" signal spec §2 asks for.
// The Verge's feed is Atom (not RSS 2.0) — this adapter, and `rss-parser`
// underneath it, handle both formats identically.
//
// ---------------------------------------------------------------------------
// Design decision: name-extraction precision (documented, not hidden)
// ---------------------------------------------------------------------------
// HN's "Show HN: Name – description" pattern and GitHub's structured repo
// `name` field both give a clean, low-noise company name directly. A general
// news article headline does not: "Acme raises $5M seed round" or "Widgetly
// launches public beta" are name-ISH, but "Investors sue Selena Gomez over
// her mental health startup" is not a company name at all. This adapter
// treats the article TITLE as the closest available proxy for
// `ExtractedCompany.name` — a defensible, simple choice, but genuinely
// noisier than HN/GitHub. This is a disclosed limitation, not a bug:
// downstream entity resolution's fuzzy blocking + similarity scoring
// (resolution/resolver.ts) is what has to compensate for RSS's lower
// precision, and a bad RSS-only "company" that never matches anything else
// simply stays its own low-signal entity rather than corrupting other
// sources' data (merge only happens on scored similarity, never blindly).
//
// ---------------------------------------------------------------------------
// Design decision: signal kind = 'launch' (documented)
// ---------------------------------------------------------------------------
// Of the 6 spec-defined `SignalKind` values, 'launch' is the closest fit for
// "a company got press coverage" — an announcement/coverage event, not a
// cumulative metric like github_stars or hn_points. `value: 1` mirrors HN's
// own hn_show signal shape (a boolean-ish occurrence, not a magnitude).
//
// ---------------------------------------------------------------------------
// Design decision: sourceId derivation (documented — idempotency contract)
// ---------------------------------------------------------------------------
// `UNIQUE(source, sourceId)` requires a STABLE id across repeated fetches of
// the same article. Preference order: RSS `<guid>` (rss-parser exposes this
// as `guid`), then Atom `<id>` (rss-parser does NOT normalize Atom's `<id>`
// into `guid` — confirmed by parsing a real Verge Atom entry during this
// phase's implementation: the field literally lands as `id`, not `guid`).
// If NEITHER is present (some minimal/malformed feeds omit both), fall back
// to a SHA-256 hex digest of the item's link (or title, if even the link is
// missing) — deterministic, so the same article hashes to the same
// sourceId on every run, satisfying the idempotency contract without a
// database round-trip.
//
// ---------------------------------------------------------------------------
// Design decision: incremental fetch is CLIENT-SIDE filtering (documented)
// ---------------------------------------------------------------------------
// Unlike GitHub's search API (`created:>{since}` query param) or HN's
// Algolia API (`numericFilters=created_at_i>{since}`), RSS/Atom has no
// standard server-side "since" query mechanism — a feed always returns
// whatever it currently publishes (typically its latest ~20-30 items).
// `FetchOptions.since` (an ISO 8601 string for this source) is therefore
// applied AFTER fetching the full feed: items whose resolved `observedAt`
// is not strictly after `since` are skipped. This is fine at RSS feed
// scale (small, bounded response sizes) — there is no unbounded-pagination
// risk the way there was for GitHub's stargazers endpoint.
//
// ---------------------------------------------------------------------------
// Design decision: no rate limiting, retry reused from Phase 7 (documented)
// ---------------------------------------------------------------------------
// Public RSS feeds are not API-quota-gated like GitHub's REST API, and spec
// §9's rate-limiting requirement is scoped to "por fuente" ceilings like
// GitHub's 60/h — nothing analogous exists for RSS, so no token bucket is
// wired in here. `pipeline/retry.ts`'s `withRetry` IS reused for the actual
// per-feed HTTP fetch (transient 5xx/429 retried with backoff+jitter, a
// permanent 4xx fails immediately) — a clean, cheap fit with the existing
// framework, consistent with the rest of the pipeline's error handling.
//
// ---------------------------------------------------------------------------
// Design decision: per-feed isolation (documented — new to this adapter)
// ---------------------------------------------------------------------------
// Unlike HN/GitHub (one endpoint per adapter), this adapter owns MULTIPLE
// independent feed URLs. A single feed returning non-XML, an HTTP error
// exhausting retries, or a genuinely empty channel MUST NOT crash the
// entire `fetch()` call — it should be skipped, and the remaining
// configured feeds should still be attempted. This mirrors spec §9's
// pipeline-level "isolated source failure" principle, applied one level
// down (isolated FEED failure within the single 'rss' source). An optional
// `onFeedError` hook (mirrors `retry.ts`'s `onRetry` hook shape) lets a
// caller observe/log a skipped feed without this adapter hard-depending on
// a logging library.
//
// No global `fetch` mocking (design.md "Testing Strategy", same convention
// as hackernews.ts/github.ts): the adapter receives an injectable
// `FetchLike` via its constructor. RSS responses are XML text, not JSON, so
// this adapter's `FetchLike` returns `.text()` instead of `.json()`.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import Parser from 'rss-parser';
import type { FetchOptions, SourceAdapter, SourcePage } from '../domain/ports.js';
import type { ExtractedCompany, Signal, SourceRecord, SourceRecordId } from '../domain/entities.js';
import { HttpError, TransientNetworkError, withRetry } from '../pipeline/retry.js';

// ---------------------------------------------------------------------------
// Feed list — small, named, easy to extend. Matches spec §15's own
// "adding a source is a new file/config entry" philosophy, one level down:
// adding a fourth FEED here needs no code change, just a new list entry.
// ---------------------------------------------------------------------------

export interface RssFeedConfig {
  readonly name: string;
  readonly url: string;
}

export const DEFAULT_RSS_FEEDS: readonly RssFeedConfig[] = [
  { name: 'techcrunch-startups', url: 'https://techcrunch.com/category/startups/feed/' },
  { name: 'theverge', url: 'https://www.theverge.com/rss/index.xml' },
  { name: 'arstechnica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
];

const RSS_RETRY_OPTIONS = { maxAttempts: 3, baseDelayMs: 300, maxDelayMs: 4_000 } as const;

// ---------------------------------------------------------------------------
// Injectable HTTP boundary — structurally compatible with the global
// `fetch`'s `Response` (a bound `fetch` can be passed as-is in production),
// but tests never touch the network or mock a global. Returns `.text()`
// (raw XML), not `.json()` — unlike hackernews.ts/github.ts's JSON APIs.
// ---------------------------------------------------------------------------

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<HttpResponseLike>;

// ---------------------------------------------------------------------------
// rss-parser is instantiated with an explicit item-fields generic
// (`Record<string, unknown>`) instead of relying on its default
// `{[key: string]: any}` — this keeps `.items[n]` typed without `any`
// leaking into this file, per the project's "zero `any` outside
// Zod-validated boundaries" rule. The fields this adapter actually reads
// are separately validated via `rssItemFieldsSchema` below (same pattern as
// hackernews.ts's `hitFieldsSchema` / github.ts's `searchItemFieldsSchema`):
// a per-item `safeParse` so ONE malformed item (e.g. missing title) is
// skipped rather than failing the whole feed.
// ---------------------------------------------------------------------------

type RssParserOutput = Parser.Output<Record<string, unknown>>;
type RawItem = Record<string, unknown>;

const rssItemFieldsSchema = z.object({
  title: z.string().optional(),
  link: z.string().optional(),
  guid: z.string().optional(),
  id: z.string().optional(), // Atom <id> — rss-parser does not fold this into `guid`
  pubDate: z.string().optional(),
  isoDate: z.string().optional(),
  creator: z.string().optional(),
  author: z.string().optional(), // Atom author (rss-parser flattens <author><name>)
  contentSnippet: z.string().optional(),
  summary: z.string().optional(),
});

type RssItemFields = z.infer<typeof rssItemFieldsSchema>;

function parseRssItemFields(raw: RawItem): RssItemFields | undefined {
  const result = rssItemFieldsSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

// ---------------------------------------------------------------------------
// sourceId derivation — see module doc comment "Design decision: sourceId
// derivation" above.
// ---------------------------------------------------------------------------

function stableSourceId(fields: RssItemFields): string {
  const guid = fields.guid?.trim() || fields.id?.trim();
  if (guid) return guid;
  const basis = fields.link?.trim() || fields.title?.trim() || '';
  return createHash('sha256').update(basis).digest('hex');
}

// ---------------------------------------------------------------------------
// observedAt resolution — prefers rss-parser's own normalized `isoDate`
// (present for both RSS `pubDate` and Atom `published`/`updated` in
// practice), falls back to parsing `pubDate` manually, and finally falls
// back to the fetch time itself so a record is never dropped purely for
// lacking a parseable date.
// ---------------------------------------------------------------------------

function resolveObservedAt(fields: RssItemFields, fetchedAt: string): string {
  if (fields.isoDate) return fields.isoDate;
  if (fields.pubDate) {
    const parsed = new Date(fields.pubDate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fetchedAt;
}

// ---------------------------------------------------------------------------
// Item -> SourceRecord mapping
// ---------------------------------------------------------------------------

function itemToSourceRecord(
  raw: RawItem,
  fields: RssItemFields,
  observedAt: string,
  fetchedAt: string,
): SourceRecord {
  const name = fields.title!.trim();
  const link = fields.link?.trim();
  const person = fields.creator?.trim() || fields.author?.trim();
  const description = fields.contentSnippet?.trim() || fields.summary?.trim();

  const signals: Signal[] = [
    {
      kind: 'launch',
      value: 1,
      observedAt,
      source: 'rss',
      ...(link ? { evidenceUrl: link } : {}),
    },
  ];

  const extracted: ExtractedCompany = {
    name,
    ...(description ? { description } : {}),
    ...(link ? { url: link } : {}),
    ...(person ? { people: [person] } : {}),
    signals,
  };

  return {
    id: crypto.randomUUID() as SourceRecordId,
    source: 'rss',
    sourceId: stableSourceId(fields),
    fetchedAt,
    raw,
    extracted,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface RssAdapterOptions {
  readonly feeds?: readonly RssFeedConfig[];
  readonly parser?: Parser<Record<string, never>, Record<string, unknown>>;
  /** Observability hook for a skipped feed — mirrors retry.ts's onRetry shape. */
  readonly onFeedError?: (feed: RssFeedConfig, error: unknown) => void;
}

export class RssAdapter implements SourceAdapter {
  readonly source = 'rss' as const;

  private readonly feeds: readonly RssFeedConfig[];
  private readonly parser: Parser<Record<string, never>, Record<string, unknown>>;
  private readonly onFeedError: (feed: RssFeedConfig, error: unknown) => void;

  constructor(
    private readonly fetchImpl: FetchLike,
    options: RssAdapterOptions = {},
  ) {
    this.feeds = options.feeds ?? DEFAULT_RSS_FEEDS;
    this.parser = options.parser ?? new Parser<Record<string, never>, Record<string, unknown>>();
    this.onFeedError = options.onFeedError ?? ((): void => undefined);
  }

  async *fetch(opts: FetchOptions): AsyncIterable<SourcePage> {
    let yielded = 0;
    let watermark = opts.since;

    for (const feedConfig of this.feeds) {
      if (yielded >= opts.limit) break;
      if (opts.signal.aborted) {
        throw new Error('RSS adapter: fetch aborted', { cause: opts.signal.reason });
      }

      let rawItems: RawItem[];
      try {
        const xml = await this.requestFeedText(feedConfig, opts.signal);
        const parsed: RssParserOutput = await this.parser.parseString(xml);
        rawItems = parsed.items ?? [];
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        this.onFeedError(feedConfig, err);
        continue;
      }

      const fetchedAt = new Date().toISOString();
      const records: SourceRecord[] = [];

      for (const raw of rawItems) {
        if (yielded + records.length >= opts.limit) break;

        const fields = parseRssItemFields(raw);
        if (!fields?.title?.trim()) continue; // malformed/titleless item, skip just this item

        const observedAt = resolveObservedAt(fields, fetchedAt);
        if (opts.since && observedAt <= opts.since) continue; // client-side since-filter

        records.push(itemToSourceRecord(raw, fields, observedAt, fetchedAt));
      }

      if (records.length === 0) continue;

      yielded += records.length;
      watermark = records.reduce(
        (max, r) =>
          r.extracted.signals[0]!.observedAt > max ? r.extracted.signals[0]!.observedAt : max,
        watermark ?? records[0]!.extracted.signals[0]!.observedAt,
      );

      yield { records, nextWatermark: watermark };
    }
  }

  private async requestFeedText(feedConfig: RssFeedConfig, signal: AbortSignal): Promise<string> {
    return withRetry(async () => {
      let response: HttpResponseLike;
      try {
        response = await this.fetchImpl(feedConfig.url, { signal });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        throw new TransientNetworkError(
          `RSS adapter: request failed for feed "${feedConfig.name}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (!response.ok) {
        throw new HttpError(
          `RSS adapter: feed "${feedConfig.name}" returned HTTP ${response.status}`,
          response.status,
        );
      }

      return response.text();
    }, RSS_RETRY_OPTIONS);
  }
}
