export class HttpError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

// ---------------------------------------------------------------------------
// Postgres error helpers
// ---------------------------------------------------------------------------

/** Extract the constraint name from a Postgres error (node-postgres or pg-native). */
export function readConstraintName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("constraint" in error && typeof (error as { constraint?: unknown }).constraint === "string") {
    return (error as { constraint: string }).constraint;
  }
  if ("constraint_name" in error && typeof (error as { constraint_name?: unknown }).constraint_name === "string") {
    return (error as { constraint_name: string }).constraint_name;
  }
  return undefined;
}

/** Check whether a Postgres error is a unique-violation (23505) on one of the given constraints. */
export function isUniqueViolation(error: unknown, constraints: string[]): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  if ((error as { code?: string }).code !== "23505") return false;
  const name = readConstraintName(error);
  return name !== undefined && constraints.includes(name);
}
