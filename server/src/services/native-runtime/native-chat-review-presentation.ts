import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  agents,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  statusDecisionEffects,
  workAssessments,
  type Db,
} from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { isNativeRunnerOwnershipHeld } from "./native-runner-ownership.js";
import { hasChatRunOwnedProviderInteraction } from "../chat-interaction-arbitration.js";
import {
  authorizeChatConversationForBoundRun,
  isExternalChatWaitAuthorizationContention,
  resolveExternalChatResponseWaitAuthorizationInTransaction,
} from "./chat-attachment-reuse.js";

const SCHEMA = "paperclip.chat_review_response_presentation.v1";
export class NativeChatReviewPresentationContentionError extends Error {
  constructor() {
    super(
      "Chat response authorization is temporarily busy; no provider delivery was attempted",
    );
    this.name = "NativeChatReviewPresentationContentionError";
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function presentationContextSha256(value: unknown): string {
  // Heartbeat appends these two adapter-managed display fields after native
  // finalization. They do not change the authenticated chat actor or wake.
  // Keep every other context field in the hash, including unknown fields.
  const {
    paperclipRuntimeServices: _services,
    paperclipRuntimePrimaryUrl: _url,
    ...scope
  } = record(value);
  return nativeSha256(scope);
}

export interface NativeChatReviewPresentationProof {
  schema: typeof SCHEMA;
  runId: string;
  resultId: string;
  resultSha256: string;
  semanticSha256: string;
  contextSha256: string;
  assessmentId: string;
  gateId: string;
  gateDecisionId: string;
  gateSha256: string;
  summarySha256: string;
}

/** A completion review is not permission to complete the task. It may still
 * receive a separately requested chat response, without publishing its review
 * payload or a new approval/question from the current run. */
async function reviewPresentationEvidence(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    resultId: string;
    assessmentId: string;
    gateId: string;
  },
  lock: boolean,
): Promise<NativeChatReviewPresentationProof | null> {
  const [run, result, assessment, issue] = await Promise.all([
    db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.nativeIssueId, input.issueId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(nativeRunResults)
      .where(
        and(
          eq(nativeRunResults.id, input.resultId),
          eq(nativeRunResults.companyId, input.companyId),
          eq(nativeRunResults.issueId, input.issueId),
          eq(nativeRunResults.runId, input.runId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select()
      .from(workAssessments)
      .where(
        and(
          eq(workAssessments.id, input.assessmentId),
          eq(workAssessments.companyId, input.companyId),
          eq(workAssessments.issueId, input.issueId),
          eq(workAssessments.runId, input.runId),
          eq(workAssessments.resultId, input.resultId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ executionState: issues.executionState })
      .from(issues)
      .where(
        and(
          eq(issues.id, input.issueId),
          eq(issues.companyId, input.companyId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (
    !run ||
    run.runtimeMode !== "native" ||
    !result ||
    result.schemaStatus !== "accepted" ||
    !assessment ||
    assessment.triggerCapability !== "server_native_finalizer" ||
    !issue ||
    record(issue.executionState).status === "pending"
  )
    return null;
  const canonical = record(result.resultJson);
  const semantic = record(canonical.result);
  const continuation = record(semantic.continuation);
  const assessed = record(assessment.assessmentJson);
  if (
    semantic.schema !== "paperclip.run_result.v1" ||
    semantic.reportedWorkDisposition !== "yielded" ||
    record(canonical.terminal).runTerminalState !== "succeeded" ||
    continuation.kind !== "response_wake" ||
    typeof continuation.idempotencyKey !== "string" ||
    !continuation.idempotencyKey.trim() ||
    typeof semantic.summary !== "string" ||
    !semantic.summary.trim() ||
    !Array.isArray(semantic.attentionRequests) ||
    semantic.attentionRequests.length !== 0 ||
    assessed.reportedDisposition !== "yielded" ||
    record(assessed.continuation).kind !== "response_wake" ||
    !Array.isArray(assessed.attentionRequests) ||
    assessed.attentionRequests.length !== 0
  )
    return null;
  const gateQuery = db
    .select()
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.id, input.gateId),
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
      ),
    );
  const [gate] = await (lock
    ? gateQuery.for("update", { noWait: true }).limit(1)
    : gateQuery.limit(1));
  const target = record(record(gate?.payload).target);
  if (
    !gate ||
    gate.kind !== "request_confirmation" ||
    gate.createdByAgentId ||
    gate.createdByUserId ||
    !gate.sourceRunId ||
    gate.sourceRunId === run.id ||
    gate.createdAt >= (run.startedAt ?? run.createdAt) ||
    record(gate.payload).supersedeOnUserComment !== false ||
    target.type !== "custom" ||
    target.key !== "native_completion_review" ||
    typeof target.revisionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      target.revisionId,
    )
  )
    return null;
  const [origin, competingInteraction, competingApproval] = await Promise.all([
    db
      .select({ id: statusDecisions.id, decisionJson: statusDecisions.decisionJson })
      .from(statusDecisions)
      .innerJoin(
        statusDecisionEffects,
        and(
          eq(statusDecisionEffects.decisionId, statusDecisions.id),
          eq(statusDecisionEffects.companyId, input.companyId),
          eq(statusDecisionEffects.issueId, input.issueId),
          eq(statusDecisionEffects.effectKind, "bind_reviewer"),
          eq(statusDecisionEffects.targetType, "issue_thread_interaction"),
          eq(statusDecisionEffects.targetId, gate.id),
          eq(statusDecisionEffects.deliveryState, "delivered"),
        ),
      )
      .where(
        and(
          eq(statusDecisions.id, target.revisionId),
          eq(statusDecisions.companyId, input.companyId),
          eq(statusDecisions.issueId, input.issueId),
          eq(statusDecisions.runId, gate.sourceRunId),
          eq(statusDecisions.applicationState, "applied"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, input.issueId),
          eq(issueThreadInteractions.status, "pending"),
          ne(issueThreadInteractions.id, gate.id),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(
        approvals,
        and(
          eq(approvals.id, issueApprovals.approvalId),
          eq(approvals.companyId, input.companyId),
        ),
      )
      .where(
        and(
          eq(issueApprovals.companyId, input.companyId),
          eq(issueApprovals.issueId, input.issueId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]),
  ]);
  if (!origin || competingInteraction || competingApproval) return null;
  const reviewEffects = Array.isArray(origin.decisionJson.effects) ? origin.decisionJson.effects : [];
  const matchesReviewRequest = reviewEffects.some((value) => {
    const effect = record(value);
    const requestKey = typeof effect.requestKey === "string" ? effect.requestKey : null;
    return effect.kind === "bind_reviewer"
      && gate.idempotencyKey === `native-review:${origin.id}${requestKey ? `:${requestKey}` : ""}`;
  });
  if (!matchesReviewRequest) return null;
  if (await hasChatRunOwnedProviderInteraction(db, input)) return null;
  return {
    schema: SCHEMA,
    runId: run.id,
    resultId: result.id,
    resultSha256: result.canonicalSha256,
    semanticSha256: nativeSha256(semantic),
    contextSha256: presentationContextSha256(run.contextSnapshot),
    assessmentId: assessment.id,
    gateId: gate.id,
    gateDecisionId: origin.id,
    gateSha256: nativeSha256({
      payload: gate.payload,
      requestedResolverPolicy: gate.requestedResolverPolicy,
      effectiveResolverPolicy: gate.effectiveResolverPolicy,
      addresseeAgentId: gate.addresseeAgentId,
      addresseeUserId: gate.addresseeUserId,
      continuationPolicy: gate.continuationPolicy,
    }),
    summarySha256: nativeSha256(semantic.summary),
  };
}

/** Called only inside the native status transaction while it owns the issue. */
export async function prepareNativeChatReviewPresentationInTransaction(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    resultId: string;
    assessmentId: string;
    gateId: string;
    agentId: string;
  },
) {
  const authorization =
    await resolveExternalChatResponseWaitAuthorizationInTransaction(
      db,
      input,
      "nonblocking",
    );
  // The caller already owns coordinator -> issue. Acquire run/actor/chat
  // policy before the review row, always NOWAIT when crossing policy locks.
  return authorization === "authorized"
    ? reviewPresentationEvidence(db, input, true)
    : null;
}

/** A model-supplied marker is insufficient: match the committed decision,
 * immutable canonical result, actual review effect, and current gate again. */
export async function authorizeNativeChatReviewPresentation(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    resultJson: Record<string, unknown>;
    destination?: { endpointId: string; conversationId: string };
  },
  lockMode: "read" | "nonblocking" = "read",
): Promise<boolean> {
  const marker = record(input.resultJson.externalChatReviewPresentation);
  if (
    marker.schema !== SCHEMA ||
    marker.runId !== input.runId ||
    typeof marker.decisionId !== "string"
  )
    return false;
  const coordinatorQuery = db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.runId, input.runId),
        eq(nativeRunFinalizations.companyId, input.companyId),
        eq(nativeRunFinalizations.issueId, input.issueId),
        eq(nativeRunFinalizations.phase, "committed"),
      ),
    );
  const [coordinator] = await (lockMode === "read"
    ? coordinatorQuery.limit(1)
    : coordinatorQuery.for("update", { noWait: true }).limit(1));
  if (
    !coordinator ||
    !coordinator.assessmentId ||
    !coordinator.resultId ||
    coordinator.decisionId !== marker.decisionId ||
    coordinator.resultId !== marker.resultId ||
    coordinator.assessmentId !== marker.assessmentId
  )
    return false;
  const [decision] = await db
    .select()
    .from(statusDecisions)
    .where(
      and(
        eq(statusDecisions.id, coordinator.decisionId),
        eq(statusDecisions.companyId, input.companyId),
        eq(statusDecisions.issueId, input.issueId),
        eq(statusDecisions.runId, input.runId),
        eq(statusDecisions.assessmentId, coordinator.assessmentId),
        eq(statusDecisions.applicationState, "applied"),
        eq(statusDecisions.reasonCode, "governed_response_waiting"),
      ),
    )
    .limit(1);
  const stored = record(
    record(decision?.decisionJson).externalChatReviewPresentation,
  );
  if (
    !decision ||
    nativeSha256({ ...stored, decisionId: decision.id }) !==
      nativeSha256(marker) ||
    nativeSha256(input.resultJson.nativeResult) !== marker.semanticSha256 ||
    nativeSha256(record(input.resultJson.nativeResult).summary) !==
      marker.summarySha256 ||
    input.resultJson.finalizationPhase !== "committed" ||
    input.resultJson.finalizationReasonCode !== "governed_response_waiting"
  )
    return false;
  const issueQuery = db
    .select()
    .from(issues)
    .where(
      and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)),
    );
  const [issue] = await (lockMode === "read"
    ? issueQuery.limit(1)
    : issueQuery.for("update", { noWait: true }).limit(1));
  const runQuery = db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.nativeIssueId, input.issueId),
      ),
    );
  const [run] = await (lockMode === "read"
    ? runQuery.limit(1)
    : runQuery.for("update", { noWait: true }).limit(1));
  if (
    !issue ||
    !run ||
    run.status !== "succeeded" ||
    isNativeRunnerOwnershipHeld(run) ||
    issue.status !== "in_review" ||
    issue.assigneeAgentId !== run.agentId ||
    presentationContextSha256(run.contextSnapshot) !== marker.contextSha256
  )
    return false;
  const agentQuery = db
    .select({ status: agents.status })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, input.companyId)),
    );
  const [agent] = await (lockMode === "read"
    ? agentQuery.limit(1)
    : agentQuery.for("update", { noWait: true }).limit(1));
  if (
    !agent ||
    // This run has already succeeded with an exact committed response proof.
    // A later or unrelated run may set the shared agent's runtime-health status
    // to error; that does not revoke this completed response. Explicit pauses
    // (including budget pauses), termination and approval gates still deny.
    ["paused", "terminated", "pending_approval"].includes(agent.status)
  )
    return false;
  try {
    const destination = await authorizeChatConversationForBoundRun(
      db,
      { ...input, agentId: run.agentId },
      run.contextSnapshot,
      lockMode,
    );
    if (
      input.destination &&
      (destination.endpointId !== input.destination.endpointId ||
        destination.conversationId !== input.destination.conversationId)
    )
      return false;
  } catch (error) {
    if (
      error instanceof Error &&
      [
        "paperclip_runner_chat_attachment_binding_denied",
        "paperclip_runner_chat_attachment_destination_denied",
        "paperclip_runner_chat_attachment_principal_denied",
      ].includes(error.message)
    )
      return false;
    throw error;
  }
  const proof = await reviewPresentationEvidence(
    db,
    {
      ...input,
      resultId: String(marker.resultId),
      assessmentId: String(marker.assessmentId),
      gateId: String(marker.gateId),
    },
    lockMode !== "read",
  );
  return proof !== null && nativeSha256(proof) === nativeSha256(stored);
}

/** Retry the whole comment transaction, never while holding governance locks. */
export async function retryNativeChatReviewPresentation<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  for (let index = 0; ; index += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (index >= 5 || !isExternalChatWaitAuthorizationContention(error))
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** index));
    }
  }
}

/** Recover only server-committed presentation metadata, never a model marker.
 * The coordinator lock prevents a stale replay overwriting a newer decision;
 * JSON merge preserves unrelated live run metadata. */
export async function restoreNativeChatReviewPresentationInTransaction(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    decisionId: string;
    resultId: string;
    assessmentId: string;
  },
): Promise<boolean> {
  const [coordinator] = await db
    .select()
    .from(nativeRunFinalizations)
    .where(
      and(
        eq(nativeRunFinalizations.companyId, input.companyId),
        eq(nativeRunFinalizations.issueId, input.issueId),
        eq(nativeRunFinalizations.runId, input.runId),
        eq(nativeRunFinalizations.phase, "committed"),
        eq(nativeRunFinalizations.decisionId, input.decisionId),
        eq(nativeRunFinalizations.resultId, input.resultId),
        eq(nativeRunFinalizations.assessmentId, input.assessmentId),
      ),
    )
    .for("update")
    .limit(1);
  if (!coordinator) return false;
  const [decision] = await db
    .select()
    .from(statusDecisions)
    .where(
      and(
        eq(statusDecisions.id, input.decisionId),
        eq(statusDecisions.companyId, input.companyId),
        eq(statusDecisions.issueId, input.issueId),
        eq(statusDecisions.runId, input.runId),
        eq(statusDecisions.assessmentId, input.assessmentId),
        eq(statusDecisions.reasonCode, "governed_response_waiting"),
        eq(statusDecisions.applicationState, "applied"),
      ),
    )
    .limit(1);
  const proof = record(
    record(decision?.decisionJson).externalChatReviewPresentation,
  );
  if (
    !decision ||
    proof.schema !== SCHEMA ||
    proof.runId !== input.runId ||
    proof.resultId !== input.resultId ||
    proof.assessmentId !== input.assessmentId
  )
    return false;
  const [result] = await db
    .select()
    .from(nativeRunResults)
    .where(
      and(
        eq(nativeRunResults.id, input.resultId),
        eq(nativeRunResults.companyId, input.companyId),
        eq(nativeRunResults.issueId, input.issueId),
        eq(nativeRunResults.runId, input.runId),
        eq(nativeRunResults.schemaStatus, "accepted"),
      ),
    )
    .limit(1);
  if (
    !result ||
    result.canonicalSha256 !== proof.resultSha256 ||
    nativeSha256(result.resultJson.result) !== proof.semanticSha256
  )
    return false;
  const projection = {
    nativeResult: result.resultJson.result,
    finalizationPhase: "committed",
    finalizationReasonCode: decision.reasonCode,
    finalizationPolicyVersion: decision.policyVersion,
    authoritativeDecision: decision.toStatus,
    decisionId: input.decisionId,
    assessmentId: input.assessmentId,
    externalChatReviewPresentation: { ...proof, decisionId: input.decisionId },
  };
  const [updated] = await db
    .update(heartbeatRuns)
    .set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify(projection)}::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.nativeIssueId, input.issueId),
        eq(heartbeatRuns.runtimeMode, "native"),
      ),
    )
    .returning({ id: heartbeatRuns.id });
  return Boolean(updated);
}

/** The authorized comment and its publication intents were inserted together.
 * Its durable existence is a receipt, including an intentional soft deletion:
 * periodic recovery must not recreate an operator-deleted answer. */
export async function hasMaterializedNativeReviewResponse(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    runId: string;
    decisionId: string;
  },
): Promise<boolean> {
  const [comment] = await db
    .select({ id: issueComments.id })
    .from(issueComments)
    .innerJoin(
      heartbeatRuns,
      and(
        eq(heartbeatRuns.id, issueComments.createdByRunId),
        eq(heartbeatRuns.companyId, issueComments.companyId),
        eq(heartbeatRuns.agentId, issueComments.authorAgentId),
      ),
    )
    .where(
      and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.createdByRunId, input.runId),
        eq(issueComments.authorType, "agent"),
        sql`${issueComments.metadata}->>'authorizationReason' = 'allow_chat_run_presentation'`,
        sql`${heartbeatRuns.resultJson}->'externalChatReviewPresentation'->>'decisionId' = ${input.decisionId}`,
      ),
    )
    .limit(1);
  return Boolean(comment);
}
