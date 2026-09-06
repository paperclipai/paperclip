#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

import type {
  AcpElicitationContext,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpRuntimeEvent,
} from "acpx/runtime";

import { createAcpxToolEventNormalizer } from "../provider-events.js";
import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../contracts/completion-result.js";
import {
  parseHarnessRuntimeRequestResolution,
  type HarnessRuntimeRequestResolution,
} from "../contracts/harness-driver.js";
import {
  normalizeAcpFormElicitation,
  type NormalizedAcpForm,
} from "../drivers/acpx/acp-question-adapter.js";
import { openCodexAcpxRuntime } from "../drivers/acpx/codex-runtime-adapter.js";
import { acpxProviderSessionIdentity } from "../drivers/acpx/recovery-identity.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../drivers/acpx/qualified-profiles.js";
import {
  AcpxRuntimeHost,
  type AcpxRetainedCleanupFailure,
  type AcpxRuntimeTurn,
} from "../drivers/acpx/runtime-host.js";
import {
  ACPX_SIDECAR_MAX_FRAME_BYTES,
  ACPX_SIDECAR_PROTOCOL_VERSION,
  boundedSidecarText,
  boundedSidecarValue,
  frameAcpxToolClassification,
  parseAcpxSidecarRequest,
  record,
  sanitizeAcpxPlanEntries,
  stringifyAcpxSidecarFrame,
  text,
  type AcpxExpectedSessionIdentity,
  type AcpxSidecarEvent,
  type AcpxSidecarOpenParams,
  type AcpxSidecarRequest,
  type AcpxSidecarResponse,
} from "../drivers/acpx/sidecar-protocol.js";
import { safeAcpxLocations } from "./acpx-sidecar-locations.js";
import { validatePrpStructuredRunResult } from "../protocol/replay-contract.js";
import type { RunnerToolCall } from "../drivers/runner-tool-bridge.js";
import {
  acpxBootstrapBlockedError,
  acpxSidecarErrorCode,
  enqueueAcpxSidecarInput,
  recordAcpxBootstrapFailure,
} from "./acpx-sidecar-input.js";
import {
  boundedIdentity,
  closeSidecarHostForCommand,
  combineSidecarAdmissionCleanups,
  hasSidecarSessionOwnership,
  observeSidecarCleanupWithin,
  parseAcpxRunAttachment,
  readSidecarHostStatusWithin,
  recoverAndCombineSidecarHostCleanup,
  reportAuthoritativeSidecarHostCleanupFailure,
  requireSidecarCommandHost,
  verifyOpenedAcpxSidecarHost,
} from "./acpx-sidecar-lifecycle.js";

const MAX_PENDING_TOOLS = 512;
const MAX_PENDING_INPUTS = 16;

function reportRetainedAcpxCleanupFailure(
  input: AcpxRetainedCleanupFailure,
): void {
  const errorName = input.error instanceof Error ? input.error.name : "Error";
  process.emitWarning(
    JSON.stringify({
      schema: "paperclip.runner.retained_cleanup_failure.v1",
      resource: input.resource,
      attempt: input.attempt,
      errorName,
    }),
    {
      code: "PAPERCLIP_ACPX_RETAINED_CLEANUP_FAILURE",
      type: "PaperclipRunnerCleanupWarning",
    },
  );
}

interface PendingTool {
  turnId: string;
  settle(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

interface PendingInput {
  turnId: string;
  normalized: NormalizedAcpForm;
  settle(response: AcpElicitationResponse): void;
  cleanup(): void;
}

let host: AcpxRuntimeHost | null = null;
let activeHostCleanup: Promise<void> | null = null;
let failedAdmissionCleanup: Promise<void> | null = null;
let openParams: AcpxSidecarOpenParams | null = null;
let runId: string | null = null;
let turnId: string | null = null;
let sequence = 0;
let requestSequence = 0;
let closing = false;
let shutdownRequested = false;
let pendingInput = Promise.resolve();
let bootstrapFailure: Error | null = null;
let initializedAgent: QualifiedAcpxAgent | null = null;
let initializedModel: string | null = null;
let inputClosed = false;
const tools = new Map<string, PendingTool>();
const inputs = new Map<string, PendingInput>();

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
lines.on("line", (line) => {
  pendingInput = enqueueAcpxSidecarInput(
    pendingInput,
    () => receiveLine(line),
    (error) => diagnostic("sidecar_input_failed", safeMessage(error)),
  );
});
lines.on("close", () => {
  inputClosed = true;
  requestShutdown("sidecar stdin closed");
});
process.once("SIGTERM", () => {
  requestShutdown("sidecar received SIGTERM");
});
process.once("SIGINT", () => {
  requestShutdown("sidecar received SIGINT");
});

function requestShutdown(reason: string): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (!inputClosed) lines.pause();
  pendingInput = enqueueAcpxSidecarInput(
    pendingInput,
    () => shutdown(reason),
    (error) => diagnostic("sidecar_shutdown_failed", safeMessage(error)),
  );
}

async function receiveLine(line: string): Promise<void> {
  if (shutdownRequested) return;
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > ACPX_SIDECAR_MAX_FRAME_BYTES) {
    diagnostic("oversized_frame", "Rejected an oversized sidecar request.");
    return;
  }
  let request: AcpxSidecarRequest;
  try {
    request = parseAcpxSidecarRequest(JSON.parse(line));
  } catch (error) {
    diagnostic("malformed_frame", safeMessage(error));
    return;
  }
  try {
    const blocked = acpxBootstrapBlockedError(
      bootstrapFailure,
      request.command,
    );
    if (blocked) throw blocked;
    response(request.id, true, await dispatch(request));
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    const normalizedRecord = record(normalized);
    bootstrapFailure = recordAcpxBootstrapFailure(
      bootstrapFailure,
      request.command,
      normalized,
    );
    response(request.id, false, undefined, {
      code: safeCode(
        acpxSidecarErrorCode(normalized),
        "acpx_sidecar_command_failed",
      ),
      message: safeMessage(normalized),
      retryable: normalizedRecord.retryable === true,
    });
  }
}

async function dispatch(
  request: AcpxSidecarRequest,
): Promise<Record<string, unknown>> {
  if (request.command === "initialize") {
    if (initializedModel)
      throw new Error("ACPX sidecar is already initialized");
    const agent = requireQualifiedAgent(request.params.agent);
    const model = requiredText(request.params.model, "model");
    const profile = resolveQualifiedAcpxProfile(agent, model);
    initializedAgent = agent;
    initializedModel = model;
    return {
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      sidecarPid: process.pid,
      profile,
      capabilities: {
        persistentSessions: true,
        exactModelVerification: true,
        permissions: "runner_policy",
        semanticTools: "runner_bridge",
        structuredInput: "paperclip.question_set.v1",
      },
    };
  }
  if (request.command === "session.open") {
    if (
      hasSidecarSessionOwnership(
        host,
        activeHostCleanup,
        failedAdmissionCleanup,
      )
    ) {
      throw new Error("ACPX sidecar already owns a session or its cleanup");
    }
    if (!initializedModel) throw new Error("initialize the ACPX sidecar first");
    const params = parseOpenParams(request.params);
    if (
      params.agent !== initializedAgent ||
      params.model !== initializedModel
    ) {
      throw new Error("ACPX session profile differs from its initialization");
    }
    const openedHost = await AcpxRuntimeHost.open(
      {
        runtimeDirectory: params.runtimeDirectory,
        normalizedSessionId: params.normalizedSessionId,
        workingDirectory: params.workingDirectory,
        agent: params.agent,
        model: params.model,
        permissionMode: params.permissionMode,
        systemInstructions: params.systemInstructions,
        environment: process.env,
        expectedIdentity: params.expectedIdentity,
        semanticTools: {
          tools: params.tools,
          handler: waitForTool,
        },
      },
      {
        retainAdmissionCleanup: retainFailedAdmissionCleanup,
        reportRetainedCleanupFailure: reportRetainedAcpxCleanupFailure,
        openRuntime: (options) =>
          openCodexAcpxRuntime(options, {
            retainCleanup: retainFailedAdmissionCleanup,
          }),
      },
    );
    const opened = await verifyOpenedAcpxSidecarHost(
      openedHost,
      sanitizeRuntimeStatus,
      undefined,
      retainFailedAdmissionCleanup,
    );
    host = openedHost;
    openParams = params;
    emit("runtime.process", {
      role: "sidecar",
      pid: process.pid,
      processGroupId: null,
      startedAt: new Date().toISOString(),
    });
    return {
      identity: acpxProviderSessionIdentity(
        openedHost.identity(),
        openedHost.binding(),
      ),
      sidecarPid: process.pid,
      status: opened.status,
    };
  }
  if (request.command === "run.attach") {
    requireHost();
    if (turnId) throw new Error("cannot attach a run during an active turn");
    const attachedTools = parseTools(request.params.tools);
    if (
      canonicalJson(attachedTools) !== canonicalJson(openParams?.tools ?? [])
    ) {
      throw new Error("ACPX run tool catalog differs from the opened session");
    }
    const attachment = parseAcpxRunAttachment(request.params);
    runId = attachment.runId;
    return {
      runId: attachment.runId,
      catalogRevision: attachment.catalogRevision,
    };
  }
  if (request.command === "turn.start") {
    const activeHost = requireHost();
    if (!runId) throw new Error("attach a run before starting an ACPX turn");
    if (turnId) throw new Error("ACPX sidecar already has an active turn");
    const currentTurnId = boundedIdentity(request.params.turnId, "turnId");
    turnId = currentTurnId;
    let runtimeTurn: AcpxRuntimeTurn;
    try {
      runtimeTurn = activeHost.startTurn({
        requestId: `${runId}:${currentTurnId}`,
        text: boundedText(request.params.message, "message", 1024 * 1024),
        onElicitation: (providerRequest, context) =>
          waitForInput(currentTurnId, providerRequest, context),
      });
    } catch (error) {
      turnId = null;
      throw error;
    }
    void pumpTurn(currentTurnId, runtimeTurn);
    return { turnId: currentTurnId };
  }
  if (request.command === "turn.cancel") {
    const expected = boundedIdentity(request.params.turnId, "turnId");
    if (expected !== turnId) throw new Error("cannot cancel a stale ACPX turn");
    await requireHost().interruptActiveTurn(
      boundedOptionalText(
        request.params.reason,
        "Paperclip cancellation",
        4_000,
      ),
    );
    return { cancelled: true };
  }
  if (request.command === "permission.resolve") {
    throw new Error(
      "ACPX permissions are resolved by the admitted runner policy",
    );
  }
  if (request.command === "input.resolve") {
    const requestId = boundedIdentity(request.params.requestId, "requestId");
    const expectedTurnId = boundedIdentity(request.params.turnId, "turnId");
    const pending = inputs.get(requestId);
    if (
      !pending ||
      pending.turnId !== expectedTurnId ||
      turnId !== expectedTurnId
    ) {
      throw new Error("input request is stale or unknown");
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      "elicitation",
      request.params.resolution,
      pending.normalized.questionSet,
    );
    const providerResponse = elicitationResponse(
      pending.normalized,
      resolution,
    );
    if (!inputs.delete(requestId))
      throw new Error("input request lost its settlement race");
    pending.cleanup();
    pending.settle(providerResponse);
    return { resolved: true };
  }
  if (request.command === "tool.resolve") {
    const callId = boundedIdentity(request.params.callId, "callId");
    const expectedTurnId = boundedIdentity(request.params.turnId, "turnId");
    const pending = tools.get(callId);
    if (
      !pending ||
      pending.turnId !== expectedTurnId ||
      turnId !== expectedTurnId
    ) {
      throw new Error("tool call is stale or unknown");
    }
    if (!tools.delete(callId))
      throw new Error("tool call lost its settlement race");
    pending.cleanup();
    if (request.params.error) {
      pending.reject(
        new Error(
          safeText(
            text(record(request.params.error).message, "Paperclip tool failed"),
          ),
        ),
      );
    } else {
      pending.settle(structuredClone(request.params.result));
    }
    return { resolved: true };
  }
  if (request.command === "session.read") {
    const activeHost = requireHost();
    return {
      identity: acpxProviderSessionIdentity(
        activeHost.identity(),
        activeHost.binding(),
      ),
      status: sanitizeRuntimeStatus(
        await readSidecarHostStatusWithin(activeHost),
      ),
    };
  }
  if (request.command === "session.snapshot") {
    const activeHost = requireHost();
    return {
      identity: acpxProviderSessionIdentity(
        activeHost.identity(),
        activeHost.binding(),
      ),
      status: sanitizeRuntimeStatus(
        await readSidecarHostStatusWithin(activeHost),
      ),
      runId,
      turnId,
      sequence,
      pendingToolCount: tools.size,
      pendingInputCount: inputs.size,
    };
  }
  if (request.command === "session.suspend") {
    if (turnId || tools.size > 0 || inputs.size > 0) {
      throw new Error("ACPX session is not at a safe suspension point");
    }
    // Cleanup retries must be able to reach the retained host. The command is
    // still serialized, and retainActiveHostCleanup keeps admission closed
    // until one sequential close proves ownership was released.
    const activeHost = requireHost({ allowCleanupRetry: true });
    const identity = acpxProviderSessionIdentity(
      activeHost.identity(),
      activeHost.binding(),
    );
    await closeSidecarHostForCommand(
      activeHost,
      boundedOptionalText(request.params.reason, "Paperclip suspension", 4_000),
      undefined,
      (cleanup) => retainActiveHostCleanup(activeHost, cleanup),
    );
    host = null;
    openParams = null;
    runId = null;
    return { suspended: true, identity };
  }
  if (request.command === "session.close") {
    if (request.params.discardPersistentState === true) {
      throw new Error(
        "ACPX persistent state cannot be discarded by this sidecar",
      );
    }
    const closingTurnId = turnId;
    if (closingTurnId) rejectTurnWaiters(closingTurnId, "ACPX session closed");
    if (host) {
      const activeHost = host;
      await closeSidecarHostForCommand(
        activeHost,
        boundedOptionalText(request.params.reason, "Paperclip close", 4_000),
        undefined,
        (cleanup) => retainActiveHostCleanup(activeHost, cleanup),
      );
    }
    host = null;
    openParams = null;
    runId = null;
    turnId = null;
    return { closed: true, discarded: false };
  }
  throw new Error("unreachable ACPX sidecar command");
}

async function pumpTurn(
  currentTurnId: string,
  runtimeTurn: AcpxRuntimeTurn,
): Promise<void> {
  let terminal: Record<string, unknown>;
  try {
    // ACP tool updates are deltas. Preserve the opening event's identity and
    // display metadata for later progress/completion frames before they cross
    // the sidecar boundary, matching the in-process ACPX driver path.
    const normalizeToolEvent = createAcpxToolEventNormalizer<AcpRuntimeEvent>();
    for await (const event of runtimeTurn.events) {
      emit(
        "runtime.event",
        sanitizeRuntimeEvent(
          normalizeToolEvent(boundRuntimeEventForNormalization(event)),
        ),
        currentTurnId,
      );
    }
    const result = await runtimeTurn.result;
    terminal = boundedSidecarValue(result);
  } catch (error) {
    terminal = {
      status: "failed",
      error: { message: safeMessage(error), retryable: false },
    };
  } finally {
    rejectTurnWaiters(currentTurnId, "ACPX turn became terminal");
    if (turnId === currentTurnId) turnId = null;
  }
  // A terminal frame is also runnerd's permission to recycle this provider.
  // Publish it only after no callback can inherit this turn's mutable binding.
  emit("runtime.turn_terminal", terminal, currentTurnId);
}

async function waitForTool(call: RunnerToolCall): Promise<unknown> {
  const activeTurnId = turnId;
  if (!activeTurnId || call.signal.aborted) {
    throw new Error("ACPX tool call is not bound to an active turn");
  }
  const callId = boundedIdentity(call.callId, "callId");
  if (tools.has(callId)) throw new Error("ACPX tool call is duplicated");
  const operationId = boundedIdentity(call.tool, "operationId");
  if (
    operationId === PRP_COMPLETION_TOOL_NAME ||
    operationId === PRP_BLOCK_TOOL_NAME
  ) {
    const validation = validatePrpStructuredRunResult(call.arguments);
    if (!validation.ok) {
      throw new Error("ACPX semantic result failed PRP schema validation");
    }
    const blocked = validation.result.reportedWorkDisposition === "blocked";
    if (
      (operationId === PRP_BLOCK_TOOL_NAME && !blocked) ||
      (operationId === PRP_COMPLETION_TOOL_NAME && blocked)
    ) {
      throw new Error(
        "ACPX semantic result disposition does not match its terminal operation",
      );
    }
    // The authenticated runner bridge admitted this built-in invocation. Send
    // that fact across the sidecar boundary before its locally produced result
    // so runnerd can authorize and correlate the terminal claim.
    emit(
      "runtime.tool_called",
      {
        callId,
        operationId,
        input: validation.result,
      },
      activeTurnId,
    );
    emit(
      "runtime.event",
      {
        type: "semantic_result",
        callId,
        operationId,
        ok: true,
        result: validation.result,
      },
      activeTurnId,
    );
    return { accepted: true };
  }
  if (tools.size >= MAX_PENDING_TOOLS) {
    throw new Error("ACPX pending tool limit reached");
  }
  emit(
    "runtime.tool_called",
    {
      callId,
      operationId,
      input: boundedSidecarValue(record(call.arguments)),
    },
    activeTurnId,
  );
  return await new Promise((settle, reject) => {
    const abort = () => {
      const pending = tools.get(callId);
      if (!pending || !tools.delete(callId)) return;
      pending.cleanup();
      reject(new Error("ACPX tool call was cancelled"));
    };
    call.signal.addEventListener("abort", abort, { once: true });
    tools.set(callId, {
      turnId: activeTurnId,
      settle,
      reject,
      cleanup: () => call.signal.removeEventListener("abort", abort),
    });
    if (call.signal.aborted) abort();
  });
}

async function waitForInput(
  activeTurnId: string,
  request: AcpElicitationRequest,
  context: AcpElicitationContext,
): Promise<AcpElicitationResponse> {
  if (turnId !== activeTurnId || context.signal.aborted) {
    return { action: "cancel" };
  }
  if (inputs.size >= MAX_PENDING_INPUTS) {
    diagnostic(
      "runtime_input_limit_reached",
      "The active ACPX turn has too many pending input requests.",
    );
    return { action: "cancel" };
  }
  let normalized: NormalizedAcpForm | null;
  try {
    normalized = normalizeAcpFormElicitation(request);
  } catch (error) {
    diagnostic("runtime_input_rejected", safeMessage(error));
    return { action: "cancel" };
  }
  if (!normalized) {
    diagnostic(
      "runtime_input_unsupported",
      "The ACPX provider requested an unsupported input mode.",
    );
    return { action: "cancel" };
  }
  if (
    normalized.questionSet.questions.some(
      (question) => question.textValidation?.pattern !== undefined,
    )
  ) {
    diagnostic(
      "runtime_input_pattern_unsupported",
      "ACPX form patterns require a bounded regular expression dialect.",
    );
    return { action: "cancel" };
  }
  const requestId = stableRequestId(
    activeTurnId,
    ++requestSequence,
    context.requestId,
  );
  emit(
    "runtime.input_requested",
    {
      requestId,
      questionSet: normalized.questionSet,
      origin: {
        adapter: "acpx-runtime-sidecar",
        provider: openParams?.agent ?? initializedAgent ?? "unknown",
        method: "elicitation/create",
      },
    },
    activeTurnId,
  );
  return await new Promise((settle) => {
    const abort = () => {
      const pending = inputs.get(requestId);
      if (!pending || !inputs.delete(requestId)) return;
      pending.cleanup();
      settle({ action: "cancel" });
    };
    context.signal.addEventListener("abort", abort, { once: true });
    inputs.set(requestId, {
      turnId: activeTurnId,
      normalized,
      settle,
      cleanup: () => context.signal.removeEventListener("abort", abort),
    });
    if (context.signal.aborted) abort();
  });
}

function elicitationResponse(
  normalized: NormalizedAcpForm,
  resolution: HarnessRuntimeRequestResolution,
): AcpElicitationResponse {
  if (resolution.action === "submit") {
    if (!("response" in resolution)) {
      throw new Error("ACPX form submission requires a canonical response");
    }
    return normalized.accept(resolution.response);
  }
  if (resolution.action === "decline" || resolution.action === "cancel") {
    return { action: resolution.action };
  }
  throw new Error("unsupported ACPX input resolution action");
}

function rejectTurnWaiters(terminalTurnId: string, message: string): void {
  for (const [callId, pending] of tools) {
    if (pending.turnId !== terminalTurnId || !tools.delete(callId)) continue;
    pending.cleanup();
    pending.reject(new Error(message));
  }
  for (const [requestId, pending] of inputs) {
    if (pending.turnId !== terminalTurnId || !inputs.delete(requestId))
      continue;
    pending.cleanup();
    pending.settle({ action: "cancel" });
  }
}

type BoundedRuntimeToolEvent = AcpRuntimeEvent & {
  paperclipBoundedTool: true;
  paperclipOutput: Record<string, unknown>;
};

function boundRuntimeEventForNormalization(
  event: AcpRuntimeEvent,
): AcpRuntimeEvent {
  if (event.type !== "tool_call") return event;
  const title = boundedOptionalText(event.title, "", 4_000) || undefined;
  const kind = boundedOptionalText(event.kind, "", 4_000) || undefined;
  return {
    type: "tool_call",
    toolCallId:
      typeof event.toolCallId === "string" && event.toolCallId.trim()
        ? stableProviderIdentity(event.toolCallId, "tool")
        : undefined,
    title,
    kind,
    locations: safeAcpxLocations(
      event.locations,
      openParams?.workingDirectory,
      kind,
      title,
    ),
    text: boundedOptionalText(event.text, "", 4_000),
    status: boundedOptionalText(event.status, "", 100),
    tag: boundedOptionalText(event.tag, "", 160),
    paperclipBoundedTool: true,
    paperclipOutput: safeOutput(event.rawOutput),
  } as BoundedRuntimeToolEvent;
}

function sanitizeRuntimeEvent(event: AcpRuntimeEvent): Record<string, unknown> {
  const runtimeType = text(record(event).type);
  if (runtimeType === "plan") {
    return {
      type: "plan",
      entries: sanitizeAcpxPlanEntries(record(event).entries),
    };
  }
  if (event.type === "text_delta") {
    return {
      type: event.stream === "thought" ? "thinking" : "text_delta",
      text: boundedOptionalText(event.text, "", 64 * 1024),
      stream: event.stream,
      tag: event.tag ?? null,
      messageId:
        typeof event.messageId === "string" && event.messageId.length > 0
          ? stableProviderIdentity(event.messageId, "message")
          : null,
    };
  }
  if (event.type === "status") {
    return boundedSidecarValue({
      type: "status",
      text: boundedOptionalText(event.text, "", 4_000),
      tag: event.tag ?? null,
      used: safeNonNegativeNumber(event.used),
      size: safeNonNegativeNumber(event.size),
      ...safeUsage(event.cost, event.breakdown),
    });
  }
  if (event.type === "tool_call") {
    const boundedTool = event as BoundedRuntimeToolEvent;
    const toolCallId =
      typeof event.toolCallId === "string" && event.toolCallId.trim()
        ? stableProviderIdentity(event.toolCallId, "tool")
        : null;
    if (toolCallId === null) {
      return {
        type: "provider_notice",
        severity: "warning",
        category: "acpx_tool_identity_missing",
        summary:
          "The qualified ACP agent emitted a tool update without a stable tool-call identity.",
      };
    }
    // Classification and the consumer must see the same title bytes. In
    // particular, a mutation token beyond the transport bound must not grant a
    // create-target attestation that runner-core cannot independently verify.
    const toolTitle =
      typeof event.title === "string"
        ? boundedSidecarText(event.title, 4_000)
        : null;
    // Classify the complete provider kind before retaining its bounded display
    // prefix. The canonical operation keeps runner-core and the location
    // attestation decision aligned even when the mutation token is outside the
    // retained prefix.
    const toolClassification = frameAcpxToolClassification(
      event.kind,
      toolTitle,
    );
    const toolCallIdentity = {
      type: "tool_call",
      toolCallId,
      tag:
        typeof event.tag === "string"
          ? boundedSidecarText(event.tag, 160)
          : null,
      status:
        typeof event.status === "string"
          ? boundedSidecarText(event.status, 100)
          : null,
      title: toolTitle,
      text: boundedOptionalText(event.text, "", 4_000) || null,
      ...toolClassification,
    };
    return boundedSidecarValue(
      {
        ...toolCallIdentity,
        locations:
          boundedTool.paperclipBoundedTool === true
            ? (event.locations ?? [])
            : safeAcpxLocations(
                event.locations,
                openParams?.workingDirectory,
                event.kind,
                toolTitle,
              ),
        ...(boundedTool.paperclipBoundedTool === true
          ? boundedTool.paperclipOutput
          : safeOutput(event.rawOutput)),
      },
      128 * 1024,
      toolCallIdentity,
    );
  }
  if (event.type === "error") {
    return {
      type: "error",
      code: event.code?.slice(0, 160) ?? null,
      message: safeText(event.message),
      retryable: event.retryable ?? false,
    };
  }
  if (event.type === "done") {
    return {
      type: "done",
      stopReason: event.stopReason?.slice(0, 160) ?? null,
    };
  }
  return {
    type: "provider_notice",
    category: `unclassified_acp_${safeCode(record(event).type, "unknown")}`,
    summary: "The qualified ACP agent emitted an unclassified runtime update.",
  };
}

function sanitizeRuntimeStatus(value: unknown): Record<string, unknown> {
  const status = record(value);
  const models = record(status.models);
  return boundedSidecarValue(
    {
      summary: safeText(text(status.summary)).slice(0, 4_000) || null,
      agentSessionId:
        safeText(text(status.agentSessionId)).slice(0, 240) || null,
      models: {
        currentModelId:
          safeText(text(models.currentModelId)).slice(0, 240) || null,
        availableModelCount: Array.isArray(models.availableModelIds)
          ? Math.min(models.availableModelIds.length, 100_000)
          : 0,
      },
    },
    32 * 1024,
  );
}

function safeUsage(cost: unknown, breakdown: unknown): Record<string, unknown> {
  const nativeCost = record(cost);
  const nativeBreakdown = record(breakdown);
  return {
    cost:
      cost === undefined || cost === null
        ? null
        : {
            amount: safeNonNegativeNumber(nativeCost.amount),
            currency: safeText(text(nativeCost.currency)).slice(0, 16) || null,
          },
    breakdown:
      breakdown === undefined || breakdown === null
        ? null
        : {
            inputTokens: safeNonNegativeNumber(nativeBreakdown.inputTokens),
            outputTokens: safeNonNegativeNumber(nativeBreakdown.outputTokens),
            cachedReadTokens: safeNonNegativeNumber(
              nativeBreakdown.cachedReadTokens,
            ),
            cachedWriteTokens: safeNonNegativeNumber(
              nativeBreakdown.cachedWriteTokens,
            ),
            thoughtTokens: safeNonNegativeNumber(nativeBreakdown.thoughtTokens),
            totalTokens: safeNonNegativeNumber(nativeBreakdown.totalTokens),
          },
  };
}

function safeNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function safeOutput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {
      output: null,
      outputBytes: 0,
      outputTruncated: false,
      outputDigest: null,
    };
  }
  let raw: string;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return {
      output: null,
      outputBytes: 0,
      outputTruncated: false,
      outputDigest: null,
    };
  }
  if (!raw) {
    return {
      output: null,
      outputBytes: 0,
      outputTruncated: false,
      outputDigest: null,
    };
  }
  const redacted = redactSecrets(raw);
  const bytes = Buffer.from(redacted);
  return {
    output: bytes
      .subarray(Math.max(0, bytes.length - 64 * 1024))
      .toString("utf8"),
    outputBytes: bytes.length,
    outputTruncated: bytes.length > 64 * 1024,
    outputDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function parseOpenParams(
  value: Record<string, unknown>,
): AcpxSidecarOpenParams {
  const agent = requireQualifiedAgent(value.agent);
  const model = requiredText(value.model, "model");
  resolveQualifiedAcpxProfile(agent, model);
  if (value.runtimeContext !== undefined && value.runtimeContext !== null) {
    throw new Error("ACPX sidecar runtime context must be pre-materialized");
  }
  if (
    value.providerSessionKey !== undefined &&
    value.providerSessionKey !== null
  ) {
    throw new Error(
      "ACPX replacement provider sessions are not available in this release",
    );
  }
  return {
    runtimeDirectory: requiredText(value.runtimeDirectory, "runtimeDirectory"),
    normalizedSessionId: boundedIdentity(
      value.normalizedSessionId,
      "normalizedSessionId",
    ),
    workingDirectory: requiredText(value.workingDirectory, "workingDirectory"),
    agent,
    model,
    permissionMode: requiredPermissionMode(value.permissionMode),
    permissionModePinned: value.permissionModePinned === true,
    systemInstructions: boundedText(
      value.systemInstructions,
      "systemInstructions",
      1024 * 1024,
    ),
    runtimeContext: null,
    tools: parseTools(value.tools),
    ...(value.expectedIdentity === undefined || value.expectedIdentity === null
      ? {}
      : { expectedIdentity: parseExpectedIdentity(value.expectedIdentity) }),
  };
}

function parseTools(value: unknown): Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.length > 512) {
    throw new Error("tools must be an array with at most 512 entries");
  }
  return value.map((tool, index) => {
    if (typeof tool !== "object" || tool === null || Array.isArray(tool)) {
      throw new Error(`tool ${index + 1} must be an object`);
    }
    return structuredClone(tool as Record<string, unknown>);
  });
}

function parseExpectedIdentity(value: unknown): AcpxExpectedSessionIdentity {
  const input = record(value);
  if (input.kind !== "acpx")
    throw new Error("ACPX recovery identity kind is invalid");
  return {
    kind: "acpx",
    normalizedSessionId: boundedIdentity(
      input.normalizedSessionId,
      "expected normalizedSessionId",
    ),
    acpxRecordId: boundedIdentity(input.acpxRecordId, "expected acpxRecordId"),
    backendSessionId: boundedIdentity(
      input.backendSessionId,
      "expected backendSessionId",
    ),
    agentSessionId: boundedIdentity(
      input.agentSessionId,
      "expected agentSessionId",
    ),
    profileDigest: digest(input.profileDigest, "expected profileDigest"),
    workspaceDigest: digest(input.workspaceDigest, "expected workspaceDigest"),
    requestedModel: boundedIdentity(
      input.requestedModel,
      "expected requestedModel",
    ),
    effectiveModel: boundedIdentity(
      input.effectiveModel,
      "expected effectiveModel",
    ),
    ...(input.permissionMode === undefined
      ? {}
      : { permissionMode: requiredPermissionMode(input.permissionMode) }),
    providerLifetimeFenceCandidates: requiredFenceCandidates(
      input.providerLifetimeFenceCandidates,
    ),
  };
}

function requiredFenceCandidates(
  value: unknown,
): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some(
      (port) => !Number.isSafeInteger(port) || port < 49_152 || port > 65_535,
    ) ||
    new Set(value).size !== 3
  ) {
    throw new Error(
      "providerLifetimeFenceCandidates must be three distinct private ports",
    );
  }
  return Object.freeze([...value]) as readonly [number, number, number];
}

function requiredPermissionMode(
  value: unknown,
): AcpxSidecarOpenParams["permissionMode"] {
  if (
    value === "approve-all" ||
    value === "approve-reads" ||
    value === "deny-all"
  ) {
    return value;
  }
  throw new Error(
    "permissionMode must be approve-all, approve-reads, or deny-all",
  );
}

function emit(
  eventType: AcpxSidecarEvent["eventType"],
  payload: Record<string, unknown>,
  eventTurnId: string | null = turnId,
): void {
  if (sequence >= Number.MAX_SAFE_INTEGER) {
    throw new Error("ACPX sidecar event sequence exhausted");
  }
  writeFrame({
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    sequence: ++sequence,
    eventType,
    runId,
    turnId: eventTurnId,
    payload,
  });
}

function diagnostic(code: string, message: string): void {
  const safe = safeText(message);
  process.stderr.write(`[paperclip-acpx-sidecar] ${code}: ${safe}\n`);
  emit("runtime.diagnostic", { code: code.slice(0, 160), message: safe });
}

function response(
  id: number,
  ok: boolean,
  result?: Record<string, unknown>,
  error?: AcpxSidecarResponse["error"],
): void {
  writeFrame({
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id,
    ok,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  });
}

function writeFrame(value: AcpxSidecarEvent | AcpxSidecarResponse): void {
  const line = stringifyAcpxSidecarFrame(value);
  if (Buffer.byteLength(line) > ACPX_SIDECAR_MAX_FRAME_BYTES) {
    process.stderr.write("[paperclip-acpx-sidecar] output_frame_too_large\n");
    return;
  }
  process.stdout.write(`${line}\n`);
}

function requireHost(
  options: { allowCleanupRetry?: boolean } = {},
): AcpxRuntimeHost {
  return requireSidecarCommandHost(host, activeHostCleanup, options);
}

function requireQualifiedAgent(value: unknown): QualifiedAcpxAgent {
  if (value !== "codex" && value !== "claude") {
    throw new Error("ACPX agent must be claude or codex");
  }
  return value;
}

function requiredText(value: unknown, field: string): string {
  const result = text(value).trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  const result = requiredText(value, field);
  if (Buffer.byteLength(result) > maxBytes) {
    throw new Error(`${field} exceeds its byte limit`);
  }
  return result;
}

function boundedOptionalText(
  value: unknown,
  fallback: string,
  maxBytes: number,
): string {
  const result = text(value, fallback);
  const bytes = Buffer.from(result);
  return bytes.length <= maxBytes
    ? result
    : bytes.subarray(0, maxBytes).toString("utf8");
}

function safeCode(value: unknown, fallback: string): string {
  const code = text(value, fallback)
    .replace(/[^A-Za-z0-9._:-]+/g, "_")
    .slice(0, 160);
  return code || fallback;
}

function digest(value: unknown, field: string): string {
  const result = requiredText(value, field);
  if (!/^sha256:[a-f0-9]{64}$/.test(result)) {
    throw new Error(`${field} is invalid`);
  }
  return result;
}

function stableRequestId(
  activeTurnId: string,
  index: number,
  nativeRequestId: string | number | null,
): string {
  const digest = createHash("sha256")
    .update(
      `${activeTurnId}:${index}:${typeof nativeRequestId}:${String(nativeRequestId)}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `acpx-input-${digest}`;
}

function stableProviderIdentity(value: string, kind: string): string {
  if (Buffer.byteLength(value) <= 240 && !/[\u0000-\u001f\u007f]/.test(value)) {
    return value;
  }
  const digest = createHash("sha256")
    .update("paperclip.acpx.provider-identity.v1\0")
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex");
  return `acpx-${kind}-${digest}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function safeText(value: unknown, maxBytes = 8_192): string {
  const message = redactSecrets(text(value, String(value)));
  const bytes = Buffer.from(message);
  return bytes.length <= maxBytes
    ? message
    : bytes.subarray(0, maxBytes).toString("utf8");
}

function redactSecrets(value: string): string {
  return value.replace(
    /(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi,
    "$1=[REDACTED]",
  );
}

function safeMessage(error: unknown): string {
  return safeText(error instanceof Error ? error.message : error);
}

async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (turnId) rejectTurnWaiters(turnId, reason);
  const cleanupOwners: Array<{
    kind: "active_host" | "failed_admission";
    cleanup: Promise<void>;
  }> = [];
  if (activeHostCleanup) {
    // A timed-out close or suspension already owns sequential provider
    // cleanup. Join that exact owner; starting another host.close here would
    // overlap it and still lose its eventual failure.
    cleanupOwners.push({ kind: "active_host", cleanup: activeHostCleanup });
  } else if (host) {
    const activeHost = host;
    const cleanup = activeHost.close({ reason });
    retainActiveHostCleanup(activeHost, cleanup);
    cleanupOwners.push({ kind: "active_host", cleanup });
  }
  if (failedAdmissionCleanup) {
    cleanupOwners.push({
      kind: "failed_admission",
      cleanup: failedAdmissionCleanup,
    });
  }
  let cleanupIncomplete = false;
  const outcomes = await Promise.all(
    cleanupOwners.map(async (owner) => ({
      ...owner,
      outcome: await observeSidecarCleanupWithin(owner.cleanup),
    })),
  );
  for (const { kind, outcome } of outcomes) {
    if (outcome.status === "deferred") {
      cleanupIncomplete = true;
      diagnostic(
        kind === "active_host"
          ? "active_host_cleanup_deferred"
          : "failed_admission_cleanup_deferred",
        kind === "active_host"
          ? "ACPX active-host cleanup exceeded the bounded shutdown wait."
          : "ACPX failed-admission cleanup remains owned after the bounded shutdown wait.",
      );
    } else if (outcome.status === "failed") {
      cleanupIncomplete = true;
      diagnostic(
        kind === "active_host"
          ? "active_host_cleanup_failed"
          : "failed_admission_cleanup_failed",
        safeMessage(outcome.error),
      );
    }
  }
  if (!cleanupIncomplete) host = null;
  openParams = null;
  runId = null;
  turnId = null;
  lines.close();
  process.stdin.pause();
  process.exitCode = cleanupIncomplete ? 1 : 0;
}

function retainActiveHostCleanup(
  activeHost: AcpxRuntimeHost,
  cleanup: Promise<void>,
): void {
  const prior = activeHostCleanup;
  const retained = closing
    ? cleanup
    : recoverAndCombineSidecarHostCleanup(activeHost, cleanup, prior);
  activeHostCleanup = retained;
  void retained
    .then(
      () => {
        if (host === activeHost) {
          host = null;
          openParams = null;
          runId = null;
          turnId = null;
        }
      },
      (error: unknown) => {
        reportAuthoritativeSidecarHostCleanupFailure(
          closing,
          activeHostCleanup,
          retained,
          error,
          (authoritativeError) => {
            diagnostic(
              "active_host_cleanup_failed",
              safeMessage(authoritativeError),
            );
            requestShutdown("ACPX active-host cleanup could not recover");
          },
        );
      },
    )
    .finally(() => {
      if (activeHostCleanup === retained) activeHostCleanup = null;
    });
}

function retainFailedAdmissionCleanup(cleanup: Promise<void>): void {
  const prior = failedAdmissionCleanup;
  const retained = combineSidecarAdmissionCleanups(
    prior ? [prior, cleanup] : [cleanup],
  );
  failedAdmissionCleanup = retained;
  void retained.then(
    () => {
      if (failedAdmissionCleanup === retained) failedAdmissionCleanup = null;
    },
    (error: unknown) => {
      // A rejected cleanup can mean the provider survived termination. Keep
      // the admission guard owned and retire this sidecar; never turn rejection
      // into a successful settlement that permits a second provider.
      diagnostic("failed_admission_cleanup_failed", safeMessage(error));
      requestShutdown("ACPX failed-admission cleanup could not recover");
    },
  );
}
