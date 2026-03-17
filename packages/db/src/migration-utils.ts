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
 * @param content Must already be normalized (CRLF → LF) via {@link normalizeMigrationContent}.
 */
export function computeMigrationHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Split a Drizzle migration file on `--> statement-breakpoint` markers. */
export function splitMigrationStatements(content: string): string[] {
  return content
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}
