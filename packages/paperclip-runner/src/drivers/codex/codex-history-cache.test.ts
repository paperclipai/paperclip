import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DurablePrpControlPlane } from "../../control-plane/durable-prp-control-plane.js";
import { SqliteAuthorityStore } from "../../control-plane/sqlite-authority-store.js";
import { CodexHistoryMap } from "./codex-history-cache.js";

it("evicts only cache entries: ancient identities remain exact after 2,000 receipts and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "driver-history-"));
  const identity = { runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "session", runId: "run-1", turnId: "turn", itemId: "item" };
  const config = { path: join(root, "authority.sqlite"), binding: JSON.stringify(identity), create: true };
  let store = await SqliteAuthorityStore.open(config);
  const options = { stateDirectory: root, identity, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` };
  let core = await DurablePrpControlPlane.open({ ...options, authorityStore: store });
  try {
    let port = core.normalizedDelivery()!;
    const cache = new CodexHistoryMap<string>("steering", port.history!, [], false);
    for (let page = 0; page < 20; page++) {
      for (let i = 0; i < 100; i++) cache.set(`call-${page * 100 + i}`, `turn-${page * 100 + i}`);
      await port.commit({ expectedRevision: port.load()?.revision ?? 0, raw: { epoch: identity.runId, sourceSeq: 0, ordinal: 0 }, driver: { cache: [...cache] }, events: [], receipts: cache.takeReceipts() });
      expect(cache.size).toBeLessThanOrEqual(128);
      expect(JSON.stringify((await store.load())!.state).length).toBeLessThan(20_000);
    }
    expect(() => cache.get("call-0")).toThrow("exact receipt read");
    await cache.prefetch(["call-0", "never-accepted"]);
    expect(cache.get("call-0")).toBe("turn-0");
    expect(cache.has("never-accepted")).toBe(false);
    await core.stop(); await store.close();
    store = await SqliteAuthorityStore.open({ ...config, create: false });
    core = await DurablePrpControlPlane.open({ ...options, authorityStore: store });
    port = core.normalizedDelivery()!;
    expect(await port.history!.get("steering", "call-0")).toBe("turn-0");
    await core.rotateRunIdentity({ ...identity, runId: "run-2", turnId: "turn-2", itemId: "item-2" });
    await expect(port.history!.get("steering", "call-0")).rejects.toThrow("retired run");
    port = core.normalizedDelivery()!;
    expect(await port.history!.get("steering", "call-0")).toBe("turn-0");
    const before = await store.load();
    await expect(port.commit({ expectedRevision: port.load()?.revision ?? 0, raw: { epoch: "run-2", sourceSeq: 0, ordinal: 0 }, driver: {}, events: [], receipts: [
      { collection: "steering", key: "new-before-conflict", value: "must-not-commit" },
      { collection: "steering", key: "call-0", value: "different-turn" },
    ] })).rejects.toThrow("receipt_conflict");
    expect(await port.history!.get("steering", "new-before-conflict")).toBeNull();
    expect(await store.load()).toEqual(before);
  } finally { await core.stop(); await store.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);

it("normalizes children of evicted ancestors through exact indexed lineage without growing current state", async () => {
  const { FakeCodexTransport, makeDriver, WORKSPACE } = await import("./codex-app-server-driver.test-support.js");
  const { vi } = await import("vitest");
  const root = await mkdtemp(join(tmpdir(), "driver-lineage-history-"));
  const identity = { runnerInstanceId: "runner-codex", environmentLeaseId: "lease", normalizedSessionId: "session-1", runId: "run-1", turnId: "turn-1", itemId: "item-1" };
  const store = await SqliteAuthorityStore.open({ path: join(root, "authority.sqlite"), binding: JSON.stringify(identity), create: true });
  const core = await DurablePrpControlPlane.open({ stateDirectory: root, identity, authorityStore: store, expectedRunnerVersion: "0.3.0", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
  const port = core.normalizedDelivery()!;
  class Transport extends FakeCodexTransport { normalizedDelivery() { return port; } }
  const transport = new Transport("thread-root");
  const session = await makeDriver([transport]).openSession({ runId: identity.runId, normalizedSessionId: identity.normalizedSessionId, workingDirectory: WORKSPACE });
  let lastThread: string | null = null;
  let failure: unknown;
  session.setEventCommitter!(async event => {
    if (event.eventType === "session.failed") failure = event;
    if (event.eventType === "item.started" && event.payload.kind === "thread_lineage") lastThread = (event.payload.lineage as { threadId: string }).threadId;
  });
  const started = (id: string, parent: string, depth: number) => transport.queue.push({ method: "thread/started", params: { thread: { id, sessionId: "codex-account-session", source: { subAgent: { thread_spawn: { parent_thread_id: parent, depth } } }, status: { type: "idle" } } } });
  try {
    await session.startTurn({ message: { text: "Work" } });
    await session.flushEventDelivery!();
    for (let index = 0; index < 300; index++) {
      started(`thread-child-${index}`, "thread-root", 1);
      await vi.waitFor(async () => { expect(await port.history!.get("lineage", `thread-child-${index}`)).not.toBeNull(); }, { interval: 1, timeout: 5_000 });
      await session.flushEventDelivery!();
      expect(failure).toBeUndefined();
      expect(lastThread).toBe(`thread-child-${index}`);
      transport.queue.push({ method: "thread/closed", params: { threadId: `thread-child-${index}` } });
    }
    await session.flushEventDelivery!();
    expect(session.lineage!().length).toBeLessThanOrEqual(128);
    expect(session.lineage!().some(thread => thread.threadId === "thread-child-0")).toBe(false);
    started("thread-grandchild", "thread-child-0", 2);
    await vi.waitFor(async () => { expect(await port.history!.get("lineage", "thread-grandchild")).not.toBeNull(); }, { interval: 1, timeout: 5_000 });
    await session.flushEventDelivery!();
    expect(await port.history!.get("lineage", "thread-grandchild")).toMatchObject({ threadId: "thread-grandchild", parentThreadId: "thread-child-0", depth: 2 });
    expect(Buffer.byteLength(JSON.stringify((await store.load())!.state))).toBeLessThan(100_000);
    expect(port.load()!.pending).toEqual([]);
  } finally { await session.close({ reason: "test complete" }); transport.queue.close(); await core.stop(); await store.close(); await rm(root, { recursive: true, force: true }); }
}, 120_000);
