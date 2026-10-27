import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import { recoveryRunResultColumn } from "./run-result-read.js";

export async function readLegacyDispositionSource(
  db: Db,
  scope: { companyId: string; issueId: string; runId: string },
) {
  const where = and(eq(heartbeatRuns.id, scope.runId), eq(heartbeatRuns.companyId, scope.companyId));
  const [native] = await db.select({
    issueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'issueId'`,
    taskId: sql<unknown>`${heartbeatRuns.contextSnapshot}->'taskId'`,
  }).from(heartbeatRuns).where(and(where, eq(heartbeatRuns.runtimeMode, "native"))).limit(1);
  if (native) {
    const bound = [native.issueId, native.taskId]
      .map(value => typeof value === "string" && value.trim().length > 0 ? value : null).find(Boolean) ?? null;
    return { kind: "skip" as const, decision: {
      kind: "skip" as const, reason: bound === scope.issueId ? "native_finalization" : "invalid_issue_binding",
    } };
  }
  const [run] = await db.select({ ...getTableColumns(heartbeatRuns), resultJson: recoveryRunResultColumn })
    .from(heartbeatRuns).where(where).limit(1);
  return { kind: "full" as const, run };
}
