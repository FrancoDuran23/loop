// Consistent error shape (spec §10: "Errores con un shape consistente
// ({ error: { code, message } })"). ONE error class, thrown from anywhere in
// a route handler (or a helper it calls, e.g. cursor.ts), caught by a
// SINGLE central `app.onError` handler (src/api/routes.ts) — not scattered
// per-route try/catch. src/api/** is infrastructure, outside the
// core-layer ESLint boundary.

export type ApiErrorCode = 'NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Readonly<Record<ApiErrorCode, number>> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number = STATUS_BY_CODE[code]) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export function notFound(message: string): ApiError {
  return new ApiError('NOT_FOUND', message);
}

export function validationError(message: string): ApiError {
  return new ApiError('VALIDATION_ERROR', message);
}

export function internalError(message: string): ApiError {
  return new ApiError('INTERNAL_ERROR', message);
}

/** The exact JSON body shape every error response MUST use (spec verbatim). */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
}

export function toApiErrorBody(err: ApiError): ApiErrorBody {
  return { error: { code: err.code, message: err.message } };
}
