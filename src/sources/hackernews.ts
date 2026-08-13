// HackerNews SourceAdapter — Algolia HN Search API (`search_by_date`), no
// auth required. "Show HN" posts are the closest thing HN has to "a
// startup/project being launched" (spec §4/§6), so this adapter filters to
// `tags=show_hn` exclusively.
//
// This is the "simplest adapter, no auth" per spec §16's ordering — no
// rate-limiter/backoff framework here (that's Phase 7's `pipeline/ratelimit.ts`
// + `pipeline/retry.ts`, built for the GitHub adapter which actually needs
// it). A basic try/catch that surfaces a clear error is sufficient here.
//
// No global `fetch` mocking (design.md "Testing Strategy"): the adapter
// receives an injectable `FetchLike` function via its constructor instead of
// calling the global `fetch`, so tests pass a fake implementation directly.

import { z } from 'zod';
import type { FetchOptions, SourceAdapter, SourcePage } from '../domain/ports.js';
import type { ExtractedCompany, Signal, SourceRecord, SourceRecordId } from '../domain/entities.js';

const ALGOLIA_SEARCH_URL = 'https://hn.algolia.com/api/v1/search_by_date';
const HN_ITEM_URL_PREFIX = 'https://news.ycombinator.com/item?id=';
const ALGOLIA_MAX_HITS_PER_PAGE = 50;

// ---------------------------------------------------------------------------
// Injectable HTTP boundary — structurally compatible with the global `fetch`
// (a bound `fetch` can be passed as-is in production), but tests never touch
// the network or mock a global.
// ---------------------------------------------------------------------------

export interface HttpResponseLike {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { readonly signal: AbortSignal },
) => Promise<HttpResponseLike>;

// ---------------------------------------------------------------------------
// Algolia response validation. `hits` is validated as a record of unknown
// values (not stripped to a known-fields object) so `raw` on the resulting
// SourceRecord stays the FULL unmodified hit — including fields this adapter
// doesn't read (num_comments, _tags, story_text, ...) — for provenance and
// replay. The fields this adapter actually needs are extracted separately
// via `hitFieldsSchema`.
// ---------------------------------------------------------------------------

const algoliaResponseSchema = z.object({
  hits: z.array(z.record(z.string(), z.unknown())),
  page: z.number(),
  nbPages: z.number(),
});

const hitFieldsSchema = z.object({
  objectID: z.string(),
  created_at_i: z.number(),
  title: z.string(),
  url: z.string().nullable().optional(),
  points: z.number().nullable().optional(),
  author: z.string().nullable().optional(),
});

type HitFields = z.infer<typeof hitFieldsSchema>;
type RawHit = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Title parsing — Show HN titles look like "Show HN: ProjectName – one-liner"
// (en-dash or hyphen). Pragmatic split, not overthought: everything before
// the first standalone dash is the name, everything after is the
// description. Titles without a dash yield name-only (no description key —
// exactOptionalPropertyTypes requires omission, not `undefined`).
// ---------------------------------------------------------------------------

const SHOW_HN_PREFIX = /^Show HN:\s*/i;
const NAME_DASH_SPLIT = /^(.*?)\s+[–-]\s+(.+)$/;

export function parseShowHnTitle(title: string): {
  readonly name: string;
  readonly description?: string;
} {
  const withoutPrefix = title.replace(SHOW_HN_PREFIX, '').trim();
  const match = NAME_DASH_SPLIT.exec(withoutPrefix);
  if (match && match[1] !== undefined && match[2] !== undefined) {
    return { name: match[1].trim(), description: match[2].trim() };
  }
  return { name: withoutPrefix };
}

// ---------------------------------------------------------------------------
// Hit -> SourceRecord mapping
// ---------------------------------------------------------------------------

function hitToSourceRecord(raw: RawHit, fields: HitFields, fetchedAt: string): SourceRecord {
  const { name, description } = parseShowHnTitle(fields.title);
  const discussionUrl = `${HN_ITEM_URL_PREFIX}${fields.objectID}`;
  const points = fields.points ?? 0;

  const signals: Signal[] = [
    {
      kind: 'hn_points',
      value: points,
      observedAt: fetchedAt,
      source: 'hackernews',
      evidenceUrl: discussionUrl,
    },
    {
      kind: 'hn_show',
      value: 1,
      observedAt: fetchedAt,
      source: 'hackernews',
      evidenceUrl: discussionUrl,
    },
  ];

  const extracted: ExtractedCompany = {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(fields.url ? { url: fields.url } : {}),
    ...(fields.author ? { people: [fields.author] } : {}),
    signals,
  };

  return {
    id: crypto.randomUUID() as SourceRecordId,
    source: 'hackernews',
    sourceId: fields.objectID,
    fetchedAt,
    raw,
    extracted,
  };
}

function buildSearchUrl(params: {
  readonly since?: string;
  readonly page: number;
  readonly hitsPerPage: number;
}): string {
  const url = new URL(ALGOLIA_SEARCH_URL);
  url.searchParams.set('tags', 'show_hn');
  url.searchParams.set('page', String(params.page));
  url.searchParams.set('hitsPerPage', String(params.hitsPerPage));
  if (params.since) {
    url.searchParams.set('numericFilters', `created_at_i>${params.since}`);
  }
  return url.toString();
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class HackerNewsAdapter implements SourceAdapter {
  readonly source = 'hackernews' as const;

  constructor(private readonly fetchImpl: FetchLike) {}

  async *fetch(opts: FetchOptions): AsyncIterable<SourcePage> {
    const hitsPerPage = Math.max(1, Math.min(opts.limit, ALGOLIA_MAX_HITS_PER_PAGE));
    let page = 0;
    let yielded = 0;
    let watermark = opts.since;

    while (yielded < opts.limit) {
      if (opts.signal.aborted) {
        throw new Error('HackerNews adapter: fetch aborted', { cause: opts.signal.reason });
      }

      const url = buildSearchUrl({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        page,
        hitsPerPage,
      });
      const parsed = await this.fetchPage(url, opts.signal, page);

      const remaining = opts.limit - yielded;
      const rawHits = parsed.hits.slice(0, remaining);
      if (rawHits.length === 0) {
        break;
      }

      const fetchedAt = new Date().toISOString();
      let fields: HitFields[];
      try {
        fields = rawHits.map((hit) => hitFieldsSchema.parse(hit));
      } catch (err) {
        throw new Error(
          `HackerNews adapter: malformed hit on page ${page}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const records = rawHits.map((raw, i) => hitToSourceRecord(raw, fields[i]!, fetchedAt));
      const maxCreatedAt = Math.max(...fields.map((f) => f.created_at_i));
      watermark = watermark
        ? String(Math.max(Number(watermark), maxCreatedAt))
        : String(maxCreatedAt);
      yielded += records.length;

      yield { records, nextWatermark: watermark };

      const isLastAlgoliaPage = parsed.page + 1 >= parsed.nbPages;
      if (isLastAlgoliaPage) {
        break;
      }
      page += 1;
    }
  }

  private async fetchPage(
    url: string,
    signal: AbortSignal,
    page: number,
  ): Promise<z.infer<typeof algoliaResponseSchema>> {
    let response: HttpResponseLike;
    try {
      response = await this.fetchImpl(url, { signal });
    } catch (err) {
      throw new Error(
        `HackerNews adapter: request failed for page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw new Error(
        `HackerNews adapter: Algolia returned HTTP ${response.status} for page ${page}`,
      );
    }

    try {
      const body = await response.json();
      return algoliaResponseSchema.parse(body);
    } catch (err) {
      throw new Error(
        `HackerNews adapter: malformed Algolia response on page ${page}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }
}
