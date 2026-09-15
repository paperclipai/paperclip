import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

type Run = typeof heartbeatRuns.$inferSelect;
type Transaction = Pick<Db, "select" | "update">;

export async function coalesceHeartbeatRun(
  tx: Transaction,
  input: { companyId: string; runId: string },
  mergeContext: (run: Pick<Run, "contextSnapshot" | "status">) => Record<string, unknown>,
) {
  const [run] = await tx
    .select()
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.companyId, input.companyId),
    ))
    .for("update");
  if (!run) {
    throw new Error("wake-queue: the coalesce target run was not found for this company");
  }
  const contextSnapshot = mergeContext(run);
  const existing = run.contextSnapshot as Record<string, unknown> | null;
  // Checkout stamps are authorization identity, not replaceable wake metadata.
  for (const key of ["issueId", "taskId"] as const) {
    if (typeof existing?.[key] === "string" && existing[key].trim()) {
      contextSnapshot[key] = existing[key];
    }
  }
  const [merged] = await tx
    .update(heartbeatRuns)
    .set({ contextSnapshot, updatedAt: new Date() })
    .where(eq(heartbeatRuns.id, run.id))
    .returning();
  return merged!;
}
