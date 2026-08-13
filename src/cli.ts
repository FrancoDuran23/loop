// Minimal CLI proving the HackerNews adapter + SourceRecordRepository work
// end-to-end. No thesis scoring, no Postgres, no other sources — those are
// later phases. Run: `npm run pipeline` (or `npm run pipeline -- --limit 10`).
//
// The SourceRecordRepository used here is a small, local, CLI-scoped
// implementation — NOT an import of `tests/doubles/in-memory-repository.ts`.
// That file is deliberately kept under `tests/` (design.md's "Two
// Repository Implementations" table), and `tsconfig.build.json` restricts
// `rootDir` to `src/` for `npm run build`; a production entrypoint under
// `src/` importing across that boundary would break the build. The
// fully-tested, richer in-memory repos (blocking-key lookup, merge, etc.)
// live in tests/doubles/ and back the pipeline/contract tests instead.

import { pathToFileURL } from 'node:url';
import type { SourceRecord, SourceRecordId } from './domain/entities.js';
import type { SourceRecordRepository } from './domain/ports.js';
import { HackerNewsAdapter, type FetchLike } from './sources/hackernews.js';

const DEFAULT_LIMIT = 5;
const SUPPORTED_SOURCES = ['hackernews'] as const;

// ---------------------------------------------------------------------------
// CLI-scoped in-memory SourceRecordRepository — upsert dedup only, no
// blocking keys, no merge. See module header for why this isn't shared with
// tests/doubles/in-memory-repository.ts.
// ---------------------------------------------------------------------------

export function createCliSourceRecordRepository(): SourceRecordRepository {
  const byId = new Map<SourceRecordId, SourceRecord>();
  const idByNaturalKey = new Map<string, SourceRecordId>();
  const insertionOrder: SourceRecordId[] = [];

  return {
    async upsert(record) {
      const key = `${record.source}:${record.sourceId}`;
      const existingId = idByNaturalKey.get(key);
      if (existingId) {
        byId.set(existingId, { ...record, id: existingId });
        return { id: existingId, isNew: false };
      }
      idByNaturalKey.set(key, record.id);
      byId.set(record.id, record);
      insertionOrder.push(record.id);
      return { id: record.id, isNew: true };
    },

    async list(after, limit) {
      const startIndex = after ? insertionOrder.indexOf(after) + 1 : 0;
      const page = insertionOrder.slice(startIndex, startIndex + limit);
      const records: SourceRecord[] = [];
      for (const id of page) {
        const record = byId.get(id);
        if (record) {
          records.push(record);
        }
      }
      return records;
    },
  };
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

export interface CliOptions {
  readonly source: (typeof SUPPORTED_SOURCES)[number];
  readonly limit: number;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let source = 'hackernews';
  let limitInput = String(DEFAULT_LIMIT);

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--source' && value !== undefined) {
      source = value;
      i += 1;
    } else if (flag === '--limit' && value !== undefined) {
      limitInput = value;
      i += 1;
    }
  }

  if (!SUPPORTED_SOURCES.includes(source as (typeof SUPPORTED_SOURCES)[number])) {
    throw new Error(
      `Unsupported --source "${source}". Only "hackernews" is wired up in this phase.`,
    );
  }

  const limit = Number(limitInput);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`--limit must be a positive number, got "${limitInput}"`);
  }

  return { source: 'hackernews', limit };
}

// ---------------------------------------------------------------------------
// Output formatting (pure — unit tested)
// ---------------------------------------------------------------------------

export function formatExtractedCompany(record: SourceRecord): string {
  const { extracted } = record;
  const lines: string[] = [
    `- ${extracted.name}${extracted.domain ? ` (${extracted.domain})` : ''}`,
  ];

  if (extracted.description) {
    lines.push(`  ${extracted.description}`);
  }
  if (extracted.url) {
    lines.push(`  url: ${extracted.url}`);
  }
  for (const signal of extracted.signals) {
    lines.push(`  signal: ${signal.kind}=${signal.value}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseCliArgs(argv);
  const fetchImpl: FetchLike = (url, init) => fetch(url, init);
  const adapter = new HackerNewsAdapter(fetchImpl);
  const sourceRecords = createCliSourceRecordRepository();
  const controller = new AbortController();

  let printedCount = 0;
  for await (const page of adapter.fetch({ limit: options.limit, signal: controller.signal })) {
    for (const record of page.records) {
      const { isNew } = await sourceRecords.upsert(record);
      console.log(formatExtractedCompany(record));
      console.log(`  (source=${record.source} isNew=${isNew})`);
      printedCount += 1;
    }
  }

  if (printedCount === 0) {
    console.log('No companies fetched.');
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
