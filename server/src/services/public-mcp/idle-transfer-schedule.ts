import { asc, gt } from "drizzle-orm";
import { mcpFileTickets, type Db } from "@paperclipai/db";
import type { IdleDeadlineSnapshot } from "../idle-deadline-types.js";
import type { IdleMcpInspectionBudget } from "./idle-wake-proof.js";

export async function readIdleMcpTransferSchedule(tx: Pick<Db,"select">, input: { now: number; budget: IdleMcpInspectionBudget }): Promise<IdleDeadlineSnapshot> {
  await input.budget.beforeRead();
  const rows = await tx.select({ companyId: mcpFileTickets.companyId, grantId: mcpFileTickets.grantId,
    uploadId: mcpFileTickets.uploadId, attachmentId: mcpFileTickets.attachmentId, workSessionId: mcpFileTickets.workSessionId,
    expiresAt: mcpFileTickets.expiresAt }).from(mcpFileTickets)
    .where(gt(mcpFileTickets.expiresAt,new Date(input.now))).orderBy(asc(mcpFileTickets.expiresAt)).limit(1001);
  input.budget.check();
  if (!Number.isFinite(input.now) || rows.length > 1000) return { blocked: true, state: ["incomplete-transfer-inspection"], deadlines: [] };
  const deadlines: number[] = [], state: unknown[] = [];
  for (const row of rows) {
    input.budget.check();
    const expiresAt = row.expiresAt.getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= input.now || !row.companyId || !row.grantId || Boolean(row.uploadId) === Boolean(row.attachmentId)) {
      return { blocked: true, state: ["uncertain-transfer"], deadlines: [] };
    }
    deadlines.push(expiresAt);
    state.push([row.companyId,row.grantId,row.uploadId,row.attachmentId,row.workSessionId,row.expiresAt.toISOString()]);
  }
  return { blocked: rows.length > 0, state, deadlines };
}
