import type {
  HarnessDriver,
  HarnessSession,
  PersistedHarnessSession,
} from "../contracts/harness-driver.js";
import type {
  NativeSession,
  NativeSessionBackend,
  NativeSessionBackendDescriptor,
  OpenNativeSessionInput,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type {
  PrpEvent,
  PrpTerminalState,
} from "../protocol/replay-contract.js";

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
      name: descriptor.displayName,
      version: descriptor.version,
      capabilities: structuredClone(descriptor.capabilities),
    };
  }

  async openSession(input: OpenNativeSessionInput): Promise<NativeSession> {
    const session = await this.#driver.openSession({
      runId: input.identity.runId,
      normalizedSessionId: input.identity.sessionId,
      workingDirectory: input.workingDirectory ?? process.cwd(),
    });
    return new HarnessNativeSession(input, session);
  }

  async recoverSession(snapshot: PersistedNativeSession) {
    if (this.#driver.recoverSession === undefined) {
      return { recovered: false, reason: "driver does not support recovery" };
    }
    const persisted: PersistedHarnessSession = {
      driverKind: snapshot.backendKind,
      driverSessionId: snapshot.sessionId,
      providerSessionId: snapshot.providerSessionId,
      runId: snapshot.identity.runId,
      normalizedSessionId: snapshot.identity.sessionId,
      activeTurnId: snapshot.activeTurnId ?? snapshot.terminalTurns?.at(-1)?.turnId ?? null,
      lastSourceSequence: parseCursor(snapshot.cursor),
      ...(snapshot.semanticResult === undefined || snapshot.semanticResult === null
        ? {}
        : {
            semanticResult: {
              result: snapshot.semanticResult,
              fingerprint: canonicalJson(snapshot.semanticResult),
              turnId: snapshot.activeTurnId ?? snapshot.terminalTurns?.at(-1)?.turnId ?? "recovered",
          },
        }),
      terminalTurns: snapshot.terminalTurns ?? [],
      pendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
      lineage: snapshot.lineage ?? [],
    };
    const recovered = await this.#driver.recoverSession(persisted);
    if (!recovered.recovered || recovered.session === undefined) {
      return { recovered: false, reason: recovered.reason };
    }
    return {
      recovered: true,
      session: new HarnessNativeSession(
        { identity: snapshot.identity },
        recovered.session,
      ),
    };
  }
}

class HarnessNativeSession implements NativeSession {
  readonly #input: OpenNativeSessionInput;
  readonly #session: HarnessSession;
  #terminal: PrpTerminalState | null = null;

  constructor(input: OpenNativeSessionInput, session: HarnessSession) {
    this.#input = structuredClone(input);
    this.#session = session;
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
      goals: this.#session.goal !== undefined,
      threadLineage: this.#session.lineage !== undefined,
    };
  }

  async *events(): AsyncIterable<PrpEvent> {
    for await (const event of this.#session.events()) {
      if (event.eventType === "run.terminal") {
        this.#terminal = structuredClone(event.payload as PrpTerminalState);
      } else if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) {
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
  }

  startTurn(input: Parameters<HarnessSession["startTurn"]>[0]) {
    return this.#session.startTurn(input);
  }

  steer(input: { turnId: string; message: { role: "user"; text: string } }) {
    if (this.#session.steer === undefined) throw new Error("steering is unavailable");
    return this.#session.steer(input);
  }

  interrupt(input: { turnId?: string; reason?: string }) {
    if (this.#session.interrupt === undefined) throw new Error("interruption is unavailable");
    return this.#session.interrupt(input);
  }

  async cancel(input: { reason: string }) {
    if (this.#session.interrupt !== undefined) {
      await this.#session.interrupt({ reason: input.reason });
    }
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
      sessionId: snapshot.driverSessionId,
      identity: structuredClone(this.#input.identity),
      providerSessionId: snapshot.providerSessionId,
      cursor:
        snapshot.lastSourceSequence === undefined
          ? null
          : String(snapshot.lastSourceSequence),
      semanticResult: snapshot.semanticResult?.result ?? null,
      terminal: this.#terminal,
      activeTurnId: snapshot.activeTurnId ?? snapshot.semanticResult?.turnId ?? null,
      terminalTurns: snapshot.terminalTurns ?? [],
      pendingRuntimeRequests: snapshot.pendingRuntimeRequests ?? [],
      lineage: snapshot.lineage ?? [],
    };
  }

  close(input: { reason: string }) {
    return this.#session.close(input);
  }
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
