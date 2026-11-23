import { sql } from "drizzle-orm";
import { environmentLeases } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";

export const REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY = "reusableSandboxKeptAfterReplacement";

export function reusableSandboxKeptAfterReplacement(lease: Pick<EnvironmentLease, "metadata">): boolean {
  const marker = lease.metadata?.[REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY];
  return typeof marker === "object" && marker !== null && !Array.isArray(marker);
}

export function reusableSandboxNotKeptAfterReplacementSql() {
  return sql`not coalesce(${environmentLeases.metadata} ? ${REUSABLE_SANDBOX_KEPT_AFTER_REPLACEMENT_KEY}, false)`;
}
