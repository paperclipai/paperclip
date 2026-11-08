import { createHash } from "node:crypto";

/**
 * Names and descriptions an agent can read must not reveal the eval: no case
 * ids, suite names, "E2E" or "test". A short digest keeps them unique.
 */
export function neutralFixtureSuffix(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 8);
}
