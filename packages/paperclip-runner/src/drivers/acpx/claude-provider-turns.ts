import { randomUUID } from "node:crypto";

import type { AcpRuntimeEvent } from "acpx/runtime";

import { createAcpSessionUpdateEventConverter, type AcpSessionUpdateEventConverter } from "./acp-session-update-event.js";
import { ClaudeBackgroundTaskTracker, type ClaudeBackgroundTaskState } from "./claude-background-tasks.js";

export const CLAUDE_PROVIDER_TURN_SILENCE_MS = 660_000;
export const CLAUDE_PROVIDER_TURN_PROCESS_LOST = "ACPX_PROVIDER_PROCESS_LOST";
export const CLAUDE_PROVIDER_TURN_SILENT = "ACPX_PROVIDER_TURN_SILENT";
export const CLAUDE_PROVIDER_TURN_CLOSED = "ACPX_PROVIDER_TURN_CLOSED";
export const CLAUDE_PROVIDER_TURN_OVERFLOW = "ACPX_PROVIDER_TURN_OVERFLOW";

const START_KINDS = new Set(["usage_update", "tool_call", "tool_call_update", "agent_message_chunk", "agent_thought_chunk", "plan"]);
const startsCycle = (update: Record<string, unknown>): boolean =>
  typeof update.sessionUpdate === "string" && START_KINDS.has(update.sessionUpdate);
const MAX_PENDING_REQUESTS = 256;
const MAX_QUEUED_MESSAGES = 4_096;
const MAX_TOOL_DECISIONS = 1_024;
const EMPTY_RESULT_USAGE = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

export type ClaudeProviderTurnResult =
  | { status: "completed"; stopReason: "end_turn"; usage: Record<string, unknown> | null }
  | { status: "cancelled"; stopReason: "cancelled" }
  | { status: "failed"; error: { code: string; message: string; retryable: false } };

export type ClaudeProviderCycleItem =
  | { type: "started"; requestId: string }
  | { type: "event"; event: AcpRuntimeEvent }
  | { type: "ended"; result: ClaudeProviderTurnResult }
  | { type: "lost" };

export interface ClaudeProviderCycleSource {
  sessionId(): string | null;
  promptActive(): boolean;
  silenceMs?: number;
  mintTurnId?: () => string;
}

type Queued =
  | { type: "started"; requestId: string; decision: Decision }
  | { type: "message"; message: unknown }
  | { type: "ended"; result: ClaudeProviderTurnResult }
  | { type: "lost" };

type Decision = { promise: Promise<boolean>; settle(adopted: boolean): void };

const ARMING_TURN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

export function parseAcpxProviderTurnArming(params: Record<string, unknown>): { turnId: string; armed: boolean } {
  const keys = Object.keys(params).sort();
  if (keys.length !== 2 || keys[0] !== "armed" || keys[1] !== "turnId"
    || typeof params.armed !== "boolean" || typeof params.turnId !== "string" || !ARMING_TURN_ID.test(params.turnId)) {
    throw new Error("ACPX provider turn arming violates its bounded contract");
  }
  return { turnId: params.turnId, armed: params.armed };
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const failed = (code: string, message: string): ClaudeProviderTurnResult => ({ status: "failed", error: { code, message, retryable: false } });

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

function decision(): Decision {
  let settle!: (adopted: boolean) => void;
  let settled = false;
  const promise = new Promise<boolean>((resolve) => { settle = resolve; });
  return { promise, settle: (adopted) => { if (!settled) { settled = true; settle(adopted); } } };
}

export class ClaudeProviderCycles {
  readonly #source: ClaudeProviderCycleSource;
  readonly #tasks = new ClaudeBackgroundTaskTracker();
  readonly #pending = new Set<string | number>();
  readonly #queue: Queued[] = [];
  readonly #undecided: Decision[] = [];
  readonly #toolDecisions = new Map<string, Decision>();
  #openDecision: Decision | null = null;
  #queuedMessages = 0;
  #waiter: (() => void) | null = null;
  #open = false;
  #subscribed = false;
  #retired = false;
  #closed = false;
  #current: { converter: AcpSessionUpdateEventConverter; busy: () => boolean } | null = null;
  #lastEndMarker: string | null = null;

  constructor(source: ClaudeProviderCycleSource) {
    this.#source = source;
  }

  get retired(): boolean {
    return this.#retired;
  }

  backgroundTasks(): ClaudeBackgroundTaskState | null {
    return this.#tasks.state();
  }

  observe(direction: "inbound" | "outbound", message: unknown): boolean {
    if (direction === "inbound" && this.#repeatsEndMarker(message)) return false;
    const inCycle = this.#classify(direction, message);
    this.#tasks.observe(direction, message, inCycle);
    return inCycle;
  }

  subscribe(): this {
    this.#subscribed = true;
    return this;
  }

  decisionFor(toolCallId: unknown): Promise<boolean> | null {
    const bound = typeof toolCallId === "string" ? this.#toolDecisions.get(toolCallId) : undefined;
    return (bound ?? this.#undecided.at(-1))?.promise ?? null;
  }

  async next(): Promise<ClaudeProviderCycleItem | null> {
    for (;;) {
      const item = this.#queue.shift();
      if (item === undefined) {
        if (this.#closed) return null;
        if (await this.#wait()) continue;
        if (this.#current?.busy()) continue;
        return this.#end(failed(CLAUDE_PROVIDER_TURN_SILENT, "Claude's own turn sent nothing within the silence bound."));
      }
      if (item.type === "started") {
        this.#current = { converter: createAcpSessionUpdateEventConverter(), busy: () => false };
        return { type: "started", requestId: item.requestId };
      }
      if (item.type === "message") {
        this.#queuedMessages -= 1;
        const event = this.#current ? await this.#current.converter.convert(item.message) : null;
        if (event) return { type: "event", event };
        continue;
      }
      if (item.type === "ended") {
        const current = this.#current;
        this.#current = null;
        current?.converter.close();
        this.#tasks.providerTurnEnded(item.result.status === "completed");
        return item;
      }
      return item;
    }
  }

  adopt(busy: () => boolean): void {
    if (this.#current) this.#current.busy = busy;
    this.#undecided.shift()?.settle(true);
  }

  drop(): void {
    const current = this.#current;
    this.#current = null;
    current?.converter.close();
    this.#tasks.providerTurnEnded(false);
    this.#retired = true;
    this.#open = false;
    this.#queue.splice(0);
    this.#close();
  }

  cancel(): boolean {
    if (!this.#open) return false;
    this.#stop({ status: "cancelled", stopReason: "cancelled" });
    return true;
  }

  lost(): void {
    this.#stop(failed(CLAUDE_PROVIDER_TURN_PROCESS_LOST, "The owned ACPX provider exited during Claude's own turn"), true);
  }

  close(): void {
    this.#stop(failed(CLAUDE_PROVIDER_TURN_CLOSED, "The ACPX runtime closed during Claude's own turn."));
  }

  retire(): void {
    this.#retired = true;
  }

  #classify(direction: "inbound" | "outbound", message: unknown): boolean {
    if (this.#closed) return false;
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
    const ownSession = params.sessionId === undefined || params.sessionId === this.#source.sessionId();
    if (hasId) {
      if (!this.#open || !ownSession || envelope.method !== "session/request_permission") return false;
      this.#bindTool(record(params.toolCall).toolCallId);
      return true;
    }
    if (envelope.method !== "session/update" || !ownSession) return false;
    const update = record(params.update);
    if (!this.#open) {
      if (this.#retired || this.#pending.size > 0 || this.#source.promptActive() || !startsCycle(update)) return false;
      if (!this.#subscribed) {
        this.#tasks.providerTurnEnded(false);
        this.retire();
        return false;
      }
      const started = decision();
      this.#undecided.push(started);
      this.#openDecision = started;
      this.#open = true;
      this.#tasks.providerTurnStarted();
      this.#push({ type: "started", requestId: this.#source.mintTurnId?.() ?? `provider-${randomUUID()}`, decision: started });
    }
    if (this.#queuedMessages >= MAX_QUEUED_MESSAGES) {
      this.#stop(failed(CLAUDE_PROVIDER_TURN_OVERFLOW, "Claude's own turn outran its bounded queue."));
      return false;
    }
    this.#queuedMessages += 1;
    this.#push({ type: "message", message });
    this.#bindTool(update.toolCallId);
    if (claudeProviderTurnEndMarker(update)) {
      this.#open = false;
      this.#push({ type: "ended", result: { status: "completed", stopReason: "end_turn", usage: cycleUsage(update) } });
    }
    return true;
  }

  #repeatsEndMarker(message: unknown): boolean {
    const envelope = record(message);
    const params = record(envelope.params);
    const update = record(params.update);
    const usage = record(record(update._meta).usage);
    const marker = envelope.method === "session/update" && claudeProviderTurnEndMarker(update)
      ? JSON.stringify([params.sessionId, update.used, update.size, update.cost])
      : null;
    const empty = EMPTY_RESULT_USAGE.every((key) => usage[key] === 0);
    const repeated = marker !== null && marker === this.#lastEndMarker && empty && !this.#open;
    this.#lastEndMarker = marker;
    return repeated;
  }

  #stop(result: ClaudeProviderTurnResult, lost = false): void {
    this.#retired = true;
    if (this.#closed) return;
    if (this.#open) this.#push({ type: "ended", result });
    this.#open = false;
    if (lost) this.#push({ type: "lost" });
    this.#close();
  }

  #end(result: ClaudeProviderTurnResult): ClaudeProviderCycleItem {
    this.drop();
    return { type: "ended", result };
  }

  #bindTool(toolCallId: unknown): void {
    if (typeof toolCallId !== "string" || this.#openDecision === null) return;
    if (!this.#toolDecisions.has(toolCallId) && this.#toolDecisions.size >= MAX_TOOL_DECISIONS) {
      this.#toolDecisions.delete(this.#toolDecisions.keys().next().value!);
    }
    this.#toolDecisions.set(toolCallId, this.#openDecision);
  }

  #close(): void {
    this.#closed = true;
    for (const pending of this.#undecided.splice(0)) pending.settle(false);
    this.#wake();
  }

  #push(item: Queued): void {
    this.#queue.push(item);
    this.#wake();
  }

  #wait(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.#current ? setTimeout(() => { this.#waiter = null; resolve(false); }, this.#source.silenceMs ?? CLAUDE_PROVIDER_TURN_SILENCE_MS) : null;
      timer?.unref?.();
      this.#waiter = () => { if (timer) clearTimeout(timer); resolve(true); };
    });
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}
