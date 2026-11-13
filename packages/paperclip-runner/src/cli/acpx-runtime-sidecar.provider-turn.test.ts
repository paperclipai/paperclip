import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/sidecar-protocol.js";
import { initializeRequest, SidecarProcess } from "../test-support/acpx-sidecar-process.js";

const children = new Set<SidecarProcess>();
afterEach(async () => {
  for (const child of children) await child.close();
  children.clear();
});

const PROVIDER = "provider-test";
const completedCycle = {
  requestId: PROVIDER,
  steps: [
    { event: { type: "status", text: "usage updated", tag: "usage_update", used: 3, size: 100 } },
    { event: { type: "tool_call", text: "probe", tag: "tool_call", title: "mcp__paperclip__probe", toolCallId: "toolu_cycle", status: "pending" } },
    { call: "call_api", toolUseId: "toolu_cycle" },
    { gate: "tool-resolved" },
    { permission: "toolu_bash" },
    { gate: "permission-resolved" },
    { state: { live: 0 } },
  ],
  result: { status: "completed", stopReason: "end_turn", usage: { type: "status", tag: "usage_update", text: "terminal prompt usage",
    cost: { amount: 0.5, currency: "USD" }, breakdown: { inputTokens: 6, outputTokens: 4, cachedReadTokens: 0, cachedWriteTokens: 0 } } },
};

async function open(scenario: { agent?: "claude" | "codex"; turns: unknown[] }) {
  const root = mkdtempSync(join(tmpdir(), "acpx-provider-turn-"));
  const loader = join(root, "loader.mjs");
  const fixture = new URL("../test-support/acpx-provider-turn-host.mjs", import.meta.url);
  writeFileSync(join(root, "script.json"), JSON.stringify(scenario));
  writeFileSync(loader, `import { registerHooks } from "node:module";
    registerHooks({resolve(specifier,context,next){
      if(context.parentURL?.includes("/acpx-runtime-sidecar.") && specifier.endsWith("/runtime-host.js"))
        return {url:${JSON.stringify(fixture.href)},shortCircuit:true};
      return next(specifier,context);
    }});`);
  const sidecar = new SidecarProcess({ loader, environment: { PAPERCLIP_TEST_OUTPUT_ROOT: root } });
  children.add(sidecar);
  const agent = scenario.agent ?? "claude";
  const model = agent === "claude" ? "claude-sonnet-5" : "gpt-5.6-sol";
  let id = 0;
  const request = async (command: string, params: Record<string, unknown>) => {
    sidecar.write({ protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION, id: ++id, command, params });
    const sent = id;
    return await sidecar.next(frame => frame.id === sent);
  };
  const send = async (command: string, params: Record<string, unknown>) => {
    const reply = await request(command, params);
    expect(reply).toMatchObject({ ok: true });
    return reply.result as Record<string, unknown>;
  };
  sidecar.write(initializeRequest(++id, agent, model));
  expect(await sidecar.next(frame => frame.id === 1)).toMatchObject({ ok: true });
  await send("session.open", { agent, model, runtimeDirectory: root, workingDirectory: root, normalizedSessionId: "provider-session",
    permissionMode: "approve-reads", systemInstructions: "Test provider turns.", tools: [{ name: "call_api", description: "Call.", inputSchema: { type: "object" } }] });
  await send("run.attach", { runId: "provider-run", catalogRevision: 1, tools: [{ name: "call_api", description: "Call.", inputSchema: { type: "object" } }] });
  const observed = () => existsSync(join(root, "observed.json")) ? JSON.parse(readFileSync(join(root, "observed.json"), "utf8")) as Record<string, unknown> : {};
  const release = (name: string) => writeFileSync(join(root, name), "");
  return { sidecar, root, request, send, observed, release, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const payload = (frame: Record<string, unknown>) => frame.payload as Record<string, unknown>;

describe("ACPX sidecar provider-started Claude turns", () => {
  it("surfaces Claude's own cycle after a turn that left a shell running as a provider-started turn", async () => {
    const { sidecar, send, observed, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle: completedCycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start a background command." });
      const first = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(payload(first)).toEqual({ status: "completed", stopReason: "end_turn", backgroundTasks: { live: 1 } });
      expect(await sidecar.next(frame => frame.eventType === "runtime.turn_started")).toMatchObject({ runId: "provider-run", turnId: PROVIDER, payload: { origin: "provider" } });
      const tool = await sidecar.next(frame => frame.eventType === "runtime.event" && payload(frame).type === "tool_call");
      expect(tool.turnId).toBe(PROVIDER);
      const called = await sidecar.next(frame => frame.eventType === "runtime.tool_called");
      expect(called).toMatchObject({ turnId: PROVIDER, payload: { callId: "tool-use:toolu_cycle", operationId: "call_api" } });
      expect(await send("session.snapshot", {})).toMatchObject({ turnId: PROVIDER, pendingToolCount: 1 });
      await send("tool.resolve", { turnId: PROVIDER, callId: "tool-use:toolu_cycle", result: { ok: true } });
      release("tool-resolved");
      const permission = await sidecar.next(frame => frame.eventType === "runtime.permission_requested");
      expect(permission.turnId).toBe(PROVIDER);
      await send("permission.resolve", { turnId: PROVIDER, requestId: payload(permission).requestId, resolution: { action: "accept" } });
      release("permission-resolved");
      const usage = await sidecar.next(frame => frame.eventType === "runtime.event" && payload(frame).text === "terminal prompt usage");
      expect(usage).toMatchObject({ turnId: PROVIDER, payload: { tag: "usage_update", cost: { amount: 0.5, currency: "USD" },
        breakdown: { inputTokens: 6, outputTokens: 4, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0 } } });
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toEqual({ status: "completed", stopReason: "end_turn", backgroundTasks: { live: 0 } });
      expect(observed()).toMatchObject({ listenerRegistered: true, admitted: true, "call:toolu_cycle": { ok: true },
        "permission:toolu_bash": { outcome: "allow_once" } });
      expect(await send("session.snapshot", {})).toMatchObject({ turnId: null, backgroundTasks: { live: 0 } });
    } finally { cleanup(); }
  }, 20_000);

  it("ends a provider-started turn cut off by provider exit as failed with the named code", async () => {
    const cycle = { requestId: PROVIDER, steps: [{ event: { type: "status", text: "usage updated", tag: "usage_update" } }],
      result: { status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST", message: "The owned ACPX provider exited during Claude's own turn", retryable: false } } };
    const { sidecar, send, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_started");
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toEqual({ status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST",
        message: "The owned ACPX provider exited during Claude's own turn", retryable: false } });
    } finally { cleanup(); }
  }, 20_000);

  it("refuses a controller turn while a provider-started turn is active and cancels that turn by closing the provider", async () => {
    const cycle = { requestId: PROVIDER, steps: [{ event: { type: "status", text: "usage updated", tag: "usage_update" } }, { gate: "never" }],
      result: { status: "completed", stopReason: "end_turn", usage: null } };
    const { sidecar, send, request, observed, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_started");
      expect(await request("turn.start", { turnId: "turn-2", message: "Paperclip's turn." })).toMatchObject({ ok: false,
        error: { message: expect.stringContaining("already has an active turn") } });
      expect(await send("turn.cancel", { turnId: PROVIDER, reason: "Stop" })).toEqual({ cancelled: true, sessionClosed: true });
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toEqual({ status: "cancelled", stopReason: "cancelled" });
      expect(observed()).toMatchObject({ cancelProviderTurn: true, closed: "Stop" });
    } finally { cleanup(); }
  }, 20_000);

  it("does not adopt a cycle after a turn that left no known live shell, nor after a later controller turn", async () => {
    const quiet = await open({ turns: [{ state: { live: 0 }, cycle: { ...completedCycle, gate: "offer" } }] });
    try {
      await quiet.send("turn.start", { turnId: "turn-1", message: "Start." });
      await quiet.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      quiet.release("offer");
      await expect.poll(() => quiet.observed().cancelProviderTurn, { timeout: 5_000 }).toBe(true);
      expect(quiet.sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { quiet.cleanup(); }

    const superseded = await open({ turns: [{ state: { live: 1 }, cycle: { ...completedCycle, gate: "offer" } }, { state: { live: 0 } }] });
    try {
      await superseded.send("turn.start", { turnId: "turn-1", message: "Start." });
      await superseded.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      await superseded.send("turn.start", { turnId: "turn-2", message: "Paperclip's next turn." });
      await superseded.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-2");
      superseded.release("offer");
      await expect.poll(() => superseded.observed().cancelProviderTurn, { timeout: 5_000 }).toBe(true);
      expect(superseded.sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { superseded.cleanup(); }
  }, 20_000);

  it("leaves non-Claude agents without a provider-turn listener", async () => {
    const { sidecar, send, observed, cleanup } = await open({ agent: "codex", turns: [{ state: { live: 1 }, cycle: completedCycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal");
      expect(payload(terminal)).toEqual({ status: "completed", stopReason: "end_turn" });
      await expect.poll(() => observed().admitted, { timeout: 5_000 }).toBe(false);
      expect(observed().listenerRegistered).toBeUndefined();
      expect(sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { cleanup(); }
  }, 20_000);
});
