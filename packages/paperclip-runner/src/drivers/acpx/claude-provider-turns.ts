import { randomUUID } from "node:crypto";

import type { AcpRuntimeEvent } from "acpx/runtime";

import { createAcpSessionUpdateEventConverter, type AcpSessionUpdateEventConverter } from "./acp-session-update-event.js";

export const CLAUDE_PROVIDER_TURN_SILENCE_MS = 660_000;
export const CLAUDE_PROVIDER_TURN_PROCESS_LOST = "ACPX_PROVIDER_PROCESS_LOST";
export const CLAUDE_PROVIDER_TURN_SILENT = "ACPX_PROVIDER_TURN_SILENT";

const START_KINDS = new Set(["usage_update", "tool_call", "tool_call_update", "agent_message_chunk", "agent_thought_chunk", "plan"]);
const MAX_PENDING_REQUESTS = 256;

export type ClaudeProviderTurnResult =
  | { status: "completed"; stopReason: "end_turn"; usage: Record<string, unknown> | null }
  | { status: "cancelled"; stopReason: "cancelled" }
  | { status: "failed"; error: { code: string; message: string; retryable: false } };

export interface ClaudeProviderTurn {
  readonly requestId: string;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<ClaudeProviderTurnResult>;
}

export interface ClaudeProviderTurnAdmission {
  busy(): boolean;
  release(): void;
}

export interface ClaudeProviderTurnHooks {
  sessionId(): string | null;
  promptActive(): boolean;
  admit(turn: ClaudeProviderTurn, fail: (code: string, message: string) => void): ClaudeProviderTurnAdmission | null;
  silenceMs?: number;
  mintTurnId?: () => string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function claudeProviderTurnEndMarker(update: Record<string, unknown>): boolean {
  return update.sessionUpdate === "usage_update" && record(record(update._meta)["_claude/origin"]).kind !== undefined;
}

function cycleUsage(update: Record<string, unknown>): Record<string, unknown> | null {
  const usage = record(record(update._meta).usage);
  const count = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] : undefined;
  if (count("input_tokens") === undefined || count("output_tokens") === undefined) return null;
  const cost = record(update.cost);
  const amount = typeof cost.amount === "number" && Number.isFinite(cost.amount) ? cost.amount : undefined;
  const currency = typeof cost.currency === "string" && cost.currency.trim() ? cost.currency.trim() : undefined;
  return {
    type: "status",
    tag: "usage_update",
    text: "terminal prompt usage",
    cost: amount === undefined && currency === undefined ? undefined : { ...(amount === undefined ? {} : { amount }), ...(currency ? { currency } : {}) },
    breakdown: {
      inputTokens: count("input_tokens"),
      outputTokens: count("output_tokens"),
      cachedReadTokens: count("cache_read_input_tokens"),
      cachedWriteTokens: count("cache_creation_input_tokens"),
      thoughtTokens: count("thought_tokens"),
      totalTokens: count("total_tokens"),
    },
  };
}

class ProviderTurnQueue {
  readonly #items: AcpRuntimeEvent[] = [];
  #waiter: (() => void) | null = null;
  #closed = false;

  push(event: AcpRuntimeEvent): void {
    if (this.#closed) return;
    this.#items.push(event);
    this.#wake();
  }

  close(): void {
    this.#closed = true;
    this.#wake();
  }

  async *iterate(): AsyncIterable<AcpRuntimeEvent> {
    for (;;) {
      const next = this.#items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => { this.#waiter = resolve; });
    }
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}

class ActiveProviderTurn implements ClaudeProviderTurn {
  readonly requestId: string;
  readonly result: Promise<ClaudeProviderTurnResult>;
  readonly #queue = new ProviderTurnQueue();
  readonly #converter: AcpSessionUpdateEventConverter = createAcpSessionUpdateEventConverter();
  #settle!: (result: ClaudeProviderTurnResult) => void;
  #chain: Promise<void> = Promise.resolve();
  #settled = false;
  admission: ClaudeProviderTurnAdmission | null = null;

  constructor(requestId: string) {
    this.requestId = requestId;
    this.result = new Promise((resolve) => { this.#settle = resolve; });
  }

  get events(): AsyncIterable<AcpRuntimeEvent> {
    return this.#queue.iterate();
  }

  get settled(): boolean {
    return this.#settled;
  }

  accept(message: unknown): void {
    this.#chain = this.#chain.then(async () => {
      const event = await this.#converter.convert(message);
      if (event) this.#queue.push(event);
    });
  }

  finishAfterQueued(result: ClaudeProviderTurnResult, done: () => void): void {
    this.#chain = this.#chain.then(() => this.finish(result, done));
  }

  finish(result: ClaudeProviderTurnResult, done: () => void): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#converter.close();
    this.#queue.close();
    try {
      this.admission?.release();
    } finally {
      done();
      this.#settle(result);
    }
  }
}

export class ClaudeProviderTurns {
  readonly #hooks: ClaudeProviderTurnHooks;
  readonly #pending = new Set<string | number>();
  #active: ActiveProviderTurn | null = null;
  #retired = false;
  #timer: NodeJS.Timeout | null = null;

  constructor(hooks: ClaudeProviderTurnHooks) {
    this.#hooks = hooks;
  }

  get retired(): boolean {
    return this.#retired;
  }

  get activeTurnId(): string | null {
    return this.#active?.requestId ?? null;
  }

  observe(direction: "inbound" | "outbound", message: unknown): boolean {
    if (this.#retired && this.#active === null) return false;
    const envelope = record(message);
    const id = envelope.id;
    const hasId = typeof id === "string" || typeof id === "number";
    if (direction === "outbound") {
      if (hasId && typeof envelope.method === "string") {
        if (this.#pending.size >= MAX_PENDING_REQUESTS) this.retire();
        else this.#pending.add(id);
      }
      return false;
    }
    if (hasId && envelope.method === undefined) {
      this.#pending.delete(id);
      return false;
    }
    const params = record(envelope.params);
    const ownSession = params.sessionId === undefined || params.sessionId === this.#hooks.sessionId();
    if (hasId) {
      const active = this.#active;
      if (!active || !ownSession || envelope.method !== "session/request_permission") return false;
      this.#touch();
      return true;
    }
    if (envelope.method !== "session/update" || !ownSession) return false;
    const update = record(params.update);
    let active = this.#active;
    if (!active) {
      if (this.#retired || this.#pending.size > 0 || this.#hooks.promptActive()) return false;
      if (typeof update.sessionUpdate !== "string" || !START_KINDS.has(update.sessionUpdate)) return false;
      active = this.#open();
      if (!active) return false;
    }
    this.#touch();
    active.accept(message);
    if (claudeProviderTurnEndMarker(update)) {
      active.finishAfterQueued({ status: "completed", stopReason: "end_turn", usage: cycleUsage(update) }, () => this.#clear(active!));
    }
    return true;
  }

  cancel(): boolean {
    const active = this.#active;
    if (!active || active.settled) return false;
    this.#retired = true;
    active.finish({ status: "cancelled", stopReason: "cancelled" }, () => this.#clear(active));
    return true;
  }

  fail(code: string, message: string): void {
    const active = this.#active;
    this.#retired = true;
    if (!active || active.settled) return;
    active.finish({ status: "failed", error: { code, message, retryable: false } }, () => this.#clear(active));
  }

  retire(): void {
    this.#retired = true;
  }

  #open(): ActiveProviderTurn | null {
    const turn = new ActiveProviderTurn(this.#hooks.mintTurnId?.() ?? `provider-${randomUUID()}`);
    this.#active = turn;
    let admission: ClaudeProviderTurnAdmission | null = null;
    try {
      admission = this.#hooks.admit(turn, (code, message) => this.fail(code, message));
    } catch {
      admission = null;
    }
    if (!admission) {
      this.#active = null;
      this.#retired = true;
      turn.finish({ status: "failed", error: { code: "ACPX_PROVIDER_TURN_DECLINED", message: "The provider-started turn was not admitted.", retryable: false } }, () => undefined);
      return null;
    }
    turn.admission = admission;
    return turn;
  }

  #touch(): void {
    if (this.#timer) clearTimeout(this.#timer);
    const silenceMs = this.#hooks.silenceMs ?? CLAUDE_PROVIDER_TURN_SILENCE_MS;
    const check = () => {
      const active = this.#active;
      if (!active || active.settled) return;
      if (active.admission?.busy()) {
        this.#timer = setTimeout(check, silenceMs);
        this.#timer.unref?.();
        return;
      }
      this.fail(CLAUDE_PROVIDER_TURN_SILENT, "Claude's own turn sent nothing within the silence bound.");
    };
    this.#timer = setTimeout(check, silenceMs);
    this.#timer.unref?.();
  }

  #clear(turn: ActiveProviderTurn): void {
    if (this.#active !== turn) return;
    this.#active = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
