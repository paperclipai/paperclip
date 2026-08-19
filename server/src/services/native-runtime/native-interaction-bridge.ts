import type { Db } from "@paperclipai/db";
import type { NativeInteractionResponseEnvelope } from "../../vendor/paperclip-runner/index.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  agents,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisions,
  workAssessments,
} from "@paperclipai/db";
import { getAgentWorkEligibility } from "@paperclipai/shared";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { nativeSha256 } from "./canonical.js";
import { recordNativeAttentionAssessment } from "./work-assessments.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeGovernanceGate,
  type NativeStatusDecision,
  type NativeStatusEffect,
} from "./status-arbiter.js";

export class NativeInteractionBridgeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeInteractionBridgeError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export type NativeAttentionMaterializedTarget = {
  effectKind: string;
  targetType: string;
  targetId: string;
};

/**
 * Applies audit-only attention outcomes that intentionally create no status
 * decision. The durable interaction/coordinator mutation is the proof; a
 * synthetic delivered effect row is neither created nor accepted.
 */
export async function applyNativeAttentionStatusDecision(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  decision: NativeStatusDecision;
  targetInteractionId?: string;
  canonicalRequestId?: string;
}): Promise<NativeAttentionMaterializedTarget[]> {
  if (input.decision.statusAction !== "preserve") {
    throw new NativeInteractionBridgeError("native_attention_status_authority_invalid", "Audit-only attention cannot change issue status");
  }
  return input.db.transaction(async (tx) => {
    const targets: NativeAttentionMaterializedTarget[] = [];
    for (const effect of input.decision.effects) {
      if (effect.kind === "link_canonical_request") {
        const boundIds = [input.canonicalRequestId, input.targetInteractionId]
          .filter((id): id is string => typeof id === "string");
        const interactions = await tx.select({
          id: issueThreadInteractions.id,
          summary: issueThreadInteractions.summary,
        })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            ...(boundIds.length > 0 ? [inArray(issueThreadInteractions.id, boundIds)] : []),
          )).limit(2);
        const canonical = input.canonicalRequestId
          ? interactions.find((interaction) => interaction.id === input.canonicalRequestId)
          : interactions[0];
        const duplicate = input.targetInteractionId
          ? interactions.find((interaction) => interaction.id === input.targetInteractionId)
          : interactions.find((interaction) => interaction.id !== canonical?.id);
        if (!canonical || !duplicate || canonical.id === duplicate.id) {
          throw new NativeInteractionBridgeError("native_attention_canonical_pair_missing", "Canonical and duplicate requests are required");
        }
        const summary = `Canonical native attention request: ${canonical.id}`;
        if (duplicate.summary !== summary) {
          await tx.update(issueThreadInteractions).set({
            summary,
            updatedAt: new Date(),
          }).where(eq(issueThreadInteractions.id, duplicate.id));
        }
        targets.push({ effectKind: effect.kind, targetType: "issue_thread_interaction", targetId: duplicate.id });
        continue;
      }
      if (effect.kind === "record_stale_response") {
        const interaction = await tx.select({
          id: issueThreadInteractions.id,
          summary: issueThreadInteractions.summary,
        })
          .from(issueThreadInteractions).where(and(
            eq(issueThreadInteractions.companyId, input.companyId),
            eq(issueThreadInteractions.issueId, input.issueId),
            ...(input.targetInteractionId ? [eq(issueThreadInteractions.id, input.targetInteractionId)] : []),
          )).limit(1).then((rows) => rows[0] ?? null);
        if (!interaction) throw new NativeInteractionBridgeError("native_stale_response_missing", "Stale response is not durable");
        const summary = "Response retained for audit after native supersession.";
        if (interaction.summary !== summary) {
          await tx.update(issueThreadInteractions).set({
            summary,
            updatedAt: new Date(),
          }).where(eq(issueThreadInteractions.id, interaction.id));
        }
        targets.push({ effectKind: effect.kind, targetType: "issue_thread_interaction", targetId: interaction.id });
        continue;
      }
      if (effect.kind === "record_finalization_error") {
        const [coordinator] = await tx.update(nativeRunFinalizations).set({
          phase: "terminal_failure",
          failureCode: effect.cause,
          failureDetail: { nextAction: effect.nextAction, recoveryOwner: { kind: "agent", agentId: effect.agentId } },
          nextAttemptAt: null,
          updatedAt: new Date(),
        }).where(and(
          eq(nativeRunFinalizations.runId, input.runId),
          eq(nativeRunFinalizations.companyId, input.companyId),
          eq(nativeRunFinalizations.issueId, input.issueId),
        )).returning({ runId: nativeRunFinalizations.runId });
        if (!coordinator) throw new NativeInteractionBridgeError("native_finalization_coordinator_missing", "Native coordinator is required");
        await tx.update(heartbeatRuns).set({
          status: "failed",
          finishedAt: new Date(),
          nativePhase: "terminal_failure",
          nativePhaseUpdatedAt: new Date(),
          errorCode: effect.cause,
          updatedAt: new Date(),
        }).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
        targets.push({ effectKind: effect.kind, targetType: "native_run_finalization", targetId: coordinator.runId });
        continue;
      }
      throw new NativeInteractionBridgeError("native_attention_effect_unimplemented", effect.kind);
    }
    return targets;
  });
}

/**
 * Materialize only interactions that authorized this run's wake. Resolution
 * remains owned by the existing interaction service; this bridge is a
 * read-only, identity-bound projection and never receives credentials.
 */
export async function materializeNativeInteractionResponses(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
  interactionIds: string[];
}): Promise<NativeInteractionResponseEnvelope[]> {
  const requestedIds = new Set(input.interactionIds.filter(Boolean));
  if (requestedIds.size === 0) return [];
  const [interactions, issue] = await Promise.all([
    issueThreadInteractionService(input.db).listForIssue(input.issueId),
    input.db.select({ status: issues.status }).from(issues).where(and(
      eq(issues.id, input.issueId),
      eq(issues.companyId, input.companyId),
    )).limit(1).then((rows) => rows[0] ?? null),
  ]);
  if (!issue) throw new NativeInteractionBridgeError("native_interaction_binding_mismatch", "Issue binding not found");
  const responses: NativeInteractionResponseEnvelope[] = [];

  for (const interaction of interactions) {
    if (!requestedIds.has(interaction.id)) continue;
    if (interaction.companyId !== input.companyId || interaction.issueId !== input.issueId) {
      throw new NativeInteractionBridgeError(
        "native_interaction_binding_mismatch",
        `Interaction ${interaction.id} is not bound to the native company and issue`,
      );
    }
    const interactionResult = record(interaction.result);
    const supersessionOutcome = interaction.status === "expired"
      && ["superseded_by_newer_request", "superseded_by_comment", "stale_target"].includes(String(interactionResult.outcome));
    if (supersessionOutcome) {
      const duplicate = interactionResult.outcome === "superseded_by_newer_request";
      const decision = resolveNativeAttentionStatus({
        facts: duplicate
          ? {
              companyScopeValid: true,
              responseState: "none",
              route: "duplicate",
              summary: interaction.summary ?? interaction.title ?? "Duplicate native attention request",
            }
          : {
              companyScopeValid: true,
              responseState: "stale",
              route: "context",
              summary: interaction.summary ?? interaction.title ?? "Stale native attention response",
            },
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: input.agentId,
      });
      await applyNativeAttentionStatusDecision({
        db: input.db,
        companyId: input.companyId,
        issueId: input.issueId,
        runId: input.runId,
        decision,
        targetInteractionId: interaction.id,
        canonicalRequestId: typeof interactionResult.supersededByInteractionId === "string"
          ? interactionResult.supersededByInteractionId
          : undefined,
      });
      continue;
    }
    if (
      interaction.resolvedByRunId === input.runId
      || (
        interaction.resolvedByAgentId === input.agentId
        && interaction.createdByAgentId === input.agentId
      )
    ) {
      throw new NativeInteractionBridgeError(
        "native_interaction_self_approval",
        `Run ${input.runId} cannot consume a response it resolved itself`,
      );
    }
    if (!interaction.resolvedByUserId && !interaction.resolvedByAgentId) {
      throw new NativeInteractionBridgeError(
        "native_interaction_unresolved",
        `Interaction ${interaction.id} has no authorized resolver`,
      );
    }

    if (interaction.kind === "request_confirmation") {
      if (interaction.resolvedByAgentId === input.agentId) {
        throw new NativeInteractionBridgeError(
          "native_interaction_self_approval",
          `Agent ${input.agentId} cannot consume a confirmation it resolved`,
        );
      }
      if (interaction.payload.toolAction !== undefined) {
        throw new NativeInteractionBridgeError(
          "native_interaction_governed_request_unsupported",
          "Governed tool-action confirmations cannot enter a native model envelope",
        );
      }
      if (
        (interaction.status !== "accepted" && interaction.status !== "rejected")
        || !interaction.result
        || (interaction.result.outcome !== "accepted" && interaction.result.outcome !== "rejected")
      ) {
        throw new NativeInteractionBridgeError(
          "native_interaction_unresolved",
          `Confirmation ${interaction.id} is not authoritatively resolved`,
        );
      }
      const resolution = resolveNativeAttentionStatus({
        facts: {
          companyScopeValid: true,
          responseState: "resolved",
          route: "context",
          summary: interaction.summary ?? interaction.title ?? "Resolved native interaction",
        },
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: input.agentId,
      });
      if (resolution.reasonCode !== "attention_resolved_from_context") {
        throw new NativeInteractionBridgeError("native_attention_resolution_invalid", "Resolved interaction has no continuation policy");
      }
      responses.push({
        interactionId: interaction.id,
        kind: interaction.kind,
        response: {
          status: interaction.status,
          result: structuredClone(interaction.result) as unknown as Record<string, unknown>,
        },
      });
      continue;
    }

    if (interaction.kind === "ask_user_questions") {
      if (interaction.status !== "answered" || !interaction.result || interaction.result.cancelled === true) {
        throw new NativeInteractionBridgeError(
          "native_interaction_unresolved",
          `Question interaction ${interaction.id} is not authoritatively answered`,
        );
      }
      const resolution = resolveNativeAttentionStatus({
        facts: {
          companyScopeValid: true,
          responseState: "resolved",
          route: "context",
          summary: interaction.summary ?? interaction.title ?? "Answered native interaction",
        },
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: input.agentId,
      });
      if (resolution.reasonCode !== "attention_resolved_from_context") {
        throw new NativeInteractionBridgeError("native_attention_resolution_invalid", "Answered interaction has no continuation policy");
      }
      responses.push({
        interactionId: interaction.id,
        kind: interaction.kind,
        response: {
          status: interaction.status,
          result: structuredClone(interaction.result) as unknown as Record<string, unknown>,
        },
      });
      continue;
    }

    throw new NativeInteractionBridgeError(
      "native_runtime_request_unsupported",
      `Interaction kind ${interaction.kind} is not supported by the native input contract`,
    );
  }

  const missing = [...requestedIds].filter((id) => !responses.some((response) => response.interactionId === id));
  if (missing.length > 0) {
    throw new NativeInteractionBridgeError(
      "native_interaction_missing",
      `Native interaction response not found: ${missing.join(", ")}`,
    );
  }
  return responses.sort((left, right) => left.interactionId.localeCompare(right.interactionId));
}

/** Native runtimes never receive credentials and never auto-approve requests. */
export function rejectUnsupportedNativeRuntimeRequest(requestKind: string) {
  return {
    accepted: false as const,
    code: "native_runtime_request_unsupported" as const,
    requestKind,
    credentialsInjected: false as const,
    selfApproval: false as const,
  };
}

export type NativeAttentionFacts = {
  companyScopeValid: boolean;
  responseState: "none" | "resolved" | "stale" | "expired";
  route: "alternate_track" | "context" | "retry" | "agent" | "human" | "duplicate" | "recovery";
  summary: string;
  budgetExhausted?: boolean;
  governanceGate?: NativeGovernanceGate | null;
  resolvedTargetAgentId?: string | null;
};

export type NativeAttentionCandidate = {
  route: NativeAttentionFacts["route"];
  summary: string;
  responseState?: NativeAttentionFacts["responseState"];
  targetAgentId?: string | null;
  targetCompanyId?: string | null;
  budgetExhausted?: boolean;
  governanceGate?: NativeGovernanceGate | null;
  targetInteractionId?: string;
  canonicalRequestId?: string;
};

function nonEmptyText(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function candidateFromPersistedRequest(request: Record<string, unknown>): NativeAttentionCandidate {
  const summary = nonEmptyText(request.summary);
  if (!summary) {
    throw new NativeInteractionBridgeError(
      "native_attention_request_invalid",
      "Persisted native attention requires a summary",
    );
  }
  const target = record(request.target);
  const capability = nonEmptyText(request.requestedCapability) ?? nonEmptyText(request.kind);
  const ownerClass = nonEmptyText(target.ownerClass);
  const requiredAuthority = nonEmptyText(request.requiredAuthority);
  const responseState = nonEmptyText(request.responseState);
  const governanceGate = record(request.governanceGate);
  let route: NativeAttentionCandidate["route"];
  if (capability === "context_lookup") route = "context";
  else if (capability === "retry") route = "retry";
  else if (capability === "duplicate") route = "duplicate";
  else if (capability === "alternate_track" || ownerClass === "current_agent") route = "alternate_track";
  else if (capability === "domain_expertise" || ownerClass === "agent") route = "agent";
  else if (
    ["review", "credential_grant", "governed_approval", "subjective_decision", "external_action"].includes(capability ?? "")
    || ["board_user", "external_system"].includes(ownerClass ?? "")
    || ["board", "external"].includes(requiredAuthority ?? "")
  ) route = "human";
  else {
    throw new NativeInteractionBridgeError(
      "native_attention_request_invalid",
      `Persisted native attention capability ${capability ?? "unknown"} has no authorized route`,
    );
  }
  return {
    route,
    summary,
    responseState: ["none", "resolved", "stale", "expired"].includes(responseState ?? "")
      ? responseState as NativeAttentionFacts["responseState"]
      : undefined,
    targetAgentId: nonEmptyText(target.agentId),
    targetCompanyId: nonEmptyText(target.companyId),
    budgetExhausted: request.budgetExhausted === true,
    governanceGate: governanceGate.kind === "interaction" && nonEmptyText(governanceGate.id)
      ? { kind: "interaction", id: nonEmptyText(governanceGate.id)! }
      : null,
    targetInteractionId: nonEmptyText(request.targetInteractionId) ?? undefined,
    canonicalRequestId: nonEmptyText(request.canonicalRequestId) ?? undefined,
  };
}

export type PersistedNativeAttentionReceipt = {
  requestId: string;
  route: NativeAttentionCandidate["route"];
  assessmentId: string;
  decisionId: string | null;
  reasonCode: string | null;
  resolvedTargetAgentId: string | null;
  materializedTargets: NativeAttentionMaterializedTarget[];
  replayed: boolean;
};

/**
 * Runtime-reachable ingress for accepted attention facts. It starts from the
 * immutable package result row, derives an authorized route, appends one
 * assessment/decision lineage per request, and lets the existing issue and
 * interaction owners materialize the effect.
 */
export async function routePersistedNativeResultAttention(input: {
  db: Db;
  runId: string;
}): Promise<PersistedNativeAttentionReceipt[]> {
  const binding = await input.db.select({
    companyId: heartbeatRuns.companyId,
    runtimeMode: heartbeatRuns.runtimeMode,
    resultId: nativeRunFinalizations.resultId,
    issueId: nativeRunFinalizations.issueId,
  }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding || binding.runtimeMode !== "native" || !binding.resultId) {
    throw new NativeInteractionBridgeError(
      "native_attention_binding_mismatch",
      "Accepted native result binding not found",
    );
  }
  const resultRow = await input.db.select().from(nativeRunResults).where(and(
    eq(nativeRunResults.id, binding.resultId),
    eq(nativeRunResults.companyId, binding.companyId),
    eq(nativeRunResults.issueId, binding.issueId),
    eq(nativeRunResults.runId, input.runId),
    eq(nativeRunResults.schemaStatus, "accepted"),
  )).limit(1).then((rows) => rows[0] ?? null);
  if (!resultRow) {
    throw new NativeInteractionBridgeError(
      "native_attention_result_missing",
      "Accepted native result row not found",
    );
  }
  const result = record(record(resultRow.resultJson).result);
  const requests = Array.isArray(result.attentionRequests)
    ? result.attentionRequests.map(record)
    : [];
  const receipts: PersistedNativeAttentionReceipt[] = [];

  for (const [index, request] of requests.entries()) {
    const candidate = candidateFromPersistedRequest(request);
    const requestId = nonEmptyText(request.id) ?? nativeSha256({
      runId: input.runId,
      resultId: resultRow.id,
      index,
      request,
    });
    const existingAssessment = await input.db.select({ id: workAssessments.id })
      .from(workAssessments).where(and(
        eq(workAssessments.companyId, binding.companyId),
        eq(workAssessments.issueId, binding.issueId),
        eq(workAssessments.runId, input.runId),
        eq(workAssessments.triggerKind, "native_attention"),
        eq(workAssessments.triggerRef, requestId),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (existingAssessment) {
      const existingDecision = await input.db.select({
        id: statusDecisions.id,
        reasonCode: statusDecisions.reasonCode,
        decisionJson: statusDecisions.decisionJson,
      }).from(statusDecisions).where(and(
        eq(statusDecisions.companyId, binding.companyId),
        eq(statusDecisions.assessmentId, existingAssessment.id),
      )).limit(1).then((rows) => rows[0] ?? null);
      if (existingDecision) {
        const decisionJson = record(existingDecision.decisionJson);
        const effects = Array.isArray(decisionJson.effects) ? decisionJson.effects.map(record) : [];
        const delegation = effects.find((effect) => effect.kind === "create_delegated_issue");
        const finalizationError = effects.find((effect) => effect.kind === "record_finalization_error");
        await input.db.update(nativeRunFinalizations).set({
          phase: finalizationError ? "retryable_failure" : "committed",
          assessmentId: existingAssessment.id,
          decisionId: existingDecision.id,
          leaseOwner: null,
          leaseExpiresAt: null,
          failureCode: nonEmptyText(finalizationError?.cause),
          failureDetail: finalizationError ? {
            originalFailureCode: finalizationError.cause,
            nextAction: finalizationError.nextAction,
          } : null,
          nextAttemptAt: finalizationError ? new Date(Date.now() + 30_000) : null,
          updatedAt: new Date(),
        }).where(and(
          eq(nativeRunFinalizations.runId, input.runId),
          eq(nativeRunFinalizations.companyId, binding.companyId),
          eq(nativeRunFinalizations.issueId, binding.issueId),
        ));
        receipts.push({
          requestId,
          route: candidate.route,
          assessmentId: existingAssessment.id,
          decisionId: existingDecision.id,
          reasonCode: existingDecision.reasonCode,
          resolvedTargetAgentId: nonEmptyText(delegation?.agentId),
          materializedTargets: [],
          replayed: true,
        });
        continue;
      }
    }

    const issue = await input.db.select({
      status: issues.status,
      statusVersion: issues.statusVersion,
      lastStatusDecisionId: issues.lastStatusDecisionId,
    }).from(issues).where(and(
      eq(issues.id, binding.issueId),
      eq(issues.companyId, binding.companyId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!issue) throw new NativeInteractionBridgeError("native_attention_binding_mismatch", "Issue binding not found");
    const coordinator = await input.db.select({
      phase: nativeRunFinalizations.phase,
      assessmentId: nativeRunFinalizations.assessmentId,
    }).from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, input.runId))
      .limit(1).then((rows) => rows[0] ?? null);
    if (!coordinator) throw new NativeInteractionBridgeError("native_attention_binding_mismatch", "Coordinator binding not found");
    const assessment = await recordNativeAttentionAssessment({
      db: input.db,
      companyId: binding.companyId,
      issueId: binding.issueId,
      runId: input.runId,
      turnId: resultRow.turnId,
      contractId: resultRow.completionContractId,
      resultId: resultRow.id,
      requestId,
      request,
      routingFacts: candidate as unknown as Record<string, unknown>,
      priorIssueStatus: issue.status,
      priorStatusVersion: Number(issue.statusVersion),
      priorDecisionId: issue.lastStatusDecisionId,
      supersedesAssessmentId: coordinator.assessmentId,
    });
    const routed = await routeNativeAttention({
      db: input.db,
      runId: input.runId,
      assessmentId: assessment.id,
      allowSupersedingCommittedDecision: coordinator.phase === "committed",
      candidate,
    });
    receipts.push({
      requestId,
      route: candidate.route,
      assessmentId: assessment.id,
      decisionId: routed.decisionId,
      reasonCode: routed.decision.reasonCode,
      resolvedTargetAgentId: routed.resolvedTargetAgentId,
      materializedTargets: routed.targets,
      replayed: existingAssessment !== null,
    });
  }

  if (receipts.length > 0) {
    await input.db.transaction(async (tx) => {
      const run = await tx.select({ resultJson: heartbeatRuns.resultJson })
        .from(heartbeatRuns).where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.companyId, binding.companyId),
        )).for("update").limit(1).then((rows) => rows[0] ?? null);
      if (!run) throw new NativeInteractionBridgeError("native_attention_binding_mismatch", "Heartbeat run missing");
      await tx.update(heartbeatRuns).set({
        resultJson: { ...record(run.resultJson), nativeAttentionRouting: receipts },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, input.runId));
    });
  }
  return receipts;
}

/**
 * Internal owner-routing step for native attention. The persisted-result
 * ingress above supplies the server-owned assessment and untrusted candidate;
 * this step resolves company scope and commits or audit-materializes the
 * authority decision.
 */
export async function routeNativeAttention(input: {
  db: Db;
  runId: string;
  assessmentId?: string;
  allowSupersedingCommittedDecision?: boolean;
  candidate: NativeAttentionCandidate;
}) {
  const binding = await input.db.select({
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    runtimeMode: heartbeatRuns.runtimeMode,
    issueId: nativeRunFinalizations.issueId,
    assessmentId: nativeRunFinalizations.assessmentId,
    issueStatus: issues.status,
    issueStatusVersion: issues.statusVersion,
    issueDecisionId: issues.lastStatusDecisionId,
  }).from(heartbeatRuns)
    .innerJoin(nativeRunFinalizations, eq(nativeRunFinalizations.runId, heartbeatRuns.id))
    .innerJoin(issues, and(
      eq(issues.id, nativeRunFinalizations.issueId),
      eq(issues.companyId, heartbeatRuns.companyId),
    ))
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!binding || binding.runtimeMode !== "native") {
    throw new NativeInteractionBridgeError("native_attention_binding_mismatch", "Native attention run binding not found");
  }

  const companyAgents = await input.db.select({
    id: agents.id,
    companyId: agents.companyId,
    name: agents.name,
    status: agents.status,
    reportsTo: agents.reportsTo,
  }).from(agents).where(eq(agents.companyId, binding.companyId)).orderBy(asc(agents.createdAt), asc(agents.id));
  const targetSuggestion = input.candidate.targetAgentId
    ? await input.db.select({ id: agents.id, companyId: agents.companyId })
        .from(agents).where(eq(agents.id, input.candidate.targetAgentId)).limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const companyScopeValid = (
    !input.candidate.targetCompanyId
    || input.candidate.targetCompanyId === binding.companyId
  ) && (
    !input.candidate.targetAgentId
    || targetSuggestion?.companyId === binding.companyId
  );
  let resolvedTargetAgentId: string | null = null;
  if (companyScopeValid && input.candidate.route === "agent") {
    const eligible = companyAgents.filter((candidate) =>
      candidate.id !== binding.agentId
      && getAgentWorkEligibility({ agent: candidate, agents: companyAgents }).invokable
    );
    const requested = eligible.find((candidate) => candidate.id === input.candidate.targetAgentId);
    resolvedTargetAgentId = requested?.id ?? eligible[0]?.id ?? null;
  }

  const facts: NativeAttentionFacts = {
    companyScopeValid,
    responseState: input.candidate.responseState ?? "none",
    route: input.candidate.route === "agent" && !resolvedTargetAgentId
      ? "recovery"
      : input.candidate.route,
    summary: input.candidate.summary,
    budgetExhausted: input.candidate.budgetExhausted,
    governanceGate: input.candidate.governanceGate,
    resolvedTargetAgentId,
  };
  const decision = resolveNativeAttentionStatus({
    facts,
    priorIssueStatus: binding.issueStatus as NativeAuthoritativeIssueStatus,
    agentId: binding.agentId,
  });
  const auditOnly = decision.reasonCode === "attention_duplicate_suppressed";
  if (auditOnly) {
    const targets = await applyNativeAttentionStatusDecision({
      db: input.db,
      companyId: binding.companyId,
      issueId: binding.issueId,
      runId: input.runId,
      decision,
      targetInteractionId: input.candidate.targetInteractionId,
      canonicalRequestId: input.candidate.canonicalRequestId,
    });
    return { decision, decisionId: null, targets, resolvedTargetAgentId };
  }
  const assessmentId = input.assessmentId ?? binding.assessmentId;
  if (!assessmentId) {
    throw new NativeInteractionBridgeError(
      "native_attention_assessment_missing",
      "Native attention requires the server-owned work assessment for this result",
    );
  }
  const committed = await commitNativeStatusDecision({
    db: input.db,
    companyId: binding.companyId,
    issueId: binding.issueId,
    runId: input.runId,
    assessmentId,
    priorStatus: binding.issueStatus,
    priorStatusVersion: Number(binding.issueStatusVersion),
    priorDecisionId: binding.issueDecisionId,
    decision,
    allowSupersedingCommittedDecision: input.allowSupersedingCommittedDecision,
  });
  return {
    decision,
    decisionId: committed.decision.id,
    targets: [],
    resolvedTargetAgentId,
  };
}

/** Server-owned attention resolution from canonical routing facts. */
export function resolveNativeAttentionStatus(input: {
  facts: NativeAttentionFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusEffect[]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  const continuation = (reasonCode: string): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode,
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: input.facts.route === "agent" ? "response_wake" : "same_agent",
      summary: input.facts.summary,
      idempotencyKey: `native-attention:${input.facts.route}:${input.facts.summary}`,
      agentId: input.agentId,
    }],
  });

  if (!input.facts.companyScopeValid) {
    return preserve("result_schema_rejected", [{
      kind: "record_finalization_error",
      cause: "result_schema_rejected",
      nextAction: "Remove the cross-company attention target.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.responseState === "stale") {
    return preserve("attention_duplicate_suppressed", [{ kind: "record_stale_response" }]);
  }
  if (input.facts.responseState === "expired") {
    return preserve("attention_budget_exhausted", [{ kind: "record_expiry" }]);
  }
  if (input.facts.budgetExhausted || input.facts.route === "recovery") {
    return preserve("attention_budget_exhausted", [{
      kind: "record_finalization_error",
      cause: "attention_budget_exhausted",
      nextAction: "Assign a named recovery owner.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.route === "duplicate") {
    return preserve("attention_duplicate_suppressed", [{ kind: "link_canonical_request" }]);
  }
  if (input.facts.governanceGate) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "governed_gate_pending",
      unblockDescriptor: null,
      effects: [
        { kind: "create_interaction", gate: input.facts.governanceGate },
        { kind: "notify_owner", agentId: input.agentId, reason: "governed_gate_pending" },
      ],
    };
  }
  if (input.facts.route === "alternate_track") {
    return continuation("turn_waiting_other_track_live");
  }
  if (input.facts.route === "context" || input.facts.route === "retry") {
    return continuation("attention_resolved_from_context");
  }
  if (input.facts.route === "agent") {
    if (!input.facts.resolvedTargetAgentId) {
      return preserve("attention_budget_exhausted", [{
        kind: "record_finalization_error",
        cause: "attention_no_valid_route",
        nextAction: "Assign a same-company eligible delegate.",
        agentId: input.agentId,
      }]);
    }
    const decision = continuation("attention_routed_to_agent");
    return {
      ...decision,
      effects: [
        { kind: "create_delegated_issue", agentId: input.facts.resolvedTargetAgentId, summary: input.facts.summary },
        ...decision.effects,
      ],
    };
  }
  if (input.facts.route === "human") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "attention_requires_human_authority",
      unblockDescriptor: null,
      effects: [
        { kind: "create_interaction", prompt: input.facts.summary },
        { kind: "notify_owner", agentId: input.agentId, reason: "attention_requires_human_authority" },
      ],
    };
  }
  throw new NativeInteractionBridgeError("native_attention_facts_invalid", "Attention facts do not select a route");
}
