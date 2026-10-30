import { afterEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { join } from "node:path";
import type { HarnessSession } from "../../contracts/harness-driver.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import type { CursorCloudArtifact, CursorCloudCreateInput, CursorCloudFollowupInput, CursorCloudRun, CursorCloudSseEvent } from "./cloud-client.js";
import { CursorCloudClient, CursorCloudClientError } from "./cloud-client.js";
import { CursorCloudCheckpointStore, cursorCloudDigest } from "./checkpoint.js";
import { reserveCursorCloudArtifactStaging } from "./artifact-staging-budget.js";
import { semanticCanonicalJson } from "../semantic-tool-receipt.js";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../runner-tool-bridge.js";
import { CursorCloudDriver, cursorCloudDriverDescriptor, type CursorCloudDriverOptions, type CursorCloudSessionHandle } from "./cursor-cloud-driver.js";

const roots: string[] = [];
const sessions: HarnessSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close({ reason: "test_cleanup" }).catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const runId = "run-11111111-1111-4111-8111-111111111111";
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

class Peer {
  request: CursorCloudCreateInput | CursorCloudFollowupInput | null = null;
  native: CursorCloudRun | null = null;
  created = deferred();
  release = deferred();
  failCreate = false;
  replay = false;
  cursor: string | undefined;
  createAgent = vi.fn(async (input: CursorCloudCreateInput) => {
    this.request = input;
    this.native = { id: runId, agentId: input.agentId!, status: "RUNNING", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" };
    this.created.resolve();
    if (this.failCreate) throw new Error("lost response");
    return { agent: { id: input.agentId!, status: "ACTIVE" as const, env: { type: "cloud" as const }, url: "https://cursor.com/agents/example", createdAt: this.native.createdAt, updatedAt: this.native.updatedAt, latestRunId: runId }, run: { ...this.native } };
  });
  createRun = vi.fn(async (_id: string, input: CursorCloudFollowupInput) => {
    this.request = input; this.release = deferred(); this.native!.status = "RUNNING";
    return { run: { ...this.native! } };
  });
  getAgent = vi.fn(async (id: string) => ({ id, status: "ACTIVE" as const, env: { type: "cloud" as const }, url: "https://cursor.com/agents/example", createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z", latestRunId: runId }));
  getRun = vi.fn(async () => ({ ...this.native! }));
  cancelRun = vi.fn(async () => { this.native!.status = "CANCELLED"; this.release.resolve(); return { id: runId }; });
  getUsage = vi.fn(async () => ({ totalUsage: { inputTokens: 3, outputTokens: 2, cacheWriteTokens: 0, cacheReadTokens: 0, totalTokens: 5 }, runs: [] }));
  listArtifacts = vi.fn(async (): Promise<{ items: CursorCloudArtifact[] }> => ({ items: [] }));
  downloadArtifact = vi.fn(async () => Buffer.alloc(0));
  async *streamRun(_agent: string, _run: string, options: { signal?: AbortSignal; lastEventId?: string } = {}): AsyncGenerator<CursorCloudSseEvent> {
    this.cursor = options.lastEventId;
    if (!this.replay) { yield { id: "opaque-1", event: "assistant", data: { text: "Working." } }; this.replay = true; }
    else yield { id: "opaque-1", event: "assistant", data: { text: "Working." } };
    await Promise.race([this.release.promise, new Promise<void>(accept => options.signal?.addEventListener("abort", () => accept(), { once: true }))]);
    if (options.signal?.aborted) return;
    yield { id: "opaque-2", event: "result", data: { runId, status: this.native!.status } };
  }
}

async function fixture(peer = new Peer(), extra: Partial<CursorCloudDriverOptions> = {}) {
  const root = await mkdtemp("/tmp/cc-"); roots.push(root);
  const handler = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText", text: "accepted" }] }));
  const options: CursorCloudDriverOptions = { model: "explicit-model", config: { schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/example/repo", startingRef: "main" }] },
    binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId: "session" }, runtimeDirectory: root,
    relay: { url: "https://relay.example.test/mcp", token: "private-relay-token", socketPath: join(root, "mcp.sock"), expiresAt: Date.now() + 600_000 }, instructions: "Follow these exact instructions.",
    dynamicTools: [{ name: "write_note", inputSchema: { type: "object", required: ["note"], properties: { note: { type: "string" } }, additionalProperties: false } }], dynamicToolHandler: handler,
    environment: { CURSOR_API_KEY: "private-cursor-key" }, client: peer, reconnectDelayMs: 1, cancelTimeoutMs: 300, ...extra };
  const driver = new CursorCloudDriver(options);
  const session = await driver.openSession({ runId: "paperclip-run", normalizedSessionId: "session", workingDirectory: root }); sessions.push(session);
  const events: PrpEvent[] = [];
  const pump = (async () => { for await (const event of session.events()) events.push(event); })();
  return { root, peer, handler, options, driver, session, events, pump };
}

async function waitFor(check: () => boolean) { await vi.waitFor(() => expect(check()).toBe(true), { timeout: 2_000, interval: 5 }); }

async function acknowledgeTerminal(session: CursorCloudSessionHandle) {
  const pending = (await session.read?.())?.pendingTerminalDelivery as { turnId: string; receiptId: string };
  await session.acknowledgeTerminalDelivery(pending);
}

function distinctFollowup(peer: Peer) {
  peer.createRun.mockImplementation(async (_id, input) => {
    peer.request = input; peer.native = { ...peer.native!, id: "run-22222222-2222-4222-8222-222222222222", status: "RUNNING" };
    return { run: { ...peer.native } };
  });
}

async function savedCheckpoint(root: string, session: CursorCloudSessionHandle) {
  await session.snapshot();
  return JSON.parse(await readFile(join(root, (await readdir(root)).find(name => /^checkpoint-.*\.json$/.test(name))!), "utf8"));
}

async function nextAuthority(f: Awaited<ReturnType<typeof fixture>>) {
  await acknowledgeTerminal(f.session);
  await f.session.attachRun!({ runId: "paperclip-followup" });
  const next = await f.session.startTurn({ message: { role: "user", text: "Next task" } });
  await waitFor(() => f.events.some(event => event.turnId === next.turnId && event.eventType === "item.delta"));
  return { next, checkpoint: await savedCheckpoint(f.root, f.session), eventCount: f.events.length };
}

function relayHeaders(peer: Peer): Record<string, string> { return structuredClone(peer.request!.mcpServers[0]!.headers!); }

async function rpc(path: string, body: unknown, token: string | Record<string, string> = "private-relay-token", session?: string): Promise<{ status: number; value: any; session?: string }> {
  return new Promise((accept, reject) => {
    const req = request({ socketPath: path, path: "/mcp", method: "POST", headers: { ...(typeof token === "string" ? { Authorization: `Bearer ${token}` } : token), "content-type": "application/json", ...(session ? { "Mcp-Session-Id": session } : {}) } }, response => {
      let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
      response.on("end", () => accept({ status: response.statusCode!, value: text ? JSON.parse(text) : null, session: response.headers["mcp-session-id"] as string | undefined }));
    });
    req.on("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", ...body as object }));
  });
}

describe("Cursor Cloud native driver", () => {
  it.each(["rejected", "ambiguous"])("retains bounded staging custody after %s controller registration across restart", async mode => {
    const runtimeDirectory = await mkdtemp("/tmp/cc-artifact-controller-"); roots.push(runtimeDirectory);
    const artifactRoot = join(runtimeDirectory, "artifacts"), signal = new AbortController().signal;
    for (let count = 0; count < 255; count++) await reserveCursorCloudArtifactStaging({ runtimeDirectory, artifactRoot, byteSize: 0, signal });
    const peer = new Peer(), bytes = Buffer.from("verified controller-rejected file");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    peer.listArtifacts.mockImplementation(async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: bytes.length, updatedAt: "2026-10-28T00:00:00Z" }] }));
    peer.downloadArtifact.mockResolvedValue(bytes);
    const handler = vi.fn(async () => {
      if (mode === "ambiguous") throw new Error("fixture controller registration unavailable");
      return { success: false, error: "fixture controller registration rejected" };
    });
    const f = await fixture(peer, { runtimeDirectory, artifactRoot, dynamicTools: [{ name: "register_deliverable", inputSchema: { type: "object" } }], dynamicToolHandler: handler });
    await f.session.startTurn({ message: { role: "user", text: "Register the verified result" } }); await peer.created.promise;
    const input = { contentRef: "cursor-artifact:artifacts/result.txt", filename: "result.txt", byteSize: bytes.length, sha256 };
    const initialized = await rpc(f.options.relay.socketPath, { id: 0, method: "initialize" }, relayHeaders(peer));
    const first = await rpc(f.options.relay.socketPath, { id: 1, method: "tools/call", params: { name: "register_deliverable", arguments: input } }, relayHeaders(peer), initialized.session);
    expect(JSON.stringify(first.value)).toContain("fixture controller registration");
    expect(handler).toHaveBeenCalledOnce();
    expect(await readFile(join(artifactRoot, sha256, input.filename))).toEqual(bytes);
    const budgetPath = join(runtimeDirectory, ".artifact-staging-budget", "usage.json");
    const budget = await readFile(budgetPath, "utf8"); expect(JSON.parse(budget)).toMatchObject({ allocations: 256, reservedBytes: bytes.length });
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    const reinitialized = await rpc(f.options.relay.socketPath, { id: 2, method: "initialize" }, relayHeaders(peer));
    const denied = await rpc(f.options.relay.socketPath, { id: 3, method: "tools/call", params: { name: "register_deliverable", arguments: { ...input, filename: "over-budget.txt" } } }, relayHeaders(peer), reinitialized.session);
    expect(JSON.stringify(denied.value)).toContain("staging budget");
    expect(handler).toHaveBeenCalledOnce(); expect(peer.downloadArtifact).toHaveBeenCalledOnce();
    expect(await readFile(budgetPath, "utf8")).toBe(budget);
    await expect(lstat(join(artifactRoot, sha256, "over-budget.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 20_000);

  it.each([503, 429])("retries a transient observation HTTP %i without replacing work or extending its deadline", async status => {
    let agentId = "", creates = 0, reads = 0, streams = 0;
    const deadlines: Array<number | null> = [];
    const now = "2026-10-28T00:00:00Z";
    let checkpoint!: () => Promise<number | null>;
    const json = (value: unknown, code = 200) => new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });
    const nativeFetch: typeof globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://controlled.cursor.test");
      const run = { id: runId, agentId, status: "FINISHED", createdAt: now, updatedAt: now };
      if (target.pathname === "/v1/agents" && init?.method === "POST") {
        creates++; agentId = JSON.parse(String(init.body)).agentId;
        return json({ agent: { id: agentId, status: "ACTIVE", env: { type: "cloud" }, url: `https://cursor.com/agents/${agentId}`, createdAt: now, updatedAt: now, latestRunId: runId }, run: { ...run, agentId, status: "RUNNING" } });
      }
      if (target.pathname.endsWith("/stream")) {
        streams++;
        return new Response('id: opaque-observation\nevent: assistant\ndata: {"text":"Working."}\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      if (target.pathname === `/v1/agents/${agentId}/runs/${runId}`) {
        deadlines.push(await checkpoint());
        return ++reads === 1 ? json({ message: "temporary read failure" }, status) : json(run);
      }
      throw new Error("Unexpected controlled provider request");
    };
    const f = await fixture(new Peer(), { client: new CursorCloudClient({ apiKey: "synthetic-key", baseUrl: "https://controlled.cursor.test", fetch: nativeFetch }) });
    checkpoint = async () => (await savedCheckpoint(f.root, f.session)).deadlineAt;
    await f.session.startTurn({ message: { role: "user", text: "Complete despite a temporary observation failure" } });
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    expect(creates).toBe(1); expect(reads).toBe(2); expect(streams).toBe(1);
    expect(deadlines[0]).toBeGreaterThan(Date.now()); expect(deadlines[1]).toBe(deadlines[0]);
    expect(f.events.filter(event => event.eventType === "turn.completed")).toHaveLength(1);
    expect(f.events.filter(event => event.eventType === "item.delta")).toHaveLength(1);
    expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
  });

  it("aborts the pending observation read when Stop settles the same native run", async () => {
    const peer = new Peer(), reading = deferred();
    const blocked = deferred<CursorCloudRun>();
    let readAborted = false;
    peer.streamRun = async function* () {};
    const original = peer.getRun.getMockImplementation()!;
    peer.getRun.mockImplementationOnce((...args: unknown[]) => {
      const signal = (args[2] as { signal?: AbortSignal } | undefined)?.signal;
      signal?.addEventListener("abort", () => { readAborted = true; }, { once: true });
      reading.resolve(); return blocked.promise;
    });
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Stop an observation in flight" } });
    await reading.promise;
    try {
      await f.session.interrupt!();
      await vi.waitFor(() => expect(readAborted).toBe(true), { timeout: 100 });
      expect((await f.session.read()).phase).toBe("terminal");
    } finally { blocked.resolve(await original()); }
  });

  it("bounds repeated transient observation reads by the original deadline", async () => {
    const peer = new Peer(); peer.streamRun = async function* () {};
    peer.getRun.mockRejectedValue(new CursorCloudClientError("http_error", { status: 503 }));
    const f = await fixture(peer, { config: { schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/example/repo" }], timeoutMs: 1_000 }, cancelTimeoutMs: 25 });
    await f.session.startTurn({ message: { role: "user", text: "Keep the original observation deadline" } });
    await peer.created.promise;
    const deadlineAt = (await savedCheckpoint(f.root, f.session)).deadlineAt;
    try {
      await waitFor(() => peer.getRun.mock.calls.length >= 5);
      expect((await savedCheckpoint(f.root, f.session)).deadlineAt).toBe(deadlineAt);
      await waitFor(() => Date.now() >= deadlineAt);
      await vi.waitFor(async () => expect((await f.session.read()).phase).toBe("stopping"));
      const observerSignal = (peer.getRun.mock.calls[0] as unknown[])[2] as { signal: AbortSignal };
      const observationReads = () => peer.getRun.mock.calls.filter(call => ((call as unknown[])[2] as { signal?: AbortSignal } | undefined)?.signal === observerSignal.signal).length;
      await vi.waitFor(() => expect(observerSignal.signal.aborted).toBe(true));
      const reads = observationReads();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(observationReads()).toBe(reads);
      expect(peer.createAgent).toHaveBeenCalledTimes(1); expect(peer.createRun).not.toHaveBeenCalled();
      expect(f.events.some(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.eventType))).toBe(false);
    } finally { peer.getRun.mockImplementation(async () => ({ ...peer.native! })); }
  });

  it.each(["http_error", "invalid_response"] as const)("does not retry a non-transient observation %s", async code => {
    const peer = new Peer(); peer.streamRun = async function* () {};
    const original = peer.getRun.getMockImplementation()!;
    peer.getRun.mockRejectedValue(new CursorCloudClientError(code, code === "http_error" ? { status: 401 } : {}));
    const f = await fixture(peer);
    try {
      await f.session.startTurn({ message: { role: "user", text: "Keep unauthorized or invalid observations fenced" } });
      await waitFor(() => f.events.some(event => (event.payload as { code?: string }).code === "cursor_cloud_remote_state_unknown"));
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(peer.getRun).toHaveBeenCalledTimes(1);
      expect((await f.session.read()).phase).toBe("running");
      expect(f.events.some(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.eventType))).toBe(false);
    } finally { peer.getRun.mockImplementation(original); }
  });

  it("aborts observation backoff without delaying Stop or buying another run", async () => {
    const peer = new Peer(); peer.streamRun = async function* () {};
    peer.getRun.mockRejectedValueOnce(new CursorCloudClientError("http_error", { status: 429, retryAfterMs: 60_000 }));
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Stop during a provider retry delay" } });
    await waitFor(() => f.events.some(event => (event.payload as { code?: string }).code === "cursor_cloud_observation_retry"));
    const signal = ((peer.getRun.mock.calls[0] as unknown[])[2] as { signal: AbortSignal }).signal;
    await f.session.interrupt!();
    expect(signal.aborted).toBe(true);
    expect((await f.session.read()).phase).toBe("terminal");
    expect(peer.createAgent).toHaveBeenCalledTimes(1); expect(peer.createRun).not.toHaveBeenCalled();
    expect(f.events.filter(event => event.eventType === "turn.interrupted")).toHaveLength(1);
  });

  it.each(["fresh", "follow-up"])("serializes the injected native MCP discovery and semantic controls on a %s run", async phase => {
    const requests: Array<{ path: string; body: CursorCloudCreateInput }> = [];
    const now = "2026-10-28T00:00:00Z";
    let agentId = "";
    let currentRunId = runId;
    const nativeFetch: typeof globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://controlled.cursor.test");
      const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (init?.method === "POST" && (target.pathname === "/v1/agents" || target.pathname === `/v1/agents/${agentId}/runs`)) {
        const body = JSON.parse(String(init.body)) as CursorCloudCreateInput;
        requests.push({ path: target.pathname, body });
        agentId ||= body.agentId!;
        currentRunId = requests.length === 1 ? runId : "run-22222222-2222-4222-8222-222222222222";
        const run = { id: currentRunId, agentId, status: "RUNNING", createdAt: now, updatedAt: now };
        return json(target.pathname === "/v1/agents"
          ? { agent: { id: agentId, status: "ACTIVE", env: { type: "cloud" }, url: `https://cursor.com/agents/${agentId}`, createdAt: now, updatedAt: now, latestRunId: currentRunId }, run }
          : { run });
      }
      if (target.pathname.endsWith("/stream")) return new Response(`id: completed\nevent: result\ndata: ${JSON.stringify({ runId: currentRunId, status: "FINISHED" })}\n\n`, { headers: { "content-type": "text/event-stream" } });
      if (target.pathname === `/v1/agents/${agentId}/runs/${currentRunId}`) return json({ id: currentRunId, agentId, status: "FINISHED", createdAt: now, updatedAt: now });
      throw new Error("Unexpected controlled provider request");
    };
    const instructions = "Exact assigned instructions.\n\nAssigned skill content stays intact.";
    const f = await fixture(new Peer(), { instructions, modelParams: [{ id: "effort", value: "high" }], client: new CursorCloudClient({ apiKey: "synthetic-private-key", baseUrl: "https://controlled.cursor.test", fetch: nativeFetch }) });
    const task = "Ask the assigned question.\nPreserve this exact task text.";
    await f.session.startTurn({ message: { role: "user", text: task } });
    await waitFor(() => f.events.filter(event => event.eventType === "turn.completed").length === 1);
    if (phase === "follow-up") {
      await acknowledgeTerminal(f.session);
      await f.session.startTurn({ message: { role: "user", text: task } });
      await waitFor(() => f.events.filter(event => event.eventType === "turn.completed").length === 2);
    }
    const sent = requests.at(-1)!;
    expect(sent.path).toBe(phase === "fresh" ? "/v1/agents" : `/v1/agents/${agentId}/runs`);
    expect(sent.body).toMatchObject({ model: { id: "explicit-model", params: [{ id: "effort", value: "high" }] }, mode: "agent", mcpServers: [{ name: "paperclip", type: "http", url: f.options.relay.url, headers: { Authorization: `Bearer ${f.options.relay.token}` } }] });
    const prompt = sent.body.prompt.text;
    expect(prompt).toContain('get_mcp_tools({server:"paperclip"})');
    expect(prompt).toContain("native Paperclip Runner");
    expect(prompt).toContain("controller-managed MCP authentication");
    expect(prompt).toContain("do not need Paperclip REST credentials in the Cloud VM");
    expect(prompt).toContain("unrelated inherited dashboard MCP namespaces");
    for (const tool of ["request_human_input", "paperclip_finish", "paperclip_block"]) expect(prompt).toContain(tool);
    expect(prompt.endsWith(`\n\nPaperclip task:\n${task}`)).toBe(true);
    expect(requests[0]!.body.prompt.text.startsWith(instructions)).toBe(true);
    if (phase === "follow-up") expect(prompt).not.toContain(instructions);
    expect(prompt).not.toContain(f.options.relay.token);
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => /^checkpoint-.*\.json$/.test(name))!);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(checkpoint.instructionsDigest).toBe(cursorCloudDigest(requests[0]!.body.prompt.text.slice(0, -`\n\nPaperclip task:\n${task}`.length)));
    const { prompt: submittedPrompt, model, mode, mcpServers } = sent.body;
    expect(checkpoint.requestDigest).toBe(cursorCloudDigest(semanticCanonicalJson({ prompt: submittedPrompt, model, mode, mcpServers })));
  });

  it.each(["observer", "reconcile", "recovery"] as const)("keeps a delayed old %s result outside the next turn authority", async source => {
    const peer = new Peer();
    const oldRead = deferred<CursorCloudRun>();
    const reading = deferred();
    const followupRunId = "run-22222222-2222-4222-8222-222222222222";
    peer.createRun.mockImplementation(async (_id, input) => {
      peer.request = input;
      peer.native = { ...peer.native!, id: followupRunId, status: "RUNNING" };
      return { run: { ...peer.native } };
    });
    peer.streamRun = async function* (_agent, providerRunId, options = {}) {
      if (providerRunId === runId && source === "observer") return;
      yield { id: providerRunId === runId ? "old-cursor" : "new-cursor", event: "assistant", data: { text: "Current stream." } };
      if (!options.signal?.aborted) await new Promise<void>(accept => options.signal?.addEventListener("abort", () => accept(), { once: true }));
    };
    const holdRead = () => peer.getRun.mockImplementationOnce(async () => { reading.resolve(); return oldRead.promise; });
    if (source === "observer") holdRead();
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "First task" } }); await peer.created.promise;
    const previous = { ...peer.native!, status: "FINISHED" as const, result: "Old final result." };
    let session = f.session;
    let events = f.events;
    let reconciled: Promise<unknown> | undefined;
    if (source !== "observer") {
      await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
      if (source === "recovery") {
        const snapshot = await session.snapshot(); await session.detachControllerForRestart!(); await f.pump;
        holdRead();
        session = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!;
        sessions.push(session); events = [];
        void (async () => { for await (const event of session.events()) events.push(event); })();
      } else {
        holdRead(); reconciled = session.reconcile!();
      }
    }
    await reading.promise;
    await session.interrupt!();
    await acknowledgeTerminal(session);
    await session.attachRun!({ runId: "paperclip-followup" });
    const next = await session.startTurn({ message: { role: "user", text: "Second task" } });
    await waitFor(() => events.some(event => event.turnId === next.turnId && event.eventType === "item.delta"));
    await session.snapshot();
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => /^checkpoint-.*\.json$/.test(name))!);
    const before = JSON.parse(await readFile(checkpointPath, "utf8"));
    const eventCount = events.length;
    oldRead.resolve(previous);
    await reconciled;
    await new Promise<void>(accept => setImmediate(accept));
    await session.snapshot();
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toEqual(before);
    expect(await session.read()).toMatchObject({ agentId: previous.agentId, runId: followupRunId, turnId: next.turnId, phase: "running", pendingTerminalDelivery: null });
    expect(events.slice(eventCount)).toEqual([]);
    await session.interrupt!();
    expect(await session.read()).toMatchObject({ runId: followupRunId, phase: "terminal", pendingTerminalDelivery: { providerRunId: followupRunId, turnId: next.turnId, status: "CANCELLED" } });
    expect(events.filter(event => event.turnId === next.turnId && event.eventType === "turn.interrupted")).toHaveLength(1);
  });

  it.each(["assistant", "tool_call", "error"] as const)("discards an old %s stream continuation without disturbing the new observer", async kind => {
    const peer = new Peer(); distinctFollowup(peer);
    const release = deferred();
    const waiting = deferred();
    const streams: Array<{ runId: string; signal?: AbortSignal }> = [];
    peer.streamRun = async function* (_agent, providerRunId, options = {}) {
      streams.push({ runId: providerRunId, signal: options.signal });
      if (providerRunId === runId) {
        waiting.resolve(); await release.promise;
        if (kind === "error") throw new CursorCloudClientError("http_error", { status: 410 });
        yield { id: "stale-cursor", event: kind, data: kind === "assistant" ? { text: "Stale assistant." } : { callId: "stale-tool", name: "old_tool", status: "completed" } };
        return;
      }
      yield { id: "current-cursor", event: "assistant", data: { text: "Current assistant." } };
      if (!options.signal?.aborted) await new Promise<void>(accept => options.signal?.addEventListener("abort", () => accept(), { once: true }));
    };
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "First task" } }); await waiting.promise;
    await f.session.interrupt!();
    const next = await nextAuthority(f);
    release.resolve(); await new Promise<void>(accept => setImmediate(accept));
    expect(await savedCheckpoint(f.root, f.session)).toEqual(next.checkpoint);
    expect(f.events.slice(next.eventCount)).toEqual([]);
    expect(streams.map(stream => stream.runId)).toEqual([runId, peer.native!.id]);
    expect(streams[1]!.signal!.aborted).toBe(false);
    await f.session.interrupt!();
    expect((await f.session.read()).pendingTerminalDelivery).toMatchObject({ providerRunId: peer.native!.id, turnId: next.next.turnId });
  });

  it.each(["response", "rejection"] as const)("ignores an old create %s after another reconciler proves its terminal", async outcome => {
    const peer = new Peer(); distinctFollowup(peer);
    const released = deferred();
    const create = peer.createAgent.getMockImplementation()!;
    peer.createAgent.mockImplementationOnce(async input => {
      const response = await create(input); await released.promise;
      if (outcome === "rejection") throw new CursorCloudClientError("http_error", { status: 422 });
      return response;
    });
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "First task" } }); await peer.created.promise;
    peer.getRun.mockResolvedValueOnce({ ...peer.native!, status: "FINISHED" });
    await f.session.reconcile!();
    const next = await nextAuthority(f);
    released.resolve(); await new Promise<void>(accept => setImmediate(accept));
    expect(await savedCheckpoint(f.root, f.session)).toEqual(next.checkpoint);
    expect(f.events.slice(next.eventCount)).toEqual([]);
    await f.session.interrupt!();
    expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { providerRunId: peer.native!.id, turnId: next.next.turnId } });
  });

  it("does not bind an old pending Agent read over a newer Run", async () => {
    const peer = new Peer(); peer.failCreate = true; distinctFollowup(peer);
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "First task" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => event.payload.code === "cursor_cloud_remote_state_unknown"));
    const getAgent = peer.getAgent.getMockImplementation()!;
    const oldAgent = await getAgent(peer.native!.agentId);
    const released = deferred<typeof oldAgent>(); const reading = deferred();
    peer.getAgent.mockImplementationOnce(async () => { reading.resolve(); return released.promise; });
    const oldReconcile = f.session.reconcile!(); await reading.promise;
    peer.getRun.mockResolvedValueOnce({ ...peer.native!, status: "FINISHED" });
    await f.session.reconcile!();
    const next = await nextAuthority(f);
    released.resolve(oldAgent); await oldReconcile;
    expect(await savedCheckpoint(f.root, f.session)).toEqual(next.checkpoint);
    expect(f.events.slice(next.eventCount)).toEqual([]);
    await f.session.interrupt!();
    expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { providerRunId: peer.native!.id, turnId: next.next.turnId } });
  });

  it("keeps an old interrupt from cancelling or clearing the next turn Stop", async () => {
    const peer = new Peer(); distinctFollowup(peer);
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "First task" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const previous = { ...peer.native! };
    const oldRead = deferred<CursorCloudRun>(), reading = deferred();
    peer.getRun.mockImplementationOnce(async () => { reading.resolve(); return oldRead.promise; });
    const oldStop = f.session.interrupt!(); await reading.promise;
    peer.getRun.mockResolvedValueOnce({ ...previous, status: "FINISHED" });
    await f.session.reconcile!();
    const next = await nextAuthority(f);
    const currentRead = deferred<CursorCloudRun>(), currentReading = deferred();
    peer.getRun.mockImplementationOnce(async () => { currentReading.resolve(); return currentRead.promise; });
    const currentStop = f.session.interrupt!(); await currentReading.promise;
    const before = await savedCheckpoint(f.root, f.session);
    oldRead.resolve(previous); await oldStop;
    expect(await savedCheckpoint(f.root, f.session)).toEqual(before);
    expect(peer.cancelRun).not.toHaveBeenCalled();
    const readCount = peer.getRun.mock.calls.length;
    const duplicateStop = f.session.interrupt!();
    await new Promise<void>(accept => setImmediate(accept));
    expect(peer.getRun).toHaveBeenCalledTimes(readCount);
    currentRead.resolve({ ...peer.native! }); await Promise.all([currentStop, duplicateStop]);
    expect(peer.cancelRun).toHaveBeenCalledTimes(1);
    expect(peer.cancelRun).toHaveBeenCalledWith(previous.agentId, peer.native!.id, expect.anything());
    expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { providerRunId: peer.native!.id, turnId: next.next.turnId } });
  });

  it.each(["fresh", "follow-up"])("restores a provably unsent %s turn after an actual checkpoint publication failure", async phase => {
    const peer = new Peer(); distinctFollowup(peer);
    const f = await fixture(peer);
    if (phase === "follow-up") {
      await f.session.startTurn({ message: { role: "user", text: "First task" } });
      await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
      await f.session.interrupt!(); await acknowledgeTerminal(f.session);
      await f.session.attachRun!({ runId: "paperclip-followup" });
    }
    const before = await savedCheckpoint(f.root, f.session);
    const eventCount = f.events.length;
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => /^checkpoint-.*\.json$/.test(name))!);
    const savedPath = `${checkpointPath}.before-failure`;
    await rename(checkpointPath, savedPath); await mkdir(checkpointPath, { mode: 0o700 });
    try {
      await expect(f.session.startTurn({ message: { role: "user", text: "No remote request before durable custody" } })).rejects.toThrow();
    } finally {
      await rm(checkpointPath, { recursive: true }); await rename(savedPath, checkpointPath);
    }
    expect(peer.createAgent).toHaveBeenCalledTimes(phase === "fresh" ? 0 : 1);
    expect(peer.createRun).not.toHaveBeenCalled();
    expect(await savedCheckpoint(f.root, f.session)).toEqual(before);
    expect(f.events.slice(eventCount)).toEqual([]);
    const reconciliations = peer.getAgent.mock.calls.length, cancellations = peer.cancelRun.mock.calls.length;
    await f.session.interrupt!();
    expect(peer.getAgent).toHaveBeenCalledTimes(reconciliations); expect(peer.cancelRun).toHaveBeenCalledTimes(cancellations);
    const snapshot = await f.session.snapshot(); await f.session.close({ reason: "storage_recovered" }); await f.pump;
    expect(peer.getAgent).toHaveBeenCalledTimes(reconciliations); expect(peer.cancelRun).toHaveBeenCalledTimes(cancellations);
    const recovered = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!;
    sessions.push(recovered);
    expect(await savedCheckpoint(f.root, recovered)).toEqual({ ...before, relayTurnToken: before.relayTurnToken ?? null });
    await recovered.startTurn({ message: { role: "user", text: "Retry after storage recovery" } });
    await waitFor(() => peer.createAgent.mock.calls.length === 1 && peer.createRun.mock.calls.length === (phase === "fresh" ? 0 : 1));
    await recovered.interrupt!();
  });

  it("retains accepted provider work when its confirmed-identity checkpoint write fails", async () => {
    const peer = new Peer();
    const f = await fixture(peer);
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => /^checkpoint-.*\.json$/.test(name))!);
    const savedPath = `${checkpointPath}.before-confirmation`;
    const create = peer.createAgent.getMockImplementation()!;
    peer.createAgent.mockImplementationOnce(async input => {
      const response = await create(input);
      await rename(checkpointPath, savedPath); await mkdir(checkpointPath, { mode: 0o700 });
      return response;
    });
    try {
      await f.session.startTurn({ message: { role: "user", text: "Accepted provider work retains its custody" } });
      await waitFor(() => f.events.some(event => event.payload.code === "cursor_cloud_remote_state_unknown"));
      expect(await f.session.read()).toMatchObject({ agentId: peer.native!.agentId, runId, phase: "running" });
      expect(peer.createAgent).toHaveBeenCalledTimes(1);
      await expect(f.session.startTurn({ message: { role: "user", text: "No duplicate" } })).rejects.toThrow("unresolved remote work");
    } finally {
      await rm(checkpointPath, { recursive: true }); await rename(savedPath, checkpointPath);
    }
    expect(await savedCheckpoint(f.root, f.session)).toMatchObject({ agentId: peer.native!.agentId, runId, phase: "running", pendingOperation: null });
    await f.session.interrupt!();
    expect(peer.createAgent).toHaveBeenCalledTimes(1); expect(peer.cancelRun).toHaveBeenCalledTimes(1);
    expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { status: "CANCELLED", providerRunId: runId } });
  });

  it("restores an unsent launch behind a concurrent Stop write after persistence rejects", async () => {
    const f = await fixture();
    const before = await savedCheckpoint(f.root, f.session);
    const held = deferred(), release = deferred(), stoppingWritten = deferred();
    const failure = new Error("controlled post-publication persistence failure");
    const originalWrite = CursorCloudCheckpointStore.prototype.write;
    let intercepted = false;
    const write = vi.spyOn(CursorCloudCheckpointStore.prototype, "write").mockImplementation(function(value) {
      const persisted = originalWrite.call(this, value);
      if (value.phase === "creating" && !intercepted) {
        intercepted = true;
        return persisted.then(async () => { held.resolve(); await release.promise; throw failure; });
      }
      if (value.phase === "stopping") void persisted.then(() => stoppingWritten.resolve());
      return persisted;
    });
    try {
      const started = f.session.startTurn({ message: { role: "user", text: "Stop before unsent launch" } });
      const rejected = expect(started).rejects.toBe(failure);
      await held.promise;
      const stopped = f.session.interrupt!(); await stoppingWritten.promise;
      expect(f.peer.createAgent).not.toHaveBeenCalled();
      release.resolve(); await rejected; await stopped;
      expect(await savedCheckpoint(f.root, f.session)).toEqual(before);
      expect(f.peer.createAgent).not.toHaveBeenCalled(); expect(f.peer.getAgent).not.toHaveBeenCalled(); expect(f.peer.cancelRun).not.toHaveBeenCalled();
      await f.session.startTurn({ message: { role: "user", text: "Next admitted task" } }); await f.peer.created.promise;
      await f.session.interrupt!();
    } finally { release.resolve(); write.mockRestore(); }
  });

  it("registers the new turn launch before Stop can enter its initial checkpoint await", async () => {
    const peer = new Peer(); distinctFollowup(peer);
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "First task" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    await f.session.interrupt!(); await acknowledgeTerminal(f.session);
    const held = deferred(), release = deferred(), stoppingWritten = deferred();
    const originalWrite = CursorCloudCheckpointStore.prototype.write;
    const write = vi.spyOn(CursorCloudCheckpointStore.prototype, "write").mockImplementation(function(value) {
      const persisted = originalWrite.call(this, value);
      if (value.phase === "creating") return persisted.then(async () => { held.resolve(); await release.promise; });
      if (value.phase === "stopping") void persisted.then(() => stoppingWritten.resolve());
      return persisted;
    });
    try {
      const started = f.session.startTurn({ message: { role: "user", text: "Second task" } }); await held.promise;
      const stopped = f.session.interrupt!(); await stoppingWritten.promise;
      expect(peer.createRun).not.toHaveBeenCalled();
      release.resolve();
      const next = await started; await stopped;
      expect(peer.cancelRun).toHaveBeenCalledTimes(2);
      expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { providerRunId: peer.native!.id, turnId: next.turnId, status: "CANCELLED" } });
    } finally { release.resolve(); write.mockRestore(); }
  });

  it("retains a confirmed same-turn Run when its delayed create rejects", async () => {
    const peer = new Peer();
    const release = deferred();
    const create = peer.createAgent.getMockImplementation()!;
    peer.createAgent.mockImplementationOnce(async input => { await create(input); await release.promise; throw new CursorCloudClientError("http_error", { status: 422 }); });
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Current task" } }); await peer.created.promise;
    await f.session.reconcile!();
    const before = await savedCheckpoint(f.root, f.session);
    release.resolve();
    await waitFor(() => f.events.some(event => event.payload.code === "cursor_cloud_remote_state_unknown"));
    const after = await savedCheckpoint(f.root, f.session);
    expect(after).toEqual({ ...before, sourceSequence: before.sourceSequence + 1 });
    expect(f.events.some(event => event.eventType === "turn.failed")).toBe(false);
    await f.session.interrupt!();
    expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { providerRunId: runId } });
  });

  it.each(["agent", "run"] as const)("keeps a current terminal with a mismatched %s identity fenced", async identity => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Current task" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const before = await savedCheckpoint(f.root, f.session);
    f.peer.getRun.mockResolvedValueOnce({ ...f.peer.native!, status: "FINISHED", ...(identity === "agent" ? { agentId: "bc-different" } : { id: "run-22222222-2222-4222-8222-222222222222" }) });
    await expect(f.session.reconcile!()).rejects.toThrow("confirmed Agent/Run identity");
    expect(await savedCheckpoint(f.root, f.session)).toEqual(before);
    await f.session.interrupt!();
    expect(await f.session.read()).toMatchObject({ phase: "terminal", pendingTerminalDelivery: { providerRunId: runId } });
  });

  it("refuses expired relay authority before remote work while retaining idle recovery for cleanup", async () => {
    const f = await fixture();
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const restored = (await new CursorCloudDriver({ ...f.options, relay: { ...f.options.relay, expiresAt: Date.now() - 1 } }).recoverSession(snapshot)).session!;
    sessions.push(restored);
    await expect(restored.startTurn({ message: { role: "user", text: "Must not launch" } })).rejects.toThrow("relay capability expired");
    expect(f.peer.createAgent).not.toHaveBeenCalled(); expect(f.peer.createRun).not.toHaveBeenCalled();
    await restored.close({ reason: "expired_cleanup" });
  });

  it("lists exact current Agent artifact paths through its bounded provider-owned read-only helper", async () => {
    const f = await fixture();
    f.peer.listArtifacts.mockResolvedValue({ items: [{ path: "artifacts/evidence.txt", sizeBytes: 12, updatedAt: "2026-10-28T00:00:00Z" }] } as any);
    await f.session.startTurn({ message: { role: "user", text: "Find the artifact" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const initialized = await rpc(f.options.relay.socketPath, { id: 0, method: "initialize" }, relayHeaders(f.peer));
    const result = await rpc(f.options.relay.socketPath, { id: 1, method: "tools/call", params: { name: "list_cursor_cloud_artifacts", arguments: {} } }, relayHeaders(f.peer), initialized.session);
    expect(JSON.parse(result.value.result.content[0].text)).toEqual({ items: [{ path: "artifacts/evidence.txt", sizeBytes: 12 }] });
    expect(f.peer.listArtifacts).toHaveBeenCalledWith(f.peer.native!.agentId, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.handler).not.toHaveBeenCalled();
  });

  it("binds revised idle instructions once on same-Agent followup and rejects revised active recovery", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Original task" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const revised = { ...f.options, instructions: "Updated assigned instructions and skill bundle." };
    const restored = (await new CursorCloudDriver(revised).recoverSession(snapshot)).session!; sessions.push(restored);
    await acknowledgeTerminal(restored);
    await restored.startTurn({ message: { role: "user", text: "Follow up" } });
    await waitFor(() => f.peer.createRun.mock.calls.length === 1);
    expect(f.peer.request?.prompt.text).toMatch(/^Updated assigned instructions and skill bundle\.[\s\S]*\n\nPaperclip task:\nFollow up$/);
    expect(f.peer.createAgent).toHaveBeenCalledTimes(1);
    const activeSnapshot = await restored.snapshot(); await restored.detachControllerForRestart!();
    await expect(new CursorCloudDriver(f.options).recoverSession(activeSnapshot)).rejects.toThrow("instructions changed");
    const final = (await new CursorCloudDriver(revised).recoverSession(activeSnapshot)).session!; sessions.push(final);
    await final.interrupt!();
    await acknowledgeTerminal(final);
    await final.startTurn({ message: { role: "user", text: "One more task" } });
    await waitFor(() => f.peer.createRun.mock.calls.length === 2);
    expect(f.peer.request?.prompt.text).toMatch(/\n\nPaperclip task:\nOne more task$/);
    expect(f.peer.request?.prompt.text).not.toContain(revised.instructions);
  });

  it("opens without paid work, sends exact model/instructions and current private MCP headers only on turn", async () => {
    const f = await fixture();
    expect(cursorCloudDriverDescriptor().capabilities).toMatchObject({ usage: false, unsupported: expect.arrayContaining(["production_usage_accounting"]) });
    expect(f.peer.createAgent).not.toHaveBeenCalled();
    expect((await f.session.read?.())?.effectiveModelAcknowledged).toBe(false);
    await f.session.startTurn({ message: { role: "user", text: "Task one" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    expect(f.peer.request).toMatchObject({ model: { id: "explicit-model" }, prompt: { text: expect.stringMatching(/^Follow these exact instructions\.[\s\S]*\n\nPaperclip task:\nTask one$/) }, mcpServers: [{ url: "https://relay.example.test/mcp", headers: { Authorization: "Bearer private-relay-token" } }] });
    expect(f.peer.request).not.toHaveProperty("schema");
    const identity = f.events.filter(event => event.payload.code === "cursor_cloud_remote_identity").map(event => JSON.parse(String(event.payload.message))).find(value => value.runId !== null);
    expect(identity).toEqual({ schema: "paperclip.cursor-cloud.remote-identity.v1", provider: "cursor_cloud", agentId: f.peer.native!.agentId, runId, ownerRunId: "paperclip-run", normalizedSessionId: "session", phase: "running" });
    const checkpoint = await readFile(join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!), "utf8");
    expect(checkpoint).not.toContain("private-relay-token"); expect(checkpoint).not.toContain("private-cursor-key"); expect(checkpoint).not.toContain("Task one");
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    expect(f.events.some(event => event.eventType === "run.result.proposed")).toBe(false);
    await acknowledgeTerminal(f.session);
    await f.session.startTurn({ message: { role: "user", text: "Task two" } });
    await waitFor(() => f.peer.createRun.mock.calls.length === 1);
    expect(f.peer.request?.prompt.text).toMatch(/\n\nPaperclip task:\nTask two$/); expect(f.peer.request?.prompt.text).not.toContain(f.options.instructions); expect(f.peer.createAgent).toHaveBeenCalledTimes(1);
  });

  it("delivers the full admitted semantic response through the real Unix MCP bridge, rejects unknown/late calls", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Use a tool" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const path = f.options.relay.socketPath;
    expect((await rpc(path, { id: "bad", method: "tools/list" }, "wrong")).status).toBe(401);
    const initialized = await rpc(path, { id: 1, method: "initialize" }, relayHeaders(f.peer));
    const response = await rpc(path, { id: "call-1", method: "tools/call", params: { name: "write_note", arguments: { note: "first" } } }, relayHeaders(f.peer), initialized.session);
    expect(response.value.result.content[0].text).toContain('"success":true');
    expect(f.handler).toHaveBeenCalledWith(expect.objectContaining({ tool: "write_note", arguments: { note: "first" }, turnId: expect.stringMatching(/^turn-/) }));
    await rpc(path, { id: "missing", method: "tools/call", params: { name: "not_admitted", arguments: {} } }, relayHeaders(f.peer), initialized.session);
    expect(f.handler).toHaveBeenCalledTimes(1);
    await f.session.interrupt!();
    expect(f.peer.cancelRun).toHaveBeenCalledTimes(1);
    expect(f.peer.getRun.mock.calls.length).toBeGreaterThanOrEqual(2);
    const late = await rpc(path, { id: "late", method: "tools/call", params: { name: "write_note", arguments: { note: "late" } } }, relayHeaders(f.peer), initialized.session);
    expect(late.status).toBe(403); expect(f.handler).toHaveBeenCalledTimes(1);
    expect((await f.session.read?.())?.providerStatus).toBe("CANCELLED");
  });

  it("retains only an accepted semantic receipt and waits for actual provider termination", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Finish semantically" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const initialized = await rpc(f.options.relay.socketPath, { id: 0, method: "initialize" }, relayHeaders(f.peer));
    const args = { reportedWorkDisposition: "done", summary: "Completed.", evidence: [], verification: [], completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [], remainingWork: [] } };
    f.handler.mockResolvedValueOnce({ success: false, contentItems: [{ type: "inputText", text: "rejected" }] });
    await rpc(f.options.relay.socketPath, { id: "rejected", method: "tools/call", params: { name: "paperclip_finish", arguments: args } }, relayHeaders(f.peer), initialized.session);
    expect((await f.session.read?.())?.semanticCompletionReceipt).toBeNull();
    await rpc(f.options.relay.socketPath, { id: "accepted", method: "tools/call", params: { name: "paperclip_finish", arguments: args } }, relayHeaders(f.peer), initialized.session);
    expect((await f.session.read?.())?.semanticCompletionReceipt).toMatchObject({ inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.events.some(event => event.eventType === "turn.completed" || event.eventType === "run.result.proposed")).toBe(false);
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
  });

  it("resumes the saved opaque stream cursor without duplicating a replayed text frame", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Reconnect" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    f.peer.cursor = undefined;
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    const replay: PrpEvent[] = []; void (async () => { for await (const event of restored.events()) replay.push(event); })();
    await waitFor(() => f.peer.cursor === "opaque-1");
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => replay.some(event => event.eventType === "turn.completed"));
    expect(replay.some(event => event.eventType === "item.delta")).toBe(false);
    expect(f.peer.createAgent).toHaveBeenCalledTimes(1);
  });

  it("namespaces repeated RPC id zero by initialized MCP session and rejects an old session after a new turn", async () => {
    const f = await fixture(); const path = f.options.relay.socketPath;
    await f.session.startTurn({ message: { role: "user", text: "First turn" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const first = await rpc(path, { id: 0, method: "initialize" }, relayHeaders(f.peer));
    const second = await rpc(path, { id: 0, method: "initialize" }, relayHeaders(f.peer));
    const call = { id: 0, method: "tools/call", params: { name: "write_note", arguments: { note: "same wire ID" } } };
    await rpc(path, call, relayHeaders(f.peer), first.session); await rpc(path, call, relayHeaders(f.peer), second.session);
    expect(f.handler).toHaveBeenCalledTimes(2);
    expect(f.handler.mock.calls[0]![0].callId).not.toBe(f.handler.mock.calls[1]![0].callId);
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    await acknowledgeTerminal(f.session);
    await f.session.startTurn({ message: { role: "user", text: "Next turn" } });
    const third = await rpc(path, { id: 0, method: "initialize" }, relayHeaders(f.peer));
    expect((await rpc(path, call, relayHeaders(f.peer), first.session)).status).toBe(404);
    await rpc(path, call, relayHeaders(f.peer), third.session); expect(f.handler).toHaveBeenCalledTimes(3);
  });

  it("rejects prior-turn relay credentials before a fresh MCP initialization", async () => {
    const f = await fixture(); const path = f.options.relay.socketPath;
    distinctFollowup(f.peer);
    await f.session.startTurn({ message: { role: "user", text: "First turn" } });
    await f.peer.created.promise;
    const previousHeaders = relayHeaders(f.peer);
    const first = await rpc(path, { id: 0, method: "initialize" }, previousHeaders);
    expect(first.status).toBe(200);
    const call = { id: 1, method: "tools/call", params: { name: "write_note", arguments: { note: "current authority" } } };
    expect((await rpc(path, call, previousHeaders, first.session)).status).toBe(200);
    expect(f.handler).toHaveBeenCalledTimes(1);
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    await nextAuthority(f);
    const currentHeaders = relayHeaders(f.peer);
    expect((await rpc(path, { id: 2, method: "initialize" }, previousHeaders)).status).toBe(401);
    expect((await rpc(path, call, previousHeaders, first.session)).status).toBe(401);
    expect(f.handler).toHaveBeenCalledTimes(1);
    const current = await rpc(path, { id: 3, method: "initialize" }, currentHeaders);
    expect(current.status).toBe(200);
    expect((await rpc(path, call, currentHeaders, current.session)).status).toBe(200);
    expect(f.handler).toHaveBeenCalledTimes(2);
  });

  it("retains the current relay capability on active recovery without exposing it in snapshots or events", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Recover this turn" } });
    await f.peer.created.promise;
    const headers = relayHeaders(f.peer);
    const token = headers[RUNNER_TOOL_SCOPE_TOKEN_HEADER]!.slice(7);
    const snapshot = await f.session.snapshot();
    await f.session.detachControllerForRestart!(); await f.pump;
    const restored = (await f.driver.recoverSession(snapshot)).session!; sessions.push(restored);
    expect((await rpc(f.options.relay.socketPath, { id: 0, method: "initialize" }, headers)).status).toBe(200);
    expect(JSON.stringify(await restored.read())).not.toContain(token);
    expect(JSON.stringify(await restored.snapshot())).not.toContain(token);
    expect(JSON.stringify(f.events)).not.toContain(token);
    expect((await savedCheckpoint(f.root, restored)).relayTurnToken).toBe(token);
    expect(f.peer.createAgent).toHaveBeenCalledTimes(1);
    expect(f.peer.createRun).not.toHaveBeenCalled();
  });

  it("redacts the current turn capability from provider events and terminal delivery", async () => {
    const peer = new Peer();
    peer.streamRun = async function* () {
      const token = relayHeaders(this)[RUNNER_TOOL_SCOPE_TOKEN_HEADER]!.slice(7);
      yield { id: "capability-text", event: "assistant", data: { text: `Private value ${token}` } };
      this.native!.status = "FINISHED"; this.native!.result = token;
      yield { id: "capability-result", event: "result", data: { runId, status: "FINISHED" } };
    };
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Keep private metadata out of output" } });
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    const token = relayHeaders(peer)[RUNNER_TOOL_SCOPE_TOKEN_HEADER]!.slice(7);
    expect(JSON.stringify(f.events)).not.toContain(token);
    expect(JSON.stringify(await f.session.read())).not.toContain(token);
    expect(f.events.find(event => event.eventType === "item.delta")?.payload.text).toBe("Private value [redacted]");
    expect((await f.session.read()).pendingTerminalDelivery).toMatchObject({ result: "[redacted]" });
  });

  it("keeps legacy active recovery cleanup-only when its turn capability is absent", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Legacy state" } }); await f.peer.created.promise;
    const headers = relayHeaders(f.peer); const checkpoint = await savedCheckpoint(f.root, f.session);
    const snapshot = await f.session.snapshot();
    await f.session.detachControllerForRestart!(); await f.pump;
    delete checkpoint.relayTurnToken;
    const path = join(f.root, (await readdir(f.root)).find(name => /^checkpoint-.*\.json$/.test(name))!);
    await writeFile(path, JSON.stringify(checkpoint), { mode: 0o600 });
    const restored = (await f.driver.recoverSession(snapshot)).session!; sessions.push(restored);
    expect((await rpc(f.options.relay.socketPath, { id: 0, method: "initialize" }, headers)).status).toBe(403);
    await restored.interrupt();
    expect(f.peer.cancelRun).toHaveBeenCalledTimes(1);
    expect(f.peer.createAgent).toHaveBeenCalledTimes(1);
    expect(f.peer.createRun).not.toHaveBeenCalled();
  });

  it("recovers an ambiguous create by saved agent identity, without another create or caller model acknowledgment", async () => {
    const peer = new Peer(); peer.failCreate = true;
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Ambiguous create" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => event.payload.code === "cursor_cloud_remote_state_unknown"));
    const snapshot = await f.session.snapshot();
    await f.session.detachControllerForRestart!(); await f.pump;
    const result = await new CursorCloudDriver(f.options).recoverSession(snapshot);
    expect(result.recovered).toBe(true); const restored = result.session!; sessions.push(restored);
    await waitFor(() => peer.getAgent.mock.calls.length > 0);
    expect(peer.createAgent).toHaveBeenCalledTimes(1);
    expect((await restored.read?.())?.effectiveModelAcknowledged).toBe(false);
    await restored.interrupt!();
    const restoredSnapshot = await restored.snapshot(); await restored.close({ reason: "done" });
    await expect(new CursorCloudDriver({ ...f.options, model: "different-model" }).recoverSession(restoredSnapshot)).rejects.toThrow("changed");
  });

  it.each([401, 403, 404, 422])("retains a saved ambiguous create identity when reconciliation returns HTTP %s", async status => {
    const peer = new Peer(); peer.failCreate = true;
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Accepted remotely but response lost" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => event.payload.code === "cursor_cloud_remote_state_unknown"));
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!);
    const before = JSON.parse(await readFile(checkpointPath, "utf8"));
    const getAgent = peer.getAgent.getMockImplementation()!;
    peer.getAgent.mockRejectedValue(new CursorCloudClientError("http_error", { status }));
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    const events: PrpEvent[] = []; void (async () => { for await (const event of restored.events()) events.push(event); })();
    await waitFor(() => events.some(event => event.payload.code === "cursor_cloud_remote_state_unknown"));
    await restored.snapshot();
    const after = JSON.parse(await readFile(checkpointPath, "utf8"));
    expect(after).toMatchObject({ phase: "creating", pendingOperation: "create_agent", requestedAgentId: before.requestedAgentId, idempotencyKey: before.idempotencyKey, requestDigest: before.requestDigest });
    expect(after.requestedAgentId).toMatch(/^bc-/);
    await expect(restored.startTurn({ message: { role: "user", text: "Must not replace uncertain work" } })).rejects.toThrow("unresolved remote work");
    expect(peer.createAgent).toHaveBeenCalledTimes(1); expect(peer.createRun).not.toHaveBeenCalled();
    peer.getAgent.mockImplementation(getAgent); await restored.interrupt!();
  });

  it("allows a definitive direct mutation rejection to settle without pretending work was accepted", async () => {
    const peer = new Peer();
    peer.createAgent.mockRejectedValue(new CursorCloudClientError("http_error", { status: 422 }));
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Invalid native request" } });
    await waitFor(() => f.events.some(event => event.eventType === "turn.failed"));
    expect(await f.session.read?.()).toMatchObject({ phase: "idle", providerStatus: "REJECTED" });
    expect(f.events.some(event => event.eventType === "turn.failed" && event.payload.remoteWorkAccepted === false)).toBe(true);
  });

  it("retains unconfirmed Stop as fenced active work, never emits a terminal on cancel acknowledgment alone", async () => {
    const peer = new Peer(); peer.cancelRun = vi.fn(async () => ({ id: runId }));
    const f = await fixture(peer, { cancelTimeoutMs: 120 });
    await f.session.startTurn({ message: { role: "user", text: "Keep running" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    await expect(f.session.interrupt!()).rejects.toThrow("did not confirm");
    expect(f.events.some(event => event.eventType === "turn.interrupted" || event.eventType === "turn.completed")).toBe(false);
    expect((await f.session.read?.())?.phase).toBe("stopping");
    await expect(f.session.startTurn({ message: { role: "user", text: "New work" } })).rejects.toThrow("unresolved");
    peer.native!.status = "CANCELLED";
  });

  it("releases a private stale Unix socket only after its real child owner was killed", async () => {
    const f = await fixture(); const snapshot = await f.session.snapshot(); await f.session.close({ reason: "initial_idle" }); await f.pump;
    const { client: _client, dynamicToolHandler: _handler, ...childOptions } = f.options;
    const script = `import {CursorCloudDriver} from ${JSON.stringify(new URL("./cursor-cloud-driver.ts", import.meta.url).href)}; process.umask(0o022); const driver=new CursorCloudDriver({...JSON.parse(process.argv[1]),dynamicToolHandler:async()=>{throw new Error('Unexpected tool call')}}); await driver.recoverSession(JSON.parse(process.argv[2])); process.stdout.write('ready\\n');`;
    const child = spawn(process.execPath, ["--import", new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, "--input-type=module", "-e", script, JSON.stringify(childOptions), JSON.stringify(snapshot)], { stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
    try {
      await Promise.race([once(child.stdout!, "data"), once(child, "exit").then(() => { throw new Error(`Controlled driver child exited before readiness: ${errors}`); })]);
      expect((await lstat(f.options.relay.socketPath)).mode & 0o777).toBe(0o600);
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    }
    finally { child.kill("SIGKILL"); }
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    expect((await restored.read?.())?.phase).toBe("idle"); expect(f.peer.createAgent).not.toHaveBeenCalled();
  });

  it("refuses a live checkpoint owner and never removes an unknown file at the socket path", async () => {
    const f = await fixture(); const snapshot = await f.session.snapshot();
    await expect(new CursorCloudDriver(f.options).recoverSession(snapshot)).rejects.toThrow("live owner");
    await f.session.close({ reason: "idle" }); await f.pump;
    await writeFile(f.options.relay.socketPath, "unowned file", { mode: 0o600 });
    await expect(new CursorCloudDriver(f.options).recoverSession(snapshot)).rejects.toThrow("without safe dead-owner");
    expect(await readFile(f.options.relay.socketPath, "utf8")).toBe("unowned file");
  });

  it("retains the exact terminal delivery across restart until its receipt is acknowledged", async () => {
    const f = await fixture();
    const started = await f.session.startTurn({ message: { role: "user", text: "Retain the final result" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    f.peer.native!.result = "Recovered final private-cursor-key private-relay-token";
    f.peer.native!.status = "FINISHED"; f.peer.release.resolve();
    await waitFor(() => f.events.some(event => event.eventType === "turn.completed"));
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!);
    expect(JSON.parse(await readFile(checkpointPath, "utf8")).sourceSequence).toBe(f.events.find(event => event.eventType === "turn.completed")!.sourceSeq);
    const pending = (await f.session.read?.())?.pendingTerminalDelivery as Record<string, unknown>;
    expect(pending).toMatchObject({ schema: "paperclip.cursor-cloud.terminal-delivery.v1", threadId: "session", turnId: started.turnId, providerRunId: runId, status: "FINISHED", interrupted: false, result: "Recovered final [redacted] [redacted]", receiptId: expect.any(String) });
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    expect((await restored.read?.())?.pendingTerminalDelivery).toEqual(pending);
    await expect(restored.startTurn({ message: { role: "user", text: "Must not replace the pending receipt" } })).rejects.toThrow("terminal delivery");
    await expect(restored.acknowledgeTerminalDelivery({ turnId: started.turnId, receiptId: "wrong" })).rejects.toThrow("receipt");
    expect((await restored.read?.())?.pendingTerminalDelivery).toEqual(pending);
    await restored.acknowledgeTerminalDelivery({ turnId: started.turnId, receiptId: pending.receiptId as string });
    expect((await restored.read?.())?.pendingTerminalDelivery).toBeNull();
    const acknowledged = await restored.snapshot(); await restored.detachControllerForRestart!();
    const final = (await new CursorCloudDriver(f.options).recoverSession(acknowledged)).session!; sessions.push(final);
    expect((await final.read?.())?.pendingTerminalDelivery).toBeNull();
    expect(f.peer.createAgent).toHaveBeenCalledTimes(1); expect(f.peer.createRun).not.toHaveBeenCalled();
  });

  it.each(["agent", "run"])("retries a transient recovery %s read without replacing work or extending its deadline", async read => {
    const peer = new Peer(); peer.failCreate = read === "agent";
    const f = await fixture(peer);
    await f.session.startTurn({ message: { role: "user", text: "Recover the existing work" } }); await peer.created.promise;
    await waitFor(() => f.events.some(event => read === "agent" ? event.payload.code === "cursor_cloud_remote_state_unknown" : event.eventType === "item.delta"));
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!);
    const deadlineAt = JSON.parse(await readFile(checkpointPath, "utf8")).deadlineAt;
    const error = new CursorCloudClientError("http_error", { status: 503 });
    if (read === "agent") peer.getAgent.mockRejectedValueOnce(error);
    else peer.getRun.mockRejectedValueOnce(error);
    const stream = vi.spyOn(peer, "streamRun");
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    await waitFor(() => stream.mock.calls.length > 0);
    expect(peer.createAgent).toHaveBeenCalledTimes(1); expect(peer.createRun).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(checkpointPath, "utf8")).deadlineAt).toBe(deadlineAt);
    await restored.interrupt!();
  });

  it("enforces the saved deadline while the first recovery read remains pending", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Recover with a slow read" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const checkpointPath = join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
    checkpoint.deadlineAt = Date.now() + 100; await writeFile(checkpointPath, JSON.stringify(checkpoint), { mode: 0o600 });
    const blocked = deferred<CursorCloudRun>();
    const getRun = f.peer.getRun.getMockImplementation()!;
    f.peer.getRun.mockImplementationOnce(() => blocked.promise);
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    try {
      await waitFor(() => f.peer.cancelRun.mock.calls.length === 1);
      expect(f.peer.createAgent).toHaveBeenCalledTimes(1); expect(f.peer.createRun).not.toHaveBeenCalled();
      await vi.waitFor(async () => expect((await restored.read?.())?.phase).toBe("terminal"));
    } finally { blocked.resolve(await getRun()); }
  });

  it("treats an expired persisted active deadline as cleanup-only instead of buying another full turn", async () => {
    const f = await fixture();
    await f.session.startTurn({ message: { role: "user", text: "Expire during outage" } }); await f.peer.created.promise;
    await waitFor(() => f.events.some(event => event.eventType === "item.delta"));
    const snapshot = await f.session.snapshot(); await f.session.detachControllerForRestart!(); await f.pump;
    const path = join(f.root, (await readdir(f.root)).find(name => name.endsWith(".json"))!);
    const checkpoint = JSON.parse(await readFile(path, "utf8")); expect(checkpoint.deadlineAt).toBeGreaterThan(Date.now());
    checkpoint.deadlineAt = Date.now() - 1; await writeFile(path, JSON.stringify(checkpoint), { mode: 0o600 });
    const restored = (await new CursorCloudDriver(f.options).recoverSession(snapshot)).session!; sessions.push(restored);
    await waitFor(() => f.peer.cancelRun.mock.calls.length === 1);
    await waitFor(() => f.peer.native!.status === "CANCELLED");
    expect(f.peer.createAgent).toHaveBeenCalledTimes(1); expect(f.peer.createRun).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await restored.read?.())?.phase).toBe("terminal"));
  });
});
