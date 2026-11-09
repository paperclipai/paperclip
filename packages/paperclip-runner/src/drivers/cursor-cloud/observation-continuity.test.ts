import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { CursorCloudClient, type CursorCloudRunStatus } from "./cloud-client.js";
import { CursorCloudDriver, type CursorCloudSessionHandle } from "./cursor-cloud-driver.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}

const fixtures: Array<{ root: string; session: CursorCloudSessionHandle; pump: Promise<void>; release(): void }> = [];
let forbiddenFetches = 0;
beforeEach(() => {
  forbiddenFetches = 0;
  vi.stubGlobal("fetch", async () => { forbiddenFetches++; throw new Error("External fetch is forbidden in the observation fixture"); });
});
afterEach(async () => {
  try {
    for (const fixture of fixtures.splice(0)) {
      fixture.release();
      try { await fixture.session.close({ reason: "observation_fixture_cleanup" }); await fixture.pump; }
      finally { await rm(fixture.root, { recursive: true, force: true }); }
    }
    expect(forbiddenFetches).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});

async function fixture(options: { timeoutMs?: number; reconnectDelayMs?: number; holdFourthRead?: boolean; finishOnFourthRead?: boolean; streamStatus?: number } = {}) {
  const root = await mkdtemp("/tmp/cc-observe-");
  const socketPath = join(root, "mcp.sock");
  const fourthRead = deferred(), releaseFourthRead = deferred();
  const counts = { creates: 0, followups: 0, cancels: 0, streams: 0, reads: 0 };
  const observations: Array<{ status: CursorCloudRunStatus; deadlineAt: number | null; at: number }> = [];
  const events: PrpEvent[] = [];
  const nativeRunId = "run-11111111-1111-4111-8111-111111111111";
  const timestamp = "2026-10-29T00:00:00Z";
  let agentId = "", nativeStatus: CursorCloudRunStatus = "RUNNING";
  const checkpoint = async () => {
    const name = (await readdir(root)).find(value => /^checkpoint-[a-f0-9]{64}\.json$/.test(value))!;
    return JSON.parse(await readFile(join(root, name), "utf8"));
  };
  const run = (status = nativeStatus) => ({ id: nativeRunId, agentId, status, createdAt: timestamp, updatedAt: timestamp,
    ...(status === "FINISHED" ? { result: "Exact final answer after disconnected observation." } : {}) });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const nativeFetch: typeof globalThis.fetch = async (url, init) => {
    const target = new URL(String(url)), method = init?.method ?? "GET";
    expect(target.origin).toBe("https://controlled.cursor.test");
    if (target.pathname === "/v1/agents" && method === "POST") {
      counts.creates++; agentId = JSON.parse(String(init?.body)).agentId;
      return json({ agent: { id: agentId, status: "ACTIVE", env: { type: "cloud" }, url: "https://cursor.com/agents/fixture", createdAt: timestamp, updatedAt: timestamp, latestRunId: nativeRunId }, run: run() });
    }
    if (target.pathname === `/v1/agents/${agentId}/runs` && method === "POST") { counts.followups++; throw new Error("Unexpected replacement work"); }
    if (target.pathname === `/v1/agents/${agentId}/runs/${nativeRunId}/cancel` && method === "POST") {
      counts.cancels++; nativeStatus = "CANCELLED"; return json({ id: nativeRunId });
    }
    if (target.pathname === `/v1/agents/${agentId}/runs/${nativeRunId}/stream` && method === "GET") {
      counts.streams++;
      if (options.streamStatus) return json({ message: "Controlled stream failure" }, options.streamStatus);
      return new Response(`id: opaque-${counts.streams}\nevent: assistant\ndata: {"text":"Working before disconnect."}\n\n`, { headers: { "content-type": "text/event-stream" } });
    }
    if (target.pathname === `/v1/agents/${agentId}/runs/${nativeRunId}` && method === "GET") {
      counts.reads++;
      if (options.finishOnFourthRead && counts.reads === 4) nativeStatus = "FINISHED";
      const observed = run();
      observations.push({ status: observed.status, deadlineAt: (await checkpoint()).deadlineAt, at: Date.now() });
      if (counts.reads === 4) {
        fourthRead.resolve();
        if (options.holdFourthRead) await releaseFourthRead.promise;
      }
      return json(observed);
    }
    throw new Error(`Unexpected synthetic API request ${method} ${target.pathname}`);
  };
  const driver = new CursorCloudDriver({ model: "explicit-model", config: { schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/example/repo" }], timeoutMs: options.timeoutMs ?? 10_000 },
    binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId: "session" }, runtimeDirectory: root,
    relay: { url: "https://relay.example.test/mcp", token: "synthetic-relay-token", socketPath, expiresAt: Date.now() + 60_000 }, instructions: "Perform only this controlled observation fixture.",
    dynamicToolHandler: async () => { throw new Error("No semantic tool is called by this fixture"); },
    client: new CursorCloudClient({ apiKey: "synthetic-key", baseUrl: "https://controlled.cursor.test", fetch: nativeFetch }), reconnectDelayMs: options.reconnectDelayMs ?? 1, cancelTimeoutMs: 200 });
  const session = await driver.openSession({ runId: "paperclip-run", normalizedSessionId: "session", workingDirectory: root });
  const pump = (async () => { for await (const event of session.events()) events.push(event); })();
  fixtures.push({ root, session, pump, release: releaseFourthRead.resolve });
  const socket = await lstat(socketPath); expect(socket.isSocket()).toBe(true); expect(socket.mode & 0o077).toBe(0);
  const started = await session.startTurn({ message: { role: "user", text: "Complete after disconnected observation." } });
  const originalDeadline = (await checkpoint()).deadlineAt as number;
  return { root, socketPath, session, events, counts, observations, checkpoint, originalDeadline, turnId: started.turnId,
    fourthRead: fourthRead.promise, releaseFourthRead: releaseFourthRead.resolve, finish: () => { nativeStatus = "FINISHED"; } };
}

const terminals = (events: PrpEvent[]) => events.filter(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.eventType));

it("continues observation beyond four active disconnects and delivers the exact terminal once", async () => {
  const f = await fixture({ holdFourthRead: true });
  await vi.waitFor(() => expect(f.counts.reads).toBe(4), { timeout: 1_000 });
  await f.fourthRead;
  expect(f.observations.map(value => value.status)).toEqual(["RUNNING", "RUNNING", "RUNNING", "RUNNING"]);
  f.finish(); f.releaseFourthRead();
  await vi.waitFor(() => expect(terminals(f.events)).toHaveLength(1), { timeout: 1_000 });
  expect(f.counts).toEqual({ creates: 1, followups: 0, cancels: 0, streams: 5, reads: 5 });
  expect(f.observations.every(value => value.deadlineAt === f.originalDeadline)).toBe(true);
  expect(Date.now()).toBeLessThan(f.originalDeadline);
  const terminal = terminals(f.events)[0]; expect(terminal.eventType).toBe("turn.completed"); expect(terminal.turnId).toBe(f.turnId);
  expect(terminal.payload.cursorCloudTerminalDelivery).toMatchObject({ status: "FINISHED", result: "Exact final answer after disconnected observation." });
  expect(f.events.filter(event => event.eventType === "item.completed" && event.payload.channel === "final")).toHaveLength(1);
  expect((await f.checkpoint()).pendingTerminalDelivery).toEqual(terminal.payload.cursorCloudTerminalDelivery);
  const settled = { ...f.counts }; await delay(30); expect(f.counts).toEqual(settled);
});

it("still settles when the fourth disconnected stream's status read is already terminal", async () => {
  const f = await fixture({ finishOnFourthRead: true });
  await vi.waitFor(() => expect(terminals(f.events)).toHaveLength(1), { timeout: 1_000 });
  expect(f.counts).toEqual({ creates: 1, followups: 0, cancels: 0, streams: 4, reads: 4 });
  expect((await f.checkpoint()).pendingTerminalDelivery.status).toBe("FINISHED");
});

it("keeps repeated disconnects within the original deadline and cancels only the saved run", async () => {
  const f = await fixture({ timeoutMs: 1_000, reconnectDelayMs: 20 });
  await vi.waitFor(() => expect(terminals(f.events)).toHaveLength(1), { timeout: 2_500 });
  expect(terminals(f.events)[0].eventType).toBe("turn.interrupted");
  expect(f.counts.streams).toBeGreaterThan(4); expect(f.counts.streams).toBeLessThan(100);
  expect(f.counts.creates).toBe(1); expect(f.counts.followups).toBe(0); expect(f.counts.cancels).toBe(1);
  expect(f.observations.every(value => value.deadlineAt === f.originalDeadline)).toBe(true);
  expect(Date.now()).toBeGreaterThanOrEqual(f.originalDeadline);
  const settled = { ...f.counts }; await delay(40); expect(f.counts).toEqual(settled);
});

it.each(["Stop", "close"] as const)("%s aborts observation backoff without a replacement or deadline extension", async operation => {
  const f = await fixture({ reconnectDelayMs: 60_000 });
  await vi.waitFor(() => expect(f.counts.reads).toBe(1), { timeout: 1_000 });
  await delay(20);
  expect((await f.checkpoint()).deadlineAt).toBe(f.originalDeadline);
  const before = Date.now();
  if (operation === "Stop") await f.session.interrupt!({ turnId: f.turnId });
  else await f.session.close({ reason: "controlled_close_during_backoff" });
  expect(Date.now() - before).toBeLessThan(1_000);
  expect(terminals(f.events)).toHaveLength(1);
  expect(f.counts.creates).toBe(1); expect(f.counts.followups).toBe(0); expect(f.counts.cancels).toBe(1); expect(f.counts.streams).toBe(1);
  const settled = { ...f.counts }; await delay(40); expect(f.counts).toEqual(settled);
  expect((await f.checkpoint()).deadlineAt).toBeNull();
  if (operation === "close") expect((await readdir(f.root)).includes("mcp.sock")).toBe(false);
});

it("keeps non-transient stream authorization failures fenced without repeated requests", async () => {
  const f = await fixture({ streamStatus: 401 });
  await vi.waitFor(() => expect(f.events.some(event => event.eventType === "harness.diagnostic" && event.payload.code === "cursor_cloud_remote_state_unknown")).toBe(true), { timeout: 1_000 });
  expect(f.counts).toEqual({ creates: 1, followups: 0, cancels: 0, streams: 1, reads: 0 });
  expect(terminals(f.events)).toHaveLength(0);
});
