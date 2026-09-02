import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
} from "../drivers/codex/app-server-transport.js";
import { redactCodexDiagnostic } from "../drivers/codex/app-server-transport.js";
import { createSkilllessCodexThreadConfig } from "../drivers/codex/codex-app-server-driver.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
  type QualifiedAcpxProfile,
} from "../drivers/acpx/qualified-profiles.js";
import { canonicalProviderEventsFromCodex } from "../provider-events.js";
import type {
  CapabilityFixtureInteraction,
  CapabilityFixtureSeed,
  CapabilityFixtureState,
  CapabilityInteractionKind,
  CapabilityJsonValue,
  CapabilityOpenFixtureRunInput,
} from "../mock-core/capability-control-plane-types.js";
import { CapabilityMockControlPlaneAdapter } from "../mock-core/capability-mock-control-plane-adapter.js";
import { CapabilitySemanticDispatcher } from "../semantic-tools/dispatcher.js";
import { CAPABILITY_DISCOVERY_GATEWAY_DEFINITIONS, type CapabilityToolExposureMode } from "../semantic-tools/discovery.js";
import type {
  CapabilitySemanticAuthorizationRecord,
  CapabilitySemanticScenarioPolicy,
  CapabilitySemanticToolDefinition,
  CapabilitySemanticToolResult,
} from "../semantic-tools/types.js";
import {
  capabilityProviderEventCategory,
  redactCapabilityEvidenceData,
  type CapabilityEvidenceKind,
} from "./evidence-redaction.js";
import {
  createCapabilityRunnerdCodexTransport,
  type CapabilityRunnerdCodexTransport,
  type CapabilityRunnerdCodexTransportOptions,
  type CapabilityRunnerdProcessEvidence,
} from "./runnerd-codex-transport.js";
import {
  capturePaperclipWorkspace,
  diffPaperclipWorkspace,
  type PaperclipWorkspaceDiff,
} from "./workspace-diff.js";
import {
  discoverPaperclipWorkspaceFileReferences,
  type PaperclipWorkspaceFileReference,
} from "./workspace-file-reference.js";

const LIVE_SESSION_SCHEMA = "paperclip.capability.live-session.v1" as const;
const LIVE_BASE_INSTRUCTIONS = [
  "You are operating one mock Paperclip issue through typed semantic tools.",
  "Use only the tools exposed in this thread; never call a Paperclip REST API.",
  "Treat every tool result as authoritative mock state and use it in your next response.",
  "The user conversation and provider are real, but all Paperclip records are mock records.",
  "Do not discover skills, credentials, endpoints, or hidden control-plane capabilities.",
].join(" ");
const CODEX_PERMISSION_PROFILE = "paperclip-runner-workspace-only";
const DISCOVER_TOOL = "discover_capabilities";
const INVOKE_DISCOVERED_TOOL = "invoke_discovered_capability";

export type CapabilityLiveSessionStatus =
  | "starting"
  | "restoring"
  | "idle"
  | "warm_idle"
  | "waiting_input"
  | "suspending"
  | "suspended"
  | "running"
  | "stopping"
  | "closed"
  | "failed";

export interface CapabilityLiveTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  turnId: string | null;
  at: string;
}

export interface CapabilityLiveEvidenceEntry {
  id: string;
  kind: CapabilityEvidenceKind;
  at: string;
  turnId: string | null;
  /**
   * Redacted at append time by `redactCapabilityEvidenceData`. Nothing here is a
   * verbatim provider payload, tool argument, or tool result, so no reader,
   * frame, replay payload, or log can reintroduce one (track 7U).
   */
  data: Record<string, CapabilityJsonValue>;
}

export interface CapabilityLiveAuthoritySnapshot {
  active: boolean;
  runId: string;
  companyId: string;
  actorId: string;
  taskId: string;
  sessionId: string;
  scenarioId: string;
  capabilities: string[];
  explicitClaims: string[];
}

export interface CapabilityLiveSessionConfigSnapshot {
  workingDirectory: string;
  /** Exact model requested by the caller; omitted only for legacy interactive sessions. */
  requestedModel?: string;
  /** Safe harness identity used by server-side projections and eval metadata. */
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  driver?: "codex_app_server" | "opencode_server" | "claude_managed_agents_api" | "aws_agentcore_harness_api" | "acpx_runtime";
  providerVersion?: string | null;
  acpxAgent?: QualifiedAcpxAgent;
  acpxProfile?: QualifiedAcpxProfile;
  managedProfile?: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: "managed-agents-2026-04-01";
    maxSessionListCostUsd: number;
  };
  agentCoreProfile?: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    contextBucket: string;
    contextPrefix: string;
    contextKmsKeyArn: string;
    qualificationRevision: string;
    eventExpiryDays: 90;
    maxEstimatedSessionCostUsd: number;
    maxIterations: number;
    maxOutputTokens: number;
    timeoutSeconds: number;
  };
  scenario: CapabilitySemanticScenarioPolicy;
  capabilities: string[];
  explicitClaims: string[];
  seedState: string;
  turnTimeoutMs: number;
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  toolExposure?: CapabilityToolExposureMode;
}

export type CapabilityLiveAttemptStatus = "running" | "succeeded" | "failed" | "terminated";

export interface CapabilityLiveAttemptSnapshot {
  attemptId: string;
  resumeOf: string | null;
  status: CapabilityLiveAttemptStatus;
  startedAt: string;
  finishedAt: string | null;
  failureCode: string | null;
}

export interface CapabilityLiveTurnTerminalFact {
  turnId: string;
  status: CapabilityLiveTurnResult["status"];
  reconciledByAttemptId: string;
  observedAt: string;
}

export interface CapabilityLiveUsageReceipt {
  receiptId: string;
  attemptId: string;
  providerResponseId: string | null;
  turnId: string | null;
  providerCalls: number;
  providerRequests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  costNanodollars: number;
  observedAt: string;
}

export interface CapabilityLiveStateRevision {
  revision: number;
  at: string;
  turnId: string | null;
  operationId: string;
  state: string;
}

export interface CapabilityLiveWorkspaceDiffEntry {
  turnId: string;
  at: string;
  diff: PaperclipWorkspaceDiff;
}

export interface CapabilityLiveWorkspaceFileReferenceEntry {
  turnId: string;
  at: string;
  reference: PaperclipWorkspaceFileReference;
}

export interface RecordCapabilityLiveUsageInput {
  receiptId: string;
  providerResponseId?: string | null;
  turnId?: string | null;
  providerCalls?: number;
  providerRequests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  costNanodollars?: number;
}

export interface CapabilityLiveSessionSnapshot {
  schema: typeof LIVE_SESSION_SCHEMA;
  revision: number;
  sessionId: string;
  providerThreadId: string;
  providerSessionId: string | null;
  /** Safe provider identity retained for reproducible eval bundle declarations. */
  providerModel?: { id: string; provider: string };
  /** Validated structured provider result, retained separately from assistant prose. */
  semanticResult?: Record<string, CapabilityJsonValue> | null;
  status: CapabilityLiveSessionStatus;
  activeTurnId: string | null;
  /** Latest immutable PRP attachment retained independently of the provider session. */
  providerRunBinding?: { runId: string; turnId: string; itemId: string };
  createdAt: string;
  updatedAt: string;
  authority: CapabilityLiveAuthoritySnapshot;
  config: CapabilityLiveSessionConfigSnapshot;
  mockState: string;
  transcript: CapabilityLiveTranscriptEntry[];
  evidence: CapabilityLiveEvidenceEntry[];
  authorizationRecords: CapabilitySemanticAuthorizationRecord[];
  process: CapabilityRunnerdProcessEvidence | null;
  networkEvidence: {
    realPaperclipRequests: 0;
    childPaperclipEnvironmentKeys: string[];
  };
  /** Governed worker attempts. A resumed worker is a new attempt, never a rewrite. */
  attempts?: CapabilityLiveAttemptSnapshot[];
  currentAttemptId?: string;
  /** Provider terminal facts reconciled by the attempt that observed them. */
  terminalTurns?: CapabilityLiveTurnTerminalFact[];
  /** Exact-once provider usage/cost receipts retained across every attempt. */
  usageLedger?: CapabilityLiveUsageReceipt[];
  /** Process-level evidence for an interrupted Codex semantic-call resume. */
  nativeResume?: {
    schema: "paperclip.runner.native-resume-proof/v1";
    triggered: true;
    runnerRestarts: number;
    runnerProcessPids: number[];
    providerProcessPids: number[];
    sharedCodexServerPid: number | null;
    sameProviderThread: boolean;
    providerThreadDigest: string | null;
    callId: string;
    operationId: string;
    inputEventCount: number;
    resultEventCount: number;
    semanticHandlerCallCount: number;
    controlPlaneEffectCount: number;
    runnerReconciledEventCount: number;
    crashedRunnerSignal: string | null;
    providerCalls: number;
    providerRequests: number;
    costNanodollars: number;
  };
  /** Bounded mock-control-plane snapshots for DevTools time travel and diffs. */
  stateHistory?: CapabilityLiveStateRevision[];
  /** Complete, bounded per-turn workspace changes verified by the runner. */
  workspaceDiffs?: CapabilityLiveWorkspaceDiffEntry[];
  /** Assistant-authored local links verified and normalized by the runner. */
  workspaceFileReferences?: CapabilityLiveWorkspaceFileReferenceEntry[];
  loadedOperationIds?: string[];
}

export interface CreateCapabilityLiveSessionInput {
  seed?: CapabilityFixtureSeed | CapabilityFixtureState;
  workingDirectory?: string;
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  acpxAgent?: QualifiedAcpxAgent;
  requestedModel?: string;
  managedProfile?: CapabilityLiveSessionConfigSnapshot["managedProfile"];
  agentCoreProfile?: CapabilityLiveSessionConfigSnapshot["agentCoreProfile"];
  scenario?: CapabilitySemanticScenarioPolicy;
  capabilities?: string[];
  explicitClaims?: string[];
  companyId?: string;
  actorId?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  attemptId?: string;
  turnTimeoutMs?: number;
  lifecyclePolicy?: CapabilityLiveSessionConfigSnapshot["lifecyclePolicy"];
  toolExposure?: CapabilityToolExposureMode;
}

export interface ResumeCapabilityLiveSessionInput {
  sessionId: string;
  attemptId: string;
  resumeOf: string;
  // Sets the turn timeout of the session from this resume onward. The
  // value persists into the saved checkpoint, so a later resume() call
  // that omits this option keeps the value set here.
  // A caller with a bounded recovery window should pass a value smaller
  // than that window, so a stall inside the resumed turn reports which
  // turn stalled instead of surfacing only as the caller's own timeout.
  turnTimeoutMs?: number;
}

export interface CapabilityLiveTurnResult {
  turnId: string;
  status: "completed" | "failed" | "interrupted" | "cancelled";
  assistantText: string;
  snapshot: CapabilityLiveSessionSnapshot;
}

export interface CapabilityLiveToolInvocationResult {
  turnId: string;
  result: CapabilitySemanticToolResult;
  snapshot: CapabilityLiveSessionSnapshot;
}

/**
 * Live turn events (track 7Q).
 *
 * A turn used to be observable only through its resolved result, so everything
 * downstream — the package server, the browser — could do nothing but wait.
 * These events expose the same work as it happens without changing what the
 * turn finally assembles: `assistantText` on a `delta` event is the running
 * value of the very buffer `sendMessage` resolves with, not a parallel copy.
 *
 * The stream is ordered by `seq` (monotonic per session, from 1) and bounded:
 * a turn emits at most `CAPABILITY_LIVE_TURN_EVENT_LIMIT` events, after which only
 * terminal and error events are delivered. A pathological provider can make a
 * turn long; it cannot make the event stream unbounded.
 */
export type CapabilityLiveTurnEvent =
  | {
      seq: number;
      at: string;
      turnId: string | null;
      kind: "delta";
      /** Assembled assistant text so far — monotonic within one agent message. */
      assistantText: string;
    }
  | {
      seq: number;
      at: string;
      turnId: string | null;
      kind: "activity";
      /** `turn_started`, `tool_call`, `tool_result`, or `stop_requested`. */
      reason: string;
    }
  | {
      seq: number;
      at: string;
      turnId: string | null;
      kind: "usage";
      /** Current provider-reported usage for the active turn. */
      usage: {
        providerRequests: number;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        reasoningTokens: number;
        costNanodollars: number;
      };
    }
  | {
      seq: number;
      at: string;
      turnId: string | null;
      kind: "terminal";
      status: CapabilityLiveTurnResult["status"];
      assistantText: string;
    }
  | {
      seq: number;
      at: string;
      turnId: string | null;
      kind: "error";
      message: string;
    };

export type CapabilityLiveTurnListener = (event: CapabilityLiveTurnEvent) => void;

type CapabilityLiveUsageMeasurement = Extract<
  CapabilityLiveTurnEvent,
  { kind: "usage" }
>["usage"];

interface CapabilityLiveTurnUsageObservations {
  reported: { usage: CapabilityLiveUsageMeasurement; exactDelta: boolean } | null;
  raw: CapabilityLiveUsageMeasurement | null;
  terminal: CapabilityLiveUsageMeasurement | null;
}

/** Distributive `Omit`, so each event variant keeps its own discriminated shape. */
type CapabilityLiveTurnEventInput = CapabilityLiveTurnEvent extends infer Variant
  ? Variant extends CapabilityLiveTurnEvent
    ? Omit<Variant, "seq" | "at">
    : never
  : never;

/** Bound on interim events per turn; terminal and error always get through. */
export const CAPABILITY_LIVE_TURN_EVENT_LIMIT = 4_000;
/** Separate bound so provider usage cannot be starved by delta/activity traffic. */
const CAPABILITY_LIVE_USAGE_EVENT_LIMIT = 512;

export interface CapabilityInteractionResolution {
  interactionId: string;
  outcome: "answered" | "accepted" | "rejected" | "expired";
  result: CapabilityJsonValue;
}

export interface CapabilityLiveSessionStore {
  load(sessionId: string): Promise<CapabilityLiveSessionSnapshot | null>;
  save(snapshot: CapabilityLiveSessionSnapshot): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export class InMemoryCapabilityLiveSessionStore implements CapabilityLiveSessionStore {
  readonly #snapshots = new Map<string, CapabilityLiveSessionSnapshot>();

  async load(sessionId: string): Promise<CapabilityLiveSessionSnapshot | null> {
    const snapshot = this.#snapshots.get(sessionId);
    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  async save(snapshot: CapabilityLiveSessionSnapshot): Promise<void> {
    this.#snapshots.set(snapshot.sessionId, structuredClone(snapshot));
  }

  async delete(sessionId: string): Promise<void> {
    this.#snapshots.delete(sessionId);
  }
}

export type CapabilityLiveTransportFactory = (
  options: CapabilityRunnerdCodexTransportOptions,
) => CapabilityRunnerdCodexTransport;

export interface CapabilityLiveSessionServiceOptions {
  store?: CapabilityLiveSessionStore;
  transportFactory?: CapabilityLiveTransportFactory;
  transportOptions?: CapabilityRunnerdCodexTransportOptions;
  now?: () => Date;
}

interface TurnWaiter {
  resolve: (result: Omit<CapabilityLiveTurnResult, "snapshot">) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  assistantText: string;
  /**
   * Transcript entry the assistant reply is being written into while the turn
   * runs, or `null` before the first delta. Streaming into a real transcript
   * entry rather than a side buffer is what lets one rendered card grow: the
   * projection sees the same entry id from the first delta to the last.
   */
  draftId: string | null;
}

interface PendingTurnCompletion {
  waiter: TurnWaiter | null;
  result: Omit<CapabilityLiveTurnResult, "snapshot">;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function jsonValue(value: unknown): CapabilityJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as CapabilityJsonValue;
}

function nonNegativeInteger(value: number | undefined, name: string): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`capability_live_usage_${name}_invalid`);
  }
  return normalized;
}

function requireNonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new Error(`capability_live_${name}_required`);
  return value;
}

function providerTurnStatus(value: unknown): CapabilityLiveTurnResult["status"] | null {
  const status = text(value).toLowerCase();
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  return null;
}

/** Reject malformed or partially written checkpoints before any provider process starts. */
export function assertCapabilityLiveSessionSnapshot(
  value: unknown,
): asserts value is CapabilityLiveSessionSnapshot {
  const snapshot = record(value);
  if (snapshot.schema !== LIVE_SESSION_SCHEMA) {
    throw new Error("capability_live_checkpoint_corrupt: unsupported snapshot schema");
  }
  for (const name of ["sessionId", "providerThreadId", "mockState", "createdAt", "updatedAt"] as const) {
    if (text(snapshot[name]).length === 0) {
      throw new Error(`capability_live_checkpoint_corrupt: missing ${name}`);
    }
  }
  if (!Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 1) {
    throw new Error("capability_live_checkpoint_corrupt: invalid revision");
  }
  const authority = record(snapshot.authority);
  for (const name of ["runId", "companyId", "actorId", "taskId", "sessionId"] as const) {
    if (text(authority[name]).length === 0) {
      throw new Error(`capability_live_checkpoint_corrupt: missing authority.${name}`);
    }
  }
  if (authority.sessionId !== snapshot.sessionId) {
    throw new Error("capability_live_checkpoint_binding_mismatch");
  }
  if (snapshot.providerRunBinding !== undefined) {
    const binding = record(snapshot.providerRunBinding);
    for (const name of ["runId", "turnId", "itemId"] as const) {
      if (text(binding[name]).length === 0) {
        throw new Error(`capability_live_checkpoint_corrupt: missing providerRunBinding.${name}`);
      }
    }
  }
  const config = record(snapshot.config);
  const persistedProvider = config.provider;
  if (
    persistedProvider !== undefined &&
    persistedProvider !== "codex" &&
    persistedProvider !== "opencode" &&
    persistedProvider !== "claude_managed"
    && persistedProvider !== "aws_agentcore"
    && persistedProvider !== "acpx"
  ) {
    throw new Error("capability_live_checkpoint_corrupt: invalid config.provider");
  }
  const provider = persistedProvider ?? "codex";
  const expectedDriver = provider === "opencode"
    ? "opencode_server"
    : provider === "claude_managed" ? "claude_managed_agents_api"
    : provider === "aws_agentcore" ? "aws_agentcore_harness_api"
    : provider === "acpx" ? "acpx_runtime" : "codex_app_server";
  if (config.driver !== undefined && config.driver !== expectedDriver) {
    throw new Error("capability_live_checkpoint_corrupt: provider/driver mismatch");
  }
  if (persistedProvider !== undefined && config.driver === undefined) {
    throw new Error("capability_live_checkpoint_corrupt: missing config.driver");
  }
  if (config.requestedModel !== undefined) {
    const requestedModel = text(config.requestedModel);
    if (requestedModel.trim().length === 0) {
      throw new Error("capability_live_checkpoint_corrupt: invalid config.requestedModel");
    }
    if (provider === "opencode" && !requestedModel.includes("/")) {
      throw new Error("capability_live_checkpoint_corrupt: invalid OpenCode model");
    }
  } else if (provider === "opencode" || provider === "claude_managed" || provider === "aws_agentcore" || provider === "acpx") {
    throw new Error(`capability_live_checkpoint_corrupt: missing ${provider === "opencode" ? "OpenCode" : provider === "claude_managed" ? "Claude Agent" : provider === "aws_agentcore" ? "AWS AgentCore" : "ACPX"} model`);
  }
  if (provider === "acpx") {
    const agent = config.acpxAgent;
    if (agent !== "pi" && agent !== "claude" && agent !== "codex") {
      throw new Error("capability_live_checkpoint_corrupt: invalid config.acpxAgent");
    }
    const expected = resolveQualifiedAcpxProfile(agent, text(config.requestedModel));
    if (JSON.stringify(record(config.acpxProfile)) !== JSON.stringify(expected)) {
      throw new Error("capability_live_checkpoint_corrupt: ACPX profile drift");
    }
  }
  if (provider === "claude_managed") {
    const profile = record(config.managedProfile);
    for (const field of ["profileId", "anthropicAgentId", "agentVersion", "environmentId"] as const) {
      if (text(profile[field]).trim().length === 0) {
        throw new Error(`capability_live_checkpoint_corrupt: missing managedProfile.${field}`);
      }
    }
    if (profile.betaVersion !== "managed-agents-2026-04-01") {
      throw new Error("capability_live_checkpoint_corrupt: invalid Managed Agents beta version");
    }
    if (typeof profile.maxSessionListCostUsd !== "number" || profile.maxSessionListCostUsd <= 0) {
      throw new Error("capability_live_checkpoint_corrupt: invalid managed session spend ceiling");
    }
  }
  if (provider === "aws_agentcore") {
    const profile = record(config.agentCoreProfile);
    for (const field of ["profileId", "region", "accountId", "harnessArn", "harnessVersion", "endpointArn", "endpointQualifier", "agentRuntimeArn", "memoryArn", "memoryId", "invocationRoleArn", "contextBucket", "contextPrefix", "contextKmsKeyArn", "qualificationRevision"] as const) {
      if (text(profile[field]).trim().length === 0) {
        throw new Error(`capability_live_checkpoint_corrupt: missing agentCoreProfile.${field}`);
      }
    }
    if (profile.eventExpiryDays !== 90) throw new Error("capability_live_checkpoint_corrupt: invalid AgentCore Memory expiry");
    for (const field of ["maxIterations", "maxOutputTokens", "timeoutSeconds"] as const) {
      if (!Number.isSafeInteger(profile[field]) || Number(profile[field]) <= 0) {
        throw new Error(`capability_live_checkpoint_corrupt: invalid agentCoreProfile.${field}`);
      }
    }
  }
  if (
    config.providerVersion !== undefined &&
    config.providerVersion !== null &&
    (typeof config.providerVersion !== "string" || config.providerVersion.trim().length === 0)
  ) {
    throw new Error("capability_live_checkpoint_corrupt: invalid config.providerVersion");
  }
  if (config.lifecyclePolicy !== undefined) {
    const lifecyclePolicy = record(config.lifecyclePolicy);
    if (lifecyclePolicy.mode === "per_turn") {
      if (lifecyclePolicy.idleTimeoutMs !== null) {
        throw new Error("capability_live_checkpoint_corrupt: per-turn idle timeout must be null");
      }
    } else if (
      lifecyclePolicy.mode !== "warm"
      || !Number.isSafeInteger(lifecyclePolicy.idleTimeoutMs)
      || Number(lifecyclePolicy.idleTimeoutMs) <= 0
    ) {
      throw new Error("capability_live_checkpoint_corrupt: invalid lifecycle policy");
    }
  }
  if (typeof snapshot.mockState !== "string") {
    throw new Error("capability_live_checkpoint_corrupt: invalid mockState");
  }
  try {
    JSON.parse(snapshot.mockState);
  } catch {
    throw new Error("capability_live_checkpoint_corrupt: invalid mockState JSON");
  }
  if (snapshot.attempts !== undefined && !Array.isArray(snapshot.attempts)) {
    throw new Error("capability_live_checkpoint_corrupt: invalid attempts");
  }
  const attemptIds = new Set<string>();
  for (const value of snapshot.attempts ?? []) {
    const attempt = record(value);
    const attemptId = text(attempt.attemptId);
    if (
      attemptId.length === 0 ||
      attemptIds.has(attemptId) ||
      !["running", "succeeded", "failed", "terminated"].includes(text(attempt.status)) ||
      text(attempt.startedAt).length === 0
    ) {
      throw new Error("capability_live_checkpoint_corrupt: invalid attempt");
    }
    const resumeOf = attempt.resumeOf === null ? null : text(attempt.resumeOf);
    if (resumeOf !== null && !attemptIds.has(resumeOf)) {
      throw new Error("capability_live_checkpoint_corrupt: invalid attempt lineage");
    }
    attemptIds.add(attemptId);
  }
  if (
    snapshot.currentAttemptId !== undefined &&
    !attemptIds.has(text(snapshot.currentAttemptId))
  ) {
    throw new Error("capability_live_checkpoint_corrupt: invalid current attempt");
  }
  if (snapshot.terminalTurns !== undefined && !Array.isArray(snapshot.terminalTurns)) {
    throw new Error("capability_live_checkpoint_corrupt: invalid terminalTurns");
  }
  const terminalTurnIds = new Set<string>();
  for (const value of snapshot.terminalTurns ?? []) {
    const terminal = record(value);
    const turnId = text(terminal.turnId);
    if (
      turnId.length === 0 ||
      terminalTurnIds.has(turnId) ||
      !["completed", "failed", "interrupted", "cancelled"].includes(text(terminal.status)) ||
      text(terminal.reconciledByAttemptId).length === 0 ||
      text(terminal.observedAt).length === 0
    ) {
      throw new Error("capability_live_checkpoint_corrupt: invalid terminal fact");
    }
    terminalTurnIds.add(turnId);
  }
  if (snapshot.usageLedger !== undefined && !Array.isArray(snapshot.usageLedger)) {
    throw new Error("capability_live_checkpoint_corrupt: invalid usageLedger");
  }
  const usageReceiptIds = new Set<string>();
  for (const value of snapshot.usageLedger ?? []) {
    const receipt = record(value);
    const receiptId = text(receipt.receiptId);
    if (
      receiptId.length === 0 ||
      usageReceiptIds.has(receiptId) ||
      text(receipt.attemptId).length === 0 ||
      text(receipt.observedAt).length === 0
    ) {
      throw new Error("capability_live_checkpoint_corrupt: invalid usage receipt");
    }
    for (const name of [
      "providerCalls",
      "providerRequests",
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "reasoningTokens",
      "costNanodollars",
    ] as const) {
      if (!Number.isSafeInteger(receipt[name]) || Number(receipt[name]) < 0) {
        throw new Error("capability_live_checkpoint_corrupt: invalid usage receipt");
      }
    }
    usageReceiptIds.add(receiptId);
  }
  if (
    snapshot.stateHistory !== undefined &&
    (!Array.isArray(snapshot.stateHistory) || snapshot.stateHistory.length > 256)
  ) {
    throw new Error("capability_live_checkpoint_corrupt: invalid stateHistory");
  }
  for (const value of snapshot.stateHistory ?? []) {
    const revision = record(value);
    if (
      !Number.isSafeInteger(revision.revision) ||
      Number(revision.revision) < 0 ||
      text(revision.at).length === 0 ||
      text(revision.operationId).length === 0 ||
      (revision.turnId !== null && typeof revision.turnId !== "string") ||
      typeof revision.state !== "string"
    ) {
      throw new Error("capability_live_checkpoint_corrupt: invalid state revision");
    }
    try {
      JSON.parse(revision.state);
    } catch {
      throw new Error("capability_live_checkpoint_corrupt: invalid state revision JSON");
    }
  }
}

export function reconcileCapabilityLiveUsage(
  snapshot: CapabilityLiveSessionSnapshot,
): Omit<CapabilityLiveUsageReceipt, "receiptId" | "attemptId" | "providerResponseId" | "turnId" | "observedAt"> {
  const unique = new Map((snapshot.usageLedger ?? []).map((receipt) => [receipt.receiptId, receipt]));
  return [...unique.values()].reduce((total, receipt) => ({
    providerCalls: total.providerCalls + receipt.providerCalls,
    providerRequests: total.providerRequests + receipt.providerRequests,
    inputTokens: total.inputTokens + receipt.inputTokens,
    outputTokens: total.outputTokens + receipt.outputTokens,
    cachedInputTokens: total.cachedInputTokens + receipt.cachedInputTokens,
    reasoningTokens: total.reasoningTokens + receipt.reasoningTokens,
    costNanodollars: total.costNanodollars + receipt.costNanodollars,
  }), {
    providerCalls: 0,
    providerRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    costNanodollars: 0,
  });
}

function dynamicToolSpec(definition: CapabilitySemanticToolDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  };
}

function discoveryToolSpecs(): Record<string, unknown>[] {
  return CAPABILITY_DISCOVERY_GATEWAY_DEFINITIONS.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema,
  }));
}

function userInput(message: string): Record<string, unknown> {
  return { type: "text", text: message, text_elements: [] };
}

function terminalStatus(value: unknown): CapabilityLiveTurnResult["status"] {
  const status = text(value, "completed");
  return status === "failed" || status === "interrupted" || status === "cancelled"
    ? status
    : "completed";
}

function pendingInteractions(port: CapabilityMockControlPlaneAdapter): CapabilityFixtureInteraction[] {
  return port.snapshot().interactions.filter((interaction) => interaction.status === "pending");
}

export class CapabilityLiveSessionService {
  readonly #store: CapabilityLiveSessionStore;
  readonly #transportFactory: CapabilityLiveTransportFactory;
  readonly #transportOptions: CapabilityRunnerdCodexTransportOptions;
  readonly #now: () => Date;
  readonly #sessions = new Map<string, CapabilityLiveSession>();

  constructor(options: CapabilityLiveSessionServiceOptions = {}) {
    this.#store = options.store ?? new InMemoryCapabilityLiveSessionStore();
    this.#transportFactory = options.transportFactory ?? createCapabilityRunnerdCodexTransport;
    this.#transportOptions = options.transportOptions ?? {};
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: CreateCapabilityLiveSessionInput = {}): Promise<CapabilityLiveSession> {
    if (input.provider === "acpx" && input.acpxAgent === "pi") {
      throw new Error("The Pi ACPX profile is not available");
    }
    if (input.provider === "claude_managed" && !input.managedProfile) {
      throw new Error("Claude Managed live sessions require a qualified managed profile");
    }
    if (input.provider === "aws_agentcore" && !input.agentCoreProfile) {
      throw new Error("AWS AgentCore live sessions require a qualified AgentCore profile");
    }
    if (
      (input.provider === "claude_managed" || input.provider === "aws_agentcore") &&
      !input.requestedModel?.trim()
    ) {
      throw new Error("Managed live sessions require an explicit qualified model");
    }
    const port = new CapabilityMockControlPlaneAdapter(input.seed);
    const seedState = port.serialize();
    await port.start();
    const state = port.snapshot();
    const sessionId = input.sessionId ?? randomUUID();
    const runId = input.runId ?? randomUUID();
    const acpxProfile = input.provider === "acpx"
      ? resolveQualifiedAcpxProfile(input.acpxAgent ?? "codex", requireNonEmpty(input.requestedModel ?? "", "requested_model"))
      : null;
    const capabilities = [...(input.capabilities ?? [])];
    const scenario = input.scenario ?? { id: "capability-live-default" };
    const authority: CapabilityLiveAuthoritySnapshot = {
      active: true,
      runId,
      companyId: input.companyId ?? state.company.id,
      actorId: input.actorId ?? state.actors[0]!.id,
      taskId: input.taskId ?? state.tasks[0]!.id,
      sessionId,
      scenarioId: scenario.id,
      capabilities,
      explicitClaims: [...(input.explicitClaims ?? capabilities)],
    };
    await port.openFixtureRun({
      identity: {
        runId,
        sessionId,
        companyId: authority.companyId,
        issueId: authority.taskId,
        agentId: authority.actorId,
      },
      backendKind: "runner",
      sourceInstanceId: "capability-live-runnerd",
      capabilities,
    });
    const session = await CapabilityLiveSession.open({
      port,
      authority,
      config: {
        workingDirectory: input.workingDirectory ?? process.cwd(),
        provider: input.provider ?? "codex",
        driver: input.provider === "opencode"
          ? "opencode_server"
          : input.provider === "claude_managed"
            ? "claude_managed_agents_api"
            : input.provider === "aws_agentcore"
              ? "aws_agentcore_harness_api"
          : input.provider === "acpx" ? "acpx_runtime" : "codex_app_server",
        providerVersion: input.provider === "opencode"
          ? "1.18.17"
          : input.provider === "claude_managed"
            ? input.managedProfile!.betaVersion
            : input.provider === "aws_agentcore"
              ? input.agentCoreProfile!.qualificationRevision
          : input.provider === "acpx" ? acpxProfile!.acpxVersion : null,
        ...(acpxProfile === null ? {} : {
          acpxAgent: acpxProfile.agent,
          acpxProfile: structuredClone(acpxProfile),
        }),
        ...(input.managedProfile === undefined
          ? {}
          : { managedProfile: structuredClone(input.managedProfile) }),
        ...(input.agentCoreProfile === undefined
          ? {}
          : { agentCoreProfile: structuredClone(input.agentCoreProfile) }),
        ...(input.requestedModel === undefined
          ? {}
          : { requestedModel: requireNonEmpty(input.requestedModel, "requested_model") }),
        scenario,
        capabilities,
        explicitClaims: authority.explicitClaims,
        seedState,
        turnTimeoutMs: input.turnTimeoutMs ?? 120_000,
        lifecyclePolicy: input.lifecyclePolicy ?? { mode: "warm", idleTimeoutMs: 300_000 },
        toolExposure: input.toolExposure ?? "eager",
      },
      store: this.#store,
      transportFactory: this.#transportFactory,
      transportOptions: this.#transportOptions,
      now: this.#now,
      attemptId: input.attemptId ?? runId,
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  async restore(sessionId: string): Promise<CapabilityLiveSession> {
    const live = this.#sessions.get(sessionId);
    if (live !== undefined) return live;
    const snapshot = await this.#store.load(sessionId);
    if (snapshot === null) throw new Error(`capability live session ${sessionId} was not found`);
    assertCapabilityLiveSessionSnapshot(snapshot);
    const session = await CapabilityLiveSession.restore({
      snapshot,
      store: this.#store,
      transportFactory: this.#transportFactory,
      transportOptions: this.#transportOptions,
      now: this.#now,
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  /**
   * Production worker-restart entrypoint. It records the killed attempt and its
   * successor durably before runnerd/Codex is started, then restores only the
   * provider thread named by that checkpoint.
   */
  async resume(input: ResumeCapabilityLiveSessionInput): Promise<CapabilityLiveSession> {
    requireNonEmpty(input.attemptId, "attempt_id");
    requireNonEmpty(input.resumeOf, "resume_of");
    if (input.attemptId === input.resumeOf) throw new Error("capability_live_resume_cycle");
    if (this.#sessions.has(input.sessionId)) {
      throw new Error("capability_live_resume_requires_new_worker");
    }
    const snapshot = await this.#store.load(input.sessionId);
    if (snapshot === null) {
      throw new Error("capability_live_resume_checkpoint_missing: refusing to open a second provider session");
    }
    assertCapabilityLiveSessionSnapshot(snapshot);
    const attempts = structuredClone(snapshot.attempts ?? [{
      attemptId: snapshot.authority.runId,
      resumeOf: null,
      status: "running" as const,
      startedAt: snapshot.createdAt,
      finishedAt: null,
      failureCode: null,
    }]);
    const currentAttemptId = snapshot.currentAttemptId ?? attempts.at(-1)?.attemptId;
    if (currentAttemptId !== input.resumeOf) throw new Error("capability_live_resume_binding_mismatch");
    if (attempts.some((attempt) => attempt.attemptId === input.attemptId)) {
      throw new Error("capability_live_resume_attempt_exists");
    }
    const previous = attempts.find((attempt) => attempt.attemptId === input.resumeOf);
    if (previous === undefined || previous.status !== "running") {
      throw new Error("capability_live_resume_source_not_running");
    }
    const resumedAt = this.#now().toISOString();
    previous.status = "terminated";
    previous.finishedAt = resumedAt;
    previous.failureCode = "worker_terminated";
    attempts.push({
      attemptId: input.attemptId,
      resumeOf: input.resumeOf,
      status: "running",
      startedAt: resumedAt,
      finishedAt: null,
      failureCode: null,
    });
    const prepared: CapabilityLiveSessionSnapshot = {
      ...snapshot,
      revision: snapshot.revision + 1,
      updatedAt: resumedAt,
      status: "starting",
      attempts,
      currentAttemptId: input.attemptId,
      ...(input.turnTimeoutMs === undefined ? {} : {
        config: { ...snapshot.config, turnTimeoutMs: input.turnTimeoutMs },
      }),
    };
    await this.#store.save(prepared);
    try {
      const session = await CapabilityLiveSession.restore({
        snapshot: prepared,
        store: this.#store,
        transportFactory: this.#transportFactory,
        transportOptions: this.#transportOptions,
        now: this.#now,
      });
      this.#sessions.set(session.id, session);
      return session;
    } catch (error) {
      const failedAt = this.#now().toISOString();
      const latest = await this.#store.load(input.sessionId) ?? prepared;
      const failedAttempts = structuredClone(latest.attempts ?? []);
      const failed = failedAttempts.find((attempt) => attempt.attemptId === input.attemptId);
      if (failed !== undefined) {
        failed.status = "failed";
        failed.finishedAt = failedAt;
        failed.failureCode = "provider_recovery_failed";
      }
      await this.#store.save({
        ...latest,
        revision: latest.revision + 1,
        updatedAt: failedAt,
        status: "failed",
        attempts: failedAttempts,
      });
      throw error;
    }
  }

  async reconnect(sessionId: string): Promise<CapabilityLiveSessionSnapshot> {
    const session = await this.restore(sessionId);
    await session.reconnect();
    return session.snapshot();
  }

  async reset(sessionId: string): Promise<CapabilityLiveSession> {
    const session = await this.restore(sessionId);
    const config = session.snapshot().config;
    // Reset starts a distinct governed chat, but the prior chat is an archive,
    // not disposable state.  Suspending preserves its provider checkpoint and
    // authority binding so selecting it from history can restore it safely.
    await session.suspend("reset archived prior session");
    const seedPort = CapabilityMockControlPlaneAdapter.restore(config.seedState);
    return this.create({
      seed: seedPort.snapshot(),
      workingDirectory: config.workingDirectory,
      provider: config.provider ?? "codex",
      ...(config.requestedModel === undefined ? {} : { requestedModel: config.requestedModel }),
      ...(config.managedProfile === undefined
        ? {}
        : { managedProfile: config.managedProfile }),
      ...(config.agentCoreProfile === undefined
        ? {}
        : { agentCoreProfile: config.agentCoreProfile }),
      scenario: config.scenario,
      capabilities: config.capabilities,
      explicitClaims: config.explicitClaims,
      turnTimeoutMs: config.turnTimeoutMs,
      lifecyclePolicy: config.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
      toolExposure: config.toolExposure ?? "eager",
    });
  }

  async stop(sessionId: string, reason = "operator stopped session"): Promise<CapabilityLiveSessionSnapshot> {
    const session = await this.restore(sessionId);
    await session.suspend(reason);
    return session.snapshot();
  }

  async shutdown(sessionId: string, reason = "service shutdown"): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return;
    await session.suspend(reason);
  }
}

interface OpenSessionOptions {
  port: CapabilityMockControlPlaneAdapter;
  authority: CapabilityLiveAuthoritySnapshot;
  config: CapabilityLiveSessionConfigSnapshot;
  store: CapabilityLiveSessionStore;
  transportFactory: CapabilityLiveTransportFactory;
  transportOptions: CapabilityRunnerdCodexTransportOptions;
  now: () => Date;
  attemptId: string;
}

interface RestoreSessionOptions extends Omit<OpenSessionOptions, "port" | "authority" | "config" | "attemptId"> {
  snapshot: CapabilityLiveSessionSnapshot;
}

export class CapabilityLiveSession {
  readonly #port: CapabilityMockControlPlaneAdapter;
  readonly #dispatcher: CapabilitySemanticDispatcher;
  readonly #store: CapabilityLiveSessionStore;
  readonly #transportFactory: CapabilityLiveTransportFactory;
  readonly #transportOptions: CapabilityRunnerdCodexTransportOptions;
  readonly #now: () => Date;
  readonly #authority: CapabilityLiveAuthoritySnapshot;
  readonly #config: CapabilityLiveSessionConfigSnapshot;
  readonly #createdAt: string;
  readonly #transcript: CapabilityLiveTranscriptEntry[];
  readonly #evidence: CapabilityLiveEvidenceEntry[];
  readonly #priorAuthorizationRecords: CapabilitySemanticAuthorizationRecord[];
  readonly #attempts: CapabilityLiveAttemptSnapshot[];
  readonly #terminalTurns: CapabilityLiveTurnTerminalFact[];
  readonly #usageLedger: CapabilityLiveUsageReceipt[];
  readonly #stateHistory: CapabilityLiveStateRevision[];
  readonly #workspaceDiffs: CapabilityLiveWorkspaceDiffEntry[];
  readonly #workspaceFileReferences: CapabilityLiveWorkspaceFileReferenceEntry[];
  #currentAttemptId: string;
  #transport: CodexAppServerTransport | null = null;
  #processEvidence: CapabilityRunnerdProcessEvidence | null = null;
  #providerThreadId = "";
  #providerSessionId: string | null = null;
  #providerModel: { id: string; provider: string } | undefined;
  #status: CapabilityLiveSessionStatus = "starting";
  #activeTurnId: string | null = null;
  #providerRunBinding: { runId: string; turnId: string; itemId: string } | null;
  #revision = 0;
  #updatedAt: string;
  #entryCounter = 0;
  #turnWaiter: TurnWaiter | null = null;
  #pump: Promise<void> | null = null;
  #persistChain: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<CapabilityLiveTurnListener>();
  #eventSeq = 0;
  #turnEventCount = 0;
  #turnUsageEventCount = 0;
  readonly #usageObservationsByTurn = new Map<string, CapabilityLiveTurnUsageObservations>();
  #latestCumulativeUsage: Record<string, unknown> = {};
  #idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #loadedOperationIds = new Set<string>();

  private constructor(options: OpenSessionOptions & { snapshot?: CapabilityLiveSessionSnapshot }) {
    this.#port = options.port;
    this.#authority = structuredClone(options.authority);
    this.#config = structuredClone(options.config);
    this.#store = options.store;
    this.#transportFactory = options.transportFactory;
    this.#transportOptions = options.transportOptions;
    this.#now = options.now;
    this.#dispatcher = new CapabilitySemanticDispatcher(this.#port, {
      scenario: this.#config.scenario,
      explicitClaims: this.#config.explicitClaims,
    });
    this.#createdAt = options.snapshot?.createdAt ?? this.#now().toISOString();
    this.#updatedAt = options.snapshot?.updatedAt ?? this.#createdAt;
    this.#transcript = structuredClone(options.snapshot?.transcript ?? []);
    this.#evidence = structuredClone(options.snapshot?.evidence ?? []);
    this.#priorAuthorizationRecords = structuredClone(options.snapshot?.authorizationRecords ?? []);
    const initialAttemptId = options.snapshot?.currentAttemptId ?? options.attemptId;
    this.#attempts = structuredClone(options.snapshot?.attempts ?? [{
      attemptId: initialAttemptId,
      resumeOf: null,
      status: "running",
      startedAt: this.#createdAt,
      finishedAt: null,
      failureCode: null,
    }]);
    this.#currentAttemptId = initialAttemptId;
    this.#terminalTurns = structuredClone(options.snapshot?.terminalTurns ?? []);
    this.#usageLedger = structuredClone(options.snapshot?.usageLedger ?? []);
    this.#stateHistory = structuredClone(options.snapshot?.stateHistory ?? [{
      revision: this.#port.snapshot().revision,
      at: this.#createdAt,
      turnId: null,
      operationId: "session.open",
      state: this.#port.serialize(),
    }]);
    this.#workspaceDiffs = structuredClone(options.snapshot?.workspaceDiffs ?? []);
    this.#workspaceFileReferences = structuredClone(options.snapshot?.workspaceFileReferences ?? []);
    for (const operationId of options.snapshot?.loadedOperationIds ?? []) this.#loadedOperationIds.add(operationId);
    this.#providerThreadId = options.snapshot?.providerThreadId ?? "";
    this.#providerSessionId = options.snapshot?.providerSessionId ?? null;
    this.#providerModel = options.snapshot?.providerModel === undefined
      ? undefined
      : structuredClone(options.snapshot.providerModel);
    this.#activeTurnId = options.snapshot?.activeTurnId ?? null;
    this.#providerRunBinding = options.snapshot?.providerRunBinding === undefined
      ? null
      : structuredClone(options.snapshot.providerRunBinding);
    this.#revision = options.snapshot?.revision ?? 0;
    this.#entryCounter = this.#transcript.length + this.#evidence.length;
  }

  static async open(options: OpenSessionOptions): Promise<CapabilityLiveSession> {
    const session = new CapabilityLiveSession(options);
    try {
      await session.#connect(false);
    } catch (error) {
      await session.#abortConnect("initial provider connection failed");
      throw error;
    }
    return session;
  }

  static async restore(options: RestoreSessionOptions): Promise<CapabilityLiveSession> {
    if (options.snapshot.schema !== LIVE_SESSION_SCHEMA) {
      throw new Error("unsupported Capability live session snapshot");
    }
    if (!options.snapshot.authority.active) {
      throw new Error("capability session authority was cleared and cannot be resumed");
    }
    const port = CapabilityMockControlPlaneAdapter.restore(options.snapshot.mockState);
    if (port.snapshot().lifecycle !== "running") await port.start();
    const session = new CapabilityLiveSession({
      ...options,
      port,
      authority: options.snapshot.authority,
      config: options.snapshot.config,
      snapshot: options.snapshot,
      attemptId: options.snapshot.currentAttemptId ?? options.snapshot.authority.runId,
    });
    try {
      await session.#connect(true);
    } catch (error) {
      await session.#abortConnect("provider recovery failed");
      throw error;
    }
    return session;
  }

  get id(): string {
    return this.#authority.sessionId;
  }

  mockState() {
    return this.#port.snapshot();
  }

  pendingInteractions(): CapabilityFixtureInteraction[] {
    return structuredClone(pendingInteractions(this.#port));
  }

  /**
   * Observe live turn events. Returns the unsubscribe function; a listener that
   * throws is dropped rather than allowed to break the provider pump, because a
   * broken consumer must not be able to stall or fail the turn it is watching.
   */
  subscribe(listener: CapabilityLiveTurnListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(event: CapabilityLiveTurnEventInput): void {
    if (event.kind === "usage") {
      if (this.#turnUsageEventCount >= CAPABILITY_LIVE_USAGE_EVENT_LIMIT) return;
      this.#turnUsageEventCount += 1;
    } else if (event.kind === "delta" || event.kind === "activity") {
      if (this.#turnEventCount >= CAPABILITY_LIVE_TURN_EVENT_LIMIT) return;
      this.#turnEventCount += 1;
    }
    this.#eventSeq += 1;
    const published = {
      ...event,
      seq: this.#eventSeq,
      at: this.#now().toISOString(),
    } as CapabilityLiveTurnEvent;
    for (const listener of [...this.#listeners]) {
      try {
        listener(published);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }

  /**
   * Mirrors the turn waiter's assembled text into its transcript draft. The
   * waiter's buffer stays the single assembly point, so the draft can never
   * diverge from what the turn will finally resolve with.
   */
  #syncAssistantDraft(turnId: string | null): void {
    const waiter = this.#turnWaiter;
    if (waiter === null || waiter.assistantText.length === 0) return;
    if (waiter.draftId === null) {
      waiter.draftId = this.#appendTranscript("assistant", waiter.assistantText, turnId);
      return;
    }
    const draft = this.#transcript.find((entry) => entry.id === waiter.draftId);
    if (draft === undefined) return;
    draft.text = waiter.assistantText;
    if (draft.turnId === null && turnId !== null) draft.turnId = turnId;
  }

  /**
   * Settles the streamed draft against the authoritative final text. An
   * interrupted turn keeps whatever it had streamed; a turn that produced
   * nothing leaves no empty card behind.
   */
  #settleAssistantDraft(waiter: TurnWaiter, assistantText: string, turnId: string): void {
    const index =
      waiter.draftId === null
        ? -1
        : this.#transcript.findIndex((entry) => entry.id === waiter.draftId);
    if (index < 0) {
      if (assistantText.length > 0) this.#appendTranscript("assistant", assistantText, turnId);
      return;
    }
    if (assistantText.length === 0) {
      this.#transcript.splice(index, 1);
      return;
    }
    const draft = this.#transcript[index]!;
    draft.text = assistantText;
    draft.turnId = draft.turnId ?? turnId;
  }

  snapshot(): CapabilityLiveSessionSnapshot {
    const records = [
      ...this.#priorAuthorizationRecords,
      ...this.#dispatcher.authorizationRecords(),
    ];
    const childKeys = this.#processEvidence?.childEnvironmentKeys ?? [];
    return {
      schema: LIVE_SESSION_SCHEMA,
      revision: this.#revision,
      sessionId: this.id,
      providerThreadId: this.#providerThreadId,
      providerSessionId: this.#providerSessionId,
      ...(this.#providerModel === undefined
        ? {}
        : { providerModel: structuredClone(this.#providerModel) }),
      status: this.#status,
      activeTurnId: this.#activeTurnId,
      ...(this.#providerRunBinding === null
        ? {}
        : { providerRunBinding: structuredClone(this.#providerRunBinding) }),
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      authority: structuredClone(this.#authority),
      config: structuredClone(this.#config),
      mockState: this.#port.serialize(),
      transcript: structuredClone(this.#transcript),
      evidence: structuredClone(this.#evidence),
      authorizationRecords: structuredClone(records),
      process: this.#processEvidence === null ? null : structuredClone(this.#processEvidence),
      networkEvidence: {
        realPaperclipRequests: 0,
        childPaperclipEnvironmentKeys: childKeys.filter((key) => key.startsWith("PAPERCLIP_")),
      },
      attempts: structuredClone(this.#attempts),
      currentAttemptId: this.#currentAttemptId,
      terminalTurns: structuredClone(this.#terminalTurns),
      usageLedger: structuredClone(this.#usageLedger),
      stateHistory: structuredClone(this.#stateHistory),
      workspaceDiffs: structuredClone(this.#workspaceDiffs),
      workspaceFileReferences: structuredClone(this.#workspaceFileReferences),
      loadedOperationIds: [...this.#loadedOperationIds].sort(),
    };
  }

  async recordUsage(input: RecordCapabilityLiveUsageInput): Promise<"committed" | "duplicate"> {
    const receiptId = requireNonEmpty(input.receiptId, "usage_receipt_id");
    const receipt: CapabilityLiveUsageReceipt = {
      receiptId,
      attemptId: this.#currentAttemptId,
      providerResponseId: input.providerResponseId ?? null,
      turnId: input.turnId ?? this.#activeTurnId,
      providerCalls: nonNegativeInteger(input.providerCalls ?? 1, "provider_calls"),
      providerRequests: nonNegativeInteger(input.providerRequests, "provider_requests"),
      inputTokens: nonNegativeInteger(input.inputTokens, "input_tokens"),
      outputTokens: nonNegativeInteger(input.outputTokens, "output_tokens"),
      cachedInputTokens: nonNegativeInteger(input.cachedInputTokens, "cached_input_tokens"),
      reasoningTokens: nonNegativeInteger(input.reasoningTokens, "reasoning_tokens"),
      costNanodollars: nonNegativeInteger(input.costNanodollars, "cost_nanodollars"),
      observedAt: this.#now().toISOString(),
    };
    const existing = this.#usageLedger.find((candidate) => candidate.receiptId === receiptId);
    if (existing !== undefined) {
      const comparable = (value: CapabilityLiveUsageReceipt) => JSON.stringify({
        ...value,
        attemptId: undefined,
        observedAt: undefined,
      });
      if (comparable(existing) !== comparable(receipt)) {
        throw new Error("capability_live_usage_receipt_conflict");
      }
      return "duplicate";
    }
    this.#usageLedger.push(receipt);
    await this.#persist();
    return "committed";
  }

  async completeAttempt(
    status: Exclude<CapabilityLiveAttemptStatus, "running" | "terminated">,
    failureCode: string | null = null,
  ): Promise<CapabilityLiveSessionSnapshot> {
    const attempt = this.#attempts.find((candidate) => candidate.attemptId === this.#currentAttemptId);
    if (attempt === undefined || attempt.status !== "running") {
      throw new Error("capability_live_attempt_not_running");
    }
    if (status === "succeeded" && this.#activeTurnId !== null) {
      throw new Error("capability_live_attempt_active_turn");
    }
    attempt.status = status;
    attempt.finishedAt = this.#now().toISOString();
    attempt.failureCode = status === "failed"
      ? requireNonEmpty(failureCode ?? "attempt_failed", "attempt_failure_code")
      : null;
    await this.#persist();
    return this.snapshot();
  }

  async sendMessage(message: string): Promise<CapabilityLiveTurnResult> {
    const value = message.trim();
    if (value.length === 0) throw new Error("Capability live messages cannot be empty");
    if (this.#status === "suspended" || this.#transport === null) {
      await this.#connect(true);
    }
    if (this.#transport === null || this.#status === "closed" || this.#status === "failed") {
      throw new Error("Capability live session is not connected");
    }
    if (this.#activeTurnId !== null || this.#turnWaiter !== null) {
      throw new Error("Capability live session already has an active turn");
    }
    if (this.#terminalTurns.length > 0) {
      if (this.#transport.attachRun !== undefined) {
        const bindingId = randomUUID().replaceAll("-", "");
        const binding = {
          runId: `run_lab_${bindingId}`,
          turnId: `turn_lab_${bindingId}`,
          itemId: `item_lab_${bindingId}`,
        };
        await this.#transport.attachRun(binding);
        this.#providerRunBinding = binding;
        await this.#persist();
      }
      // A transport without cross-run attachment keeps subsequent provider
      // turns inside this capability session's existing governed run. This is
      // distinct from reusing the provider under a different PRP authority.
    }
    this.#status = "running";
    this.#clearIdleTimer();
    this.#turnEventCount = 0;
    this.#turnUsageEventCount = 0;
    // Start the baseline before admitting provider work, but do not make turn
    // interruption wait for a potentially large workspace walk. The provider
    // turn id is bound first; the terminal path waits for this baseline before
    // comparing the post-turn workspace.
    const workspaceBeforePromise = capturePaperclipWorkspace(this.#config.workingDirectory);
    // Held by id, not by position: a provider can start streaming before
    // `turn/start` resolves, in which case the assistant draft is already the
    // last transcript entry and the user message would never learn its turn.
    const userEntryId = this.#appendTranscript("user", value, null);
    let response: Record<string, unknown>;
    const terminal = this.#armTurnWaiter();
    // Workspace capture can outlive a deliberately tiny test timeout. Attach
    // a rejection observer immediately; the authoritative await below still
    // propagates the same error to the caller.
    void terminal.catch(() => undefined);
    try {
      response = await this.#transport.request("turn/start", {
        threadId: this.#providerThreadId,
        cwd: this.#config.workingDirectory,
        permissions: CODEX_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#config.workingDirectory],
        input: [userInput(value)],
      });
    } catch (error) {
      this.#rejectTurn(error);
      await terminal.catch(() => undefined);
      throw error;
    }
    const turnId = text(record(response.turn).id);
    if (turnId.length === 0) {
      this.#rejectTurn(new Error("Codex turn response omitted turn.id"));
      throw new Error("Codex turn response omitted turn.id");
    }
    if (this.#activeTurnId !== null && this.#activeTurnId !== turnId) {
      this.#rejectTurn(new Error("Codex turn identity changed during start"));
      throw new Error("Codex turn identity changed during start");
    }
    if (this.#turnWaiter !== null) this.#activeTurnId = turnId;
    const sent = this.#transcript.find((entry) => entry.id === userEntryId);
    if (sent !== undefined && sent.turnId === null) sent.turnId = turnId;
    const draftId = (this.#turnWaiter as TurnWaiter | null)?.draftId ?? null;
    const draft =
      draftId === null ? undefined : this.#transcript.find((entry) => entry.id === draftId);
    if (draft !== undefined && draft.turnId === null) draft.turnId = turnId;
    const workspaceBefore = await workspaceBeforePromise;
    await this.#persist();
    const result = await terminal;
    const workspaceFileReferences = await discoverPaperclipWorkspaceFileReferences(
      this.#config.workingDirectory,
      result.assistantText,
      result.turnId,
    );
    for (const reference of workspaceFileReferences) {
      this.#workspaceFileReferences.push({
        turnId: result.turnId,
        at: this.#now().toISOString(),
        reference: {
          ...reference,
          preview: reference.preview === null ? null : redactCodexDiagnostic(reference.preview),
        },
      });
    }
    const workspaceAfter = await capturePaperclipWorkspace(this.#config.workingDirectory);
    const workspaceDiff = diffPaperclipWorkspace(
      workspaceBefore,
      workspaceAfter,
      `${this.id}:${result.turnId}:workspace`,
    );
    if (workspaceDiff !== null) {
      this.#workspaceDiffs.push({
        turnId: result.turnId,
        at: this.#now().toISOString(),
        diff: {
          ...workspaceDiff,
          files: workspaceDiff.files.map((file) => ({
            ...file,
            diff: file.diff === null ? null : redactCodexDiagnostic(file.diff),
          })),
        },
      });
    }
    await this.#captureTurnUsage(result.turnId, result.status !== "completed");
    await this.#persist();
    await this.#afterTurnSettled();
    return { ...result, snapshot: this.snapshot() };
  }

  async #afterTurnSettled(): Promise<void> {
    const policy = this.#config.lifecyclePolicy ?? { mode: "per_turn" as const, idleTimeoutMs: null };
    if (policy.mode === "per_turn") {
      await this.suspend("per-turn lifecycle completed");
      return;
    }
    this.#status = this.pendingInteractions().length > 0 ? "waiting_input" : "warm_idle";
    this.#armIdleTimer(policy.idleTimeoutMs);
    await this.#persist();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer !== null) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  #armIdleTimer(timeoutMs: number): void {
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      void this.suspend("warm session idle timeout").catch((error) => {
        this.#appendEvidence("diagnostic", this.#activeTurnId, {
          message: redactCodexDiagnostic(String(error)),
        });
      });
    }, timeoutMs);
  }

  async #captureTurnUsage(turnId: string, allowEmpty = false): Promise<void> {
    if (this.#transport === null) throw new Error("capability_live_usage_transport_missing");
    const initial = this.#usageObservationsByTurn.get(turnId);
    // An explicit whole-turn delta is already complete. Other providers can
    // publish one or more rawResponse receipts after turn/completed, so retain
    // the full bounded grace period instead of committing the first partial
    // observation that happens to arrive.
    if (initial?.reported?.exactDelta !== true) {
      const usageDeadline = Date.now() + 500;
      while (Date.now() < usageDeadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    const captured = this.#usageObservationsByTurn.get(turnId);
    const reportedTokens = (captured?.reported?.usage.inputTokens ?? 0)
      + (captured?.reported?.usage.outputTokens ?? 0);
    const needsRead = captured === undefined || (
      captured.reported?.exactDelta !== true
      && captured.raw === null
      && captured.terminal === null
      && reportedTokens === 0
    );
    const read = needsRead ? await this.#transport.request("thread/read", {
      threadId: this.#providerThreadId,
      includeTurns: true,
    }) : {};
    const thread = record(read.thread);
    const usage = record(thread.tokenUsage ?? read.tokenUsage);
    const cumulativeNotification = Object.keys(this.#latestCumulativeUsage).length > 0
      ? this.#latestCumulativeUsage
      : undefined;
    const readTotal = usage.total ?? usage.totalTokenUsage ?? usage.total_token_usage;
    // If the current turn produced no usable observation, thread/read is the
    // freshest authority. A prior turn's cached notification is only a final
    // compatibility fallback.
    const total = record(needsRead
      ? readTotal ?? cumulativeNotification
      : cumulativeNotification ?? readTotal);
    const integer = (...names: string[]): number => {
      for (const name of names) {
        const value = total[name];
        if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
      }
      return 0;
    };
    const cumulative = {
      providerRequests: 1,
      inputTokens: integer("inputTokens", "input_tokens"),
      outputTokens: integer("outputTokens", "output_tokens"),
      cachedInputTokens: integer("cachedInputTokens", "cached_input_tokens"),
      reasoningTokens: integer("reasoningOutputTokens", "reasoningTokens", "reasoning_output_tokens"),
      costNanodollars: 0,
    };
    const prior = reconcileCapabilityLiveUsage(this.snapshot());
    const cumulativeFallback: CapabilityLiveUsageMeasurement = {
      providerRequests: 1,
      inputTokens: Math.max(0, cumulative.inputTokens - prior.inputTokens),
      outputTokens: Math.max(0, cumulative.outputTokens - prior.outputTokens),
      cachedInputTokens: Math.max(0, cumulative.cachedInputTokens - prior.cachedInputTokens),
      reasoningTokens: Math.max(0, cumulative.reasoningTokens - prior.reasoningTokens),
      costNanodollars: 0,
    };
    const reported = captured?.reported?.usage;
    const usableReported = reported !== undefined
      && reported.inputTokens + reported.outputTokens > 0
      ? reported
      : undefined;
    const selected = captured?.reported?.exactDelta === true
      ? reported
      : captured?.raw ?? captured?.terminal ?? usableReported ?? cumulativeFallback;
    const selectedWithReportedCost = selected === undefined
      ? undefined
      : {
          ...selected,
          costNanodollars: Math.max(selected.costNanodollars, reported?.costNanodollars ?? 0),
        };
    if (
      (selectedWithReportedCost?.inputTokens ?? 0) + (selectedWithReportedCost?.outputTokens ?? 0) === 0
      && !allowEmpty
    ) {
      throw new Error(`capability_live_usage_missing:${JSON.stringify({
        captured: captured !== undefined,
        needsRead,
        readKeys: Object.keys(read).sort(),
        threadKeys: Object.keys(thread).sort(),
        usageKeys: Object.keys(usage).sort(),
        totalKeys: Object.keys(total).sort(),
      })}`);
    }
    const finalUsage = selectedWithReportedCost ?? cumulativeFallback;
    await this.recordUsage({
      receiptId: `${turnId}:usage`,
      turnId,
      providerCalls: 1,
      providerRequests: Math.max(1, finalUsage.providerRequests),
      inputTokens: finalUsage.inputTokens,
      outputTokens: finalUsage.outputTokens,
      cachedInputTokens: finalUsage.cachedInputTokens,
      reasoningTokens: finalUsage.reasoningTokens,
      costNanodollars: finalUsage.costNanodollars,
    });
  }

  /**
   * Runs an operator-authored DevTools call through the exact dispatcher used
   * by Codex. It receives a real turn id, durable call/result evidence, and a
   * state-history entry so it is replayable as part of the conversation rather
   * than an out-of-band API console.
   */
  async invokeTool(operationId: string, input: unknown): Promise<CapabilityLiveToolInvocationResult> {
    if (this.#status === "closed" || this.#status === "failed") {
      throw new Error("Capability live session is not connected");
    }
    if (this.#activeTurnId !== null || this.#turnWaiter !== null) {
      throw new Error("Capability live session already has an active turn");
    }
    const turnId = `devtools-${randomUUID()}`;
    const callId = `devtools-call-${randomUUID()}`;
    const argumentsValue = jsonValue(input);
    const beforeRevision = this.#port.snapshot().revision;
    this.#appendTranscript("user", `DevTools invoked \`${operationId}\`.`, turnId);
    this.#appendEvidence("tool_call", turnId, {
      callId,
      operationId,
      input: argumentsValue,
      beforeRevision,
    });
    const result = await this.#dispatcher.dispatch({
      runId: this.#authority.runId,
      callId,
      operationId,
      input: argumentsValue,
    });
    this.#recordStateRevision(turnId, operationId);
    this.#appendEvidence("tool_result", turnId, {
      callId,
      operationId,
      result: jsonValue(result),
      beforeRevision,
      afterRevision: result.stateRevision,
    });
    this.#appendTranscript(
      "assistant",
      result.ok
        ? `DevTools call \`${operationId}\` completed at company state revision ${result.stateRevision}.`
        : `DevTools call \`${operationId}\` was denied: ${result.denial.message}`,
      turnId,
    );
    this.#recordTerminalFact(turnId, "completed");
    await this.#persist();
    return { turnId, result, snapshot: this.snapshot() };
  }

  #armTurnWaiter(): Promise<Omit<CapabilityLiveTurnResult, "snapshot">> {
    if (this.#turnWaiter !== null) throw new Error("Capability live session already has a turn waiter");
    return new Promise<Omit<CapabilityLiveTurnResult, "snapshot">>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.#turnWaiter;
        this.#turnWaiter = null;
        if (waiter !== null) {
          this.#emit({
            turnId: this.#activeTurnId,
            kind: "error",
            message: `Capability Codex turn timed out after ${this.#config.turnTimeoutMs}ms`,
          });
        }
        reject(new Error(`Capability Codex turn timed out after ${this.#config.turnTimeoutMs}ms`));
      }, this.#config.turnTimeoutMs);
      this.#turnWaiter = { resolve, reject, timer, assistantText: "", draftId: null };
    });
  }

  /** Interrupts and durably reconciles a checkpointed active turn after restart. */
  async reconcileActiveTurn(
    reason = "worker restarted while provider turn was active",
  ): Promise<CapabilityLiveTurnResult | null> {
    if (this.#activeTurnId === null) return null;
    const turnId = this.#activeTurnId;
    const terminal = this.#armTurnWaiter();
    try {
      await this.interrupt(reason);
    } catch (error) {
      this.#rejectTurn(error);
      await terminal.catch(() => undefined);
      throw error;
    }
    const result = await terminal;
    if (result.turnId !== turnId) throw new Error("capability_live_provider_session_drift: terminal turn mismatch");
    await this.#persist();
    await this.#afterTurnSettled();
    return { ...result, snapshot: this.snapshot() };
  }

  async interrupt(reason = "operator interrupted turn"): Promise<CapabilityLiveSessionSnapshot> {
    if (this.#transport === null || this.#activeTurnId === null) return this.snapshot();
    this.#status = "stopping";
    const turnId = this.#activeTurnId;
    this.#appendEvidence("session", turnId, { action: "stop_requested", reason });
    this.#emit({ turnId, kind: "activity", reason: "stop_requested" });
    await this.#transport.request("turn/interrupt", {
      threadId: this.#providerThreadId,
      turnId,
    });
    await this.#persist();
    return this.snapshot();
  }

  async increaseManagedSessionBudget(
    maxSessionListCostUsd: number,
  ): Promise<CapabilityLiveSessionSnapshot> {
    if (
      (this.#config.provider !== "claude_managed" &&
        this.#config.provider !== "aws_agentcore") ||
      this.#transport === null
    ) {
      throw new Error(
        "remote session budget updates require a connected remote provider session",
      );
    }
    if (!Number.isFinite(maxSessionListCostUsd) || maxSessionListCostUsd <= 0) {
      throw new Error("managed session spend ceiling must be positive");
    }
    await this.#transport.request("session/budget/increase", {
      maxSessionListCostUsd,
    });
    if (this.#config.managedProfile) {
      this.#config.managedProfile.maxSessionListCostUsd = maxSessionListCostUsd;
    }
    if (this.#config.agentCoreProfile) {
      this.#config.agentCoreProfile.maxEstimatedSessionCostUsd =
        maxSessionListCostUsd;
    }
    this.#status = this.#activeTurnId === null ? "warm_idle" : "running";
    this.#appendEvidence("session", this.#activeTurnId, {
      action: "budget_increased",
      maxSessionListCostUsd,
    });
    await this.#persist();
    return this.snapshot();
  }

  async deleteManagedRemoteSession(): Promise<CapabilityLiveSessionSnapshot> {
    if (
      (this.#config.provider !== "claude_managed" &&
        this.#config.provider !== "aws_agentcore") ||
      this.#transport === null
    ) {
      throw new Error(
        "remote session deletion requires a connected remote provider session",
      );
    }
    if (this.#activeTurnId !== null) {
      throw new Error(
        "interrupt the active turn before deleting the remote session",
      );
    }
    await this.#transport.request("session/destroy", {});
    this.#providerSessionId = null;
    this.#authority.active = false;
    this.#status = "closed";
    this.#appendEvidence("cleanup", null, {
      reason: "remote session explicitly deleted",
      remoteDeleted: true,
      resumable: false,
    });
    await this.#persist();
    return this.snapshot();
  }

  async resolveInteraction(input: CapabilityInteractionResolution): Promise<CapabilityLiveTurnResult> {
    const interaction = pendingInteractions(this.#port).find(
      (candidate) => candidate.id === input.interactionId,
    );
    if (interaction === undefined) throw new Error("interaction is not pending in this session");
    const outcome = await this.#port.tryApplyCommand({
      runId: this.#authority.runId,
      idempotencyKey: `capability-live-interaction:${input.interactionId}:${input.outcome}`,
      command: {
        kind: "resolve_human_input",
        interactionId: input.interactionId,
        outcome: input.outcome,
        result: input.result,
      },
    });
    if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
    this.#recordStateRevision(null, "resolve_human_input");
    this.#appendEvidence("interaction", null, {
      interactionId: input.interactionId,
      interactionKind: interaction.kind,
      outcome: input.outcome,
      result: input.result,
      stateRevision: outcome.result.stateRevision,
    });
    await this.#persist();
    return this.sendMessage(JSON.stringify({
      schema: "paperclip.semantic-interaction-result.v1",
      interactionId: input.interactionId,
      kind: interaction.kind,
      outcome: input.outcome,
      result: input.result,
      instruction: "Continue using this typed interaction result in the same mock issue session.",
    }));
  }

  async reconnect(): Promise<void> {
    if (this.#activeTurnId !== null) {
      throw new Error("stop the active turn before reconnecting the Codex transport");
    }
    await this.#disconnect("reconnect");
    await this.#connect(true);
  }

  async suspend(reason = "session suspended"): Promise<void> {
    if (this.#status === "closed" || this.#status === "suspended") return;
    this.#clearIdleTimer();
    if (this.#status === "failed") {
      // The notification pump may have failed to persist this state after a
      // transient store error. Its serialization queue is repaired, so a
      // suspend/shutdown boundary must retry the latest snapshot without
      // changing the authoritative failed status.
      // The first retry repairs as much state as possible before teardown, but
      // it is best effort: cleanup may append evidence that needs a newer save,
      // and a transient failure here must not skip that final attempt.
      await this.#persist().catch(() => undefined);
      let disconnectError: unknown = null;
      try {
        await this.#disconnect(reason);
      } catch (error) {
        disconnectError = error;
      }
      let persistenceError: unknown = null;
      try {
        await this.#persist();
      } catch (error) {
        persistenceError = error;
      }
      if (disconnectError !== null && persistenceError !== null) {
        throw new AggregateError(
          [disconnectError, persistenceError],
          "Capability live cleanup and final persistence both failed",
        );
      }
      if (disconnectError !== null) throw disconnectError;
      if (persistenceError !== null) throw persistenceError;
      return;
    }
    this.#status = "suspending";
    await this.#persist();
    await this.#disconnect(reason);
    this.#status = "suspended";
    this.#appendEvidence("cleanup", null, {
      reason,
      authorityCleared: false,
      mockStopped: false,
      processExited: this.#processEvidence?.runnerExited ?? true,
      resumable: true,
    });
    await this.#persist();
  }

  async shutdown(reason: string): Promise<void> {
    this.#clearIdleTimer();
    if (this.#activeTurnId !== null) {
      try {
        await this.interrupt(reason);
      } catch (error) {
        this.#appendEvidence("diagnostic", this.#activeTurnId, {
          message: redactCodexDiagnostic(String(error)),
        });
      }
    }
    await this.#disconnect(reason);
    await this.#port.stop();
    this.#authority.active = false;
    this.#status = "closed";
    this.#appendEvidence("cleanup", null, {
      reason,
      authorityCleared: true,
      mockStopped: true,
      processExited: this.#processEvidence?.runnerExited ?? true,
    });
    await this.#persist();
  }

  async #connect(resume: boolean): Promise<void> {
    const provider = this.#config.provider ?? this.#transportOptions.provider ?? "codex";
    this.#status = resume ? "restoring" : "starting";
    const identityDigest = createHash("sha256").update(this.id).digest("hex").slice(0, 20);
    const providerRunBinding = this.#providerRunBinding ?? {
      runId: this.#authority.runId,
      turnId: `turn_lab_${identityDigest}`,
      itemId: `item_lab_${identityDigest}`,
    };
    this.#providerRunBinding = providerRunBinding;
    const transportBundle = this.#transportFactory({
      ...this.#transportOptions,
      provider,
      ...(provider === "acpx" && this.#config.acpxAgent ? {
        acpxAgent: this.#config.acpxAgent,
      } : {}),
      ...(provider === "claude_managed" && this.#config.managedProfile
        ? {
            managedProfile: {
              ...this.#config.managedProfile,
              model: this.#config.requestedModel ?? "claude-sonnet-5",
            },
          }
        : {}),
      ...(provider === "aws_agentcore" && this.#config.agentCoreProfile
        ? {
            agentCoreProfile: {
              ...this.#config.agentCoreProfile,
              model:
                this.#config.requestedModel ??
                "global.anthropic.claude-sonnet-4-6",
            },
          }
        : {}),
      lifecyclePolicy: this.#config.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
      resumeActiveTurnId: resume ? this.#activeTurnId : null,
      stateDirectory: resolve(this.#config.workingDirectory, ".paperclip-runner-prp", identityDigest),
      prpIdentity: {
        runnerInstanceId: `runner_lab_${identityDigest}`,
        environmentLeaseId: `lease_lab_${identityDigest}`,
        runId: providerRunBinding.runId,
        normalizedSessionId: this.id,
        turnId: providerRunBinding.turnId,
        itemId: providerRunBinding.itemId,
      },
      onDiagnostic: (message) => {
        this.#transportOptions.onDiagnostic?.(message);
        this.#appendEvidence("diagnostic", this.#activeTurnId, {
          message: redactCodexDiagnostic(message),
        });
      },
      onEvidence: (evidence) => {
        this.#processEvidence = structuredClone(evidence);
        this.#transportOptions.onEvidence?.(evidence);
      },
    });
    this.#transport = transportBundle.transport;
    this.#processEvidence = structuredClone(transportBundle.evidence());
    this.#transport.setServerRequestHandler((request) => this.#handleServerRequest(request));
    const initialized = await this.#transport.request("initialize", {
      clientInfo: {
        name: "paperclip-runner",
        title: "Paperclip Runner Capability",
        version: "capability-v1",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.#transport.notify("initialized");
    const authorizedTools = this.#dispatcher.listTools(this.#authority.runId);
    const tools = (this.#config.toolExposure ?? "eager") === "lazy"
      ? authorizedTools.filter((tool) => tool.annotations.exposure === "always")
      : authorizedTools;
    this.#appendEvidence("tool_exposure", null, {
      operationIds: tools.map((tool) => tool.name),
      scenarioId: this.#config.scenario.id,
      toolExposure: this.#config.toolExposure ?? "eager",
    });
    if (resume) {
      const read = await this.#transport.request("thread/read", {
        threadId: this.#providerThreadId,
        includeTurns: true,
      });
      const thread = record(read.thread);
      if (text(thread.id) !== this.#providerThreadId) {
        throw new Error("capability_live_provider_session_drift: thread/read identity mismatch");
      }
      const readSessionId = text(thread.sessionId);
      if (
        this.#providerSessionId !== null
        && readSessionId.length > 0
        && readSessionId !== this.#providerSessionId
      ) {
        throw new Error("capability_live_provider_session_drift: thread/read session mismatch");
      }
      if (this.#activeTurnId !== null) {
        const turns = Array.isArray(thread.turns) ? thread.turns.map(record) : [];
        const recoveredTurn = turns.find((turn) => text(turn.id) === this.#activeTurnId);
        if (recoveredTurn === undefined) {
          throw new Error("capability_live_provider_session_drift: checkpointed active turn missing");
        }
        const recoveredTerminal = providerTurnStatus(recoveredTurn.status);
        if (recoveredTerminal !== null) {
          this.#recordTerminalFact(this.#activeTurnId, recoveredTerminal);
          this.#activeTurnId = null;
        }
      }
      const resumed = await this.#transport.request("thread/resume", {
        threadId: this.#providerThreadId,
        ...(this.#config.requestedModel === undefined ? {} : { model: this.#config.requestedModel }),
        cwd: this.#config.workingDirectory,
        config: createSkilllessCodexThreadConfig(this.#config.workingDirectory),
        permissions: CODEX_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#config.workingDirectory],
        baseInstructions: LIVE_BASE_INSTRUCTIONS,
        persistExtendedHistory: true,
      });
      const resumedThread = record(resumed.thread);
      if (text(resumedThread.id) !== this.#providerThreadId) {
        throw new Error("capability_live_provider_session_drift: thread/resume identity mismatch");
      }
      const resumedSessionId = text(resumedThread.sessionId);
      if (
        this.#providerSessionId !== null
        && resumedSessionId.length > 0
        && resumedSessionId !== this.#providerSessionId
      ) {
        throw new Error("capability_live_provider_session_drift: thread/resume session mismatch");
      }
      this.#providerSessionId = resumedSessionId || this.#providerSessionId;
      this.#captureProviderModel(resumed);
    } else {
      const opened = await this.#transport.request("thread/start", {
        cwd: this.#config.workingDirectory,
        ...(this.#config.requestedModel === undefined ? {} : { model: this.#config.requestedModel }),
        config: createSkilllessCodexThreadConfig(this.#config.workingDirectory),
        permissions: CODEX_PERMISSION_PROFILE,
        runtimeWorkspaceRoots: [this.#config.workingDirectory],
        approvalPolicy: "never",
        baseInstructions: LIVE_BASE_INSTRUCTIONS,
        dynamicTools: [
          ...tools.map(dynamicToolSpec),
          ...((this.#config.toolExposure ?? "eager") === "lazy" ? discoveryToolSpecs() : []),
        ],
        experimentalRawEvents: true,
        persistExtendedHistory: true,
      });
      const thread = record(opened.thread);
      this.#providerThreadId = text(thread.id);
      if (this.#providerThreadId.length === 0) throw new Error("Codex thread response omitted thread.id");
      this.#providerSessionId = text(thread.sessionId) || text(record(initialized.user).sessionId) || null;
      this.#captureProviderModel(opened);
    }
    this.#status = this.#activeTurnId === null ? "idle" : "running";
    this.#appendEvidence("session", null, {
      action: resume ? "resumed" : "started",
      sessionId: this.id,
      providerThreadId: this.#providerThreadId,
      providerSessionId: this.#providerSessionId,
      mode: `live_${this.#config.provider ?? "codex"}`,
      runner: "paperclip-runnerd",
      requestedModel: this.#config.requestedModel ?? null,
      controlPlane: "mock",
    });
    this.#pump = this.#pumpNotifications();
    await this.#persist();
  }

  #captureProviderModel(response: Record<string, unknown>): void {
    const thread = record(response.thread);
    const id = text(response.model, text(thread.model));
    const provider = text(response.modelProvider, text(thread.modelProvider));
    if (id.length > 0 && provider.length > 0) this.#providerModel = { id, provider };
  }

  async #disconnect(reason: string): Promise<void> {
    const transport = this.#transport;
    this.#transport = null;
    if (transport !== null) await transport.close();
    if (this.#pump !== null) await this.#pump.catch(() => undefined);
    this.#pump = null;
    this.#appendEvidence("process", null, {
      action: "transport_closed",
      reason,
      runnerExited: this.#processEvidence?.runnerExited ?? true,
      runnerPid: this.#processEvidence?.runnerPid ?? null,
      codexPid: this.#processEvidence?.codexPid ?? null,
      providerPid: this.#processEvidence?.providerPid ?? null,
      sidecarPid: this.#processEvidence?.sidecarPid ?? null,
      agentPid: this.#processEvidence?.agentPid ?? null,
    });
  }

  async #abortConnect(reason: string): Promise<void> {
    await this.#disconnect(reason).catch(() => undefined);
    await this.#port.stop().catch(() => undefined);
  }

  async #handleServerRequest(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    if (request.method !== "item/tool/call") {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Unsupported Codex client request." }],
      };
    }
    const operationId = text(request.params.tool);
    const threadId = text(request.params.threadId);
    const turnId = text(request.params.turnId);
    const callId = text(request.params.callId, String(request.id));
    // Codex may issue its first tool request immediately after writing the
    // turn/start response, before the response and turn/started notification
    // have crossed the two async readers. Bind that request only while this
    // session is already waiting for the single turn it just started.
    if (
      this.#activeTurnId === null &&
      this.#turnWaiter !== null &&
      this.#status === "running" &&
      threadId === this.#providerThreadId &&
      turnId.length > 0
    ) {
      this.#activeTurnId = turnId;
    }
    const terminalReplay = this.#isDurableTerminalReplay(turnId, request.params.arguments);
    if (
      threadId !== this.#providerThreadId ||
      turnId.length === 0 ||
      (turnId !== this.#activeTurnId && !terminalReplay) ||
      callId.length === 0
    ) {
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Tool call was outside the active Capability thread and turn." }],
      };
    }
    if (operationId === DISCOVER_TOOL) {
      const args = record(request.params.arguments);
      try {
        const discovered = this.#dispatcher.discoverTools(
          this.#authority.runId,
          text(args.query),
          { ...(text(args.namespace) ? { namespace: text(args.namespace) } : {}), ...(typeof args.limit === "number" ? { limit: args.limit } : {}) },
        );
        for (const operation of discovered.operations) this.#loadedOperationIds.add(operation.name);
        this.#appendEvidence("tool_discovery", turnId, {
          action: "loaded", query: discovered.query, namespace: discovered.namespace ?? "",
          operationIds: discovered.operations.map((operation) => operation.name),
        });
        await this.#persist();
        return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(discovered) }] };
      } catch (error) {
        this.#appendEvidence("tool_discovery", turnId, { action: "rejected", query: text(args.query), namespace: text(args.namespace), operationIds: [] });
        return { success: false, contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : "Capability discovery failed." }] };
      }
    }
    let semanticOperationId = operationId;
    let semanticInput = request.params.arguments;
    if (operationId === INVOKE_DISCOVERED_TOOL) {
      const args = record(request.params.arguments);
      semanticOperationId = text(args.operationId);
      semanticInput = args.input;
      if (!this.#loadedOperationIds.has(semanticOperationId)) {
        return { success: false, contentItems: [{ type: "inputText", text: "Operation was not loaded by discover_capabilities." }] };
      }
    }
    const beforeRevision = this.#port.snapshot().revision;
    this.#appendEvidence("tool_call", turnId, {
      callId,
      operationId: semanticOperationId,
      input: jsonValue(semanticInput),
      beforeRevision,
    });
    this.#emit({ turnId, kind: "activity", reason: "tool_call" });
    const result = await this.#dispatcher.dispatch({
      runId: this.#authority.runId,
      callId,
      operationId: semanticOperationId,
      input: semanticInput,
    });
    this.#recordStateRevision(turnId, semanticOperationId);
    const replayDisposition = result.ok ? text(record(result.result).disposition) : "";
    this.#appendEvidence("tool_result", turnId, {
      callId,
      operationId: semanticOperationId,
      result: jsonValue(result),
      beforeRevision,
      afterRevision: result.stateRevision,
    });
    this.#emit({ turnId, kind: "activity", reason: "tool_result" });
    if (terminalReplay && replayDisposition !== "duplicate") {
      await this.#persist();
      return {
        success: false,
        contentItems: [{ type: "inputText", text: "Terminal-turn replay did not resolve to a durable duplicate." }],
      };
    }
    if (terminalReplay) {
      this.#recordTerminalFact(this.#durableReplayTurnId(turnId), "completed");
    }
    await this.#persist();
    return this.#codexToolResponse(result);
  }

  #isDurableTerminalReplay(turnId: string, input: unknown): boolean {
    if (turnId.length === 0 || this.#activeTurnId !== null) return false;
    if (this.#terminalTurns.some(
      (candidate) => candidate.turnId === this.#durableReplayTurnId(turnId),
    )) return false;
    const terminal = this.#terminalTurns.find((candidate) => candidate.turnId === turnId);
    if (
      terminal?.status !== "interrupted" ||
      terminal.reconciledByAttemptId !== this.#currentAttemptId
    ) return false;
    const idempotencyKey = text(record(input).idempotencyKey);
    if (idempotencyKey.length === 0) return false;
    const scope = `${this.#authority.runId}:semantic-command`;
    return this.#port.snapshot().idempotency.some(
      (entry) => entry.scope === scope && entry.key === idempotencyKey,
    );
  }

  #durableReplayTurnId(interruptedTurnId: string): string {
    return `${interruptedTurnId}:durable-duplicate-replay`;
  }

  #codexToolResponse(result: CapabilitySemanticToolResult): Record<string, unknown> {
    return {
      success: result.ok,
      contentItems: [{
        type: "inputText",
        text: JSON.stringify(result),
      }],
    };
  }

  async #pumpNotifications(): Promise<void> {
    const transport = this.#transport;
    if (transport === null) return;
    try {
      for await (const notification of transport.notifications()) {
        await this.#handleNotification(notification);
      }
    } catch (error) {
      if (this.#transport !== transport) return;
      this.#status = "failed";
      this.#appendEvidence("diagnostic", this.#activeTurnId, {
        message: redactCodexDiagnostic(String(error)),
      });
      this.#rejectTurn(error);
      try {
        await this.#persist();
      } catch {
        // The original provider or notification failure already rejected the
        // active turn. Persisting that failed state is best effort: #persist
        // repairs its serialization queue so a later transition can retry the
        // latest snapshot, and this background pump must not reject unobserved.
      }
    }
  }

  async #handleNotification(notification: CodexRpcNotification): Promise<void> {
    const params = notification.params;
    const turn = record(params.turn);
    const item = record(params.item);
    const turnId = text(params.turnId, text(turn.id));
    const providerEvent = capabilityProviderEventCategory(notification.method, params);
    for (const canonical of canonicalProviderEventsFromCodex(notification.method, params)) {
      this.#appendEvidence("provider_event", turnId || this.#activeTurnId, {
        canonicalEventType: canonical.eventType,
        itemId: canonical.itemId,
        payload: canonical.payload,
      });
    }
    if (notification.method === "thread/tokenUsage/updated") {
      const tokenUsage = record(params.tokenUsage);
      this.#latestCumulativeUsage = record(
        tokenUsage.total ?? tokenUsage.totalTokenUsage ?? tokenUsage.total_token_usage ?? tokenUsage,
      );
      const runDelta = record(tokenUsage.runDelta ?? params.runDelta);
      if (turnId.length > 0) {
        const runDeltaAvailable =
          (params.runDeltaAvailable === true ||
            tokenUsage.runDeltaAvailable === true) &&
          Object.keys(runDelta).length > 0;
        const committed = reconcileCapabilityLiveUsage(this.snapshot());
        const integer = (source: Record<string, unknown>, ...names: string[]): number => {
          for (const name of names) {
            const value = source[name];
            if (Number.isSafeInteger(value) && Number(value) >= 0) return Number(value);
          }
          return 0;
        };
        const costNanodollars = (source: Record<string, unknown>): number => {
          const providerCostUsd = source.providerCostUsd;
          return typeof providerCostUsd === "number"
            && Number.isFinite(providerCostUsd)
            && providerCostUsd >= 0
            ? Math.round(providerCostUsd * 1_000_000_000)
            : 0;
        };
        const measurement = (source: Record<string, unknown>): CapabilityLiveUsageMeasurement => ({
          providerRequests: integer(source, "requests", "providerRequests"),
          inputTokens: integer(source, "inputTokens", "input_tokens"),
          outputTokens: integer(source, "outputTokens", "output_tokens"),
          cachedInputTokens: integer(
            source,
            "cacheReadTokens",
            "cachedInputTokens",
            "cached_input_tokens",
            "cache_read_input_tokens",
          ),
          reasoningTokens: integer(
            source,
            "reasoningOutputTokens",
            "reasoningTokens",
            "reasoning_tokens",
            "reasoning_output_tokens",
          ),
          costNanodollars: costNanodollars(source),
        });
        const cumulativeMeasurement = measurement(this.#latestCumulativeUsage);
        const cumulativeDelta: CapabilityLiveUsageMeasurement = {
          providerRequests: Math.max(0, cumulativeMeasurement.providerRequests - committed.providerRequests),
          inputTokens: Math.max(0, cumulativeMeasurement.inputTokens - committed.inputTokens),
          outputTokens: Math.max(0, cumulativeMeasurement.outputTokens - committed.outputTokens),
          cachedInputTokens: Math.max(0, cumulativeMeasurement.cachedInputTokens - committed.cachedInputTokens),
          reasoningTokens: Math.max(0, cumulativeMeasurement.reasoningTokens - committed.reasoningTokens),
          costNanodollars: Math.max(0, cumulativeMeasurement.costNanodollars - committed.costNanodollars),
        };
        const explicitDelta = measurement(runDelta);
        const usage: CapabilityLiveUsageMeasurement = {
          providerRequests: Math.max(
            1,
            runDeltaAvailable ? explicitDelta.providerRequests : 0,
            cumulativeDelta.providerRequests,
          ),
          inputTokens: runDeltaAvailable ? explicitDelta.inputTokens : cumulativeDelta.inputTokens,
          outputTokens: runDeltaAvailable ? explicitDelta.outputTokens : cumulativeDelta.outputTokens,
          cachedInputTokens: runDeltaAvailable
            ? explicitDelta.cachedInputTokens
            : cumulativeDelta.cachedInputTokens,
          reasoningTokens: runDeltaAvailable
            ? explicitDelta.reasoningTokens
            : cumulativeDelta.reasoningTokens,
          costNanodollars: Math.max(
            runDeltaAvailable ? explicitDelta.costNanodollars : 0,
            cumulativeDelta.costNanodollars,
          ),
        };
        const observations = this.#usageObservationsByTurn.get(turnId) ?? {
          reported: null,
          raw: null,
          terminal: null,
        };
        this.#usageObservationsByTurn.set(turnId, {
          ...observations,
          reported: { usage, exactDelta: runDeltaAvailable },
        });
        this.#emit({ turnId, kind: "usage", usage });
      }
    }
    this.#appendEvidence("provider_event", turnId || null, {
      method: notification.method,
      params: jsonValue(params),
    });
    if (notification.method === "rawResponse/completed" || notification.method === "turn/completed") {
      const rawUsage = record(params.usage);
      // Current Codex builds may omit turnId from rawResponse/completed. Turns
      // are serialized by this session, so the active or just-terminal turn is
      // the unambiguous owner of that usage receipt.
      const usageTurnId = turnId || this.#activeTurnId || this.#terminalTurns.at(-1)?.turnId || "";
      if (usageTurnId.length > 0 && Object.keys(rawUsage).length > 0) {
        const observations = this.#usageObservationsByTurn.get(usageTurnId) ?? {
          reported: null,
          raw: null,
          terminal: null,
        };
        const value = (name: string): number => Number.isSafeInteger(rawUsage[name]) && Number(rawUsage[name]) >= 0 ? Number(rawUsage[name]) : 0;
        if (notification.method === "rawResponse/completed") {
          const base = observations.raw ?? { providerRequests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, costNanodollars: 0 };
          this.#usageObservationsByTurn.set(usageTurnId, {
            ...observations,
            raw: {
              providerRequests: base.providerRequests + 1,
              inputTokens: base.inputTokens + value("inputTokens"),
              outputTokens: base.outputTokens + value("outputTokens"),
              cachedInputTokens: base.cachedInputTokens + value("cachedInputTokens"),
              reasoningTokens: base.reasoningTokens + value("reasoningOutputTokens"),
              costNanodollars: base.costNanodollars,
            },
          });
        } else {
          // Some provider versions publish only a terminal per-turn receipt.
          this.#usageObservationsByTurn.set(usageTurnId, {
            ...observations,
            terminal: {
              providerRequests: 1,
              inputTokens: value("inputTokens"),
              outputTokens: value("outputTokens"),
              cachedInputTokens: value("cachedInputTokens"),
              reasoningTokens: value("reasoningOutputTokens"),
              costNanodollars: 0,
            },
          });
        }
      }
    }
    let pendingCompletion: PendingTurnCompletion | null = null;
    if (notification.method === "provider/budgetReached") {
      this.#status = "waiting_input";
      this.#appendEvidence("session", turnId || this.#activeTurnId, {
        action: "budget_reached",
        stopReason: "provider_quota",
      });
      this.#emit({ turnId: turnId || this.#activeTurnId, kind: "activity", reason: "provider_budget_reached" });
    } else if (notification.method === "turn/started") {
      if (turnId.length > 0) this.#activeTurnId = turnId;
      this.#emit({ turnId: turnId || this.#activeTurnId, kind: "activity", reason: "turn_started" });
    } else if (notification.method === "item/agentMessage/delta") {
      if (this.#turnWaiter !== null) {
        this.#turnWaiter.assistantText += text(params.delta);
        this.#publishAssistantProgress(turnId || this.#activeTurnId);
      }
    } else if (
      providerEvent.endsWith("_delta") ||
      (providerEvent.endsWith("_started") && providerEvent !== "item_started") ||
      (providerEvent.endsWith("_completed") && providerEvent !== "item_completed" && providerEvent !== "turn_completed")
    ) {
      // Reasoning, planning, command-output, and file-change progress used to
      // be retained only for diagnostics. Emitting an activity frame here lets
      // the thread acknowledge that work immediately, while the redaction gate
      // still withholds provider text and chain-of-thought content.
      this.#emit({
        turnId: turnId || this.#activeTurnId,
        kind: "activity",
        reason: providerEvent,
      });
    } else if (notification.method === "item/completed" && text(item.type) === "agentMessage") {
      const assistantText = text(item.text);
      if (assistantText.length > 0 && this.#turnWaiter !== null) {
        this.#turnWaiter.assistantText = assistantText;
        this.#publishAssistantProgress(turnId || this.#activeTurnId);
      }
    } else if (notification.method === "turn/completed") {
      const status = terminalStatus(turn.status);
      const settled = this.#terminalTurns.find(
        (terminal) => terminal.turnId === turnId,
      );
      if (settled !== undefined && turnId !== this.#activeTurnId) {
        if (settled.status !== status) {
          throw new Error("capability_live_terminal_fact_conflict");
        }
        // A recovered provider can replay the already-settled terminal after
        // the next turn starts. Keep that fact, but never let it resolve the
        // newer turn's waiter or clear its active identity.
      } else if (
        this.#activeTurnId !== null &&
        turnId.length > 0 &&
        turnId !== this.#activeTurnId
      ) {
        throw new Error(
          "capability_live_provider_session_drift: terminal named an unknown inactive turn",
        );
      } else {
        pendingCompletion = this.#completeTurn(turnId, status);
      }
    }
    try {
      await this.#persist();
    } catch (error) {
      // A terminal provider notification is not successful until its snapshot
      // is durable. Reject the caller instead of acknowledging a completion
      // that recovery cannot yet observe; the pump catch records and retries
      // the authoritative failed state.
      pendingCompletion?.waiter?.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
    if (pendingCompletion !== null) {
      this.#emit({
        turnId: pendingCompletion.result.turnId,
        kind: "terminal",
        status: pendingCompletion.result.status,
        assistantText: pendingCompletion.result.assistantText,
      });
      pendingCompletion.waiter?.resolve(pendingCompletion.result);
    }
  }

  /** Streams the assembled text into the transcript draft and announces it. */
  #publishAssistantProgress(turnId: string | null): void {
    this.#syncAssistantDraft(turnId);
    this.#emit({
      turnId,
      kind: "delta",
      assistantText: this.#turnWaiter?.assistantText ?? "",
    });
  }

  #completeTurn(
    turnId: string,
    status: CapabilityLiveTurnResult["status"],
  ): PendingTurnCompletion {
    const waiter = this.#turnWaiter;
    if (waiter === null) {
      this.#recordTerminalFact(turnId, status);
      this.#activeTurnId = null;
      this.#status = "idle";
      return { waiter: null, result: { turnId, status, assistantText: "" } };
    }
    clearTimeout(waiter.timer);
    this.#turnWaiter = null;
    const assistantText = waiter.assistantText.trim();
    this.#settleAssistantDraft(waiter, assistantText, turnId);
    this.#recordTerminalFact(turnId, status);
    this.#activeTurnId = null;
    this.#status = "idle";
    return { waiter, result: { turnId, status, assistantText } };
  }

  #recordTerminalFact(turnId: string, status: CapabilityLiveTurnResult["status"]): void {
    const existing = this.#terminalTurns.find((terminal) => terminal.turnId === turnId);
    if (existing !== undefined) {
      if (existing.status !== status) throw new Error("capability_live_terminal_fact_conflict");
      return;
    }
    this.#terminalTurns.push({
      turnId,
      status,
      reconciledByAttemptId: this.#currentAttemptId,
      observedAt: this.#now().toISOString(),
    });
  }

  #rejectTurn(error: unknown): void {
    const waiter = this.#turnWaiter;
    if (waiter === null) return;
    clearTimeout(waiter.timer);
    this.#turnWaiter = null;
    const turnId = this.#activeTurnId;
    this.#activeTurnId = null;
    this.#status = "failed";
    // Whatever the turn had already streamed stays in the transcript; a failed
    // turn should read as an interrupted reply, not as one that never spoke.
    if (turnId !== null) this.#settleAssistantDraft(waiter, waiter.assistantText.trim(), turnId);
    this.#emit({
      turnId,
      kind: "error",
      message: redactCodexDiagnostic(error instanceof Error ? error.message : String(error)),
    });
    waiter.reject(error instanceof Error ? error : new Error(String(error)));
  }

  #appendTranscript(
    role: CapabilityLiveTranscriptEntry["role"],
    message: string,
    turnId: string | null,
  ): string {
    this.#entryCounter += 1;
    const id = `transcript-${String(this.#entryCounter).padStart(6, "0")}`;
    this.#transcript.push({
      id,
      role,
      text: message,
      turnId,
      at: this.#now().toISOString(),
    });
    return id;
  }

  /**
   * Records one evidence entry. Redaction happens here rather than at render
   * time so the retained record is already the public one: a raw provider
   * payload never enters the snapshot, the store, a stream frame, or a log.
   */
  #appendEvidence(
    kind: CapabilityLiveEvidenceEntry["kind"],
    turnId: string | null,
    data: Record<string, unknown>,
  ): void {
    this.#entryCounter += 1;
    this.#evidence.push({
      id: `evidence-${String(this.#entryCounter).padStart(6, "0")}`,
      kind,
      at: this.#now().toISOString(),
      turnId,
      data: redactCapabilityEvidenceData(kind, jsonValue(data) as Record<string, unknown>),
    });
    if (this.#evidence.length > 2_000) this.#evidence.splice(0, this.#evidence.length - 2_000);
  }

  #recordStateRevision(turnId: string | null, operationId: string): void {
    const state = this.#port.snapshot();
    if (this.#stateHistory.at(-1)?.revision === state.revision) return;
    this.#stateHistory.push({
      revision: state.revision,
      at: this.#now().toISOString(),
      turnId,
      operationId,
      state: this.#port.serialize(),
    });
    if (this.#stateHistory.length > 256) {
      this.#stateHistory.splice(0, this.#stateHistory.length - 256);
    }
  }

  #persist(): Promise<void> {
    this.#revision += 1;
    this.#updatedAt = this.#now().toISOString();
    const snapshot = this.snapshot();
    const attempt = this.#persistChain.then(() => this.#store.save(snapshot));
    // Report this save failure to its caller, but do not permanently poison the
    // serialization queue. A later state transition must still be able to
    // persist a newer snapshot after a transient store failure.
    this.#persistChain = attempt.catch(() => undefined);
    return attempt;
  }
}

export function capabilityInteractionKindFromMock(
  kind: CapabilityInteractionKind,
): "ask_user_questions" | "request_confirmation" | "request_checkbox_confirmation" | "request_item_verdicts" | "suggest_tasks" {
  if (kind === "questions") return "ask_user_questions";
  if (kind === "confirmation") return "request_confirmation";
  if (kind === "checkbox") return "request_checkbox_confirmation";
  if (kind === "item_verdicts") return "request_item_verdicts";
  return "suggest_tasks";
}

export type { CapabilityOpenFixtureRunInput };
