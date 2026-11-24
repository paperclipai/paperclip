import { and, eq } from "drizzle-orm";
import { toolConnectionContentDeletions, type Db } from "@paperclipai/db";
import type {
  ToolConnectionContentDeletion,
  ToolConnectionContentDeletionCounts,
  ToolConnectionContentDeletionReason,
} from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";

export type Phase = "invocations" | "events" | "auditEvents" | "appViews" | "deliveredResults" | "runs" | "done";
const PHASES: Phase[] = ["invocations", "events", "auditEvents", "appViews", "deliveredResults", "runs", "done"];
const OPEN_WORK_WAIT_MS = 60_000;
const OPEN_WORK_WAIT_MAX_MS = 5 * 60_000;
const OPEN_WORK_WAIT_LIMIT_MS = 24 * 60 * 60_000;
const OPEN_WORK_LONG_WAIT_MS = 60 * 60_000;

export type RunInProgress = { id: string; eventAfterId: number; changed: boolean; stage?: "events" | "log" };

export type Progress = {
  phase: Phase;
  waiting: boolean;
  cursor: { createdAt: string; id: string } | null;
  runCursor: string | null;
  currentRun: RunInProgress | null;
  pendingRuns: string[];
  counts: ToolConnectionContentDeletionCounts;
};

export type ContentDeletionActor = { actorType: "user" | "agent" | "system"; actorId: string | null };

type DeletionRow = typeof toolConnectionContentDeletions.$inferSelect;

export function emptyContentDeletionCounts(): ToolConnectionContentDeletionCounts {
  return { toolCalls: 0, approvals: 0, auditEvents: 0, appViews: 0, runs: 0, runsInProgress: 0, itemsInProgress: 0 };
}

export function readProgress(row: { progress: unknown }): Progress {
  const raw = row.progress as Partial<Progress>;
  const counts = { ...emptyContentDeletionCounts(), ...(raw.counts ?? {}) };
  const phase = PHASES.includes(raw.phase as Phase) ? raw.phase as Phase : "invocations";
  return { phase, waiting: phase === "done" && raw.waiting === true, cursor: raw.cursor ?? null, runCursor: raw.runCursor ?? null,
    currentRun: raw.currentRun ?? null, pendingRuns: raw.pendingRuns ?? [], counts };
}

export function nextPhase(phase: Phase): Phase {
  return PHASES[Math.min(PHASES.indexOf(phase) + 1, PHASES.length - 1)]!;
}

export function toDeletion(row: DeletionRow): ToolConnectionContentDeletion {
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    requestedAt: row.requestedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    retrying: row.status === "pending" && row.lastError !== null,
    counts: readProgress(row).counts,
  };
}

export function initialContentDeletionProgress(): Progress {
  return { phase: "invocations", waiting: false, cursor: null, runCursor: null, currentRun: null, pendingRuns: [], counts: emptyContentDeletionCounts() };
}

export function openWorkWaitMs(row: { requestedAt: Date }, open: number, untilSettled = false) {
  const waitedMs = Date.now() - row.requestedAt.getTime();
  if (open === 0) return null;
  if (waitedMs >= OPEN_WORK_WAIT_LIMIT_MS) return untilSettled ? OPEN_WORK_LONG_WAIT_MS : null;
  return Math.min(Math.max(OPEN_WORK_WAIT_MS, waitedMs / 10), OPEN_WORK_WAIT_MAX_MS);
}

export async function requestConnectionContentDeletion(
  db: Db,
  connection: { id: string; companyId: string },
  actor: ContentDeletionActor,
  reason: ToolConnectionContentDeletionReason = "requested",
) {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const pendingFor = () => tx
      .select()
      .from(toolConnectionContentDeletions)
      .where(and(
        eq(toolConnectionContentDeletions.companyId, connection.companyId),
        eq(toolConnectionContentDeletions.connectionId, connection.id),
        eq(toolConnectionContentDeletions.status, "pending"),
      ))
      .limit(1)
      .for("update");
    const now = new Date();
    let [existing] = await pendingFor();
    if (existing && reason === "requested" && existing.reason === "requested") return { deletion: toDeletion(existing), created: false };
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.toolConnectionContentDeletion);
    if (!existing) {
      const [created] = await tx
        .insert(toolConnectionContentDeletions)
        .values({
          requestedAt: now,
          createdAt: now,
          updatedAt: now,
          companyId: connection.companyId,
          connectionId: connection.id,
          reason,
          requestedByActorType: actor.actorType,
          requestedByActorId: actor.actorId,
          progress: initialContentDeletionProgress() as unknown as Record<string, unknown>,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return { deletion: toDeletion(created), created: true };
      [existing] = await pendingFor();
      if (reason === "requested" && existing!.reason === "requested") return { deletion: toDeletion(existing!), created: false };
    }
    const counts = readProgress(existing!).counts;
    const [restarted] = await tx
      .update(toolConnectionContentDeletions)
      .set({
        reason: reason === "requested" ? existing!.reason : reason,
        requestedAt: now,
        notBefore: null,
        lastError: null,
        updatedAt: now,
        progress: { ...initialContentDeletionProgress(), counts: { ...counts, itemsInProgress: 0, runsInProgress: 0 } } as unknown as Record<string, unknown>,
      })
      .where(eq(toolConnectionContentDeletions.id, existing!.id))
      .returning();
    return { deletion: toDeletion(restarted ?? existing!), created: false };
  });
}
