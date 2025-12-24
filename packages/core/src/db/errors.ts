export type ErrorCode =
  | "not_found"
  | "conflict"
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "unavailable"
  | "internal";

export type ErrorDetails = Record<string, unknown>;

export class MementoError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: ErrorDetails;

  constructor(code: ErrorCode, message: string, details?: ErrorDetails) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class NotFoundError extends MementoError {
  constructor(message = "Not found", details?: ErrorDetails) {
    super("not_found", message, details);
  }
}

export class ConflictError extends MementoError {
  constructor(message = "Conflict", details?: ErrorDetails) {
    super("conflict", message, details);
  }
}

export class ValidationError extends MementoError {
  constructor(message = "Validation failed", details?: ErrorDetails) {
    super("validation", message, details);
  }
}

export class UnauthorizedError extends MementoError {
  constructor(message = "Unauthorized", details?: ErrorDetails) {
    super("unauthorized", message, details);
  }
}

export class ForbiddenError extends MementoError {
  constructor(message = "Forbidden", details?: ErrorDetails) {
    super("forbidden", message, details);
  }
}

export class RateLimitedError extends MementoError {
  constructor(message = "Rate limited", details?: ErrorDetails) {
    super("rate_limited", message, details);
  }
}

export class UnavailableError extends MementoError {
  constructor(message = "Service unavailable", details?: ErrorDetails) {
    super("unavailable", message, details);
  }
}

export class InternalError extends MementoError {
  constructor(message = "Internal error", details?: ErrorDetails) {
    super("internal", message, details);
  }
}

export function isMementoError(err: unknown): err is MementoError {
  return err instanceof MementoError;
}

export function toToolError(err: unknown): { code: ErrorCode; message: string; details?: ErrorDetails } {
  if (isMementoError(err)) {
    return { code: err.code, message: err.message, details: err.details };
  }

  if (err instanceof Error) {
    return { code: "internal", message: err.message };
  }

  return { code: "internal", message: "Unknown error" };
}
