import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agentTaskSessions, heartbeatRuns, issueProjectReferences, issues, projects, type Db } from "@paperclipai/db";
import { scanProjectMentions } from "@paperclipai/shared";
import { MAX_ADMISSION_PROJECTS, readAdmittedProjects, retainedSessionProjects } from "../modules/execution-admission/index.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/**
 * The task-context owner's project references: the optional primary project
 * union every structured `project://` link in content Paperclip supplies to the
 * task's execution (title, description, undeleted comments, every issue
 * document, plan-review annotation comments, thread interactions, workflow case
 * facts, copied ancestor titles and the selected accepted plan revision), plus
 * a retained session's admitted set. `contextRevision` addresses that outcome:
 * it changes whenever any source write changes a reference, and revalidation
 * recomputes it. Triggers keep `issue_project_references` as a lock-free
 * candidate index only.
 */
export type TaskProjectReferences =
  | { kind: "resolved"; contextRevision: string; primaryProjectId: string | null; projectIds: string[] }
  | { kind: "not_found" }
  | { kind: "lock_set_changed"; missing: number }
  | { kind: "context_source_unavailable" }
  | { kind: "unprojected_context_source"; sources: UnprojectedContextSource[] }
  | { kind: "fresh_context_required" }
  | { kind: "retained_context_mismatch" }
  | { kind: "context_too_large"; limit: number }
  | { kind: "too_many_projects"; count: number; limit: number }
  | { kind: "invalid_references"; malformed: number; unavailable: number }
  | { kind: "unauthorized"; count: number };

export type UnprojectedContextSource = "agent_instructions" | "run_output";

/** What the queued intent will supply besides the task's current content. Every field is required. */
export type TaskContextSelection = {
  /** The accepted plan revision supplied instead of the latest plan. */
  acceptedPlanRevisionId: string | null;
  /** A resumed provider session, pinned to the run and admission that produced it. */
  retainedSession: { sessionId: string; runId: string; admissionId: string } | null;
  /** Instructions supplied to the execution; bundles are not covered yet. */
  instructions: "none" | { bundleDigest: string };
  /** Earlier run output replayed by continuation or handoff; not covered yet. */
  runOutput: "none" | { runIds: string[] };
};

export type ResolveTaskProjectReferencesInput = {
  companyId: string;
  issueId: string;
  /** The execution's actor; a reference never grants access. */
  actor: AuthorizationActor;
  selection: TaskContextSelection;
  /** Projects the caller locked from the hint. A resolved set outside it asks for a retry. */
  lockedProjectIds: readonly string[];
};

/** Link-bearing source text read per resolution; larger contexts are refused, never truncated. */
export const MAX_TASK_REFERENCE_SOURCE_BYTES = 8 * 1024 * 1024;
const ANCESTOR_DEPTH = 50;

function textLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...textLeaves(item)]);
  return [];
}

const ancestorIds = (companyId: string, issueId: string) => sql`with recursive ancestors(id, depth) as (
    select parent_id, 1 from issues where id = ${issueId} and company_id = ${companyId} and parent_id is not null
    union all select i.parent_id, a.depth + 1 from issues i join ancestors a on i.id = a.id
    where i.company_id = ${companyId} and i.parent_id is not null and a.depth < ${ANCESTOR_DEPTH})
  select id from ancestors`;

function unprojectedSources(selection: TaskContextSelection): UnprojectedContextSource[] {
  const sources: UnprojectedContextSource[] = [];
  if (selection.instructions !== "none") sources.push("agent_instructions");
  if (selection.runOutput !== "none") sources.push("run_output");
  return sources;
}

/** Validates the pinned session → run → admission chain; never reconstructs a set from edited text. */
async function retainedProjectIds(tx: Db, input: ResolveTaskProjectReferencesInput) {
  const pin = input.selection.retainedSession;
  if (!pin) return { kind: "none" as const };
  const { companyId, issueId } = input;
  const [session] = await tx.select({ agentId: agentTaskSessions.agentId, taskKey: agentTaskSessions.taskKey,
    lastRunId: agentTaskSessions.lastRunId }).from(agentTaskSessions)
    .where(and(eq(agentTaskSessions.id, pin.sessionId), eq(agentTaskSessions.companyId, companyId)));
  const [run] = await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, pin.runId), eq(heartbeatRuns.companyId, companyId),
      sql`${issueId} in (${heartbeatRuns.issueId}::text, ${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`));
  const admission = await readAdmittedProjects(tx, { companyId, admissionId: pin.admissionId });
  const actorAgentId = input.actor.type === "agent" ? input.actor.agentId : null;
  if (!session || !run || admission.kind === "not_found" || session.agentId !== actorAgentId || session.taskKey !== issueId
    || session.lastRunId !== pin.runId || run.agentId !== session.agentId || admission.runId !== pin.runId) {
    return { kind: "mismatch" as const };
  }
  const retained = retainedSessionProjects(admission.projects, []);
  return retained.kind === "retain" ? { kind: "retained" as const, projectIds: retained.projectIds } : retained;
}

/**
 * Resolves the complete reference set in the caller's transaction, after the
 * caller's own locks; it takes none. Every source is parsed in full with the
 * shared parser in one statement. Summaries, truncation, pagination and
 * workspace staging never shrink the set. Outcomes carry counts, never
 * inaccessible project IDs or names.
 */
export async function resolveTaskProjectReferences(tx: Db, input: ResolveTaskProjectReferencesInput): Promise<TaskProjectReferences> {
  if (!("nestedIndex" in tx)) throw new Error("Task project references must be resolved in a transaction");
  const { companyId, issueId, selection } = input;
  const [issue] = await tx.select({ projectId: issues.projectId }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!issue) return { kind: "not_found" };
  const unprojected = unprojectedSources(selection);
  if (unprojected.length > 0) return { kind: "unprojected_context_source", sources: unprojected };
  const retained = await retainedProjectIds(tx, input);
  if (retained.kind === "mismatch") return { kind: "retained_context_mismatch" };
  if (retained.kind === "fresh_context_required") return retained;

  const plan = selection.acceptedPlanRevisionId;
  const [read] = await tx.execute(sql`with sources(body, data) as (
      select concat_ws(' ', title, description), null::jsonb from issues where id = ${issueId} and company_id = ${companyId}
      union all select title, null from issues where company_id = ${companyId} and id in (${ancestorIds(companyId, issueId)})
      union all select body, null from issue_comments where company_id = ${companyId} and issue_id = ${issueId} and deleted_at is null
      union all select d.latest_body, null from issue_documents l join documents d on d.id = l.document_id
        where l.company_id = ${companyId} and l.issue_id = ${issueId}
      union all select body, null from document_annotation_comments where company_id = ${companyId} and issue_id = ${issueId}
      union all select null, jsonb_build_array(title, summary, payload, result) from issue_thread_interactions
        where company_id = ${companyId} and issue_id = ${issueId}
      union all select null, jsonb_build_array(title, summary, fields) from cases where company_id = ${companyId} and work_issue_id = ${issueId}
    ), linked as (select body, data from sources where coalesce(body, data::text) ilike '%project://%'),
    size as (select coalesce(sum(octet_length(coalesce(body, data::text))), 0) as bytes from linked)
    select (select bytes from size) as bytes,
      (select coalesce(jsonb_agg(coalesce(to_jsonb(body), data)), '[]') from linked where (select bytes from size) <= ${MAX_TASK_REFERENCE_SOURCE_BYTES}) as texts,
      ${plan ? sql`(select r.body from document_revisions r join issue_documents l on l.document_id = r.document_id
        where r.company_id = ${companyId} and r.id = ${plan} and l.issue_id = ${issueId} and l.key = 'plan')` : sql`null`} as plan_body,
      ${plan ? sql`(select count(*) from document_revisions r join issue_documents l on l.document_id = r.document_id
        where r.company_id = ${companyId} and r.id = ${plan} and l.issue_id = ${issueId} and l.key = 'plan')` : sql`1`}::int as plan_found`) as unknown as
    Array<{ bytes: string | number; texts: unknown; plan_body: string | null; plan_found: number }>;
  if (!read || read.plan_found === 0) return { kind: "context_source_unavailable" };
  if (Number(read.bytes) + Buffer.byteLength(read.plan_body ?? "") > MAX_TASK_REFERENCE_SOURCE_BYTES) {
    return { kind: "context_too_large", limit: MAX_TASK_REFERENCE_SOURCE_BYTES };
  }

  let malformed = 0;
  const referenced = new Set<string>(retained.kind === "retained" ? retained.projectIds : []);
  for (const text of [...textLeaves(read.texts), read.plan_body ?? ""]) {
    const scan = scanProjectMentions(text);
    malformed += scan.malformed;
    for (const projectId of scan.projectIds) referenced.add(projectId);
  }
  const primaryProjectId = issue.projectId;
  if (primaryProjectId) referenced.add(primaryProjectId);
  const projectIds = [...referenced].sort();
  if (projectIds.length > MAX_ADMISSION_PROJECTS) {
    return { kind: "too_many_projects", count: projectIds.length, limit: MAX_ADMISSION_PROJECTS };
  }
  const found = projectIds.length === 0 ? [] : await tx.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)));
  const unavailable = projectIds.length - found.length;
  if (malformed > 0 || unavailable > 0) return { kind: "invalid_references", malformed, unavailable };
  const decisions = await authorizationService(tx).decideReads(input.actor,
    projectIds.map(projectId => ({ type: "project" as const, companyId, projectId })));
  const unauthorized = decisions.filter(decision => !decision.allowed).length;
  if (unauthorized > 0) return { kind: "unauthorized", count: unauthorized };
  const locked = new Set(input.lockedProjectIds);
  const missing = projectIds.filter(projectId => !locked.has(projectId)).length;
  if (missing > 0) return { kind: "lock_set_changed", missing };
  const contextRevision = `task-refs:v1:${createHash("sha256").update(JSON.stringify({ primaryProjectId, projectIds,
    acceptedPlanRevisionId: plan, retainedAdmissionId: selection.retainedSession?.admissionId ?? null,
    instructions: selection.instructions, runOutput: selection.runOutput })).digest("hex")}`;
  return { kind: "resolved", contextRevision, primaryProjectId, projectIds };
}

/**
 * Unlocked candidate superset for the whole selection: the task's and its
 * ancestors' projection rows, the selected plan revision and the retained
 * admission. Lock these projects (in this order), then resolve.
 */
export async function readTaskProjectReferenceHint(db: Db, scope: { companyId: string; issueId: string; selection: TaskContextSelection }) {
  const { companyId, issueId, selection } = scope;
  const [issue] = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  if (!issue) return null;
  const rows = await db.execute(sql`select distinct project_id from (
      select project_id from issue_project_references where company_id = ${companyId} and (issue_id = ${issueId}
        or (source_kind = 'issue' and issue_id in (${ancestorIds(companyId, issueId)})))
      union all select unnest(paperclip_project_reference_candidates(body)) from document_revisions
        where company_id = ${companyId} and id = ${selection.acceptedPlanRevisionId}) candidates`) as unknown as Array<{ project_id: string }>;
  const projectIds = new Set(rows.map(row => row.project_id));
  if (selection.retainedSession) {
    const admission = await readAdmittedProjects(db, { companyId, admissionId: selection.retainedSession.admissionId });
    if (admission.kind === "found" && admission.projects.kind === "known") admission.projects.projectIds.forEach(id => projectIds.add(id));
  }
  return { projectIds: [...projectIds].sort() };
}

/**
 * Indexed reverse lookup: candidate tasks referencing a project as primary,
 * by a current source, an accepted plan revision, or a copied ancestor title.
 * Retained-only references are found through the admission owner (C1b-2).
 */
export async function findTasksReferencingProject(db: Db, scope: { companyId: string; projectId: string }) {
  const rows = await db.execute(sql`with recursive found(id, depth) as (
      select distinct issue_id, 0 from ${issueProjectReferences}
      where company_id = ${scope.companyId} and project_id = ${scope.projectId}
      union select i.id, f.depth + 1 from issues i join found f on i.parent_id = f.id
      where i.company_id = ${scope.companyId} and f.depth < ${ANCESTOR_DEPTH})
    select distinct id from found order by id`) as unknown as Array<{ id: string }>;
  return rows.map(row => row.id);
}

/** Hint for waiting work after the outer commit; the sources remain the truth. */
export async function notifyTaskProjectReferences(tx: object, scope: { companyId: string; issueId?: string | null }) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.taskProjectReferences, scope.issueId ? `${scope.companyId}:${scope.issueId}` : scope.companyId);
}
