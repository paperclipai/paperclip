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

export class AcpxRuntimeHost extends Base {
  static async open(options) {
    const host = await Base.open(options);
    Object.setPrototypeOf(host, this.prototype);
    return host;
  }

  backgroundTaskState() { return state; }

  onProviderTurn(listener) {
    note("listenerRegistered", true);
    this.providerTurnListener = listener;
  }

  cancelProviderTurn() {
    note("cancelProviderTurn", true);
    this.cancelActive?.();
    return true;
  }

  isClosed() { return this.closed; }

  providerTurnsAvailable() { return !existsSync(join(root(), "exited")); }

  async close(input) {
    if (this.closed) return;
    note("closed", input.reason);
    return await super.close(input);
  }

  startTurn({ requestId }) {
    const current = script().turns[++turn];
    state = current.state;
    if (current.cycle) void this.offerCycle(current.cycle);
    return { requestId, promptStarted: Promise.resolve(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      events: (async function* () {})() };
  }

  async offerCycle(cycle) {
    if (cycle.gate) await gate(cycle.gate);
    else await sleep(50);
    const queue = [];
    let wake = null, closed = false, settle;
    const push = (event) => { queue.push(event); wake?.(); };
    const close = () => { closed = true; wake?.(); };
    const result = new Promise((resolve) => { settle = resolve; });
    const turn = {
      requestId: cycle.requestId,
      result,
      events: (async function* () {
        for (;;) {
          if (queue.length > 0) { yield queue.shift(); continue; }
          if (closed) return;
          await new Promise((resolve) => { wake = resolve; });
        }
      })(),
    };
    this.cancelActive = () => { close(); settle({ status: "cancelled", stopReason: "cancelled" }); };
    const binding = this.providerTurnListener?.(turn) ?? null;
    note("admitted", binding !== null);
    if (!binding) return;
    const handler = this.options.semanticTools.handler;
    for (const step of cycle.steps) {
      if (closed) return;
      if (step.event) push(step.event);
      if (step.call) {
        handler({ callId: "1", tool: step.call, arguments: {}, signal: new AbortController().signal, providerToolUseId: step.toolUseId })
          .then((value) => note(`call:${step.toolUseId}`, value), (error) => note(`call:${step.toolUseId}`, `error:${error.message}`));
      }
      if (step.permission) {
        void binding.onPermissionRequest({ sessionId: "blocked-output-backend", inferredKind: "execute", raw: { sessionId: "blocked-output-backend",
          toolCall: { toolCallId: step.permission, title: "Run a command", kind: "execute" },
          options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "reject", name: "Reject" }] } },
          { signal: new AbortController().signal, responseDelivery: Promise.resolve() })
          .then((decision) => note(`permission:${step.permission}`, decision));
      }
      if (step.busy !== undefined) note("busy", binding.busy());
      if (step.gate) await gate(step.gate);
      if (step.sleep) await sleep(step.sleep);
      if (step.state) state = step.state;
    }
    if (closed) return;
    close();
    settle(cycle.result);
    if (cycle.next) void this.offerCycle(cycle.next);
  }
}
