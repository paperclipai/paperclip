import type { environmentLeases } from "@paperclipai/db";

export function isEnvironmentLeaseReattachable(
  lease: Pick<typeof environmentLeases.$inferSelect, "status" | "releasedAt" | "cleanupStatus" | "expiresAt">,
  now: number,
): boolean {
  return lease.status === "active" && lease.releasedAt === null && lease.cleanupStatus === null
    && !(lease.expiresAt !== null && new Date(lease.expiresAt).getTime() <= now);
}
