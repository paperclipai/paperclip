import { resourceLifecycleEvents, type Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";

/** Call inside the transaction that creates the resource or approves the hire. */
export async function recordResourceCreationEvent(
  db: Db,
  companyId: string,
  resourceType: "agent" | "project",
  resourceId: string,
): Promise<void> {
  await db.insert(resourceLifecycleEvents).values({ companyId, resourceType, resourceId, action: "create" }).onConflictDoNothing({
    target: [resourceLifecycleEvents.companyId, resourceLifecycleEvents.resourceType, resourceLifecycleEvents.resourceId],
    where: sql`${resourceLifecycleEvents.action} = 'create'`,
  });
}

/** Call with the agent row locked, in the same transaction as the status change. */
export async function recordAgentStatusEvent(db: Db, companyId: string, agentId: string, before: string, after: string): Promise<void> {
  if (before === after) return;
  const action = after === "terminated" ? "terminate"
    : after === "paused" ? "pause"
      : before === "paused" && ["active", "idle", "running", "error"].includes(after) ? "resume" : null;
  if (!action) return;
  await db.insert(resourceLifecycleEvents).values({ companyId, resourceType: "agent", resourceId: agentId, action });
}
