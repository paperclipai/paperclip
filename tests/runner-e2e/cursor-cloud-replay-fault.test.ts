import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CursorCloudClient } from "../../packages/paperclip-runner/src/drivers/cursor-cloud/cloud-client.js";
import { CursorCloudDriver } from "../../packages/paperclip-runner/src/drivers/cursor-cloud/cursor-cloud-driver.js";
import type { PrpEvent } from "../../packages/paperclip-runner/src/protocol/replay-contract.js";
import { createCursorCloudReplayFaultFetch, gradeCursorCloudReplayFault, installCursorCloudReplayFault, readCursorCloudReplayFaultProofs, readCursorCloudReplayFaultReservation, withCursorCloudReplayFault, type CursorCloudReplayFaultProof } from "./cursor-cloud-replay-fault.js";

const agent = "bc-11111111-1111-4111-8111-111111111111", run = "run-22222222-2222-4222-8222-222222222222";
const url = `https://api.cursor.com/v1/agents/${agent}/runs/${run}/stream`;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const expected = [{ agentIdSha256: digest(agent), runIdSha256: digest(run) }];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const directory = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "cc-replay-")); roots.push(directory); return directory; }
function bytes(parts: readonly Uint8Array[], onCancel = vi.fn()) {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (index < parts.length) controller.enqueue(parts[index++]!); else controller.close(); }, cancel: onCancel }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}
async function readUntilCut(response: Response) {
  const reader = response.body!.getReader(), chunks: Uint8Array[] = [];
  let failure: unknown;
  try { while (true) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); } } catch (error) { failure = error; }
  return { value: Buffer.concat(chunks).toString("utf8"), failure };
}
function fixture(response: () => Response) {
  let proof: CursorCloudReplayFaultProof | undefined;
  const original = vi.fn(async () => response());
  return { original, fetch: createCursorCloudReplayFaultFetch({ fetch: original as typeof fetch, digest, record: value => { proof = value; } }), proof: () => proof! };
}

describe("Cursor Cloud live replay fault framing", () => {
  it.each(["\n", "\r\n", "\r"])("cuts after exact complete native bytes across every chunk boundary (%j)", async newline => {
    const prefix = `: keepalive${newline}${newline}id: ignored${newline}${newline}`;
    const frame = `event: assistant${newline}id: old${newline}id: opaque-cursor${newline}data: {"text":"private provider canary 🌱"}${newline}${newline}`;
    const trailing = `event: done${newline}data: {}${newline}${newline}`;
    const complete = Buffer.from(prefix + frame + trailing);
    const cancellation = vi.fn();
    const f = fixture(() => bytes([...complete].map(byte => Uint8Array.of(byte)), cancellation));
    const first = await readUntilCut(await f.fetch(url));
    expect(first.value).toBe(prefix + frame); expect(first.failure).toBeInstanceOf(Error); expect(cancellation).toHaveBeenCalledTimes(1);
    expect(f.proof().cut).toMatchObject({ eventIdSha256: digest("opaque-cursor"), frameSha256: digest(frame), frameBytes: Buffer.byteLength(frame), event: "assistant" });
    await f.fetch(url, { headers: { "Last-Event-ID": "opaque-cursor" } });
    expect(gradeCursorCloudReplayFault([f.proof()], expected).passed).toBe(true);
    const serialized = JSON.stringify(f.proof());
    for (const privateValue of [agent, run, "opaque-cursor", "private provider canary"]) expect(serialized).not.toContain(privateValue);
  });
  it("forwards several frames from one chunk without delivering post-cut bytes", async () => {
    const prefix = 'event: status\nid: start\ndata: {"status":"RUNNING"}\n\n';
    const frame = 'event: tool_call\nid: cut\ndata: {"status":"running"}\n\n';
    const f = fixture(() => bytes([Buffer.from(prefix + frame + 'event: assistant\nid: later\ndata: {"text":"later"}\n\n')]));
    expect((await readUntilCut(await f.fetch(url))).value).toBe(prefix + frame);
    expect(f.proof().cutCount).toBe(1);
  });
  it("delivers the disconnect even when upstream cancellation never settles", async () => {
    const cancellation = vi.fn(() => new Promise<void>(() => {}));
    const f = fixture(() => bytes([Buffer.from('event: assistant\nid: cut\ndata: {"text":"working"}\n\n')], cancellation));
    const observed = await Promise.race([readUntilCut(await f.fetch(url)), new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("disconnect was suppressed by cancellation")), 250); timer.unref(); })]);
    expect(observed.failure).toBeInstanceOf(Error); expect(f.proof().cutCount).toBe(1); expect(cancellation).toHaveBeenCalledTimes(1);
  });
  it("bounds individual frames without rejecting a larger chunk of valid frames", async () => {
    const prefix = ": " + "x".repeat(800_000) + "\n\n";
    const frame = 'event: assistant\nid: cursor\ndata: {"text":"' + "y".repeat(300_000) + '"}\n\n';
    const f = fixture(() => bytes([Buffer.from(prefix + frame)]));
    expect((await readUntilCut(await f.fetch(url))).value).toBe(prefix + frame); expect(f.proof().cutCount).toBe(1);
  });
  it.each([
    'id: alone\n\n: comment\n\n',
    'event: assistant\nid:\ndata: {"text":"no cursor"}\n\n',
    'event: assistant\nid: invalid\u0000id\ndata: {"text":"bad cursor"}\n\n',
    'event: assistant\nid: unfinished\ndata: {"text":"partial"}',
    'event: assistant\nid: malformed\ndata: not-json\n\n',
    'event: result\nid: terminal\ndata: {"status":"FINISHED"}\n\nevent: done\nid: done\ndata: {}\n\n',
  ])("does not invent a cut for an undispatched, malformed or terminal frame", async content => {
    const f = fixture(() => bytes([Buffer.from(content)]));
    const observed = await readUntilCut(await f.fetch(url));
    expect(observed).toEqual({ value: content, failure: undefined });
    expect(f.proof().cutCount).toBe(0); expect(gradeCursorCloudReplayFault([f.proof()], expected).passed).toBe(false);
  });
  it("delegates fetch arguments unchanged and never intercepts a different route, host or method", async () => {
    const original = vi.fn(async (_resource: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response("ordinary response"));
    const records = vi.fn();
    const wrapped = createCursorCloudReplayFaultFetch({ fetch: original as typeof fetch, digest, record: records });
    const init = { method: "POST", headers: { authorization: "Bearer private-auth-canary" }, body: "private-request-canary", redirect: "error" as const };
    await wrapped(url, init);
    expect(original.mock.calls[0]).toEqual([url, init]);
    const request = new Request(url.replace("api.cursor.com", "other.example.test"), { headers: init.headers });
    await wrapped(request); await wrapped(url + "?private-query-canary"); await wrapped(url.replace("https:", "http:"));
    expect(original.mock.calls[1]?.[0]).toBe(request); expect(records).not.toHaveBeenCalled();
  });
});

describe("Cursor Cloud replay evidence calibration", () => {
  async function goodProof() {
    const f = fixture(() => bytes([Buffer.from('event: assistant\nid: cursor\ndata: {"text":"working"}\n\n')]));
    await readUntilCut(await f.fetch(url)); await f.fetch(url, { headers: { "Last-Event-ID": "cursor" } }); return f.proof();
  }
  it.each(["missing", "no-cut", "repeated-cut", "agent", "run", "cursor", "failed-request", "not-sse", "extra-secret", "unowned", "missing-owned"])("fails closed for %s evidence", async reason => {
    const proof = await goodProof();
    if (reason === "no-cut") proof.cutCount = 0;
    if (reason === "repeated-cut") proof.cutCount = 2;
    if (reason === "agent") proof.reconnect!.agentIdSha256 = digest("foreign-agent");
    if (reason === "run") proof.reconnect!.runIdSha256 = digest("foreign-run");
    if (reason === "cursor") proof.reconnect!.lastEventIdSha256 = digest("wrong-cursor");
    if (reason === "failed-request") proof.reconnect!.httpStatus = 503;
    if (reason === "not-sse") proof.reconnect!.sseReady = false;
    if (reason === "extra-secret") Object.assign(proof, { token: "private-auth-canary" });
    const identities = reason === "unowned" ? [{ agentIdSha256: digest("foreign"), runIdSha256: digest("foreign") }]
      : reason === "missing-owned" ? [...expected, { agentIdSha256: digest("other"), runIdSha256: digest("other") }] : expected;
    expect(gradeCursorCloudReplayFault(reason === "missing" ? [] : [proof], identities).passed).toBe(false);
  });
  it("requires one cut total and distinct owned observations for every turn", async () => {
    const selected = await goodProof(), other = { agentIdSha256: digest(agent), runIdSha256: digest("other-owned-run") };
    const untouched = { schema: selected.schema, identity: other, streamRequests: 1, cutCount: 0, cut: null, reconnect: null };
    const owned = [...expected, other];
    expect(gradeCursorCloudReplayFault([selected, untouched], owned).passed).toBe(true);
    const secondCut = structuredClone(selected);
    secondCut.identity = other; Object.assign(secondCut.cut!, other); Object.assign(secondCut.reconnect!, other);
    expect(gradeCursorCloudReplayFault([selected, secondCut], owned).passed).toBe(false);
    expect(gradeCursorCloudReplayFault([selected, { ...untouched, identity: selected.identity }], owned).passed).toBe(false);
    expect(gradeCursorCloudReplayFault([selected, { ...untouched, identity: { ...other, runIdSha256: digest("foreign-run") } }], owned).passed).toBe(false);
    expect(gradeCursorCloudReplayFault([selected], owned).passed).toBe(false);
  });
});

describe("Cursor Cloud replay bundle treatment", () => {
  it("reserves exactly one cut across two real per-turn Node processes", async () => {
    const directory = await root(), bundlePath = join(directory, "proxy.cjs"), peerPath = join(directory, "peer.cjs"), evidenceDirectory = join(directory, "evidence");
    const secondRun = "run-33333333-3333-4333-8333-333333333333";
    await writeFile(peerPath, `globalThis.fetch = async (_input, init) => {
      globalThis.streamRequests = (globalThis.streamRequests ?? 0) + 1;
      if (init?.headers && new Headers(init.headers).get("Last-Event-ID") !== "shared-cursor") throw new Error("wrong resume cursor");
      return new Response('event: assistant\\nid: shared-cursor\\ndata: {"text":"private native content"}\\n\\nevent: result\\nid: terminal\\ndata: {}\\n\\n', {headers: {"content-type": "text/event-stream"}});
    };\n`);
    const original = Buffer.from(`#!/usr/bin/env node\n;(async () => {
      const target = "https://api.cursor.com/v1/agents/${agent}/runs/" + process.argv[2] + "/stream";
      let cut = false;
      try { await (await fetch(target)).text(); } catch { cut = true; }
      if (cut) await (await fetch(target, {headers: {"Last-Event-ID": "shared-cursor"}})).text();
      process.stdout.write(JSON.stringify({pid: process.pid, cut, requests: globalThis.streamRequests}));
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });\n`);
    await writeFile(bundlePath, original, { mode: 0o600 });
    await withCursorCloudReplayFault({ bundlePath, evidenceDirectory }, async manifest => {
      const execute = (runId: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--require", peerPath, bundlePath, runId], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
        let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; }); child.once("error", reject); child.once("exit", code => resolve({ code, output }));
      });
      const outcomes = await Promise.all([execute(run), execute(secondRun)]);
      expect(outcomes.map(outcome => outcome.code)).toEqual([0, 0]);
      const turns = outcomes.map(outcome => JSON.parse(outcome.output));
      expect(new Set(turns.map(turn => turn.pid)).size).toBe(2);
      expect(turns.filter(turn => turn.cut)).toHaveLength(1);
      expect(turns.map(turn => turn.requests).sort()).toEqual([1, 2]);
      const proofs = await readCursorCloudReplayFaultProofs(evidenceDirectory, manifest);
      expect(proofs).toHaveLength(2);
      const reservation = await readCursorCloudReplayFaultReservation(evidenceDirectory, manifest);
      const selected = (proofs as CursorCloudReplayFaultProof[]).find(proof => proof.cutCount === 1)!;
      expect(reservation).toMatchObject({ treatmentId: manifest.treatmentId, processId: turns.find(turn => turn.cut).pid, ...selected.identity });
      expect(gradeCursorCloudReplayFault(proofs, [...expected, { agentIdSha256: digest(agent), runIdSha256: digest(secondRun) }]).passed).toBe(true);
      expect(JSON.stringify(proofs)).not.toContain("private native content");
    });
    expect(await readFile(bundlePath)).toEqual(original);
  });
  it("runs a self-contained generated prelude, preserves shebang and restores exact bytes on failure", async () => {
    const directory = await root(), bundlePath = join(directory, "proxy.cjs"), evidenceDirectory = join(directory, "evidence");
    const original = Buffer.from(`#!/usr/bin/env node\nconst oldFetch = globalThis.fetch;\nif (oldFetch === undefined) throw new Error("missing fetch");\nprocess.stdout.write("proxy body ran");\n`);
    await writeFile(bundlePath, original, { mode: 0o700 });
    await expect(withCursorCloudReplayFault({ bundlePath, evidenceDirectory }, async manifest => {
      const treated = await readFile(bundlePath);
      expect(treated.toString().startsWith("#!/usr/bin/env node\n;")).toBe(true);
      expect(manifest.originalProxySha256).toBe(digest(original)); expect(manifest.instrumentedProxySha256).toBe(digest(treated));
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [bundlePath], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
        let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; }); child.once("error", reject); child.once("exit", code => resolve({ code, output }));
      });
      expect(result).toEqual({ code: 0, output: "proxy body ran" });
      expect(await readCursorCloudReplayFaultProofs(evidenceDirectory, manifest)).toEqual([]);
      expect(await readFile(join(evidenceDirectory, `original-proxy-${manifest.treatmentId}.cjs`))).toEqual(original);
      throw new Error("intentional acceptance failure");
    })).rejects.toThrow("intentional acceptance failure");
    expect(await readFile(bundlePath)).toEqual(original);
  });
  it("refuses double installation and refuses to overwrite another writer during restore", async () => {
    const directory = await root(), bundlePath = join(directory, "proxy.cjs"), evidenceDirectory = join(directory, "evidence");
    await writeFile(bundlePath, "process.exit(0);\n");
    const treatment = await installCursorCloudReplayFault({ bundlePath, evidenceDirectory });
    await expect(installCursorCloudReplayFault({ bundlePath, evidenceDirectory })).rejects.toThrow("already installed");
    await writeFile(bundlePath, "other writer\n");
    await expect(treatment.restore()).rejects.toThrow("refusing to overwrite"); expect(await readFile(bundlePath, "utf8")).toBe("other writer\n");
  });
  it("serializes the prelude under the same tsx loader used by the paid launcher", async () => {
    const directory = await root(), bundlePath = join(directory, "proxy.cjs"), evidenceDirectory = join(directory, "evidence");
    const original = '#!/usr/bin/env node\nprocess.stdout.write("tsx proxy ran");\n';
    await writeFile(bundlePath, original);
    const code = `import {spawnSync} from "node:child_process";
      const {withCursorCloudReplayFault} = await import(${JSON.stringify(new URL("./cursor-cloud-replay-fault.ts", import.meta.url).href)});
      await withCursorCloudReplayFault(${JSON.stringify({ bundlePath, evidenceDirectory })}, async () => {
        const result = spawnSync(process.execPath, [${JSON.stringify(bundlePath)}], {encoding: "utf8"});
        if (result.status !== 0 || result.stdout !== "tsx proxy ran") throw new Error("tsx proxy prelude failed: " + result.stderr);
      }); process.stdout.write("tsx passed");`;
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", new URL("../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).href, "--input-type=module", "--eval", code], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
      let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; }); child.once("error", reject); child.once("exit", code => resolve({ code, output }));
    });
    expect(result).toEqual({ code: 0, output: "tsx passed" }); expect(await readFile(bundlePath, "utf8")).toBe(original);
  });
});

it("the actual driver reconnects the real client with its saved cursor and deduplicates the replayed frame without creating another prompt", async () => {
  const directory = await root(), events: PrpEvent[] = [], proofs: CursorCloudReplayFaultProof[] = [];
  const nativeRun = "run-33333333-3333-4333-8333-333333333333", time = "2026-10-28T00:00:00Z";
  let nativeAgent = "", creates = 0, streams = 0;
  const requests: Array<{ path: string; headers: Headers }> = [];
  const peer: typeof fetch = async (resource, init) => {
    const path = new URL(String(resource)).pathname, headers = new Headers(init?.headers); requests.push({ path, headers });
    if (path === "/v1/agents" && init?.method === "POST") {
      creates += 1; nativeAgent = JSON.parse(String(init.body)).agentId;
      return Response.json({ agent: { id: nativeAgent, status: "ACTIVE", env: { type: "cloud" }, url: "https://cursor.com/agents/example", createdAt: time, updatedAt: time }, run: { id: nativeRun, agentId: nativeAgent, status: "RUNNING", createdAt: time, updatedAt: time } }, { status: 201 });
    }
    if (path.endsWith("/stream")) {
      streams += 1;
      const first = 'event: assistant\nid: opaque-cursor\ndata: {"text":"Working."}\n\n';
      const withheld = 'event: assistant\nid: withheld\ndata: {"text":"must be replayed"}\n\n';
      return bytes([Buffer.from(first + withheld + (streams === 1 ? "" : `event: assistant\nid: new-cursor\ndata: {"text":"Recovered."}\n\nevent: result\nid: terminal\ndata: {"runId":"${nativeRun}","status":"FINISHED"}\n\n`))]);
    }
    if (path.endsWith(nativeRun)) return Response.json({ id: nativeRun, agentId: nativeAgent, status: streams < 2 ? "RUNNING" : "FINISHED", createdAt: time, updatedAt: time });
    throw new Error("Unexpected controlled request");
  };
  const client = new CursorCloudClient({ apiKey: "private-auth-canary", fetch: createCursorCloudReplayFaultFetch({ fetch: peer, digest, record: value => proofs.push(value) }) });
  const driver = new CursorCloudDriver({ model: "explicit-model", config: { schema: "paperclip.cursor-cloud.config.v1", repos: [{ url: "https://github.com/example/disposable", startingRef: "main" }] }, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId: "session" }, runtimeDirectory: directory,
    relay: { url: "https://relay.example.test/mcp", token: "private-relay-canary", socketPath: join(directory, "mcp.sock"), expiresAt: Date.now() + 60_000 }, instructions: "Exact fixture instructions.", dynamicTools: [], dynamicToolHandler: async () => ({ success: true }), client, reconnectDelayMs: 1 });
  const session = await driver.openSession({ runId: "local-run", normalizedSessionId: "session", workingDirectory: directory });
  const pump = (async () => { for await (const event of session.events()) events.push(event); })();
  try {
    await session.startTurn({ message: { role: "user", text: "Recover this exact run." } });
    await vi.waitFor(() => expect(events.some(event => event.eventType === "turn.completed")).toBe(true));
    expect(creates).toBe(1); expect(streams).toBe(2);
    const streamRequests = requests.filter(request => request.path.endsWith("/stream"));
    expect(streamRequests[0]!.headers.has("Last-Event-ID")).toBe(false); expect(streamRequests[1]!.headers.get("Last-Event-ID")).toBe("opaque-cursor");
    expect(requests.every(request => request.headers.get("authorization") === "Bearer private-auth-canary")).toBe(true);
    expect(events.filter(event => event.eventType === "item.delta").map(event => event.payload.text)).toEqual(["Working.", "must be replayed", "Recovered."]);
    expect(events.every((event, index) => index === 0 || event.sourceSeq > events[index - 1]!.sourceSeq)).toBe(true);
    expect(gradeCursorCloudReplayFault([proofs.at(-1)!], [{ agentIdSha256: digest(nativeAgent), runIdSha256: digest(nativeRun) }]).passed).toBe(true);
    expect(JSON.stringify(proofs)).not.toContain("private-auth-canary"); expect(JSON.stringify(proofs)).not.toContain("opaque-cursor");
  } finally { await session.close({ reason: "test_cleanup" }); await pump; }
});
