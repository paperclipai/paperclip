import { ISSUE_STATUSES } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

const KNOWN_ISSUE_STATUSES: readonly string[] = ISSUE_STATUSES;

// Express's default `qs` parser binds repeated query keys to a `string[]`,
// so a request like `?status=todo&status=in_progress` arrives here as an
// array. Single-key + comma-separated forms remain valid too; normalize the
// supported shapes once so the service contract matches runtime reality.
// Unknown statuses are rejected with a 400 so a typo does not read as
// "no matching issues".
export function parseStatusFilter(
  input: string | readonly string[] | undefined,
): string[] {
  if (input === undefined || input === null) return [];
  const entries = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [input]
      : [];
  const statuses = entries
    .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
    .map((status) => status.trim())
    .filter(Boolean);
  const unknown = statuses.filter((status) => !KNOWN_ISSUE_STATUSES.includes(status));
  if (unknown.length > 0) {
    throw badRequest(`Unknown issue status: ${unknown.join(", ")}`, {
      allowed: ISSUE_STATUSES,
    });
  }
  return statuses;
}
