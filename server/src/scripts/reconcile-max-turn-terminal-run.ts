import { and, desc, eq } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { hasUnblockDescriptor } from "../services/issue-blocked-gate.js";

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function main() {
  const runId = parseFlag("--run");
  if (!runId) {
    throw new Error("Usage: pnpm --filter @paperclipai/server exec tsx src/scripts/reconcile-max-turn-terminal-run.ts --run <uuid> [--apply]");
  }
  const apply = process.argv.includes("--apply");
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (run.status !== "failed" || run.errorCode !== "max_turns_exhausted") {
    throw new Error(`Run ${runId} is not a failed max_turns_exhausted run`);
  }
  const context = record(run.contextSnapshot);
  const issueId = typeof context.issueId === "string"
    ? context.issueId
    : typeof context.taskId === "string"
      ? context.taskId
      : null;
  if (!issueId) throw new Error(`Run ${runId} has no bound issue`);

  const issue = await db
    .select({ id: issues.id, status: issues.status, unblockDescriptor: issues.unblockDescriptor })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
    .then((rows) => rows[0] ?? null);
  if (!issue || (issue.status !== "done" && issue.status !== "blocked")) {
    throw new Error(`Issue ${issueId} has no supported terminal disposition`);
  }
  if (issue.status === "blocked" && !hasUnblockDescriptor(issue.unblockDescriptor)) {
    throw new Error(`Issue ${issueId} is blocked without a structured unblock descriptor`);
  }

  const transition = await db
    .select({ id: activityLog.id, details: activityLog.details })
    .from(activityLog)
    .where(and(
      eq(activityLog.companyId, run.companyId),
      eq(activityLog.runId, run.id),
      eq(activityLog.action, "issue.updated"),
      eq(activityLog.entityType, "issue"),
      eq(activityLog.entityId, issue.id),
    ))
    .orderBy(desc(activityLog.createdAt))
    .then((rows) => rows.find((row) => record(row.details).status === issue.status) ?? null);
  if (!transition) throw new Error(`Run ${runId} has no same-run terminal issue receipt`);

  const reconciliation = {
    issueId: issue.id,
    issueStatus: issue.status,
    proof: "run_linked_issue_update_receipt",
    historicalRepair: true,
  };
  if (!apply) {
    console.log(JSON.stringify({ outcome: "dry_run_pass", runId, reconciliation }, null, 2));
    await db.$client.end({ timeout: 1 });
    return;
  }

  await db.transaction(async (tx) => {
    const updated = await tx
      .update(heartbeatRuns)
      .set({
        status: "succeeded",
        error: null,
        errorCode: null,
        livenessState: issue.status === "done" ? "completed" : "blocked",
        livenessReason: issue.status === "done" ? "Issue is done" : "Issue status is blocked",
        resultJson: {
          ...record(run.resultJson),
          terminalDispositionReconciliation: reconciliation,
        },
        updatedAt: new Date(),
      })
      .where(and(
        eq(heartbeatRuns.id, run.id),
        eq(heartbeatRuns.status, "failed"),
        eq(heartbeatRuns.errorCode, "max_turns_exhausted"),
      ))
      .returning({ id: heartbeatRuns.id });
    if (updated.length !== 1) throw new Error(`Run ${runId} changed during reconciliation`);

    if (run.wakeupRequestId) {
      await tx
        .update(agentWakeupRequests)
        .set({ status: "completed", error: null, updatedAt: new Date() })
        .where(and(
          eq(agentWakeupRequests.id, run.wakeupRequestId),
          eq(agentWakeupRequests.runId, run.id),
        ));
    }
    await tx
      .update(environmentLeases)
      .set({ status: "released", failureReason: null, updatedAt: new Date() })
      .where(and(
        eq(environmentLeases.heartbeatRunId, run.id),
        eq(environmentLeases.status, "failed"),
      ));
    await tx.insert(activityLog).values({
      companyId: run.companyId,
      actorType: "system",
      actorId: "max_turn_terminal_reconciler",
      agentId: run.agentId,
      runId: run.id,
      action: "heartbeat_run.max_turn_terminal_reconciled",
      entityType: "heartbeat_run",
      entityId: run.id,
      details: reconciliation,
    });
  });

  console.log(JSON.stringify({ outcome: "reconciled", runId, reconciliation }, null, 2));
  await db.$client.end({ timeout: 1 });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
