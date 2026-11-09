import { createHash, randomBytes } from "node:crypto";

// Per-process salt: the public catalog ids cannot be hashed back to a case.
const salt = randomBytes(16);

/**
 * Names and descriptions an agent can read must not reveal the eval: no case
 * ids, suite names, "E2E" or "test". A short salted digest keeps them unique
 * and stable within one attempt, without being reversible from public ids.
 */
export function neutralFixtureSuffix(...parts: readonly string[]): string {
  return createHash("sha256").update(salt).update(parts.join("\0")).digest("hex").slice(0, 8);
}
