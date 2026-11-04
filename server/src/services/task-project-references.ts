import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import {
  agentTaskSessions,
  cases,
  documentAnnotationComments,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issueProjectReferences,
  issueThreadInteractions,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import { scanProjectMentions } from "@paperclipai/shared";
import { MAX_ADMISSION_PROJECTS, readRetainedSessionProjects } from "../modules/execution-admission/index.js";
import { authorizationService, type AuthorizationActor } from "./authorization.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/**
 * The task-context owner's project references: the optional primary project
 * union every structured `project://` link in content Paperclip supplies to the
 * task's execution (title, description, undeleted comments, every issue
 * document, plan-review annotation comments, thread interactions, workflow case
 * facts and the accepted plan revision). Triggers advance
 * `issues.context_reference_revision` in the statement of every source write;
 * the projection in `issue_project_references` is only a candidate index.
 */
export type TaskProjectReferences =
  | { kind: "resolved"; revision: number; primaryProjectId: string | null; projectIds: string[] }
  | { kind: "not_found" }
  | { kind: "revision_changed"; revision: number }
  | { kind: "context_source_unavailable" }
  | { kind: "fresh_context_required" }
  | { kind: "too_many_projects"; count: number; limit: number }
  | { kind: "invalid_references"; malformed: number; unavailable: number }
  | { kind: "unauthorized"; count: number };

export type ResolveTaskProjectReferencesInput = {
  companyId: string;
  issueId: string;
  /** The execution's actor; a reference never grants access. */
  actor: AuthorizationActor;
  /** The accepted plan revision the queued intent supplies instead of the latest plan. */
  acceptedPlanRevisionId?: string | null;
  /** A resumed provider session carries its previous admission's references. */
  retainedSessionId?: string | null;
  /** The revision of an earlier unlocked hint; a mismatch asks the caller to retry. */
  expectedRevision?: number;
};

const LINK = "%project://%";

function textLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textLeaves);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...textLeaves(item)]);
  return [];
}

/**
 * Lock-order step 4: locks the task FOR UPDATE, after any project locks the
 * caller holds, then reads every source in full. Summaries, truncation,
 * pagination and workspace staging never shrink the set. Outcomes carry counts,
 * never inaccessible project IDs or names. Must run in the caller's transaction.
 */
export async function resolveTaskProjectReferences(tx: Db, input: ResolveTaskProjectReferencesInput): Promise<TaskProjectReferences> {
  if (!("nestedIndex" in tx)) throw new Error("Task project references must be resolved in a transaction");
  const { companyId, issueId } = input;
  const [issue] = await tx.select({ title: issues.title, description: issues.description, projectId: issues.projectId,
    revision: issues.contextReferenceRevision }).from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId))).for("update");
  if (!issue) return { kind: "not_found" };
  if (input.expectedRevision !== undefined && input.expectedRevision !== issue.revision) {
    return { kind: "revision_changed", revision: issue.revision };
  }
  const [comments, issueDocs, annotations, interactions, caseFacts, acceptedPlan] = await Promise.all([
    tx.select({ body: issueComments.body }).from(issueComments).where(and(eq(issueComments.companyId, companyId),
      eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt), ilike(issueComments.body, LINK))),
    tx.select({ body: documents.latestBody }).from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId), ilike(documents.latestBody, LINK))),
    tx.select({ body: documentAnnotationComments.body }).from(documentAnnotationComments).where(and(eq(documentAnnotationComments.companyId, companyId),
      eq(documentAnnotationComments.issueId, issueId), ilike(documentAnnotationComments.body, LINK))),
    tx.select({ title: issueThreadInteractions.title, summary: issueThreadInteractions.summary, payload: issueThreadInteractions.payload,
      result: issueThreadInteractions.result }).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId), sql`concat_ws(' ', ${issueThreadInteractions.title}, ${issueThreadInteractions.summary},
        ${issueThreadInteractions.payload}::text, ${issueThreadInteractions.result}::text) ilike ${LINK}`)),
    tx.select({ title: cases.title, summary: cases.summary, fields: cases.fields }).from(cases)
      .where(and(eq(cases.companyId, companyId), eq(cases.workIssueId, issueId))),
    input.acceptedPlanRevisionId
      ? tx.select({ body: documentRevisions.body }).from(documentRevisions)
        .innerJoin(issueDocuments, eq(issueDocuments.documentId, documentRevisions.documentId))
        .where(and(eq(documentRevisions.companyId, companyId), eq(documentRevisions.id, input.acceptedPlanRevisionId),
          eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, "plan")))
      : Promise.resolve(null),
  ]);
  if (acceptedPlan && acceptedPlan.length === 0) return { kind: "context_source_unavailable" };

  const texts = [issue.title, issue.description ?? "", ...comments.map(row => row.body), ...issueDocs.map(row => row.body),
    ...annotations.map(row => row.body), ...(acceptedPlan ?? []).map(row => row.body),
    ...interactions.flatMap(row => textLeaves([row.title, row.summary, row.payload, row.result])),
    ...caseFacts.flatMap(row => textLeaves([row.title, row.summary, row.fields]))];
  let malformed = 0;
  const referenced = new Set<string>();
  for (const text of texts) {
    const scan = scanProjectMentions(text);
    malformed += scan.malformed;
    for (const projectId of scan.projectIds) referenced.add(projectId);
  }
  const primaryProjectId = issue.projectId;
  let projectIds = [...new Set([...referenced, ...(primaryProjectId ? [primaryProjectId] : [])])].sort();

  if (input.retainedSessionId) {
    const [session] = await tx.select({ lastRunId: agentTaskSessions.lastRunId }).from(agentTaskSessions)
      .where(and(eq(agentTaskSessions.id, input.retainedSessionId), eq(agentTaskSessions.companyId, companyId)));
    if (!session?.lastRunId) return { kind: "fresh_context_required" };
    const retained = await readRetainedSessionProjects(tx, { companyId, runId: session.lastRunId }, projectIds);
    if (retained.kind === "fresh_context_required") return retained;
    projectIds = retained.projectIds;
  }
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
  return { kind: "resolved", revision: issue.revision, primaryProjectId, projectIds };
}

/**
 * Unlocked read of the projection: the projects to lock (in this order) before
 * resolving. A superset of the references; `resolveTaskProjectReferences` with
 * `expectedRevision` detects any change in between.
 */
export async function readTaskProjectReferenceHint(db: Db, scope: { companyId: string; issueId: string }) {
  const [issue] = await db.select({ revision: issues.contextReferenceRevision }).from(issues)
    .where(and(eq(issues.id, scope.issueId), eq(issues.companyId, scope.companyId)));
  if (!issue) return null;
  const rows = await db.selectDistinct({ projectId: issueProjectReferences.projectId }).from(issueProjectReferences)
    .where(and(eq(issueProjectReferences.companyId, scope.companyId), eq(issueProjectReferences.issueId, scope.issueId)))
    .orderBy(issueProjectReferences.projectId);
  return { revision: issue.revision, projectIds: rows.map(row => row.projectId) };
}

/** Indexed reverse lookup: candidate tasks that reference a project, primary or mentioned. */
export async function findTasksReferencingProject(db: Db, scope: { companyId: string; projectId: string }) {
  const rows = await db.selectDistinct({ issueId: issueProjectReferences.issueId }).from(issueProjectReferences)
    .where(and(eq(issueProjectReferences.companyId, scope.companyId), eq(issueProjectReferences.projectId, scope.projectId)))
    .orderBy(issueProjectReferences.issueId);
  return rows.map(row => row.issueId);
}

/** Hint for waiting work after the outer commit; the revision and projection are the truth. */
export async function notifyTaskProjectReferences(tx: object, scope: { companyId: string; issueId?: string | null }) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.taskProjectReferences, scope.issueId ? `${scope.companyId}:${scope.issueId}` : scope.companyId);
}
