import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import type { NativeSessionCapabilities, NativeUserMessage } from "./types.js";

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
}

export interface OpenHarnessSessionInput {
  runId: string;
  normalizedSessionId: string;
  workingDirectory: string;
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
    };

export type HarnessRuntimeRequestAction = HarnessRuntimeRequestResolution["action"];

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
  if (action !== "submit" && ("answers" in candidate || "content" in candidate)) {
    throw new HarnessRuntimeRequestResolutionError(
      requestKind,
      `${action} does not carry submitted form data`,
    );
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
};

export function harnessRuntimeRequestOutcome(
  request: Pick<
    HarnessRuntimeRequest,
    "requestId" | "requestKind" | "turnId" | "itemId"
  >,
  outcome: { action?: HarnessRuntimeRequestAction | null; reason?: string | null } = {},
): HarnessRuntimeRequestOutcome {
  return {
    requestId: request.requestId,
    requestKind: request.requestKind,
    turnId: request.turnId,
    itemId: request.itemId,
    ...(outcome.action ? { action: outcome.action } : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
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

export interface PersistedHarnessSession {
  driverKind: string;
  driverSessionId: string;
  providerSessionId?: string | null;
  runId?: string;
  normalizedSessionId?: string;
  activeTurnId?: string | null;
  semanticResult?: PersistedHarnessSemanticResult | null;
  terminalTurns?: PersistedHarnessTurnTerminal[];
  pendingRuntimeRequests?: HarnessRuntimeRequest[];
  goal?: HarnessThreadGoal | null;
  lineage?: HarnessThreadLineageEntry[];
  lastSourceSequence?: number;
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
  startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }>;
  steer?(input: { turnId: string; message: NativeUserMessage }): Promise<void>;
  interrupt?(input: { turnId?: string; reason?: string }): Promise<void>;
  pendingRuntimeRequests?(): HarnessRuntimeRequest[];
  resolveRuntimeRequest?(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void>;
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
  ): Promise<HarnessSessionRecoveryResult>;
}
