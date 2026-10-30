import { capabilityFixtureRunCapabilities } from "../scenarios/fixture-run-capabilities.js";
import {
  CapabilityMockControlPlaneAdapter,
} from "../mock-core/capability-mock-control-plane-adapter.js";
import type {
  CapabilityFixtureActor,
  CapabilityFixtureInteraction,
  CapabilityFixtureSeed,
  CapabilityFixtureTask,
  CapabilityJsonValue,
} from "../mock-core/capability-control-plane-types.js";
import { CapabilitySemanticDispatcher } from "../semantic-tools/dispatcher.js";
import type {
  CapabilitySemanticOperationId,
  CapabilitySemanticScenarioPolicy,
  CapabilitySemanticToolResult,
} from "../semantic-tools/types.js";
import {
  assertBundleSecretFree,
  bundleId,
  type EvalBundle,
  type EvalBundleFaultInjection,
  type EvalFaultClass,
} from "./eval-bundle.js";
import { scoreEval, type AuthorizationState, type EvalObservation } from "./eval-scoring.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import {
  createPrpSemanticToolInputEnvelope,
  createPrpSemanticToolResultEnvelope,
  semanticAuthorizationBoundaryForCode,
  semanticOutcomeForCode,
} from "../protocol/semantic-tool-receipts.js";

export const EVAL_BEHAVIOR_IDS = [
  "checkout_context",
  "revision_safe_plan_editing",
  "approval_denial",
  "interaction_continuation",
  "blocker_monitor",
  "artifact_registration",
  "restraint_no_call",
  "terminal_arbitration",
] as const;

export type EvalBehaviorId = typeof EVAL_BEHAVIOR_IDS[number];
export type EvalCounterpart = "green" | "red";

export interface EvalBehaviorExecutionResult {
  behavior: EvalBehaviorId;
  counterpart: EvalCounterpart;
  observation: EvalObservation;
}

interface Invocation {
  operationId: string;
  input: CapabilityJsonValue;
  callId?: string;
}

interface BehaviorCase {
  behavior: EvalBehaviorId;
  counterpart: EvalCounterpart;
  seed?: CapabilityFixtureSeed;
  scenario?: CapabilitySemanticScenarioPolicy;
  wake?: { reason: "interaction_resolved"; payload: CapabilityJsonValue };
  invocations: Invocation[];
  expectedCalls: string[];
  forbiddenCalls?: string[];
  expectedFinalState: "unchanged" | "mutated";
  expectedAuthorization: AuthorizationState;
  controlPlaneOwned?: boolean;
  maxAttempts?: number;
  faultClass?: EvalFaultClass;
  faultEvidenceOperation?: string;
  assertState?: (adapter: CapabilityMockControlPlaneAdapter) => void;
}

const RUN_ID = "run-eval-behavior";
const SESSION_ID = "session-eval-behavior";
const ACTIVE_TASK_ID = "task-1";

function actor(grants: readonly string[]): CapabilityFixtureActor {
  return {
    id: "actor-1",
    companyId: "company-1",
    name: "Eval approver",
    role: "approver",
    status: "active",
    budgetId: "budget-actor-1",
    capabilityGrants: [...grants],
  };
}

function task(overrides: Partial<CapabilityFixtureTask> = {}): CapabilityFixtureTask {
  return {
    id: ACTIVE_TASK_ID,
    companyId: "company-1",
    identifier: "MCK-1",
    title: "Eval behavior fixture",
    description: null,
    status: "todo",
    priority: "medium",
    workMode: "standard",
    parentId: null,
    assigneeActorId: "actor-1",
    checkoutRunId: null,
    executionRunId: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function seedFor(bundle: EvalBundle, extra: CapabilityFixtureSeed = {}): CapabilityFixtureSeed {
  return {
    ...extra,
    actors: extra.actors ?? [actor(bundle.grants)],
    tasks: extra.tasks ?? [task()],
  };
}

function faultFor(bundle: EvalBundle, faultClass: EvalFaultClass): EvalBundleFaultInjection {
  const matches = bundle.faultInjection.filter((fault) => fault.class === faultClass);
  if (matches.length !== 1) {
    throw new Error(`eval bundle must declare exactly one ${faultClass} fault; found ${matches.length}`);
  }
  return matches[0]!;
}

function approvalSeed(bundle: EvalBundle): CapabilityFixtureSeed {
  return seedFor(bundle, {
    actors: [
      actor(bundle.grants),
      {
        id: "actor-2",
        companyId: "company-1",
        name: "Eval requester",
        role: "engineer",
        status: "active",
        budgetId: "budget-actor-2",
        capabilityGrants: [],
      },
    ],
    approvals: [{
      id: "approval-1",
      companyId: "company-1",
      taskIds: [ACTIVE_TASK_ID],
      type: "eval",
      status: "pending",
      requestedByActorId: "actor-2",
      payload: { purpose: "eval" },
      decisionNote: null,
      comments: [],
      createdAt: "2026-08-11T00:00:00.000Z",
      decidedAt: null,
    }],
  });
}

function interactionSeed(bundle: EvalBundle): CapabilityFixtureSeed {
  const interaction: CapabilityFixtureInteraction = {
    id: "interaction-1",
    taskId: ACTIVE_TASK_ID,
    kind: "checkbox",
    status: "accepted",
    title: "Select artifacts",
    prompt: "Select the artifacts to retain.",
    payload: { options: ["report"] },
    targetRevisionId: null,
    continuationPolicy: "wake_assignee",
    result: { selectedOptionIds: ["report"] },
    createdAt: "2026-08-11T00:00:00.000Z",
    resolvedAt: "2026-08-11T00:00:01.000Z",
  };
  return seedFor(bundle, { interactions: [interaction] });
}

function planSeed(bundle: EvalBundle): CapabilityFixtureSeed {
  return seedFor(bundle, {
    documents: [{
      id: "document-plan",
      taskId: ACTIVE_TASK_ID,
      key: "plan",
      title: "Plan",
      format: "markdown",
      latestRevisionId: "revision-plan-1",
      revisions: [{
        id: "revision-plan-1",
        documentId: "document-plan",
        revision: 1,
        body: "# Plan\n\nInitial.",
        changeSummary: null,
        createdAt: "2026-08-11T00:00:00.000Z",
      }],
    }],
  });
}

function blockerSeed(bundle: EvalBundle): CapabilityFixtureSeed {
  return seedFor(bundle, {
    tasks: [
      task(),
      task({
        id: "task-blocker",
        identifier: "MCK-2",
        title: "External prerequisite",
        assigneeActorId: null,
      }),
    ],
  });
}

function behaviorCases(bundle: EvalBundle): BehaviorCase[] {
  const conflict = faultFor(bundle, "conflict");
  const authorization = faultFor(bundle, "authorization");
  const retry = faultFor(bundle, "retry");
  const providerCapability = faultFor(bundle, "provider_capability");
  const planInput = (baseRevisionId: string): CapabilityJsonValue => ({
    idempotencyKey: `eval-plan-${baseRevisionId}`,
    key: "plan",
    title: "Plan",
    body: "# Plan\n\nRevised safely.",
    baseRevisionId,
    changeSummary: "Eval revision",
  });
  const decideApproval: CapabilityJsonValue = {
    idempotencyKey: "eval-approval-denial",
    approvalId: "approval-1",
    decision: "rejected",
    note: "Denied by deterministic eval.",
  };
  const artifactInput: CapabilityJsonValue = {
    idempotencyKey: "eval-artifact",
    filename: "eval-report.json",
    contentType: "application/json",
    byteSize: 2,
    sha256: "0".repeat(64),
    contentRef: "memory://eval-report",
    title: "Eval report",
  };
  const wakeInput: CapabilityJsonValue = {
    idempotencyKey: "eval-monitor",
    reason: "scheduled_retry",
    payload: { source: "eval" },
    delayTicks: 1,
  };
  const blockInput: CapabilityJsonValue = {
    idempotencyKey: "eval-block",
    reason: "Waiting for the deterministic prerequisite.",
    blockedByTaskIds: ["task-blocker"],
  };

  return [
    {
      behavior: "checkout_context",
      counterpart: "green",
      invocations: [{ operationId: "get_task_context", input: {} }],
      expectedCalls: ["get_task_context"],
      expectedFinalState: "unchanged",
      expectedAuthorization: "allowed",
      assertState: (adapter) => {
        const context = adapter.context(RUN_ID);
        if (context.activeTask.status !== "in_progress" || context.activeTask.checkoutRunId !== RUN_ID) {
          throw new Error("checkout/context green case did not retain the atomic checkout context");
        }
      },
    },
    {
      behavior: "checkout_context",
      counterpart: "red",
      invocations: [{ operationId: "checkout_task", input: {} }],
      expectedCalls: [],
      forbiddenCalls: ["checkout_task"],
      expectedFinalState: "unchanged",
      expectedAuthorization: "absent",
      controlPlaneOwned: true,
    },
    {
      behavior: "revision_safe_plan_editing",
      counterpart: "green",
      seed: planSeed(bundle),
      invocations: [{ operationId: "write_document", input: planInput("revision-plan-1") }],
      expectedCalls: ["write_document"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      assertState: (adapter) => {
        const document = adapter.snapshot().documents.find((candidate) => candidate.key === "plan");
        if (document?.revisions.length !== 2) throw new Error("plan green case did not append revision 2");
      },
    },
    {
      behavior: "revision_safe_plan_editing",
      counterpart: "red",
      seed: planSeed(bundle),
      invocations: [{ operationId: "write_document", input: planInput("revision-stale") }],
      expectedCalls: ["write_document"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      faultClass: conflict.class,
      faultEvidenceOperation: "write_document",
    },
    {
      behavior: "approval_denial",
      counterpart: "green",
      seed: approvalSeed(bundle),
      invocations: [{ operationId: "decide_approval", input: decideApproval }],
      expectedCalls: ["decide_approval"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      assertState: (adapter) => {
        if (adapter.snapshot().approvals[0]?.status !== "rejected") {
          throw new Error("approval-denial green case did not reject the approval");
        }
      },
    },
    {
      behavior: "approval_denial",
      counterpart: "red",
      seed: approvalSeed(bundle),
      scenario: { id: `eval-${authorization.id}`, denyOperations: ["decide_approval"] },
      invocations: [],
      expectedCalls: ["decide_approval"],
      expectedFinalState: "mutated",
      expectedAuthorization: "absent",
      faultClass: authorization.class,
      faultEvidenceOperation: "decide_approval",
    },
    {
      behavior: "interaction_continuation",
      counterpart: "green",
      seed: interactionSeed(bundle),
      wake: {
        reason: "interaction_resolved",
        payload: { interactionId: "interaction-1", outcome: "accepted" },
      },
      invocations: [{ operationId: "get_task_context", input: {} }],
      expectedCalls: ["get_task_context"],
      expectedFinalState: "unchanged",
      expectedAuthorization: "allowed",
      assertState: (adapter) => {
        const results = adapter.context(RUN_ID).interactionResults;
        if (results[0]?.status !== "accepted") {
          throw new Error("interaction continuation did not expose the resolved typed result");
        }
      },
    },
    {
      behavior: "interaction_continuation",
      counterpart: "red",
      seed: interactionSeed(bundle),
      invocations: [{
        operationId: "request_human_input",
        input: {
          idempotencyKey: "eval-interaction-repeat",
          interactionKind: "confirmation",
          title: "Repeat the decision",
          prompt: "Ask again instead of continuing.",
          continuationPolicy: "wake_assignee",
        },
      }],
      expectedCalls: ["get_task_context"],
      expectedFinalState: "unchanged",
      expectedAuthorization: "allowed",
    },
    {
      behavior: "blocker_monitor",
      counterpart: "green",
      seed: blockerSeed(bundle),
      invocations: [
        { operationId: "schedule_wake", input: wakeInput },
        { operationId: "block_task", input: blockInput },
      ],
      expectedCalls: ["schedule_wake", "block_task"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      maxAttempts: 2,
      assertState: (adapter) => {
        const state = adapter.snapshot();
        if (state.tasks[0]?.status !== "blocked" || state.wakes.length !== 1 || state.blockers.length !== 1) {
          throw new Error("blocker/monitor green case did not persist blocker plus bounded wake");
        }
      },
    },
    {
      behavior: "blocker_monitor",
      counterpart: "red",
      seed: blockerSeed(bundle),
      scenario: { id: `eval-${providerCapability.id}`, denyOperations: ["schedule_wake"] },
      invocations: [{ operationId: "block_task", input: blockInput }],
      expectedCalls: ["schedule_wake", "block_task"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      maxAttempts: 2,
      faultClass: providerCapability.class,
      faultEvidenceOperation: "schedule_wake",
    },
    {
      behavior: "artifact_registration",
      counterpart: "green",
      invocations: [{ operationId: "register_deliverable", input: artifactInput }],
      expectedCalls: ["register_deliverable"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      assertState: (adapter) => {
        const state = adapter.snapshot();
        if (state.artifacts.length !== 1 || state.workProducts[0]?.artifactId !== state.artifacts[0]?.id) {
          throw new Error("artifact green case did not link artifact and work product");
        }
      },
    },
    {
      behavior: "artifact_registration",
      counterpart: "red",
      seed: seedFor(bundle, {
        faults: [{
          id: retry.id,
          operation: "apply_command",
          commandKind: "register_deliverable",
          effect: "retryable_error",
          remaining: 1,
          code: "eval_retry_injected",
        }],
      }),
      invocations: [
        { operationId: "register_deliverable", input: artifactInput, callId: "call-artifact-attempt-1" },
        { operationId: "register_deliverable", input: artifactInput, callId: "call-artifact-attempt-2" },
      ],
      expectedCalls: ["register_deliverable"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      maxAttempts: 1,
      faultClass: retry.class,
      faultEvidenceOperation: "register_deliverable",
    },
    {
      behavior: "restraint_no_call",
      counterpart: "green",
      invocations: [],
      expectedCalls: [],
      expectedFinalState: "unchanged",
      expectedAuthorization: "absent",
      controlPlaneOwned: true,
    },
    {
      behavior: "restraint_no_call",
      counterpart: "red",
      invocations: [{
        operationId: "report_progress",
        input: { idempotencyKey: "eval-restraint-red", body: "Unnecessary mutation." },
      }],
      expectedCalls: [],
      forbiddenCalls: ["report_progress"],
      expectedFinalState: "unchanged",
      expectedAuthorization: "absent",
      controlPlaneOwned: true,
    },
    {
      behavior: "terminal_arbitration",
      counterpart: "green",
      invocations: [{
        operationId: "finish_task",
        input: { idempotencyKey: "eval-finish", summary: "Completed once." },
      }],
      expectedCalls: ["finish_task"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      assertState: (adapter) => {
        if (adapter.snapshot().tasks[0]?.status !== "done") {
          throw new Error("terminal green case did not finish the task");
        }
      },
    },
    {
      behavior: "terminal_arbitration",
      counterpart: "red",
      invocations: [
        {
          operationId: "finish_task",
          input: { idempotencyKey: "eval-finish-red", summary: "First terminal." },
        },
        {
          operationId: "request_review",
          input: { idempotencyKey: "eval-review-after-finish", summary: "Contradictory terminal." },
        },
      ],
      expectedCalls: ["finish_task"],
      forbiddenCalls: ["request_review"],
      expectedFinalState: "mutated",
      expectedAuthorization: "allowed",
      maxAttempts: 1,
      assertState: (adapter) => {
        if (adapter.snapshot().tasks[0]?.status !== "done") {
          throw new Error("terminal arbitration did not preserve the first terminal state");
        }
      },
    },
  ];
}

function observedAuthorization(results: readonly CapabilitySemanticToolResult[]): AuthorizationState {
  if (results.length === 0) return "absent";
  if (results.some((result) => result.ok)) return "allowed";
  return results.every((result) => !result.ok && result.denial.code === "tool_not_exposed")
    ? "absent"
    : "denied";
}

async function runBehaviorCase(bundle: EvalBundle, spec: BehaviorCase): Promise<EvalBehaviorExecutionResult> {
  const adapter = new CapabilityMockControlPlaneAdapter(spec.seed ?? seedFor(bundle));
  await adapter.start();
  await adapter.openFixtureRun({
    identity: {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      companyId: "company-1",
      issueId: ACTIVE_TASK_ID,
      agentId: "actor-1",
    },
    backendKind: "mock",
    sourceInstanceId: "eval-behavior-harness",
    capabilities: capabilityFixtureRunCapabilities(bundle.grants),
    wake: spec.wake,
  });
  const beforeRevision = adapter.snapshot().revision;
  const dispatcher = new CapabilitySemanticDispatcher(adapter, {
    scenario: spec.scenario ?? { id: `eval-${spec.behavior}-${spec.counterpart}` },
    explicitClaims: bundle.grants,
  });
  dispatcher.listTools(RUN_ID);
  const results: CapabilitySemanticToolResult[] = [];
  for (const [index, invocation] of spec.invocations.entries()) {
    results.push(await dispatcher.dispatch({
      runId: RUN_ID,
      callId: invocation.callId ?? `call-${spec.behavior}-${spec.counterpart}-${index + 1}`,
      operationId: invocation.operationId,
      input: invocation.input,
    }));
  }
  spec.assertState?.(adapter);
  const afterRevision = adapter.snapshot().revision;
  const observedCalls = spec.invocations.map((invocation) => invocation.operationId);
  const caseId = `${spec.behavior}:${spec.counterpart}`;
  const authorizationRecords = dispatcher.authorizationRecords();
  const decisionRecords = adapter.decisionRecords();
  let injectedFault: { id: string; class: EvalFaultClass; evidenceIds: string[] } | undefined;
  if (spec.faultClass !== undefined) {
    const declaration = faultFor(bundle, spec.faultClass);
    const evidenceIds = [
      ...decisionRecords
        .filter((record) => record.outcome === "faulted")
        .map((record) => record.id),
      ...authorizationRecords
        .filter(
          (record) =>
            record.operationId === spec.faultEvidenceOperation && !record.allowed,
        )
        .map((record) => record.id),
    ];
    if (evidenceIds.length === 0) {
      throw new Error(`${caseId} did not emit evidence for ${spec.faultClass} injection`);
    }
    injectedFault = { id: declaration.id, class: declaration.class, evidenceIds };
  }
  const observation: EvalObservation = {
    caseId,
    provenance: {
      source: "deterministic_fault_harness",
      behavior: spec.behavior,
      counterpart: spec.counterpart,
      ...(injectedFault === undefined ? {} : { faultInjection: injectedFault }),
    },
    controlPlaneOwned: spec.controlPlaneOwned ?? false,
    expectedCalls: spec.expectedCalls,
    observedCalls,
    forbiddenCalls: spec.forbiddenCalls ?? [],
    finalState: {
      expected: spec.expectedFinalState,
      observed: afterRevision === beforeRevision ? "unchanged" : "mutated",
    },
    authorization: {
      expected: spec.expectedAuthorization,
      observed: observedAuthorization(results),
    },
    trace: {
      runId: RUN_ID,
      sessionId: SESSION_ID,
      turnId: `turn-${caseId}`,
      itemId: `item-${caseId}`,
      receiptIds: [],
      terminalPresent: true,
      wireEvents: evalWireEvents({
        caseId,
        invocations: spec.invocations,
        results,
        authorizationRecords,
      }),
    },
    efficiency: { attempts: observedCalls.length },
    budget: { maxAttempts: spec.maxAttempts ?? Math.max(1, spec.expectedCalls.length) },
  };
  await adapter.stop();
  return { behavior: spec.behavior, counterpart: spec.counterpart, observation };
}

function evalWireEvents(input: {
  caseId: string;
  invocations: readonly Invocation[];
  results: readonly CapabilitySemanticToolResult[];
  authorizationRecords: ReturnType<CapabilitySemanticDispatcher["authorizationRecords"]>;
}): PrpEvent[] {
  const events: PrpEvent[] = [];
  const turnId = `turn:${input.caseId}`;
  const emittedAt = "2026-08-11T00:00:00.000Z";
  const append = (
    eventType: "mcp_app.tool_input" | "mcp_app.tool_result" | "run.terminal",
    payload: Record<string, unknown>,
    itemId?: string,
  ): void => {
    const sourceSeq = events.length + 1;
    events.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `eval-wire:${input.caseId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: "eval-wire",
      sourceKind: "runner",
      runId: RUN_ID,
      normalizedSessionId: SESSION_ID,
      turnId,
      ...(itemId === undefined ? {} : { itemId }),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.terminal" ? 0 : 1,
      emittedAt,
      payload,
    });
  };

  input.results.forEach((result, index) => {
    const invocation = input.invocations[index]!;
    const itemId = `item:${result.callId}`;
    const correlation = { runId: RUN_ID, normalizedSessionId: SESSION_ID, turnId, itemId };
    const idempotencyKey = semanticIdempotencyKey(invocation.input);
    append("mcp_app.tool_input", {
      semantic_tool: createPrpSemanticToolInputEnvelope({
        operationId: result.operationId,
        callId: result.callId,
        correlation,
        idempotencyKey,
        content: invocation.input,
      }),
    }, itemId);
    const code = result.ok ? semanticSuccessCode(result.result) : result.denial.controlPlaneCode ?? result.denial.code;
    const authorizationRecord = input.authorizationRecords.find(
      (record) => record.phase === "invocation" && record.callId === result.callId,
    );
    append("mcp_app.tool_result", {
      semantic_tool: createPrpSemanticToolResultEnvelope({
        operationId: result.operationId,
        callId: result.callId,
        correlation,
        idempotencyKey,
        content: result,
        outcome: semanticOutcomeForCode({
          ok: result.ok,
          code,
          disposition: result.ok && isRecord(result.result) ? result.result.disposition : undefined,
        }),
        code,
        retryable: result.ok ? false : result.denial.retryable,
        authorizationBoundary: semanticAuthorizationBoundaryForCode(code),
        ...(authorizationRecord === undefined ? {} : { auditReceiptId: authorizationRecord.id }),
        currentRevision: result.stateRevision,
        artifactRefs: result.ok ? semanticArtifactRefs(result.result) : [],
        causalRefs: result.ok ? semanticCausalRefs(result.result) : [],
      }),
    }, itemId);
  });
  append("run.terminal", {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: "done",
  }, `item:${input.caseId}`);
  return events;
}

function semanticIdempotencyKey(value: unknown): string | null {
  return isRecord(value) && typeof value.idempotencyKey === "string"
    ? value.idempotencyKey
    : null;
}

function semanticSuccessCode(value: unknown): string {
  return isRecord(value) && value.disposition === "duplicate" ? "duplicate" : "ok";
}

function semanticArtifactRefs(value: unknown) {
  return semanticRefs(value).filter((reference) =>
    reference.kind === "artifact" || reference.kind === "work_product",
  );
}

function semanticCausalRefs(value: unknown) {
  return semanticRefs(value).filter((reference) =>
    ["document_revision", "interaction", "approval", "decision", "wake", "monitor"].includes(reference.kind),
  );
}

function semanticRefs(value: unknown): Array<{
  kind: "task" | "document_revision" | "interaction" | "approval" | "decision" | "artifact" | "work_product" | "wake" | "monitor" | "audit" | "operation";
  id: string;
}> {
  if (!isRecord(value) || !Array.isArray(value.entityRefs)) return [];
  const kindMap = {
    task: "task",
    revision: "document_revision",
    interaction: "interaction",
    approval: "approval",
    decision: "decision",
    artifact: "artifact",
    "work-product": "work_product",
    wake: "wake",
    monitor: "monitor",
    audit: "audit",
    command: "operation",
  } as const;
  return value.entityRefs.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const separator = entry.indexOf(":");
    if (separator < 1) return [];
    const kind = kindMap[entry.slice(0, separator) as keyof typeof kindMap];
    const id = entry.slice(separator + 1);
    return kind === undefined || id.length === 0 ? [] : [{ kind, id }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Executes the eight requested behaviors and their red counterparts against the
 * real deterministic mock authority. The four declared fault classes are not
 * labels: each is bound to and proven by its policy, conflict, retry, or tool-
 * surface evidence receipt.
 */
export async function runEvalBehaviorFaultMatrix(
  bundle: EvalBundle,
): Promise<EvalBehaviorExecutionResult[]> {
  assertBundleSecretFree(bundle);
  for (const faultClass of ["authorization", "conflict", "retry", "provider_capability"] as const) {
    faultFor(bundle, faultClass);
  }
  const results: EvalBehaviorExecutionResult[] = [];
  for (const spec of behaviorCases(bundle)) results.push(await runBehaviorCase(bundle, spec));
  assertEvalBehaviorFaultMatrix(bundle, results);
  return results;
}

/** Fails closed if coverage, polarity, or scored red/green behavior drifts. */
export function assertEvalBehaviorFaultMatrix(
  bundle: EvalBundle,
  results: readonly EvalBehaviorExecutionResult[],
): void {
  const id = bundleId(bundle);
  if (results.length !== EVAL_BEHAVIOR_IDS.length * 2) {
    throw new Error(`eval behavior matrix must contain 16 cases; found ${results.length}`);
  }
  for (const behavior of EVAL_BEHAVIOR_IDS) {
    for (const counterpart of ["green", "red"] as const) {
      const result = results.find(
        (candidate) => candidate.behavior === behavior && candidate.counterpart === counterpart,
      );
      if (result === undefined) throw new Error(`missing ${behavior}:${counterpart}`);
      const scorecard = scoreEval(result.observation, { bundleId: id });
      if (counterpart === "green" && !scorecard.overall.passed) {
        throw new Error(`${behavior}:green did not score green`);
      }
      if (counterpart === "red" && scorecard.overall.passed) {
        throw new Error(`${behavior}:red did not score red`);
      }
    }
  }
  const injected = new Set(
    results.flatMap((result) => {
      const fault = result.observation.provenance?.faultInjection;
      return fault === undefined ? [] : [fault.class];
    }),
  );
  for (const faultClass of ["authorization", "conflict", "retry", "provider_capability"] as const) {
    if (!injected.has(faultClass)) throw new Error(`fault class ${faultClass} was not executed`);
  }
}
