import { describe, expect, it } from 'vitest';
import type { SourceRecord, SourceRecordId } from '../src/domain/entities.js';
import {
  createCliSourceRecordRepository,
  formatExtractedCompany,
  parseCliArgs,
} from '../src/cli.js';

function makeRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: crypto.randomUUID() as SourceRecordId,
    source: 'hackernews',
    sourceId: 'hn-1',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    raw: {},
    extracted: {
      name: 'Loglane',
      signals: [
        {
          kind: 'hn_points',
          value: 87,
          observedAt: '2026-01-01T00:00:00.000Z',
          source: 'hackernews',
        },
      ],
    },
    ...overrides,
  };
}

describe('parseCliArgs', () => {
  it('defaults to source=hackernews and a positive limit when no flags are given', () => {
    const options = parseCliArgs([]);
    expect(options).toEqual({ source: 'hackernews', limit: 5 });
  });

  it('reads --source and --limit flags', () => {
    const options = parseCliArgs(['--source', 'hackernews', '--limit', '10']);
    expect(options).toEqual({ source: 'hackernews', limit: 10 });
  });

  it('throws for an unsupported --source value', () => {
    expect(() => parseCliArgs(['--source', 'github'])).toThrow(/hackernews/i);
  });

  it('throws for a non-positive --limit value', () => {
    expect(() => parseCliArgs(['--limit', '0'])).toThrow(/positive/i);
    expect(() => parseCliArgs(['--limit', 'notanumber'])).toThrow(/positive/i);
  });
});

describe('formatExtractedCompany', () => {
  it('formats name, description, url, and signals when all are present', () => {
    const record = makeRecord({
      extracted: {
        name: 'Loglane',
        domain: 'loglane.dev',
        description: 'a tiny logging library',
        url: 'https://loglane.dev',
        signals: [
          {
            kind: 'hn_points',
            value: 87,
            observedAt: '2026-01-01T00:00:00.000Z',
            source: 'hackernews',
          },
          {
            kind: 'hn_show',
            value: 1,
            observedAt: '2026-01-01T00:00:00.000Z',
            source: 'hackernews',
          },
        ],
      },
    });

    const output = formatExtractedCompany(record);

    expect(output).toContain('Loglane (loglane.dev)');
    expect(output).toContain('a tiny logging library');
    expect(output).toContain('https://loglane.dev');
    expect(output).toContain('hn_points=87');
    expect(output).toContain('hn_show=1');
  });

  it('omits domain/description/url lines when the extraction has none of them', () => {
    const record = makeRecord({
      extracted: {
        name: 'MyThing',
        signals: [],
      },
    });

    const output = formatExtractedCompany(record);

    expect(output).toContain('MyThing');
    expect(output).not.toContain('(');
    expect(output).not.toContain('url:');
  });
});

describe('createCliSourceRecordRepository', () => {
  it('upsert is idempotent by (source, sourceId): second call returns isNew false, no duplicate', async () => {
    const repo = createCliSourceRecordRepository();
    const record = makeRecord({ sourceId: 'hn-1' });

    const first = await repo.upsert(record);
    const second = await repo.upsert({ ...record, fetchedAt: '2026-01-02T00:00:00.000Z' });

    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);

    const all = await repo.list(undefined, 10);
    expect(all).toHaveLength(1);
  });
});
