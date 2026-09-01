import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
  CodexTraceInterpretation,
  CodexTransportProcessInfo,
} from "../drivers/codex/app-server-transport.js";
import { createSanitizedCodexEnvironment } from "../drivers/codex/app-server-transport.js";
import {
  codexSemanticToolSpecs,
  createIsolatedCodexAppServerArgs,
} from "../drivers/codex/codex-app-server-driver.js";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";
import type { HarnessRuntimeRequestResolution } from "../contracts/harness-driver.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  spawnRunner,
  waitForProcess,
  type RunnerProcessHandle,
  type RunnerProcessConnection,
  type RunnerProcessLaunchSpec,
} from "../control-plane/durable-prp-control-plane.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../drivers/acpx/qualified-profiles.js";
import { createSanitizedAcpxSpawnInput } from "../drivers/acpx/environment.js";
import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import type { NativeAcpxPermissionMode } from "../contracts/native-execution.js";
import { nativeMcpLaunchBinding } from "../drivers/native-mcp.js";
import {
  prepareIsolatedCodexHome,
  releaseMaterializedNativeRuntimeSkills,
} from "../drivers/runtime-context-materializer.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const MAX_NOTIFICATION_COUNT = 2_048;
const MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;
const RUNNER_CLIENT_VERSION = "0.3.0";
const RUNNER_BOOTSTRAP_TICKET_TTL_MS = 60_000;

const CODEX_COLLABORATION_RUNTIME_INSTRUCTIONS = `## Codex-style collaboration

- Before the first tool call in a turn, send a brief commentary update describing the immediate work you are starting.
- During tool-driven work, send concise commentary updates at meaningful transitions so the user can follow progress without opening raw logs.
- Reserve \`report_progress\` for meaningful durable milestones on longer work. Do not call it merely to create a completion comment on a short run; Paperclip materializes the final assistant response as the durable completion comment.
- After semantic finalization, send one self-contained final assistant response with the outcome and verification.`;

export function withCodexCollaborationRuntimeInstructions(
  instructions: string,
  enabled = true,
): string {
  if (!enabled) return instructions;
  const base = instructions.trimEnd();
  return `${base}\n\n${CODEX_COLLABORATION_RUNTIME_INSTRUCTIONS}`;
}

function recoveredControlPlaneIdentity(
  directory: string,
  desired: DurableRecoveryIdentity,
): DurableRecoveryIdentity {
  const stored = record(
    JSON.parse(
      readFileSync(resolve(directory, "control-plane-state.json"), "utf8"),
    ),
  );
  const identity = record(
    stored.identity,
  ) as unknown as DurableRecoveryIdentity;
  if (
    identity.runnerInstanceId !== desired.runnerInstanceId ||
    identity.environmentLeaseId !== desired.environmentLeaseId ||
    identity.normalizedSessionId !== desired.normalizedSessionId
  ) {
    throw new Error(
      "PRP recovery identity does not match the durable session binding",
    );
  }
  return structuredClone(identity);
}

function bridgedCodexQuestionParams(
  request: Record<string, unknown>,
  method: string,
  threadId: string,
  turnId: string,
): Record<string, unknown> | null {
  const questionSet = record(request.input);
  if (
    questionSet.schema !== "paperclip.question_set.v1" ||
    !Array.isArray(questionSet.questions) ||
    questionSet.questions.length === 0
  ) return null;
  const common = {
    threadId,
    turnId,
    itemId: typeof request.itemId === "string" ? request.itemId : String(request.requestId ?? "runtime-input"),
  };
  if (method === "mcpServer/elicitation/request") {
    const required: string[] = [];
    const properties = Object.fromEntries(questionSet.questions.map((candidate, index) => {
      const question = record(candidate);
      const id = typeof question.id === "string" ? question.id : `question-${index + 1}`;
      if (question.required === true) required.push(id);
      const validation = record(question.textValidation);
      const options = Array.isArray(question.options)
        ? question.options.map((candidateOption) => {
            const option = record(candidateOption);
            return {
              const: typeof option.id === "string" ? option.id : "option",
              title: typeof option.label === "string" ? option.label : "Option",
              ...(typeof option.description === "string" ? { description: option.description } : {}),
            };
          })
        : [];
      const isBoolean = question.answerMode === "single_select"
        && options.length === 2
        && options[0]?.const === "true"
        && options[1]?.const === "false";
      const inputType = validation.inputType === "integer" || validation.inputType === "number"
        ? validation.inputType
        : "string";
      const scalarSchema = isBoolean
        ? { type: "boolean" }
        : options.length > 0
        ? { type: "string", oneOf: options }
        : {
            type: inputType,
            ...(typeof validation.minLength === "number" ? { minLength: validation.minLength } : {}),
            ...(typeof validation.maxLength === "number" ? { maxLength: validation.maxLength } : {}),
            ...(typeof validation.minimum === "number" ? { minimum: validation.minimum } : {}),
            ...(typeof validation.maximum === "number" ? { maximum: validation.maximum } : {}),
            ...(typeof validation.pattern === "string" ? { pattern: validation.pattern } : {}),
          };
      return [id, {
        ...(question.answerMode === "multi_select"
          ? { type: "array", items: scalarSchema }
          : scalarSchema),
        ...(typeof question.header === "string"
          ? { title: question.header }
          : typeof question.prompt === "string"
            ? { title: question.prompt }
            : {}),
        ...(typeof question.helpText === "string" ? { description: question.helpText } : {}),
      }];
    }));
    return {
      ...common,
      message: typeof questionSet.description === "string"
        ? questionSet.description
        : typeof questionSet.title === "string"
          ? questionSet.title
          : "A tool needs your input",
      requestedSchema: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    };
  }
  return {
    ...common,
    ...(typeof questionSet.title === "string" ? { title: questionSet.title } : {}),
    ...(typeof questionSet.description === "string" ? { description: questionSet.description } : {}),
    ...(typeof questionSet.submitLabel === "string" ? { submitLabel: questionSet.submitLabel } : {}),
    questions: questionSet.questions.map((candidate, index) => {
      const question = record(candidate);
      const validation = record(question.textValidation);
      return {
        id: typeof question.id === "string" ? question.id : `question-${index + 1}`,
        ...(typeof question.header === "string" ? { header: question.header } : {}),
        question: typeof question.prompt === "string" ? question.prompt : `Question ${index + 1}`,
        ...(typeof question.helpText === "string" ? { description: question.helpText } : {}),
        required: question.required === true,
        ...(question.answerMode === "multi_select" ? { multiSelect: true } : {}),
        ...(Array.isArray(question.options)
          ? {
              options: question.options.map((candidateOption, optionIndex) => {
                const option = record(candidateOption);
                return {
                  id: typeof option.id === "string" ? option.id : `option-${optionIndex + 1}`,
                  label: typeof option.label === "string" ? option.label : `Option ${optionIndex + 1}`,
                  ...(typeof option.description === "string" ? { description: option.description } : {}),
                };
              }),
            }
          : {}),
        ...(record(question.customAnswer).enabled === true ? { isOther: true } : {}),
        ...(typeof validation.minLength === "number" ? { minLength: validation.minLength } : {}),
        ...(typeof validation.maxLength === "number" ? { maxLength: validation.maxLength } : {}),
      };
    }),
  };
}

export interface CapabilityRunnerdProcessEvidence {
  runnerPid: number | null;
  runnerProcessGroupId: number | null;
  providerPid: number | null;
  codexPid: number | null;
  sidecarPid: number | null;
  agentPid: number | null;
  providerDriver: string | null;
  providerVersion: string | null;
  acpxAgent: QualifiedAcpxAgent | null;
  agentServerVersion: string | null;
  agentRuntimeVersion: string | null;
  acpProtocolVersion: number | null;
  providerExecutionKind: "local_process" | "remote_service" | null;
  providerService:
    "anthropic_managed_agents" | "aws_bedrock_agentcore_harness" | null;
  runnerExited: boolean;
  runnerExitCode: number | null;
  runnerSignal: NodeJS.Signals | null;
  childEnvironmentKeys: string[];
  diagnostics: string[];
}

export interface CapabilityRunnerdCodexTransportOptions {
  provider?: "codex" | "opencode" | "acpx";
  acpxAgent?: QualifiedAcpxAgent;
  acpxPermissionMode?: NativeAcpxPermissionMode;
  acpxPermissionModePinned?: boolean;
  acpxSidecarPath?: string;
  /** Node executable in the runner filesystem; required for remote JS providers. */
  providerNodeCommand?: string;
  acpxRuntimeDirectory?: string;
  runnerBinary?: string;
  codexCommand?: string;
  codexArgs?: string[];
  /** Controller-visible Codex home used only to seed the isolated runner home. */
  sourceCodexHome?: string | null;
  opencodeCommand?: string;
  opencodeProxyPath?: string;
  opencodeRuntimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  onDiagnostic?: (message: string) => void;
  onEvidence?: (evidence: Readonly<CapabilityRunnerdProcessEvidence>) => void;
  stateDirectory?: string;
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  /** Runtime-context paths rewritten for the runner-owned filesystem. */
  runnerRuntimeContext?: NativeRuntimeContextSnapshot | null;
  /** Root path visible to runnerd when it is not on the Paperclip host. */
  runnerFilesystemRoot?: string;
  /** Current run's authority catalog, used when a suspended session is rebound. */
  resumeDynamicTools?: readonly Readonly<Record<string, unknown>>[];
  /** Provider turn recorded by the owner checkpoint when restoring an active run. */
  resumeActiveTurnId?: string | null;
  /** Explicitly permits ACPX to rotate its provider-native session after a governed wait. */
  providerRecoveryPolicy?:
    | "same_session_only"
    | "allow_replacement_after_resume_failure"
    | "allow_replacement_after_governed_wait";
  prpIdentity?: {
    runnerInstanceId: string;
    environmentLeaseId: string;
    runId: string;
    normalizedSessionId: string;
    turnId: string;
    itemId: string;
  };
  /** Registers the run-bound PRP authority on Paperclip's shared HTTP server. */
  controlPlaneRegistration?: (authority: DurablePrpControlPlane) => Promise<{
    connectUrl?: string;
    connection?: RunnerProcessConnection;
    activate?: () => Promise<void> | void;
    ready?: () => Promise<void>;
    failure?: Promise<never>;
    startupFailureCode?:
      | "runner_local_connect_failed"
      | "runner_direct_wss_failed"
      | "runner_ingress_unavailable";
    release: () => Promise<void> | void;
  }>;
  /** Optional remote process owner used only by the new runner coordinator. */
  runnerProcessLauncher?: (
    spec: RunnerProcessLaunchSpec,
  ) => RunnerProcessHandle;
  /** Durable runner state path in the process owner's filesystem. */
  runnerStateDirectory?: string;
  /** Read the live durable runner state when runnerd owns a remote filesystem. */
  readRunnerState?: () => Promise<Record<string, unknown>>;
  /** Active-connection recovery budget. Omitted for the existing local mode. */
  runnerReconnectGraceMs?: number;
}

export type RunnerdCodexTransportOptions =
  CapabilityRunnerdCodexTransportOptions;

export interface CapabilityRunnerdCodexTransport {
  transport: CodexAppServerTransport;
  evidence(): Readonly<CapabilityRunnerdProcessEvidence>;
}

export type RunnerdCodexTransport = CapabilityRunnerdCodexTransport;

export function unwrapRunnerdProviderNotifications(
  input: unknown,
): Record<string, unknown>[] {
  const payload = record(input);
  if (typeof payload.method === "string") return [payload];
  if (Array.isArray(payload.events)) {
    return payload.events
      .map(record)
      .filter((event) => typeof event.method === "string");
  }
  const latest = record(payload.latest);
  return typeof latest.method === "string" ? [latest] : [];
}

export function unwrapRunnerdProviderNotification(
  input: unknown,
): Record<string, unknown> {
  const notifications = unwrapRunnerdProviderNotifications(input);
  return notifications.at(-1) ?? record(input);
}

export function expandRunnerdCanonicalNotifications(
  method: string,
  input: unknown,
): Array<{ method: string; params: Record<string, unknown> }> {
  const payload = record(input);
  if (!Array.isArray(payload.events)) return [{ method, params: payload }];
  return payload.events.map((event) => ({ method, params: record(event) }));
}

export function resolveRunnerdSessionIdentity(input: unknown): {
  processId: number | null;
  threadId: string | null;
  sessionId: string | null;
} {
  const started = record(input);
  const runtimeIdentity = record(started.runtimeIdentity);
  const descriptor = record(started.providerDescriptor);
  const processId =
    runtimeIdentity.processId ??
    runtimeIdentity.process_id ??
    descriptor.processId ??
    started.processId ??
    started.pid;
  const threadId = started.threadId ?? started.providerSessionId;
  const sessionId = started.sessionId ?? started.providerAccountSessionId;
  return {
    processId: typeof processId === "number" ? processId : null,
    threadId:
      typeof threadId === "string" && threadId.length > 0 ? threadId : null,
    sessionId:
      typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null,
  };
}

class NotificationQueue implements AsyncIterable<CodexRpcNotification> {
  #values: Array<{ value: CodexRpcNotification; bytes: number }> = [];
  #waiters: Array<{
    resolve: (value: IteratorResult<CodexRpcNotification>) => void;
    reject: (error: Error) => void;
  }> = [];
  #bytes = 0;
  #closed = false;
  #error: Error | null = null;

  push(value: CodexRpcNotification): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (
      this.#values.length >= MAX_NOTIFICATION_COUNT ||
      this.#bytes + bytes > MAX_NOTIFICATION_BYTES
    ) {
      throw new Error("PRP provider notification queue bound exceeded");
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    this.#values = [];
    this.#bytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error !== null) waiter.reject(this.#error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#bytes -= queued.bytes;
          return { value: queued.value, done: false };
        }
        if (this.#error !== null) throw this.#error;
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolveValue, reject) =>
          this.#waiters.push({ resolve: resolveValue, reject }),
        );
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type PendingTraceRehydration = {
  sourceEventId: string;
  eventType: string;
  visibleNotificationCount: number;
};

type PendingDriverTraceInterpretation = CodexTraceInterpretation;

function locateRunnerdTraceFrame(
  tracePath: string,
  sourceEventId: string,
): { frameId: number | null; nativeChannelSettled: boolean } {
  const lines = readFileSync(tracePath, "utf8").split("\n");
  let frameId: number | null = null;
  let nativeChannelSettled = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]?.trim()) continue;
    const entry = record(JSON.parse(lines[index]!));
    if (entry.kind === "trace_status" && entry.debugChannel === "rust_native") {
      nativeChannelSettled = true;
    }
    if (
      entry.kind !== "interpretation" ||
      !Array.isArray(entry.emittedEventIds)
    ) {
      continue;
    }
    if ((entry.emittedEventIds as unknown[]).includes(sourceEventId)) {
      frameId = typeof entry.frameId === "number" ? entry.frameId : null;
      break;
    }
  }
  return { frameId, nativeChannelSettled };
}

function appendRunnerdRehydrationTrace(
  tracePath: string | undefined,
  sourceEventId: string,
  eventType: string,
  visibleNotificationCount: number,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = locateRunnerdTraceFrame(
      tracePath,
      sourceEventId,
    );
    if (frameId === null)
      return nativeChannelSettled ? "not_applicable" : "retry";
    appendFileSync(
      `${tracePath}.rehydration`,
      `${JSON.stringify({
        kind: "interpretation",
        schema: "paperclip.provider_trace_interpretation.v1",
        debugChannel: "typescript_runnerd_rehydration",
        debugSequence,
        frameId,
        stage: "typescript_runnerd_rehydration",
        ruleId: `runnerd.rehydrate.${eventType}`,
        disposition: visibleNotificationCount > 0 ? "mapped" : "ignored",
        emittedEventIds: [sourceEventId],
        droppedFields: [],
        fieldMappings: [
          {
            inputPath: "sourceEventId",
            outputPath: "paperclipTrace.sourceEventId",
            action: "copied",
            reason: "Preserved the durable event identity while rehydrating the provider notification",
          },
          {
            inputPath: "eventType",
            outputPath: "paperclipTrace.sourceEventType",
            action: "renamed",
            reason: "Attached the canonical PRP type to the rehydrated notification",
          },
        ],
        reason:
          visibleNotificationCount > 0
            ? "Canonical PRP event was rehydrated into the Codex driver notification contract"
            : "Canonical PRP event did not produce a Codex driver notification",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return "written";
  } catch {
    // Debug delivery is deliberately outside run authority and never fails it.
    return "retry";
  }
}

function appendCodexDriverInterpretationTrace(
  tracePath: string | undefined,
  input: PendingDriverTraceInterpretation,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = locateRunnerdTraceFrame(
      tracePath,
      input.sourceEventId,
    );
    if (frameId === null) {
      return nativeChannelSettled ? "not_applicable" : "retry";
    }
    appendFileSync(
      `${tracePath}.rehydration`,
      `${JSON.stringify({
        kind: "interpretation",
        schema: "paperclip.provider_trace_interpretation.v1",
        debugChannel: "typescript_runnerd_rehydration",
        debugSequence,
        frameId,
        stage: "typescript_codex_driver_normalization",
        ruleId: `codex_driver.normalize.${input.providerMethod}`,
        disposition: input.disposition,
        emittedEventIds: input.emittedEventIds,
        droppedFields: [],
        fieldMappings: [
          {
            inputPath: "params",
            outputPath: "payload",
            action: "normalized",
            reason: "Codex notification fields were normalized into canonical PRP event payloads",
          },
          ...input.emittedEventIds.map((eventId) => ({
            outputPath: `event:${eventId}`,
            action: "derived",
            reason: "The driver emitted this canonical PRP event from the normalized notification",
          })),
        ],
        reason: input.reason,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return "written";
  } catch {
    // Debug delivery is deliberately outside run authority and never fails it.
    return "retry";
  }
}

function appendRunnerdTraceStatus(
  tracePath: string,
  input: {
    status: "complete" | "incomplete";
    reason: string | null;
    debugSequence: number;
    acknowledgedDebugSequence: number;
  },
): void {
  appendFileSync(
    `${tracePath}.rehydration`,
    `${JSON.stringify({
      kind: "trace_status",
      debugChannel: "typescript_runnerd_rehydration",
      debugSequence: input.debugSequence,
      status: input.status,
      acknowledgedDebugSequence: input.acknowledgedDebugSequence,
      reason: input.reason,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function rehydrateRunnerdUsageNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  return {
    ...rawParams,
    // The normalized PRP usage event carries the provider session identity
    // rather than replaying the provider's original threadId field. Rehydrate
    // the Codex notification contract so the strict driver does not reject
    // valid accounting as a cross-thread event.
    // The strict facade is opened on the runner-owned harness thread. A
    // providerSessionId can be a distinct backend/agent session (ACPX is one
    // example), so it must remain metadata rather than become a thread bind.
    threadId: openedThreadId,
    turnId: activeTurnId,
    tokenUsage: {
      total: record(rawParams.cumulative),
      runDelta: record(rawParams.runDelta),
    },
  };
}

export function rehydrateRunnerdThreadTokenUsage(
  cumulative: unknown,
): { total: Record<string, unknown> } | null {
  const total = record(cumulative);
  return Object.keys(total).length === 0 ? null : { total };
}

export function rehydrateRunnerdResultNotification(
  result: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
  itemId: string,
): Record<string, unknown> {
  return {
    threadId: openedThreadId,
    // The durable controller turn belongs to the runner envelope, while a
    // protocol facade may expose a different provider-native turn. The result
    // is observed during the latter and must be bound to that active turn.
    turnId: activeTurnId,
    itemId,
    result,
  };
}

export function rehydrateRunnerdTurnNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
  method: "turn/started" | "turn/completed",
): Record<string, unknown> {
  const rawTurn = record(rawParams.turn);
  const providerTurnId =
    typeof rawParams.providerTurnId === "string" && rawParams.providerTurnId.length > 0
      ? rawParams.providerTurnId
      : null;
  const rawTurnId =
    providerTurnId ??
    (typeof rawTurn.id === "string" && rawTurn.id.length > 0
      ? rawTurn.id
      : typeof rawParams.turnId === "string" && rawParams.turnId.length > 0
        ? rawParams.turnId
        : activeTurnId);
  const boundTurnId =
    method === "turn/completed"
      ? providerTurnId ?? activeTurnId
      : rawTurnId;
  return {
    ...rawParams,
    // A canonical runnerd terminal is bound by the authenticated PRP envelope.
    // Its compact `turn.id` is the durable controller turn, not necessarily the
    // provider turn exposed by the Codex facade. Restore both strict bindings.
    threadId: openedThreadId,
    turnId: boundTurnId,
    turn: {
      ...rawTurn,
      id: boundTurnId,
      ...(rawTurn.status === undefined && rawParams.status !== undefined
        ? { status: rawParams.status }
        : {}),
    },
  };
}

export function rehydrateRunnerdItemNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  const rawItem = record(rawParams.item);
  return {
    ...rawParams,
    threadId: openedThreadId,
    turnId: activeTurnId,
    item: {
      ...rawItem,
      id: rawItem.id ?? rawParams.itemId,
      type: rawItem.type ?? rawParams.kind,
      status: rawItem.status ?? rawParams.status,
      text: rawItem.text ?? rawParams.text,
    },
  };
}

export function rehydrateRunnerdPlanNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  const steps = Array.isArray(rawParams.steps) ? rawParams.steps : [];
  return {
    ...rawParams,
    threadId: openedThreadId,
    turnId: activeTurnId,
    // Rust has already normalized the provider's plan entries into PRP's
    // { stepId, body, status } shape. Rebuild Codex's notification contract
    // so the strict TypeScript driver can perform (and expose) its second
    // interpretation stage instead of silently dropping the plan.
    plan: Array.isArray(rawParams.plan)
      ? rawParams.plan
      : steps.map((value) => {
          const step = record(value);
          return {
            step: typeof step.body === "string" ? step.body : "",
            status:
              typeof step.status === "string" ? step.status : "pending",
          };
        }),
  };
}

export function rehydrateRunnerdWorkspaceChangeNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  return {
    threadId: openedThreadId,
    turnId: activeTurnId,
    // Rust already parsed and bounded the complete Codex turn snapshot. Keep
    // that canonical value intact instead of consulting git or the workspace
    // again in the TypeScript driver.
    workspaceChange: structuredClone(rawParams),
  };
}

function commandDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(durableRecoveryInternals.canonicalJson(value)).digest("hex")}`;
}

function approvedRunnerArtifact(
  runnerBinaryPath: string,
): { version: string; digest: string } {
  return {
    version: RUNNER_CLIENT_VERSION,
    digest: `sha256:${createHash("sha256")
      .update(readFileSync(runnerBinaryPath))
      .digest("hex")}`,
  };
}

function authorizedToolSet(
  tools: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  const operations = tools
    .map((tool) => ({
      operationId: String(tool.name ?? ""),
      version: 1,
      description: String(tool.description ?? ""),
      inputSchema: record(tool.inputSchema),
      responseSchema: {},
    }))
    .sort((left, right) =>
      left.operationId < right.operationId
        ? -1
        : left.operationId > right.operationId
          ? 1
          : 0,
    );
  return {
    schema: "paperclip.runner.authorized-tools.v1",
    schemaVersion: 1,
    catalogDigest: commandDigest(operations),
    operations,
  };
}

/**
 * Raw provider tracing is consumed by runnerd itself. The provider child still
 * receives the narrower allowlist enforced by Rust's `SupervisedProcess`, so
 * these controller-selected sidecar paths never enter the harness process.
 */
function withRunnerdProviderTrace(
  environment: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const result = { ...environment };
  for (const key of [
    "PAPERCLIP_PROVIDER_TRACE_PATH",
    "PAPERCLIP_PROVIDER_TRACE_MAX_BYTES",
  ] as const) {
    const value = source?.[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function createCapabilityRunnerdProviderEnvironment(input: {
  provider: NonNullable<CapabilityRunnerdCodexTransportOptions["provider"]>;
  options: CapabilityRunnerdCodexTransportOptions;
  identity: DurableRecoveryIdentity;
  codexHome: string;
  runtimeContextPath: string;
  hasRuntimeContext: boolean;
}): NodeJS.ProcessEnv {
  const commonIdentity = {
    PAPERCLIP_RUNNER_INSTANCE_ID: input.identity.runnerInstanceId,
    PAPERCLIP_RUN_ID: input.identity.runId,
    PAPERCLIP_NORMALIZED_SESSION_ID: input.identity.normalizedSessionId,
    ...(input.hasRuntimeContext
      ? { PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH: input.runtimeContextPath }
      : {}),
  };
  if (input.provider === "opencode") {
    return {
      ...process.env,
      ...input.options.environment,
      PAPERCLIP_OPENCODE_COMMAND: input.options.opencodeCommand ?? "opencode",
      PAPERCLIP_OPENCODE_RUNTIME_DIR:
        input.options.opencodeRuntimeDirectory ??
        resolve(input.options.stateDirectory ?? tmpdir(), "opencode"),
      ...commonIdentity,
    };
  }
  if (input.provider === "acpx") {
    return {
      ...createSanitizedAcpxSpawnInput(
        input.options.environment,
        input.options.acpxAgent ?? "codex",
      ).env,
      ...commonIdentity,
      ...(input.options.providerRecoveryPolicy ===
      "allow_replacement_after_governed_wait"
        ? {
            PAPERCLIP_ACPX_PROVIDER_RECOVERY_POLICY:
              "allow_replacement_after_governed_wait",
          }
        : {}),
    };
  }
  const environment = createSanitizedCodexEnvironment({
    ...input.options.environment,
    HOME: input.codexHome,
    CODEX_HOME: input.codexHome,
  });
  for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY"] as const) {
    const apiKey = input.options.environment?.[key];
    if (apiKey?.trim()) environment[key] = apiKey;
  }
  return environment;
}

export function resolveSourceCodexHome(
  environment: NodeJS.ProcessEnv | undefined,
): string | null {
  const explicit = environment?.CODEX_HOME?.trim();
  if (explicit) return explicit;
  const home = environment?.HOME?.trim();
  return home ? resolve(home, ".codex") : null;
}

export function trustedRuntimeReadOnlyRoots(
  environment: NodeJS.ProcessEnv | undefined,
): string[] {
  const path = environment?.PATH ?? "";
  const roots = new Set<string>();
  for (const entry of path.split(process.platform === "win32" ? ";" : ":")) {
    if (entry === "/opt/homebrew" || entry.startsWith("/opt/homebrew/")) {
      roots.add("/opt/homebrew");
    } else if (entry === "/usr/local" || entry.startsWith("/usr/local/")) {
      roots.add("/usr/local");
    } else if (entry === "/opt/local" || entry.startsWith("/opt/local/")) {
      roots.add("/opt/local");
    } else if (entry === "/nix/store" || entry.startsWith("/nix/store/")) {
      roots.add("/nix/store");
    }
  }
  return [...roots];
}

function unwrapToolResponse(
  response: Record<string, unknown>,
): {
  readonly __paperclipSemanticToolOutcome: true;
  readonly result: unknown;
  readonly isError: boolean;
} {
  const items = Array.isArray(response.contentItems)
    ? response.contentItems
    : [];
  const value = record(items[0]).text;
  let result: unknown = response;
  try {
    if (typeof value === "string") result = JSON.parse(value);
  } catch {
    result = response;
  }
  return {
    __paperclipSemanticToolOutcome: true as const,
    result,
    isError: response.success === false,
  };
}

class DurablePrpCodexTransport implements CodexAppServerTransport {
  readonly #root: string;
  readonly #ownsRoot: boolean;
  readonly #queue = new NotificationQueue();
  readonly #startedAt = new Date().toISOString();
  readonly #evidence: CapabilityRunnerdProcessEvidence;
  #handler: CodexServerRequestHandler = async () => ({
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: "No Paperclip control-plane tool handler is installed.",
      },
    ],
  });
  #core: DurablePrpControlPlane | null = null;
  #handle: RunnerProcessHandle | null = null;
  #pump: NodeJS.Timeout | null = null;
  #eventIndex = 0;
  #threadId = "";
  #sessionId: string | null = null;
  #providerIdentity: Record<string, unknown> | null = null;
  #turnId = "";
  #durableTurnId = "";
  #authorizedTools: Record<string, unknown> | null = null;
  #closed = false;
  #failure: Error | null = null;
  readonly #failureSignal: Promise<never>;
  #rejectFailureSignal!: (error: Error) => void;
  #runnerRecoveryInProgress = false;
  #startupComplete = false;
  #startupFailureCode = "native_runner_process_exited";
  #controlPlaneRelease: (() => Promise<void> | void) | null = null;
  #nextTraceDebugSequence = 1;
  #traceRehydrationSpoolOverflow = false;
  #pendingTraceRehydrations: PendingTraceRehydration[] = [];
  #pendingDriverTraceInterpretations: PendingDriverTraceInterpretation[] = [];
  readonly #bridgedRuntimeInputs = new Map<string, { durableTurnId: string }>();

  constructor(readonly options: CapabilityRunnerdCodexTransportOptions) {
    if (options.provider === "acpx" && options.acpxAgent === "pi") {
      throw new Error("The Pi ACPX profile is not available");
    }
    this.#failureSignal = new Promise<never>((_resolve, reject) => {
      this.#rejectFailureSignal = reject;
    });
    // Failure is also observed by request/notification paths. Register an
    // internal handler so a process exit after the owner has closed the
    // session cannot become an unhandled process-level rejection.
    void this.#failureSignal.catch(() => undefined);
    this.#ownsRoot = options.stateDirectory === undefined;
    this.#turnId = options.resumeActiveTurnId ?? "";
    this.#root =
      options.stateDirectory ??
      mkdtempSync(resolve(tmpdir(), "paperclip-runner-lab-prp-"));
    if (options.resumeDynamicTools !== undefined) {
      this.#authorizedTools = authorizedToolSet([
        ...options.resumeDynamicTools,
        ...codexSemanticToolSpecs(),
      ]);
    }
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#evidence = {
      runnerPid: null,
      runnerProcessGroupId: null,
      providerPid: null,
      codexPid: null,
      sidecarPid: null,
      agentPid: null,
      providerDriver: null,
      providerVersion: null,
      acpxAgent: null,
      agentServerVersion: null,
      agentRuntimeVersion: null,
      acpProtocolVersion: null,
      providerExecutionKind: null,
      providerService: null,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: Object.keys(
        options.provider === "acpx"
          ? createSanitizedAcpxSpawnInput(
              options.environment,
              options.acpxAgent ?? "codex",
            ).env
          : createSanitizedCodexEnvironment(options.environment),
      ).sort(),
      diagnostics: ["lab transport selected authenticated durable PRP"],
    };
  }

  evidence(): CapabilityRunnerdProcessEvidence {
    return structuredClone(this.#evidence);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error("PRP Codex transport is closed");
    this.#throwIfFailed();
    if (method === "initialize") return { user: {} };
    if (method === "thread/start") return this.#start(params);
    if (method === "collaborationMode/list") {
      // runnerd negotiates the real Codex preset or the provider-proxy-owned
      // planning contract during session.open. This transport-level mask
      // confirms that closed boundary; turn/start remains runner-managed and
      // never forwards this sentinel to the outer TypeScript driver.
      return this.options.provider === undefined ||
        this.options.provider === "codex" ||
        this.options.provider === "opencode" ||
        this.options.provider === "acpx"
        ? {
            data: [
              {
                name: "Plan",
                mode: "plan",
                model: "runner-managed",
                reasoning_effort: null,
              },
            ],
          }
        : { data: [] };
    }
    if (method === "turn/start") return this.#startTurn(params);
    if (method === "turn/steer") {
      const input = Array.isArray(params.input) ? params.input.map(record) : [];
      const text = input
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("\n");
      const expectedTurnId =
        typeof params.expectedTurnId === "string"
          ? params.expectedTurnId
          : this.#turnId;
      if (!text.trim()) throw new Error("turn/steer requires a message");
      if (expectedTurnId !== this.#turnId)
        throw new Error("turn/steer named a stale turn");
      const correlationId =
        typeof params.correlationId === "string"
          ? params.correlationId
          : undefined;
      await this.#command(
        "turn.steer",
        {
          text,
          turnId: this.#durableTurnId,
          providerTurnId: expectedTurnId,
          ...(correlationId ? { correlationId } : {}),
        },
        correlationId,
      );
      return {};
    }
    if (method === "turn/interrupt") {
      await this.#command("turn.interrupt", params);
      return {};
    }
    if (method === "thread/read") {
      if (this.#core === null) await this.#resume();
      // An authenticated recovered runner has already restarted the provider
      // and emitted harness.ready with its exact durable thread identity. Ask
      // runnerd for its provider snapshot rather than reading its filesystem:
      // remote process owners need the same recovery contract as local ones.
      const snapshot = await this.#commandResult("session.snapshot", {});
      const activeProviderTurnId =
        typeof snapshot.activeProviderTurnId === "string" &&
        snapshot.activeProviderTurnId.length > 0
          ? snapshot.activeProviderTurnId
          : null;
      const recoveredTurns: Array<Record<string, unknown>> =
        activeProviderTurnId === null
          ? []
          : [{ id: activeProviderTurnId, status: "inProgress" }];
      if (activeProviderTurnId === null && this.#turnId.length > 0) {
        const recoveryDeadline = Date.now() + 5_000;
        let terminal = (
          this.#core?.store.state.committedEvents ?? []
        ).find(() => false);
        while (Date.now() < recoveryDeadline) {
          this.#throwIfFailed();
          this.#pumpEvents();
          terminal = [...(this.#core?.store.state.committedEvents ?? [])]
            .reverse()
            .find((event) => {
              if (
                event.eventType !== "turn.completed" &&
                event.eventType !== "turn.failed" &&
                event.eventType !== "turn.interrupted" &&
                event.eventType !== "turn.cancelled"
              ) return false;
              const payload = record(record(event.envelope.payload).payload);
              const providerTurnId =
                payload.providerTurnId ??
                payload.turnId ??
                record(payload.turn).id;
              return providerTurnId === this.#turnId;
            });
          if (terminal !== undefined) break;
          await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        }
        if (terminal !== undefined) {
          recoveredTurns.push({
            id: this.#turnId,
            status:
              terminal.eventType === "turn.completed"
                ? "completed"
                : terminal.eventType === "turn.interrupted"
                  ? "interrupted"
                  : terminal.eventType === "turn.cancelled"
                    ? "cancelled"
                    : "failed",
          });
        }
      }
      return {
        thread: {
          id: this.#threadId,
          sessionId: this.#sessionId,
          ...(this.#providerIdentity === null
            ? {}
            : { providerIdentity: structuredClone(this.#providerIdentity) }),
          cwd: this.options.runnerFilesystemRoot ?? tmpdir(),
          turns: recoveredTurns,
        },
      };
    }
    if (method === "session/budget/increase") {
      await this.#command("session.budget.increase", params);
      return {};
    }
    if (method === "session/destroy") {
      await this.#command("session.destroy", params);
      return {};
    }
    if (method === "thread/resume")
      return {
        thread: {
          id: this.#threadId,
          sessionId: this.#sessionId,
          ...(this.#providerIdentity === null
            ? {}
            : { providerIdentity: structuredClone(this.#providerIdentity) }),
        },
      };
    throw new Error(
      `PRP Codex transport does not expose provider method ${method}`,
    );
  }

  notify(_method: string, _params?: Record<string, unknown>): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.#queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    const pending = this.#bridgedRuntimeInputs.get(input.requestId);
    if (!pending) throw new Error(`PRP runtime request ${input.requestId} is no longer pending`);
    if (!("response" in input.resolution)) {
      throw new Error(
        "runnerd-native runtime requests require a canonical question response",
      );
    }
    const commandId = `command_runtime_input_${createHash("sha256")
      .update(`${input.requestId}:${pending.durableTurnId}`)
      .digest("hex")
      .slice(0, 24)}`;
    await this.#command(
      "request.resolve",
      {
        requestId: input.requestId,
        turnId: pending.durableTurnId,
        response: input.resolution.response,
      },
      commandId,
    );
  }

  recordTraceInterpretation(input: CodexTraceInterpretation): void {
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (!tracePath) return;
    const traceResult = appendCodexDriverInterpretationTrace(
      tracePath,
      input,
      this.#nextTraceDebugSequence,
    );
    if (traceResult === "written") {
      this.#nextTraceDebugSequence += 1;
    } else if (
      traceResult === "retry" &&
      this.#pendingDriverTraceInterpretations.length < 4_096
    ) {
      this.#pendingDriverTraceInterpretations.push(structuredClone(input));
    } else if (traceResult === "retry") {
      this.#traceRehydrationSpoolOverflow = true;
    }
  }

  processInfo(): CodexTransportProcessInfo {
    return {
      pid: this.#evidence.runnerPid,
      processGroupId: this.#evidence.runnerProcessGroupId,
      startedAt: this.#startedAt,
      exited: this.#evidence.runnerExited,
      exitCode: this.#evidence.runnerExitCode,
      signal: this.#evidence.runnerSignal,
    };
  }

  async #readDurableRunnerState(): Promise<Record<string, unknown>> {
    if (this.options.readRunnerState) return this.options.readRunnerState();
    return record(
      JSON.parse(
        readFileSync(
          resolve(this.#root, "runner", "runner-state.json"),
          "utf8",
        ),
      ),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#core !== null && this.#handle !== null) {
      const runnerAlreadyStopping =
        this.#handle.child.exitCode !== null ||
        this.#core.store.state.commands.some(
          (command) =>
            (command.type === "runner.suspend" ||
              command.type === "runner.shutdown") &&
            command.status === "pending",
        );
      // A terminal provider event settles the turn, but it does not stop the
      // runner process. Close therefore needs an explicit lifecycle command
      // unless one is already pending or the process has exited. Completed
      // lifecycle commands can belong to an earlier restored runner process.
      if (!runnerAlreadyStopping) {
        this.#core.queueCommand("runner.suspend", {}, undefined, true);
      }
      try {
        const result = await waitForProcess(
          this.#handle,
          this.options.closeGraceMs ?? 10_000,
        );
        this.#evidence.runnerExited = true;
        this.#evidence.runnerExitCode = result.code;
        this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
        if (result.stderr.trim())
          this.#diagnostic(result.stderr.trim().slice(-4_096));
      } catch (error) {
        this.#diagnostic(`runner shutdown failed: ${String(error)}`);
      }
    }
    this.#flushPendingTraceRehydrations();
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (tracePath) {
      const incomplete =
        this.#traceRehydrationSpoolOverflow ||
        this.#pendingTraceRehydrations.length > 0 ||
        this.#pendingDriverTraceInterpretations.length > 0;
      const debugSequence = this.#nextTraceDebugSequence++;
      try {
        appendRunnerdTraceStatus(tracePath, {
          status: incomplete ? "incomplete" : "complete",
          reason: incomplete
            ? this.#traceRehydrationSpoolOverflow
              ? "typescript_rehydration_spool_full"
              : "typescript_rehydration_correlation_incomplete"
            : null,
          debugSequence,
          acknowledgedDebugSequence: debugSequence - 1,
        });
      } catch {
        // Raw trace failure is intentionally independent of run authority.
      }
      this.#pendingTraceRehydrations = [];
      this.#pendingDriverTraceInterpretations = [];
    }
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    this.#queue.close();
    // Ensure a runner that missed or could not finish the graceful lifecycle
    // command cannot keep the control-plane server alive during teardown.
    this.#handle?.child.kill("SIGKILL");
    if (this.#controlPlaneRelease !== null) await this.#controlPlaneRelease();
    await this.#core?.stop();
    this.#controlPlaneRelease = null;
    if (this.#ownsRoot) rmSync(this.#root, { recursive: true, force: true });
    this.#publish();
  }

  async #start(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#core !== null)
      throw new Error("PRP provider thread is already started");
    const token = randomUUID().replaceAll("-", "");
    const identity = this.options.prpIdentity ?? {
      runnerInstanceId: `runner_lab_${token}`,
      environmentLeaseId: `lease_lab_${token}`,
      runId: `run_lab_${token}`,
      normalizedSessionId: `session_lab_${token}`,
      turnId: `turn_lab_${token}`,
      itemId: `item_lab_${token}`,
    };
    const runnerBinaryPath =
      this.options.runnerBinary ?? defaultCapabilityRunnerdBinary();
    const runnerArtifact = approvedRunnerArtifact(runnerBinaryPath);
    this.#durableTurnId = identity.turnId;
    const dynamicTools = Array.isArray(params.dynamicTools)
      ? params.dynamicTools.map(record)
      : [];
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(this.#root, "control-plane"),
      identity,
      expectedRunnerVersion: runnerArtifact.version,
      expectedRunnerDigest: runnerArtifact.digest,
      onSemanticToolInput: async (call) =>
        unwrapToolResponse(
          await this.#handler({
            id: call.callId,
            method: "item/tool/call",
            params: {
              threadId: this.#threadId,
              turnId: this.#turnId,
              callId: call.callId,
              tool: call.operationId,
              arguments: call.input,
            },
            ...(call.sourceEventId && call.sourceEventType
              ? {
                  paperclipTrace: {
                    sourceEventId: call.sourceEventId,
                    sourceEventType: call.sourceEventType,
                  },
                }
              : {}),
          }),
        ),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    mkdirSync(resolve(this.#root, "runner"), { recursive: true, mode: 0o700 });
    const provider = this.options.provider ?? "codex";
    const sourceRuntimeContext = this.options.runtimeContext ?? null;
    const runtimeContext =
      this.options.runnerRuntimeContext ?? sourceRuntimeContext;
    const localRuntimeContextPath = resolve(this.#root, "runtime-context.json");
    const runtimeContextPath = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "runtime-context.json")
      : localRuntimeContextPath;
    if (runtimeContext !== null) {
      writeFileSync(localRuntimeContextPath, `${JSON.stringify(runtimeContext)}\n`, { mode: 0o600 });
    }
    const localCodexHome = resolve(this.#root, "codex-home");
    const codexHome = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "codex-home")
      : localCodexHome;
    if (provider === "codex") {
      await prepareIsolatedCodexHome({
        context: sourceRuntimeContext,
        codexHome: localCodexHome,
        sourceCodexHome:
          this.options.sourceCodexHome ??
          resolveSourceCodexHome(this.options.environment),
        apiKey:
          this.options.environment?.CODEX_API_KEY ??
          this.options.environment?.OPENAI_API_KEY,
        nativeMcp: nativeMcpLaunchBinding(this.options.environment),
      });
    }
    const opencodeProxyPath =
      this.options.opencodeProxyPath ??
      fileURLToPath(
        new URL("../cli/opencode-app-server-proxy.js", import.meta.url),
      );
    const acpxSidecarPath =
      this.options.acpxSidecarPath ??
      fileURLToPath(new URL("../cli/acpx-runtime-sidecar.js", import.meta.url));
    const providerNodeCommand =
      this.options.providerNodeCommand ?? process.execPath;
    if (
      this.options.runnerFilesystemRoot
      && (provider === "opencode" || provider === "acpx")
    ) {
      const providerPaths = [
        ["provider Node", providerNodeCommand],
        ["OpenCode proxy", opencodeProxyPath],
        ["ACPX sidecar", acpxSidecarPath],
        ["OpenCode executable", this.options.opencodeCommand ?? "opencode"],
      ] as const;
      for (const [label, candidate] of providerPaths) {
        if (
          candidate.startsWith("/Users/")
          || /^[A-Za-z]:\\\\Users\\\\/.test(candidate)
        ) {
          throw new Error(
            `runner_remote_provider_artifact_incompatible: ${label} path belongs to the controller host`,
          );
        }
      }
      if (!this.options.providerNodeCommand) {
        throw new Error(
          "runner_remote_provider_artifact_incompatible: remote JS provider omitted its provider-pack Node executable",
        );
      }
      if (provider === "opencode" && !this.options.opencodeProxyPath) {
        throw new Error(
          "runner_remote_provider_artifact_incompatible: remote OpenCode omitted its packaged proxy",
        );
      }
      if (provider === "acpx" && !this.options.acpxSidecarPath) {
        throw new Error(
          "runner_remote_provider_artifact_incompatible: remote ACPX omitted its packaged sidecar",
        );
      }
    }
    this.#authorizedTools = authorizedToolSet(dynamicTools);
    const acpxAgent =
      provider === "acpx" ? (this.options.acpxAgent ?? "codex") : null;
    const requestedModel = typeof params.model === "string" ? params.model : "";
    const includeCodexCollaborationInstructions =
      provider === "codex" &&
      record(params.config).include_collaboration_mode_instructions !== false;
    const unboundBaseInstructions = String(
      params.baseInstructions ?? "You are a Paperclip agent.",
    );
    const baseInstructions =
      sourceRuntimeContext && runtimeContext
        ? unboundBaseInstructions.replaceAll(
            sourceRuntimeContext.instructions.bundle.rootPath,
            runtimeContext.instructions.bundle.rootPath,
          )
        : unboundBaseInstructions;
    const acpxProfile =
      provider === "acpx"
        ? resolveQualifiedAcpxProfile(acpxAgent!, requestedModel)
        : null;
    const completionContract = record(params.completionContract);
    core.queueCommand("run.prepare", {
      authorizedTools: this.#authorizedTools,
      ...(completionContract.revision
        && Array.isArray(completionContract.criterionIds)
        ? { completionContract }
        : {}),
      provider:
        provider === "acpx"
              ? {
                  kind: "acpx",
                  provider: "acpx",
                  driver: "acpx_runtime",
                  providerVersion: acpxProfile!.acpxVersion,
                  agent: acpxProfile!.agent,
                  model: requestedModel,
                  acpxVersion: acpxProfile!.acpxVersion,
                  agentServerPackage: acpxProfile!.agentServerPackage,
                  agentServerVersion: acpxProfile!.agentServerVersion,
                  agentRuntimePackage: acpxProfile!.agentRuntimePackage,
                  agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
                  commandDigest: acpxProfile!.commandDigest,
                  sidecarCommand: providerNodeCommand,
                  sidecarArgs: [acpxSidecarPath],
                  runtimeDirectory:
                    this.options.acpxRuntimeDirectory ??
                    resolve(this.#root, "acpx"),
                  normalizedSessionId: identity.normalizedSessionId,
                  runId: identity.runId,
                  cwd: String(params.cwd ?? tmpdir()),
                  instructions: baseInstructions,
                  permissionMode: this.options.acpxPermissionMode ?? "approve-all",
                  permissionModePinned: this.options.acpxPermissionModePinned ?? true,
                  runtimeContext,
                }
              : {
                  kind: provider,
                  provider,
                  driver:
                    provider === "opencode"
                      ? "opencode_server"
                      : "codex_app_server",
                  providerVersion:
                    provider === "opencode"
                      ? "1.18.17"
                      : "codex-app-server-v1",
                  command:
                    provider === "opencode"
                      ? providerNodeCommand
                      : (this.options.codexCommand ?? "codex"),
                  args:
                    provider === "opencode"
                      ? [opencodeProxyPath]
                      : (this.options.codexArgs ??
                        createIsolatedCodexAppServerArgs(
                          this.options.environment,
                          [
                            ...trustedRuntimeReadOnlyRoots(this.options.environment),
                            ...(runtimeContext ? [codexHome, runtimeContext.instructions.bundle.rootPath, ...runtimeContext.skills.map((skill) => skill.bundle.rootPath)] : []),
                          ],
                        )),
                  cwd: String(params.cwd ?? tmpdir()),
                  model: typeof params.model === "string" ? params.model : null,
                  approvalPolicy:
                    params.approvalPolicy === "on-request" || params.approvalPolicy === "untrusted"
                      ? params.approvalPolicy
                      : "never",
                  instructions:
                    provider === "codex"
                      ? withCodexCollaborationRuntimeInstructions(
                          baseInstructions,
                          includeCodexCollaborationInstructions,
                        )
                      : baseInstructions,
                  collaborationMode:
                    params.permissions ===
                    "paperclip-runner-workspace-read-only"
                      ? "plan"
                      : "default",
                  includeCollaborationModeInstructions:
                    includeCodexCollaborationInstructions,
                  includeSkillInstructions: provider === "codex" && runtimeContext !== null,
                  runtimeContext,
                },
    });
    core.queueCommand("session.open", { reuse: "same_session" });
    const registration = this.options.controlPlaneRegistration
      ? await this.options.controlPlaneRegistration(core)
      : null;
    this.#startupFailureCode =
      registration?.startupFailureCode ?? "runner_local_connect_failed";
    if (registration === null) await core.start();
    else this.#controlPlaneRelease = registration.release;
    const handle = spawnRunner({
      connection: registration?.connection ?? {
        mode: "connect",
        connectUrl: registration?.connectUrl ?? core.connectUrl,
      },
      stateDirectory:
        this.options.runnerStateDirectory ?? resolve(this.#root, "runner"),
      identity,
      ticket: core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
      maxOutboxBytes: 256 * 1024,
      p0ReserveBytes: 64 * 1024,
      maxRuntimeMs: 60 * 60 * 1_000,
      reconnectGraceMs: this.options.runnerReconnectGraceMs,
      lifecyclePolicy: this.options.lifecyclePolicy,
      runnerBinaryPath,
      runnerVersion: runnerArtifact.version,
      runnerDigest: runnerArtifact.digest,
      environment: withRunnerdProviderTrace(
        createCapabilityRunnerdProviderEnvironment({
          provider,
          options: {
            ...this.options,
            stateDirectory: this.#root,
            acpxAgent: acpxAgent ?? undefined,
          },
          identity,
          codexHome,
          runtimeContextPath,
          hasRuntimeContext: runtimeContext !== null,
        }),
        this.options.environment,
      ),
      processLauncher: this.options.runnerProcessLauncher,
    });
    this.#handle = handle;
    this.#watchRunner(handle);
    await registration?.activate?.();
    if (registration?.failure) {
      void registration.failure.catch((error: unknown) => {
        this.#failTransport(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    await this.#awaitRegistrationReady(registration?.ready);
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    await this.#waitCommand("run.prepare");
    await this.#waitCommand("session.open");
    await this.#waitForProviderIdentity();
    this.#startupComplete = true;
    this.#diagnostic("runnerd authenticated to the durable PRP control plane");
    return {
      thread: {
        id: this.#threadId,
        sessionId: this.#sessionId,
        ...(this.#providerIdentity === null
          ? {}
          : { providerIdentity: structuredClone(this.#providerIdentity) }),
        model: params.model,
        modelProvider:
          provider === "opencode" && typeof params.model === "string"
            ? params.model.split("/", 1)[0]
            : provider === "acpx"
              ? acpxAgent === "pi"
                ? "openrouter"
                : acpxAgent === "claude"
                  ? "anthropic"
                  : "openai"
              : "openai",
      },
    };
  }

  async #resume(): Promise<void> {
    const desiredIdentity = this.options.prpIdentity;
    if (
      desiredIdentity === undefined ||
      (this.options.readRunnerState === undefined &&
        !existsSync(resolve(this.#root, "runner", "runner-state.json")))
    ) {
      throw new Error("PRP provider resume state is unavailable");
    }
    const controlPlaneDirectory = resolve(this.#root, "control-plane");
    const identity = recoveredControlPlaneIdentity(
      controlPlaneDirectory,
      desiredIdentity,
    );
    if (
      identity.runId !== desiredIdentity.runId ||
      identity.turnId !== desiredIdentity.turnId ||
      identity.itemId !== desiredIdentity.itemId
    ) {
      // PRP identity is the authorization boundary for every command, event,
      // and semantic receipt. Reusing a provider process for another run needs
      // a crash-safe credential and durable-state rotation on both peers; do
      // not pretend that a provider-only attachment changed that authority.
      throw new Error("native_runner_prp_run_rotation_unavailable");
    }
    const runnerBinaryPath =
      this.options.runnerBinary ?? defaultCapabilityRunnerdBinary();
    const runnerArtifact = approvedRunnerArtifact(runnerBinaryPath);
    this.#durableTurnId = identity.turnId;
    const provider = this.options.provider ?? "codex";
    const sourceRuntimeContext = this.options.runtimeContext ?? null;
    const runtimeContext =
      this.options.runnerRuntimeContext ?? sourceRuntimeContext;
    const localRuntimeContextPath = resolve(this.#root, "runtime-context.json");
    const runtimeContextPath = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "runtime-context.json")
      : localRuntimeContextPath;
    if (runtimeContext !== null) {
      writeFileSync(localRuntimeContextPath, `${JSON.stringify(runtimeContext)}\n`, {
        mode: 0o600,
      });
    }
    const localCodexHome = resolve(this.#root, "codex-home");
    const codexHome = this.options.runnerFilesystemRoot
      ? resolve(this.options.runnerFilesystemRoot, "codex-home")
      : localCodexHome;
    if (provider === "codex") {
      // The prior process consumed a sealed, immutable copy. Rebuild that
      // copy from the authoritative runtime snapshot before a new provider is
      // launched; normal materialization still rejects arbitrary replacement.
      await releaseMaterializedNativeRuntimeSkills(
        resolve(localCodexHome, "skills"),
      );
      await prepareIsolatedCodexHome({
        context: sourceRuntimeContext,
        codexHome: localCodexHome,
        sourceCodexHome:
          this.options.sourceCodexHome ??
          resolveSourceCodexHome(this.options.environment),
        apiKey:
          this.options.environment?.CODEX_API_KEY ??
          this.options.environment?.OPENAI_API_KEY,
        nativeMcp: nativeMcpLaunchBinding(this.options.environment),
      });
    }
    const core = new DurablePrpControlPlane({
      stateDirectory: controlPlaneDirectory,
      identity,
      expectedRunnerVersion: runnerArtifact.version,
      expectedRunnerDigest: runnerArtifact.digest,
      onSemanticToolInput: async (call) =>
        unwrapToolResponse(
          await this.#handler({
            id: call.callId,
            method: "item/tool/call",
            params: {
              threadId: this.#threadId,
              turnId: this.#turnId,
              callId: call.callId,
              tool: call.operationId,
              arguments: call.input,
            },
            ...(call.sourceEventId && call.sourceEventType
              ? {
                  paperclipTrace: {
                    sourceEventId: call.sourceEventId,
                    sourceEventType: call.sourceEventType,
                  },
                }
              : {}),
          }),
        ),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    this.#eventIndex = core.store.state.committedEvents.length;
    const registration = this.options.controlPlaneRegistration
      ? await this.options.controlPlaneRegistration(core)
      : null;
    this.#startupFailureCode =
      registration?.startupFailureCode ?? "runner_local_connect_failed";
    if (registration === null) await core.start();
    else this.#controlPlaneRelease = registration.release;
    const handle = spawnRunner({
      connection: registration?.connection ?? {
        mode: "connect",
        connectUrl: registration?.connectUrl ?? core.connectUrl,
      },
      stateDirectory:
        this.options.runnerStateDirectory ?? resolve(this.#root, "runner"),
      identity,
      ticket: core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
      maxOutboxBytes: 256 * 1024,
      p0ReserveBytes: 64 * 1024,
      maxRuntimeMs: 60 * 60 * 1_000,
      reconnectGraceMs: this.options.runnerReconnectGraceMs,
      lifecyclePolicy: this.options.lifecyclePolicy,
      runnerBinaryPath,
      runnerVersion: runnerArtifact.version,
      runnerDigest: runnerArtifact.digest,
      environment: withRunnerdProviderTrace(
        createCapabilityRunnerdProviderEnvironment({
          provider,
          options: {
            ...this.options,
            stateDirectory: this.#root,
          },
          identity,
          codexHome,
          runtimeContextPath,
          hasRuntimeContext: runtimeContext !== null,
        }),
        this.options.environment,
      ),
      processLauncher: this.options.runnerProcessLauncher,
    });
    this.#handle = handle;
    this.#watchRunner(handle);
    await registration?.activate?.();
    if (registration?.failure) {
      void registration.failure.catch((error: unknown) => {
        this.#failTransport(
          error instanceof Error ? error : new Error(String(error)),
        );
      });
    }
    await this.#awaitRegistrationReady(registration?.ready);
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    await this.#waitForProviderIdentity();
    this.#startupComplete = true;
    this.#diagnostic(
      "runnerd restored its durable PRP session and provider thread",
    );
  }

  async #startTurn(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = Array.isArray(params.input) ? params.input.map(record) : [];
    const message = input
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .join("\n");
    const pendingTurnId = `turn_lab_${randomUUID().replaceAll("-", "")}`;
    this.#turnId = pendingTurnId;
    await this.#command("turn.start", { text: message });
    // Command completion only means runnerd accepted the command. Codex assigns
    // the authoritative turn identity in the subsequent turn/started event, so
    // do not expose the temporary transport identity to the strict driver.
    const deadline = Date.now() + 30_000;
    while (this.#turnId === pendingTurnId && Date.now() < deadline) {
      this.#throwIfFailed();
      this.#pumpEvents();
      if (this.#turnId !== pendingTurnId) break;
      if (this.#handle?.child.exitCode !== null)
        throw new Error("runnerd exited before provider turn startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (this.#turnId === pendingTurnId)
      throw new Error("runnerd did not report the provider turn identity");
    return { turn: { id: this.#turnId, status: "inProgress" } };
  }

  async #command(
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = correlationId
      ? `command_steer_${createHash("sha256")
          .update(`${this.#durableTurnId}:${correlationId}`)
          .digest("hex")
          .slice(0, 32)}`
      : `command_lab_${randomUUID().replaceAll("-", "")}`;
    const existing = core.store.state.commands.find(
      (command) => command.commandId === commandId,
    );
    if (existing) {
      if (
        existing.type !== type ||
        durableRecoveryInternals.canonicalJson(existing.payload) !==
          durableRecoveryInternals.canonicalJson(payload)
      ) {
        throw new Error(
          `PRP steering correlation ${correlationId} was reused with different content`,
        );
      }
    } else {
      core.queueCommand(type, payload, commandId, true);
    }
    await this.#waitCommand(type, commandId);
  }

  async #commandResult(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = `command_lab_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(type, payload, commandId, true);
    await this.#waitCommand(type, commandId);
    const command = core.store.state.commands.find(
      (candidate) => candidate.commandId === commandId,
    );
    if (command?.status !== "completed") {
      throw new Error(`PRP command ${type} omitted its durable result`);
    }
    return record(record(command.result).result);
  }

  async #waitForProviderIdentity(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      this.#pumpEvents();
      if (
        this.#threadId.length > 0 &&
        (this.#evidence.providerExecutionKind === "remote_service" ||
          this.#evidence.providerPid !== null)
      )
        return;
      if (this.#handle?.child.exitCode !== null)
        throw new Error("runnerd exited before provider startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("runnerd did not report its provider identity");
  }

  async #waitCommand(type: string, commandId?: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      const command = this.#core?.store.state.commands.find((candidate) =>
        commandId === undefined
          ? candidate.type === type
          : candidate.commandId === commandId,
      );
      if (command?.status === "completed") return;
      if (command !== undefined && command.status !== "pending") {
        throw new Error(
          `PRP command ${type} ${command.status}: ${JSON.stringify(command.result)}`,
        );
      }
      if (this.#handle?.child.exitCode !== null)
        throw new Error(`runnerd exited while waiting for ${type}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(
      `${this.#startupComplete ? "provider_transport_failed" : this.#startupFailureCode}: PRP command ${type} timed out`,
    );
  }

  #pumpEvents(): void {
    this.#flushPendingTraceRehydrations();
    const events = this.#core?.store.state.committedEvents ?? [];
    while (this.#eventIndex < events.length) {
      const event = events[this.#eventIndex++];
      if (
        event.eventType === "harness.ready" ||
        event.eventType === "session.started" ||
        event.eventType === "session.resumed"
      ) {
        const started = record(record(event.envelope.payload).payload);
        const runtimeIdentity = record(started.runtimeIdentity);
        const descriptor = record(started.providerDescriptor);
        const {
          processId: pid,
          threadId,
          sessionId,
        } = resolveRunnerdSessionIdentity(started);
        const providerIdentity = record(started.providerIdentity);
        if (pid !== null) {
          this.#evidence.providerPid = pid;
          if (descriptor.driver === "acpx_runtime")
            this.#evidence.sidecarPid = pid;
          else this.#evidence.codexPid = pid;
        }
        if (typeof descriptor.driver === "string")
          this.#evidence.providerDriver = descriptor.driver;
        if (typeof descriptor.providerVersion === "string")
          this.#evidence.providerVersion = descriptor.providerVersion;
        if (
          descriptor.agent === "pi" ||
          descriptor.agent === "claude" ||
          descriptor.agent === "codex"
        )
          this.#evidence.acpxAgent = descriptor.agent;
        if (typeof descriptor.agentServerVersion === "string")
          this.#evidence.agentServerVersion = descriptor.agentServerVersion;
        if (typeof descriptor.agentRuntimeVersion === "string")
          this.#evidence.agentRuntimeVersion = descriptor.agentRuntimeVersion;
        if (typeof descriptor.acpProtocolVersion === "number")
          this.#evidence.acpProtocolVersion = descriptor.acpProtocolVersion;
        if (typeof descriptor.agentProcessId === "number")
          this.#evidence.agentPid = descriptor.agentProcessId;
        if (
          runtimeIdentity.executionKind === "local_process" ||
          runtimeIdentity.executionKind === "remote_service"
        ) {
          this.#evidence.providerExecutionKind = runtimeIdentity.executionKind;
        }
        if (runtimeIdentity.service === "anthropic_managed_agents") {
          this.#evidence.providerService = "anthropic_managed_agents";
        } else if (
          runtimeIdentity.service === "aws_bedrock_agentcore_harness"
        ) {
          this.#evidence.providerService = "aws_bedrock_agentcore_harness";
        }
        if (threadId !== null) this.#threadId = threadId;
        if (sessionId !== null) this.#sessionId = sessionId;
        if (typeof providerIdentity.kind === "string") {
          this.#providerIdentity = structuredClone(providerIdentity);
        }
        this.#publish();
        continue;
      }
      if (event.eventType === "harness.diagnostic") {
        const diagnostic = record(record(event.envelope.payload).payload);
        if (
          diagnostic.providerMethod === "acpx/process" &&
          diagnostic.role === "acp_agent" &&
          typeof diagnostic.pid === "number"
        ) {
          this.#evidence.agentPid = diagnostic.pid;
          this.#publish();
        }
      }
      if (event.eventType === "runtime_request.created") {
        const request = record(record(event.envelope.payload).payload).request;
        const normalizedRequest = record(request);
        const requestId = typeof normalizedRequest.requestId === "string"
          ? normalizedRequest.requestId
          : "";
        const origin = record(normalizedRequest.origin);
        const method = typeof origin.method === "string" ? origin.method : "";
        const params = bridgedCodexQuestionParams(normalizedRequest, method, this.#threadId, this.#turnId);
        if (
          requestId &&
          params &&
          (method === "item/tool/requestUserInput" ||
            method === "tool/requestUserInput" ||
            method === "mcpServer/elicitation/request") &&
          !this.#bridgedRuntimeInputs.has(requestId)
        ) {
          this.#bridgedRuntimeInputs.set(requestId, {
            durableTurnId: typeof event.envelope.turnId === "string"
              ? event.envelope.turnId
              : this.#durableTurnId,
          });
          void this.#handler({
            id: requestId,
            method,
            params,
            paperclipTrace: {
              sourceEventId: event.sourceEventId,
              sourceEventType: event.eventType,
            },
          }).catch((error) => {
            this.#failTransport(error instanceof Error ? error : new Error(String(error)));
          });
        }
        continue;
      }
      if (
        event.eventType === "runtime_request.resolved" ||
        event.eventType === "runtime_request.cancelled" ||
        event.eventType === "runtime_request.expired"
      ) {
        const requestId = record(record(event.envelope.payload).payload).requestId;
        if (typeof requestId === "string") this.#bridgedRuntimeInputs.delete(requestId);
        continue;
      }
      const eventPayload = record(event.envelope.payload).payload;
      const sessionUpdatePayload = record(eventPayload);
      const canonicalMethod = (
        {
          "turn.started": "turn/started",
          "item.started": "item/started",
          "item.delta": "item/agentMessage/delta",
          "item.completed": "item/completed",
          "turn.completed": "turn/completed",
          "turn.failed": "turn/completed",
          "turn.interrupted": "turn/completed",
          "turn.cancelled": "turn/completed",
          "usage.reported": "thread/tokenUsage/updated",
          "plan.updated": "turn/plan/updated",
          "workspace.change.updated": "paperclip/workspaceChange/updated",
          "run.result.proposed": "paperclip/runResult",
          "session.updated":
            sessionUpdatePayload.status === "budget_reached"
              ? "provider/budgetReached"
              : "provider/sessionUpdated",
        } as Record<string, string>
      )[event.eventType];
      const notifications =
        event.eventType === "provider.event"
          ? unwrapRunnerdProviderNotifications(eventPayload)
          : canonicalMethod
            ? expandRunnerdCanonicalNotifications(canonicalMethod, eventPayload)
            : [];
      for (const payload of notifications) {
        const method = payload.method;
        if (typeof method !== "string") continue;
        const rawParams = record(payload.params);
        const params =
          method === "thread/tokenUsage/updated"
            ? rehydrateRunnerdUsageNotification(
                rawParams,
                this.#threadId,
                this.#turnId,
              )
            : method === "turn/plan/updated"
              ? rehydrateRunnerdPlanNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                )
            : method === "paperclip/workspaceChange/updated"
              ? rehydrateRunnerdWorkspaceChangeNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                )
            : method === "paperclip/runResult"
              ? rehydrateRunnerdResultNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                  typeof event.envelope.itemId === "string"
                    ? event.envelope.itemId
                    : "semantic-result",
                )
            : event.eventType !== "provider.event" &&
                (method === "item/started" || method === "item/completed")
              ? rehydrateRunnerdItemNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                )
            : event.eventType !== "provider.event" &&
                (method === "turn/started" || method === "turn/completed")
              ? rehydrateRunnerdTurnNotification(
                  rawParams,
                  this.#threadId,
                  this.#turnId,
                  method,
                )
              : rawParams;
        if (
          params.turnId === undefined &&
          typeof event.envelope.turnId === "string"
        ) {
          params.turnId = event.envelope.turnId;
        }
        // Only the canonical start establishes provider turn identity. Other
        // normalized events inherit the durable controller turn from the PRP
        // envelope; allowing one of them to update this binding would replace
        // the provider-native id before its terminal is rehydrated.
        if (method === "turn/started") {
          const providerTurnId = record(params.turn).id ?? params.turnId;
          if (typeof providerTurnId === "string" && providerTurnId.length > 0) {
            this.#turnId = providerTurnId;
          }
        }
        this.#queue.push({
          method,
          params,
          ...(this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH
            ? {
                paperclipTrace: {
                  sourceEventId: event.sourceEventId,
                  sourceEventType: event.eventType,
                },
              }
            : {}),
        });
      }
      if (this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH) {
        const pending = {
          sourceEventId: event.sourceEventId,
          eventType: event.eventType,
          visibleNotificationCount: notifications.length,
        };
        const traceResult = appendRunnerdRehydrationTrace(
          this.options.environment.PAPERCLIP_PROVIDER_TRACE_PATH,
          pending.sourceEventId,
          pending.eventType,
          pending.visibleNotificationCount,
          this.#nextTraceDebugSequence,
        );
        if (traceResult === "written") {
          this.#nextTraceDebugSequence += 1;
        } else if (
          traceResult === "retry" &&
          this.#pendingTraceRehydrations.length < 4_096
        ) {
          this.#pendingTraceRehydrations.push(pending);
        } else if (traceResult === "retry") {
          this.#traceRehydrationSpoolOverflow = true;
        }
      }
    }
  }

  #flushPendingTraceRehydrations(): void {
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (!tracePath) return;
    const retry: PendingTraceRehydration[] = [];
    for (const pending of this.#pendingTraceRehydrations) {
      const traceResult = appendRunnerdRehydrationTrace(
        tracePath,
        pending.sourceEventId,
        pending.eventType,
        pending.visibleNotificationCount,
        this.#nextTraceDebugSequence,
      );
      if (traceResult === "written") this.#nextTraceDebugSequence += 1;
      else if (traceResult === "retry") retry.push(pending);
    }
    this.#pendingTraceRehydrations = retry;

    const driverRetry: PendingDriverTraceInterpretation[] = [];
    for (const pending of this.#pendingDriverTraceInterpretations) {
      const traceResult = appendCodexDriverInterpretationTrace(
        tracePath,
        pending,
        this.#nextTraceDebugSequence,
      );
      if (traceResult === "written") this.#nextTraceDebugSequence += 1;
      else if (traceResult === "retry") driverRetry.push(pending);
    }
    this.#pendingDriverTraceInterpretations = driverRetry;
  }

  #pumpEventsSafely(): void {
    try {
      this.#pumpEvents();
    } catch (error) {
      this.#failTransport(
        new Error(
          `provider_transport_failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  #watchRunner(handle: RunnerProcessHandle): void {
    void handle.completion.then(
      (result) => {
        this.#evidence.runnerExited = true;
        this.#evidence.runnerExitCode = result.code;
        this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
        const detail = result.stderr.trim() || result.stdout.trim();
        if (detail) this.#diagnostic(detail.slice(-4_096));
        this.#publish();
        if (this.#closed || this.#handle !== handle) return;
        // A per-turn runner exits after its terminal suffix is durably ACKed.
        // Drain that suffix into the provider-facing queue before classifying
        // process completion; clean terminal exit is the expected lifecycle.
        this.#pumpEventsSafely();
        const expectedPerTurnExit =
          result.code === 0 &&
          (this.options.lifecyclePolicy?.mode ?? "per_turn") === "per_turn" &&
          (this.#core?.store.state.committedEvents.some(
            (event) =>
              event.eventType === "runner.suspending" ||
              event.eventType === "run.terminal",
          ) ?? false);
        if (expectedPerTurnExit) return;
        const code = /provider_frame_too_large|stdout frame exceeded/i.test(
          detail,
        )
          ? "provider_frame_too_large"
          : /runner_ingress_bind_conflict/i.test(detail)
            ? "runner_ingress_bind_conflict"
          : /transport_reconnect_grace_exceeded/i.test(detail)
            ? "transport_reconnect_grace_exceeded"
          : this.#startupComplete
            ? "native_runner_process_exited"
            : this.#startupFailureCode;
        if (
          code === "native_runner_process_exited" &&
          this.options.runnerReconnectGraceMs !== undefined &&
          handle.restart
        ) {
          void this.#recoverRunnerProcess(handle, detail);
          return;
        }
        this.#failTransport(
          new Error(
            `${code}: runnerd exited unexpectedly${result.code === null ? "" : ` with code ${result.code}`}${detail ? `: ${detail.slice(-1_000)}` : ""}`,
          ),
        );
      },
      (error) => {
        if (this.#closed || this.#handle !== handle) return;
        if (
          this.#startupComplete &&
          this.options.runnerReconnectGraceMs !== undefined &&
          handle.restart
        ) {
          void this.#recoverRunnerProcess(
            handle,
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
        this.#failTransport(
          new Error(
            `${this.#startupComplete ? "native_runner_process_exited" : this.#startupFailureCode}: runnerd process failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
    );
  }

  async #recoverRunnerProcess(
    failedHandle: RunnerProcessHandle,
    initialDetail: string,
  ): Promise<void> {
    if (
      this.#runnerRecoveryInProgress ||
      this.#closed ||
      this.#handle !== failedHandle ||
      this.#core === null ||
      !failedHandle.restart
    ) return;
    this.#runnerRecoveryInProgress = true;
    const graceMs = this.options.runnerReconnectGraceMs ?? 0;
    const deadline = Date.now() + graceMs;
    const delays = [250, 500, 1_000, 2_000, 5_000] as const;
    let attempt = 0;
    let restart = failedHandle.restart;
    let lastDetail = initialDetail;
    this.#diagnostic(
      `runner process disconnected; recovery is allowed for ${graceMs}ms`,
    );
    try {
      while (!this.#closed && Date.now() < deadline) {
        if (attempt > 0) {
          const base = delays[Math.min(attempt - 1, delays.length - 1)]!;
          const jittered = Math.max(
            1,
            Math.round(base * (0.75 + Math.random() * 0.5)),
          );
          await new Promise((resolveWait) => setTimeout(resolveWait, jittered));
        }
        if (this.#closed) return;
        if (Date.now() >= deadline) break;
        const priorConnectionCount = this.#core.store.state.connectionCount;
        let recoveredHandle: RunnerProcessHandle;
        try {
          recoveredHandle = restart(
            this.#core.issueBootstrapTicket(RUNNER_BOOTSTRAP_TICKET_TTL_MS),
          );
        } catch (error) {
          lastDetail = error instanceof Error ? error.message : String(error);
          attempt += 1;
          continue;
        }
        this.#handle = recoveredHandle;
        if (recoveredHandle.restart) restart = recoveredHandle.restart;
        this.#evidence.runnerExited = false;
        this.#evidence.runnerExitCode = null;
        this.#evidence.runnerSignal = null;
        this.#evidence.runnerPid = recoveredHandle.child.pid ?? null;
        this.#publish();

        let processSettled = false;
        const completion = recoveredHandle.completion.then(
          (result) => {
            processSettled = true;
            lastDetail = result.stderr.trim() || result.stdout.trim();
            return false;
          },
          (error) => {
            processSettled = true;
            lastDetail = error instanceof Error ? error.message : String(error);
            return false;
          },
        );
        const authenticated = (async () => {
          while (!processSettled && !this.#closed && Date.now() < deadline) {
            if (
              this.#core !== null &&
              this.#core.store.state.connectionCount > priorConnectionCount &&
              this.#core.activeRunnerConnectionCount() === 1
            ) return true;
            await new Promise((resolveWait) => setTimeout(resolveWait, 25));
          }
          return false;
        })();
        if (await Promise.race([completion, authenticated])) {
          this.#diagnostic("runner process restored its durable PRP session");
          this.#watchRunner(recoveredHandle);
          return;
        }
        attempt += 1;
      }
      if (!this.#closed) {
        this.#failTransport(
          new Error(
            `transport_reconnect_grace_exceeded: runner process recovery exceeded ${graceMs}ms${lastDetail ? `: ${lastDetail.slice(-1_000)}` : ""}`,
          ),
        );
      }
    } finally {
      this.#runnerRecoveryInProgress = false;
    }
  }

  #failTransport(error: Error): void {
    if (this.#failure !== null || this.#closed) return;
    this.#failure = error;
    this.#rejectFailureSignal(error);
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    this.#diagnostic(error.message);
    this.#queue.close(error);
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure;
  }

  async #awaitRegistrationReady(
    ready: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (ready === undefined) {
      this.#throwIfFailed();
      return;
    }
    await Promise.race([ready(), this.#failureSignal]);
    this.#throwIfFailed();
  }

  #diagnostic(message: string): void {
    this.#evidence.diagnostics.push(message);
    if (this.#evidence.diagnostics.length > 64)
      this.#evidence.diagnostics.shift();
    this.options.onDiagnostic?.(message);
    this.#publish();
  }

  #publish(): void {
    this.options.onEvidence?.(this.evidence());
  }
}

export function defaultCapabilityRunnerdBinary(): string {
  const staged = resolve(
    packageRoot,
    `dist/bin/paperclip-runnerd${executableSuffix}`,
  );
  if (existsSync(staged)) return staged;
  return resolve(
    packageRoot,
    `runner/target/debug/paperclip-runnerd${executableSuffix}`,
  );
}

/** Starts an authenticated durable PRP authority, runnerd, and Codex provider transport. */
export function createCapabilityRunnerdCodexTransport(
  options: CapabilityRunnerdCodexTransportOptions = {},
): CapabilityRunnerdCodexTransport {
  const transport = new DurablePrpCodexTransport(options);
  return { transport, evidence: () => transport.evidence() };
}

export const createRunnerdCodexTransport =
  createCapabilityRunnerdCodexTransport;
