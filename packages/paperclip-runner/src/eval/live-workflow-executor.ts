import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CapabilityJsonValue } from "../mock-core/capability-control-plane-types.js";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import type {
  PrpStructuredRunResult,
  PrpTerminalState,
} from "../protocol/replay-contract.js";
import { capabilityFixtureRunCapabilities } from "../scenarios/fixture-run-capabilities.js";
import {
  CapabilityLiveSessionService,
  InMemoryCapabilityLiveSessionStore,
  type CapabilityLiveSession,
  type CapabilityLiveSessionServiceOptions,
  type CapabilityLiveSessionSnapshot,
  type CapabilityLiveSessionStore,
  type CapabilityLiveTurnEvent,
  type CapabilityLiveTurnResult,
} from "../live/live-session.js";
import type { EvalObservation } from "./eval-scoring.js";
import { isCapabilitySemanticReadOperation } from "../semantic-tools/policy.js";
import {
  RUNNER_WORKFLOW_OBSERVATION_SCHEMA,
  type RunnerWorkflowCheck,
  type RunnerWorkflowEvalCase,
  type RunnerWorkflowObservation,
} from "./workflow-contracts.js";
import {
  RunnerWorkflowInfrastructureError,
  RUNNER_LIVE_CANDIDATE_SLOTS,
  type RunnerLiveEvalCandidate,
  type RunnerLiveScheduleEntry,
} from "./live-workflow-matrix.js";

const LIVE_GRANTS = [
  "delegation:tasks:create",
  "dependencies:write",
  "discovery:agents:read",
  "discovery:tasks:read",
  "governance:approvals:request",
] as const;

function promptFor(evalCase: RunnerWorkflowEvalCase): string {
  const common =
    "Use only the typed Paperclip tools. Do not call REST APIs. Reply with concise user-facing prose after the final tool result.";
  const prompts: Record<RunnerWorkflowEvalCase["id"], string> = {
    "final-response":
      "Write a detailed answer of at least 1200 characters, then call finish_task exactly once with a faithful summary. Do not replace the answer with a completion acknowledgement.",
    "rich-activity":
      "Immediately report one short progress update, inspect the workspace with a read-only command or search if available, then call finish_task exactly once. Preserve visible tool activity.",
    "verification-policy":
      "Call finish_task exactly once. Include one verification entry that is not_run with reasonCode tool_unavailable and explain the caveat without treating it as a blocker.",
    "governed-interaction":
      "Call request_human_input once to ask a required single-select question. After the typed answer arrives, use it exactly and call finish_task once. Do not create a provider-native question.",
    "steering-causality":
      "A later message will narrow the requested format. On this turn provide a short draft and do not repeat work; after the follow-up, call finish_task exactly once.",
    "planning-lifecycle":
      "Write a plan document, then request human confirmation. Do not create implementation work until confirmation is accepted. If rejected, revise the plan and request confirmation again. After acceptance, treat the work as small and cohesive: implement on the source task, create no child, and call finish_task.",
    "review-lifecycle":
      "Request human confirmation for an external verification check. If rejected, address only the requested verification and ask again. After acceptance call finish_task exactly once.",
    "delegation-return":
      "Write a plan document and request confirmation. After acceptance, create one child only because an independently owned external verification boundary justifies it, set the source dependency to that child, and after its completion result arrives call finish_task exactly once. Do not create phase or file-based children.",
    "completion-robustness":
      "Call finish_task exactly once with canonical values. If the tool returns a schema error, correct the arguments in this turn. Do not print completion JSON as prose.",
    "restart-recovery":
      "Call report_progress exactly once, state that disposition will be completed after recovery, and do not call finish_task on this turn.",
    "cancellation-permissions":
      "Begin a read-only inspection and continue working until interrupted. Do not claim completion and do not call a semantic completion tool.",
    "trace-lineage":
      "Call finish_task exactly once with a concise summary so the semantic tool frame can be correlated through PRP and presentation.",
  };
  return `${common} ${prompts[evalCase.id]}`;
}

function continuationPrompt(evalCase: RunnerWorkflowEvalCase): string {
  if (evalCase.id === "restart-recovery") {
    return "The provider session was restored. Use the existing progress result, do not repeat it, and call finish_task exactly once.";
  }
  if (evalCase.id === "steering-causality") {
    return "Steering update: use bullet points only. Apply only this formatting change and call finish_task exactly once without repeating prior work.";
  }
  if (evalCase.id === "delegation-return") {
    return "The plan is accepted. Create exactly one justified child, set the source task dependency to that child, then stop without calling finish_task. Wait for the authoritative child-completion result.";
  }
  return "Continue from the authoritative typed interaction result. Do not redo completed work.";
}

function workflowResult(
  disposition: "done" | "blocked",
  summary: string,
  idempotencyKey: string,
): PrpStructuredRunResult {
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: disposition,
    summary,
    completionClaim: {
      contractRevision: "runner-workflow-eval-v1",
      objectiveSatisfied: disposition === "done",
      criteria: [],
      remainingWork:
        disposition === "done"
          ? []
          : [
              {
                description: "Wait for the delegated child to complete.",
                blocksCompletion: true,
              },
            ],
    },
    evidence: [],
    verification: [],
    attentionRequests: [],
    artifacts: [],
    ...(disposition === "done"
      ? {}
      : {
          blocker: {
            reasonCode: "delegated_child_in_progress",
            owner: { kind: "agent" as const, name: "Delegated child" },
            unblockAction: "Complete the delegated child task.",
            scope: "current_track" as const,
          },
          continuation: {
            kind: "delegated_issue" as const,
            summary:
              "Resume the source task after the delegated child completes.",
            idempotencyKey,
          },
        }),
  };
}

async function completeWorkflowRun(
  adapter: CapabilityMockControlPlaneAdapter,
  input: {
    runId: string;
    sessionId: string;
    source: string;
    disposition: "done" | "blocked";
    summary: string;
  },
): Promise<void> {
  const terminal: PrpTerminalState = {
    schema: "paperclip.prp.terminal.v1",
    turnTerminalState: "completed",
    runTerminalState: "succeeded",
    reportedWorkDisposition: input.disposition,
  };
  const current = adapter.snapshot().runs.find((run) => run.id === input.runId);
  if (current === undefined) {
    throw new Error(`workflow eval run ${input.runId} is missing`);
  }
  if (current.result !== null) return;
  if (
    !current.events.some(
      (event) => "eventType" in event && event.eventType === "run.terminal",
    )
  ) {
    await adapter.appendEvent({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${input.source}:terminal:1`,
      sourceSeq: 1,
      sourceInstanceId: input.source,
      sourceKind: "runner",
      runId: input.runId,
      normalizedSessionId: input.sessionId,
      turnId: `${input.source}-turn`,
      eventType: "run.terminal",
      schemaVersion: 1,
      priority: 0,
      emittedAt: new Date().toISOString(),
      payload: terminal,
    });
  }
  await adapter.completeRun({
    result: workflowResult(
      input.disposition,
      input.summary,
      `${input.source}-continuation`,
    ),
    terminal,
  });
}

export interface AdvancedDelegationReturnState {
  mockState: string;
  childTaskId: string;
  returnRunId: string;
}

/**
 * Advance the controlled mock authority through the child-return boundary.
 * This is orchestration evidence, not a model-authored semantic call: the
 * evaluated provider still has to author the child/dependency and final result.
 */
export async function advanceDelegationReturnMockState(input: {
  mockState: string;
  parentRunId: string;
  parentSessionId: string;
  parentTaskId: string;
  capabilities: readonly string[];
}): Promise<AdvancedDelegationReturnState | null> {
  const adapter = CapabilityMockControlPlaneAdapter.restore(input.mockState);
  if (adapter.snapshot().lifecycle !== "running") await adapter.start();
  const initial = adapter.snapshot();
  const children = initial.tasks.filter(
    (task) => task.parentId === input.parentTaskId,
  );
  if (children.length !== 1) return null;
  const child = children[0]!;
  if (
    !initial.blockers.some(
      (blocker) =>
        blocker.taskId === input.parentTaskId &&
        blocker.blockedByTaskId === child.id,
    )
  ) {
    return null;
  }

  await completeWorkflowRun(adapter, {
    runId: input.parentRunId,
    sessionId: input.parentSessionId,
    source: `${input.parentRunId}-delegation-wait`,
    disposition: "blocked",
    summary: "Source task is waiting on its delegated child.",
  });

  const childRunId = `${input.parentRunId}-child`;
  const childSessionId = `${input.parentSessionId}-child`;
  const actorId = child.assigneeActorId ?? initial.actors[0]!.id;
  await adapter.openFixtureRun({
    identity: {
      runId: childRunId,
      sessionId: childSessionId,
      companyId: child.companyId,
      issueId: child.id,
      agentId: actorId,
    },
    backendKind: "runner",
    sourceInstanceId: "runner-workflow-eval-child",
    capabilities: [...input.capabilities],
  });
  await adapter.applyCommand({
    runId: childRunId,
    idempotencyKey: `${childRunId}-finish`,
    command: {
      kind: "finish_task",
      taskId: child.id,
      summary: "Delegated verification completed.",
    },
  });
  await completeWorkflowRun(adapter, {
    runId: childRunId,
    sessionId: childSessionId,
    source: `${childRunId}-completion`,
    disposition: "done",
    summary: "Delegated verification completed.",
  });

  const returnRunId = `${input.parentRunId}-return`;
  await adapter.openFixtureRun({
    identity: {
      runId: returnRunId,
      sessionId: input.parentSessionId,
      companyId: initial.company.id,
      issueId: input.parentTaskId,
      agentId: initial.actors[0]!.id,
    },
    backendKind: "runner",
    sourceInstanceId: "runner-workflow-eval-return",
    capabilities: [...input.capabilities],
    wake: {
      reason: "blockers_resolved",
      payload: { completedTaskId: child.id },
    },
  });
  return { mockState: adapter.serialize(), childTaskId: child.id, returnRunId };
}

async function restoreAfterDelegatedChild(input: {
  session: CapabilityLiveSession;
  store: CapabilityLiveSessionStore;
  transportOptions: CapabilityLiveSessionServiceOptions["transportOptions"];
}): Promise<{
  service: CapabilityLiveSessionService;
  session: CapabilityLiveSession;
} | null> {
  const before = input.session.snapshot();
  const advanced = await advanceDelegationReturnMockState({
    mockState: before.mockState,
    parentRunId: before.authority.runId,
    parentSessionId: before.sessionId,
    parentTaskId: before.authority.taskId,
    capabilities: before.authority.capabilities,
  });
  if (advanced === null) return null;
  await input.session.suspend("workflow eval delegated child completed");
  const checkpoint = await input.store.load(before.sessionId);
  if (checkpoint === null) {
    throw new Error("workflow eval delegation checkpoint is missing");
  }
  const {
    providerRunBinding: _providerRunBinding,
    ...checkpointWithoutBinding
  } = checkpoint;
  const at = new Date().toISOString();
  const updated: CapabilityLiveSessionSnapshot = {
    ...checkpointWithoutBinding,
    revision: checkpoint.revision + 1,
    updatedAt: at,
    authority: {
      ...checkpoint.authority,
      runId: advanced.returnRunId,
    },
    mockState: advanced.mockState,
    stateHistory: [
      ...(checkpoint.stateHistory ?? []),
      {
        revision: JSON.parse(advanced.mockState).revision as number,
        at,
        turnId: null,
        operationId: "eval.delegated_child_completed",
        state: advanced.mockState,
      },
    ],
  };
  await input.store.save(updated);
  const service = new CapabilityLiveSessionService({
    store: input.store,
    transportOptions: input.transportOptions,
  });
  return { service, session: await service.restore(before.sessionId) };
}

function acpxAgent(
  candidate: RunnerLiveEvalCandidate,
): "claude" | "codex" | undefined {
  if (candidate.adapter !== "acpx_runtime") return undefined;
  if (candidate.qualification.profile === "claude") return "claude";
  if (candidate.qualification.profile === "codex") return "codex";
  return undefined;
}

function check(
  id: string,
  passed: boolean,
  reason: string,
  evidenceIds: string[] = [],
): RunnerWorkflowCheck {
  return {
    id,
    passed,
    ...(passed ? {} : { reason }),
    ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
  };
}

function interactionResolution(
  evalCase: RunnerWorkflowEvalCase,
  index: number,
): {
  outcome: "answered" | "accepted" | "rejected";
  result: CapabilityJsonValue;
} {
  const decisions = evalCase.steps.flatMap((step) =>
    step.kind === "review_decision" ? [step.decision] : [],
  );
  const decision = decisions[index];
  if (decision === "reject")
    return {
      outcome: "rejected",
      result: {
        note: "Eval reviewer requests the narrow verification-only revision.",
      },
    };
  if (decision === "approve")
    return { outcome: "accepted", result: { confirmed: true } };
  return {
    outcome: "answered",
    result: { selectedOptionIds: ["eval-choice"], answer: "eval-choice" },
  };
}

function providerEventTypes(snapshot: CapabilityLiveSessionSnapshot): string[] {
  return snapshot.evidence.flatMap((entry) => {
    if (entry.kind !== "provider_event") return [];
    const value = entry.data.canonicalEventType;
    return typeof value === "string" ? [value] : [];
  });
}

function observedCalls(snapshot: CapabilityLiveSessionSnapshot): string[] {
  return snapshot.evidence.flatMap((entry) =>
    entry.kind === "tool_call" && typeof entry.data.operationId === "string"
      ? [entry.data.operationId]
      : [],
  );
}

export function unexpectedLiveWorkflowCalls(
  calls: readonly string[],
  expectedCalls: readonly string[],
): string[] {
  const expected = new Set(expectedCalls);
  return scorableLiveWorkflowCalls(calls, expectedCalls).filter(
    (operationId) => !expected.has(operationId),
  );
}

/**
 * Keeps required reads and every stateful operation in trajectory scoring while
 * ignoring optional read-only context gathering. The full call list remains in
 * the workflow evidence and metrics for auditability.
 */
export function scorableLiveWorkflowCalls(
  calls: readonly string[],
  expectedCalls: readonly string[],
): string[] {
  const expected = new Set(expectedCalls);
  return calls.filter(
    (operationId) =>
      expected.has(operationId) ||
      !isCapabilitySemanticReadOperation(operationId),
  );
}

function duplicateEffectSignals(
  snapshot: CapabilityLiveSessionSnapshot,
): string[] {
  return snapshot.evidence.flatMap((entry) => {
    if (entry.kind !== "tool_result") return [];
    const envelope =
      typeof entry.data.result === "object" &&
      entry.data.result !== null &&
      !Array.isArray(entry.data.result)
        ? (entry.data.result as Record<string, CapabilityJsonValue>)
        : {};
    const result =
      typeof envelope.result === "object" &&
      envelope.result !== null &&
      !Array.isArray(envelope.result)
        ? (envelope.result as Record<string, CapabilityJsonValue>)
        : {};
    return result.disposition === "duplicate" &&
      typeof entry.data.operationId === "string"
      ? [entry.data.operationId]
      : [];
  });
}

function traceMetadata(raw: string): {
  frameCount: number;
  byteCount: number;
  digest: string;
  digestVerified: boolean;
  ordered: boolean;
  dispositions: string[];
  lineage: string[];
} {
  const records = raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  const frames = records.filter((entry) => entry.kind === "frame");
  const frameIds = frames.map((entry) => Number(entry.frameId));
  const debugSequences = records
    .map((entry) => Number(entry.debugSequence))
    .filter(Number.isFinite);
  const digestVerified =
    frames.length > 0 &&
    frames.every((entry) => {
      if (
        typeof entry.rawBase64 !== "string" ||
        typeof entry.digest !== "string"
      )
        return false;
      const bytes = Buffer.from(entry.rawBase64, "base64");
      return (
        bytes.byteLength === Number(entry.byteLength) &&
        `sha256:${createHash("sha256").update(bytes).digest("hex")}` ===
          entry.digest
      );
    });
  const strictlyIncreasing = (values: number[]): boolean =>
    values.every(
      (value, index) =>
        Number.isFinite(value) && (index === 0 || value > values[index - 1]!),
    );
  const interpretations = records.filter(
    (entry) => entry.kind === "interpretation",
  );
  const emittedCounts = interpretations.map((entry) =>
    Array.isArray(entry.emittedEventIds) ? entry.emittedEventIds.length : 0,
  );
  const eventParents = new Map<string, number>();
  for (const interpretation of interpretations) {
    if (!Array.isArray(interpretation.emittedEventIds)) continue;
    for (const eventId of interpretation.emittedEventIds) {
      if (typeof eventId === "string")
        eventParents.set(eventId, (eventParents.get(eventId) ?? 0) + 1);
    }
  }
  const lineage = new Set<string>();
  if (interpretations.length > 0) lineage.add("one_to_one");
  if (emittedCounts.some((count) => count > 1)) lineage.add("one_to_many");
  if ([...eventParents.values()].some((count) => count > 1))
    lineage.add("many_to_one");
  return {
    frameCount: frames.length,
    byteCount: frames.reduce(
      (sum, entry) => sum + (Number(entry.byteLength) || 0),
      0,
    ),
    digest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
    digestVerified,
    ordered: strictlyIncreasing(frameIds) && strictlyIncreasing(debugSequences),
    dispositions: [
      ...new Set(
        interpretations.flatMap((entry) =>
          typeof entry.disposition === "string" ? [entry.disposition] : [],
        ),
      ),
    ],
    lineage: [...lineage],
  };
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function safeFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|AKIA[0-9A-Z]{16})\b/gi,
      "[REDACTED]",
    )
    .slice(0, 1_000);
}

const LIVE_PROVIDER_CREDENTIAL_ENVIRONMENT = new Set(
  RUNNER_LIVE_CANDIDATE_SLOTS.flatMap((slot) =>
    slot.candidates.flatMap(
      (candidate) => candidate.qualification.requiredEnvironment,
    ),
  ),
);
const CREDENTIAL_ENVIRONMENT_NAME =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|AUTH(?:ORIZATION)?|COOKIE|SECRET|SESSION|TOKEN|PASSWORD|CREDENTIALS?)(?:$|_)/;

function candidateTransportEnvironment(
  candidate: RunnerLiveEvalCandidate,
  tracePath: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const required = new Set(candidate.qualification.requiredEnvironment);
  return {
    ...Object.fromEntries(
      Object.entries(source).filter(
        ([name, value]) =>
          typeof value === "string" &&
          ((!LIVE_PROVIDER_CREDENTIAL_ENVIRONMENT.has(name) &&
            !CREDENTIAL_ENVIRONMENT_NAME.test(name)) ||
            required.has(name)),
      ),
    ),
    PAPERCLIP_PROVIDER_TRACE_PATH: tracePath,
  };
}

function usageTotals(snapshot: CapabilityLiveSessionSnapshot | undefined): {
  totalTokens: number;
  costUsd: number;
} {
  const usage = snapshot?.usageLedger ?? [];
  return {
    totalTokens: usage.reduce(
      (sum, receipt) =>
        sum +
        receipt.inputTokens +
        receipt.outputTokens +
        receipt.reasoningTokens,
      0,
    ),
    costUsd:
      usage.reduce((sum, receipt) => sum + receipt.costNanodollars, 0) /
      1_000_000_000,
  };
}

function candidateBudgetViolations(
  candidate: RunnerLiveEvalCandidate,
  snapshot: CapabilityLiveSessionSnapshot | undefined,
): string[] {
  const usage = usageTotals(snapshot);
  const violations: string[] = [];
  if (usage.totalTokens > candidate.budget.maxTotalTokens) {
    violations.push(
      `totalTokens ${usage.totalTokens} exceeds budget ${candidate.budget.maxTotalTokens}`,
    );
  }
  if (usage.costUsd > candidate.budget.maxCostUsd) {
    violations.push(
      `costUsd ${usage.costUsd} exceeds budget ${candidate.budget.maxCostUsd}`,
    );
  }
  return violations;
}

function candidateBudgetThresholdsReached(
  candidate: RunnerLiveEvalCandidate,
  snapshot: CapabilityLiveSessionSnapshot | undefined,
): string[] {
  const usage = usageTotals(snapshot);
  const reached: string[] = [];
  if (usage.totalTokens >= candidate.budget.maxTotalTokens) {
    reached.push(
      `totalTokens ${usage.totalTokens} reached budget ${candidate.budget.maxTotalTokens}`,
    );
  }
  if (usage.costUsd >= candidate.budget.maxCostUsd) {
    reached.push(
      `costUsd ${usage.costUsd} reached budget ${candidate.budget.maxCostUsd}`,
    );
  }
  return reached;
}

function liveCandidateBudgetStopReason(
  candidate: RunnerLiveEvalCandidate,
  snapshot: CapabilityLiveSessionSnapshot,
  usage: Extract<CapabilityLiveTurnEvent, { kind: "usage" }>["usage"],
): string | null {
  const committed = usageTotals(snapshot);
  const totalTokens =
    committed.totalTokens +
    usage.inputTokens +
    usage.outputTokens +
    usage.reasoningTokens;
  const costUsd = committed.costUsd + usage.costNanodollars / 1_000_000_000;
  const reached: string[] = [];
  if (totalTokens >= candidate.budget.maxTotalTokens) {
    reached.push(
      `totalTokens ${totalTokens} reached budget ${candidate.budget.maxTotalTokens}`,
    );
  }
  if (costUsd >= candidate.budget.maxCostUsd) {
    reached.push(
      `costUsd ${costUsd} reached budget ${candidate.budget.maxCostUsd}`,
    );
  }
  return reached.length === 0
    ? null
    : `candidate reported usage budget stop: ${reached.join("; ")}`;
}

/** Builds an unscored observation without exposing provider credentials or raw trace payloads. */
export function unavailableLiveRunnerWorkflowObservation(input: {
  entry: RunnerLiveScheduleEntry;
  candidate: RunnerLiveEvalCandidate;
  evalCase: RunnerWorkflowEvalCase;
  classification: "infrastructure_failure" | "skipped";
  code: string;
  category: "provider" | "qualification" | "orchestration";
  retryable: boolean;
  message: string;
}): RunnerWorkflowObservation {
  const unavailable = check("execution-unavailable", false, input.message);
  return {
    schema: RUNNER_WORKFLOW_OBSERVATION_SCHEMA,
    caseId: input.evalCase.id,
    candidateId: input.candidate.id,
    provider: input.candidate.provider,
    classification: input.classification,
    base: {
      caseId: input.evalCase.id,
      provenance: { source: "live_model", behavior: input.evalCase.id },
      controlPlaneOwned: false,
      expectedCalls: input.evalCase.assertions.requiredOperationIds ?? [],
      observedCalls: [],
      forbiddenCalls: [],
      finalState: { expected: "mutated", observed: "unchanged" },
      authorization: { expected: "allowed", observed: "absent" },
      trace: { terminalPresent: false, receiptIds: [] },
      efficiency: { latencyMs: 0, totalTokens: 0, costUsd: 0, attempts: 0 },
      budget: input.candidate.budget,
    },
    lifecycle: {
      checks: [unavailable],
      attempts: 0,
      runs: 0,
      recoveryOwner: "none",
    },
    continuation: { checks: [unavailable], repeatedWorkSignals: [] },
    presentation: {
      checks: [unavailable],
      responseSource: "none",
      commentCount: 0,
    },
    traceLineage: {
      capture: "off",
      frameCount: 0,
      byteCount: 0,
      digestVerified: false,
      ordered: false,
      dispositions: [],
      lineage: [],
    },
    metrics: {
      settlementMs: 0,
      attempts: 0,
      toolCount: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    observedPrpEventTypes: [],
    artifactDigests: [],
    failure: {
      code: input.code,
      category: input.category,
      retryable: input.retryable,
      message: safeFailureMessage(input.message),
    },
  };
}

async function settleInteractions(
  evalCase: RunnerWorkflowEvalCase,
  session: CapabilityLiveSession,
  turns: CapabilityLiveTurnResult[],
  withinBudget: () => boolean,
): Promise<void> {
  let index = 0;
  while (
    session.pendingInteractions().length > 0 &&
    index < 6 &&
    withinBudget()
  ) {
    const pending = session.pendingInteractions()[0]!;
    const resolution = interactionResolution(evalCase, index);
    turns.push(
      await session.resolveInteraction({
        interactionId: pending.id,
        ...resolution,
      }),
    );
    index += 1;
  }
}

/** Executes one real-provider workflow against the controlled mock authority. */
export async function executeLiveRunnerWorkflow(input: {
  entry: RunnerLiveScheduleEntry;
  candidate: RunnerLiveEvalCandidate;
  evalCase: RunnerWorkflowEvalCase;
  workingDirectory?: string;
  allowMissingUsage?: boolean;
  expectedAssistantText?: string;
  promptOverride?: string;
  runnerBinary?: string;
}): Promise<RunnerWorkflowObservation> {
  const runtimeRoot = await mkdtemp(
    join(tmpdir(), "paperclip-runner-live-eval-"),
  );
  const tracePath = join(runtimeRoot, "provider-trace.ndjson");
  const store = new InMemoryCapabilityLiveSessionStore();
  const transportOptions = {
    environment: candidateTransportEnvironment(input.candidate, tracePath),
    ...(input.runnerBinary === undefined
      ? {}
      : { runnerBinary: input.runnerBinary }),
  };
  let service = new CapabilityLiveSessionService({ store, transportOptions });
  let session: CapabilityLiveSession | null = null;
  const turns: CapabilityLiveTurnResult[] = [];
  const streamed: CapabilityLiveTurnEvent[] = [];
  const startedAt = Date.now();
  let firstVisibleAt: number | null = null;
  let infrastructureError: unknown;
  let budgetInterrupt: Promise<void> | null = null;
  let budgetInterruptError: unknown;
  let budgetStopReason: string | null = null;
  let unsubscribe: () => void = () => undefined;
  const withinBudget = (): boolean =>
    budgetStopReason === null &&
    candidateBudgetThresholdsReached(input.candidate, session?.snapshot())
      .length === 0;
  const subscribeToSession = (activeSession: CapabilityLiveSession): void => {
    unsubscribe();
    unsubscribe = activeSession.subscribe((event) => {
      streamed.push(event);
      if (
        firstVisibleAt === null &&
        (event.kind === "delta" || event.kind === "activity")
      )
        firstVisibleAt = Date.now();
      if (
        event.kind === "usage" &&
        budgetInterrupt === null &&
        session === activeSession
      ) {
        const reason = liveCandidateBudgetStopReason(
          input.candidate,
          activeSession.snapshot(),
          event.usage,
        );
        if (reason !== null) {
          budgetStopReason = reason;
          budgetInterrupt = activeSession.interrupt(reason).then(
            () => undefined,
            (error: unknown) => {
              budgetInterruptError = error;
            },
          );
        }
      }
    });
  };
  try {
    session = await service.create({
      workingDirectory: input.workingDirectory ?? runtimeRoot,
      provider: input.candidate.provider,
      ...(acpxAgent(input.candidate) === undefined
        ? {}
        : { acpxAgent: acpxAgent(input.candidate) }),
      requestedModel: input.candidate.model,
      seed: {
        actors: [
          {
            id: "actor-1",
            companyId: "company-1",
            name: "Workflow eval actor",
            role: "engineer",
            status: "active",
            budgetId: "budget-actor-1",
            capabilityGrants: [...LIVE_GRANTS],
          },
        ],
      },
      capabilities: capabilityFixtureRunCapabilities(LIVE_GRANTS),
      explicitClaims: [...LIVE_GRANTS],
      runId: input.entry.executionId,
      // Durable session identity is validation-bearing and must not look like
      // credential material (for example a `session-...` token).
      sessionId: `eval-${input.entry.executionId}`,
      attemptId: `attempt-${input.entry.executionId}`,
      turnTimeoutMs: input.candidate.budget.maxLatencyMs,
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 300_000 },
      scenario: { id: `runner-workflow-${input.evalCase.id}` },
    });
    subscribeToSession(session);
    try {
      if (input.evalCase.id === "cancellation-permissions") {
        const pending = session.sendMessage(promptFor(input.evalCase));
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        await session.interrupt("workflow eval cancellation");
        const settled = await Promise.allSettled([pending]);
        if (settled[0]?.status === "fulfilled") turns.push(settled[0].value);
      } else {
        turns.push(
          await session.sendMessage(
            input.promptOverride ?? promptFor(input.evalCase),
            {
              allowMissingUsage: input.allowMissingUsage,
            },
          ),
        );
        await settleInteractions(input.evalCase, session, turns, withinBudget);
        if (input.evalCase.id === "delegation-return" && withinBudget()) {
          const restored = await restoreAfterDelegatedChild({
            session,
            store,
            transportOptions,
          });
          if (restored !== null) {
            service = restored.service;
            session = restored.session;
            subscribeToSession(session);
            turns.push(
              await session.sendMessage(
                "The delegated child completed successfully and the source task is unblocked. Use the authoritative child result and call finish_task exactly once without repeating the delegated work.",
                { allowMissingUsage: input.allowMissingUsage },
              ),
            );
          }
        }
        if (input.evalCase.id === "steering-causality" && withinBudget()) {
          turns.push(
            await session.sendMessage(continuationPrompt(input.evalCase), {
              allowMissingUsage: input.allowMissingUsage,
            }),
          );
        }
        if (input.evalCase.id === "restart-recovery" && withinBudget()) {
          const sessionId = session.id;
          await session.suspend("workflow eval simulated worker restart");
          service = new CapabilityLiveSessionService({
            store,
            transportOptions,
          });
          session = await service.restore(sessionId);
          subscribeToSession(session);
          turns.push(
            await session.sendMessage(continuationPrompt(input.evalCase), {
              allowMissingUsage: input.allowMissingUsage,
            }),
          );
        }
      }
    } finally {
      unsubscribe();
      if (budgetInterrupt !== null) await budgetInterrupt;
      if (budgetInterruptError !== undefined) throw budgetInterruptError;
    }
  } catch (error) {
    infrastructureError = error;
  }

  const snapshot = session?.snapshot();
  if (session !== null) {
    try {
      await service.shutdown(session.id, "Runner live workflow eval complete");
    } catch (error) {
      infrastructureError ??= error;
    }
  }
  if (infrastructureError !== undefined) {
    await rm(runtimeRoot, { recursive: true, force: true });
    throw new RunnerWorkflowInfrastructureError(
      "live_provider_execution_failed",
      true,
      safeFailureMessage(infrastructureError),
    );
  }
  const calls = snapshot === undefined ? [] : observedCalls(snapshot);
  const expectedCalls = input.evalCase.assertions.requiredOperationIds ?? [];
  const taskState =
    snapshot === undefined
      ? null
      : ((
          JSON.parse(snapshot.mockState) as {
            tasks?: Array<{ id: string; status: string }>;
          }
        ).tasks?.find((task) => task.id === "task-1") ?? null);
  const terminalStatuses = turns.map((turn) => turn.status);
  const cancellationExpected = input.evalCase.id === "cancellation-permissions";
  const terminalOkay = cancellationExpected
    ? terminalStatuses.some(
        (status) => status === "cancelled" || status === "interrupted",
      )
    : terminalStatuses.length > 0 &&
      terminalStatuses.every((status) => status === "completed");
  const missingCalls = expectedCalls.filter(
    (operationId) => !calls.includes(operationId),
  );
  const extraCalls = unexpectedLiveWorkflowCalls(calls, expectedCalls);
  const duplicateSignals =
    snapshot === undefined ? [] : duplicateEffectSignals(snapshot);
  const pendingInteractions = session?.pendingInteractions().length ?? 0;
  let rawTrace = "";
  try {
    rawTrace = await readFile(tracePath, "utf8");
  } catch {
    rawTrace = "";
  }
  const trace = traceMetadata(rawTrace);
  const { totalTokens, costUsd } = usageTotals(snapshot);
  const budgetViolations = candidateBudgetViolations(input.candidate, snapshot);
  const budgetThresholdsReached = candidateBudgetThresholdsReached(
    input.candidate,
    snapshot,
  );
  const budgetFailure =
    budgetViolations.length > 0
      ? {
          code: "candidate_budget_exceeded",
          message: budgetViolations.join("; "),
        }
      : budgetStopReason !== null
        ? {
            code: "candidate_budget_reached",
            message: budgetStopReason,
          }
        : budgetThresholdsReached.length > 0
          ? {
              code: "candidate_budget_reached",
              message: budgetThresholdsReached.join("; "),
            }
          : null;
  const receiptIds =
    snapshot?.evidence
      .filter((entry) => entry.kind === "tool_result")
      .map((entry) => entry.id) ?? [];
  const assistantTexts =
    snapshot?.transcript
      .filter(
        (entry) => entry.role === "assistant" && entry.text.trim().length > 0,
      )
      .map((entry) => entry.text) ?? [];
  const stateMutated = (snapshot?.stateHistory?.length ?? 0) > 1;
  const base: EvalObservation = {
    caseId: input.evalCase.id,
    provenance: { source: "live_model", behavior: input.evalCase.id },
    controlPlaneOwned: expectedCalls.length === 0,
    expectedCalls,
    observedCalls: scorableLiveWorkflowCalls(calls, expectedCalls),
    forbiddenCalls: [],
    finalState: {
      expected: expectedCalls.length === 0 ? "unchanged" : "mutated",
      observed: stateMutated ? "mutated" : "unchanged",
    },
    authorization: {
      expected: expectedCalls.length === 0 ? "absent" : "allowed",
      observed:
        calls.length === 0
          ? "absent"
          : snapshot?.authorizationRecords.some(
                (record) => record.phase === "invocation" && !record.allowed,
              )
            ? "denied"
            : "allowed",
    },
    trace: {
      runId: snapshot?.authority.runId,
      sessionId: snapshot?.sessionId,
      turnId: turns.at(-1)?.turnId,
      itemId: snapshot?.evidence.find((entry) => entry.kind === "tool_call")
        ?.id,
      receiptIds,
      terminalPresent: terminalStatuses.length > 0,
    },
    efficiency: {
      latencyMs: Date.now() - startedAt,
      totalTokens,
      costUsd,
      attempts: snapshot?.attempts?.length ?? 1,
    },
    budget: {
      maxLatencyMs: input.candidate.budget.maxLatencyMs,
      maxTotalTokens: input.candidate.budget.maxTotalTokens,
      maxCostUsd: input.candidate.budget.maxCostUsd,
      maxAttempts: input.candidate.budget.maxAttempts,
    },
  };
  const lifecycleChecks = [
    check(
      "terminal-authority",
      terminalOkay,
      `unexpected terminal statuses: ${terminalStatuses.join(",") || "none"}`,
    ),
    check(
      "attempt-bound",
      (snapshot?.attempts?.length ?? 1) <= input.candidate.budget.maxAttempts,
      "attempt budget exceeded",
    ),
    check(
      "token-budget",
      totalTokens <= input.candidate.budget.maxTotalTokens,
      `totalTokens ${totalTokens} exceeds budget ${input.candidate.budget.maxTotalTokens}`,
    ),
    check(
      "cost-budget",
      costUsd <= input.candidate.budget.maxCostUsd,
      `costUsd ${costUsd} exceeds budget ${input.candidate.budget.maxCostUsd}`,
    ),
    check(
      "candidate-budget-stop",
      budgetFailure === null,
      budgetFailure?.message ?? "candidate budget remained available",
    ),
    check(
      "semantic-disposition",
      cancellationExpected ||
        calls.includes("finish_task") ||
        calls.includes("request_review"),
      "no authoritative semantic disposition",
    ),
    check(
      "owned-wait",
      pendingInteractions === 0,
      `${pendingInteractions} governed interaction(s) remain pending`,
    ),
  ];
  const continuationChecks = [
    check(
      "required-calls",
      missingCalls.length === 0,
      `missing required calls: ${missingCalls.join(", ")}`,
    ),
    check(
      "trajectory-restraint",
      extraCalls.length === 0,
      `unexpected calls: ${extraCalls.join(", ")}`,
    ),
    check(
      "no-repeated-work",
      input.evalCase.id === "restart-recovery" || duplicateSignals.length === 0,
      `duplicate semantic effects detected: ${[...new Set(duplicateSignals)].join(", ")}`,
    ),
  ];
  const presentationChecks = [
    check(
      "first-visible-progress",
      cancellationExpected || firstVisibleAt !== null,
      "provider emitted no visible progress",
    ),
    check(
      "substantive-response",
      cancellationExpected ||
        assistantTexts.some((text) => text.trim().length >= 2),
      "provider emitted no user-facing response",
    ),
    ...(input.expectedAssistantText === undefined
      ? []
      : [
          check(
            "expected-assistant-text",
            assistantTexts.length === 1 &&
              assistantTexts[0]?.trim() === input.expectedAssistantText,
            "provider response did not exactly match the smoke marker",
          ),
        ]),
    check(
      "no-empty-comment",
      assistantTexts.every((text) => text.trim().length > 0),
      "empty assistant output was retained",
    ),
    check(
      "terminal-presentation",
      terminalOkay,
      "terminal presentation would remain unsettled",
    ),
  ];
  const checksPassed = [
    ...lifecycleChecks,
    ...continuationChecks,
    ...presentationChecks,
  ].every((entry) => entry.passed);
  const observation: RunnerWorkflowObservation = {
    schema: RUNNER_WORKFLOW_OBSERVATION_SCHEMA,
    caseId: input.evalCase.id,
    candidateId: input.candidate.id,
    provider: input.candidate.provider,
    classification:
      checksPassed && budgetFailure === null
        ? "completed"
        : "candidate_failure",
    base,
    lifecycle: {
      checks: lifecycleChecks,
      issueStatus: taskState?.status,
      runStatus: terminalStatuses.at(-1),
      semanticDisposition: calls.includes("finish_task")
        ? "done"
        : calls.includes("request_review")
          ? "needs_review"
          : undefined,
      attempts: snapshot?.attempts?.length ?? 1,
      runs: turns.length,
      recoveryOwner: pendingInteractions > 0 ? "human" : "none",
    },
    continuation: {
      checks: continuationChecks,
      wakeReasons:
        snapshot?.evidence
          .filter((entry) => entry.kind === "interaction")
          .map(() => "interaction_resolved") ?? [],
      consumedInputIds:
        snapshot?.evidence
          .filter((entry) => entry.kind === "interaction")
          .map((entry) => entry.id) ?? [],
      sessionPolicy:
        input.evalCase.id === "restart-recovery"
          ? "same_session"
          : "same_session",
      repeatedWorkSignals: [...new Set([...extraCalls, ...duplicateSignals])],
    },
    presentation: {
      checks: presentationChecks,
      responseSource:
        assistantTexts.length > 0 ? "final_agent_message" : "none",
      commentCount: assistantTexts.length > 0 ? 1 : 0,
      orderedMarkers: streamed.map((event) => event.kind),
      visibleActivityFamilies:
        snapshot === undefined
          ? []
          : providerEventTypes(snapshot).map(
              (eventType) => eventType.split(".")[0]!,
            ),
      terminalLabel: cancellationExpected
        ? "Stopped"
        : terminalOkay
          ? "Completed"
          : "Needs attention",
    },
    traceLineage: {
      capture: rawTrace.length > 0 ? "on" : "off",
      frameCount: trace.frameCount,
      byteCount: trace.byteCount,
      digestVerified: trace.digestVerified,
      ordered: trace.ordered,
      dispositions: trace.dispositions,
      lineage: trace.lineage,
      ...(rawTrace.length > 0 ? { traceRef: trace.digest } : {}),
    },
    metrics: {
      timeToFirstVisibleProgressMs:
        firstVisibleAt === null ? undefined : firstVisibleAt - startedAt,
      settlementMs: Date.now() - startedAt,
      attempts: snapshot?.attempts?.length ?? 1,
      toolCount: calls.length,
      totalTokens,
      costUsd,
    },
    observedPrpEventTypes:
      snapshot === undefined ? [] : providerEventTypes(snapshot),
    artifactDigests:
      snapshot?.workspaceDiffs?.map((entry) => digestJson(entry.diff)) ?? [],
    ...(budgetFailure === null
      ? {}
      : {
          failure: {
            code: budgetFailure.code,
            category: "candidate" as const,
            retryable: false,
            message: budgetFailure.message,
          },
        }),
  };
  await rm(runtimeRoot, { recursive: true, force: true });
  return observation;
}
