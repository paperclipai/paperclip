import {
  HarnessCapabilityUnavailableError,
  HarnessOperationAlreadyTerminalError,
  HarnessStaleTurnError,
  harnessRuntimeRequestOutcome,
  parseHarnessRuntimeRequestResolution,
  type HarnessDriver,
  type HarnessRuntimeRequestAction,
  type HarnessDriverDescriptor,
  type HarnessGoalOperation,
  type HarnessRuntimeRequest,
  type HarnessRuntimeRequestResolution,
  type HarnessSession,
  type HarnessSessionRecoveryResult,
  type HarnessThreadGoal,
  type HarnessThreadLineageEntry,
  type OpenHarnessSessionInput,
  type PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import type { NativeUserMessage } from "../contracts/types.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
} from "../protocol/replay-contract.js";
import {
  findLiveConsoleDemoManifest,
  type LiveConsoleDemoBeat,
  type LiveConsoleDemoManifest,
} from "./live-console-demo-manifests.js";

const DRIVER_KIND = "live-console-scripted-demo";

/**
 * `setTimeout` is typed as a DOM timer when this module is compiled under the
 * browser tsconfig for the transcript-model tests, so `unref` is guarded
 * rather than assumed.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void };
  if (typeof handle.unref === "function") handle.unref();
}

const HOLD_TIMEOUT_MS = 45_000;

export interface LiveConsoleScriptedDriverOptions {
  manifestId?: string;
  manifest?: LiveConsoleDemoManifest;
  /** Milliseconds between streamed chunks. Tests set this to zero. */
  chunkDelayMs?: number;
  now?: () => Date;
}

class EventQueue implements AsyncIterable<PrpEvent> {
  #values: PrpEvent[] = [];
  #waiters: Array<(result: IteratorResult<PrpEvent>) => void> = [];
  #closed = false;

  push(value: PrpEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<PrpEvent> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise<IteratorResult<PrpEvent>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
    };
  }
}

/** A promise that a later event can settle early. */
class Gate {
  #resolve: (() => void) | null = null;
  #settled = false;
  readonly promise: Promise<void>;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  open(): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#resolve?.();
  }

  get settled(): boolean {
    return this.#settled;
  }
}

interface PendingRequestEntry {
  request: HarnessRuntimeRequest;
  gate: Gate;
  outcome: "pending" | "resolved" | "expired" | "cancelled";
  action: HarnessRuntimeRequestAction | null;
  reason: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ScriptedSessionInput extends OpenHarnessSessionInput {
  manifest: LiveConsoleDemoManifest;
  chunkDelayMs: number;
  now: () => Date;
  resumed: boolean;
  restoredSequence: number;
  restoredGoal: HarnessThreadGoal | null;
  restoredLineage: HarnessThreadLineageEntry[];
  turnCounter: number;
}

class LiveConsoleScriptedSession implements HarnessSession {
  readonly #queue = new EventQueue();
  readonly #input: ScriptedSessionInput;
  readonly #pending = new Map<string, PendingRequestEntry>();
  readonly #lineage: HarnessThreadLineageEntry[];
  readonly #terminalTurns: Array<{ turnId: string; fingerprint: string }> = [];
  #sequence: number;
  #turnCounter: number;
  #activeTurnId: string | null = null;
  #turnStartPending = false;
  #interruptGate: Gate | null = null;
  #goal: HarnessThreadGoal | null;
  #semanticResult: PrpStructuredRunResult | null = null;
  #closed = false;
  #turnRunner: Promise<void> = Promise.resolve();

  constructor(input: ScriptedSessionInput) {
    this.#input = input;
    this.#sequence = input.restoredSequence;
    this.#turnCounter = input.turnCounter;
    this.#goal = input.restoredGoal;
    this.#lineage = [
      {
        threadId: this.#threadId,
        providerSessionId: input.normalizedSessionId,
        parentThreadId: null,
        depth: 0,
        nickname: "root",
        role: "primary",
        status: "running",
      },
      ...input.restoredLineage.filter((entry) => entry.depth > 0),
    ];
    this.#emit(input.resumed ? "session.resumed" : "session.started", {
      driverSessionId: this.#threadId,
      providerSessionId: input.normalizedSessionId,
      manifest: input.manifest.id,
      workingDirectory: input.workingDirectory,
      providerAuthentication: "server-side",
    });
  }

  get #threadId(): string {
    return `thread-${this.#input.normalizedSessionId}`;
  }

  ids(): { driverSessionId: string; providerSessionId?: string | null; displayId?: string | null } {
    return {
      driverSessionId: this.#threadId,
      providerSessionId: this.#input.normalizedSessionId,
      displayId: this.#input.manifest.name,
    };
  }

  events(): AsyncIterable<PrpEvent> {
    return this.#queue;
  }

  async startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }> {
    if (this.#closed) throw new Error("session is closed");
    if (this.#activeTurnId !== null || this.#turnStartPending) {
      throw new Error("a turn is already active");
    }
    this.#turnCounter += 1;
    const turnId = `turn-${this.#turnCounter}`;
    const beats = this.#turnCounter === 1
      ? this.#input.manifest.beats
      : (this.#input.manifest.followUpBeats ?? this.#input.manifest.beats);
    this.#turnStartPending = true;
    this.#interruptGate = new Gate();
    this.#emit("turn.submitted", {
      turnId,
      text: input.message.text,
      envelopeSchema: "paperclip.task_envelope.v1",
    }, { turnId });
    this.#turnRunner = this.#runTurn(turnId, beats).catch((error) => {
      this.#emit("harness.diagnostic", { message: `demo turn failed: ${String(error)}` });
    });
    return { turnId };
  }

  async steer(input: { turnId: string; message: NativeUserMessage }): Promise<void> {
    if (!this.#input.manifest.capabilities.steering) {
      throw new HarnessCapabilityUnavailableError(
        "steering",
        "this demo manifest does not advertise steering",
      );
    }
    if (this.#activeTurnId === null && !this.#turnStartPending) {
      throw new HarnessOperationAlreadyTerminalError("steer");
    }
    if (input.turnId !== this.#activeTurnId) {
      this.#emit("harness.diagnostic", {
        code: "stale_turn_rejected",
        message: `steering rejected: turn ${input.turnId} is not the active turn`,
      });
      throw new HarnessStaleTurnError(input.turnId);
    }
    this.#emit("item.completed", {
      kind: "steering_acknowledgement",
      status: "acknowledged",
      text: input.message.text,
    }, { turnId: input.turnId, itemId: `steer-${input.turnId}-${this.#sequence + 1}` });
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    if (!this.#input.manifest.capabilities.interruption) {
      throw new HarnessCapabilityUnavailableError(
        "interruption",
        "this demo manifest does not advertise interruption",
      );
    }
    if (this.#activeTurnId === null && !this.#turnStartPending) {
      throw new HarnessOperationAlreadyTerminalError("interrupt");
    }
    if (
      input.turnId !== undefined &&
      this.#activeTurnId !== null &&
      input.turnId !== this.#activeTurnId
    ) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    this.#emit("item.completed", {
      kind: "interrupt_acknowledgement",
      status: "acknowledged",
      text: input.reason ?? "browser_operator",
    }, {
      ...(this.#activeTurnId === null ? {} : { turnId: this.#activeTurnId }),
      itemId: `interrupt-${this.#sequence + 1}`,
    });
    this.#interruptGate?.open();
  }

  pendingRuntimeRequests(): HarnessRuntimeRequest[] {
    return [...this.#pending.values()]
      .filter((entry) => entry.outcome === "pending")
      .map((entry) => structuredClone(entry.request));
  }

  async resolveRuntimeRequest(input: {
    requestId: string;
    turnId: string;
    resolution: HarnessRuntimeRequestResolution;
  }): Promise<void> {
    const entry = this.#pending.get(input.requestId);
    if (entry === undefined) {
      throw new Error(`unknown runtime request ${input.requestId}`);
    }
    if (entry.outcome !== "pending") {
      throw new HarnessOperationAlreadyTerminalError(`resolve ${input.requestId}`);
    }
    if (input.turnId.length > 0 && input.turnId !== entry.request.turnId) {
      throw new HarnessStaleTurnError(input.turnId);
    }
    const resolution = parseHarnessRuntimeRequestResolution(
      entry.request.requestKind,
      input.resolution,
    );
    entry.outcome = "resolved";
    entry.action = resolution.action;
    this.#settleRequest(entry, "runtime_request.resolved");
  }

  async goal(input: HarnessGoalOperation): Promise<HarnessThreadGoal | null> {
    if (this.#input.manifest.capabilities.goals !== true) {
      throw new HarnessCapabilityUnavailableError(
        "goal",
        this.#input.manifest.capabilities.unsupported?.[0] ??
          "this app-server does not advertise the goals capability",
      );
    }
    const at = this.#input.now().getTime();
    if (input.action === "get") return this.#goal === null ? null : structuredClone(this.#goal);
    if (input.action === "set") {
      this.#goal = {
        threadId: this.#threadId,
        objective: input.objective,
        status: "active",
        tokenBudget: input.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: this.#goal?.createdAt ?? at,
        updatedAt: at,
      };
    } else if (input.action === "clear") {
      this.#goal = null;
    } else if (this.#goal === null) {
      throw new HarnessCapabilityUnavailableError(
        `goal ${input.action}`,
        "no goal is set on this thread",
      );
    } else {
      this.#goal = {
        ...this.#goal,
        status: input.action === "pause" ? "paused" : "active",
        updatedAt: at,
      };
    }
    this.#emit("item.completed", {
      kind: this.#goal === null ? "goal_cleared" : "goal",
      text: this.#goal === null
        ? "Goal cleared."
        : `Goal ${input.action === "set" ? "set" : input.action}: ${this.#goal.objective}`,
      operation: input.action,
      ...(this.#goal === null ? {} : { goal: structuredClone(this.#goal) }),
    }, { itemId: `goal-${this.#sequence + 1}` });
    return this.#goal === null ? null : structuredClone(this.#goal);
  }

  lineage(): HarnessThreadLineageEntry[] {
    return structuredClone(this.#lineage);
  }

  async usage(): Promise<Record<string, unknown> | null> {
    return { inputTokens: this.#sequence * 12, outputTokens: this.#sequence * 7 };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: DRIVER_KIND,
      driverSessionId: this.#threadId,
      providerSessionId: this.#input.normalizedSessionId,
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      ...(this.#semanticResult === null
        ? {}
        : {
            semanticResult: {
              result: structuredClone(this.#semanticResult),
              fingerprint: `${this.#input.manifest.id}:${this.#turnCounter}`,
              turnId: `turn-${this.#turnCounter}`,
            },
          }),
      terminalTurns: structuredClone(this.#terminalTurns),
      pendingRuntimeRequests: this.pendingRuntimeRequests(),
      goal: this.#goal === null ? null : structuredClone(this.#goal),
      lineage: this.lineage(),
      lastSourceSequence: this.#sequence,
    };
  }

  async close(input: { reason: string; force?: boolean }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      if (entry.outcome !== "pending") continue;
      entry.outcome = "cancelled";
      entry.reason = input.reason;
      this.#settleRequest(entry, "runtime_request.cancelled");
    }
    this.#interruptGate?.open();
    await this.#turnRunner.catch(() => undefined);
    this.#emit("session.closed", { reason: input.reason });
    this.#queue.close();
  }

  /** Test and reconnect seam: the demo server uses it to keep the cursor. */
  get sequence(): number {
    return this.#sequence;
  }

  get turnCounter(): number {
    return this.#turnCounter;
  }

  #emit(
    eventType: PrpEvent["eventType"],
    payload: Record<string, unknown>,
    binding: { turnId?: string; itemId?: string } = {},
  ): void {
    this.#sequence += 1;
    this.#queue.push({
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#input.runId}:${this.#sequence}`,
      sourceSeq: this.#sequence,
      sourceInstanceId: `${DRIVER_KIND}:${this.#input.normalizedSessionId}`,
      sourceKind: "runner",
      runId: this.#input.runId,
      normalizedSessionId: this.#input.normalizedSessionId,
      ...(binding.turnId === undefined ? {} : { turnId: binding.turnId }),
      ...(binding.itemId === undefined ? {} : { itemId: binding.itemId }),
      eventType,
      schemaVersion: 1,
      priority: 1,
      emittedAt: this.#input.now().toISOString(),
      payload,
    } as PrpEvent);
  }

  #settleRequest(entry: PendingRequestEntry, eventType: PrpEvent["eventType"]): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    this.#emit(
      eventType,
      harnessRuntimeRequestOutcome(entry.request, {
        action: entry.action,
        reason: entry.reason,
      }),
      { turnId: entry.request.turnId, itemId: entry.request.itemId },
    );
    entry.gate.open();
  }

  async #sleep(ms: number): Promise<"elapsed" | "interrupted"> {
    if (ms <= 0) return this.#interruptGate?.settled === true ? "interrupted" : "elapsed";
    const gate = this.#interruptGate;
    return await new Promise<"elapsed" | "interrupted">((resolve) => {
      const timer = setTimeout(() => resolve("elapsed"), ms);
      unrefTimer(timer);
      void gate?.promise.then(() => {
        clearTimeout(timer);
        resolve("interrupted");
      });
    });
  }

  get #interrupted(): boolean {
    return this.#interruptGate?.settled === true;
  }

  async #runTurn(turnId: string, beats: readonly LiveConsoleDemoBeat[]): Promise<void> {
    const manifest = this.#input.manifest;
    if (manifest.startDelayMs > 0) {
      const outcome = await this.#sleep(manifest.startDelayMs);
      if (outcome === "interrupted" || this.#closed) {
        this.#turnStartPending = false;
        this.#recordTerminalTurn(turnId, "cancelled");
        this.#emit("turn.cancelled", {
          turnId,
          reason: "interrupted before the provider accepted the turn",
        }, { turnId });
        return;
      }
    }
    if (this.#closed) {
      this.#turnStartPending = false;
      return;
    }
    this.#turnStartPending = false;
    this.#activeTurnId = turnId;
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { turnId, status: "inProgress" }, { turnId });
    this.#emit("runtime.phase.changed", { phase: "harness_running" });

    let failed = false;
    for (const beat of beats) {
      if (this.#interrupted || this.#closed) break;
      failed = (await this.#runBeat(turnId, beat)) || failed;
    }

    this.#activeTurnId = null;
    if (this.#interrupted) {
      this.#recordTerminalTurn(turnId, "interrupted");
      this.#emit("turn.interrupted", { turnId, reason: "browser_operator" }, { turnId });
      return;
    }
    if (this.#closed) return;
    const disposition = failed || manifest.disposition === "failed" ? "failed" : "completed";
    this.#recordTerminalTurn(turnId, disposition);
    this.#emitResult(turnId, disposition === "failed");
    this.#emit(disposition === "failed" ? "turn.failed" : "turn.completed", {
      turnId,
      ...(disposition === "failed"
        ? { message: "The demo manifest ends in a failed turn." }
        : {}),
    }, { turnId });
  }

  #recordTerminalTurn(turnId: string, state: string): void {
    this.#terminalTurns.push({ turnId, fingerprint: `${state}:${turnId}` });
  }

  async #runBeat(turnId: string, beat: LiveConsoleDemoBeat): Promise<boolean> {
    const delay = this.#input.chunkDelayMs;
    if (beat.kind === "reasoning" || beat.kind === "assistant") {
      const itemKind = beat.kind === "reasoning" ? "reasoning" : "agentMessage";
      this.#emit("item.started", { kind: itemKind, text: "" }, { turnId, itemId: beat.itemId });
      let text = "";
      for (const chunk of beat.chunks) {
        if ((await this.#sleep(delay)) === "interrupted" || this.#closed) {
          this.#emit("item.completed", {
            kind: itemKind,
            text,
            status: "interrupted",
            interrupted: true,
          }, { turnId, itemId: beat.itemId });
          return false;
        }
        text += chunk;
        this.#emit("item.delta", { kind: itemKind, text: chunk }, { turnId, itemId: beat.itemId });
      }
      this.#emit("item.completed", { kind: itemKind, text, status: "completed" }, {
        turnId,
        itemId: beat.itemId,
      });
      return false;
    }

    if (beat.kind === "tool") {
      this.#emit("item.started", {
        kind: "commandExecution",
        text: `${beat.name}: ${beat.input}`,
        toolName: beat.name,
        input: beat.input,
        status: "running",
      }, { turnId, itemId: beat.itemId });
      const wait = beat.hold === true ? HOLD_TIMEOUT_MS : Math.max(delay, 0) * 2;
      if ((await this.#sleep(wait)) === "interrupted" || this.#closed) {
        this.#emit("item.completed", {
          kind: "commandExecution",
          text: `${beat.name}: ${beat.input}`,
          toolName: beat.name,
          input: beat.input,
          status: "interrupted",
          interrupted: true,
        }, { turnId, itemId: beat.itemId });
        return false;
      }
      if (beat.failure !== undefined) {
        this.#emit("item.failed", {
          kind: "commandExecution",
          text: `${beat.name}: ${beat.input}`,
          toolName: beat.name,
          input: beat.input,
          message: beat.failure,
          status: "failed",
        }, { turnId, itemId: beat.itemId });
        return true;
      }
      this.#emit("item.completed", {
        kind: "commandExecution",
        text: `${beat.name}: ${beat.input}`,
        toolName: beat.name,
        input: beat.input,
        output: beat.output ?? "",
        status: "completed",
      }, { turnId, itemId: beat.itemId });
      return false;
    }

    if (beat.kind === "request") {
      const request: HarnessRuntimeRequest = {
        requestId: beat.requestId,
        requestKind: beat.requestKind,
        method: beat.method,
        turnId,
        itemId: beat.itemId,
        status: "pending",
        prompt: beat.prompt,
        details: structuredClone(beat.details),
      };
      const entry: PendingRequestEntry = {
        request,
        gate: new Gate(),
        outcome: "pending",
        action: null,
        reason: null,
        timer: null,
      };
      this.#pending.set(request.requestId, entry);
      if (beat.expiresAfterMs !== undefined) {
        entry.timer = setTimeout(() => {
          if (entry.outcome !== "pending") return;
          entry.outcome = "expired";
          this.#settleRequest(entry, "runtime_request.expired");
        }, beat.expiresAfterMs);
        unrefTimer(entry.timer);
      }
      this.#emit("runtime_request.created", {
        request: {
          ...request,
          type: request.method,
          actions: [...beat.actions],
        },
      }, { turnId, itemId: beat.itemId });
      await Promise.race([
        entry.gate.promise,
        this.#interruptGate?.promise ?? new Promise<void>(() => undefined),
      ]);
      if (entry.outcome === "pending") {
        entry.outcome = "cancelled";
        entry.reason = "turn_interrupted";
        this.#settleRequest(entry, "runtime_request.cancelled");
        return false;
      }
      return false;
    }

    if (beat.kind === "child") {
      const child: HarnessThreadLineageEntry = {
        threadId: beat.threadId,
        providerSessionId: `${beat.threadId}-provider`,
        parentThreadId: this.#threadId,
        depth: 1,
        nickname: beat.nickname,
        role: beat.role,
        status: "starting",
      };
      this.#lineage.push(child);
      for (const status of beat.statuses) {
        if ((await this.#sleep(delay)) === "interrupted" || this.#closed) return false;
        child.status = status;
        this.#emit("item.completed", {
          kind: "thread_lineage",
          text: `Child thread ${beat.nickname} is ${status}.`,
          thread: structuredClone(child),
        }, { turnId, itemId: `${beat.threadId}-${status}` });
      }
      return false;
    }

    if (beat.kind === "diagnostic") {
      this.#emit("harness.diagnostic", { message: beat.message });
      return true;
    }

    this.#emit("harness.diagnostic", { message: beat.note });
    await this.#sleep(HOLD_TIMEOUT_MS);
    return false;
  }

  #emitResult(turnId: string, failed: boolean): void {
    const manifest = this.#input.manifest;
    const result: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: failed ? "blocked" : "done",
      summary: failed
        ? `The ${manifest.name} demo ended in a failed turn on purpose.`
        : `The ${manifest.name} demo turn completed.`,
      completionClaim: {
        contractRevision: "live-console-demo-v1",
        objectiveSatisfied: !failed,
        criteria: [
          {
            criterionId: "objective",
            status: failed ? "not_satisfied" : "satisfied",
            evidenceRefs: [`manifest:${manifest.id}`],
          },
        ],
        remainingWork: failed
          ? [
              {
                description: "Investigate the scripted command failure.",
                blocksCompletion: true,
              },
            ]
          : [],
      },
      evidence: [{ ref: `manifest:${manifest.id}` }],
      verification: [
        {
          commandOrCheck: `liveConsole demo manifest ${manifest.id}`,
          status: failed ? "failed" : "passed",
        },
      ],
      attentionRequests: [],
      artifacts: [],
    };
    this.#semanticResult = result;
    this.#emit("run.result.proposed", result as unknown as Record<string, unknown>, { turnId });
  }
}

/**
 * A package-local `HarnessDriver` that replays a deterministic demo manifest.
 * It exists so the browser tracer can reach every protocol state without a
 * provider account, using exactly the routes the real Codex boundary uses.
 */
export class LiveConsoleScriptedDriver implements HarnessDriver {
  readonly #manifest: LiveConsoleDemoManifest;
  readonly #chunkDelayMs: number;
  readonly #now: () => Date;
  #session: LiveConsoleScriptedSession | null = null;

  constructor(options: LiveConsoleScriptedDriverOptions = {}) {
    this.#manifest = options.manifest ??
      findLiveConsoleDemoManifest(options.manifestId ?? "completion");
    this.#chunkDelayMs = options.chunkDelayMs ?? 45;
    this.#now = options.now ?? (() => new Date());
  }

  get manifest(): LiveConsoleDemoManifest {
    return this.#manifest;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: DRIVER_KIND,
      displayName: `Live console demo — ${this.#manifest.name}`,
      version: "1",
      protocolVersion: "live-console-demo-v1",
      capabilities: structuredClone(this.#manifest.capabilities),
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    const session = new LiveConsoleScriptedSession({
      ...input,
      manifest: this.#manifest,
      chunkDelayMs: this.#chunkDelayMs,
      now: this.#now,
      resumed: false,
      restoredSequence: 0,
      restoredGoal: null,
      restoredLineage: [],
      turnCounter: 0,
    });
    this.#session = session;
    return session;
  }

  async recoverSession(
    snapshot: PersistedHarnessSession,
  ): Promise<HarnessSessionRecoveryResult> {
    if (snapshot.driverKind !== DRIVER_KIND) {
      return { recovered: false, reason: `cannot resume driver kind ${snapshot.driverKind}` };
    }
    const runId = snapshot.runId;
    const normalizedSessionId = snapshot.normalizedSessionId;
    if (runId === undefined || normalizedSessionId === undefined) {
      return { recovered: false, reason: "snapshot is missing its runner identity" };
    }
    const session = new LiveConsoleScriptedSession({
      runId,
      normalizedSessionId,
      workingDirectory: "<server-owned>",
      manifest: this.#manifest,
      chunkDelayMs: this.#chunkDelayMs,
      now: this.#now,
      resumed: true,
      restoredSequence: snapshot.lastSourceSequence ?? 0,
      restoredGoal: snapshot.goal ?? null,
      restoredLineage: snapshot.lineage ?? [],
      turnCounter: this.#session?.turnCounter ?? 0,
    });
    this.#session = session;
    return { recovered: true, session };
  }
}
