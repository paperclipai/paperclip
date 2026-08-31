import type {
  HarnessDriver,
  HarnessSession,
  HarnessSessionRecoveryOptions,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import type {
  NativeSession,
  NativeSessionBackend,
  NativeSessionBackendDescriptor,
  NativeSessionRecoveryOptions,
  OpenNativeSessionInput,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type {
  PrpEvent,
  PrpTerminalState,
} from "../protocol/replay-contract.js";

const MAX_RECOVERY_TERMINAL_TURNS = 4_096;
const MAX_RECOVERY_TERMINAL_BYTES = 8 * 1024 * 1024;
const MAX_RECOVERY_TERMINAL_FINGERPRINT_BYTES = 256 * 1024;
const MAX_RECOVERY_SEMANTIC_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_RECOVERY_SEMANTIC_RESULT_NODES = 65_536;
const MAX_RECOVERY_SEMANTIC_RESULT_DEPTH = 128;

/**
 * Package-owned adapter from the concrete harness driver contract to the
 * normalized session boundary consumed by Paperclip. Provider mechanics stay
 * behind HarnessDriver; the control plane sees only PRP events and results.
 */
export class HarnessDriverBackend implements NativeSessionBackend {
  readonly #driver: HarnessDriver;

  constructor(driver: HarnessDriver) {
    this.#driver = driver;
  }

  async descriptor(): Promise<NativeSessionBackendDescriptor> {
    const descriptor = await this.#driver.descriptor();
    return {
      kind: "runner",
      name: descriptor.kind,
      version: descriptor.version,
      capabilities: structuredClone(descriptor.capabilities),
      runtimeContextCapabilities: descriptor.runtimeContextCapabilities === undefined ? undefined : structuredClone(descriptor.runtimeContextCapabilities),
    };
  }

  async openSession(input: OpenNativeSessionInput): Promise<NativeSession> {
    const session = await this.#driver.openSession({
      runId: input.identity.runId,
      normalizedSessionId: input.identity.sessionId,
      workingDirectory: input.workingDirectory ?? process.cwd(),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    try {
      assertProviderSessionIdentity(
        session,
        (await this.#driver.descriptor()).kind,
        "session.open",
      );
    } catch (error) {
      await session.close({
        reason: "provider session bootstrap returned an incomplete identity",
        force: true,
      }).catch(() => undefined);
      throw error;
    }
    return new HarnessNativeSession(input, session);
  }

  async recoverSession(
    snapshot: PersistedNativeSession,
    options: NativeSessionRecoveryOptions,
  ) {
    if (this.#driver.recoverSession === undefined) {
      return { recovered: false, reason: "driver does not support recovery" };
    }
    const prevalidationFailure = recoveryPrevalidationFailure(snapshot);
    if (prevalidationFailure !== null) {
      return { recovered: false, reason: prevalidationFailure };
    }
    const recoveredSemanticTurn = completedSemanticTurn(snapshot);
    const semanticTurnId =
      recoveredSemanticTurn?.turnId ??
      snapshot.activeTurnId ??
      snapshot.terminalTurns?.at(-1)?.turnId ??
      null;
    const recoveredTerminal =
      recoveredSemanticTurn && snapshot.semanticResult
        ? {
            schema: "paperclip.prp.terminal.v1" as const,
            turnTerminalState: "completed" as const,
            runTerminalState: "succeeded" as const,
            reportedWorkDisposition:
              snapshot.semanticResult.reportedWorkDisposition,
          }
        : snapshot.terminal ?? null;
    // `null` is a durable "no active turn" checkpoint. Only an omitted legacy
    // field may use the compatibility fallback; nullish coalescing here would
    // otherwise turn a settled semantic or terminal turn back into an active
    // one on every subsequent recovery.
    const activeTurnId = snapshot.activeTurnId === undefined
      ? recoveredSemanticTurn?.turnId
        ?? snapshot.terminalTurns?.at(-1)?.turnId
        ?? null
      : snapshot.activeTurnId;
    const persisted: PersistedHarnessSession = {
      driverKind: snapshot.driverKind ?? snapshot.backendKind,
      driverSessionId: snapshot.sessionId,
      providerSessionId: snapshot.providerSessionId,
      ...(snapshot.providerIdentity === undefined
        ? {}
        : { providerIdentity: structuredClone(snapshot.providerIdentity) }),
      ...(snapshot.providerRecoveryPolicy === undefined
        ? {}
        : { providerRecoveryPolicy: snapshot.providerRecoveryPolicy }),
      runId: snapshot.identity.runId,
      normalizedSessionId: snapshot.identity.sessionId,
      activeTurnId,
      lastSourceSequence: parseCursor(snapshot.cursor),
      ...(snapshot.semanticResult === undefined || snapshot.semanticResult === null
        ? {}
        : {
            semanticResult: {
              result: snapshot.semanticResult,
              fingerprint: canonicalJson(snapshot.semanticResult),
              turnId: semanticTurnId ?? "recovered",
          },
        }),
      terminalTurns: snapshot.terminalTurns ?? [],
      dispositionOnlyRecoveryConsumed:
        snapshot.dispositionOnlyRecoveryConsumed ?? false,
      dispositionOnlyRecoveryTurnId:
        snapshot.dispositionOnlyRecoveryTurnId ?? null,
      pendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
      lineage: snapshot.lineage ?? [],
    };
    const recoveryOptions: HarnessSessionRecoveryOptions = {
      signal: options.signal,
    };
    const recovered = await this.#driver.recoverSession(
      persisted,
      recoveryOptions,
    );
    if (!recovered.recovered || recovered.session === undefined) {
      return { recovered: false, reason: recovered.reason };
    }
    try {
      assertProviderSessionIdentity(
        recovered.session,
        (await this.#driver.descriptor()).kind,
        "session.recover",
      );
    } catch (error) {
      await recovered.session.close({
        reason: "provider session recovery returned an incomplete identity",
        force: true,
      }).catch(() => undefined);
      throw error;
    }
    return {
      recovered: true,
      session: new HarnessNativeSession(
        { identity: snapshot.identity },
        recovered.session,
        recoveredTerminal,
      ),
    };
  }
}

function completedSemanticTurn(
  snapshot: PersistedNativeSession,
): { turnId: string; fingerprint: string } | null {
  if (snapshot.semanticResult === undefined || snapshot.semanticResult === null) {
    return null;
  }
  const semanticFingerprint = canonicalJson(snapshot.semanticResult);
  const terminalTurns = snapshot.terminalTurns ?? [];
  for (let index = terminalTurns.length - 1; index >= 0; index -= 1) {
    const terminal = terminalTurns[index]!;
    try {
      const value: unknown = JSON.parse(terminal.fingerprint);
      const record = plainRecord(value);
      if (
        record?.status === "completed" &&
        record.semanticResult === semanticFingerprint
      ) {
        return terminal;
      }
    } catch {
      // Non-canonical or legacy terminal fingerprints cannot prove completion.
    }
  }
  return null;
}

function recoveryPrevalidationFailure(
  snapshot: PersistedNativeSession,
): string | null {
  if (
    snapshot.terminalTurns !== undefined &&
    !Array.isArray(snapshot.terminalTurns)
  ) {
    return "persisted harness terminal history is invalid";
  }
  const terminalTurns = snapshot.terminalTurns ?? [];
  if (terminalTurns.length > MAX_RECOVERY_TERMINAL_TURNS) {
    return "persisted harness terminal history exceeds its recovery limit";
  }
  let terminalBytes = 0;
  for (const terminal of terminalTurns) {
    if (
      typeof terminal?.turnId !== "string" ||
      typeof terminal.fingerprint !== "string"
    ) {
      return "persisted harness terminal history is invalid";
    }
    if (
      terminal.turnId.length > MAX_RECOVERY_TERMINAL_BYTES ||
      terminal.fingerprint.length > MAX_RECOVERY_TERMINAL_FINGERPRINT_BYTES
    ) {
      return "persisted harness terminal history exceeds its recovery limit";
    }
    const fingerprintBytes = Buffer.byteLength(terminal.fingerprint);
    terminalBytes += Buffer.byteLength(terminal.turnId) + fingerprintBytes;
    if (
      fingerprintBytes > MAX_RECOVERY_TERMINAL_FINGERPRINT_BYTES ||
      terminalBytes > MAX_RECOVERY_TERMINAL_BYTES
    ) {
      return "persisted harness terminal history exceeds its recovery limit";
    }
  }
  if (
    snapshot.semanticResult !== undefined &&
    snapshot.semanticResult !== null &&
    !isBoundedPersistedJson(
      snapshot.semanticResult,
      MAX_RECOVERY_SEMANTIC_RESULT_BYTES,
    )
  ) {
    return "persisted harness semantic result exceeds its recovery limit";
  }
  return null;
}

/** Measure persisted JSON without first serializing or cloning the payload. */
function isBoundedPersistedJson(value: unknown, maxBytes: number): boolean {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const add = (amount: number): boolean => {
    bytes += amount;
    return bytes <= maxBytes;
  };
  const visit = (candidate: unknown, depth: number): boolean => {
    nodes += 1;
    if (
      nodes > MAX_RECOVERY_SEMANTIC_RESULT_NODES ||
      depth > MAX_RECOVERY_SEMANTIC_RESULT_DEPTH
    ) {
      return false;
    }
    if (candidate === null) return add(4);
    switch (typeof candidate) {
      case "string":
        return candidate.length + 2 <= maxBytes - bytes
          ? add(jsonStringBytes(candidate, maxBytes - bytes))
          : false;
      case "boolean":
        return add(candidate ? 4 : 5);
      case "number":
        return Number.isFinite(candidate)
          ? add(String(candidate).length)
          : false;
      case "object":
        break;
      default:
        return false;
    }
    if (ancestors.has(candidate)) return false;
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (!add(2)) return false;
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0 && !add(1)) return false;
          if (!visit(candidate[index], depth + 1)) return false;
        }
        return true;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return false;
      if (!add(2)) return false;
      let propertyCount = 0;
      for (const key in candidate as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
        if (propertyCount > 0 && !add(1)) return false;
        propertyCount += 1;
        if (
          key.length + 3 > maxBytes - bytes ||
          !add(jsonStringBytes(key, maxBytes - bytes) + 1) ||
          !visit((candidate as Record<string, unknown>)[key], depth + 1)
        ) {
          return false;
        }
      }
      return true;
    } finally {
      ancestors.delete(candidate);
    }
  };
  try {
    return visit(value, 0);
  } catch {
    return false;
  }
}

function jsonStringBytes(value: string, maxBytes: number): number {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) {
      bytes += 2;
    } else if (code <= 0x1f) {
      bytes += [0x08, 0x09, 0x0a, 0x0c, 0x0d].includes(code) ? 2 : 6;
    } else if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      bytes += 6;
    } else {
      bytes += 3;
    }
    if (bytes > maxBytes) return maxBytes + 1;
  }
  return bytes;
}

function assertProviderSessionIdentity(
  session: HarnessSession,
  provider: string,
  stage: "session.open" | "session.recover",
): void {
  const ids = session.ids();
  if (
    typeof ids.driverSessionId !== "string"
    || ids.driverSessionId.trim().length === 0
    || typeof ids.providerSessionId !== "string"
    || ids.providerSessionId.trim().length === 0
  ) {
    throw new Error(
      `provider_initialize_protocol_error: provider=${provider} stage=${stage} missing durable provider session identity`,
    );
  }
}

class HarnessNativeSession implements NativeSession {
  #input: OpenNativeSessionInput;
  readonly #session: HarnessSession;
  #terminal: PrpTerminalState | null = null;
  #explicitlyCancelled = false;

  constructor(
    input: OpenNativeSessionInput,
    session: HarnessSession,
    terminal?: PrpTerminalState | null,
  ) {
    this.#input = structuredClone(input);
    this.#session = session;
    this.#terminal = terminal === undefined ? null : structuredClone(terminal);
  }

  identity() {
    return structuredClone(this.#input.identity);
  }

  async capabilities() {
    return {
      resume: true,
      typedEvents: true,
      steering: this.#session.steer !== undefined,
      interruption: this.#session.interrupt !== undefined,
      structuredResult: true,
      read: this.#session.read !== undefined,
      reconciliation: this.#session.reconcile !== undefined,
      usage: this.#session.usage !== undefined,
      runtimeRequestResolution: this.#session.resolveRuntimeRequest !== undefined,
      runtimeRequestHandoff: this.#session.handoffRuntimeRequest !== undefined,
      goals: this.#session.goal !== undefined,
      threadLineage: this.#session.lineage !== undefined,
    };
  }

  async attachRun(input: { identity: OpenNativeSessionInput["identity"] }): Promise<void> {
    const currentIdentity = this.#input.identity;
    if (
      input.identity.sessionId !== currentIdentity.sessionId
      || input.identity.companyId !== currentIdentity.companyId
      || input.identity.issueId !== currentIdentity.issueId
      || input.identity.agentId !== currentIdentity.agentId
    ) {
      throw new Error("native_session_attach_binding_mismatch");
    }
    if (this.#session.attachRun === undefined) {
      throw new Error("native_session_multi_run_unavailable");
    }
    await this.#session.attachRun({ runId: input.identity.runId });
    this.#input = { ...this.#input, identity: structuredClone(input.identity) };
    this.#terminal = null;
    this.#explicitlyCancelled = false;
  }

  async *events(): AsyncIterable<PrpEvent> {
    let sourceInstanceId: string | null = null;
    let lastSourceSequence = 0;
    let sawTerminal = false;
    let synthesizedDurableWait = false;
    let streamFailure: unknown = null;
    const observedPendingInputs = new Map<string, Record<string, unknown>>();
    try {
      for await (const event of this.#session.events()) {
        sourceInstanceId = event.sourceInstanceId;
        lastSourceSequence = Math.max(lastSourceSequence, event.sourceSeq);
        if (event.eventType === "runtime_request.created") {
          const request = plainRecord(event.payload.request);
          if (
            request?.schema === "paperclip.runtime_request.v2"
            && request.type === "input"
            && typeof request.requestId === "string"
          ) observedPendingInputs.set(request.requestId, structuredClone(request));
        } else if (["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"].includes(event.eventType)) {
          const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId : null;
          if (requestId) observedPendingInputs.delete(requestId);
        }
        if (event.eventType === "run.terminal") {
          sawTerminal = true;
          this.#terminal = structuredClone(event.payload as PrpTerminalState);
        } else if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) {
          sawTerminal = true;
          const snapshot = await this.#session.snapshot();
          const disposition = snapshot.semanticResult?.result.reportedWorkDisposition ?? "yielded";
          this.#terminal = {
            schema: "paperclip.prp.terminal.v1",
            turnTerminalState:
              event.eventType === "turn.completed" ? "completed"
                : event.eventType === "turn.failed" ? "failed"
                  : event.eventType === "turn.interrupted" ? "interrupted"
                    : "cancelled",
            runTerminalState: event.eventType === "turn.completed" ? "succeeded" : event.eventType === "turn.failed" ? "failed" : "cancelled",
            reportedWorkDisposition: disposition,
          };
        }
        yield structuredClone(event);
      }
    } catch (error) {
      streamFailure = error;
    }

    // The provider can disappear while its native RPC is awaiting the user.
    // Emit one canonical terminal fact and replace the stream failure with a
    // governed wait; the control plane can materialize the continuation without
    // ever trying to replay the dead provider request.
    if (!sawTerminal && !this.#explicitlyCancelled && sourceInstanceId) {
      const snapshot = await this.#session.snapshot().catch(() => null);
      let governedWaitTurnId: string | undefined;
      for (const request of observedPendingInputs.values()) {
        const sourceSeq = Math.max(lastSourceSequence, snapshot?.lastSourceSequence ?? 0) + 1;
        lastSourceSequence = sourceSeq;
        const requestId = String(request.requestId);
        const turnId = typeof request.turnId === "string" ? request.turnId : undefined;
        governedWaitTurnId ??= turnId;
        const itemId = typeof request.itemId === "string" ? request.itemId : requestId;
        yield {
          schema: "paperclip.prp.event.v1",
          sourceEventId: `${sourceInstanceId}:${this.#input.identity.runId}:${sourceSeq}`,
          sourceSeq,
          sourceInstanceId,
          sourceKind: "runner",
          runId: this.#input.identity.runId,
          normalizedSessionId: this.#input.identity.sessionId,
          ...(turnId ? { turnId } : {}),
          itemId,
          eventType: "runtime_request.expired",
          schemaVersion: 1,
          priority: 0,
          emittedAt: new Date().toISOString(),
          payload: {
            requestId,
            ...(turnId ? { turnId } : {}),
            itemId,
            requestKind: "runtime",
            reason: "provider_process_lost",
            replayAllowed: false,
            requestType: "input",
            ...(plainRecord(request.origin)?.adapter
              ? { adapter: plainRecord(request.origin)?.adapter }
              : {}),
            request: structuredClone(request),
          },
        };
      }
      if (governedWaitTurnId) {
        const sourceSeq = Math.max(lastSourceSequence, snapshot?.lastSourceSequence ?? 0) + 1;
        lastSourceSequence = sourceSeq;
        synthesizedDurableWait = true;
        sawTerminal = true;
        this.#terminal = {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "interrupted",
          runTerminalState: "cancelled",
          reportedWorkDisposition: "yielded",
        };
        yield {
          schema: "paperclip.prp.event.v1",
          sourceEventId: `${sourceInstanceId}:${this.#input.identity.runId}:${sourceSeq}`,
          sourceSeq,
          sourceInstanceId,
          sourceKind: "runner",
          runId: this.#input.identity.runId,
          normalizedSessionId: this.#input.identity.sessionId,
          turnId: governedWaitTurnId,
          eventType: "turn.interrupted",
          schemaVersion: 1,
          priority: 0,
          emittedAt: new Date().toISOString(),
          payload: { status: "interrupted", reason: "provider_process_lost" },
        };
      }
    }
    if (streamFailure && !synthesizedDurableWait) throw streamFailure;
  }

  startTurn(input: Parameters<HarnessSession["startTurn"]>[0]) {
    return this.#session.startTurn(input);
  }

  steer(input: { turnId: string; message: { role: "user"; text: string }; correlationId?: string }) {
    if (this.#session.steer === undefined) throw new Error("steering is unavailable");
    return this.#session.steer(input);
  }

  interrupt(input: { turnId?: string; reason?: string }) {
    if (this.#session.interrupt === undefined) throw new Error("interruption is unavailable");
    return this.#session.interrupt(input);
  }

  cancel(input: { reason: string; signal: AbortSignal }) {
    if (input.signal.aborted) {
      throw input.signal.reason ?? new Error("native session cancellation aborted");
    }
    // This flag is the adapter's synchronous publication boundary. Provider
    // interruption happens afterward as passive cleanup, so a slow or broken
    // transport cannot synthesize or publish new accepted output for the turn.
    this.#explicitlyCancelled = true;
    const interrupt = this.#session.interrupt;
    return {
      cleanup: interrupt === undefined
        ? Promise.resolve()
        : Promise.resolve().then(() => interrupt.call(this.#session, {
            reason: input.reason,
            signal: input.signal,
          })),
    };
  }

  resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: Parameters<NonNullable<HarnessSession["resolveRuntimeRequest"]>>[0]["resolution"];
  }) {
    if (this.#session.resolveRuntimeRequest === undefined) {
      throw new Error("native_runtime_request_resolution_unavailable");
    }
    return this.#session.resolveRuntimeRequest(input);
  }

  handoffRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    reason: "durable_handoff";
    signal: AbortSignal;
  }) {
    if (this.#session.handoffRuntimeRequest === undefined) {
      throw new Error("native_runtime_request_handoff_unavailable");
    }
    return this.#session.handoffRuntimeRequest(input);
  }

  async result() {
    const snapshot = await this.#session.snapshot();
    if (snapshot.semanticResult === undefined || snapshot.semanticResult === null) {
      return null;
    }
    if (this.#terminal === null) {
      return null;
    }
    return {
      result: structuredClone(snapshot.semanticResult.result),
      terminal: structuredClone(this.#terminal),
      turnId: snapshot.semanticResult.turnId,
    };
  }

  async snapshot(): Promise<PersistedNativeSession> {
    const snapshot = await this.#session.snapshot();
    return {
      backendKind: "runner",
      driverKind: snapshot.driverKind,
      sessionId: snapshot.driverSessionId,
      identity: structuredClone(this.#input.identity),
      providerSessionId: snapshot.providerSessionId,
      ...(snapshot.providerIdentity === undefined
        ? {}
        : { providerIdentity: structuredClone(snapshot.providerIdentity) }),
      ...(snapshot.providerRecoveryPolicy === undefined
        ? {}
        : { providerRecoveryPolicy: snapshot.providerRecoveryPolicy }),
      cursor:
        snapshot.lastSourceSequence === undefined
          ? null
          : String(snapshot.lastSourceSequence),
      semanticResult: snapshot.semanticResult?.result ?? null,
      terminal: this.#terminal,
      // Harness snapshots use an explicit null to record a settled turn. Keep
      // the semantic-result fallback solely for legacy snapshots that omitted
      // activeTurnId, or a later recovery can replay the terminal turn.
      activeTurnId: snapshot.activeTurnId === undefined
        ? snapshot.semanticResult?.turnId ?? null
        : snapshot.activeTurnId,
      terminalTurns: snapshot.terminalTurns ?? [],
      dispositionOnlyRecoveryConsumed:
        snapshot.dispositionOnlyRecoveryConsumed ?? false,
      dispositionOnlyRecoveryTurnId:
        snapshot.dispositionOnlyRecoveryTurnId ?? null,
      pendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
      lineage: snapshot.lineage ?? [],
    };
  }

  async usage(): Promise<Record<string, unknown> | null> {
    return this.#session.usage?.() ?? null;
  }

  close(input: { reason: string }) {
    return this.#session.close(input);
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function createHarnessDriverBackend(driver: HarnessDriver): NativeSessionBackend {
  return new HarnessDriverBackend(driver);
}

function parseCursor(cursor: string | null | undefined): number | undefined {
  if (cursor === undefined || cursor === null || cursor === "") return undefined;
  const parsed = Number(cursor);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
