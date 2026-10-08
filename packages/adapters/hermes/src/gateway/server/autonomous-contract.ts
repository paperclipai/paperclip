import { createHash } from "node:crypto";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  autonomousActionRequestSchema,
  autonomousApprovalStateSchema,
  autonomousGateDecisionSchema,
  autonomousRiskDecisionSchema,
  autonomousRiskSchema,
  autonomousStateEnvelopeSchema,
  createAutonomousCorrelationMetadata,
  createAutonomousEffectRecord,
  createAutonomousMergeGateEvidence,
  getAutonomousRiskDecisionBindingIssue,
  type AutonomousApprovalState,
  type AutonomousCorrelationMetadata,
  type AutonomousGateDecision,
  type AutonomousRisk,
  type AutonomousStateEnvelope,
} from "@paperclipai/shared";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_EVENT_RECONNECT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TIMEOUT_SEC,
} from "../shared/constants.js";
import {
  allowsInsecureRemoteHttp,
  isRemotePlainHttp,
  parseBooleanLike,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

export type HermesGatewaySessionStrategy = "issue" | "agent" | "run" | "none";

export type HermesGatewayConfig = {
  apiBaseUrl: string;
  apiKey: string;
  sessionKeyStrategy: HermesGatewaySessionStrategy;
  persistSession: boolean;
  timeoutSec: number;
  eventReconnectMs: number;
  pollIntervalMs: number;
  paperclipApiUrl: string | null;
  headers: Record<string, string>;
};

export type HermesGatewayConfigValidation =
  | { ok: true; value: HermesGatewayConfig }
  | { ok: false; errorCode: string; errorMessage: string };

export type HermesGatewayScopeManifest = {
  tenantId: string;
  projectId: string;
  boardId: string;
  taskId: string;
};

type HermesGatewayGateMetadata = {
  gateId: string;
  decision: AutonomousGateDecision;
  evidenceRef?: string | null;
};

type HermesGatewayRiskMetadata = {
  decisionId?: string | null;
  outcome?: string | null;
  reasonCode?: string | null;
  requiresApproval?: boolean | null;
};

type HermesGatewaySourceEnvelope = {
  schemaVersion?: unknown;
  executionId?: unknown;
  taskId?: unknown;
  parentExecutionId?: unknown;
  attempt?: unknown;
  actionId?: unknown;
  idempotencyKey?: unknown;
  correlationId?: unknown;
  workerId?: unknown;
  role?: unknown;
  scope?: unknown;
  workerScope?: unknown;
  risk?: unknown;
  approval?: unknown;
  gates?: unknown;
  riskMetadata?: unknown;
  riskDecision?: unknown;
  stateEnvelope?: unknown;
};

export type HermesGatewayExecutionEnvelope = {
  schemaVersion: 1;
  executionId: string;
  taskId: string;
  parentExecutionId: string | null;
  attempt: number;
  actionId: string;
  idempotencyKey: string;
  effectKey: string;
  effectFingerprint: string;
  correlationId: string;
  workerId: string;
  role: string;
  scope: HermesGatewayScopeManifest;
  risk: AutonomousRisk;
  approval: AutonomousApprovalState;
  gates: HermesGatewayGateMetadata[];
  riskMetadata: HermesGatewayRiskMetadata;
  stateEnvelope: AutonomousStateEnvelope;
};

export type HermesGatewaySessionIdentity = {
  strategy: HermesGatewaySessionStrategy;
  sessionKey: string | null;
  priorSessionId: string | null;
  persistent: boolean;
};

export type HermesGatewayMappedRequest = {
  envelope: HermesGatewayExecutionEnvelope;
  session: HermesGatewaySessionIdentity;
  body: {
    autonomous: {
      schemaVersion: 1;
      executionId: string;
      taskId: string;
      parentExecutionId: string | null;
      attempt: number;
      actionId: string;
      idempotencyKey: string;
      effectKey: string;
      effectFingerprint: string;
      correlationId: string;
      workerId: string;
      role: string;
      scope: HermesGatewayScopeManifest;
      risk: AutonomousRisk;
      approval: AutonomousApprovalState;
      gates: HermesGatewayGateMetadata[];
      riskMetadata: HermesGatewayRiskMetadata;
      stateEnvelope: AutonomousStateEnvelope;
    };
    session: {
      strategy: HermesGatewaySessionStrategy;
      persistent: boolean;
      sessionKey: string | null;
      priorSessionId: string | null;
    };
    runContext: {
      executionId: string;
      runId: string;
      correlationId: string;
      timeoutSec: number;
      paperclipApiUrl: string | null;
    };
  };
};

export type HermesGatewayResponseEvidence = {
  gateEvidence: ReturnType<typeof createAutonomousMergeGateEvidence>[];
  correlation: AutonomousCorrelationMetadata;
  activity: {
    eventType: "hermes_gateway.run";
    status: string;
    summary: string | null;
    runId: string;
    correlationId: string;
  };
  telemetry: {
    provider: "hermes_gateway";
    status: string;
    exitCode: number | null;
    timedOut: boolean;
    runId: string;
    actionId: string;
    effectKey: string;
    effectFingerprint: string;
    correlationId: string;
  };
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const SENSITIVE_KEY_PATTERN = /api[_-]?key|secret|token|password|credential|authorization|private[_ -]?key|chain[_ -]?of[_ -]?thought|reasoning|raw[_ -]?output|prompt/i;
const CRITICAL_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "idempotency-key",
  "x-hermes-session-key",
]);
const SESSION_STRATEGIES = new Set<HermesGatewaySessionStrategy>(["issue", "agent", "run", "none"]);

function invalid(errorCode: string, errorMessage: string): HermesGatewayConfigValidation {
  return { ok: false, errorCode, errorMessage };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value: unknown, fallback: number, field: string): { value: number } | { error: HermesGatewayConfigValidation } {
  if (value === undefined || value === null || value === "") return { value: fallback };
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { error: invalid("hermes_gateway_config_invalid", `${field} must be a finite non-negative number.`) };
  }
  return { value: parsed };
}

function parseUrl(value: unknown, field: string): URL | null {
  const raw = nonEmpty(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function parseHeaders(value: unknown): { value: Record<string, string> } | { error: HermesGatewayConfigValidation } {
  if (value === undefined || value === null || value === "") return { value: {} };
  const source = typeof value === "string" ? (() => {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  })() : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { error: invalid("hermes_gateway_config_invalid_headers", "headers must be a JSON object or object.") };
  }
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source as Record<string, unknown>)) {
    if (!key.trim() || typeof entry !== "string") {
      return { error: invalid("hermes_gateway_config_invalid_headers", "headers must contain only non-empty string values.") };
    }
    if (CRITICAL_HEADERS.has(key.trim().toLowerCase())) continue;
    headers[key.trim()] = entry;
  }
  return { value: headers };
}

export function parseHermesGatewayConfig(config: unknown): HermesGatewayConfigValidation {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return invalid("hermes_gateway_config_invalid", "Hermes Gateway adapter config must be an object.");
  }
  const source = config as Record<string, unknown>;
  const apiBaseUrl = nonEmpty(source.apiBaseUrl ?? source.url);
  if (!apiBaseUrl) return invalid("hermes_gateway_api_base_url_missing", "Hermes gateway adapter requires apiBaseUrl.");
  const baseUrl = parseUrl(apiBaseUrl, "apiBaseUrl");
  if (!baseUrl) return invalid("hermes_gateway_api_base_url_invalid", "apiBaseUrl must be an http:// or https:// URL.");
  if (isRemotePlainHttp(baseUrl) && !allowsInsecureRemoteHttp(source)) {
    return invalid("hermes_gateway_plain_http_remote_denied", remotePlainHttpDeniedMessage(baseUrl.hostname));
  }

  const apiKey = nonEmpty(source.apiKey ?? source.token);
  if (!apiKey) return invalid("hermes_gateway_api_key_missing", "Hermes gateway adapter requires apiKey.");

  const strategyValue = source.sessionKeyStrategy === undefined ? "issue" : source.sessionKeyStrategy;
  if (typeof strategyValue !== "string" || !SESSION_STRATEGIES.has(strategyValue as HermesGatewaySessionStrategy)) {
    return invalid("hermes_gateway_config_unsupported_session_strategy", "sessionKeyStrategy must be one of issue, agent, run, or none.");
  }
  const persistValue = source.persistSession === undefined ? true : parseBooleanLike(source.persistSession);
  if (persistValue === null) return invalid("hermes_gateway_config_invalid", "persistSession must be boolean-like.");

  const timeout = finiteNumber(source.timeoutSec, DEFAULT_TIMEOUT_SEC, "timeoutSec");
  if ("error" in timeout) return timeout.error;
  const reconnect = finiteNumber(source.eventReconnectMs, DEFAULT_EVENT_RECONNECT_MS, "eventReconnectMs");
  if ("error" in reconnect) return reconnect.error;
  const poll = finiteNumber(source.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, "pollIntervalMs");
  if ("error" in poll) return poll.error;
  const headers = parseHeaders(source.headers);
  if ("error" in headers) return headers.error;

  const paperclipApiUrlValue = nonEmpty(source.paperclipApiUrl);
  if (paperclipApiUrlValue && !parseUrl(paperclipApiUrlValue, "paperclipApiUrl")) {
    return invalid("hermes_gateway_config_invalid", "paperclipApiUrl must be an http:// or https:// URL.");
  }
  return {
    ok: true,
    value: {
      apiBaseUrl,
      apiKey,
      sessionKeyStrategy: strategyValue as HermesGatewaySessionStrategy,
      persistSession: persistValue,
      timeoutSec: timeout.value,
      eventReconnectMs: Math.floor(Math.min(30_000, Math.max(250, reconnect.value))),
      pollIntervalMs: Math.floor(Math.min(10_000, Math.max(250, poll.value))),
      paperclipApiUrl: paperclipApiUrlValue ?? null,
      headers: headers.value,
    },
  };
}

function assertIdentifier(value: unknown, field: string): string {
  const result = nonEmpty(value);
  if (!result || !IDENTIFIER_PATTERN.test(result)) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", `${field} is missing or malformed.`);
  }
  return result;
}

function readRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertNoSensitiveKeys(value: unknown, path = "metadata"): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSensitiveKeys(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new HermesGatewayBoundaryError("hermes_gateway_envelope_secret_denied", `${path}.${key} is not allowed in autonomous metadata.`);
    }
    assertNoSensitiveKeys(entry, `${path}.${key}`);
  }
}

function parseScope(value: unknown, fallback: HermesGatewayScopeManifest, taskId: string): HermesGatewayScopeManifest {
  if (value === undefined) return fallback;
  const source = readRecord(value, "scope");
  const scope = {
    tenantId: assertIdentifier(source.tenantId, "scope.tenantId"),
    projectId: assertIdentifier(source.projectId, "scope.projectId"),
    boardId: assertIdentifier(source.boardId, "scope.boardId"),
    taskId: assertIdentifier(source.taskId, "scope.taskId"),
  };
  if (scope.taskId !== taskId) {
    throw new HermesGatewayBoundaryError("hermes_gateway_scope_denied", "Worker scope task does not match the execution task.");
  }
  return scope;
}

function parseGates(value: unknown): HermesGatewayGateMetadata[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "gates must be a bounded array.");
  }
  return value.map((entry, index) => {
    const gate = readRecord(entry, `gates[${index}]`);
    const allowed = new Set(["gateId", "decision", "evidenceRef"]);
    if (Object.keys(gate).some((key) => !allowed.has(key))) {
      throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", `gates[${index}] contains unsupported metadata.`);
    }
    const gateId = assertIdentifier(gate.gateId, `gates[${index}].gateId`);
    const decision = autonomousGateDecisionSchema.safeParse(gate.decision);
    if (!decision.success) {
      throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", `gates[${index}].decision is unsupported.`);
    }
    return {
      gateId,
      decision: decision.data,
      evidenceRef: gate.evidenceRef === undefined || gate.evidenceRef === null ? null : assertIdentifier(gate.evidenceRef, `gates[${index}].evidenceRef`),
    };
  });
}

function parseRiskMetadata(value: unknown): HermesGatewayRiskMetadata {
  if (value === undefined) return {};
  const source = readRecord(value, "riskMetadata");
  const allowed = new Set(["decisionId", "outcome", "reasonCode", "requiresApproval"]);
  if (Object.keys(source).some((key) => !allowed.has(key))) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "riskMetadata contains unsupported fields.");
  }
  if (source.requiresApproval !== undefined && source.requiresApproval !== null && typeof source.requiresApproval !== "boolean") {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "riskMetadata.requiresApproval must be boolean.");
  }
  return {
    ...(source.decisionId == null ? {} : { decisionId: assertIdentifier(source.decisionId, "riskMetadata.decisionId") }),
    ...(source.outcome == null ? {} : { outcome: assertIdentifier(source.outcome, "riskMetadata.outcome") }),
    ...(source.reasonCode == null ? {} : { reasonCode: assertIdentifier(source.reasonCode, "riskMetadata.reasonCode") }),
    ...(source.requiresApproval == null ? {} : { requiresApproval: source.requiresApproval === true }),
  };
}

export class HermesGatewayBoundaryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HermesGatewayBoundaryError";
    this.code = code;
  }
}

function readAutonomousSource(ctx: AdapterExecutionContext): HermesGatewaySourceEnvelope {
  const source = ctx.context.autonomousExecution ?? ctx.context.autonomous ?? ctx.context.autonomousEnvelope;
  if (source === undefined) return {};
  assertNoSensitiveKeys(source);
  const record = readRecord(source, "autonomous");
  const allowed = new Set([
    "schemaVersion", "executionId", "taskId", "parentExecutionId", "attempt", "actionId", "idempotencyKey", "correlationId",
    "workerId", "role", "scope", "workerScope", "risk", "approval", "gates", "riskMetadata", "riskDecision", "stateEnvelope",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "autonomous envelope contains unsupported fields.");
  }
  return record;
}

function assertActionIdentifier(value: unknown, field: string): string {
  const result = assertIdentifier(value, field);
  if (result.length > 256) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", `${field} is too long.`);
  }
  return result;
}

function readOptionalParentExecutionId(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return assertIdentifier(value, field);
}

function buildDefaultStateEnvelope(input: {
  executionId: string;
  taskId: string;
  parentExecutionId: string | null;
  workerId: string;
  role: string;
  risk: AutonomousRisk;
  attempt: number;
  gates: HermesGatewayGateMetadata[];
}): AutonomousStateEnvelope {
  const now = new Date().toISOString();
  return autonomousStateEnvelopeSchema.parse({
    schemaVersion: 1,
    executionId: input.executionId,
    taskId: input.taskId,
    parentExecutionId: input.parentExecutionId,
    risk: input.risk,
    state: "PENDING",
    dependencies: [],
    workers: [{ workerId: input.workerId, role: input.role, state: "PENDING" }],
    gates: input.gates.map(({ gateId, decision }) => ({ gateId, decision })),
    attempt: input.attempt,
    createdAt: now,
    updatedAt: now,
  });
}

function enforceGatewayGates(input: {
  risk: AutonomousRisk;
  gates: HermesGatewayGateMetadata[];
  stateEnvelope: AutonomousStateEnvelope;
}): void {
  const gates = [...input.gates, ...input.stateEnvelope.gates];
  if (gates.some((gate) => gate.decision !== "PASS")) {
    throw new HermesGatewayBoundaryError("hermes_gateway_gate_denied", "Autonomous execution requires every supplied gate to PASS.");
  }
  if (input.risk !== "LOW" && gates.length === 0) {
    throw new HermesGatewayBoundaryError("hermes_gateway_gate_denied", "Non-low-risk autonomous execution requires a passing gate.");
  }
}

export function buildHermesGatewaySessionIdentity(input: {
  strategy: HermesGatewaySessionStrategy;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  priorSessionId?: string | null;
  persistSession?: boolean;
}): HermesGatewaySessionIdentity {
  const persistent = input.persistSession !== false && (input.strategy === "issue" || input.strategy === "agent");
  const sessionKey = input.strategy === "none"
    ? null
    : !persistent
      ? `paperclip:run:${input.runId}`
      : input.strategy === "agent"
        ? `paperclip:company:${input.companyId}:agent:${input.agentId}`
        : input.strategy === "run"
          ? `paperclip:run:${input.runId}`
          : `paperclip:company:${input.companyId}:agent:${input.agentId}:${input.issueId ? `issue:${input.issueId}` : `run:${input.runId}`}`;
  return {
    strategy: input.strategy,
    sessionKey,
    priorSessionId: input.priorSessionId ?? null,
    persistent,
  };
}

export function mapPaperclipExecutionToHermesRequest(ctx: AdapterExecutionContext): HermesGatewayMappedRequest {
  const configResult = parseHermesGatewayConfig(ctx.config);
  if (!configResult.ok) throw new HermesGatewayBoundaryError(configResult.errorCode, configResult.errorMessage);
  const source = readAutonomousSource(ctx);
  const taskId = assertIdentifier(source.taskId ?? ctx.context.taskId ?? ctx.context.issueId ?? ctx.runId, "taskId");
  const executionId = assertIdentifier(source.executionId ?? ctx.runId, "executionId");
  const attempt = source.attempt === undefined ? 1 : source.attempt;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1 || attempt > 3) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "attempt must be an integer from 1 through 3.");
  }
  const actionId = assertIdentifier(source.actionId ?? `autonomous-action/${executionId}/${taskId}/${attempt}/WAKEUP`, "actionId");
  const idempotencyKey = assertActionIdentifier(
    source.idempotencyKey ?? `autonomous-idempotency/${executionId}/${taskId}/${attempt}/WAKEUP`,
    "idempotencyKey",
  );
  const correlationId = assertIdentifier(source.correlationId ?? `paperclip/${ctx.runId}/${executionId}`, "correlationId");
  const workerId = assertIdentifier(source.workerId ?? ctx.agent.id, "workerId");
  const role = assertIdentifier(source.role ?? "worker", "role");
  const defaultScope: HermesGatewayScopeManifest = {
    tenantId: ctx.agent.companyId,
    projectId: assertIdentifier(ctx.context.projectId ?? "paperclip", "projectId"),
    boardId: assertIdentifier(ctx.context.boardId ?? "paperclip", "boardId"),
    taskId,
  };
  const scope = parseScope(source.scope ?? source.workerScope, defaultScope, taskId);
  if (scope.tenantId !== ctx.agent.companyId) {
    throw new HermesGatewayBoundaryError("hermes_gateway_scope_denied", "Worker scope tenant does not match the Paperclip company.");
  }
  const risk = autonomousRiskSchema.safeParse(source.risk ?? "LOW");
  if (!risk.success) throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "risk is unsupported.");
  const approval = autonomousApprovalStateSchema.safeParse(source.approval ?? "NOT_REQUIRED");
  if (!approval.success) throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "approval is unsupported.");
  const gates = parseGates(source.gates);
  const riskMetadata = parseRiskMetadata(source.riskMetadata);
  const stateEnvelopeRaw = source.stateEnvelope;
  const stateEnvelopeResult = stateEnvelopeRaw === undefined
    ? null
    : autonomousStateEnvelopeSchema.safeParse(stateEnvelopeRaw);
  if (stateEnvelopeResult !== null && !stateEnvelopeResult.success) {
    throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "stateEnvelope is malformed.");
  }
  let stateEnvelope = stateEnvelopeResult?.success ? stateEnvelopeResult.data : null;
  if (stateEnvelope && (
    stateEnvelope.executionId !== executionId ||
    stateEnvelope.taskId !== taskId ||
    stateEnvelope.attempt !== attempt ||
    stateEnvelope.risk !== risk.data
  )) {
    throw new HermesGatewayBoundaryError("hermes_gateway_scope_denied", "stateEnvelope identity does not match the execution envelope.");
  }
  const parentCandidates = [
    readOptionalParentExecutionId(source.parentExecutionId, "parentExecutionId"),
    readOptionalParentExecutionId(ctx.context.parentExecutionId, "context.parentExecutionId"),
    stateEnvelope?.parentExecutionId,
  ].filter((value): value is string | null => value !== undefined);
  if (new Set(parentCandidates.map((value) => value ?? "<null>")).size > 1) {
    throw new HermesGatewayBoundaryError("hermes_gateway_parent_execution_mismatch", "Nested and top-level parentExecutionId values diverge.");
  }
  const parentExecutionId = parentCandidates[0] ?? null;
  let riskOutcome = risk.data === "LOW" ? "ALLOW" : "DENY";
  let riskDecisionData: ReturnType<typeof autonomousRiskDecisionSchema.parse> | null = null;
  if (source.riskDecision !== undefined) {
    const decision = autonomousRiskDecisionSchema.safeParse(source.riskDecision);
    if (!decision.success) throw new HermesGatewayBoundaryError("hermes_gateway_envelope_invalid", "riskDecision is malformed.");
    if (decision.data.actionId !== actionId || decision.data.executionId !== executionId || decision.data.taskId !== taskId) {
      throw new HermesGatewayBoundaryError("hermes_gateway_scope_denied", "riskDecision identity does not match the execution envelope.");
    }
    if (decision.data.risk !== risk.data) {
      throw new HermesGatewayBoundaryError("hermes_gateway_risk_decision_mismatch", "riskDecision risk does not match the execution envelope.");
    }
    riskDecisionData = decision.data;
    riskOutcome = decision.data.outcome;
  }
  if (risk.data !== "LOW" && !riskDecisionData) {
    throw new HermesGatewayBoundaryError("hermes_gateway_risk_decision_required", "Non-low-risk autonomous execution requires a riskDecision.");
  }
  if (!stateEnvelope) {
    stateEnvelope = buildDefaultStateEnvelope({
      executionId,
      taskId,
      parentExecutionId,
      workerId,
      role,
      risk: risk.data,
      attempt,
      gates,
    });
  }
  enforceGatewayGates({ risk: risk.data, gates, stateEnvelope });
  const effectiveGates = [...gates, ...stateEnvelope.gates];
  const gateDecision = effectiveGates.length === 0 && risk.data !== "LOW"
    ? "FAIL"
    : effectiveGates.every((gate) => gate.decision === "PASS")
      ? "PASS"
      : "FAIL";
  if (riskDecisionData) {
    const bindingIssue = getAutonomousRiskDecisionBindingIssue({
      decision: riskDecisionData,
      risk: risk.data,
      approval: approval.data,
      gateDecision,
      actionId,
      executionId,
      taskId,
    });
    if (bindingIssue) {
      throw new HermesGatewayBoundaryError("hermes_gateway_risk_decision_denied", `riskDecision admission evidence is ${bindingIssue}.`);
    }
  }
  const scopeKey = `${scope.tenantId}/${scope.projectId}/${scope.boardId}/${scope.taskId}/${workerId}`;
  const effect = createAutonomousEffectRecord(autonomousActionRequestSchema.parse({
    actionId,
    idempotencyKey,
    executionId,
    taskId,
    parentExecutionId,
    workerId,
    attempt,
    kind: "WAKEUP",
    effectType: "hermes_gateway.run",
    effectPayload: {
      provider: "hermes_gateway",
      runId: ctx.runId,
      executionId,
      taskId,
      attempt,
      scope: scopeKey,
      risk: risk.data,
      approval: approval.data,
      gateDecision,
      riskOutcome,
      companyId: ctx.agent.companyId,
    },
  }));
  const envelope: HermesGatewayExecutionEnvelope = {
    schemaVersion: 1,
    executionId,
    taskId,
    parentExecutionId,
    attempt,
    actionId,
    idempotencyKey,
    effectKey: effect.effectKey,
    effectFingerprint: effect.effectFingerprint,
    correlationId,
    workerId,
    role,
    scope,
    risk: risk.data,
    approval: approval.data,
    gates,
    riskMetadata,
    stateEnvelope,
  };
  const issueId = nonEmpty(ctx.context.issueId) ?? (taskId.startsWith("issue-") ? taskId : null);
  const session = buildHermesGatewaySessionIdentity({
    strategy: configResult.value.sessionKeyStrategy,
    companyId: ctx.agent.companyId,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    issueId,
    priorSessionId: nonEmpty(ctx.runtime.sessionId),
    persistSession: configResult.value.persistSession,
  });
  return {
    envelope,
    session,
    body: {
      autonomous: {
        schemaVersion: 1,
        executionId,
        taskId,
        parentExecutionId,
        attempt,
        actionId,
        idempotencyKey,
        effectKey: effect.effectKey,
        effectFingerprint: effect.effectFingerprint,
        correlationId,
        workerId,
        role,
        scope,
        risk: risk.data,
        approval: approval.data,
        gates,
        riskMetadata,
        stateEnvelope,
      },
      session: {
        strategy: session.strategy,
        persistent: session.persistent,
        sessionKey: session.sessionKey,
        priorSessionId: session.priorSessionId,
      },
      runContext: {
        executionId,
        runId: ctx.runId,
        correlationId,
        timeoutSec: configResult.value.timeoutSec,
        paperclipApiUrl: configResult.value.paperclipApiUrl,
      },
    },
  };
}

function redactEvidenceText(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/chain[_ -]?of[_ -]?thought|private\s+chain|reasoning\s*[:=]|raw[_ -]?output/i.test(text)) return "[REDACTED]";
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 240);
}

export function projectHermesResponseEvidence(input: {
  envelope: HermesGatewayExecutionEnvelope;
  runId: string;
  status: string;
  exitCode: number | null;
  summary?: unknown;
  errorCode?: string | null;
  timedOut?: boolean;
}): HermesGatewayResponseEvidence {
  const normalizedStatus = input.status.trim().toLowerCase() || "unknown";
  const passed = normalizedStatus === "completed" && input.exitCode === 0;
  const summary = redactEvidenceText(input.summary);
  const actionDigest = createHash("sha256").update(input.envelope.actionId).digest("hex").slice(0, 32);
  const evidenceRef = `artifact://hermes-gateway/${input.envelope.executionId.slice(0, 96)}/${input.runId.slice(0, 96)}/${actionDigest}`;
  const gateEvidence = [createAutonomousMergeGateEvidence({
    gateId: "global",
    decision: passed ? "PASS" : "FAIL",
    evidenceRef,
    metadata: {
      summary: summary ?? input.errorCode ?? normalizedStatus,
      exitCode: input.exitCode,
      changedFiles: null,
    },
  })];
  const correlation = createAutonomousCorrelationMetadata({
    executionId: input.envelope.executionId,
    taskId: input.envelope.taskId,
    parentExecutionId: input.envelope.parentExecutionId,
    workerId: input.envelope.workerId,
    attempt: input.envelope.attempt,
    actionId: input.envelope.actionId,
    eventKind: passed ? "effect.applied" : "effect.rejected",
    evidence: {
      summary,
      references: [evidenceRef],
    },
  });
  return {
    gateEvidence,
    correlation,
    activity: {
      eventType: "hermes_gateway.run",
      status: normalizedStatus,
      summary,
      runId: input.runId,
      correlationId: input.envelope.correlationId,
    },
    telemetry: {
      provider: "hermes_gateway",
      status: normalizedStatus,
      exitCode: input.exitCode,
      timedOut: input.timedOut === true,
      runId: input.runId,
      actionId: input.envelope.actionId,
      effectKey: input.envelope.effectKey,
      effectFingerprint: input.envelope.effectFingerprint,
      correlationId: input.envelope.correlationId,
    },
  };
}

export function mapHermesGatewayHealthFailure(input: { status?: number; unreachable?: boolean }): {
  errorCode: "hermes_gateway_health_failed" | "hermes_gateway_health_unreachable";
  errorFamily: "transient_upstream";
} {
  return input.unreachable || input.status === undefined
    ? { errorCode: "hermes_gateway_health_unreachable", errorFamily: "transient_upstream" }
    : { errorCode: "hermes_gateway_health_failed", errorFamily: "transient_upstream" };
}

export function safeGatewayMetadata(value: unknown): Record<string, unknown> {
  assertNoSensitiveKeys(value);
  return parseObject(value);
}

export { redactEvidenceText as redactHermesGatewayEvidenceText };
