import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { COPILOT_AGENT_MODE, createCopilotProtocolGuard } from "./copilot-policy.js";

// Exercise the installed, patched wire stream, not a mock observer. This is a
// pinned internal bundle export; the package-contract suite guards its version.
const bundle = new URL("./dist/live-checkpoint-BSIrfgVo.js", pathToFileURL(createRequire(import.meta.url).resolve("acpx/package.json")));
const { k: AcpClient } = await import(bundle.href);
const safe = { sessionId: "s", modes: { currentModeId: COPILOT_AGENT_MODE }, configOptions: [
  { id: "mode", currentValue: COPILOT_AGENT_MODE }, { id: "allow_all", currentValue: "off" }, { id: "model", currentValue: "gpt-5.6-luna" },
] };

function connection(guarded = true) {
  const written: unknown[] = [];
  let inbound!: ReadableStreamDefaultController;
  const kill = vi.fn();
  const client = new AcpClient({ cwd: "/tmp", agentCommand: "fixture-never-spawned", permissionMode: "deny-all",
    ...(guarded ? { protocolGuardFactory: () => createCopilotProtocolGuard("gpt-5.6-luna") } : {}),
  });
  client.agent = { kill };
  const stream = client.createTappedStream({
    readable: new ReadableStream({ start(controller) { inbound = controller; } }),
    writable: new WritableStream({ write(message) { written.push(message); } }),
  });
  return { client, writer: stream.writable.getWriter(), reader: stream.readable.getReader(), inbound, written, kill };
}

describe("patched ACPX admission guard", () => {
  it.each(["session/new", "session/load", "session/resume"])("rejects unsafe %s before it reaches the SDK", async method => {
    const c = connection();
    await c.writer.write({ id: 0, method, params: { sessionId: "s" } });
    const read = c.reader.read();
    c.inbound.enqueue({ id: 0, result: { ...safe, modes: { currentModeId: "autopilot" } } });
    await expect(read).rejects.toMatchObject({ code: "COPILOT_POLICY_VIOLATION" });
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("rejects permission controls before any bytes reach the provider", async () => {
    const c = connection();
    await c.writer.write({ id: 0, method: "session/new", params: {} });
    c.inbound.enqueue({ id: 0, result: safe }); await c.reader.read();
    await expect(c.writer.write({ id: 1, method: "session/set_config_option", params: { sessionId: "s", configId: "allow_all", value: "on" } })).rejects.toThrow(/admitted permission policy/);
    expect(c.written).toHaveLength(1); expect(c.kill).toHaveBeenCalledOnce();
    c.inbound.close();
  });
  it("errors and stops the provider on drift even without a notification observer", async () => {
    const c = connection();
    await c.writer.write({ id: 0, method: "session/new", params: {} });
    c.inbound.enqueue({ id: 0, result: safe }); await c.reader.read();
    await c.writer.write({ id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Perform task" }] } });
    const read = c.reader.read();
    c.inbound.enqueue({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "current_mode_update", currentModeId: "autopilot" } } });
    await expect(read).rejects.toMatchObject({ code: "COPILOT_POLICY_VIOLATION" });
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("preserves unguarded provider wire behavior", async () => {
    const c = connection(false);
    const message = { method: "session/update", params: { update: { sessionUpdate: "current_mode_update", currentModeId: "other-provider-mode" } } };
    c.inbound.enqueue(message);
    expect((await c.reader.read()).value).toEqual(message);
    expect(c.kill).not.toHaveBeenCalled();
    c.inbound.close();
  });
  it("blocks detached command before the permission request can authorize a side effect", async () => {
    const c = connection();
    await c.writer.write({ id: 0, method: "session/new", params: {} });
    c.inbound.enqueue({ id: 0, result: safe }); await c.reader.read();
    await c.writer.write({ id: 1, method: "session/prompt", params: { sessionId: "s", prompt: [{ type: "text", text: "Run task" }] } });
    const read = c.reader.read();
    const pendingSdkRequest = c.client.runConnectionRequest(() => new Promise(() => {}));
    const pendingRejection = expect(pendingSdkRequest).rejects.toMatchObject({ code: "COPILOT_DETACHED_WORK_UNSUPPORTED" });
    c.inbound.enqueue({ method: "session/update", params: { sessionId: "s", update: {
      sessionUpdate: "tool_call", toolCallId: "native-detached", kind: "execute", status: "pending",
      rawInput: { command: "fixture", mode: "async", detach: true },
    } } });
    c.inbound.enqueue({ id: 0, method: "session/request_permission", params: { sessionId: "s", toolCall: { toolCallId: "native-detached" } } });
    await expect(read).rejects.toMatchObject({ code: "COPILOT_DETACHED_WORK_UNSUPPORTED", message: expect.stringContaining("Run the command attached") });
    await pendingRejection;
    expect(c.written).toHaveLength(2); // Only session/new and session/prompt; no permission response.
    expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
