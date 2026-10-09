import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DurableRecoveryCommittedEvent, DurableRecoveryIdentity } from "../contracts/durable-recovery.js";

// Replace only the PRP peer and process boundary. The production transport,
// event pump, registered handler, and request emission below all run unchanged.
const peer = vi.hoisted(() => ({ current: null as TestPeer | null }));
interface TestPeer {
  store: { state: { identity: DurableRecoveryIdentity; committedEvents: DurableRecoveryCommittedEvent[]; commands: Array<Record<string, unknown>> } };
  emit(type: string, payload: Record<string, unknown>): void;
}
vi.mock("../control-plane/durable-prp-control-plane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../control-plane/durable-prp-control-plane.js")>();
  return {
    ...actual,
    spawnRunner: vi.fn(() => ({ child: { exitCode: null }, completion: new Promise(() => {}) })),
    DurablePrpControlPlane: class implements TestPeer {
      store: TestPeer["store"];
      connectUrl = "ws://fixture.invalid";
      constructor(options: { identity: DurableRecoveryIdentity }) {
        this.store = { state: { identity: options.identity, committedEvents: [], commands: [] } };
        peer.current = this;
      }
      async start() {}
      async stop() {}
      disconnectActiveRunner() {}
      persistRunAttachTemplate() {}
      issueBootstrapTicket() { return {}; }
      getCommand(id: string) { return this.store.state.commands.find(c => c.commandId === id); }
      queueCommand(type: string, payload: Record<string, unknown>, id = type) {
        this.store.state.commands.push({ type, commandId: id, status: "completed", result: { result: { providerTurnId: payload.turnId } } });
        if (type === "session.open") this.emit("session.started", {
          threadId: "thread-1", sessionId: "provider-session-1",
          runtimeIdentity: { executionKind: "remote_service" },
        });
        if (type === "turn.start") this.emit("turn.started", { providerTurnId: payload.turnId });
      }
      emit(eventType: string, payload: Record<string, unknown>) {
        const sourceSeq = this.store.state.committedEvents.length + 1;
        this.store.state.committedEvents.push({
          eventType, sourceSeq, sourceEventId: `fixture:${sourceSeq}`,
          priority: 0, deliveryCount: 1, logicalEffectCount: 1,
          envelope: { turnId: this.store.state.identity.turnId, payload: { payload } },
        });
      }
    },
  };
});
import { cursorToolIdentity, cursorToolExecutionId } from "../drivers/acpx/cursor-plan-tool-identity.js";
import { normalizeAcpxPermission } from "../drivers/acpx/acp-permission-adapter.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { makeDriver, WORKSPACE } from "../drivers/codex/codex-app-server-driver.test-support.js";
import type { PrpEvent } from "../protocol/replay-contract.js";


describe("permission and tool order through the actual transport and harness", () => {
  it.each(["tool-first", "permission-first"].flatMap(order => ["native-tool-7", "native\u0080tool", "native\u0085tool", "native\u009ftool", "tool/1", "x".repeat(161)].map(rawId => ({ order, rawId }))))("preserves committed batch order and native identity with an unanswered permission: $order $rawId", async ({ order, rawId }) => {
    const toolCallId = cursorToolIdentity(rawId);
    const executionId = cursorToolExecutionId(rawId);
    const normalized = normalizeAcpxPermission({ sessionId: "provider-session-1", inferredKind: "execute", raw: {
      sessionId: "provider-session-1", toolCall: { toolCallId: rawId, kind: "execute" },
      options: [{ kind: "reject_once", optionId: "original-native-denial", name: "Deny" }],
    } }, { provider: "cursor" });
    expect(normalized.toolCallId).toBe(toolCallId);
    const root = mkdtempSync(join(tmpdir(), "permission-ordering-"));
    const binary = join(root, "unexecuted-runner");
    writeFileSync(binary, "not executable: process boundary is mocked");
    const bundle = createCapabilityRunnerdCodexTransport({
      runnerBinary: binary, stateDirectory: root,
      sourceCodexHome: join(root, "absent-source-home"),
      environment: { HOME: root, PATH: "/usr/bin:/bin" },
    });
    const driver = makeDriver([], { transportFactory: () => bundle.transport });
    const seen: PrpEvent[] = [];
    let session: Awaited<ReturnType<typeof driver.openSession>> | undefined;
    let drain: Promise<void> | undefined;
    try {
      session = await driver.openSession({ runId: "ordering-run", normalizedSessionId: "ordering-session", workingDirectory: WORKSPACE });
      const { turnId } = await session.startTurn({ message: { role: "user", text: "Fixture" } });
      drain = (async () => { for await (const event of session!.events()) {
        seen.push(event);
        if (seen.some(e => e.eventType === "runtime_request.created") && seen.some(e => e.eventType === "tool.execution.started")) break;
      } })();
      const tool = () => peer.current!.emit("tool.execution.started", {
        schema: "paperclip.tool.execution.v1", executionId, transport: "builtin", namespace: null,
        name: "Run command", operation: "execute", target: null, status: "running", readOnly: false,
        inputUpdated: true, output: null, outputBytes: 0, outputTruncated: false, outputDigest: null,
        durationMs: null, exitCode: null, progress: [],
      });
      const permission = () => peer.current!.emit("runtime_request.created", { request: {
        requestId: "permission-7", type: "permission", requestKind: "permission_approval",
        itemId: "opaque-item-7", prompt: "Run command", details: { toolCallId: normalized.toolCallId },
        choices: [{ key: "decline", label: "Deny" }, { key: "cancel", label: "Cancel" }],
        origin: { adapter: "acpx-runtime-sidecar", provider: "cursor", method: "session/request_permission" },
      } });
      // Both durable events exist before the production pump's next tick.
      // Keep the permission unanswered while the independent tool pump drains.
      if (order === "tool-first") { tool(); permission(); } else { permission(); tool(); }
      await vi.waitFor(() => expect(seen.filter(e => ["tool.execution.started", "runtime_request.created"].includes(e.eventType))).toHaveLength(2), { timeout: 1_000, interval: 5 });
      const nativeOrder = peer.current!.store.state.committedEvents.filter(e => ["tool.execution.started", "runtime_request.created"].includes(e.eventType)).map(e => e.eventType);
      const projectedOrder = seen.filter(e => ["tool.execution.started", "runtime_request.created"].includes(e.eventType)).map(e => e.eventType);
      expect(session.pendingRuntimeRequests!()).toMatchObject([{ requestId: "permission-7", turnId, status: "pending", details: { toolCallId } }]);
      expect(projectedOrder).toEqual(nativeOrder);
      // Permission details retain bounded native identity; activity retains
      // Rust's opaque execution ID. Their deterministic join is intentional.
      expect(seen.find(e => e.eventType === "tool.execution.started")?.payload).toMatchObject({ executionId });
      if (rawId === "tool/1" || rawId.length === 161) expect(executionId).not.toBe(toolCallId);
    } finally {
      // This test owns no actual process or database. Retire the mocked peer
      // and its controller timer without inventing a provider terminal event.
      await bundle.detachControllerForRestart();
      await drain;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function bareTransport() {
  const root = mkdtempSync(join(tmpdir(), "permission-queue-lifecycle-"));
  const binary = join(root, "unexecuted-runner");
  writeFileSync(binary, "not executable: process boundary is mocked");
  const bundle = createCapabilityRunnerdCodexTransport({ runnerBinary: binary, stateDirectory: root,
    sourceCodexHome: join(root, "absent-source-home"), environment: { HOME: root, PATH: "/usr/bin:/bin" },
  });
  await bundle.transport.request("initialize", {});
  await bundle.transport.request("thread/start", { cwd: root });
  await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Fixture" }] });
  const iterator = bundle.transport.notifications()[Symbol.asyncIterator]();
  expect((await iterator.next()).value?.method).toBe("turn/started");
  const emitPermission = (requestId = "permission-7", prompt = "Run command") => peer.current!.emit("runtime_request.created", { request: {
    requestId, type: "permission", requestKind: "permission_approval", itemId: requestId, prompt,
    choices: [{ key: "cancel", label: "Cancel" }], details: { toolCallId: "tool-7" },
    origin: { adapter: "acpx-runtime-sidecar", provider: "cursor", method: "session/request_permission" },
  } });
  const emitMarker = () => peer.current!.emit("item.delta", { kind: "agentMessage", text: "marker" });
  return { bundle, iterator, emitPermission, emitMarker, async close() { await bundle.detachControllerForRestart(); rmSync(root, { recursive: true, force: true }); } };
}

it("discards a queued permission on close before the notification consumer asks for next", async () => {
  const fixture = await bareTransport(); const handler = vi.fn(async () => ({}));
  fixture.bundle.transport.setServerRequestHandler(handler);
  try {
    fixture.emitMarker(); fixture.emitPermission();
    expect((await fixture.iterator.next()).value?.method).toBe("item/agentMessage/delta");
    expect(handler).not.toHaveBeenCalled();
    await fixture.bundle.detachControllerForRestart();
    await expect(fixture.iterator.next()).resolves.toMatchObject({ done: true });
    expect(handler).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it("does not dispatch an expired durable request when its consumer resumes", async () => {
  const fixture = await bareTransport(); const handler = vi.fn(async () => ({}));
  fixture.bundle.transport.setServerRequestHandler(handler);
  try {
    fixture.emitPermission();
    peer.current!.emit("runtime_request.expired", { requestId: "permission-7" });
    fixture.emitMarker();
    expect((await fixture.iterator.next()).value?.method).toBe("item/agentMessage/delta");
    expect(handler).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it("does not dispatch queued approval callbacks into a replacement turn", async () => {
  const fixture = await bareTransport(); const handler = vi.fn(async () => ({}));
  fixture.bundle.transport.setServerRequestHandler(handler);
  try {
    fixture.emitMarker(); fixture.emitPermission();
    expect((await fixture.iterator.next()).value?.method).toBe("item/agentMessage/delta");
    await fixture.bundle.transport.request("turn/start", { input: [{ type: "text", text: "Next turn" }] });
    expect((await fixture.iterator.next()).value?.method).toBe("turn/started");
    expect(handler).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it.each(["throw", "reject"])("closes the queue and wakes its consumer on handler %s", async failure => {
  const fixture = await bareTransport();
  const handler = vi.fn(() => { if (failure === "throw") throw new Error("fixture handler failed"); return Promise.reject(new Error("fixture handler failed")); });
  fixture.bundle.transport.setServerRequestHandler(handler);
  try {
    fixture.emitPermission();
    await expect(fixture.iterator.next()).rejects.toThrow("fixture handler failed");
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(fixture.iterator.next()).rejects.toThrow("fixture handler failed");
  } finally { await fixture.close(); }
});

it.each(["count", "bytes"])("bounds queued permission callback %s without a consumer", async bound => {
  const fixture = await bareTransport(); const handler = vi.fn(async () => ({}));
  fixture.bundle.transport.setServerRequestHandler(handler);
  try {
    if (bound === "count") for (let i = 0; i < 2049; i++) fixture.emitPermission(`permission-${i}`);
    else fixture.emitPermission("oversized", "x".repeat(4 * 1024 * 1024));
    // next waits until the actual event pump reaches the closed queue limit.
    await expect(fixture.iterator.next()).rejects.toThrow("notification queue bound exceeded");
    expect(handler).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});

it("wakes an idle notification consumer during controller shutdown", async () => {
  const fixture = await bareTransport();
  try {
    const pending = fixture.iterator.next();
    await fixture.bundle.detachControllerForRestart();
    await expect(pending).resolves.toMatchObject({ done: true });
  } finally { await fixture.close(); }
});

it("does not transfer a queued request to a newly registered handler", async () => {
  const fixture = await bareTransport(); const original = vi.fn(async () => ({})), replacement = vi.fn(async () => ({}));
  fixture.bundle.transport.setServerRequestHandler(original);
  try {
    fixture.emitMarker(); fixture.emitPermission(); fixture.emitMarker();
    expect((await fixture.iterator.next()).value?.method).toBe("item/agentMessage/delta");
    fixture.bundle.transport.setServerRequestHandler(replacement);
    expect((await fixture.iterator.next()).value?.method).toBe("item/agentMessage/delta");
    expect(original).not.toHaveBeenCalled(); expect(replacement).not.toHaveBeenCalled();
  } finally { await fixture.close(); }
});
