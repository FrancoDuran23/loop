// Zod boundary validation for every API input (spec §10: "Todo query param
// validado con Zod"). Kept in its own module, separate from routes.ts, so
// the coercion/range behavior can be unit-tested without spinning up a Hono
// app or Postgres.

import { z } from 'zod';
import { STAGES } from '../domain/entities.js';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** `GET /deals` query params. `c.req.query()` always yields strings (or
 * undefined) — `z.coerce.number()` converts before range-checking, and Zod
 * rejects non-numeric strings (`Number('notanumber')` is `NaN`, which
 * `z.coerce.number()` treats as an invalid_type failure, not a passing
 * NaN). `cursor` is validated here only as "a non-empty string" — its
 * actual structural validity (base64/JSON/shape) is `cursor.ts`'s job. */
export const dealsQuerySchema = z.object({
  minScore: z.coerce.number().min(0).max(100).optional(),
  sector: z.string().min(1).optional(),
  stage: z.enum(STAGES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  cursor: z.string().min(1).optional(),
});

export type DealsQuery = z.infer<typeof dealsQuerySchema>;

/** Path params (`:id`) are validated too, even though spec's literal
 * wording only mandates query params — same Zod-at-the-boundary discipline,
 * and a malformed id should fail with the SAME consistent error shape as a
 * malformed query, not a raw 500 from a downstream UUID-cast failure. */
export const uuidParamSchema = z.string().uuid();

/** `POST /runs` optional request body — spec only pins the response shape
 * (`202 { runId }`), not the request shape. `thesisPath` defaults to the
 * same `thesis.example.yaml` the CLI defaults to (src/cli.ts); `limitPerSource`
 * mirrors the CLI's `--limit` flag. Kept intentionally small — no `sources`
 * override in this phase (documented choice, see routes.ts). */
export const postRunsBodySchema = z.object({
  thesisPath: z.string().min(1).optional(),
  limitPerSource: z.coerce.number().int().positive().optional(),
});

export type PostRunsBody = z.infer<typeof postRunsBodySchema>;
