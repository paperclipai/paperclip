import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AcpxRuntimeHost as Base } from "./acpx-blocked-output-host.mjs";

const root = () => process.env.PAPERCLIP_TEST_OUTPUT_ROOT;
const script = () => JSON.parse(readFileSync(join(root(), "script.json"), "utf8"));
const note = (key, value) => {
  const path = join(root(), "observed.json");
  const observed = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  observed[key] = value;
  writeFileSync(path, JSON.stringify(observed));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = async (name) => { while (!existsSync(join(root(), name))) await sleep(5); };

let turn = -1;
let state = { live: 0 };

class Cycles {
  queue = [];
  wake = null;
  closed = false;
  decision = null;
  binding = null;
  open = false;

  push(item) {
    if (this.closed) return;
    this.queue.push(item);
    this.wake?.();
  }

  start(requestId) {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    this.decision = { promise, settle };
    this.binding = null;
    this.open = true;
    note("offered", true);
    this.push({ type: "started", requestId });
  }

  end(result) {
    if (!this.open) return;
    this.open = false;
    this.push({ type: "ended", result });
  }

  async next() {
    for (;;) {
      if (this.queue.length > 0) return this.queue.shift();
      if (this.closed) return null;
      await new Promise((resolve) => { this.wake = resolve; });
    }
  }

  adopt(binding) {
    note("admitted", true);
    this.binding = binding;
    this.decision?.settle(true);
    this.decision = null;
    return true;
  }

  drop() {
    note("dropped", true);
    this.decision?.settle(false);
    this.decision = null;
    this.queue = [];
    this.closed = true;
    this.wake?.();
  }

  cancel() {
    note("cancelProviderTurn", true);
    if (!this.open) return false;
    this.end({ status: "cancelled", stopReason: "cancelled" });
    return true;
  }

  decisionFor() {
    return this.decision?.promise ?? null;
  }
}

export class AcpxRuntimeHost extends Base {
  static async open(options) {
    const host = await Base.open(options);
    Object.setPrototypeOf(host, this.prototype);
    host.cycles = new Cycles();
    return host;
  }

  backgroundTaskState() { return state; }

  providerCycles() {
    note("listenerRegistered", true);
    return this.cycles;
  }

  isClosed() { return this.closed; }

  async status() {
    const held = this.terminalGate;
    this.terminalGate = null;
    if (held) await gate(held);
    return {};
  }

  providerTurnsAvailable() { return !existsSync(join(root(), "exited")) && !this.cycles.closed; }

  async close(input) {
    if (this.closed) return;
    note("closed", input.reason);
    return await super.close(input);
  }

  startTurn({ requestId }) {
    const current = script().turns[++turn];
    state = current.state;
    this.terminalGate = current.holdTerminal ?? null;
    if (current.cycle) void this.offerCycle(current.cycle);
    if (current.lose) void gate(current.lose).then(() => this.cycles.push({ type: "lost" }));
    return { requestId, promptStarted: Promise.resolve(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      events: (async function* () {})() };
  }

  async offerCycle(cycle) {
    if (cycle.gate) await gate(cycle.gate);
    else if (!cycle.immediate) await sleep(50);
    const cycles = this.cycles;
    if (cycles.closed) return;
    cycles.start(cycle.requestId);
    const handler = this.options.semanticTools.handler;
    for (const step of cycle.steps) {
      if (!cycles.open) return;
      if (step.event) cycles.push({ type: "event", event: step.event });
      if (step.call) {
        handler({ callId: "1", tool: step.call, arguments: {}, signal: new AbortController().signal, providerToolUseId: step.toolUseId })
          .then((value) => note(`call:${step.toolUseId}`, value), (error) => note(`call:${step.toolUseId}`, `error:${error.message}`));
      }
      if (step.permission) {
        const decided = cycles.decisionFor(step.permission);
        void Promise.resolve(decided ?? true).then((adopted) => adopted && cycles.binding
          ? cycles.binding.onPermissionRequest({ sessionId: "blocked-output-backend", inferredKind: "execute", raw: { sessionId: "blocked-output-backend",
            toolCall: { toolCallId: step.permission, title: "Run a command", kind: "execute" },
            options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "reject", name: "Reject" }] } },
            { signal: new AbortController().signal, responseDelivery: Promise.resolve() })
          : { outcome: "cancel" })
          .then((decision) => note(`permission:${step.permission}`, decision));
      }
      if (step.busy !== undefined) note("busy", cycles.binding?.busy() ?? false);
      if (step.plan) {
        const adopted = await (cycles.decisionFor(step.plan.toolCallId) ?? true);
        if (adopted) cycles.binding?.onPlanProposal?.(step.plan);
        note("planOffered", adopted);
      }
      if (step.gate) await gate(step.gate);
      if (step.sleep) await sleep(step.sleep);
      if (step.state) state = step.state;
    }
    if (!cycles.open) return;
    cycles.end(cycle.result);
    if (cycle.next) void this.offerCycle(cycle.next);
  }
}
