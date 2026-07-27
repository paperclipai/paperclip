import { createHash } from "node:crypto";

export type CloudStackRole = "owner" | "admin" | "member" | "support";

export interface CloudStackContext {
  stackId: string;
  stackRole: CloudStackRole;
}

/**
 * Deterministic company id for a cloud tenant stack. The trusted gateway
 * routes a stack's traffic to one company; deriving the id from the stack id
 * keeps that mapping stable whether or not the company row exists yet, so the
 * company can be created lazily (by onboarding) without any gateway change.
 */
export function cloudTenantCompanyId(stackId: string): string {
  const bytes = createHash("sha256").update(`paperclip-cloud-tenant-company:${stackId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Only a stack owner or admin may create (i.e. onboard) the stack's company. */
export function canCreateStackCompany(
  cloudStack: CloudStackContext | undefined | null,
): cloudStack is CloudStackContext {
  return cloudStack?.stackRole === "owner" || cloudStack?.stackRole === "admin";
}

/**
 * Postgres unique violation on the companies primary key — the forced stack
 * company id already exists (another owner/admin completed onboarding first).
 * Mirrors the cause-chain walk of isIssuePrefixConflict in companies.ts.
 */
export function isCompanyIdConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const maybe = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    const constraint = maybe.constraint ?? maybe.constraint_name;
    if (maybe.code === "23505" && constraint === "companies_pkey") return true;
    current = maybe.cause;
  }
  return false;
}
