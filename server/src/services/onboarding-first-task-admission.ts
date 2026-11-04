import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { agents, documents, heartbeatRuns, issueComments, issueDocuments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { ONBOARDING_FIRST_TASK_ORIGIN_KIND, requestCheckboxConfirmationPayloadSchema, requestCheckboxConfirmationResultSchema,
  requestConfirmationPayloadSchema, requestConfirmationResultSchema } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const runOriginFields = {
  nativeIssueId: heartbeatRuns.nativeIssueId,
  issueId: heartbeatRuns.issueId,
  contextIssueId: sql<unknown>`${heartbeatRuns.contextSnapshot}->>'issueId'`,
  contextTaskId: sql<unknown>`${heartbeatRuns.contextSnapshot}->>'taskId'`,
  agentId: heartbeatRuns.agentId,
  responsibleUserId: heartbeatRuns.responsibleUserId,
};

function runIssueId(run: {
  nativeIssueId: string | null; issueId: string | null; contextIssueId: unknown; contextTaskId: unknown;
}): string | null {
  const id = run.nativeIssueId ?? run.issueId ?? run.contextIssueId ?? run.contextTaskId;
  return typeof id === "string" ? id : null;
}

const acceptanceRequired = () => forbidden(
  "First-task proposal requires human acceptance before creating execution tasks.",
  { code: "onboarding_first_task_acceptance_required" },
);

type FirstTaskMutationInput = {
  companyId: string;
  actorAgentId?: string | null;
  actorRunId?: string | null;
  blockedByIssueIds?: readonly string[];
};

async function readAuthenticatedFirstTaskSources(tx: Db, input: FirstTaskMutationInput, lockSource: boolean, parentIssueId?: string | null) {
  if (!input.actorAgentId || !input.actorRunId) return [];
  const [observedRun] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.actorRunId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.actorAgentId),
  ));
  if (!observedRun) throw forbidden("Authenticated agent run not found");
  const sourceIssueIds = [runIssueId(observedRun), parentIssueId].filter((id): id is string => Boolean(id));
  if (!sourceIssueIds.length) return [];
  // Let the UUID column compare identities, including PostgreSQL's accepted
  // uppercase, unhyphenated and braced forms. Do not compare raw input strings.
  const isRequestedBlocker = input.blockedByIssueIds?.length
    ? sql<boolean>`${inArray(issues.id, [...input.blockedByIssueIds])}`
    : sql<boolean>`false`;
  const query = tx.select({ id: issues.id, isRequestedBlocker }).from(issues).where(and(
    inArray(issues.id, sourceIssueIds), eq(issues.companyId, input.companyId),
    eq(issues.originKind, ONBOARDING_FIRST_TASK_ORIGIN_KIND),
  ));
  return lockSource ? await query.for("update") : await query;
}

function assertNotBlockedByFirstTaskSource(source: { isRequestedBlocker: boolean } | undefined) {
  if (source?.isRequestedBlocker) {
    throw badRequest(
      "First-task execution tasks cannot be blocked by their onboarding task. Remove the onboarding task from blockedByTaskIds (REST: blockedByIssueIds), preserve other required blockers, then use set_dependencies on the onboarding task to wait for the child.",
      { code: "onboarding_first_task_parent_blocker" },
    );
  }
}

/**
 * Creation admission for a run serving the server-owned onboarding task. This is
 * deliberately independent of the requested parent and client origin metadata.
 * Call inside the creation transaction, after a side-effect-free replay check.
 */
export async function assertOnboardingFirstTaskCreationAllowed(tx: Db, input: FirstTaskMutationInput): Promise<void> {
  if (!input.actorAgentId || !input.actorRunId) return;
  // Match the native authority/interaction lifecycle: issue, then run, then
  // interaction/document. Ordinary tasks acquire no additional row locks.
  const [source] = await readAuthenticatedFirstTaskSources(tx, input, true);
  if (!source) return;
  const [run] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.actorRunId), eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, input.actorAgentId),
  )).for("share");
  if (!run || runIssueId(run) !== source.id) throw acceptanceRequired();

  if (await readOnboardingFirstTaskDecision(tx, { companyId: input.companyId, issueId: source.id, outcomes: ["accepted"] }) !== "accepted") throw acceptanceRequired();
  assertNotBlockedByFirstTaskSource(source);
}

/** Blocker edits retain their own authorization; they do not consume a proposal. */
export async function assertOnboardingFirstTaskDependenciesAllowed(tx: Db, input: FirstTaskMutationInput & { parentIssueId: string | null }): Promise<void> {
  if (!input.blockedByIssueIds?.length) return;
  // The update owner already holds the actor-run authorization lock. A read is
  // sufficient for source identity and the locked target's structural parent;
  // do not lock a parent after a child. A child's own run has a different source
  // but must still not wait on its server-owned onboarding parent.
  const sources = await readAuthenticatedFirstTaskSources(tx, input, false, input.parentIssueId);
  assertNotBlockedByFirstTaskSource(sources.find(source => source.isRequestedBlocker));
}

/** Shared persisted-decision proof; creation and completion retain different authority. */
async function readOnboardingFirstTaskDecision(tx: Db, input: {
  companyId: string; issueId: string; outcomes: Array<"accepted" | "rejected">;
}): Promise<"accepted" | "rejected" | null> {
  // Select the newest proposal before checking its outcome: a later pending or
  // rejected proposal must never fall back to an older accepted scope. Governed
  // tool/credential actions and custom completion reviews are not proposals.
  const [proposal] = await tx.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId),
    inArray(issueThreadInteractions.kind, ["request_confirmation", "request_checkbox_confirmation"]),
    sql`NOT (${issueThreadInteractions.payload} ?| ARRAY['toolAction', 'secretProposal', 'connectionAuthorization'])`,
    sql`COALESCE(${issueThreadInteractions.payload}->'target'->>'type', '') <> 'custom'`,
  )).orderBy(desc(issueThreadInteractions.createdAt), desc(issueThreadInteractions.id)).limit(1).for("share");
  if (!proposal || (proposal.status !== "accepted" && proposal.status !== "rejected") ||
    !input.outcomes.includes(proposal.status) || !proposal.resolvedAt) return null;
  const checkbox = proposal.kind === "request_checkbox_confirmation";
  const payload = checkbox ? requestCheckboxConfirmationPayloadSchema.safeParse(proposal.payload)
    : requestConfirmationPayloadSchema.safeParse(proposal.payload);
  const result = checkbox ? requestCheckboxConfirmationResultSchema.safeParse(proposal.result)
    : requestConfirmationResultSchema.safeParse(proposal.result);
  if (!payload.success || !result.success || result.data.outcome !== proposal.status) return null;
  if (checkbox && proposal.status === "accepted") {
    const selected = object(result.data).selectedOptionIds;
    if (!("options" in payload.data) || !Array.isArray(selected) || selected.length === 0) return null;
    const allowed = new Set(payload.data.options.map(option => option.id));
    if (selected.some(id => typeof id !== "string" || !allowed.has(id))
      || selected.length < payload.data.minSelected
      || (payload.data.maxSelected != null && selected.length > payload.data.maxSelected)) return null;
  }

  if (proposal.sourceRunId) {
    const [origin] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, proposal.sourceRunId), eq(heartbeatRuns.companyId, input.companyId),
    )).for("share");
    if (!origin || runIssueId(origin) !== input.issueId || origin.agentId !== proposal.createdByAgentId) return null;
  } else if (proposal.createdByAgentId) {
    const [creator] = await tx.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, proposal.createdByAgentId));
    if (creator?.companyId !== input.companyId) return null;
  } else if (!proposal.createdByUserId) return null;

  const directHumanDecision = Boolean(proposal.resolvedByUserId && !proposal.resolvedByAgentId && !proposal.resolvedByRunId);
  if (!directHumanDecision) {
    const commentId = result.data.commentId;
    if (!commentId || !proposal.resolvedByAgentId || !proposal.resolvedByRunId) return null;
    const [comment] = await tx.select().from(issueComments).where(and(
      eq(issueComments.id, commentId), eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    )).for("share");
    if (!comment || comment.deletedAt || comment.authorType !== "user" || !comment.authorUserId
      || comment.authorAgentId || comment.createdByRunId || comment.derivedAuthorAgentId || comment.derivedCreatedByRunId
      || comment.sourceTrust?.disposition === "quarantined" || comment.createdAt < proposal.createdAt
      || comment.body.trim() === "/new") return null;
    const [resolver] = await tx.select(runOriginFields).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, proposal.resolvedByRunId), eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, proposal.resolvedByAgentId),
    )).for("share");
    if (!resolver || runIssueId(resolver) !== input.issueId
      || (resolver.responsibleUserId && resolver.responsibleUserId !== comment.authorUserId)) return null;
  }

  // Refusal permits acknowledgement and closure, never execution. An agent-only
  // plan edit cannot turn that human refusal into permission to execute.
  if (proposal.status === "rejected") return "rejected";

  const target = payload.data.target;
  const [plan] = await tx.select({ documentId: documents.id, revisionId: documents.latestRevisionId })
    .from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(
      eq(issueDocuments.companyId, input.companyId), eq(documents.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId), eq(issueDocuments.key, "plan"),
    )).for("share", { of: documents });
  // Document writers do not all lock the issue, so hold the document row too.
  // A saved plan must be accepted by revision; an untargeted card cannot stand
  // in for approval of a different or subsequently edited document.
  if (plan || target) {
    if (!target || target.type !== "issue_document" || target.key !== "plan"
      || (target.issueId && target.issueId !== input.issueId) || !plan || plan.revisionId !== target.revisionId
      || (target.documentId && plan.documentId !== target.documentId)) return null;
  }
  return "accepted";
}

/** Completion may acknowledge a trusted refusal; it never authorizes rejected work. */
export async function onboardingFirstTaskCompletionAllowed(tx: Db, input: {
  companyId: string; issueId: string; runId: string;
}): Promise<boolean> {
  const [source] = await tx.select({ id: issues.id, originKind: issues.originKind }).from(issues).where(and(
    eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
  ));
  if (!source) return false;
  if (source.originKind !== ONBOARDING_FIRST_TASK_ORIGIN_KIND) return true;
  // Only the first-task path takes additional authority locks. At status commit
  // these are held until the decision is written, in issue/run/proposal order.
  const [lockedSource] = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.id, source.id), eq(issues.companyId, input.companyId), eq(issues.originKind, ONBOARDING_FIRST_TASK_ORIGIN_KIND),
  )).for("update");
  if (!lockedSource) return false;
  const [run] = await tx.select({ ...runOriginFields, runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId),
  )).for("share");
  if (!run || run.runtimeMode !== "native" || run.nativeIssueId !== source.id) return false;
  return await readOnboardingFirstTaskDecision(tx, { companyId: input.companyId, issueId: source.id, outcomes: ["accepted", "rejected"] }) !== null;
}
