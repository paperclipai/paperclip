import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  companies,
  completionContracts,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issueRecoveryActions,
  issueWorkProducts,
  issues,
  nativeRunFinalizations,
  nativeRunResults,
  statusDecisionEffects,
  statusDecisions,
  workAssessments,
  workspaceOperations,
} from "@paperclipai/db";
import type { NativeEvidenceAssessment } from "../services/native-runtime/evidence-classifier.js";
import { classifyNativeEvidence } from "../services/native-runtime/evidence-classifier.js";
import {
  applyNativeAttentionStatusDecision,
  materializeNativeInteractionResponses,
  rejectUnsupportedNativeRuntimeRequest,
  resolveNativeAttentionStatus,
} from "../services/native-runtime/native-interaction-bridge.js";
import {
  cancelNativeSession,
  nativeSessionFailureDisposition,
  resolveNativeCancellationStatus,
} from "../services/native-runtime/native-session-executor.js";
import {
  inspectNativeCompatibilityState,
  inspectNativeMigrationState,
  resolveHeartbeatNativeRuntimeMode,
  resolveNativeCompatibilityStatus,
  resolveNativeMigrationStatus,
  resolveNativeRuntimeMode,
} from "../services/native-runtime/runtime-mode.js";
import {
  arbitrateNativeStatus,
  type NativeStatusDecision,
  type NativeStatusEffect,
} from "../services/native-runtime/status-arbiter.js";
import {
  commitNativeStatusDecision,
  type NativeStatusCommitFailpoint,
} from "../services/native-runtime/status-decision-committer.js";
import {
  projectNativeTerminalRunStatus,
  recordNativeFinalizationFailure,
  finalizeNativeRun,
  resolveNativeFinalizerStatus,
} from "../services/native-runtime/native-run-finalizer.js";
import {
  reconcileNativeFinalizations,
  resolveNativeReconciliationStatus,
} from "../services/native-runtime/native-finalization-reconciler.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type Fixture = {
  id: string;
  mode: "native" | "legacy";
  covers: Record<string, string[]>;
  given: Record<string, unknown>;
  expected: {
    statusAction: string;
    runStatus: string;
    reasonCode: string | null;
    requiredEffects: string[];
    forbiddenEffects: string[];
    livePathKind: string | null;
    preserveClaim: boolean;
    nativeRecords: boolean;
    decisionCount: number;
    maxWakeCount: number;
    maxNotificationCount: number;
  };
};

type Corpus = { schema: string; corpusRevision: number; fixtures: Fixture[] };

type PolicyObservation = {
  runStatus: string;
  statusAction: string;
  reasonCode: string | null;
  effects: string[];
  livePathKind: string | null;
  preserveClaim: boolean;
  nativeRecords: boolean;
  decisionCount: number;
  wakeCount: number;
  notificationCount: number;
};

type ConsumerExecution = {
  consumer: string;
  observed: Record<string, unknown>;
};

type FixtureObservation = PolicyObservation & {
  fixtureId: string;
  consumerExecutions: ConsumerExecution[];
  consumerEvidenceByRow: Map<string, string>;
};

type DisabledLiveEntrypoint = "attention" | "cancellation" | "reconciliation" | "rollout";

const corpusPath = fileURLToPath(new URL(
  "../../../packages/paperclip-runner/spec/fixtures/status-authority-sdk.json",
  import.meta.url,
));

const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as Corpus;

const matrixRowConsumers: Record<string, string> = {
  "SD-01": "native-finalizer-status",
  "SD-02": "native-finalizer-status",
  "SD-03": "native-finalizer-status",
  "SD-04": "native-finalizer-status",
  "SD-05": "native-finalizer-status",
  "SD-06": "native-finalizer-status",
  "SD-07": "native-finalizer-status",
  "SD-08": "native-finalizer-status",
  "SD-09": "native-attention-resolver",
  "SD-10": "native-attention-resolver",
  "SD-11": "native-attention-resolver",
  "SD-12": "native-attention-resolver",
  "SD-13": "native-attention-resolver",
  "SD-14": "native-finalizer-status",
  "SD-15": "native-finalizer-status",
  "SD-16": "native-cancellation-authority",
  "SD-17": "native-cancellation-authority",
  "SD-18": "native-cancellation-authority",
  "SD-19": "native-reconciliation-consumer",
  "TC-01": "native-run-terminal-projection",
  "TC-02": "native-run-terminal-projection",
  "TC-03": "native-run-terminal-projection",
  "TC-04": "native-run-terminal-projection",
  "TC-05": "native-run-terminal-projection",
  "TC-06": "native-run-terminal-projection",
  "TC-07": "native-run-terminal-projection",
  "TC-08": "native-run-terminal-projection",
  "ATT-01": "native-attention-resolver",
  "ATT-02": "native-attention-resolver",
  "ATT-03": "native-attention-resolver",
  "ATT-04": "native-attention-resolver",
  "ATT-05": "native-attention-resolver",
  "ATT-06": "native-attention-resolver",
  "ATT-07": "native-attention-resolver",
  "ATT-08": "native-attention-resolver",
  "ATT-09": "native-attention-resolver",
  "ATT-10": "native-attention-resolver",
  "ATT-11": "native-attention-resolver",
  "ATT-12": "native-attention-resolver",
  "LIVE-01": "status-decision-committer",
  "LIVE-02": "status-decision-committer",
  "LIVE-03": "status-decision-committer",
  "LIVE-04": "status-decision-committer",
  "LIVE-05": "status-decision-committer",
  "LIVE-06": "status-decision-committer",
  "REC-01": "native-reconciliation-consumer",
  "REC-02": "native-reconciliation-consumer",
  "REC-03": "native-reconciliation-consumer",
  "REC-04": "native-reconciliation-consumer",
  "REC-05": "native-reconciliation-consumer",
  "REC-06": "native-reconciliation-consumer",
  "REC-07": "native-reconciliation-consumer",
  "REC-08": "native-reconciliation-consumer",
  "COMP-01": "native-compatibility-read-model",
  "COMP-02": "native-compatibility-status",
  "COMP-03": "native-compatibility-read-model",
  "COMP-04": "native-compatibility-read-model",
  "COMP-05": "native-compatibility-status",
  "COMP-06": "native-compatibility-status",
  "COMP-07": "native-compatibility-read-model",
  "COMP-08": "native-compatibility-status",
  "MIG-01": "native-migration-read-model",
  "MIG-02": "native-migration-read-model",
  "MIG-03": "native-migration-read-model",
  "MIG-04": "native-migration-status",
  "MIG-05": "native-migration-status",
  "MIG-06": "native-migration-status",
  "MIG-07": "native-migration-status",
  "MIG-08": "heartbeat-runtime-selection",
  "MIG-09": "native-migration-read-model",
};

function requiredConsumerForMatrixRow(matrixRow: string) {
  const consumer = matrixRowConsumers[matrixRow];
  if (!consumer) throw new Error(`No production consumer assertion for ${matrixRow}`);
  return consumer;
}

const noNativeRecordStates = new Set([
  "legacy_exit_zero",
  "native_field_only_in_result_json",
  "preexisting_open_issue",
  "production_shaped_upgrade",
  "authorized_status_write",
  "no_native_rows",
  "no_reviewed_adapter_contract_migration",
]);

const completeEvidenceStates = new Set([
  "mechanically_satisfied",
  "low_risk_policy_claim",
  "new_evidence_satisfies_contract",
  "identical_result_before_ack",
  "result_preserved",
  "shadow_application_disabled",
  "mixed_ledger",
  "shadow_compute",
  "cohort_policy_pinned",
]);

const zeroDecisionStates = new Set([
  "safe_partial_parse", "equivalent_attention_family",
  "response_after_supersession", "reused_id_changed_material", "decision_committed_delivery_pending",
]);

const nativeStatusEffectKinds = new Set<NativeStatusEffect["kind"]>([
  "create_interaction", "bind_reviewer", "notify_owner", "enqueue_continuation",
  "bind_blocker", "schedule_retry", "record_finalization_error", "release_run_resources",
  "create_delegated_issue", "accept_replacement_turn", "cancel_continuations",
  "append_superseding_assessment", "dispatch_pending_effect", "increment_status_version",
  "schedule_reconciliation", "record_shadow_decision", "render_four_layers",
  "materialize_contract", "record_mode_labeled_divergence", "record_mode_native",
  "record_policy_version", "finish_as_native",
  "resume_workspace_operation", "record_expiry", "record_stale_response",
  "link_canonical_request", "record_recovery", "release_checkout",
]);

const supersedingDecisionStates = new Set([
  "new_evidence_satisfies_contract", "dependency_now_done", "explicit_resume_capability",
  "board_cancelled_before_cas", "new_policy_requires_review", "authorized_writer_incremented_version",
]);

const liveReconciliationStates = new Set([
  "board_cancelled_before_cas", "new_evidence_satisfies_contract", "new_policy_requires_review",
]);

function initialRunStatus(fixture: Fixture) {
  const terminalState = fixture.given.runTerminalState;
  if (["succeeded", "failed", "cancelled", "active"].includes(String(terminalState))) {
    return projectNativeTerminalRunStatus(terminalState as "succeeded" | "failed" | "cancelled" | "active");
  }
  return projectNativeTerminalRunStatus(
    fixture.given.nativeFinalization === "present" ? "succeeded" : "active",
  );
}

function fixtureDisposition(fixture: Fixture): NativeEvidenceAssessment["reportedDisposition"] {
  const value = fixture.given.reportedWorkDisposition;
  return ["done", "blocked", "needs_review", "yielded"].includes(String(value))
    ? value as NativeEvidenceAssessment["reportedDisposition"]
    : "yielded";
}

function failpointFor(fixture: Fixture): NativeStatusCommitFailpoint | undefined {
  if (fixture.given.fault === "continuation_insert_failure") return "continuation_materialization";
  if (fixture.given.fault === "reviewer_insert_failure") return "interaction_materialization";
  if (fixture.given.fault === "blocker_insert_failure") return "blocker_materialization";
  return undefined;
}

function attentionFactsFor(completionState: string, summary: string, governanceGate: { kind: "interaction"; id: string } | null) {
  switch (completionState) {
    case "alternate_track_runnable":
      return { companyScopeValid: true, responseState: "none" as const, route: "alternate_track" as const, summary };
    case "context_answer_current":
      return { companyScopeValid: true, responseState: "resolved" as const, route: "context" as const, summary };
    case "ordinary_domain_expertise":
      return { companyScopeValid: true, responseState: "none" as const, route: "agent" as const, summary };
    case "intentional_human_judgment":
      return { companyScopeValid: true, responseState: "none" as const, route: "human" as const, summary };
    case "equivalent_attention_family":
      return { companyScopeValid: true, responseState: "none" as const, route: "duplicate" as const, summary };
    case "resolver_budget_exhausted":
      return { companyScopeValid: true, responseState: "none" as const, route: "recovery" as const, summary, budgetExhausted: true };
    case "transient_retry_then_success":
      return { companyScopeValid: true, responseState: "resolved" as const, route: "retry" as const, summary };
    case "cross_company_target":
      return { companyScopeValid: false, responseState: "none" as const, route: "agent" as const, summary };
    case "response_after_supersession":
      return { companyScopeValid: true, responseState: "stale" as const, route: "context" as const, summary };
    case "interaction_expired":
      return { companyScopeValid: true, responseState: "expired" as const, route: "human" as const, summary };
    case "governed_gate_pending":
      return {
        companyScopeValid: true,
        responseState: "none" as const,
        route: "human" as const,
        summary,
        governanceGate,
      };
    default:
      return null;
  }
}

function reconciliationFactsFor(completionState: string) {
  switch (completionState) {
    case "equivalent_attention_family": return { equivalentAttentionFamily: true };
    case "identical_result_before_ack": return { canonicalReplay: true };
    case "reused_id_changed_material": return { callerMaterialConflict: true };
    case "result_preserved": return { workspaceOperationPending: true };
    case "decision_committed_delivery_pending": return { undeliveredEffectCount: 1 };
    case "board_cancelled_before_cas": return { authoritativeStatusChanged: true };
    case "new_evidence_satisfies_contract": return { newEvidenceSatisfiesContract: true };
    case "dependency_now_done": return { dependencyResolved: true };
    case "explicit_resume_capability": return { authorizedResume: true };
    case "new_policy_requires_review": return { policyVersionChanged: true };
    case "authorized_writer_incremented_version": return { statusVersionAdvanced: true };
    default: return null;
  }
}

function compatibilityFactsFor(completionState: string) {
  switch (completionState) {
    case "safe_partial_parse": return { invalidNativeFinalization: true };
    case "explicit_resume_capability": return { terminalResumeAuthorized: true };
    case "shadow_application_disabled": return { shadowApplicationDisabled: true };
    case "mixed_ledger": return { mixedLedger: true };
    case "authorized_writer_incremented_version": return { statusWriterAdvancedVersion: true };
    default: return null;
  }
}

function migrationFactsFor(completionState: string) {
  switch (completionState) {
    case "shadow_compute": return { shadowMaterialization: true };
    case "classified_native_legacy_divergence": return { classifiedDivergence: true };
    case "allowlisted_company_adapter_policy": return { applicationEnabled: true };
    case "cohort_policy_pinned": return { policyPinned: true };
    case "kill_switch_during_active_native_run": return { killSwitchActiveForNewRuns: true };
    default: return null;
  }
}

function comparisonFailures(fixture: Fixture, observed: FixtureObservation): string[] {
  const failures: string[] = [];
  if (observed.runStatus !== fixture.expected.runStatus) failures.push("runStatus");
  if (observed.statusAction !== fixture.expected.statusAction) failures.push("statusAction");
  if (observed.reasonCode !== fixture.expected.reasonCode) failures.push("reasonCode");
  for (const effect of fixture.expected.requiredEffects) {
    if (!observed.effects.includes(effect)) failures.push(`requiredEffects:${effect}`);
  }
  for (const effect of fixture.expected.forbiddenEffects) {
    if (observed.effects.includes(effect)) failures.push(`forbiddenEffects:${effect}`);
  }
  if (observed.livePathKind !== fixture.expected.livePathKind) failures.push("livePathKind");
  if (observed.preserveClaim !== fixture.expected.preserveClaim) failures.push("preserveClaim");
  if (observed.nativeRecords !== fixture.expected.nativeRecords) failures.push("nativeRecords");
  if (observed.decisionCount !== fixture.expected.decisionCount) failures.push("decisionCount");
  if (observed.wakeCount > fixture.expected.maxWakeCount) failures.push("maxWakeCount");
  if (observed.notificationCount > fixture.expected.maxNotificationCount) failures.push("maxNotificationCount");
  return failures;
}

describe("P6-31 Section 18.13 executable status-authority corpus", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const agentId = randomUUID();
  const delegateAgentId = randomUUID();
  const outsideCompanyId = randomUUID();
  const outsideAgentId = randomUUID();

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-status-corpus-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Status corpus", issuePrefix: "PSC" });
    await db.insert(companies).values({ id: outsideCompanyId, name: "Outside corpus", issuePrefix: "OUT" });
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Status corpus agent",
        adapterType: "codex_local",
        status: "running",
      },
      {
        id: delegateAgentId,
        companyId,
        name: "Eligible status corpus delegate",
        adapterType: "codex_local",
        status: "idle",
        capabilities: "Provide production status-authority expertise",
      },
      {
        id: outsideAgentId,
        companyId: outsideCompanyId,
        name: "Outside-company agent",
        adapterType: "codex_local",
        status: "idle",
      },
    ]);
  }, 30_000);

  afterAll(async () => temporary?.cleanup());

  async function seedFixture(fixture: Fixture) {
    const issueId = randomUUID();
    const runId = randomUUID();
    const contractId = randomUUID();
    const resultId = randomUUID();
    const assessmentId = randomUUID();
    const workProductId = randomUUID();
    const assessmentCreatedAt = new Date();
    const priorStatus = String(fixture.given.priorIssueStatus ?? "in_progress");
    const completionState = String(fixture.given.completionState ?? "");
    const nativeRecords = fixture.mode === "native" && !noNativeRecordStates.has(completionState);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: fixture.id,
      status: priorStatus,
      assigneeAgentId: agentId,
      workMode: "standard",
    });
    if (!nativeRecords) return {
      issueId,
      runId,
      workProductId,
      nativeRecords,
      assessmentId,
      contractId: null,
      resultId: null,
    };

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: initialRunStatus(fixture),
      runtimeMode: "native",
      runtimeModeResolvedAt: new Date(),
      contextSnapshot: { issueId, fixtureId: fixture.id },
      completionContractId: contractId,
      completionContractSha256: `contract:${fixture.id}`,
    });
    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "paperclip.completion-contract.v1",
      policyVersion: "phase6-v1",
      risk: "standard",
      completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal",
      contractJson: { revision: "corpus-v1", criteria: [{ id: "objective", requirement: fixture.id }] },
      canonicalSha256: `contract:${fixture.id}`,
      createdByActorType: "system",
      createdByActorId: "status-corpus",
    });
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId,
      completionContractId: contractId,
      serverFingerprint: `fingerprint:${fixture.id}`,
      schemaStatus: "accepted",
      resultJson: {
        fixtureId: fixture.id,
        result: {
          reportedWorkDisposition: fixtureDisposition(fixture),
          summary: fixture.id,
          completionClaim: {
            contractRevision: "corpus-v1",
            objectiveSatisfied: true,
            criteria: [{
              criterionId: "objective",
              status: "satisfied",
              evidenceRefs: [`work_product:${workProductId}`],
            }],
            remainingWork: [],
          },
          verification: [{
            commandOrCheck: "fixture",
            status: "passed",
            artifactRef: `work_product:${workProductId}`,
          }],
        },
        terminal: {
          runTerminalState: fixture.given.runTerminalState === "failed"
            ? "failed"
            : fixture.given.runTerminalState === "cancelled" ? "cancelled" : "succeeded",
        },
        ...(fixture.given.reportedWorkDisposition === null && fixture.given.nativeFinalization !== "invalid"
          ? {}
          : { completionClaim: { fixtureId: fixture.id, preserved: true } }),
      },
      canonicalSha256: `result:${fixture.id}`,
    });
    await db.insert(issueWorkProducts).values({
      id: workProductId,
      companyId,
      issueId,
      type: "artifact",
      provider: "paperclip",
      title: `${fixture.id} evidence`,
      status: "ready_for_review",
      reviewState: completionState === "new_evidence_satisfies_contract" ? "none" : "approved",
      createdAt: new Date(assessmentCreatedAt.getTime() - 1_000),
      updatedAt: new Date(assessmentCreatedAt.getTime() - 1_000),
    });
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId,
      contractId,
      resultId,
      triggerKind: "native_result",
      triggerActorCompanyId: companyId,
      priorIssueStatus: completionState === "board_cancelled_before_cas" ? "in_progress" : priorStatus,
      priorStatusVersion: 0,
      policyVersion: completionState === "new_policy_requires_review" ? "phase6-v1" : "phase6-v2",
      assessmentJson: {
        fixtureId: fixture.id,
        ...(completionState === "new_evidence_satisfies_contract" ? { allCriteriaSatisfied: false } : {}),
      },
      inputDigest: `assessment:${fixture.id}`,
      createdAt: assessmentCreatedAt,
    });
    await db.insert(nativeRunFinalizations).values({
      runId,
      companyId,
      issueId,
      phase: "assessing",
      resultId,
      assessmentId,
    });
    return { issueId, runId, workProductId, nativeRecords, assessmentId, contractId, resultId };
  }

  async function executeFixture(
    fixture: Fixture,
    options: { disableLiveEntrypoint?: DisabledLiveEntrypoint } = {},
  ): Promise<FixtureObservation> {
    const completionState = String(fixture.given.completionState ?? "");
    const seeded = await seedFixture(fixture);
    const consumerExecutions: ConsumerExecution[] = [];
    const materializedEffects = new Set<string>();
    const operationalEffects = new Set<string>();
    const priorIssueStatus = String(fixture.given.priorIssueStatus ?? "in_progress") as Parameters<typeof arbitrateNativeStatus>[0]["priorIssueStatus"];
    const mode = resolveNativeRuntimeMode({
      enabled: fixture.mode === "native",
      runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
      agent: { id: agentId, status: "running", adapterType: "codex_local" },
      issue: { id: seeded.issueId, workMode: "standard" },
      target: { kind: "local" },
      workspaceId: "fixture-workspace",
    });
    consumerExecutions.push({ consumer: "runtime-mode", observed: { kind: mode.kind, reason: mode.reason } });
    if (mode.kind === "native") {
      expect(mode.authorityDecision.effects.some((effect) => effect.kind === "record_mode_native"), `${fixture.id}:native runtime authority`).toBe(true);
    } else if (mode.reason === "instance_flag_disabled") {
      expect(mode.authorityDecision?.effects.some((effect) => effect.kind === "record_shadow_decision"), `${fixture.id}:legacy compatibility authority`).toBe(true);
    }

    let governanceGate: { kind: "interaction"; id: string } | null = null;
    if (seeded.nativeRecords && completionState === "governed_gate_pending") {
      const interactionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId: seeded.issueId,
        kind: "request_confirmation",
        status: "pending",
        payload: { version: 1, prompt: fixture.id },
      });
      governanceGate = { kind: "interaction", id: interactionId };
    }

    const pushDecisionConsumer = (
      consumer: string,
      decision: NativeStatusDecision,
    ) => {
      consumerExecutions.push({
        consumer,
        observed: {
          statusAction: decision.statusAction,
          toStatus: decision.toStatus,
          reasonCode: decision.reasonCode,
          effects: decision.effects.map((effect) => effect.kind),
        },
      });
      return decision;
    };

    let semanticConsumer: string | null = null;
    let consumerDecision: NativeStatusDecision | null = null;
    let liveEntrypointCommitted = false;
    let liveAttentionInteractionId: string | null = null;
    const attentionFacts = attentionFactsFor(completionState, fixture.id, governanceGate);
    if (
      seeded.nativeRecords
      && options.disableLiveEntrypoint !== "attention"
      && attentionFacts
      && ["attention_response", "attention_candidate", "interaction", "monitor"].includes(String(fixture.given.trigger))
    ) {
      let canonicalRequestId: string | undefined;
      if (attentionFacts.route === "duplicate") {
        canonicalRequestId = randomUUID();
        liveAttentionInteractionId = randomUUID();
        await db.insert(issueThreadInteractions).values([
          {
            id: canonicalRequestId,
            companyId,
            issueId: seeded.issueId,
            kind: "request_confirmation",
            status: "pending",
            idempotencyKey: `canonical:${fixture.id}`,
            payload: { version: 1, prompt: `Canonical ${fixture.id}` },
          },
          {
            id: liveAttentionInteractionId,
            companyId,
            issueId: seeded.issueId,
            kind: "request_confirmation",
            status: "expired",
            resolvedAt: new Date(),
            idempotencyKey: `duplicate:${fixture.id}`,
            payload: { version: 1, prompt: `Duplicate ${fixture.id}` },
            result: { version: 1, outcome: "superseded_by_newer_request", supersededByInteractionId: canonicalRequestId },
          },
        ]);
      } else if (attentionFacts.responseState === "stale") {
        liveAttentionInteractionId = randomUUID();
        await db.insert(issueThreadInteractions).values({
          id: liveAttentionInteractionId,
          companyId,
          issueId: seeded.issueId,
          kind: "request_confirmation",
          status: "expired",
          resolvedAt: new Date(),
          payload: { version: 1, prompt: `Stale ${fixture.id}` },
          result: { version: 1, outcome: "superseded_by_comment", commentId: randomUUID() },
        });
      } else if (attentionFacts.responseState === "expired") {
        liveAttentionInteractionId = randomUUID();
        await db.insert(issueThreadInteractions).values({
          id: liveAttentionInteractionId,
          companyId,
          issueId: seeded.issueId,
          kind: "ask_user_questions",
          status: "pending",
          payload: { version: 1, questions: [] },
        });
      }
      const target = attentionFacts.route === "agent"
        ? {
            ownerClass: "agent",
            agentId: completionState === "cross_company_target" ? outsideAgentId : delegateAgentId,
            companyId: completionState === "cross_company_target" ? outsideCompanyId : companyId,
          }
        : attentionFacts.route === "human"
          ? { ownerClass: "board_user", companyId }
          : { ownerClass: "current_agent", companyId };
      const requestedCapability = attentionFacts.route === "context"
        ? "context_lookup"
        : attentionFacts.route === "retry"
          ? "retry"
          : attentionFacts.route === "duplicate"
            ? "duplicate"
            : attentionFacts.route === "alternate_track"
              ? "alternate_track"
            : attentionFacts.route === "human"
              ? "subjective_decision"
              : "domain_expertise";
      const resultRow = await db.select({ resultJson: nativeRunResults.resultJson })
        .from(nativeRunResults).where(eq(nativeRunResults.id, seeded.resultId!))
        .then((rows) => rows[0] ?? null);
      if (!resultRow) throw new Error(`${fixture.id}: persisted result missing`);
      const resultEnvelope = resultRow.resultJson as Record<string, unknown>;
      const persistedResult = resultEnvelope.result as Record<string, unknown>;
      await db.update(nativeRunResults).set({
        resultJson: {
          ...resultEnvelope,
          result: {
            ...persistedResult,
            attentionRequests: [{
              id: `attention:${fixture.id}`,
              requestedCapability,
              requiredAuthority: attentionFacts.route === "human" ? "board" : "agent",
              target,
              summary: attentionFacts.summary,
              responseState: attentionFacts.responseState,
              budgetExhausted: attentionFacts.budgetExhausted === true,
              governanceGate: attentionFacts.governanceGate,
              targetInteractionId: liveAttentionInteractionId,
              canonicalRequestId,
            }],
          },
        },
      }).where(eq(nativeRunResults.id, seeded.resultId!));
      const finalized = await finalizeNativeRun({
        db,
        runId: seeded.runId,
        workspaceFinalizeStatus: "succeeded",
        projectRunStatus: true,
      });
      const [receipt] = "attentionReceipts" in finalized ? finalized.attentionReceipts : [];
      if (!receipt) throw new Error(`${fixture.id}: persisted attention route missing`);
      const persistedDecision = receipt.decisionId
        ? await db.select().from(statusDecisions).where(eq(statusDecisions.id, receipt.decisionId))
            .then((rows) => rows[0] ?? null)
        : null;
      const persistedDecisionJson = persistedDecision?.decisionJson as Record<string, unknown> | undefined;
      const routedDecision = persistedDecision
        ? {
            policyVersion: persistedDecision.policyVersion,
            statusAction: persistedDecisionJson?.statusAction,
            toStatus: persistedDecision.toStatus,
            reasonCode: persistedDecision.reasonCode,
            unblockDescriptor: persistedDecisionJson?.unblockDescriptor ?? null,
            effects: persistedDecisionJson?.effects,
          } as NativeStatusDecision
        : resolveNativeAttentionStatus({ facts: attentionFacts, priorIssueStatus, agentId });
      semanticConsumer = "native-attention-resolver";
      consumerDecision = pushDecisionConsumer(semanticConsumer, routedDecision);
      liveEntrypointCommitted = true;
      for (const effect of routedDecision.effects) materializedEffects.add(effect.kind);
      consumerExecutions.push({
        consumer: "native-attention-finalizer",
        observed: {
          phase: finalized.phase,
          decisionId: receipt.decisionId,
          resolvedTargetAgentId: receipt.resolvedTargetAgentId,
          reasonCode: receipt.reasonCode,
          materializedTargets: receipt.materializedTargets,
          persistedResultId: seeded.resultId,
        },
      });
      if (receipt.decisionId === null) {
        const beforeReplay = liveAttentionInteractionId
          ? await db.select({
              summary: issueThreadInteractions.summary,
              updatedAt: issueThreadInteractions.updatedAt,
            }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, liveAttentionInteractionId))
              .then((rows) => rows[0] ?? null)
          : null;
        const assessmentCount = await db.select().from(workAssessments)
          .where(eq(workAssessments.runId, seeded.runId)).then((rows) => rows.length);
        const replayed = await finalizeNativeRun({
          db,
          runId: seeded.runId,
          workspaceFinalizeStatus: "succeeded",
          projectRunStatus: true,
        });
        expect(replayed, `${fixture.id}:audit replay coordinator`).toMatchObject({ phase: "committed", decisionId: null });
        if (liveAttentionInteractionId) {
          await expect(db.select({
            summary: issueThreadInteractions.summary,
            updatedAt: issueThreadInteractions.updatedAt,
          }).from(issueThreadInteractions).where(eq(issueThreadInteractions.id, liveAttentionInteractionId))
            .then((rows) => rows[0] ?? null)).resolves.toEqual(beforeReplay);
        }
        await expect(db.select().from(workAssessments)
          .where(eq(workAssessments.runId, seeded.runId)).then((rows) => rows.length)).resolves.toBe(assessmentCount);
      }
      if (attentionFacts.route === "agent" && completionState !== "cross_company_target") {
        expect(receipt.resolvedTargetAgentId, `${fixture.id}:eligible delegate`).toBe(delegateAgentId);
      }
    }
    if (["turn_scope", "run_scope", "issue_scope_authorized", "replacement_turn_accepted"].includes(completionState)) {
      semanticConsumer = "native-cancellation-authority";
      const scope = completionState === "run_scope" ? "run" : completionState === "issue_scope_authorized" ? "issue" : "turn";
      if (options.disableLiveEntrypoint === "cancellation") {
        consumerDecision = pushDecisionConsumer(semanticConsumer, resolveNativeCancellationStatus({
          scope,
          priorIssueStatus,
          agentId,
          replacementAccepted: completionState === "replacement_turn_accepted",
        }));
      } else {
        const cancellation = await cancelNativeSession(seeded.runId, `fixture:${fixture.id}`, {
          db,
          scope,
          replacementAccepted: completionState === "replacement_turn_accepted",
        });
        if (typeof cancellation === "boolean" || !cancellation.decision || !cancellation.auditId) {
          throw new Error(`${fixture.id}: live cancellation did not persist an authoritative outcome`);
        }
        consumerDecision = pushDecisionConsumer(semanticConsumer, cancellation.decision);
        liveEntrypointCommitted = true;
        for (const effect of cancellation.decision.effects) materializedEffects.add(effect.kind);
        consumerExecutions.push({
          consumer: "native-session-cancellation",
          observed: {
            dispatched: cancellation.dispatched,
            scope,
            reasonCode: cancellation.decision.reasonCode,
            decisionId: cancellation.decisionId,
            auditId: cancellation.auditId,
          },
        });
      }
    } else {
      const reconciliationFacts = reconciliationFactsFor(completionState);
      const compatibilityFacts = compatibilityFactsFor(completionState);
      const migrationFacts = migrationFactsFor(completionState);
      if (
        reconciliationFacts
        && !liveReconciliationStates.has(completionState)
        && (
          supersedingDecisionStates.has(completionState)
          || (fixture.covers.reconciliationRows ?? []).length > 0
          || String(fixture.given.trigger) === "dependency"
        )
      ) {
        semanticConsumer = "native-reconciliation-consumer";
        consumerDecision = pushDecisionConsumer(semanticConsumer, resolveNativeReconciliationStatus({
          facts: reconciliationFacts,
          priorIssueStatus,
          agentId,
        }));
      } else if (!consumerDecision && attentionFacts && ["attention_response", "attention_candidate", "interaction", "monitor"].includes(String(fixture.given.trigger))) {
        semanticConsumer = "native-attention-resolver";
        consumerDecision = pushDecisionConsumer(semanticConsumer, resolveNativeAttentionStatus({
          facts: options.disableLiveEntrypoint === "attention" && attentionFacts.route === "agent"
            ? { ...attentionFacts, resolvedTargetAgentId: delegateAgentId }
            : attentionFacts,
          priorIssueStatus,
          agentId,
        }));
      } else if (
        completionState === "kill_switch_during_active_native_run"
        && (fixture.covers.migrationRows ?? []).includes("MIG-08")
      ) {
        const runtimeConfig = {
          nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 },
        };
        const enabled = options.disableLiveEntrypoint === "rollout";
        const activeResolution = resolveHeartbeatNativeRuntimeMode({
          persisted: {
            runtimeMode: "native",
            runtimeModeReason: "eligible_opt_in",
            runtimeModeResolvedAt: new Date(),
          },
          enabled,
          runtimeConfig,
          agent: { id: agentId, status: "running", adapterType: "codex_local" },
          issue: { id: seeded.issueId, workMode: "standard" },
          target: { kind: "local" },
          workspaceId: "fixture-workspace",
        });
        const freshResolution = resolveHeartbeatNativeRuntimeMode({
          persisted: { runtimeMode: null, runtimeModeReason: null, runtimeModeResolvedAt: null },
          enabled,
          runtimeConfig,
          agent: { id: agentId, status: "running", adapterType: "codex_local" },
          issue: { id: seeded.issueId, workMode: "standard" },
          target: { kind: "local" },
          workspaceId: "fixture-workspace",
        });
        if (
          activeResolution.kind !== "native"
          || freshResolution.kind !== "legacy"
          || freshResolution.reason !== "instance_flag_disabled"
          || runtimeConfig.nativeRunner.mode !== "native"
        ) {
          throw new Error(`${fixture.id}: global kill-switch transition missing`);
        }
        semanticConsumer = "native-migration-status";
        consumerDecision = pushDecisionConsumer(semanticConsumer, activeResolution.authorityDecision);
        operationalEffects.add("fresh_flag_off_run_selects_legacy");
        consumerExecutions.push({
          consumer: "heartbeat-runtime-selection",
          observed: {
            activeMode: activeResolution.kind,
            freshMode: freshResolution.kind,
            freshReason: freshResolution.reason,
            profileMode: runtimeConfig.nativeRunner.mode,
          },
        });
      } else if (migrationFacts && (fixture.covers.migrationRows ?? []).length > 0 && (fixture.covers.decisionRows ?? []).length === 0) {
        semanticConsumer = "native-migration-status";
        consumerDecision = pushDecisionConsumer(
          semanticConsumer,
          completionState === "allowlisted_company_adapter_policy" && mode.kind === "native"
            ? mode.authorityDecision
            : resolveNativeMigrationStatus({ facts: migrationFacts, priorIssueStatus, agentId }),
        );
      } else if (compatibilityFacts && (fixture.covers.compatibilityRows ?? []).length > 0 && (fixture.covers.decisionRows ?? []).length === 0) {
        semanticConsumer = "native-compatibility-status";
        consumerDecision = pushDecisionConsumer(semanticConsumer, resolveNativeCompatibilityStatus({
          facts: compatibilityFacts,
          priorIssueStatus,
          agentId,
        }));
      } else if (completionState === "safe_partial_parse" && compatibilityFacts) {
        semanticConsumer = "native-finalizer-status";
        consumerDecision = pushDecisionConsumer(semanticConsumer, resolveNativeCompatibilityStatus({
          facts: compatibilityFacts,
          priorIssueStatus,
          agentId,
        }));
      }

      if (attentionFacts && (fixture.covers.attentionRows ?? []).length > 0 && semanticConsumer !== "native-attention-resolver") {
        pushDecisionConsumer("native-attention-resolver", resolveNativeAttentionStatus({ facts: attentionFacts, priorIssueStatus, agentId }));
      }
      if (
        reconciliationFacts
        && !liveReconciliationStates.has(completionState)
        && (fixture.covers.reconciliationRows ?? []).length > 0
        && semanticConsumer !== "native-reconciliation-consumer"
      ) {
        pushDecisionConsumer("native-reconciliation-consumer", resolveNativeReconciliationStatus({ facts: reconciliationFacts, priorIssueStatus, agentId }));
      }
      if (compatibilityFacts && (fixture.covers.compatibilityRows ?? []).some((row) => ["COMP-02", "COMP-05", "COMP-06", "COMP-07", "COMP-08"].includes(row)) && semanticConsumer !== "native-compatibility-status") {
        pushDecisionConsumer("native-compatibility-status", resolveNativeCompatibilityStatus({ facts: compatibilityFacts, priorIssueStatus, agentId }));
      }
      if (migrationFacts && (fixture.covers.migrationRows ?? []).some((row) => ["MIG-04", "MIG-05", "MIG-06", "MIG-07", "MIG-08"].includes(row)) && semanticConsumer !== "native-migration-status") {
        pushDecisionConsumer("native-migration-status", resolveNativeMigrationStatus({ facts: migrationFacts, priorIssueStatus, agentId }));
      }
    }

    if (
      seeded.nativeRecords
      && options.disableLiveEntrypoint !== "reconciliation"
      && liveReconciliationStates.has(completionState)
    ) {
      const [priorDecision] = await db.insert(statusDecisions).values({
        companyId,
        issueId: seeded.issueId,
        assessmentId: seeded.assessmentId,
        decisionVersion: 1,
        policyVersion: completionState === "new_policy_requires_review" ? "phase6-v1" : "phase6-v2",
        fromStatus: completionState === "board_cancelled_before_cas" ? "in_progress" : priorIssueStatus,
        toStatus: completionState === "board_cancelled_before_cas" ? "in_progress" : priorIssueStatus,
        reasonCode: "prior_fixture_decision",
        decisionJson: { superseded: true },
        decisionDigest: `prior-decision:${fixture.id}`,
        applicationState: "applied",
        appliedAt: new Date(),
      }).returning({ id: statusDecisions.id });
      await db.update(issues).set({
        statusVersion: 1,
        lastStatusDecisionId: priorDecision!.id,
      }).where(eq(issues.id, seeded.issueId));
      await db.update(nativeRunFinalizations).set({
        phase: "committed",
        decisionId: priorDecision!.id,
      }).where(eq(nativeRunFinalizations.runId, seeded.runId));
      if (completionState === "new_evidence_satisfies_contract") {
        await db.update(issueWorkProducts).set({
          reviewState: "approved",
          updatedAt: new Date(Date.now() + 1_000),
        }).where(eq(issueWorkProducts.id, seeded.workProductId));
      }
      const [reconciled] = await reconcileNativeFinalizations(db, [seeded.runId]);
      if (!reconciled?.reconciliationDecision || !reconciled.decisionId) {
        throw new Error(`${fixture.id}: live reconciliation did not commit an authoritative decision`);
      }
      semanticConsumer = "native-reconciliation-consumer";
      consumerDecision = pushDecisionConsumer(semanticConsumer, reconciled.reconciliationDecision);
      liveEntrypointCommitted = true;
      consumerExecutions.push({
        consumer: "native-reconciliation-entrypoint",
        observed: {
          action: reconciled.reconciliationAction,
          decisionId: reconciled.decisionId,
        },
      });
    }
    if (
      seeded.nativeRecords
      && options.disableLiveEntrypoint === "reconciliation"
      && liveReconciliationStates.has(completionState)
    ) {
      const facts = reconciliationFactsFor(completionState);
      if (!facts) throw new Error(`${fixture.id}: missing reconciliation facts`);
      semanticConsumer = "native-reconciliation-consumer";
      consumerDecision = pushDecisionConsumer(semanticConsumer, resolveNativeReconciliationStatus({
        facts,
        priorIssueStatus,
        agentId,
      }));
    }

    let assessment: NativeEvidenceAssessment | null = null;
    if (seeded.nativeRecords && ["runner_finalizer", "dependency", "shadow_comparator", "read_model", "authorized_agent"].includes(String(fixture.given.trigger))) {
      const accepted = completeEvidenceStates.has(completionState);
      const evidenceRef = accepted
        ? `work_product:${seeded.workProductId}`
        : `work_product:${randomUUID()}`;
      assessment = await classifyNativeEvidence({
        db,
        companyId,
        issueId: seeded.issueId,
        runId: seeded.runId,
        contract: { revision: "corpus-v1", criteria: [{ id: "objective" }] },
        result: {
          reportedWorkDisposition: fixtureDisposition(fixture),
          summary: fixture.id,
          completionClaim: {
            contractRevision: "corpus-v1",
            objectiveSatisfied: true,
            criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [evidenceRef] }],
            remainingWork: accepted ? [] : [{ blocksCompletion: true }],
          },
          verification: [{ commandOrCheck: "fixture", status: "passed", artifactRef: evidenceRef }],
          blocker: fixture.given.reportedWorkDisposition === "blocked"
            ? {
                scope: completionState === "task_wide_owner_action_bound" ? "task_wide" : "current_track",
                owner: { kind: "board" },
                unblockAction: `Resolve ${fixture.id}`,
              }
            : null,
          continuation: fixture.given.reportedWorkDisposition === "yielded" && completionState !== "no_durable_continuation"
            ? { kind: "same_agent", summary: fixture.id, idempotencyKey: `fixture:${fixture.id}` }
            : null,
        },
      });
      consumerExecutions.push({
        consumer: "evidence-classifier",
        observed: {
          allCriteriaSatisfied: assessment.allCriteriaSatisfied,
          verificationPassed: assessment.verificationPassed,
          acceptedEvidenceCount: assessment.acceptedEvidenceRefs.length,
          missingRequirementCount: assessment.missingRequirements.length,
        },
      });

      const liveDecision = resolveNativeFinalizerStatus({
        assessment,
        terminalState: fixture.given.runTerminalState === "failed"
          ? "failed"
          : fixture.given.runTerminalState === "cancelled" ? "cancelled" : "succeeded",
        workspaceFinalizeStatus: fixture.given.fault === "workspace_finalize_failure" ? "failed" : "succeeded",
        governanceGate,
        completionClaimPolicyAccepted: completionState === "low_risk_policy_claim",
        allowIncompleteContinuation: completionState !== "no_durable_continuation",
        agentId,
        priorIssueStatus,
      });
      consumerExecutions.push({
        consumer: "status-arbiter",
        observed: {
          toStatus: liveDecision.toStatus,
          reasonCode: liveDecision.reasonCode,
          effects: liveDecision.effects.map((effect) => effect.kind),
        },
      });
      if (!consumerDecision) {
        semanticConsumer = "native-finalizer-status";
        consumerDecision = pushDecisionConsumer(semanticConsumer, liveDecision);
      }
    }

    if (
      seeded.nativeRecords
      && options.disableLiveEntrypoint !== "reconciliation"
      && consumerDecision?.effects.some((effect) => effect.kind === "resume_workspace_operation")
    ) {
      await db.insert(workspaceOperations).values({
        companyId,
        heartbeatRunId: seeded.runId,
        issueId: seeded.issueId,
        phase: "workspace_finalize",
        status: "failed",
        exitCode: 1,
        cwd: process.cwd(),
        finishedAt: new Date(),
      });
      const [reconciled] = await reconcileNativeFinalizations(db, [seeded.runId]);
      if (!reconciled || reconciled.reconciliationAction !== "resume_workspace_operation") {
        throw new Error(`${fixture.id}: live workspace reconciliation did not execute (${JSON.stringify(reconciled)})`);
      }
      liveEntrypointCommitted = true;
      materializedEffects.add("resume_workspace_operation");
      consumerExecutions.push({
        consumer: "native-reconciliation-entrypoint",
        observed: {
          action: reconciled.reconciliationAction,
          workspaceOperationId: reconciled.workspaceOperationId,
          workspaceFinalizeStatus: reconciled.workspaceFinalizeStatus,
        },
      });
    }
    if (!liveEntrypointCommitted && seeded.nativeRecords && consumerDecision?.effects.some((effect) => effect.kind === "link_canonical_request")) {
      const canonicalInteractionId = randomUUID();
      liveAttentionInteractionId = randomUUID();
      await db.insert(issueThreadInteractions).values([
        {
          id: canonicalInteractionId,
          companyId,
          issueId: seeded.issueId,
          kind: "request_confirmation",
          status: "pending",
          idempotencyKey: `canonical:${fixture.id}`,
          payload: { version: 1, prompt: `Canonical ${fixture.id}` },
        },
        {
          id: liveAttentionInteractionId,
          companyId,
          issueId: seeded.issueId,
          kind: "request_confirmation",
          status: "expired",
          resolvedAt: new Date(),
          idempotencyKey: `duplicate:${fixture.id}`,
          payload: { version: 1, prompt: `Duplicate ${fixture.id}` },
          result: {
            version: 1,
            outcome: "superseded_by_newer_request",
            supersededByInteractionId: canonicalInteractionId,
          },
        },
      ]);
    }
    if (!liveEntrypointCommitted && seeded.nativeRecords && consumerDecision?.effects.some((effect) => effect.kind === "record_stale_response")) {
      liveAttentionInteractionId = randomUUID();
      await db.insert(issueThreadInteractions).values({
        id: liveAttentionInteractionId,
        companyId,
        issueId: seeded.issueId,
        kind: "request_confirmation",
        status: "expired",
        resolvedAt: new Date(),
        payload: { version: 1, prompt: `Stale ${fixture.id}` },
        result: { version: 1, outcome: "superseded_by_comment", commentId: randomUUID() },
      });
    }
    if (!liveEntrypointCommitted && seeded.nativeRecords && consumerDecision?.effects.some((effect) => effect.kind === "record_expiry")) {
      await db.insert(issueThreadInteractions).values({
        companyId,
        issueId: seeded.issueId,
        kind: "ask_user_questions",
        status: "pending",
        payload: { version: 1, questions: [] },
      });
    }
    if (seeded.nativeRecords && completionState === "decision_committed_delivery_pending") {
      const [priorDecision] = await db.insert(statusDecisions).values({
        companyId,
        issueId: seeded.issueId,
        assessmentId: seeded.assessmentId,
        decisionVersion: 1,
        policyVersion: "phase6-v2",
        fromStatus: priorIssueStatus,
        toStatus: priorIssueStatus,
        reasonCode: "live_continuation_registered",
        decisionJson: { persistedBeforeDelivery: true },
        decisionDigest: `delivery-pending:${fixture.id}`,
        applicationState: "applied",
        appliedAt: new Date(),
      }).returning({ id: statusDecisions.id });
      const [pendingWake] = await db.insert(agentWakeupRequests).values({
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: {
          issueId: seeded.issueId,
          taskId: seeded.issueId,
          nativeDecisionId: priorDecision!.id,
          continuationKind: "same_agent",
          continuationSummary: fixture.id,
        },
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `delivery-pending:${seeded.issueId}`,
      }).returning({ id: agentWakeupRequests.id });
      await db.insert(statusDecisionEffects).values({
        companyId,
        issueId: seeded.issueId,
        decisionId: priorDecision!.id,
        ordinal: 1,
        effectKind: "enqueue_continuation",
        targetType: "agent_wakeup_request",
        targetId: pendingWake!.id,
        idempotencyKey: `delivery-pending:${seeded.issueId}`,
        payload: { fixtureId: fixture.id },
        deliveryState: "pending",
        attemptCount: 0,
      });
      await db.update(nativeRunFinalizations).set({
        phase: "committed",
        decisionId: priorDecision!.id,
      }).where(eq(nativeRunFinalizations.runId, seeded.runId));
      await reconcileNativeFinalizations(db, [seeded.runId]);
    }
    if (
      seeded.nativeRecords
      && zeroDecisionStates.has(completionState)
      && !liveEntrypointCommitted
      && consumerDecision
      && consumerDecision.effects.some((effect) => [
        "link_canonical_request",
        "record_stale_response",
        "record_finalization_error",
      ].includes(effect.kind))
    ) {
      const interactionEffect = consumerDecision.effects.find((effect) => ["link_canonical_request", "record_stale_response"].includes(effect.kind));
      if (interactionEffect && liveAttentionInteractionId) {
        const projection = await materializeNativeInteractionResponses({
          db,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          agentId,
          interactionIds: [liveAttentionInteractionId],
        }).then(() => ({ code: null })).catch((error) => ({
          code: error instanceof Error && "code" in error ? String(error.code) : String(error),
        }));
        expect(projection.code, `${fixture.id}:live attention terminal`).toBe("native_interaction_missing");
        materializedEffects.add(interactionEffect.kind);
        consumerExecutions.push({ consumer: "native-attention-effect-materializer", observed: projection });
      } else {
        const targets = await applyNativeAttentionStatusDecision({
          db,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          decision: consumerDecision,
        });
        for (const target of targets) materializedEffects.add(target.effectKind);
        consumerExecutions.push({
          consumer: "native-attention-effect-materializer",
          observed: { targets },
        });
      }
    }

    let rolledBack = false;
    if (
      seeded.nativeRecords
      && consumerDecision
      && consumerDecision.reasonCode !== null
      && completionState !== "replacement_turn_accepted"
      && !zeroDecisionStates.has(completionState)
      && !liveEntrypointCommitted
    ) {
      let priorStatusVersion = 0;
      let priorDecisionId: string | null = null;
      if (supersedingDecisionStates.has(completionState)) {
        const priorAssessmentId = randomUUID();
        await db.insert(workAssessments).values({
          id: priorAssessmentId,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          contractId: seeded.contractId!,
          resultId: seeded.resultId!,
          triggerKind: "prior_fixture_fact",
          triggerActorCompanyId: companyId,
          priorIssueStatus,
          priorStatusVersion: 0,
          policyVersion: "phase6-v1",
          assessmentJson: { fixtureId: fixture.id, superseded: true },
          inputDigest: `prior-assessment:${fixture.id}`,
        });
        const [priorDecision] = await db.insert(statusDecisions).values({
          companyId,
          issueId: seeded.issueId,
          assessmentId: priorAssessmentId,
          decisionVersion: 1,
          policyVersion: "phase6-v1",
          fromStatus: priorIssueStatus,
          toStatus: priorIssueStatus,
          reasonCode: "prior_fixture_decision",
          decisionJson: { superseded: true },
          decisionDigest: `prior-decision:${fixture.id}`,
          applicationState: "applied",
          appliedAt: new Date(),
        }).returning({ id: statusDecisions.id });
        priorDecisionId = priorDecision!.id;
        priorStatusVersion = 1;
        await db.update(issues).set({
          statusVersion: priorStatusVersion,
          lastStatusDecisionId: priorDecisionId,
        }).where(eq(issues.id, seeded.issueId));
      }

      const failpoint = failpointFor(fixture);
      try {
        const committed = await commitNativeStatusDecision({
          db,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          assessmentId: seeded.assessmentId,
          priorStatus: priorIssueStatus,
          priorStatusVersion,
          priorDecisionId,
          decision: consumerDecision,
          failpoint,
        });
        const replayed = await commitNativeStatusDecision({
          db,
          companyId,
          issueId: seeded.issueId,
          runId: seeded.runId,
          assessmentId: seeded.assessmentId,
          priorStatus: priorIssueStatus,
          priorStatusVersion,
          priorDecisionId,
          decision: consumerDecision,
        });
        expect(replayed.replayed, `${fixture.id} decision replay`).toBe(true);
        expect(replayed.decision.id, `${fixture.id} replay decision identity`).toBe(committed.decision.id);
        consumerExecutions.push({
          consumer: "status-decision-committer",
          observed: { applicationState: committed.decision.applicationState, failpoint: null, replayed: replayed.replayed },
        });
      } catch (error) {
        if (!failpoint) throw error;
        rolledBack = true;
        consumerExecutions.push({
          consumer: "status-decision-committer",
          observed: { applicationState: "rolled_back", failpoint, error: String(error) },
        });
      }
    }

    if (options.disableLiveEntrypoint === "rollout" && completionState === "kill_switch_during_active_native_run") {
      await db.update(agents).set({
        runtimeConfig: { nativeRunner: { mode: "native", backend: "codex_app_server", protocolVersion: 1 } },
      }).where(eq(agents.id, agentId));
    }

    if (seeded.nativeRecords && (rolledBack || completionState === "safe_partial_parse")) {
      const failure = await recordNativeFinalizationFailure({
        db,
        runId: seeded.runId,
        error: new Error(rolledBack ? "side_effect_planning_failed" : "native_finalization_invalid"),
        projectRunStatus: true,
      });
      materializedEffects.add("record_finalization_error");
      consumerExecutions.push({
        consumer: "native-finalization-failure",
        observed: { phase: failure.phase, failureCode: failure.failureCode },
      });
    } else if (seeded.nativeRecords && consumerDecision?.effects.some((effect) => effect.kind === "record_finalization_error")) {
      await db.update(heartbeatRuns).set({
        status: projectNativeTerminalRunStatus("failed"),
        finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, seeded.runId));
    }

    if (["attention_response", "attention_candidate", "interaction", "monitor"].includes(String(fixture.given.trigger))) {
      const interactionId = randomUUID();
      const resolved = ["attention_response", "interaction"].includes(String(fixture.given.trigger));
      await db.insert(issueThreadInteractions).values({
        id: interactionId,
        companyId,
        issueId: seeded.issueId,
        kind: "ask_user_questions",
        status: resolved ? "answered" : completionState === "interaction_expired" ? "expired" : "pending",
        resolvedByUserId: resolved ? "board-user" : null,
        resolvedAt: resolved ? new Date() : null,
        payload: {
          version: 1,
          questions: [{ id: "answer", prompt: fixture.id, selectionMode: "single", options: [{ id: "continue", label: "Continue" }] }],
        },
        result: resolved ? { version: 1, answers: [{ questionId: "answer", optionIds: ["continue"] }] } : null,
      });
      const projected = await materializeNativeInteractionResponses({
        db,
        companyId,
        issueId: seeded.issueId,
        runId: seeded.runId,
        agentId,
        interactionIds: [interactionId],
      }).then((responses) => ({ responseCount: responses.length, code: null }))
        .catch((error) => ({ responseCount: 0, code: error instanceof Error && "code" in error ? String(error.code) : String(error) }));
      consumerExecutions.push({ consumer: "interaction-lifecycle", observed: projected });
      const denied = rejectUnsupportedNativeRuntimeRequest(`fixture:${fixture.id}`);
      consumerExecutions.push({
        consumer: "native-runtime-request-boundary",
        observed: { accepted: denied.accepted, credentialsInjected: denied.credentialsInjected, selfApproval: denied.selfApproval },
      });
    }

    const boardTarget = completionState === "explicit_resume_capability"
        ? "in_progress"
        : completionState === "authorized_status_write"
          ? "in_review"
          : completionState === "authorized_writer_incremented_version"
            ? String(fixture.given.priorIssueStatus ?? "in_progress")
            : null;
    if (boardTarget) {
      const currentVersion = await db.select({ statusVersion: issues.statusVersion })
        .from(issues).where(eq(issues.id, seeded.issueId))
        .then((rows) => Number(rows[0]?.statusVersion ?? 0));
      const updated = await issueService(db).update(seeded.issueId, {
        status: boardTarget,
        statusVersion: currentVersion + 1,
        actorUserId: "status-corpus-board",
        actorAgentId: null,
      });
      consumerExecutions.push({
        consumer: "authorized-issue-writer",
        observed: { status: updated.status, statusVersion: updated.statusVersion },
      });
      if (completionState === "authorized_status_write") {
        const reviewer = await issueThreadInteractionService(db).create(
          updated,
          {
            kind: "request_confirmation",
            idempotencyKey: `migration-review:${fixture.id}`,
            sourceRunId: null,
            title: "Migration writer review",
            summary: "Preserve the existing review liveness path.",
            continuationPolicy: "wake_assignee",
            payload: {
              version: 1,
              prompt: "Review the migrated issue status.",
              acceptLabel: "Approve",
              rejectLabel: "Continue",
              supersedeOnUserComment: false,
            },
          },
          { systemId: "status-corpus" },
        );
        materializedEffects.add("bind_reviewer");
        consumerExecutions.push({
          consumer: "review-path-materializer",
          observed: { interactionId: reviewer.id, status: reviewer.status },
        });
      }
    }

    const reconciliationRows = fixture.covers.reconciliationRows ?? [];
    if (reconciliationRows.length > 0 || ["authorized_agent", "board_user"].includes(String(fixture.given.trigger))) {
      const disposition = nativeSessionFailureDisposition(
        completionState === "resolver_budget_exhausted" ? 3 : 1,
        new Date("2026-08-09T00:00:00.000Z"),
      );
      consumerExecutions.push({
        consumer: "native-recovery-policy",
        observed: { phase: disposition.phase, failureCode: disposition.failureCode, retryScheduled: disposition.nextAttemptAt !== null },
      });
    }

    if (["migration", "read_model", "shadow_comparator"].includes(String(fixture.given.trigger))) {
      const persistedIssue = await db.select({ status: issues.status, statusVersion: issues.statusVersion })
        .from(issues).where(and(eq(issues.id, seeded.issueId), eq(issues.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      consumerExecutions.push({
        consumer: "migration-compatibility-read",
        observed: { found: persistedIssue !== null, status: persistedIssue?.status, statusVersion: persistedIssue?.statusVersion },
      });
    }

    const [decisionRows, effectRows, nativeRows, wakeRows, recoveryRows, interactionRows, persistedIssue, persistedRun] = await Promise.all([
      db.select({ id: statusDecisions.id }).from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId)),
      db.select({
        id: statusDecisionEffects.id,
        effectKind: statusDecisionEffects.effectKind,
        targetType: statusDecisionEffects.targetType,
        targetId: statusDecisionEffects.targetId,
        deliveryState: statusDecisionEffects.deliveryState,
        attemptCount: statusDecisionEffects.attemptCount,
      }).from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, seeded.issueId)),
      db.select({ id: nativeRunResults.id, resultJson: nativeRunResults.resultJson })
        .from(nativeRunResults).where(eq(nativeRunResults.issueId, seeded.issueId)),
      db.select({ id: agentWakeupRequests.id, payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, seeded.issueId)),
      db.select({
        id: issueThreadInteractions.id,
        status: issueThreadInteractions.status,
        summary: issueThreadInteractions.summary,
      })
        .from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, seeded.issueId)),
      db.select({
        status: issues.status,
        statusVersion: issues.statusVersion,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        unblockDescriptor: issues.unblockDescriptor,
      })
        .from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0] ?? null),
      db.select({
        status: heartbeatRuns.status,
        runtimeMode: heartbeatRuns.runtimeMode,
        completionContractId: heartbeatRuns.completionContractId,
        continuationAttempt: heartbeatRuns.continuationAttempt,
        processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId,
        resultJson: heartbeatRuns.resultJson,
        runnerProfileJson: heartbeatRuns.runnerProfileJson,
      }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, seeded.runId)).then((rows) => rows[0] ?? null),
    ]);
    const persistedEffects = effectRows
      .map((row) => row.effectKind)
      .filter((effect) => effect !== "issue_status_projection");
    for (const effect of persistedEffects) materializedEffects.add(effect);
    for (const effectRow of effectRows.filter((row) => row.effectKind !== "issue_status_projection")) {
      expect(effectRow.deliveryState, `${fixture.id}:${effectRow.effectKind}:delivery`).toBe("delivered");
      expect(effectRow.attemptCount, `${fixture.id}:${effectRow.effectKind}:at-most-once`).toBe(1);
      expect(effectRow.targetId, `${fixture.id}:${effectRow.effectKind}:target`).not.toBeNull();
      if (effectRow.effectKind !== "release_checkout") {
        expect(effectRow.targetType, `${fixture.id}:${effectRow.effectKind}:no-synthetic-checkout`).not.toBe("issue_checkout");
      }
      if (effectRow.targetType === "agent_wakeup_request") {
        const target = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target, `${fixture.id}:${effectRow.effectKind}:wake-target`).not.toBeNull();
      } else if (effectRow.targetType === "agent") {
        const target = await db.select({ id: agents.id }).from(agents)
          .where(eq(agents.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target, `${fixture.id}:${effectRow.effectKind}:agent-target`).not.toBeNull();
      } else if (effectRow.targetType === "delegated_issue" || effectRow.targetType === "issue" || effectRow.targetType === "issue_checkout" || effectRow.targetType === "issue_unblock_descriptor") {
        const target = await db.select({ id: issues.id }).from(issues)
          .where(eq(issues.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target, `${fixture.id}:${effectRow.effectKind}:issue-target`).not.toBeNull();
      } else if (effectRow.targetType === "issue_recovery_action") {
        const target = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target, `${fixture.id}:${effectRow.effectKind}:recovery-target`).not.toBeNull();
      } else if (effectRow.targetType === "issue_thread_interaction") {
        const target = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target, `${fixture.id}:${effectRow.effectKind}:interaction-target`).not.toBeNull();
      } else if (effectRow.targetType === "heartbeat_run") {
        expect(effectRow.targetId, `${fixture.id}:${effectRow.effectKind}:run-target`).toBe(seeded.runId);
      } else if (effectRow.targetType === "workspace_operation") {
        const target = await db.select({ status: workspaceOperations.status }).from(workspaceOperations)
          .where(eq(workspaceOperations.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target?.status, `${fixture.id}:${effectRow.effectKind}:workspace-target`).toBe("succeeded");
      } else if (effectRow.targetType === "completion_contract") {
        expect(persistedRun?.completionContractId, `${fixture.id}:${effectRow.effectKind}:contract-link`).toBe(effectRow.targetId);
      } else if (effectRow.targetType === "status_decision") {
        const target = await db.select({ id: statusDecisions.id }).from(statusDecisions)
          .where(eq(statusDecisions.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target, `${fixture.id}:${effectRow.effectKind}:decision-target`).not.toBeNull();
      } else if (effectRow.targetType === "status_decision_effect") {
        const target = await db.select({ deliveryState: statusDecisionEffects.deliveryState }).from(statusDecisionEffects)
          .where(eq(statusDecisionEffects.id, effectRow.targetId!)).then((rows) => rows[0] ?? null);
        expect(target?.deliveryState, `${fixture.id}:${effectRow.effectKind}:effect-target`).toBe("delivered");
      } else if (!["approval", "interaction", "execution_stage"].includes(effectRow.targetType)) {
        throw new Error(`${fixture.id}:${effectRow.effectKind}:unknown target type ${effectRow.targetType}`);
      }
    }
    const persistedRunResult = persistedRun?.resultJson && typeof persistedRun.resultJson === "object" ? persistedRun.resultJson : {};
    const persistedRunnerProfile = persistedRun?.runnerProfileJson && typeof persistedRun.runnerProfileJson === "object" ? persistedRun.runnerProfileJson : {};
    if (Array.isArray(persistedRunResult.nativeDispatchedEffectIds) && persistedRunResult.nativeDispatchedEffectIds.length > 0) {
      materializedEffects.add("dispatch_pending_effect");
      expect(persistedRunResult.nativeDispatchedEffectIds, `${fixture.id}:dispatched effect identity`)
        .toEqual(expect.arrayContaining(effectRows.map((row) => row.id)));
    }
    if (persistedEffects.includes("release_checkout")) {
      expect(persistedIssue?.checkoutRunId, `${fixture.id}:checkout released`).toBeNull();
      expect(persistedIssue?.executionRunId, `${fixture.id}:execution released`).toBeNull();
    }
    if (persistedEffects.includes("bind_blocker")) expect(persistedIssue?.unblockDescriptor, `${fixture.id}:blocker target`).not.toBeNull();
    if (materializedEffects.has("accept_replacement_turn")) expect(persistedRun?.continuationAttempt, `${fixture.id}:replacement target`).toBeGreaterThan(0);
    if (persistedEffects.includes("release_run_resources")) {
      expect(persistedRun?.processPid, `${fixture.id}:pid released`).toBeNull();
      expect(persistedRun?.processGroupId, `${fixture.id}:process group released`).toBeNull();
    }
    if (persistedEffects.includes("record_shadow_decision")) expect(persistedRunResult.nativeShadowDecision, `${fixture.id}:shadow target`).toBeDefined();
    if (persistedEffects.includes("render_four_layers")) expect(persistedRunResult.nativeOutcomeLayers, `${fixture.id}:four-layer target`).toBeDefined();
    if (persistedEffects.includes("record_mode_labeled_divergence")) expect(persistedRunResult.nativeLegacyDivergence, `${fixture.id}:divergence target`).toBeDefined();
    if (persistedEffects.includes("record_mode_native")) expect(persistedRun?.runtimeMode, `${fixture.id}:mode target`).toBe("native");
    if (persistedEffects.includes("record_policy_version")) expect(persistedRunnerProfile.nativeStatusPolicyVersion, `${fixture.id}:policy target`).toBe("phase6-v2");
    if (persistedEffects.includes("finish_as_native")) expect(persistedRunResult.nativeKillSwitchDisposition, `${fixture.id}:finish-native target`).toBe("finish_as_native");
    if (materializedEffects.has("link_canonical_request")) {
      expect(interactionRows.some((row) => row.summary?.startsWith("Canonical native attention request:")), `${fixture.id}:canonical link target`).toBe(true);
    }
    if (materializedEffects.has("record_stale_response")) {
      expect(interactionRows.some((row) => row.summary === "Response retained for audit after native supersession."), `${fixture.id}:stale audit target`).toBe(true);
    }
    if (materializedEffects.has("record_finalization_error")) expect(persistedRun?.status, `${fixture.id}:finalization failure target`).toBe("failed");
    const observedNativeRecords = nativeRows.length > 0;
    const compatibilityState = (fixture.covers.compatibilityRows ?? []).length > 0
      ? inspectNativeCompatibilityState({
          resolution: mode,
          nativeRecordCount: nativeRows.length,
          decisionCount: decisionRows.length,
          issueStatus: persistedIssue?.status ?? priorIssueStatus,
          statusVersion: Number(persistedIssue?.statusVersion ?? 0),
          persistedEffectKinds: persistedEffects,
        })
      : null;
    const migrationState = (fixture.covers.migrationRows ?? []).length > 0
      ? inspectNativeMigrationState({
          resolution: mode,
          nativeRecordCount: nativeRows.length,
          decisionCount: decisionRows.length,
          issueStatusBefore: priorIssueStatus,
          issueStatusAfter: persistedIssue?.status ?? priorIssueStatus,
          statusVersion: Number(persistedIssue?.statusVersion ?? 0),
          hasPendingReview: interactionRows.some((row) => row.status === "pending"),
        })
      : null;
    let effects = [...new Set([
      ...persistedEffects,
      ...(consumerDecision?.effects.map((effect) => effect.kind) ?? []),
      ...operationalEffects,
    ])];
    if (rolledBack) effects = ["record_finalization_error"];
    if (!consumerDecision) {
      effects = migrationState?.effects.length
        ? [...migrationState.effects]
        : compatibilityState?.effects.length ? [...compatibilityState.effects] : [];
    }
    for (const effect of effects) {
      if (nativeStatusEffectKinds.has(effect as NativeStatusEffect["kind"])) {
        expect(materializedEffects.has(effect), `${fixture.id}:${effect}:materialized-target`).toBe(true);
      }
    }

    const issueWakeRows = wakeRows.filter((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      return payload.issueId === seeded.issueId || payload.taskId === seeded.issueId;
    });
    const statusAction = rolledBack
      ? "preserve"
      : consumerDecision
        ? consumerDecision.statusAction
        : migrationState?.statusAction ?? compatibilityState?.statusAction ?? "preserve";
    const livePathKind = rolledBack
      ? null
      : effects.includes("create_delegated_issue") ? "delegated_issue"
      : effects.includes("bind_reviewer") ? "review"
      : effects.includes("create_interaction") ? "interaction"
      : effects.includes("bind_blocker") ? "blocker"
      : effects.includes("schedule_retry") ? "retry"
      : effects.includes("enqueue_continuation") || effects.includes("accept_replacement_turn") ? "continuation"
      : recoveryRows.length > 0 ? "recovery"
      : completionState === "preexisting_open_issue" && persistedIssue?.status === "in_review" ? "review"
      : null;
    if ((fixture.covers.terminalRows ?? []).length > 0) {
      const terminalInput = persistedRun?.status === "running"
        ? "active"
        : persistedRun?.status === "cancelled"
          ? "cancelled"
          : persistedRun?.status === "failed" ? "failed" : "succeeded";
      consumerExecutions.push({
        consumer: "native-run-terminal-projection",
        observed: { status: projectNativeTerminalRunStatus(terminalInput) },
      });
    }
    if (compatibilityState) {
      consumerExecutions.push({
        consumer: "native-compatibility-read-model",
        observed: compatibilityState,
      });
    }
    if (migrationState) {
      consumerExecutions.push({
        consumer: "native-migration-read-model",
        observed: migrationState,
      });
    }
    const consumerEvidenceByRow = new Map<string, string>();
    for (const matrixRow of Object.values(fixture.covers).flat()) {
      const consumer = requiredConsumerForMatrixRow(matrixRow);
      const execution = consumerExecutions.find((candidate) => candidate.consumer === consumer);
      if (!execution) continue;
      const semanticRow = matrixRow.startsWith("SD-")
        || matrixRow.startsWith("ATT-")
        || matrixRow.startsWith("REC-")
        || consumer.endsWith("-status");
      if (semanticRow) {
        const returnedEffects = Array.isArray(execution.observed.effects)
          ? execution.observed.effects.map(String)
          : [];
        const returnedStatusAction = execution.observed.statusAction
          ?? (execution.observed.toStatus === priorIssueStatus ? "preserve" : execution.observed.toStatus);
        if (
          returnedStatusAction !== statusAction
          || execution.observed.reasonCode !== (rolledBack ? "side_effect_planning_failed" : consumerDecision?.reasonCode ?? null)
          || !effects.every((effect) => returnedEffects.includes(effect))
        ) continue;
      } else if (matrixRow.startsWith("TC-")) {
        if (execution.observed.status !== (persistedRun?.status ?? initialRunStatus(fixture))) continue;
      } else if (consumer.endsWith("-read-model")) {
        const returnedEffects = Array.isArray(execution.observed.effects)
          ? execution.observed.effects.map(String)
          : [];
        if (
          execution.observed.statusAction !== statusAction
          || execution.observed.native !== observedNativeRecords
          || !effects.every((effect) => returnedEffects.includes(effect))
        ) continue;
      } else if (consumer === "status-decision-committer") {
        const expectedApplicationState = rolledBack ? "rolled_back" : "applied";
        if (execution.observed.applicationState !== expectedApplicationState) continue;
      } else if (consumer === "heartbeat-runtime-selection") {
        if (
          execution.observed.activeMode !== "native"
          || execution.observed.freshMode !== "legacy"
          || execution.observed.freshReason !== "instance_flag_disabled"
          || execution.observed.profileMode !== "native"
        ) continue;
      }
      consumerEvidenceByRow.set(matrixRow, consumer);
    }
    consumerExecutions.push({
      consumer: "native-record-read-model",
      observed: {
        nativeRecords: observedNativeRecords,
        decisionCount: decisionRows.length,
        effectCount: effectRows.length,
        wakeCount: issueWakeRows.length,
        recoveryCount: recoveryRows.length,
      },
    });
    if (consumerExecutions.length < 2) throw new Error(`${fixture.id} did not execute a concern consumer`);
    if (
      ["turn_scope", "run_scope", "issue_scope_authorized", "replacement_turn_accepted"].includes(completionState)
      && !consumerExecutions.some((execution) =>
        execution.consumer === "native-session-cancellation" && typeof execution.observed.auditId === "string"
      )
    ) {
      throw new Error(`${fixture.id}: live cancellation proof missing`);
    }
    if (
      attentionFacts
      && ["attention_response", "attention_candidate", "interaction", "monitor"].includes(String(fixture.given.trigger))
      && !consumerExecutions.some((execution) => execution.consumer === "native-attention-finalizer")
    ) {
      throw new Error(`${fixture.id}: live attention finalizer proof missing`);
    }
    if (
      ["REC-04", "REC-06", "REC-07", "REC-08"].some((row) => (fixture.covers.reconciliationRows ?? []).includes(row))
      && !consumerExecutions.some((execution) => execution.consumer === "native-reconciliation-entrypoint")
    ) {
      throw new Error(`${fixture.id}: live reconciliation proof missing`);
    }

    return {
      fixtureId: fixture.id,
      runStatus: mode.kind === "legacy"
        ? "legacy_derived"
        : persistedRun?.status ?? initialRunStatus(fixture),
      statusAction,
      reasonCode: rolledBack ? "side_effect_planning_failed" : consumerDecision?.reasonCode ?? null,
      effects,
      livePathKind,
      preserveClaim: nativeRows.some((row) => {
        const result = row.resultJson && typeof row.resultJson === "object" ? row.resultJson : {};
        return result.completionClaim !== undefined;
      }),
      nativeRecords: observedNativeRecords,
      decisionCount: decisionRows.length,
      wakeCount: issueWakeRows.length,
      notificationCount: effectRows.filter((row) => ["notify_owner", "create_delegated_issue", "cancel_continuations"].includes(row.effectKind)).length,
      consumerExecutions,
      consumerEvidenceByRow,
    };
  }

  it("executes all 52 fixtures in their production consumers and joins all 70 matrix rows", async () => {
    expect(corpus.schema).toBe("paperclip.status-authority-conformance.v1");
    expect(corpus.fixtures).toHaveLength(52);

    const observations = new Map<string, FixtureObservation>();
    for (const fixture of corpus.fixtures) observations.set(fixture.id, await executeFixture(fixture));

    const semanticFailures: string[] = [];
    for (const fixture of corpus.fixtures) {
      const observed = observations.get(fixture.id)!;
      semanticFailures.push(...comparisonFailures(fixture, observed).map((failure) => `${fixture.id}:${failure}`));
      expect(observed.consumerExecutions.length, `${fixture.id} consumer execution`).toBeGreaterThan(1);
      for (const matrixRow of Object.values(fixture.covers).flat()) {
        expect(observed.consumerEvidenceByRow.get(matrixRow), `${fixture.id}:${matrixRow}`)
          .toBe(requiredConsumerForMatrixRow(matrixRow));
      }
    }
    expect(semanticFailures).toEqual([]);

    const matrixByRow = new Map<string, Array<{ fixtureId: string; observation: FixtureObservation }>>();
    for (const fixture of corpus.fixtures) {
      for (const matrixRow of Object.values(fixture.covers).flat()) {
        const joined = { fixtureId: fixture.id, observation: observations.get(fixture.id)! };
        const existing = matrixByRow.get(matrixRow);
        if (existing) existing.push(joined);
        else matrixByRow.set(matrixRow, [joined]);
      }
    }
    const matrixResults = [...matrixByRow].map(([matrixRow, joinedFixtures]) => ({ matrixRow, joinedFixtures }));
    expect(matrixResults).toHaveLength(70);
    expect(new Set(matrixResults.map((result) => result.matrixRow))).toEqual(new Set([
      ...Array.from({ length: 19 }, (_, index) => `SD-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `TC-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 12 }, (_, index) => `ATT-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 6 }, (_, index) => `LIVE-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `REC-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 8 }, (_, index) => `COMP-${String(index + 1).padStart(2, "0")}`),
      ...Array.from({ length: 9 }, (_, index) => `MIG-${String(index + 1).padStart(2, "0")}`),
    ]));
    for (const result of matrixResults) {
      expect(result.joinedFixtures.length, result.matrixRow).toBeGreaterThan(0);
      for (const joined of result.joinedFixtures) {
        expect(joined.observation.fixtureId).toBe(joined.fixtureId);
        expect(joined.observation.consumerEvidenceByRow.get(result.matrixRow), result.matrixRow)
          .toBe(requiredConsumerForMatrixRow(result.matrixRow));
      }
    }
  }, 60_000);

  it("fails independently when any asserted field category is mutated", async () => {
    const observations = new Map<string, FixtureObservation>();
    for (const fixture of corpus.fixtures) observations.set(fixture.id, await executeFixture(fixture));

    for (const fixture of corpus.fixtures) {
      const observed = observations.get(fixture.id)!;
      const observedEffect = observed.effects[0] ?? "__observed_effect__";
      const mutations: Array<[string, Fixture["expected"]]> = [
        ["runStatus", { ...fixture.expected, runStatus: `mutated:${fixture.expected.runStatus}` }],
        ["statusAction", { ...fixture.expected, statusAction: `mutated:${fixture.expected.statusAction}` }],
        ["reasonCode", { ...fixture.expected, reasonCode: fixture.expected.reasonCode === null ? "mutated" : null }],
        ["requiredEffects", { ...fixture.expected, requiredEffects: [...fixture.expected.requiredEffects, "__missing_effect__"] }],
        ["forbiddenEffects", { ...fixture.expected, forbiddenEffects: [...fixture.expected.forbiddenEffects, observedEffect] }],
        ["livePathKind", { ...fixture.expected, livePathKind: fixture.expected.livePathKind === null ? "continuation" : null }],
        ["preserveClaim", { ...fixture.expected, preserveClaim: !fixture.expected.preserveClaim }],
        ["nativeRecords", { ...fixture.expected, nativeRecords: !fixture.expected.nativeRecords }],
        ["decisionCount", { ...fixture.expected, decisionCount: fixture.expected.decisionCount + 1 }],
        ["maxWakeCount", { ...fixture.expected, maxWakeCount: observed.wakeCount - 1 }],
        ["maxNotificationCount", { ...fixture.expected, maxNotificationCount: observed.notificationCount - 1 }],
      ];
      for (const [field, expected] of mutations) {
        const mutated = { ...fixture, expected };
        expect(comparisonFailures(mutated, observed), `${fixture.id}:${field}`).not.toEqual([]);
      }
    }
  }, 60_000);

  it("fails mapped fixtures when live entrypoints or owning actions are removed despite matching policy labels", async () => {
    const byId = (id: string) => {
      const fixture = corpus.fixtures.find((candidate) => candidate.id === id);
      if (!fixture) throw new Error(`fixture missing: ${id}`);
      return fixture;
    };

    expect(resolveNativeCancellationStatus({
      scope: "turn",
      priorIssueStatus: "in_progress",
      agentId,
    }).reasonCode).toBe("cancellation_turn_only");
    await expect(executeFixture(byId("turn-only-cancellation"), {
      disableLiveEntrypoint: "cancellation",
    })).rejects.toThrow("live cancellation proof missing");

    expect(resolveNativeAttentionStatus({
      facts: {
        companyScopeValid: true,
        responseState: "none",
        route: "agent",
        summary: "delegate",
        resolvedTargetAgentId: delegateAgentId,
      },
      priorIssueStatus: "in_progress",
      agentId,
    }).reasonCode).toBe("attention_routed_to_agent");
    await expect(executeFixture(byId("human-request-routed-to-agent"), {
      disableLiveEntrypoint: "attention",
    })).rejects.toThrow("live attention finalizer proof missing");
    await expect(executeFixture(byId("duplicate-and-fresh-key-question"), {
      disableLiveEntrypoint: "attention",
    })).rejects.toThrow("live attention finalizer proof missing");
    await expect(executeFixture(byId("stale-attention-response"), {
      disableLiveEntrypoint: "attention",
    })).rejects.toThrow("live attention finalizer proof missing");

    expect(resolveNativeReconciliationStatus({
      facts: { workspaceOperationPending: true },
      priorIssueStatus: "in_progress",
      agentId,
    }).effects.map((effect) => effect.kind)).toContain("resume_workspace_operation");
    await expect(executeFixture(byId("crash-before-workspace-finalization"), {
      disableLiveEntrypoint: "reconciliation",
    })).rejects.toThrow("native_workspace_operation_not_executed");

    expect(resolveNativeMigrationStatus({
      facts: { killSwitchActiveForNewRuns: true },
      priorIssueStatus: "in_progress",
      agentId,
    }).effects.map((effect) => effect.kind)).toContain("finish_as_native");
    await expect(executeFixture(byId("migration-kill-switch-rollback"), {
      disableLiveEntrypoint: "rollout",
    })).rejects.toThrow("global kill-switch transition missing");

    const pendingFixture = byId("crash-after-decision-commit");
    const seeded = await seedFixture(pendingFixture);
    const [decision] = await db.insert(statusDecisions).values({
      companyId,
      issueId: seeded.issueId,
      assessmentId: seeded.assessmentId,
      decisionVersion: 1,
      policyVersion: "phase6-v2",
      fromStatus: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      decisionJson: { fixtureId: pendingFixture.id },
      decisionDigest: `pending-negative:${seeded.issueId}`,
      applicationState: "applied",
      appliedAt: new Date(),
    }).returning({ id: statusDecisions.id });
    const [wake] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      payload: { issueId: seeded.issueId, nativeDecisionId: decision!.id },
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `pending-negative:${seeded.issueId}`,
    }).returning({ id: agentWakeupRequests.id });
    await db.insert(statusDecisionEffects).values({
      companyId,
      issueId: seeded.issueId,
      decisionId: decision!.id,
      ordinal: 1,
      effectKind: "enqueue_continuation",
      targetType: "agent_wakeup_request",
      targetId: wake!.id,
      idempotencyKey: `pending-negative:${seeded.issueId}`,
      payload: { fixtureId: pendingFixture.id },
      deliveryState: "pending",
      attemptCount: 0,
    });
    await db.update(nativeRunFinalizations).set({
      phase: "committed",
      decisionId: decision!.id,
    }).where(eq(nativeRunFinalizations.runId, seeded.runId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake!.id));
    expect(resolveNativeReconciliationStatus({
      facts: { undeliveredEffectCount: 1 },
      priorIssueStatus: "in_progress",
      agentId,
    }).effects.map((effect) => effect.kind)).toContain("dispatch_pending_effect");
    await expect(reconcileNativeFinalizations(db, [seeded.runId]))
      .rejects.toThrow("native_pending_effect_target_missing:enqueue_continuation");
  }, 30_000);

  it("fails the transaction closed for an unknown status effect", async () => {
    const fixture = corpus.fixtures.find((candidate) => candidate.mode === "native");
    if (!fixture) throw new Error("native corpus fixture missing");
    const seeded = await seedFixture(fixture);
    const decision: NativeStatusDecision = {
      policyVersion: "phase6-v2",
      statusAction: "preserve",
      toStatus: String(fixture.given.priorIssueStatus ?? "in_progress") as NativeStatusDecision["toStatus"],
      reasonCode: "unknown_effect_test",
      unblockDescriptor: null,
      effects: [{ kind: "unknown_effect" } as never],
    };

    await expect(commitNativeStatusDecision({
      db,
      companyId,
      issueId: seeded.issueId,
      runId: seeded.runId,
      assessmentId: seeded.assessmentId,
      priorStatus: decision.toStatus,
      priorStatusVersion: 0,
      priorDecisionId: null,
      decision,
    })).rejects.toThrow("native_status_effect_unimplemented:unknown_effect");

    const [decisionRows, effectRows, persistedIssue, coordinator] = await Promise.all([
      db.select({ id: statusDecisions.id }).from(statusDecisions).where(eq(statusDecisions.issueId, seeded.issueId)),
      db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects).where(eq(statusDecisionEffects.issueId, seeded.issueId)),
      db.select({ status: issues.status, statusVersion: issues.statusVersion, lastStatusDecisionId: issues.lastStatusDecisionId })
        .from(issues).where(eq(issues.id, seeded.issueId)).then((rows) => rows[0]!),
      db.select({ phase: nativeRunFinalizations.phase, decisionId: nativeRunFinalizations.decisionId })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, seeded.runId)).then((rows) => rows[0]!),
    ]);
    expect(decisionRows).toHaveLength(0);
    expect(effectRows).toHaveLength(0);
    expect(persistedIssue).toMatchObject({ status: decision.toStatus, statusVersion: 0, lastStatusDecisionId: null });
    expect(coordinator).toMatchObject({ phase: "assessing", decisionId: null });
  });
});
