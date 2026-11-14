import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { AcpxRuntimeHost as Base } from "./acpx-blocked-output-host.mjs";
import { ClaudeProviderCycles } from "../drivers/acpx/claude-provider-turns.ts";

const SESSION = "blocked-output-backend";
const air = { jetbrains: { air: { version: 1, capabilities: ["sessionFailure", "asyncTasks"] } } };
const update = (body) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId: SESSION, update: body } });
const spawned = (id) => update({ sessionUpdate: "async_task_spawned", asyncTaskId: id, name: id, taskType: "shell", description: id, showInTranscript: false, canStop: true });
const finished = (id) => update({ sessionUpdate: "async_task_state_update", asyncTaskId: id, state: "completed" });
const usage = () => update({ sessionUpdate: "usage_update", used: 3, size: 100 });
const endMarker = () => update({ sessionUpdate: "usage_update", used: 4, size: 100,
  _meta: { "_claude/origin": { kind: "task-notification" }, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const toolCall = (id) => update({ sessionUpdate: "tool_call", toolCallId: id, title: "call_api", kind: "other", status: "pending" });
const overlapping = () => JSON.parse(readFileSync(join(process.env.PAPERCLIP_TEST_OUTPUT_ROOT, "script.json"), "utf8")).overlap === true;
const gate = async (name) => { while (!existsSync(join(process.env.PAPERCLIP_TEST_OUTPUT_ROOT, name))) await new Promise((resolve) => setTimeout(resolve, 5)); };

export class AcpxRuntimeHost extends Base {
  static async open(options) {
    const host = await Base.open(options);
    Object.setPrototypeOf(host, this.prototype);
    let minted = 0;
    host.cycles = new ClaudeProviderCycles({ sessionId: () => SESSION, promptActive: () => false, mintTurnId: () => `provider-${++minted}` }).subscribe();
    host.deliver("outbound", { jsonrpc: "2.0", id: 0, method: "initialize", params: { clientCapabilities: { _meta: air } } });
    host.deliver("inbound", { jsonrpc: "2.0", id: 0, result: { protocolVersion: 1, _meta: air } });
    return host;
  }

  deliver(direction, message) {
    this.cycles.observe(direction, message);
  }

  backgroundTaskState() { return this.cycles.backgroundTasks(); }
  providerCycles() {
    const cycles = this.cycles;
    return {
      next: () => cycles.next(),
      adopt: (binding) => { cycles.adopt(binding.busy); return true; },
      drop: () => cycles.drop(),
      cancel: () => cycles.cancel(),
      decisionFor: (toolCallId) => cycles.decisionFor(toolCallId),
    };
  }
  providerTurnsAvailable() { return !this.cycles.retired; }
  isClosed() { return this.closed; }

  startTurn({ requestId }) {
    this.deliver("outbound", { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: SESSION } });
    this.deliver("inbound", spawned("task-1"));
    this.deliver("inbound", spawned("task-2"));
    this.deliver("inbound", { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
    if (overlapping()) {
      void (async () => {
        await gate("cycles");
        this.deliver("inbound", finished("task-1"));
        this.deliver("inbound", usage());
        this.deliver("inbound", endMarker());
        this.deliver("inbound", usage());
        this.deliver("inbound", toolCall("toolu_01Later"));
        void this.options.semanticTools.handler({ callId: "1", tool: "call_api", arguments: {}, signal: new AbortController().signal,
          providerToolUseId: "toolu_01Later" }).catch(() => undefined);
        await gate("later-end");
        this.deliver("inbound", endMarker());
      })();
      return { requestId, promptStarted: Promise.resolve(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
        events: (async function* () {})() };
    }
    void (async () => {
      await gate("cycles");
      this.deliver("inbound", finished("task-1"));
      this.deliver("inbound", usage());
      this.deliver("inbound", endMarker());
      await gate("second");
      this.deliver("inbound", finished("task-2"));
      this.deliver("inbound", usage());
      await gate("second-end");
      this.deliver("inbound", endMarker());
    })();
    return { requestId, promptStarted: Promise.resolve(), result: Promise.resolve({ status: "completed", stopReason: "end_turn" }),
      events: (async function* () {})() };
  }
}
