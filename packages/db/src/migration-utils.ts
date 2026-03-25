import { createHash } from "node:crypto";

/**
 * Normalize CRLF → LF so hashes are consistent across platforms.
 * npm-published dist/ uses LF; git checkouts on Windows use CRLF.
 */
export function normalizeMigrationContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

/**
 * Compute a SHA-256 hex digest for migration content.
 * Normalizes CRLF → LF internally so callers don't need to pre-normalize.
 */
export function computeMigrationHash(content: string): string {
  return createHash("sha256").update(normalizeMigrationContent(content)).digest("hex");
}

/**
 * Split a Drizzle migration file on `--> statement-breakpoint` markers.
 * @param content Should already be normalized (CRLF → LF) via {@link normalizeMigrationContent}
 *   so that line-ending differences don't affect statement boundaries or downstream hashing.
 */
export function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
