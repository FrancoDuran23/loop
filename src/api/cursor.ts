// HTTP-facing wire encoding for domain/ports.ts's DealCursor — the port
// itself only knows the decoded { score, companyId } structural shape (spec
// §10: "Paginación por cursor, no por offset"); this module owns turning
// that into an opaque base64url token safe to embed in a query string, and
// back. Deliberately NOT a raw offset/page number: the token means "the
// exact (score, companyId) tiebreak-safe position after which to continue",
// not "skip N rows" — proven stable under insertion by
// tests/integration/deal-read-model.test.ts's cursor-walk test.

import { z } from 'zod';
import type { CompanyId } from '../domain/entities.js';
import type { DealCursor } from '../domain/ports.js';
import { ApiError } from './errors.js';

const cursorPayloadSchema = z.object({
  score: z.number(),
  companyId: z.string().min(1),
});

export function encodeDealCursor(cursor: DealCursor): string {
  const json = JSON.stringify({ score: cursor.score, companyId: cursor.companyId });
  return Buffer.from(json, 'utf-8').toString('base64url');
}

/** Decodes and validates an opaque cursor token. Throws a VALIDATION_ERROR
 * `ApiError` (never a raw exception) for anything malformed — garbage
 * base64, valid base64 with non-JSON content, or JSON that doesn't match
 * the expected `{ score, companyId }` shape — so route handlers can let it
 * propagate straight to the central `onError` handler. */
export function decodeDealCursor(token: string): DealCursor {
  let parsed: unknown;
  try {
    const json = Buffer.from(token, 'base64url').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    throw new ApiError('VALIDATION_ERROR', `Invalid cursor: "${token}" is not a valid cursor token`);
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(
      'VALIDATION_ERROR',
      `Invalid cursor: ${result.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return { score: result.data.score, companyId: result.data.companyId as CompanyId };
}
