import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { createDb, type Db } from "../../../packages/db/src/index.js";
import { agents, issues, heartbeatRuns, toolActionRequests, toolInvocations, toolActionDeliveries, agentWakeupRequests } from "../../../packages/db/src/index.js";
import { paperclipConfigSchema } from "../../../packages/shared/src/config-schema.js";
const { and, eq, or, inArray, sql }: typeof import("../../../packages/db/node_modules/drizzle-orm/index.js") =
  createRequire(new URL("../../../packages/db/package.json", import.meta.url))("drizzle-orm");

export interface ReviewAdmissionBinding {
  companyId: string; issueId: string; agentId: string; actionRequestId: string;
  invocationId: string; sourceRunId: string; interactionId: string;
}
/** Failure evidence only. No payloads, tool arguments, provider text or credentials. */
export async function readReviewAdmissionSnapshot(db: Db, b: ReviewAdmissionBinding) {
  if (Object.keys(b).length !== 7 || Object.values(b).some(value => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)))
    return { available: false as const, reason: "invalid_binding" as const };
  return db.transaction(async tx => {
    await tx.execute(sql`set local statement_timeout = '3000ms'`);
    const [owner] = await tx.select({ actionStatus: toolActionRequests.status, invocationStatus: toolInvocations.status,
      sourceStatus: heartbeatRuns.status, sourceNativePhase: heartbeatRuns.nativePhase,
      issueStatus: issues.status, conversationState: issues.conversationState, agentStatus: agents.status,
    }).from(toolActionRequests).innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, toolInvocations.runId)).innerJoin(issues, eq(issues.id, toolActionRequests.issueId))
      .innerJoin(agents, eq(agents.id, toolInvocations.agentId)).where(and(
        eq(toolActionRequests.id, b.actionRequestId), eq(toolActionRequests.companyId, b.companyId),
        eq(toolActionRequests.issueId, b.issueId), eq(toolActionRequests.interactionId, b.interactionId), eq(toolActionRequests.requestedByAgentId, b.agentId),
        eq(toolInvocations.id, b.invocationId), eq(toolInvocations.companyId, b.companyId), eq(toolInvocations.issueId, b.issueId),
        eq(toolInvocations.agentId, b.agentId), eq(heartbeatRuns.id, b.sourceRunId), eq(heartbeatRuns.companyId, b.companyId),
        eq(heartbeatRuns.agentId, b.agentId),
        or(eq(heartbeatRuns.issueId, b.issueId), eq(heartbeatRuns.nativeIssueId, b.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${b.issueId}`),
        eq(issues.companyId, b.companyId), eq(agents.companyId, b.companyId),
      )).limit(1);
    if (!owner) return { available: false as const, reason: "binding_mismatch" as const };
    const [delivery] = await tx.select({ createdAt: toolActionDeliveries.createdAt, deliveredAt: toolActionDeliveries.deliveredAt })
      .from(toolActionDeliveries).where(and(eq(toolActionDeliveries.companyId, b.companyId), eq(toolActionDeliveries.actionRequestId, b.actionRequestId),
        eq(toolActionDeliveries.issueId, b.issueId), eq(toolActionDeliveries.interactionId, b.interactionId))).limit(1);
    const wakeRows = await tx.select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId, coalescedCount: agentWakeupRequests.coalescedCount,
      requestedAt: agentWakeupRequests.requestedAt, finishedAt: agentWakeupRequests.finishedAt,
    }).from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, b.companyId), eq(agentWakeupRequests.agentId, b.agentId),
      or(eq(agentWakeupRequests.idempotencyKey, `tool-action-response:${b.actionRequestId}`),
        sql`${agentWakeupRequests.payload}->'toolActionRequestIds' @> ${JSON.stringify([b.actionRequestId])}::jsonb`)))
      .orderBy(agentWakeupRequests.createdAt, agentWakeupRequests.id).limit(8);
    const wakes = wakeRows.slice(0, 8), ids = wakes.flatMap(wake => wake.runId ? [wake.runId] : []);
    const runRows = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, runtimeMode: heartbeatRuns.runtimeMode,
      nativePhase: heartbeatRuns.nativePhase, wakeupRequestId: heartbeatRuns.wakeupRequestId,
      startedAt: heartbeatRuns.startedAt, finishedAt: heartbeatRuns.finishedAt,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, b.companyId), eq(heartbeatRuns.agentId, b.agentId),
      or(eq(heartbeatRuns.issueId, b.issueId), eq(heartbeatRuns.nativeIssueId, b.issueId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${b.issueId}`),
      or(ids.length ? inArray(heartbeatRuns.id, ids) : sql`false`,
        sql`${heartbeatRuns.contextSnapshot}->'toolActionRequestIds' @> ${JSON.stringify([b.actionRequestId])}::jsonb`)))
      .orderBy(heartbeatRuns.createdAt, heartbeatRuns.id).limit(8);
    return { available: true as const, observedAt: new Date().toISOString(), binding: b, owner,
      delivery: delivery ?? null, wakes, runs: runRows.slice(0, 8), rowLimitReached: wakeRows.length === 8 || runRows.length === 8 };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Same owned-config database pattern as controller-recovery-observer.ts. */
export async function observeReviewAdmission(b: ReviewAdmissionBinding, env: NodeJS.ProcessEnv = process.env) {
  let db: Db | undefined;
  try {
    if (!env.PAPERCLIP_CONFIG || !env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT) return { available: false as const, reason: "owned_config_unavailable" as const };
    const [root, filename] = await Promise.all([realpath(env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT), realpath(env.PAPERCLIP_CONFIG)]);
    if (!filename.startsWith(`${root}${path.sep}`)) return { available: false as const, reason: "owned_config_unavailable" as const };
    const config = paperclipConfigSchema.parse(JSON.parse(await readFile(filename, "utf8")));
    const url = config.database.mode === "postgres" ? config.database.connectionString
      : `postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`;
    if (!url) return { available: false as const, reason: "owned_config_unavailable" as const };
    db = createDb(url, { maxConnections: 1, connectTimeoutSeconds: 3 });
    return await readReviewAdmissionSnapshot(db, b);
  } catch { return { available: false as const, reason: "observation_unavailable" as const }; }
  finally { await db?.$client.end({ timeout: 1 }).catch(() => {}); }
}

export function reviewAdmissionSummary(snapshot: Awaited<ReturnType<typeof observeReviewAdmission>>) {
  if (!snapshot.available) return { available: false, reason: snapshot.reason };
  const states = ["queued", "running", "claimed", "completed", "coalesced", "deferred", "deferred_issue_execution", "succeeded", "failed", "cancelled", "timed_out", "skipped", "interrupted", "other"];
  const counts = (values: string[]) => Object.fromEntries(states.map(state => [state,
    values.filter(value => (states.includes(value) ? value : "other") === state).length]));
  return { available: true, delivery: !snapshot.delivery ? "missing" : snapshot.delivery.deliveredAt ? "acknowledged" : "pending",
    wakes: snapshot.wakes.length, wakeStates: counts(snapshot.wakes.map(row => row.status)),
    coalescedWakes: snapshot.wakes.filter(row => row.coalescedCount > 0).length,
    boundRuns: snapshot.wakes.filter(wake => snapshot.runs.some(run => run.id === wake.runId)).length,
    runStates: counts(snapshot.runs.map(row => row.status)),
    nativeRunStates: counts(snapshot.runs.filter(row => row.runtimeMode === "native").map(row => row.status)), rowLimitReached: snapshot.rowLimitReached };
}
