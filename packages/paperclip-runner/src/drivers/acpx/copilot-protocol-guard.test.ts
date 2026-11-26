import { describe, expect, it, vi } from "vitest";
import { COPILOT_AGENT_MODE, createCopilotPolicyEnforcement } from "./copilot-policy.js";
import { acpxInternals } from "../../../test/support/acpx-bundle-internals.mjs";

// Exercise the installed ACPX wire stream with its stock observer. This is a
// pinned internal bundle export; the package-contract suite guards its version.
const { AcpClient } = await acpxInternals(["AcpClient"]);
const safe = { sessionId: "s", modes: { currentModeId: COPILOT_AGENT_MODE }, configOptions: [
  { id: "mode", currentValue: COPILOT_AGENT_MODE }, { id: "allow_all", currentValue: "off" }, { id: "model", currentValue: "gpt-5.6-luna" },
] };

function connection() {
  const written: unknown[] = [];
  let inbound!: ReadableStreamDefaultController;
  const stop = vi.fn();
  const policy = createCopilotPolicyEnforcement("gpt-5.6-luna", stop);
  const client = new AcpClient({ cwd: "/tmp", agentCommand: "fixture-never-spawned", permissionMode: "deny-all" });
  client.setEventHandlers({ onAcpMessage: (direction: "inbound" | "outbound", message: unknown) => policy.observe(direction, message) });
  const stream = client.createTappedStream({
    readable: new ReadableStream({ start(controller) { inbound = controller; } }),
    writable: new WritableStream({ write(message) { written.push(message); } }),
  });
  return { policy, stop, writer: stream.writable.getWriter(), reader: stream.readable.getReader(), inbound, written };
}

async function open(c: ReturnType<typeof connection>, method = "session/new"): Promise<void> {
  await c.writer.write({ id: 0, method, params: method === "session/new" ? {} : { sessionId: "s" } });
  c.inbound.enqueue({ id: 0, result: safe });
  await c.reader.read();
}

describe("Copilot policy enforcement on the stock ACPX stream", () => {
  it.each(["session/new", "session/load", "session/resume"])("stops the provider when %s restores autopilot, before the SDK sees the reply", async method => {
    const c = connection();
    await c.writer.write({ id: 0, method, params: { sessionId: "s" } });
    c.inbound.enqueue({ id: 0, result: { ...safe, modes: { currentModeId: "autopilot" } } });
    await c.reader.read();
    expect(c.stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "COPILOT_POLICY_VIOLATION" }));
    expect(() => c.policy.assertActive()).toThrow(expect.objectContaining({ code: "COPILOT_POLICY_VIOLATION" }));
  });

  it("stops the provider when a permission control is written", async () => {
    const c = connection();
    await open(c);
    await c.writer.write({ id: 1, method: "session/set_config_option", params: { sessionId: "s", configId: "allow_all", value: "on" } });
    expect(c.stop).toHaveBeenCalledOnce();
    expect(() => c.policy.assertActive()).toThrow(/admitted permission policy/);
  });

  it("stops the provider on mid-session mode drift", async () => {
    const c = connection();
    await open(c);
    await c.writer.write({ id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Perform task" }] } });
    c.inbound.enqueue({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "current_mode_update", currentModeId: "autopilot" } } });
    await c.reader.read();
    expect(c.stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "COPILOT_POLICY_VIOLATION" }));
  });

  it("records detached work before its permission request reaches the SDK", async () => {
    const c = connection();
    await open(c);
    await c.writer.write({ id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Run task" }] } });
    c.inbound.enqueue({ method: "session/update", params: { sessionId: "s", update: {
      sessionUpdate: "tool_call", toolCallId: "native-detached", kind: "execute", status: "pending",
      rawInput: { command: "fixture", mode: "async", detach: true },
    } } });
    await c.reader.read();
    expect(c.stop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "COPILOT_DETACHED_WORK_UNSUPPORTED" }));
    expect(() => c.policy.assertActive()).toThrow(/Run the command attached/);
  });

  it("keeps a safe session admitted and starts each connection fresh", async () => {
    const c = connection();
    await open(c);
    await c.writer.write({ id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Perform task" }] } });
    expect(c.stop).not.toHaveBeenCalled();
    c.policy.assertActive();
    c.policy.connect();
    // A new connection has no admitted session until it opens one.
    c.policy.observe("outbound", { id: 2, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Perform task" }] } });
    expect(c.stop).toHaveBeenCalledOnce();
  });
});
