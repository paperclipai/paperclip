// Provider-started turn restart recovery tests split out of
// runnerd-codex-transport.test.ts so Vitest schedules them in parallel with the
// core transport suite instead of serializing them on one worker.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import {
  createCapabilityRunnerdCodexTransport,
  rehydrateRunnerdItemNotification,
  rehydrateRunnerdTurnNotification,
} from "./runnerd-codex-transport.js";
import {
  defaultCapabilityRunnerdBinary,
  fakeCodex,
  fakeCodexArgs,
} from "../../test/support/runnerd-transport.js";

const providerTurnStart = (turnId: string, origin: string | null = "provider") => ({ provider: "acpx", providerTurnId: turnId, status: "inProgress",
  turn: { id: turnId, status: "inProgress" }, ...(origin ? { origin } : {}) });
const providerTurnItem = (turnId: string) => ({ provider: "acpx", itemId: `message-${turnId}`, kind: "agentMessage", status: "completed", text: `${turnId} is done.` });
const providerTurnTerminal = (turnId: string) => ({ provider: "acpx", providerTurnId: turnId, status: "completed", error: null });
const optedInClaude = { provider: "acpx" as const, acpxAgent: "claude" as const, providerStartedTurns: true };

async function deliverProviderTurnEventsAfterRestart(input: {
  options: Record<string, unknown>;
  resumeActiveTurnId?: string;
  acknowledged: Array<[string, Record<string, unknown>]>;
  redelivered: Array<[string, Record<string, unknown>]>;
  removed?: number[];
  finishCall?: boolean;
}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-provider-turn-start-"));
  const OriginalCore = durableControlPlane.DurablePrpControlPlane;
  let callbacks!: ConstructorParameters<typeof OriginalCore>[0];
  let core!: DurablePrpControlPlane;
  const coreSpy = vi.spyOn(durableControlPlane, "DurablePrpControlPlane").mockImplementation(function (options) {
    callbacks = options;
    return core = new OriginalCore(options);
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex, codexArgs: fakeCodexArgs(stateDirectory), stateDirectory,
    ...(input.resumeActiveTurnId ? { resumeActiveTurnId: input.resumeActiveTurnId } : {}),
  });
  const toolCalls: Array<Record<string, unknown>> = [];
  bundle.transport.setServerRequestHandler(async request => {
    toolCalls.push(structuredClone(request.params));
    return { success: true, contentItems: [{ type: "inputText" as const, text: "{\"done\":true}" }] };
  });
  const delivered: Array<{ method: string; params: Record<string, any> }> = [];
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir() });
    const reader = bundle.transport.notifications()[Symbol.asyncIterator]();
    void (async () => { for (let next = await reader.next(); !next.done; next = await reader.next()) delivered.push(next.value); })().catch(() => undefined);
    await new Promise(done => setTimeout(done, 100));
    const before = delivered.length;
    const transport = bundle.transport as unknown as { options: Record<string, unknown> };
    transport.options = { ...transport.options, ...input.options };
    const identity = core.store.state.identity;
    const window = core.store.state.committedEvents;
    const envelope = (eventType: string, payload: Record<string, unknown>) =>
      ({ runId: identity.runId, turnId: identity.turnId, payload: { eventType, turnId: identity.turnId, payload } });
    input.acknowledged.forEach(([eventType, payload], index) => {
      const at = window.length - input.acknowledged.length + index;
      window[at] = { ...window[at]!, eventType, envelope: envelope(eventType, payload) };
    });
    for (const at of [...input.removed ?? []].sort((left, right) => right - left)) window.splice(window.length - input.acknowledged.length + at, 1);
    let seq = window.at(-1)!.sourceSeq;
    const commit = (eventType: string, payload: Record<string, unknown>) => {
      seq += 1;
      window.push({ sourceSeq: seq, sourceEventId: `provider-turn-start-${seq}`, eventType, priority: 1,
        envelope: envelope(eventType, payload), deliveryCount: 1, logicalEffectCount: 1 });
      return `provider-turn-start-${seq}`;
    };
    for (const [eventType, payload] of input.redelivered) commit(eventType, payload);
    (core.store as unknown as { onChange: (() => void) | null }).onChange?.();
    if (input.finishCall) {
      const sourceEventId = commit("tool.execution.started", { executionId: "exec-provider-finish", transport: "dynamic", name: "paperclip_finish", status: "running" });
      const outcome = await callbacks.onSemanticToolInput!({ callId: "exec-provider-finish", operationId: "paperclip_finish",
        input: { summary: "Done" }, sourceEventId, sourceEventType: "semantic_tool.input", correlation: identity });
      expect(outcome.isError).not.toBe(true);
    }
    await new Promise(done => setTimeout(done, 200));
    return { notifications: delivered.slice(before).filter(notification => notification.method.startsWith("turn/") || notification.method.startsWith("item/")), toolCalls };
  } finally {
    coreSpy.mockRestore();
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

const notificationTurns = (notifications: Array<{ method: string; params: Record<string, any> }>) =>
  notifications.map(notification => [notification.method, notification.params.turnId, notification.params.origin ?? null]);

it("gives the driver a provider turn's start before its next event when the start was acknowledged before a restart", async () => {
  const { notifications } = await deliverProviderTurnEventsAfterRestart({ options: optedInClaude,
    acknowledged: [["turn.started", providerTurnStart("provider-1")]],
    redelivered: [["item.completed", providerTurnItem("provider-1")], ["turn.completed", providerTurnTerminal("provider-1")]] });
  expect(notificationTurns(notifications)).toEqual([["turn/started", "provider-1", "provider"], ["item/completed", "provider-1", null], ["turn/completed", "provider-1", null]]);
  expect(notifications[0]!.params).toEqual(rehydrateRunnerdTurnNotification(providerTurnStart("provider-1"), notifications[1]!.params.threadId, "provider-1", "turn/started"));
}, 20_000);

it("gives the driver a provider turn's start before its next event when the window removed events after the start", async () => {
  const { notifications } = await deliverProviderTurnEventsAfterRestart({ options: optedInClaude,
    acknowledged: [["turn.started", providerTurnStart("provider-1")], ["item.completed", providerTurnItem("provider-1")], ["item.completed", providerTurnItem("provider-1")]],
    removed: [1],
    redelivered: [["item.completed", providerTurnItem("provider-1")], ["turn.completed", providerTurnTerminal("provider-1")]] });
  expect(notificationTurns(notifications)).toEqual([["turn/started", "provider-1", "provider"], ["item/completed", "provider-1", null], ["turn/completed", "provider-1", null]]);
}, 20_000);

it("labels each provider turn's events with that turn when the recovery read names a later turn", async () => {
  const { notifications } = await deliverProviderTurnEventsAfterRestart({ options: optedInClaude, resumeActiveTurnId: "provider-2",
    acknowledged: [["turn.started", providerTurnStart("provider-1")]],
    redelivered: [["item.completed", providerTurnItem("provider-1")], ["turn.completed", providerTurnTerminal("provider-1")],
      ["turn.started", providerTurnStart("provider-2")], ["item.completed", providerTurnItem("provider-2")]] });
  expect(notificationTurns(notifications)).toEqual([["turn/started", "provider-1", "provider"], ["item/completed", "provider-1", null],
    ["turn/completed", "provider-1", null], ["turn/started", "provider-2", "provider"], ["item/completed", "provider-2", null]]);
}, 20_000);

it("gives no second start to the provider turn that the recovered driver already has as its active turn", async () => {
  const { notifications } = await deliverProviderTurnEventsAfterRestart({ options: optedInClaude, resumeActiveTurnId: "provider-1",
    acknowledged: [["turn.started", providerTurnStart("provider-1")]],
    redelivered: [["item.completed", providerTurnItem("provider-1")], ["turn.completed", providerTurnTerminal("provider-1")]] });
  expect(notificationTurns(notifications)).toEqual([["item/completed", "provider-1", null], ["turn/completed", "provider-1", null]]);
}, 20_000);

it("gives no second start to a provider turn whose start is delivered again", async () => {
  const { notifications } = await deliverProviderTurnEventsAfterRestart({ options: optedInClaude, acknowledged: [],
    redelivered: [["turn.started", providerTurnStart("provider-1")], ["item.completed", providerTurnItem("provider-1")], ["turn.completed", providerTurnTerminal("provider-1")]] });
  expect(notificationTurns(notifications)).toEqual([["turn/started", "provider-1", "provider"], ["item/completed", "provider-1", null], ["turn/completed", "provider-1", null]]);
}, 20_000);

it.each([
  ["not opted in", { provider: "acpx", acpxAgent: "claude" }, "provider"],
  ["a non-Claude agent", { provider: "acpx", acpxAgent: "codex", providerStartedTurns: true }, "provider"],
  ["another provider", { providerStartedTurns: true }, "provider"],
  ["a controller-started turn", optedInClaude, null],
] as const)("delivers a restarted turn's events as before for %s", async (_case, options, origin) => {
  const { notifications } = await deliverProviderTurnEventsAfterRestart({ options, resumeActiveTurnId: "controller-turn",
    acknowledged: [["turn.started", providerTurnStart("provider-1", origin)]],
    redelivered: [["item.completed", providerTurnItem("provider-1")], ["turn.completed", providerTurnTerminal("provider-1")]] });
  const threadId = notifications[0]!.params.threadId;
  expect(notifications).toEqual([
    { method: "item/completed", params: rehydrateRunnerdItemNotification(providerTurnItem("provider-1"), threadId, "controller-turn") },
    { method: "turn/completed", params: rehydrateRunnerdTurnNotification(providerTurnTerminal("provider-1"), threadId, "controller-turn", "turn/completed") },
  ]);
}, 20_000);

it("binds the finish call of a provider turn whose start was acknowledged before a restart to that turn", async () => {
  const { notifications, toolCalls } = await deliverProviderTurnEventsAfterRestart({ options: optedInClaude, resumeActiveTurnId: "provider-2",
    acknowledged: [["turn.started", providerTurnStart("provider-1")]], redelivered: [], finishCall: true });
  expect(notificationTurns(notifications)).toEqual([["turn/started", "provider-1", "provider"]]);
  expect(toolCalls).toEqual([expect.objectContaining({ turnId: "provider-1", tool: "paperclip_finish", callId: "exec-provider-finish" })]);
}, 20_000);
