import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { startStorageFaultProxy } from "./storage-proxy.js";
import { exposedAfterLaunch, redactStorageUrl, storageTriggerMarkdown, storageTriggerMatches, storageTriggerShortfall, StorageTrigger, type StorageTriggerReceipt, type ArmedStorageFault, type StorageTriggerHooks } from "./storage-trigger.js";
import type { FaultReceipt } from "./types.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });

async function upstream() {
  const seen: string[] = [];
  const server: Server = createServer((incoming, outgoing) => {
    incoming.resume();
    incoming.on("end", () => { seen.push(`${incoming.method} ${incoming.url}`); outgoing.writeHead(200).end("ok"); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  closers.push(async () => { server.closeAllConnections(); server.close(); });
  return { endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

function hooks(overrides: Partial<StorageTriggerHooks> = {}) {
  const fired: Array<{ armed: ArmedStorageFault; path: string }> = [];
  const events: string[] = [];
  const value: StorageTriggerHooks = {
    canFire: () => true, isOpen: () => true,
    fire: async (armed, held) => { fired.push({ armed, path: held.path }); },
    record: kind => { events.push(kind); },
    ...overrides,
  };
  return { value, fired, events };
}

function send(endpoint: string, method: string, route: string, body = "bytes") {
  const outgoing = request(`${endpoint}${route}`, { method, headers: { "content-length": Buffer.byteLength(body) } });
  outgoing.on("error", () => undefined);
  const response = new Promise<number>(resolve => outgoing.on("response", incoming => { incoming.resume(); resolve(incoming.statusCode ?? 0); }));
  outgoing.end(body);
  return { outgoing, response };
}

const until = async (check: () => boolean) => { for (let index = 0; index < 200 && !check(); index += 1) await new Promise(resolve => setTimeout(resolve, 10)); };
const snapshotPut = "/bucket/chaos/w/c1/workspace-snapshots/ws1/s1/u1.pcws";

describe("storage trigger targets", () => {
  it("matches snapshot uploads, parts, downloads and run-log writes only", () => {
    expect(storageTriggerMatches("snapshot-upload", "PUT", snapshotPut, 4096)).toBe(true);
    expect(storageTriggerMatches("snapshot-upload", "PUT", `${snapshotPut}?partNumber=1&uploadId=u`, 4096)).toBe(true);
    expect(storageTriggerMatches("snapshot-upload", "PUT", snapshotPut, 0)).toBe(false);
    expect(storageTriggerMatches("snapshot-upload", "POST", `${snapshotPut}?uploads`, 0)).toBe(false);
    expect(storageTriggerMatches("snapshot-upload", "POST", `${snapshotPut}?uploadId=u`, 120)).toBe(false);
    expect(storageTriggerMatches("snapshot-upload", "GET", snapshotPut)).toBe(false);
    expect(storageTriggerMatches("snapshot-part", "PUT", `${snapshotPut}?partNumber=2&uploadId=abc`)).toBe(true);
    expect(storageTriggerMatches("snapshot-part", "PUT", snapshotPut)).toBe(false);
    expect(storageTriggerMatches("snapshot-download", "GET", snapshotPut)).toBe(true);
    expect(storageTriggerMatches("snapshot-download", "HEAD", snapshotPut)).toBe(false);
    expect(storageTriggerMatches("run-log", "PUT", "/bucket/chaos/w/run-logs/c1/r1/000001.ndjson")).toBe(true);
    expect(storageTriggerMatches("run-log", "GET", "/bucket/chaos/w/run-logs/c1/r1/000001.ndjson")).toBe(false);
    expect(storageTriggerMatches("run-log", "PUT", snapshotPut)).toBe(false);
  });

  it("keeps part numbers but hides upload ids and signatures in receipts", () => {
    expect(redactStorageUrl(`${snapshotPut}?partNumber=2&uploadId=abc&X-Amz-Signature=s`)).toBe(`${snapshotPut}?partNumber=2&uploadId=…`);
    expect(redactStorageUrl(`${snapshotPut}?uploads`)).toBe(`${snapshotPut}?uploads`);
    expect(redactStorageUrl(`${snapshotPut}?x-id=PutObject`)).toBe(`${snapshotPut}?x-id=PutObject`);
  });

  it("parses --storage-trigger only with s3 storage and time triggers", () => {
    const base = ["--env", "local", "--adapters", "codex", "--workloads", "A1", "--faults", "K1"];
    const parsed = parseCommand([...base, "--storage", "s3", "--storage-trigger", "run-log"]);
    expect(parsed.mode === "wave" && parsed.options.storageTrigger).toBe("run-log");
    expect(() => parseCommand([...base, "--storage-trigger", "run-log"])).toThrow(/needs --storage s3/);
    expect(() => parseCommand([...base, "--storage", "s3", "--storage-trigger", "everything"])).toThrow(/takes one of/);
    expect(() => parseCommand([...base, "--workloads", "C1", "--triggers", "comment", "--storage", "s3", "--storage-trigger", "run-log"])).toThrow(/--triggers time/);
    expect(() => parseCommand([...base, "--workloads", "A1,G1", "--storage", "s3", "--storage-trigger", "run-log"])).toThrow(/board-acting workloads \(G1\)/);
    expect(() => parseCommand([...base, "--workloads", "C1", "--matrix", "--storage", "s3", "--storage-trigger", "run-log"])).toThrow(/--matrix/);
  });
});

describe("storage-triggered restart", () => {
  it("fires an armed fault on the matching request, holds it open and records what was in flight", async () => {
    const store = await upstream();
    const proxy = await startStorageFaultProxy(store.endpoint);
    closers.push(() => proxy.close());
    const { value, fired, events } = hooks();
    const trigger = new StorageTrigger("snapshot-upload", value, 5_000);
    proxy.observe(trigger.listener);

    const before = send(proxy.endpoint, "PUT", snapshotPut);
    expect(await before.response).toBe(200);
    expect(fired).toEqual([]);

    trigger.arm({ taskId: "t01", kind: "K1", holdMs: 0, armedAt: Date.now(), restartSteps: [{ gapMs: 5_000, signal: "SIGKILL" }] });
    const other = send(proxy.endpoint, "PUT", "/bucket/chaos/w/run-logs/r1/1.ndjson");
    expect(await other.response).toBe(200);
    const held = send(proxy.endpoint, "PUT", `${snapshotPut}?partNumber=1&uploadId=u`, "x".repeat(1024));
    await until(() => fired.length > 0);
    expect(fired).toEqual([{ armed: expect.objectContaining({ taskId: "t01", kind: "K1", restartSteps: [{ gapMs: 5_000, signal: "SIGKILL" }] }), path: `${snapshotPut}?partNumber=1&uploadId=…` }]);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(store.seen.filter(line => line.includes("partNumber"))).toEqual([]);

    held.outgoing.destroy();
    await until(() => trigger.receipts[0]?.request?.outcome !== "in_flight");
    const faults = [{ faultId: "f01", requestedBy: "t01", requestedAt: Date.now() } as FaultReceipt];
    const [receipt] = trigger.finish(faults);
    expect(receipt).toMatchObject({ target: "snapshot-upload", taskId: "t01", faultId: "f01", missedAt: null,
      request: { method: "PUT", held: true, declaredBytes: 1024, outcome: "aborted", status: null } });
    expect(receipt!.inFlight.map(entry => entry.method)).toEqual(["PUT"]);
    expect(events).toEqual(["storage_trigger_armed", "storage_trigger_fired"]);
    expect(proxy.counts().byMethod.PUT).toBe(2);
  });

  it("skips a match while a fault cannot fire and records armed faults that never matched", async () => {
    const store = await upstream();
    const proxy = await startStorageFaultProxy(store.endpoint);
    closers.push(() => proxy.close());
    let ready = false;
    const { value, fired } = hooks({ canFire: () => ready, isOpen: taskId => taskId !== "t02" });
    const trigger = new StorageTrigger("snapshot-download", value, 5_000);
    proxy.observe(trigger.listener);
    trigger.arm({ taskId: "t02", kind: "K2", holdMs: 0, armedAt: 1 });
    trigger.arm({ taskId: "t03", kind: "K4", holdMs: 30_000, armedAt: 2 });
    trigger.arm({ taskId: "t04", kind: "K1", holdMs: 0, armedAt: 3 });

    expect(await send(proxy.endpoint, "GET", snapshotPut, "").response).toBe(200);
    expect(fired).toEqual([]);
    ready = true;
    const held = send(proxy.endpoint, "GET", snapshotPut, "");
    await until(() => fired.length > 0);
    expect(fired.map(entry => entry.armed.taskId)).toEqual(["t03"]);
    held.outgoing.destroy();

    trigger.arm({ taskId: "t02", kind: "K1", holdMs: 0, armedAt: 4 });
    const receipts = trigger.finish([]);
    expect(receipts.map(receipt => [receipt.taskId, receipt.missedReason ?? null, receipt.firedAt !== null])).toEqual([
      ["t02", "task_rested", false], ["t03", null, true], ["t04", "no_matching_request", false], ["t02", "task_rested", false]]);
  });

  it("forwards a held request after the hold when the restart never came", async () => {
    const store = await upstream();
    const proxy = await startStorageFaultProxy(store.endpoint);
    closers.push(() => proxy.close());
    const { value } = hooks();
    const trigger = new StorageTrigger("run-log", value, 50);
    proxy.observe(trigger.listener);
    trigger.arm({ taskId: "t01", kind: "K1", holdMs: 0, armedAt: 1 });
    expect(await send(proxy.endpoint, "PUT", "/bucket/chaos/w/run-logs/r1/1.ndjson").response).toBe(200);
    await until(() => trigger.receipts[0]?.request?.outcome === "completed");
    expect(trigger.receipts[0]!.request).toMatchObject({ held: true, outcome: "completed", status: 200 });
  });
});

describe("storage trigger receipts", () => {
  const receipt = (taskId: string, firedAt: number | null, outcome: "aborted" | "completed" = "aborted", faultId?: string): StorageTriggerReceipt => ({
    target: "snapshot-upload", taskId, kind: "K1", armedAt: 0, firedAt, missedAt: firedAt === null ? 1 : null, inFlight: [],
    request: firedAt === null ? null : { id: 1, method: "PUT", path: snapshotPut, startedAt: firedAt, declaredBytes: 1, held: true, outcome, status: null, settledAt: firedAt + 1 },
    ...(faultId ? { faultId } : {}) });

  it("links each fired receipt to the first fault its task requested at or after the fire", () => {
    const trigger = new StorageTrigger("snapshot-upload", hooks().value);
    trigger.receipts.push(receipt("t01", 100), receipt("t01", 500), receipt("t02", 300));
    const faults = [{ faultId: "f03", requestedBy: "t01", requestedAt: 520 }, { faultId: "f01", requestedBy: "t01", requestedAt: 110 },
      { faultId: "f00", requestedBy: "t01", requestedAt: 50 }, { faultId: "f02", requestedBy: "t02", requestedAt: 305 }] as FaultReceipt[];
    expect(trigger.finish(faults).map(entry => entry.faultId)).toEqual(["f01", "f03", "f02"]);
  });

  it("fails a wave whose restarts did not provably interrupt a held transfer", () => {
    expect(storageTriggerShortfall([receipt("t01", 10, "aborted", "f01"), receipt("t02", null)])).toBeNull();
    expect(storageTriggerShortfall([receipt("t01", null), receipt("t02", null)])).toMatch(/no restart interrupted a matching transfer \(2 armed, none fired\)/);
    expect(storageTriggerShortfall([])).toMatch(/0 armed/);
    expect(storageTriggerShortfall([receipt("t01", 10, "completed", "f01")])).toMatch(/t01 fault=f01 outcome=completed/);
    expect(storageTriggerShortfall([receipt("t01", 10, "aborted")])).toMatch(/t01 fault=none outcome=aborted/);
  });

  it("summarises interrupted and unreached faults for the wave summary", () => {
    const text = storageTriggerMarkdown([receipt("t01", 10, "aborted", "f01"), { ...receipt("t02", null), missedReason: "task_rested" }]);
    expect(text).toContain("1 of 2 armed faults interrupted a transfer; 1 not reached.");
    expect(text).toContain("| t01 | K1 | f01 | aborted | `PUT ws1/s1/u1.pcws` |");
    expect(text).toContain("| t02 | K1 | - | not reached (task_rested) | - |");
  });
});

describe("storage-triggered restart exposure", () => {
  it("waits for a launch in flight and exposes the task it launched", async () => {
    const launched = [{ id: "t01", done: false }, { id: "t02", done: true }];
    let finish!: () => void;
    const launching = new Promise<void>(resolve => { finish = resolve; });
    launched.push({ id: "t03", done: false });
    const exposed = exposedAfterLaunch(launching, launched);
    let settled = false;
    void exposed.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    launched.push({ id: "t04", done: false });
    finish();
    expect((await exposed).map(task => task.id)).toEqual(["t01", "t03", "t04"]);
    expect((await exposedAfterLaunch(null, launched)).map(task => task.id)).toEqual(["t01", "t03", "t04"]);
  });
});
