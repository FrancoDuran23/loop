// In-memory implementations of the 4 domain repository ports (design.md
// "Two Repository Implementations"). No SQL, no Docker. Backs the Phase 3
// CLI/pipeline and later phases' contract suite, which runs the same shared
// suite once against this double and once against the real Postgres impl.
//
// Blocking-key derivation here (`computeCompanyBlockingKeys`) is
// intentionally simple — lowercase domain + name-prefix-4 + name trigrams —
// and self-contained. It is NOT the real normalization algorithm
// (accents/corporate-suffix stripping), which is Phase 4's
// `resolution/normalize.ts`. This module only needs to index and look up by
// whatever keys a caller supplies.

import type {
  Company,
  CompanyId,
  RunId,
  RunStats,
  RunStatus,
  ScoredDeal,
  Signal,
  SourceName,
  SourceRecord,
  SourceRecordId,
} from '../../src/domain/entities.js';
import type {
  CompanyRepository,
  RunRepository,
  ScoredDealRepository,
  SourceRecordRepository,
} from '../../src/domain/ports.js';

// ---------------------------------------------------------------------------
// Blocking keys
// ---------------------------------------------------------------------------

const TRIGRAM_LENGTH = 3;
const NAME_PREFIX_LENGTH = 4;

export function computeCompanyBlockingKeys(
  company: Pick<Company, 'canonicalName'> & Partial<Pick<Company, 'domain'>>,
): readonly string[] {
  const keys = new Set<string>();
  if (company.domain) {
    keys.add(`domain:${company.domain.toLowerCase()}`);
  }
  const name = company.canonicalName.toLowerCase();
  if (name.length >= NAME_PREFIX_LENGTH) {
    keys.add(`name4:${name.slice(0, NAME_PREFIX_LENGTH)}`);
  }
  for (let i = 0; i <= name.length - TRIGRAM_LENGTH; i += 1) {
    keys.add(`trigram:${name.slice(i, i + TRIGRAM_LENGTH)}`);
  }
  return Array.from(keys);
}

// ---------------------------------------------------------------------------
// CompanyRepository
// ---------------------------------------------------------------------------

export function createInMemoryCompanyRepository(): CompanyRepository {
  const byId = new Map<CompanyId, Company>();
  const byDomain = new Map<string, CompanyId>();
  const byBlockingKey = new Map<string, Set<CompanyId>>();

  function index(company: Company): void {
    if (company.domain) {
      byDomain.set(company.domain, company.id);
    }
    for (const key of computeCompanyBlockingKeys(company)) {
      let bucket = byBlockingKey.get(key);
      if (!bucket) {
        bucket = new Set();
        byBlockingKey.set(key, bucket);
      }
      bucket.add(company.id);
    }
  }

  return {
    async findByDomain(domain) {
      const id = byDomain.get(domain);
      return id ? byId.get(id) : undefined;
    },

    async findByBlockingKeys(keys) {
      const ids = new Set<CompanyId>();
      for (const key of keys) {
        for (const id of byBlockingKey.get(key) ?? []) {
          ids.add(id);
        }
      }
      const companies: Company[] = [];
      for (const id of ids) {
        const company = byId.get(id);
        if (company) {
          companies.push(company);
        }
      }
      return companies;
    },

    async save(company) {
      // Simplification: re-saving the same id with a CHANGED domain/name
      // leaves the old blocking-key/domain index entries pointing at this
      // id too (harmless — they still resolve to the current object via
      // byId — but stale keys aren't pruned). Not exercised by Phase 3's
      // required behaviors (upsert-by-id idempotency isn't domain-change
      // aware); revisit if a later phase needs strict reindexing on update.
      byId.set(company.id, company);
      index(company);
    },

    async linkSourceRecord(id, rec) {
      const company = byId.get(id);
      if (!company || company.memberRecordIds.includes(rec)) {
        return;
      }
      byId.set(id, { ...company, memberRecordIds: [...company.memberRecordIds, rec] });
    },

    async appendSignals(id, signals) {
      const company = byId.get(id);
      if (!company || signals.length === 0) {
        return;
      }
      byId.set(id, { ...company, signals: [...company.signals, ...signals] });
    },

    async setEmbedding(id, embedding) {
      const company = byId.get(id);
      if (!company) {
        return;
      }
      byId.set(id, { ...company, embedding });
    },

    async merge(survivorId, absorbedId, ev) {
      const survivor = byId.get(survivorId);
      const absorbed = byId.get(absorbedId);
      if (!survivor || !absorbed) {
        throw new Error(
          `merge: unknown company id (survivor=${survivorId}, absorbed=${absorbedId})`,
        );
      }

      const memberRecordIds = Array.from(
        new Set([...survivor.memberRecordIds, ...absorbed.memberRecordIds]),
      );
      const signals: Signal[] = [...survivor.signals, ...absorbed.signals];
      const flags =
        ev.confidence === 'uncertain'
          ? Array.from(new Set([...survivor.flags, 'merge_incierto']))
          : survivor.flags;

      const updatedSurvivor: Company = { ...survivor, memberRecordIds, signals, flags };
      const updatedAbsorbed: Company = { ...absorbed, mergedInto: survivorId };

      // Non-destructive: the absorbed row is updated in place (mergedInto
      // pointer added) and stays fully indexed (domain + blocking keys) —
      // never removed from `byId`, never de-indexed. It must remain
      // retrievable via findByDomain/findByBlockingKeys exactly as before;
      // callers check `mergedInto` to know it has been superseded.
      byId.set(survivorId, updatedSurvivor);
      byId.set(absorbedId, updatedAbsorbed);
      index(updatedSurvivor);
      index(updatedAbsorbed);
    },
  };
}

// ---------------------------------------------------------------------------
// SourceRecordRepository
// ---------------------------------------------------------------------------

export function createInMemorySourceRecordRepository(): SourceRecordRepository {
  const byId = new Map<SourceRecordId, SourceRecord>();
  const idByNaturalKey = new Map<string, SourceRecordId>();
  const insertionOrder: SourceRecordId[] = [];

  function naturalKey(source: SourceName, sourceId: string): string {
    return `${source}:${sourceId}`;
  }

  return {
    async upsert(record) {
      const key = naturalKey(record.source, record.sourceId);
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
// RunRepository
// ---------------------------------------------------------------------------

interface RunState {
  readonly thesis: string;
  status?: RunStatus;
  stats?: RunStats;
}

export function createInMemoryRunRepository(): RunRepository {
  const runs = new Map<RunId, RunState>();
  const watermarks = new Map<SourceName, string>();

  return {
    async start(id, thesis) {
      runs.set(id, { thesis });
    },

    async watermark(source) {
      return watermarks.get(source);
    },

    async setWatermark(source, w) {
      watermarks.set(source, w);
    },

    async finish(id, status, stats) {
      const run = runs.get(id);
      if (!run) {
        throw new Error(`finish: run ${id} was never started`);
      }
      runs.set(id, { ...run, status, stats });
    },
  };
}

// ---------------------------------------------------------------------------
// ScoredDealRepository
// ---------------------------------------------------------------------------

// Extends the pure port with a synchronous `all()` inspector. The port
// itself has no read method (that's DealReadModel's job, deferred to
// Phase 9), but design.md's testing strategy requires verifying idempotent
// re-run behavior for scored deals — impossible through the port alone.
export interface InMemoryScoredDealRepository extends ScoredDealRepository {
  all(runId: RunId): readonly ScoredDeal[];
}

export function createInMemoryScoredDealRepository(): InMemoryScoredDealRepository {
  const dealsByRun = new Map<RunId, readonly ScoredDeal[]>();

  return {
    async saveAll(runId, deals) {
      dealsByRun.set(runId, [...deals]);
    },

    all(runId) {
      return dealsByRun.get(runId) ?? [];
    },
  };
}
