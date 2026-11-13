import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ACPX_SIDECAR_PROTOCOL_VERSION } from "../drivers/acpx/sidecar-protocol.js";
import { claudePlanProposalEvent } from "../provider-events.js";
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

async function open(scenario: { agent?: "claude" | "codex"; turns: unknown[]; host?: string; overlap?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "acpx-provider-turn-"));
  const loader = join(root, "loader.mjs");
  const fixture = new URL(`../test-support/${scenario.host ?? "acpx-provider-turn-host.mjs"}`, import.meta.url);
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
  return { sidecar, root, request, send, observed, release, cleanup: async () => { await sidecar.close(); children.delete(sidecar); rmSync(root, { recursive: true, force: true }); } };
}

const payload = (frame: Record<string, unknown>) => frame.payload as Record<string, unknown>;

describe("ACPX sidecar provider-started Claude turns", () => {
  it("surfaces Claude's own cycle after a turn that left a shell running as a provider-started turn", async () => {
    const { sidecar, send, observed, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle: completedCycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start a background command." });
      const first = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(payload(first)).toEqual({ status: "completed", stopReason: "end_turn", backgroundTasks: { live: 1 } });
      await expect.poll(() => observed().offered, { timeout: 5_000 }).toBe(true);
      expect(sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
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
    } finally { await cleanup(); }
  }, 20_000);

  it("ends a provider-started turn cut off by provider exit as failed with the named code", async () => {
    const cycle = { requestId: PROVIDER, gate: "offer", steps: [{ event: { type: "status", text: "usage updated", tag: "usage_update" } }],
      result: { status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST", message: "The owned ACPX provider exited during Claude's own turn", retryable: false } } };
    const { sidecar, send, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      release("offer");
      await sidecar.next(frame => frame.eventType === "runtime.turn_started");
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toEqual({ status: "failed", error: { code: "ACPX_PROVIDER_PROCESS_LOST",
        message: "The owned ACPX provider exited during Claude's own turn", retryable: false } });
    } finally { await cleanup(); }
  }, 20_000);

  it("publishes a plan proposed in an adopted cycle and ends that turn as a controller turn with a declined plan ends", async () => {
    const plan = { toolCallId: "toolu_plan", markdown: "# Plan\n\nShip it." };
    const cycle = { requestId: PROVIDER, gate: "offer", steps: [{ event: { type: "status", text: "usage updated", tag: "usage_update" } }, { plan }],
      result: { status: "completed", stopReason: "end_turn", usage: null } };
    const { sidecar, send, observed, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      release("offer");
      await sidecar.next(frame => frame.eventType === "runtime.turn_started" && frame.turnId === PROVIDER);
      const proposed = await sidecar.next(frame => frame.eventType === "runtime.rich_event" && payload(frame).eventType === "plan.proposed");
      expect(proposed).toMatchObject({ turnId: PROVIDER, payload: { ...claudePlanProposalEvent(plan) } });
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toEqual({ status: "completed", stopReason: "end_turn" });
      expect(observed().planOffered).toBe(true);
    } finally { await cleanup(); }
  }, 20_000);

  it("publishes nothing for a plan proposed in a dropped cycle", async () => {
    const plan = { toolCallId: "toolu_plan", markdown: "# Plan\n\nShip it." };
    const cycle = { requestId: PROVIDER, gate: "offer", steps: [{ event: { type: "status", text: "usage updated", tag: "usage_update" } }, { plan }],
      result: { status: "completed", stopReason: "end_turn", usage: null } };
    const { sidecar, send, observed, release, cleanup } = await open({ turns: [{ state: { live: 0 }, cycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      release("offer");
      await expect.poll(() => observed().planOffered, { timeout: 5_000 }).toBe(false);
      await send("session.snapshot", {});
      expect(sidecar.pending(frame => frame.eventType === "runtime.rich_event" && payload(frame).eventType === "plan.proposed")).toBe(0);
      expect(sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { await cleanup(); }
  }, 20_000);

  it("refuses a controller turn while a provider-started turn is active and cancels that turn by closing the provider", async () => {
    const cycle = { requestId: PROVIDER, gate: "offer", steps: [{ event: { type: "status", text: "usage updated", tag: "usage_update" } }, { gate: "never" }],
      result: { status: "completed", stopReason: "end_turn", usage: null } };
    const { sidecar, send, request, observed, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      release("offer");
      await sidecar.next(frame => frame.eventType === "runtime.turn_started");
      expect(await request("turn.start", { turnId: "turn-2", message: "Paperclip's turn." })).toMatchObject({ ok: false,
        error: { message: expect.stringContaining("already has an active turn") } });
      expect(await send("turn.cancel", { turnId: PROVIDER, reason: "Stop" })).toEqual({ cancelled: true, sessionClosed: true });
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toEqual({ status: "cancelled", stopReason: "cancelled" });
      expect(observed()).toMatchObject({ cancelProviderTurn: true, closed: "Stop" });
    } finally { await cleanup(); }
  }, 20_000);

  it("adopts a second cycle after the first ends when runnerd arms again", async () => {
    const second = { ...completedCycle, requestId: "provider-second", gate: "second", steps: [
      { event: { type: "tool_call", text: "probe", tag: "tool_call", title: "probe", toolCallId: "toolu_second", status: "pending" } },
      { state: { live: 0 } }] };
    const first = { ...completedCycle, gate: "offer", steps: [
      { event: { type: "status", text: "usage updated", tag: "usage_update" } }, { state: { live: 1 } }], next: second };
    const { sidecar, send, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle: first }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      release("offer");
      const firstTerminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(firstTerminal)).toMatchObject({ status: "completed", backgroundTasks: { live: 1 } });
      expect(await send("session.provider_turn", { turnId: PROVIDER, armed: true })).toEqual({ armed: true });
      release("second");
      expect(await sidecar.next(frame => frame.eventType === "runtime.turn_started" && frame.turnId === "provider-second")).toMatchObject({ payload: { origin: "provider" } });
      const secondTerminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "provider-second");
      expect(payload(secondTerminal)).toMatchObject({ status: "completed", backgroundTasks: { live: 0 } });
    } finally { await cleanup(); }
  }, 20_000);

  it("holds a cycle that starts while the previous provider-started turn is still settling until runnerd arms its terminal", async () => {
    const second = { ...completedCycle, requestId: "provider-second", immediate: true, steps: [
      { event: { type: "tool_call", text: "probe", tag: "tool_call", title: "probe", toolCallId: "toolu_second", status: "pending" } },
      { gate: "second-done" }, { state: { live: 0 } }] };
    const first = { ...completedCycle, gate: "offer", steps: [
      { event: { type: "status", text: "usage updated", tag: "usage_update" } }, { state: { live: 1 } }], next: second };
    const { sidecar, send, observed, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle: first }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      release("offer");
      const firstTerminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(firstTerminal)).toMatchObject({ status: "completed", backgroundTasks: { live: 1 } });
      expect(observed().admitted).toBe(true);
      expect(sidecar.pending(frame => frame.eventType === "runtime.turn_started" && frame.turnId === "provider-second")).toBe(0);
      expect(await send("session.provider_turn", { turnId: PROVIDER, armed: true })).toEqual({ armed: true });
      expect(await sidecar.next(frame => frame.eventType === "runtime.turn_started" && frame.turnId === "provider-second")).toMatchObject({ payload: { origin: "provider" } });
      const tool = await sidecar.next(frame => frame.eventType === "runtime.event" && frame.turnId === "provider-second" && payload(frame).type === "tool_call");
      expect(tool).toBeDefined();
      release("second-done");
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "provider-second");
    } finally { await cleanup(); }
  }, 20_000);

  it("holds a cycle that starts while the prompt turn is still settling and adopts it with its tool call once runnerd arms", async () => {
    const cycle = { ...completedCycle, immediate: true, steps: [
      { event: { type: "tool_call", text: "probe", tag: "tool_call", title: "mcp__paperclip__probe", toolCallId: "toolu_cycle", status: "pending" } },
      { call: "call_api", toolUseId: "toolu_cycle" },
      { gate: "cycle-done" }, { state: { live: 0 } }] };
    const { sidecar, send, observed, release, cleanup } = await open({ turns: [{ state: { live: 1 }, cycle, holdTerminal: "terminal" }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start a background command." });
      await expect.poll(() => observed().offered, { timeout: 5_000 }).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(observed().dropped).toBeUndefined();
      expect(sidecar.pending(frame => frame.eventType === "runtime.turn_terminal")).toBe(0);
      expect(sidecar.pending(frame => frame.eventType === "runtime.tool_called")).toBe(0);
      release("terminal");
      const first = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(payload(first)).toMatchObject({ status: "completed", backgroundTasks: { live: 1 } });
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      expect(await sidecar.next(frame => frame.eventType === "runtime.turn_started")).toMatchObject({ turnId: PROVIDER, payload: { origin: "provider" } });
      const called = await sidecar.next(frame => frame.eventType === "runtime.tool_called");
      expect(called).toMatchObject({ turnId: PROVIDER, payload: { callId: "tool-use:toolu_cycle", operationId: "call_api" } });
      await send("tool.resolve", { turnId: PROVIDER, callId: "tool-use:toolu_cycle", result: { ok: true } });
      release("cycle-done");
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === PROVIDER);
      expect(payload(terminal)).toMatchObject({ status: "completed", backgroundTasks: { live: 0 } });
      expect(observed()).toMatchObject({ admitted: true, "call:toolu_cycle": { ok: true } });
    } finally { await cleanup(); }
  }, 20_000);

  it("tells runnerd the provider is gone only while armed for a provider-started turn", async () => {
    const armed = await open({ turns: [{ state: { live: 1 }, lose: "lose" }] });
    try {
      await armed.send("turn.start", { turnId: "turn-1", message: "Start." });
      await armed.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await armed.send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      armed.release("lose");
      const lost = await armed.sidecar.next(frame => frame.eventType === "runtime.diagnostic" && payload(frame).code === "ACPX_PROVIDER_PROCESS_LOST");
      expect(lost.turnId ?? null).toBeNull();
    } finally { await armed.cleanup(); }

    const unarmed = await open({ turns: [{ state: { live: 1 }, lose: "lose" }] });
    try {
      await unarmed.send("turn.start", { turnId: "turn-1", message: "Start." });
      await unarmed.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      unarmed.release("lose");
      await new Promise(resolve => setTimeout(resolve, 200));
      await unarmed.send("session.snapshot", {});
      expect(unarmed.sidecar.pending(frame => frame.eventType === "runtime.diagnostic" && payload(frame).code === "ACPX_PROVIDER_PROCESS_LOST")).toBe(0);
    } finally { await unarmed.cleanup(); }
  }, 20_000);

  it("binds a later cycle's tool call to that cycle, not to an earlier cycle adopted first", async () => {
    const { sidecar, send, release, cleanup } = await open({ turns: [], host: "acpx-provider-turn-tracked-host.mjs", overlap: true });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start two background commands." });
      const first = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(payload(first)).toMatchObject({ status: "completed", backgroundTasks: { live: 2 } });
      release("cycles");
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(sidecar.pending(frame => frame.eventType === "runtime.tool_called")).toBe(0);
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      const cycleOne = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "provider-1");
      expect(payload(cycleOne)).toMatchObject({ status: "completed", backgroundTasks: { live: 1 } });
      expect(sidecar.pending(frame => frame.eventType === "runtime.tool_called")).toBe(0);
      expect(await send("session.provider_turn", { turnId: "provider-1", armed: true })).toEqual({ armed: true });
      await sidecar.next(frame => frame.eventType === "runtime.turn_started" && frame.turnId === "provider-2");
      const called = await sidecar.next(frame => frame.eventType === "runtime.tool_called");
      expect(called).toMatchObject({ turnId: "provider-2", payload: { callId: "tool-use:toolu_01Later", operationId: "call_api" } });
      await send("tool.resolve", { turnId: "provider-2", callId: "tool-use:toolu_01Later", result: { ok: true } });
      release("later-end");
      await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "provider-2");
    } finally { await cleanup(); }
  }, 20_000);

  it("reports the second shell live at the first cycle's terminal and an unknown state after the second cycle", async () => {
    const { sidecar, send, release, cleanup } = await open({ turns: [], host: "acpx-provider-turn-tracked-host.mjs" });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start two background commands." });
      const first = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(payload(first)).toMatchObject({ status: "completed", backgroundTasks: { live: 2 } });
      expect(await send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      release("cycles");
      const cycleOne = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "provider-1");
      expect(payload(cycleOne)).toMatchObject({ status: "completed", backgroundTasks: { live: 1 } });
      expect(await send("session.provider_turn", { turnId: "provider-1", armed: true })).toEqual({ armed: true });
      release("second");
      await sidecar.next(frame => frame.eventType === "runtime.turn_started" && frame.turnId === "provider-2");
      release("second-end");
      const cycleTwo = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "provider-2");
      expect(payload(cycleTwo)).toEqual({ status: "completed", stopReason: "end_turn" });
    } finally { await cleanup(); }
  }, 20_000);

  it("never surfaces a cycle runnerd did not arm, disarmed, or armed for another terminal or a dead provider", async () => {
    const unarmed = await open({ turns: [{ state: { live: 1 }, cycle: { ...completedCycle, gate: "offer" } }] });
    try {
      await unarmed.send("turn.start", { turnId: "turn-1", message: "Start." });
      await unarmed.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      unarmed.release("offer");
      await expect.poll(() => unarmed.observed().dropped, { timeout: 8_000 }).toBe(true);
      expect(await unarmed.send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: false });
      expect(unarmed.sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { await unarmed.cleanup(); }

    const disarmed = await open({ turns: [{ state: { live: 1 }, cycle: { ...completedCycle, gate: "offer" } }] });
    try {
      await disarmed.send("turn.start", { turnId: "turn-1", message: "Start." });
      await disarmed.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      disarmed.release("offer");
      await expect.poll(() => disarmed.observed().offered, { timeout: 5_000 }).toBe(true);
      expect(await disarmed.send("session.provider_turn", { turnId: "turn-1", armed: false })).toEqual({ armed: false });
      await expect.poll(() => disarmed.observed().dropped, { timeout: 2_000 }).toBe(true);
      expect(disarmed.sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { await disarmed.cleanup(); }

    for (const [name, arming, prepare] of [
      ["another terminal", { turnId: "turn-0", armed: true }, () => undefined],
      ["a quiet terminal", { turnId: "turn-1", armed: true }, () => undefined],
      ["a dead provider", { turnId: "turn-1", armed: true }, (root: string) => writeFileSync(join(root, "exited"), "")],
    ] as const) {
      const state = name === "a quiet terminal" ? { live: 0 } : { live: 1 };
      const session = await open({ turns: [{ state, cycle: { ...completedCycle, gate: "offer" } }] });
      try {
        await session.send("turn.start", { turnId: "turn-1", message: "Start." });
        await session.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
        prepare(session.root);
        expect(await session.send("session.provider_turn", arming), name).toEqual({ armed: false });
        session.release("offer");
        await expect.poll(() => session.observed().dropped, { timeout: 5_000 }).toBe(true);
        expect(session.sidecar.pending(frame => frame.eventType === "runtime.turn_started"), name).toBe(0);
      } finally { await session.cleanup(); }
    }
  }, 40_000);

  it("drops a cycle offered after a later controller turn even if runnerd had armed the earlier terminal", async () => {
    const superseded = await open({ turns: [{ state: { live: 1 }, cycle: { ...completedCycle, gate: "offer" } }, { state: { live: 0 } }] });
    try {
      await superseded.send("turn.start", { turnId: "turn-1", message: "Start." });
      await superseded.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-1");
      expect(await superseded.send("session.provider_turn", { turnId: "turn-1", armed: true })).toEqual({ armed: true });
      await superseded.send("turn.start", { turnId: "turn-2", message: "Paperclip's next turn." });
      await superseded.sidecar.next(frame => frame.eventType === "runtime.turn_terminal" && frame.turnId === "turn-2");
      superseded.release("offer");
      await expect.poll(() => superseded.observed().dropped, { timeout: 5_000 }).toBe(true);
      expect(superseded.sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { await superseded.cleanup(); }
  }, 20_000);

  it("leaves non-Claude agents without a provider-turn listener", async () => {
    const { sidecar, send, observed, cleanup } = await open({ agent: "codex", turns: [{ state: { live: 1 }, cycle: completedCycle }] });
    try {
      await send("turn.start", { turnId: "turn-1", message: "Start." });
      const terminal = await sidecar.next(frame => frame.eventType === "runtime.turn_terminal");
      expect(payload(terminal)).toEqual({ status: "completed", stopReason: "end_turn" });
      await expect.poll(() => observed().offered, { timeout: 5_000 }).toBe(true);
      expect(observed().listenerRegistered).toBeUndefined();
      expect(sidecar.pending(frame => frame.eventType === "runtime.turn_started")).toBe(0);
    } finally { await cleanup(); }
  }, 20_000);
});
