import { and, eq, inArray, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, issues, projects, routineRuns, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { agentRunWritesRevoked } from "../agent-run-cancellation.js";
import { unauthorized } from "../errors.js";

export interface TaskCreationProvenance {
  status: "complete" | "unknown";
  routineIds: string[];
  shareable: boolean | null;
}

export const unknownTaskCreationProvenance = (): TaskCreationProvenance => ({
  status: "unknown", routineIds: [], shareable: null,
});

const MAX_TASKS = 100;
const MAX_DEPTH = 16;
const MAX_QUERIES = 32;
const taskReference = (run: { nativeIssueId?: string | null; issueId?: string | null; contextSnapshot?: Record<string, unknown> | null }) =>
  run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.contextSnapshot?.taskKey;

export async function authenticateWebhookCreationRun(db: Db, companyId: string, token?: string | null) {
  if (token == null) return null;
  const claims = verifyLocalAgentJwt(token.trim(), { strictRunAuthority: true });
  if (!claims || claims.company_id !== companyId || !isUuidLike(claims.run_id) || !isUuidLike(claims.sub)) throw unauthorized();
  return validateCreationRun(db, companyId, claims.sub, claims.run_id);
}

export async function validateCreationRun(db: Db, companyId: string, agentId: string, runId: string) {
  if (!isUuidLike(runId)) throw unauthorized();
  const [run] = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status,
    resultJson: sql<Record<string, unknown>>`jsonb_build_object('executionCancellation', ${heartbeatRuns.resultJson}->'executionCancellation')`,
    agentStatus: agents.status,
  }).from(heartbeatRuns).innerJoin(agents, and(eq(agents.id, heartbeatRuns.agentId), eq(agents.companyId, companyId)))
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)));
  if (!run || run.status !== "running" || agentRunWritesRevoked(run)
    || run.agentStatus === "terminated" || run.agentStatus === "pending_approval") throw unauthorized();
  return run.id;
}

export async function readTaskCreationProvenance(db: Db, companyId: string, taskId: string | null, deadlineAt = Infinity): Promise<TaskCreationProvenance> {
  if (!taskId || !isUuidLike(taskId)) return unknownTaskCreationProvenance();
  let queries = 0;
  const read = async <T>(query: () => PromiseLike<T>): Promise<T | null> => {
    if (queries >= MAX_QUERIES || Date.now() >= deadlineAt) return null;
    queries++;
    const rows = await query();
    return Date.now() >= deadlineAt ? null : rows;
  };
  const visited = new Set<string>(), routineIds = new Set<string>();
  const edges = new Map<string, Set<string>>();
  let pending = [taskId], complete = true, shareable: boolean | null = null;
  const connect = (from: string, to: string) => {
    const parents = edges.get(from) ?? new Set<string>();
    parents.add(to); edges.set(from, parents); pending.push(to);
  };
  for (let depth = 0; pending.length; depth++) {
    const batch = [...new Set(pending)].filter(id => !visited.has(id));
    pending = [];
    if (!batch.length) break;
    if (depth >= MAX_DEPTH || visited.size + batch.length > MAX_TASKS) { complete = false; break; }
    batch.forEach(id => visited.add(id));
    const tasks = await read(() => db.select({ id: issues.id, parentId: issues.parentId,
      originKind: issues.originKind, originRunId: issues.originRunId, createdByAgentId: issues.createdByAgentId,
      visibility: issues.visibility, privacyRootIssueId: issues.privacyRootIssueId, projectId: issues.projectId,
    }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, batch))));
    if (!tasks) { complete = false; break; }
    if (tasks.length !== batch.length) complete = false;
    const projectIds = [...new Set(tasks.flatMap(task => task.projectId ? [task.projectId] : []))];
    const publicProjects = projectIds.length ? await read(() => db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds), eq(projects.visibility, "open")))) : [];
    if (!publicProjects) { complete = false; break; }
    const publicProjectIds = new Set(publicProjects.map(project => project.id));
    for (const task of tasks) {
      const publicTask = task.visibility === "open" && !task.privacyRootIssueId
        && (!task.projectId || publicProjectIds.has(task.projectId));
      if (task.id === taskId) shareable = publicTask;
      else if (!publicTask) shareable = false;
      if (task.parentId) connect(task.id, task.parentId);
    }
    const originIds = [...new Set(tasks.flatMap(task => task.originRunId && isUuidLike(task.originRunId) ? [task.originRunId] : []))];
    const receipts = originIds.length ? await read(() => db.select({ id: routineRuns.id, routineId: routineRuns.routineId,
      linkedIssueId: routineRuns.linkedIssueId, createdByRunId: routineRuns.createdByRunId, source: routineRuns.source,
    }).from(routineRuns).where(and(eq(routineRuns.companyId, companyId), inArray(routineRuns.id, originIds)))) : [];
    if (!receipts) { complete = false; break; }
    const receiptMap = new Map(receipts.map(receipt => [receipt.id, receipt]));
    const creators: Array<{ taskId: string; runId: string; agentId: string | null }> = [];
    const legacyTasks = tasks.filter(task => !task.originRunId && task.createdByAgentId);
    const events = legacyTasks.length ? await read(() => db.select({ taskId: activityLog.entityId, runId: activityLog.runId }).from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "issue"),
        inArray(activityLog.entityId, legacyTasks.map(task => task.id)), inArray(activityLog.action, ["issue.created", "issue.child_created"])))) : [];
    if (!events) { complete = false; break; }
    for (const task of tasks) {
      const receipt = task.originRunId ? receiptMap.get(task.originRunId) : undefined;
      if (receipt?.linkedIssueId === task.id) {
        routineIds.add(receipt.routineId);
        if (receipt.createdByRunId) creators.push({ taskId: task.id, runId: receipt.createdByRunId, agentId: null });
        else if (task.createdByAgentId || receipt.source === "api") complete = false;
      } else if (task.originKind === "routine_execution") {
        complete = false;
      } else if (task.originRunId) {
        if (!isUuidLike(task.originRunId)) complete = false;
        else creators.push({ taskId: task.id, runId: task.originRunId, agentId: task.createdByAgentId });
      } else if (task.createdByAgentId) {
        const ids = [...new Set(events.filter(event => event.taskId === task.id).map(event => event.runId))];
        if (ids.length !== 1 || !ids[0] || !isUuidLike(ids[0])) complete = false;
        else creators.push({ taskId: task.id, runId: ids[0], agentId: task.createdByAgentId });
      }
    }
    const creatorIds = [...new Set(creators.map(creator => creator.runId))];
    const runs = creatorIds.length ? await read(() => db.select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId,
      nativeIssueId: heartbeatRuns.nativeIssueId, issueId: heartbeatRuns.issueId,
      contextSnapshot: sql<Record<string, unknown>>`jsonb_build_object('issueId', ${heartbeatRuns.contextSnapshot}->'issueId',
        'taskId', ${heartbeatRuns.contextSnapshot}->'taskId', 'taskKey', ${heartbeatRuns.contextSnapshot}->'taskKey')`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, creatorIds)))) : [];
    if (!runs) { complete = false; break; }
    const runMap = new Map(runs.map(run => [run.id, run]));
    const identifiers = [...new Set(runs.map(taskReference).filter((ref): ref is string => typeof ref === "string" && !isUuidLike(ref)))];
    const identified = identifiers.length ? await read(() => db.select({ id: issues.id, identifier: issues.identifier }).from(issues)
      .where(and(eq(issues.companyId, companyId), inArray(issues.identifier, identifiers)))) : [];
    if (!identified) { complete = false; break; }
    const taskIds = new Map(identified.map(task => [task.identifier, task.id]));
    for (const creator of creators) {
      const run = runMap.get(creator.runId), reference = run && taskReference(run);
      const id = typeof reference === "string" ? (isUuidLike(reference) ? reference : taskIds.get(reference)) : null;
      if (!run || (creator.agentId && run.agentId !== creator.agentId) || !id) complete = false;
      else connect(creator.taskId, id);
    }
  }
  const active = new Set<string>(), done = new Set<string>();
  const acyclic = (id: string): boolean => {
    if (active.has(id)) return false;
    if (done.has(id)) return true;
    active.add(id);
    for (const parent of edges.get(id) ?? []) if (!acyclic(parent)) return false;
    active.delete(id); done.add(id); return true;
  };
  if (!acyclic(taskId)) complete = false;
  return { status: complete ? "complete" : "unknown", routineIds: [...routineIds].sort(), shareable };
}
