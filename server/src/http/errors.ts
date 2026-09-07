import { HttpError } from "../errors.js";

export type HttpErrorCode = "NOT_FOUND" | "INTERNAL_SERVER_ERROR";

/**
 * Convert domain errors into the stable JSON response contract used by the
 * current server. Unknown failures are deliberately redacted.
 */
export function toHttpErrorResponse(error: unknown, code?: HttpErrorCode): Response {
  if (code === "NOT_FOUND") {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }

  if (error instanceof HttpError) {
    const body = error.details === undefined
      ? { error: error.message }
      : { error: error.message, details: error.details };
    return Response.json(body, {
      status: error.status,
      headers: { "cache-control": "no-store" },
    });
  }

  return Response.json(
    { error: "Internal server error" },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}
