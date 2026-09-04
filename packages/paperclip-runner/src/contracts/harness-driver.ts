import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import type { NativeSessionCapabilities, NativeUserMessage } from "./types.js";
import {
  PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
  parsePaperclipQuestionResponse,
  type PaperclipQuestionResponse,
  type PaperclipQuestionSet,
  type PaperclipRuntimeRequestOrigin,
} from "./question-set.js";

export * from "./question-set.js";

export const HARNESS_DRIVER_CONTRACT_VERSION = 1 as const;

export interface HarnessDriverConfigIssue {
  path: string;
  code: string;
  message: string;
}

export type HarnessDriverConfigValidation =
  | { ok: true; config: Record<string, unknown>; issues: [] }
  | { ok: false; config: null; issues: HarnessDriverConfigIssue[] };

export interface HarnessTranscriptSnapshot {
  schema: "paperclip-runner/harness-transcript/v1";
  complete: boolean;
  eventCount: number;
  events: PrpEvent[];
  omissionReason: string | null;
}

export interface HarnessDriverDescriptor {
  kind: string;
  displayName: string;
  version: string;
  protocolVersion?: string;
  capabilities: NativeSessionCapabilities;
  runtimeContextCapabilities?: NativeRuntimeContextCapabilities;
}

export interface NativeRuntimeContextCapabilities {
  instructions: "native" | "unsupported";
  skills: "native" | "unsupported";
  mcp: "native" | "unsupported";
}

export interface OpenHarnessSessionInput {
  runId: string;
  normalizedSessionId: string;
  workingDirectory: string;
  /** Abort provider bootstrap and release any not-yet-returned provider state. */
  signal?: AbortSignal;
}

export interface HarnessSessionRecoveryOptions {
  /** Abort provider recovery and release any not-yet-returned provider state. */
  signal: AbortSignal;
}

export class HarnessCapabilityUnavailableError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`${operation} is unavailable: ${detail}`);
    this.name = "HarnessCapabilityUnavailableError";
    this.operation = operation;
  }
}

export class HarnessReconciliationError extends Error {
  readonly recoverable = true;

  constructor(message: string) {
    super(message);
    this.name = "HarnessReconciliationError";
  }
}

export class HarnessOperationAlreadyTerminalError extends Error {
  readonly code = "already_terminal" as const;

  constructor(operation: string) {
    super(`${operation} lost a race with the committed turn terminal`);
    this.name = "HarnessOperationAlreadyTerminalError";
  }
}

export class HarnessStaleTurnError extends Error {
  readonly code = "stale_turn" as const;

  constructor(turnId: string) {
    super(`turn ${turnId} is not the active turn`);
    this.name = "HarnessStaleTurnError";
  }
}

export type HarnessRuntimeRequestKind =
  | "command_approval"
  | "file_approval"
  | "permission_approval"
  | "user_input"
  | "elicitation";

export interface HarnessRuntimeRequest {
  requestId: string;
  requestKind: HarnessRuntimeRequestKind;
  method: string;
  turnId: string;
  itemId: string;
  status: "pending";
  prompt: string;
  details: Record<string, unknown>;
  /** Provider-neutral presentation model for structured input requests. */
  input?: PaperclipQuestionSet;
  /** Diagnostic origin only; provider response shapes never enter PRP. */
  origin?: PaperclipRuntimeRequestOrigin;
}

export type HarnessRuntimeRequestResolution =
  | { action: "accept" | "accept_for_session" | "decline" | "cancel" }
  | {
      action: "submit";
      answers: Record<string, { answers: string[] }>;
    }
  | {
      action: "submit";
      content: Record<string, unknown>;
    }
  | {
      action: "submit";
      response: PaperclipQuestionResponse;
    };

export type HarnessRuntimeRequestAction = HarnessRuntimeRequestResolution["action"];

export type HarnessRuntimeRequestHandoffResult = "handed_off" | "already_settled";

/**
 * A runtime-input handoff commits its durable state transition before the
 * method returns. Provider interruption is cleanup only: it remains observed,
 * but cannot acquire mutation authority or reverse an already committed turn.
 */
export interface HarnessRuntimeRequestHandoff {
  result: HarnessRuntimeRequestHandoffResult;
  cleanup: Promise<void>;
}

const RUNTIME_REQUEST_ACTIONS: readonly HarnessRuntimeRequestAction[] = [
  "accept",
  "accept_for_session",
  "decline",
  "cancel",
  "submit",
];

export class HarnessRuntimeRequestResolutionError extends Error {
  readonly code = "invalid_resolution" as const;
  readonly requestKind: HarnessRuntimeRequestKind;

  constructor(requestKind: HarnessRuntimeRequestKind, detail: string) {
    super(`${requestKind} rejected its resolution: ${detail}`);
    this.name = "HarnessRuntimeRequestResolutionError";
    this.requestKind = requestKind;
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseAnswers(value: unknown): Record<string, { answers: string[] }> | null {
  const fields = plainRecord(value);
  if (fields === null || Object.keys(fields).length === 0) return null;
  const parsed: Record<string, { answers: string[] }> = {};
  for (const [field, entry] of Object.entries(fields)) {
    const answer = plainRecord(entry);
    if (answer === null || !Array.isArray(answer.answers)) return null;
    if (answer.answers.some((value) => typeof value !== "string")) return null;
    parsed[field] = { answers: [...(answer.answers as string[])] };
  }
  return parsed;
}

/**
 * Validates a resolution against the kind of request it answers, so a
 * mismatched submit fails closed instead of degrading into an accepted empty
 * response. Every driver runs this before it touches its provider, and the
 * browser transport runs it again at its own untrusted edge.
 */
export function parseHarnessRuntimeRequestResolution(
  requestKind: HarnessRuntimeRequestKind,
  value: unknown,
  questionSet?: PaperclipQuestionSet,
): HarnessRuntimeRequestResolution {
  const candidate = plainRecord(value) ?? {};
  const rawAction = candidate.action;
  if (
    typeof rawAction !== "string" ||
    !RUNTIME_REQUEST_ACTIONS.includes(rawAction as HarnessRuntimeRequestAction)
  ) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      `unsupported action ${JSON.stringify(rawAction) ?? "undefined"}`,
    );
  }
  const action = rawAction as HarnessRuntimeRequestAction;
  if (action !== "submit" && ("answers" in candidate || "content" in candidate || "response" in candidate)) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      `${action} does not carry submitted form data`,
    );
  }

  if (action === "submit" && "response" in candidate) {
    if (requestKind !== "user_input" && requestKind !== "elicitation") {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "approval requests do not accept submitted question responses",
      );
    }
    if ("answers" in candidate || "content" in candidate) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "canonical submissions cannot also carry provider-specific answers or content",
      );
    }
    if (questionSet === undefined) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "canonical submission requires the persisted question set",
      );
    }
    try {
      return {
        action,
        response: parsePaperclipQuestionResponse(questionSet, candidate.response),
      };
    } catch (error) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        error instanceof Error ? error.message : "invalid question response",
      );
    }
  }

  if (requestKind === "user_input") {
    if (action === "accept" || action === "accept_for_session") {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "user input requires submit, decline, or cancel",
      );
    }
    if (action !== "submit") return { action };
    if ("content" in candidate) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "user input submissions carry answers, not content",
      );
    }
    const answers = parseAnswers(candidate.answers);
    if (answers === null) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "submit requires answers shaped as { field: { answers: [string] } }",
      );
    }
    return { action, answers };
  }

  if (requestKind === "elicitation") {
    if (action === "accept_for_session") {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "elicitation does not support session acceptance",
      );
    }
    if (action !== "submit") return { action };
    if ("answers" in candidate) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "elicitation submissions carry content, not answers",
      );
    }
    const content = plainRecord(candidate.content);
    if (content === null || Object.keys(content).length === 0) {
      throw new HarnessRuntimeRequestResolutionError(
        requestKind,
        "submit requires a non-empty content object",
      );
    }
    return { action, content: structuredClone(content) };
  }

  if (action === "submit") {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      "approval requests do not accept submitted form data",
    );
  }
  return { action };
}

/**
 * The single payload shape every driver emits for a terminal
 * `runtime_request.*` fact. Request identity travels in the payload as well as
 * the event binding, so a consumer that only reads payloads still settles the
 * request it belongs to.
 */
export type HarnessRuntimeRequestOutcome = {
  requestId: string;
  requestKind: HarnessRuntimeRequestKind;
  turnId: string;
  itemId: string;
  action?: HarnessRuntimeRequestAction;
  reason?: string;
  /** Enables content-free lifecycle counters partitioned by adapter. */
  adapter?: string;
  requestType?: "input" | "permission";
  /** Canonical submitted answers retained for durable replay and audit UI. */
  response?: PaperclipQuestionResponse;
};

export function harnessRuntimeRequestOutcome(
  request: Pick<
    HarnessRuntimeRequest,
    "requestId" | "requestKind" | "turnId" | "itemId" | "origin" | "input"
  >,
  outcome: {
    action?: HarnessRuntimeRequestAction | null;
    reason?: string | null;
    response?: PaperclipQuestionResponse | null;
  } = {},
): HarnessRuntimeRequestOutcome {
  return {
    requestId: request.requestId,
    requestKind: request.requestKind,
    turnId: request.turnId,
    itemId: request.itemId,
    ...(outcome.action ? { action: outcome.action } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    ...(outcome.response ? { response: structuredClone(outcome.response) } : {}),
    ...(request.input
      ? {
          ...(request.origin?.adapter ? { adapter: request.origin.adapter } : {}),
          requestType: "input" as const,
        }
      : {}),
  };
}

/** Canonical non-replayable expiration used when a live input moves to a durable wait. */
export function harnessRuntimeInputExpiredOutcome(
  request: HarnessRuntimeRequest,
  reason: "durable_handoff" | "provider_process_lost",
): Omit<HarnessRuntimeRequestOutcome, "requestKind"> & {
  requestKind: "runtime";
  replayAllowed: false;
  request: Record<string, unknown>;
} {
  return {
    ...harnessRuntimeRequestOutcome(request, { reason }),
    requestKind: "runtime",
    replayAllowed: false,
    request: {
      schema: PAPERCLIP_RUNTIME_REQUEST_SCHEMA_V2,
      requestKind: "runtime",
      requestId: request.requestId,
      type: "input",
      status: request.status,
      prompt: request.prompt,
      input: structuredClone(request.input),
      origin: structuredClone(request.origin),
      turnId: request.turnId,
      itemId: request.itemId,
    },
  };
}

export interface HarnessThreadGoal {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export type HarnessGoalOperation =
  | { action: "get" }
  | { action: "set"; objective: string; tokenBudget?: number | null }
  | { action: "pause" | "resume" | "clear" };

export interface HarnessThreadLineageEntry {
  threadId: string;
  providerSessionId: string | null;
  parentThreadId: string | null;
  depth: number;
  nickname: string | null;
  role: string | null;
  status: string;
}

export interface PersistedHarnessSemanticResult {
  result: PrpStructuredRunResult;
  fingerprint: string;
  callId?: string | null;
  turnId: string;
}

export interface PersistedHarnessTurnTerminal {
  turnId: string;
  fingerprint: string;
}

export interface AcpxSessionIdentity {
  kind: "acpx";
  normalizedSessionId: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  profileDigest: string;
  workspaceDigest: string;
  requestedModel: string;
  effectiveModel: string;
  /** Missing on legacy snapshots; those used the historical approve-reads behavior. */
  permissionMode?: "approve-all" | "approve-reads" | "deny-all";
}

export type PersistedHarnessProviderIdentity = AcpxSessionIdentity;

export interface PersistedHarnessSession {
  driverKind: string;
  driverSessionId: string;
  providerSessionId?: string | null;
  runId?: string;
  normalizedSessionId?: string;
  activeTurnId?: string | null;
  semanticResult?: PersistedHarnessSemanticResult | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  /** A result-less terminal task may spend this fail-closed one-shot recovery allowance. */
  dispositionOnlyRecoveryConsumed?: boolean;
  /** Exact accepted provider turn that spent the disposition-only allowance. */
  dispositionOnlyRecoveryTurnId?: string | null;
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  goal?: HarnessThreadGoal | null;
  lineage?: HarnessThreadLineageEntry[];
  lastSourceSequence?: number;
  /** Tagged provider identity used to reject cross-profile recovery. */
  providerIdentity?: PersistedHarnessProviderIdentity;
  /** Narrow escape hatch for a durable response-wake when a provider cannot reload its prior native session. */
  providerRecoveryPolicy?:
    | "same_session_only"
    | "allow_replacement_after_governed_wait"
    | "allow_replacement_after_resume_failure";
}

export interface HarnessSessionRecoveryResult {
  recovered: boolean;
  session?: HarnessSession;
  reason?: string;
}

export interface HarnessSession {
  ids(): {
    driverSessionId: string;
    providerSessionId?: string | null;
    displayId?: string | null;
  };
  events(): AsyncIterable<PrpEvent>;
  attachRun?(input: { runId: string }): Promise<void> | void;
  startTurn(input: {
    message: NativeUserMessage;
    requestedCollaborationMode?: "default" | "plan";
  }): Promise<{ turnId: string; effectiveCollaborationMode?: "default" | "plan" }>;
  steer?(input: { turnId: string; message: NativeUserMessage; correlationId?: string }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string; signal?: AbortSignal }): Promise<void>;
  pendingRuntimeRequests?(): HarnessRuntimeRequest[];
  resolveRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void>;
  handoffRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    /** Do not synchronously commit if runtime ownership is already revoked. */
    signal: AbortSignal;
  }): HarnessRuntimeRequestHandoff;
  goal?(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null>;
  lineage?(): HarnessThreadLineageEntry[];
  read?(): Promise<Record<string, unknown>>;
  reconcile?(): Promise<Record<string, unknown>>;
  usage?(): Promise<Record<string, unknown> | null>;
  transcript?(): Promise<HarnessTranscriptSnapshot>;
  snapshot(): Promise<PersistedHarnessSession>;
  close(input: { reason: string; force?: boolean }): Promise<void>;
}

/** A local harness implementation hidden behind the runner daemon boundary. */
export interface HarnessDriver {
  descriptor(): Promise<HarnessDriverDescriptor>;
  validateConfig?(config: unknown): Promise<HarnessDriverConfigValidation>;
  openSession(input: OpenHarnessSessionInput): Promise<HarnessSession>;
  recoverSession?(
    snapshot: PersistedHarnessSession,
    options: HarnessSessionRecoveryOptions,
  ): Promise<HarnessSessionRecoveryResult>;
}
