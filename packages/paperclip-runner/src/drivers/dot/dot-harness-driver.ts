import { createHash, randomUUID } from "node:crypto";
import type { HarnessDriver, HarnessSession, OpenHarnessSessionInput, PersistedHarnessSession } from "../../contracts/harness-driver.js";
import type { NativeRunIdentity, NativeUserMessage } from "../../contracts/types.js";
import { validatePrpStructuredRunResult, type PrpEvent, type PrpStructuredRunResult } from "../../protocol/replay-contract.js";

export interface DotPrincipal { companyId: string; grantId: string }
export interface DotTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface DotAssignment extends NativeRunIdentity { turnId: string; messageId: string }

/** All authority comes from the host after normal run admission. Never accept
 * these bindings or callbacks from an MCP request or an agent configuration. */
export interface DotDriverOptions {
  identity: NativeRunIdentity;
  principal: DotPrincipal;
  expiresAt: number;
  tools: readonly DotTool[];
  assertAuthority: () => Promise<void>;
  executeTool: (input: { name: string; arguments: Record<string, unknown>; requestId: string; turnId: string }) => Promise<unknown>;
  publish: (assignment: DotAssignment) => Promise<void>;
  now?: () => number;
}

export class DotBoundaryError extends Error {}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);

/** Experimental, one-run provider. No model API or CLI impersonation: an
 * authenticated Dot pulls work after an MCP Event and calls back through MCP.
 * Memory-only: restart loses the session and fails closed; resume is false. */
export class DotHarnessDriver implements HarnessDriver {
  readonly identity: NativeRunIdentity;
  #options: DotDriverOptions;
  #session: DotSession | null = null;
  #opened = false;
  #revoked = false;

  constructor(options: DotDriverOptions) {
    if (options.identity.companyId !== options.principal.companyId) throw new DotBoundaryError("Company binding mismatch.");
    const remaining = options.expiresAt - (options.now ?? Date.now)();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 24 * 3600_000) throw new DotBoundaryError("Dot authority must expire within 24 hours.");
    this.identity = structuredClone(options.identity);
    this.#options = { ...options, identity: this.identity, principal: structuredClone(options.principal), tools: structuredClone(options.tools) };
  }

  async descriptor() {
    return {
      kind: "openai-dot-prototype", displayName: "OpenAI Dot (prototype)", version: "0.1.0", protocolVersion: "prp.v1",
      capabilities: {
        resume: false, typedEvents: true, steering: false, interruption: false, structuredResult: true,
        read: true, reconciliation: true, usage: false, dynamicTools: true,
        unsupported: ["resume", "steering", "interruption", "usage", "goals", "runtimeRequestResolution"],
      },
    };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    if (input.runId !== this.identity.runId || input.normalizedSessionId !== this.identity.sessionId || this.#opened || this.#revoked) {
      throw new DotBoundaryError("Dot session binding mismatch or already opened.");
    }
    input.signal?.throwIfAborted();
    this.#opened = true;
    await this.#options.assertAuthority();
    input.signal?.throwIfAborted();
    if (this.#revoked) throw new DotBoundaryError("Dot driver was revoked during admission.");
    return this.#session = new DotSession(this.#options);
  }

  async inbox(principal: DotPrincipal) {
    return this.#session ? this.#session.inbox(principal) : null;
  }

  async command(principal: DotPrincipal, input: DotCommand): Promise<unknown> {
    if (!this.#session) throw new DotBoundaryError("Dot run is unavailable.");
    return this.#session.command(principal, input);
  }

  /** Synchronous revocation: future callbacks lose authority immediately.
   * This does NOT prove that OpenAI stopped the Dot or any child tasks. */
  revoke() { this.#revoked = true; this.#session?.revoke(); }
}

export type DotCommand = { turnId: string; requestId: string } & (
  | { operation: "accept" }
  | { operation: "read" }
  | { operation: "tool"; name: string; arguments: Record<string, unknown> }
  | { operation: "progress"; text: string }
  | { operation: "finish"; result: unknown }
);

class DotSession implements HarnessSession {
  #turnId: string | null = null;
  #message: NativeUserMessage | null = null;
  #messageId = randomUUID();
  #events: PrpEvent[] = [];
  #waiters = new Set<() => void>();
  #revoked = false;
  #accepted = false;
  #result: PrpStructuredRunResult | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #receipts = new Map<string, { digest: string; promise: Promise<unknown> }>();
  #expiry: NodeJS.Timeout;
  constructor(readonly options: DotDriverOptions) {
    this.#expiry = setTimeout(() => this.revoke(), Math.max(0, options.expiresAt - this.#now()));
    this.#expiry.unref();
  }
  #now() { return (this.options.now ?? Date.now)(); }
  ids() { return { driverSessionId: this.options.identity.sessionId, providerSessionId: `dot-bridge:${this.options.identity.sessionId}`, displayId: "OpenAI Dot" }; }

  async #authorize(principal?: DotPrincipal) {
    if (principal && (principal.companyId !== this.options.principal.companyId || principal.grantId !== this.options.principal.grantId)) {
      throw new DotBoundaryError("This connection is not bound to this Dot run.");
    }
    if (this.#revoked || this.options.expiresAt <= this.#now()) throw new DotBoundaryError("Dot run authority expired or was revoked.");
    await this.options.assertAuthority();
    if (this.#revoked || this.options.expiresAt <= this.#now()) throw new DotBoundaryError("Dot run authority expired or was revoked.");
  }

  async startTurn(input: { message: NativeUserMessage }) {
    await this.#authorize();
    if (this.#turnId) throw new DotBoundaryError("This prototype accepts one turn per admitted run.");
    this.#turnId = randomUUID();
    this.#message = structuredClone(input.message);
    this.#emit("session.started", {});
    // A webhook receipt is not evidence that Dot accepted or started the turn.
    try { await this.options.publish(this.#assignment()); }
    catch { this.revoke(); throw new DotBoundaryError("Dot wakeup could not be confirmed. Inspect the assignment before retrying."); }
    return { turnId: this.#turnId };
  }

  #assignment(): DotAssignment {
    return { ...this.options.identity, turnId: this.#turnId!, messageId: this.#messageId };
  }
  async inbox(principal: DotPrincipal) {
    await this.#authorize(principal);
    return this.#turnId && !this.#result ? { ...this.#assignment(), accepted: this.#accepted, expiresAt: this.options.expiresAt } : null;
  }

  async command(principal: DotPrincipal, input: DotCommand): Promise<unknown> {
    await this.#authorize(principal);
    if (!this.#turnId || input.turnId !== this.#turnId) throw new DotBoundaryError("Stale or unknown Dot turn.");
    if (!input.requestId || input.requestId.length > 100) throw new DotBoundaryError("A bounded request ID is required.");
    const encoded = canonical(input);
    if (Buffer.byteLength(encoded) > 256 * 1024) throw new DotBoundaryError("Dot command exceeds 256 KiB.");
    const digest = createHash("sha256").update(encoded).digest("hex");
    const old = this.#receipts.get(input.requestId);
    if (old) {
      if (old.digest !== digest) throw new DotBoundaryError("Request ID was reused with different arguments.");
      return structuredClone(await old.promise);
    }
    if (this.#receipts.size >= 1000) throw new DotBoundaryError("Dot run command limit reached.");
    // Serialize command acceptance with completion. Reserve the promise BEFORE
    // dispatch so concurrent retries can never execute a tool twice.
    const promise = this.#tail.then(async () => {
      await this.#authorize(principal);
      if (this.#result) throw new DotBoundaryError("Dot turn already completed.");
      if (input.operation === "accept") {
        if (!this.#accepted) { this.#accepted = true; this.#emit("turn.started", {}); }
        return { accepted: true };
      }
      if (input.operation === "read") return {
        assignment: this.#assignment(), message: this.#message, tools: this.options.tools,
        accounting: { usage: null, cost: null },
      };
      if (!this.#accepted) throw new DotBoundaryError("Accept the Dot assignment before writing or finishing.");
      if (input.operation === "tool") {
        if (!this.options.tools.some(t => t.name === input.name)) throw new DotBoundaryError("Tool is not projected to this run.");
        let result: unknown;
        try {
          result = await this.options.executeTool({ name: input.name, arguments: input.arguments, requestId: input.requestId, turnId: input.turnId });
        } catch {
          // Never replay a possibly committed write after a transport failure.
          return { outcome: "unknown", message: "Inspect current task state; retry only with the same requestId." };
        }
        await this.#authorize(principal);
        return result;
      }
      if (input.operation === "progress") {
        if (!input.text.trim() || input.text.length > 16_000) throw new DotBoundaryError("Progress must contain 1–16000 characters.");
        this.#emit("item.started", { kind: "assistant_message" }, input.requestId);
        this.#emit("item.delta", { text: input.text }, input.requestId);
        this.#emit("item.completed", { kind: "assistant_message", text: input.text }, input.requestId);
        return { accepted: true };
      }
      const parsed = validatePrpStructuredRunResult(input.result);
      if (!parsed.ok) throw new DotBoundaryError("Invalid Paperclip structured run result.");
      this.#result = parsed.result;
      clearTimeout(this.#expiry);
      this.#emit("run.result.proposed", this.#result);
      this.#emit("turn.completed", {});
      this.#emit("run.terminal", {
        schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded",
        reportedWorkDisposition: this.#result.reportedWorkDisposition,
      });
      return { accepted: true, disposition: this.#result.reportedWorkDisposition };
    });
    this.#receipts.set(input.requestId, { digest, promise });
    this.#tail = promise.catch(() => {});
    return structuredClone(await promise);
  }

  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, itemId?: string) {
    const sequence = this.#events.length + 1;
    this.#events.push({
      schema: "paperclip.prp.event.v1", sourceEventId: `${this.options.identity.runId}:${sequence}`,
      sourceSeq: sequence, sourceInstanceId: `dot:${this.options.identity.sessionId}`, sourceKind: "runner",
      runId: this.options.identity.runId, normalizedSessionId: this.options.identity.sessionId,
      ...(this.#turnId ? { turnId: this.#turnId } : {}), ...(itemId ? { itemId } : {}),
      eventType, schemaVersion: 1, priority: eventType.startsWith("run.") ? 0 : 1,
      emittedAt: new Date(this.#now()).toISOString(), payload: structuredClone(payload),
    });
    this.#notify();
  }
  #notify() { for (const wake of this.#waiters) wake(); this.#waiters.clear(); }
  async *events(): AsyncIterable<PrpEvent> {
    let index = 0;
    while (true) {
      while (index < this.#events.length) {
        const event = this.#events[index++]!;
        yield structuredClone(event);
        if (event.eventType === "run.terminal") return;
      }
      if (this.#revoked) return;
      await new Promise<void>(resolve => this.#waiters.add(resolve));
    }
  }
  async read() { return { accepted: this.#accepted, completed: !!this.#result, revoked: this.#revoked }; }
  async reconcile() { return { ...await this.read(), providerStopConfirmed: false, usage: null, cost: null }; }
  async usage() { return null; }
  async snapshot(): Promise<PersistedHarnessSession> {
    return { driverKind: "openai-dot-prototype", driverSessionId: this.ids().driverSessionId, providerSessionId: this.ids().providerSessionId,
      runId: this.options.identity.runId, normalizedSessionId: this.options.identity.sessionId,
      activeTurnId: this.#result || this.#revoked ? null : this.#turnId, lastSourceSequence: this.#events.length,
      semanticResult: this.#result ? { result: this.#result, turnId: this.#turnId!, fingerprint: canonical(this.#result) } : null };
  }
  revoke() { this.#revoked = true; clearTimeout(this.#expiry); this.#notify(); }
  async close() {
    this.revoke();
    if (this.#accepted && !this.#result) throw new DotBoundaryError("Dot authority revoked; provider stop is unconfirmed.");
  }
}
