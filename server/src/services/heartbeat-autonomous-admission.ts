import type { Db } from "@paperclipai/db";
import {
  consumeAutonomousActionOnce,
  releaseAutonomousActionReservation,
  registerAutonomousAction,
} from "@paperclipai/db";
import {
  autonomousApprovalStateSchema,
  autonomousGateDecisionSchema,
  autonomousRiskDecisionSchema,
  autonomousRiskSchema,
  autonomousStateEnvelopeSchema,
  getAutonomousRiskDecisionBindingIssue,
  type AutonomousActionDedupDecision,
  type AutonomousActionRequest,
} from "@paperclipai/shared";

const HERMES_GATEWAY_ADAPTER = "hermes_gateway";
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;

type JsonObject = Record<string, unknown>;

type HeartbeatAutonomousLedger = {
  register: typeof registerAutonomousAction;
  consume: typeof consumeAutonomousActionOnce;
  release?: typeof releaseAutonomousActionReservation;
};

export type HeartbeatAutonomousAdmissionInput = {
  db: Db;
  adapterType: string;
  companyId: string;
  workerId: string;
  executionId: string;
  runId: string;
  context: JsonObject;
  ledger?: HeartbeatAutonomousLedger;
};

export type HeartbeatAutonomousAdmissionResult =
  | { outcome: "SKIPPED" }
  | { outcome: "CONSUMED"; actionId: string; effectKey: string; effectFingerprint: string };

/**
 * Keep the last ownership check adjacent to the admission boundary. The
 * heartbeat caller must invoke this after ledger admission and immediately
 * before entering the adapter, so a cancellation or reassignment cannot turn
 * a claimed action into an external run.
 */
export function assertHeartbeatAutonomousDispatchOwnership(input: {
  aborted: boolean;
  currentRun: { status: string; companyId: string; agentId: string } | null;
  companyId: string;
  agentId: string;
}): void {
  if (
    input.aborted ||
    !input.currentRun ||
    input.currentRun.status !== "running" ||
    input.currentRun.companyId !== input.companyId ||
    input.currentRun.agentId !== input.agentId
  ) {
    throw new Error("autonomous_heartbeat_dispatch_ownership_changed");
  }
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function asIdentifier(value: unknown, fallback: string, field: string): string {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!IDENTIFIER_PATTERN.test(candidate)) {
    throw new Error(`autonomous_heartbeat_admission_invalid_${field}`);
  }
  return candidate;
}

function readOptionalParentExecutionId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return asIdentifier(value, "", field);
}

function readGateDecision(source: JsonObject, additionalGates: readonly unknown[] = []): {
  gateDecision: "PASS" | "FAIL";
  gateCount: number;
} {
  const raw = source.gates;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new Error("autonomous_heartbeat_admission_invalid_gates");
  }
  const gates = [...(raw ?? []), ...additionalGates];
  let gateDecision: "PASS" | "FAIL" = "PASS";
  for (const gate of gates) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      throw new Error("autonomous_heartbeat_admission_invalid_gate");
    }
    const parsed = autonomousGateDecisionSchema.safeParse((gate as JsonObject).decision);
    if (!parsed.success) throw new Error("autonomous_heartbeat_admission_invalid_gate");
    if (parsed.data !== "PASS") gateDecision = "FAIL";
  }
  return { gateDecision, gateCount: gates.length };
}

function readScope(input: {
  source: JsonObject;
  companyId: string;
  taskId: string;
  workerId: string;
  projectId?: unknown;
  boardId?: unknown;
}): string {
  const raw = input.source.scope ?? input.source.workerScope;
  const scope = raw === undefined ? {} : asObject(raw);
  if (raw !== undefined && Object.keys(scope).length === 0) {
    throw new Error("autonomous_heartbeat_admission_invalid_scope");
  }
  const tenantId = asIdentifier(scope.tenantId, input.companyId, "scope_tenant");
  const projectId = asIdentifier(scope.projectId ?? input.projectId, "paperclip", "scope_project");
  const boardId = asIdentifier(scope.boardId ?? input.boardId, "paperclip", "scope_board");
  const scopedTaskId = asIdentifier(scope.taskId, input.taskId, "scope_task");
  if (tenantId !== input.companyId || scopedTaskId !== input.taskId) {
    throw new Error("autonomous_heartbeat_admission_scope_denied");
  }
  return `${tenantId}/${projectId}/${boardId}/${scopedTaskId}/${input.workerId}`;
}

function admissionRequest(input: {
  source: JsonObject;
  companyId: string;
  workerId: string;
  executionId: string;
  runId: string;
  taskId: string;
  attempt: number;
  parentExecutionId: string | null;
  scopeKey: string;
  risk: string;
  approval: string;
  gateDecision: "PASS" | "FAIL";
  riskOutcome: string;
}): AutonomousActionRequest {
  const actionId = asIdentifier(
    input.source.actionId,
    `autonomous-action/${input.executionId}/${input.taskId}/${input.attempt}/WAKEUP`,
    "action",
  );
  const idempotencyKey = asIdentifier(
    input.source.idempotencyKey,
    `autonomous-idempotency/${input.executionId}/${input.taskId}/${input.attempt}/WAKEUP`,
    "idempotency",
  );
  return {
    actionId,
    idempotencyKey,
    executionId: input.executionId,
    taskId: input.taskId,
    parentExecutionId: input.parentExecutionId,
    workerId: input.workerId,
    attempt: input.attempt,
    kind: "WAKEUP",
    effectType: "hermes_gateway.run",
    effectPayload: {
      provider: "hermes_gateway",
      runId: input.runId,
      executionId: input.executionId,
      taskId: input.taskId,
      attempt: input.attempt,
      scope: input.scopeKey,
      risk: input.risk,
      approval: input.approval,
      gateDecision: input.gateDecision,
      riskOutcome: input.riskOutcome,
      companyId: input.companyId,
    },
  };
}

function denyReason(input: {
  risk: string;
  approval: string;
  gateDecision: "PASS" | "FAIL";
  gateCount: number;
  riskOutcome: string;
  hasRiskDecision: boolean;
}): string | null {
  if (input.gateDecision !== "PASS" || (input.risk !== "LOW" && input.gateCount === 0)) {
    return "gate_failed_or_missing";
  }
  if (input.approval === "PENDING" || input.approval === "DENIED") {
    return "approval_not_granted";
  }
  if (input.risk !== "LOW" && !input.hasRiskDecision) {
    return "non_low_risk_requires_granted_approval";
  }
  if (input.riskOutcome !== "ALLOW") return "risk_decision_denied";
  return null;
}

function throwDenied(reason: string, decision: AutonomousActionDedupDecision): never {
  throw new Error(
    `autonomous_heartbeat_admission_denied:${reason}:ledger=${decision.decisionId}`,
  );
}

/**
 * Admission boundary for the Hermes gateway heartbeat path. The request shape
 * intentionally mirrors the gateway mapper so D16 effect keys/fingerprints
 * remain identical at the server and adapter boundaries.
 */
export async function admitHeartbeatAutonomousAction(
  input: HeartbeatAutonomousAdmissionInput,
): Promise<HeartbeatAutonomousAdmissionResult> {
  if (input.adapterType !== HERMES_GATEWAY_ADAPTER) return { outcome: "SKIPPED" };

  const source = asObject(
    input.context.autonomousExecution ?? input.context.autonomous ?? input.context.autonomousEnvelope,
  );
  const taskId = asIdentifier(
    source.taskId ?? input.context.taskId ?? input.context.issueId,
    input.executionId,
    "task",
  );
  const executionId = asIdentifier(source.executionId, input.executionId, "execution");
  const workerId = asIdentifier(source.workerId, input.workerId, "worker");
  const attemptValue = source.attempt === undefined ? 1 : source.attempt;
  if (typeof attemptValue !== "number" || !Number.isInteger(attemptValue) || attemptValue < 1 || attemptValue > 3) {
    throw new Error("autonomous_heartbeat_admission_invalid_attempt");
  }
  const attempt = attemptValue;
  const riskResult = autonomousRiskSchema.safeParse(source.risk ?? "LOW");
  const approvalResult = autonomousApprovalStateSchema.safeParse(source.approval ?? "NOT_REQUIRED");
  if (!riskResult.success) throw new Error("autonomous_heartbeat_admission_invalid_risk");
  if (!approvalResult.success) throw new Error("autonomous_heartbeat_admission_invalid_approval");
  const risk = riskResult.data;
  const approval = approvalResult.data;
  const stateEnvelopeRaw = source.stateEnvelope;
  const stateEnvelopeResult = stateEnvelopeRaw === undefined
    ? null
    : autonomousStateEnvelopeSchema.safeParse(stateEnvelopeRaw);
  if (stateEnvelopeResult !== null && !stateEnvelopeResult.success) {
    throw new Error("autonomous_heartbeat_admission_invalid_state_envelope");
  }
  const stateEnvelope = stateEnvelopeResult?.success ? stateEnvelopeResult.data : null;
  if (stateEnvelope && (
    stateEnvelope.executionId !== executionId ||
    stateEnvelope.taskId !== taskId ||
    stateEnvelope.attempt !== attempt ||
    stateEnvelope.risk !== risk
  )) {
    throw new Error("autonomous_heartbeat_admission_state_scope_denied");
  }
  const parentCandidates = [
    readOptionalParentExecutionId(source.parentExecutionId, "parent_execution"),
    readOptionalParentExecutionId(input.context.parentExecutionId, "context_parent_execution"),
    stateEnvelope?.parentExecutionId,
  ].filter((value): value is string | null => value !== undefined);
  if (new Set(parentCandidates.map((value) => value ?? "<null>")).size > 1) {
    throw new Error("autonomous_heartbeat_admission_parent_execution_mismatch");
  }
  const parentExecutionId = parentCandidates[0] ?? null;
  const { gateDecision, gateCount } = readGateDecision(source, stateEnvelope?.gates ?? []);
  const riskDecisionRaw = source.riskDecision;
  const riskDecision = riskDecisionRaw === undefined
    ? null
    : autonomousRiskDecisionSchema.safeParse(riskDecisionRaw);
  if (riskDecision !== null && !riskDecision.success) {
    throw new Error("autonomous_heartbeat_admission_invalid_risk_decision");
  }
  const riskDecisionData = riskDecision && riskDecision.success ? riskDecision.data : null;
  const riskOutcome = riskDecisionData?.outcome ?? (risk === "LOW" ? "ALLOW" : "DENY");
  if (riskDecisionData && (
    riskDecisionData.actionId !== (typeof source.actionId === "string" ? source.actionId : `autonomous-action/${executionId}/${taskId}/${attempt}/WAKEUP`) ||
    riskDecisionData.executionId !== executionId ||
    riskDecisionData.taskId !== taskId
  )) {
    throw new Error("autonomous_heartbeat_admission_risk_scope_denied");
  }
  if (riskDecisionData) {
    const bindingIssue = getAutonomousRiskDecisionBindingIssue({
      decision: riskDecisionData,
      risk,
      approval,
      gateDecision,
      actionId: typeof source.actionId === "string"
        ? source.actionId
        : `autonomous-action/${executionId}/${taskId}/${attempt}/WAKEUP`,
      executionId,
      taskId,
    });
    if (bindingIssue) {
      throw new Error(`autonomous_heartbeat_admission_risk_decision_${bindingIssue}`);
    }
  }
  const scopeKey = readScope({
    source,
    companyId: input.companyId,
    taskId,
    workerId,
    projectId: input.context.projectId,
    boardId: input.context.boardId,
  });
  const request = admissionRequest({
    source,
    companyId: input.companyId,
    workerId,
    executionId,
    runId: input.runId,
    taskId,
    attempt,
    parentExecutionId,
    scopeKey,
    risk,
    approval,
    gateDecision,
    riskOutcome,
  });
  const ledger = input.ledger ?? {
    register: registerAutonomousAction,
    consume: consumeAutonomousActionOnce,
    release: releaseAutonomousActionReservation,
  };
  const registered = await ledger.register(input.db, input.companyId, request);
  const reason = denyReason({
    risk,
    approval,
    gateDecision,
    gateCount,
    riskOutcome,
    hasRiskDecision: riskDecisionData !== null,
  });
  if (reason) {
    await ledger.release?.(input.db, input.companyId, registered.actionId);
    throwDenied(reason, registered);
  }
  const consumed = await ledger.consume(input.db, input.companyId, request);
  if (consumed.outcome === "ALREADY_CONSUMED") {
    throw new Error(`autonomous_heartbeat_admission_duplicate:${consumed.actionId}`);
  }
  if (consumed.outcome === "REJECT") {
    throw new Error(`autonomous_heartbeat_admission_conflict:${consumed.reasonCode}`);
  }
  return {
    outcome: "CONSUMED",
    actionId: consumed.actionId,
    effectKey: consumed.effectKey,
    effectFingerprint: consumed.effectFingerprint,
  };
}
