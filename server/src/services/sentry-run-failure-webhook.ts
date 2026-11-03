import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, heartbeatRuns, issues, projects, routineRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { authorizationService } from "./authorization.js";

const MAX_PROVENANCE_TASKS = 100;
const taskContext = sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
  'taskId', ${heartbeatRuns.contextSnapshot}->'taskId', 'taskKey', ${heartbeatRuns.contextSnapshot}->'taskKey')`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function eventTags(value: unknown): Map<string, string> | null {
  const entries = Array.isArray(value) ? value.map(entry => Array.isArray(entry)
    ? entry : [record(entry)?.key, record(entry)?.value]) : Object.entries(record(value) ?? {});
  const tags = new Map<string, string>();
  for (const [key, val] of entries) {
    if (typeof key !== "string" || typeof val !== "string") continue;
    if (tags.has(key) && tags.get(key) !== val) return null;
    tags.set(key, val);
  }
  return tags;
}

function runTaskReference(run: Pick<typeof heartbeatRuns.$inferSelect, "nativeIssueId" | "issueId" | "contextSnapshot">) {
  return run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId
    ?? run.contextSnapshot?.taskId ?? run.contextSnapshot?.taskKey;
}

/** Follow both structural ancestry and immutable creation provenance. A task
 * created without a parent, or moved after creation, must not evade the guard. */
async function isIndependentSource(db: Db, companyId: string, routineId: string, taskId: string): Promise<boolean> {
  const visited = new Set<string>();
  let pending = [taskId];
  while (pending.length) {
    const batch = [...new Set(pending)].filter(id => !visited.has(id));
    if (!batch.length) break;
    if (visited.size + batch.length > MAX_PROVENANCE_TASKS) return false;
    batch.forEach(id => visited.add(id));
    const tasks = await db.select({ id: issues.id, parentId: issues.parentId, originKind: issues.originKind,
      originId: issues.originId, originRunId: issues.originRunId, createdByAgentId: issues.createdByAgentId,
    }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, batch)));
    if (tasks.length !== batch.length) return false;
    if (tasks.some(task => task.originKind === "routine_execution" && task.originId === routineId)) return false;
    if (tasks.some(task => task.originRunId && !isUuidLike(task.originRunId))) return false;
    const routineOriginIds = tasks.filter(task => task.originRunId)
      .map(task => task.originRunId!);
    const routineCreationIds = new Set<string>();
    if (routineOriginIds.length) {
      const origins = await db.select({ id: routineRuns.id, routineId: routineRuns.routineId, linkedIssueId: routineRuns.linkedIssueId,
        source: sql<string | null>`${routineRuns.triggerPayload}->>'source'` }).from(routineRuns)
        .where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.id, routineOriginIds)));
      for (const origin of origins) {
        if (!tasks.some(task => task.originRunId === origin.id && task.id === origin.linkedIssueId)) continue;
        if (origin.routineId === routineId || origin.source === "sentry_run_failure") return false;
        routineCreationIds.add(origin.id);
      }
    }
    if (tasks.some(task => task.originKind === "routine_execution" && !routineCreationIds.has(task.originRunId ?? ""))) return false;
    const legacyTasks = tasks.filter(task => !task.originRunId && task.createdByAgentId);
    const creationEvents = legacyTasks.length ? await db.select({ taskId: activityLog.entityId, runId: activityLog.runId })
      .from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, legacyTasks.map(task => task.id)),
        inArray(activityLog.action, ["issue.created", "issue.child_created"]))) : [];
    const creatorIds = [...new Set([...tasks.filter(task => !routineCreationIds.has(task.originRunId ?? "")).map(task => task.originRunId),
      ...creationEvents.map(event => event.runId)].filter((id): id is string => typeof id === "string" && isUuidLike(id)))];
    const creators = creatorIds.length ? await db.select({ id: heartbeatRuns.id, nativeIssueId: heartbeatRuns.nativeIssueId,
      issueId: heartbeatRuns.issueId, contextSnapshot: taskContext,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, creatorIds))) : [];
    if (creators.length !== creatorIds.length) return false;
    if (legacyTasks.some(task => !creationEvents.some(event => event.taskId === task.id && event.runId))) return false;
    const references = creators.map(runTaskReference);
    if (references.some(ref => typeof ref !== "string")) return false;
    // Historical creation runs can reference task identifiers instead of UUIDs.
    const identifiers = references.filter((ref): ref is string => typeof ref === "string" && !isUuidLike(ref));
    const referencedTasks = identifiers.length ? await db.select({ id: issues.id, identifier: issues.identifier }).from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.identifier, identifiers))) : [];
    if (new Set(referencedTasks.map(task => task.identifier)).size !== new Set(identifiers).size) return false;
    pending = [...tasks.flatMap(task => task.parentId ? [task.parentId] : []),
      ...references.filter((ref): ref is string => typeof ref === "string" && isUuidLike(ref)),
      ...referencedTasks.map(task => task.id)];
  }
  return true;
}

type Delivery = { ignored: true; reason: string } | {
  ignored: false;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

/** Called only after the receiving trigger's bearer credential is verified.
 * Provider content cannot select an actor, project, routine, or instructions. */
export async function prepareSentryRunFailureWebhook(db: Db, routine: {
  id: string; companyId: string; assigneeAgentId: string | null;
}, payload: Record<string, unknown> | null | undefined): Promise<Delivery> {
  const event = record(record(payload?.data)?.event);
  const tags = eventTags(event?.tags);
  const runId = tags?.get("run_id")?.trim().toLowerCase(), taskId = tags?.get("task_id")?.trim().toLowerCase();
  if (payload?.action !== "triggered" || tags?.get("event_kind") !== "run_failure"
    || !runId || !isUuidLike(runId) || !taskId || !isUuidLike(taskId)
    || (tags.has("company_id") && tags.get("company_id") !== routine.companyId)) {
    return { ignored: true, reason: "not_company_run_failure" };
  }
  const [run] = await db.select({ nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
    contextSnapshot: taskContext, status: heartbeatRuns.status,
  }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, routine.companyId), eq(heartbeatRuns.id, runId)));
  const [task] = await db.select({ id: issues.id, identifier: issues.identifier, visibility: issues.visibility,
    privacyRootIssueId: issues.privacyRootIssueId, projectId: issues.projectId,
  }).from(issues).where(and(eq(issues.companyId, routine.companyId), eq(issues.id, taskId)));
  if (!run || !task || !["failed", "timed_out", "cancelled"].includes(run.status)
    || ![task.id, task.identifier].includes(runTaskReference(run) as string)) {
    return { ignored: true, reason: "source_run_unavailable" };
  }
  // Routine history is company-readable. Do not copy private source identifiers
  // into it, even when the assigned repair agent can read the original task.
  const [project] = task.projectId ? await db.select({ visibility: projects.visibility }).from(projects)
    .where(and(eq(projects.companyId, routine.companyId), eq(projects.id, task.projectId))) : [];
  if (task.visibility !== "open" || task.privacyRootIssueId || (task.projectId && project?.visibility !== "open") || !routine.assigneeAgentId) {
    return { ignored: true, reason: "source_not_shareable" };
  }
  const [decision] = await authorizationService(db).decideReads({ type: "agent", source: "agent_key",
    companyId: routine.companyId, agentId: routine.assigneeAgentId,
  }, [{ type: "issue", companyId: routine.companyId, issueId: task.id }]);
  if (!decision?.allowed) return { ignored: true, reason: "source_not_readable" };
  if (!await isIndependentSource(db, routine.companyId, routine.id, task.id)) {
    return { ignored: true, reason: "repair_automation_provenance" };
  }
  const errorCode = tags.get("error_code");
  const eventId = event?.event_id ?? event?.id;
  return {
    ignored: false,
    idempotencyKey: `sentry-run-failure:${runId}`,
    payload: {
      source: "sentry_run_failure", taskId: task.id, taskIdentifier: task.identifier, runId,
      ...(typeof eventId === "string" && /^[a-f0-9]{32}$/i.test(eventId) ? { sentryEventId: eventId } : {}),
      ...(errorCode && /^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(errorCode) ? { errorCode } : {}),
      variables: { task_identifier: task.identifier ?? task.id, task_id: task.id, run_id: runId },
    },
  };
}
