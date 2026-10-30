import { createHash } from "node:crypto";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../drivers/runner-tool-bridge.js";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV5 } from "../contracts/native-execution.js";
import { canonicalNativeRuntimeContextDigest, NATIVE_RUNTIME_ASSET_SCHEMA, PAPERCLIP_EXECUTION_PROMPT, PAPERCLIP_EXECUTION_PROMPT_REVISION, nativeRuntimePromptDigest } from "../contracts/runtime-context.js";
import { executeNativeSession } from "../native-session-runtime.js";
import type { PrpEvent, PrpStructuredRunResult } from "../protocol/replay-contract.js";
import type { DurablePrpControlPlane } from "./durable-prp-control-plane.js";
import { createRunnerdCodexTransport, defaultCapabilityRunnerdBinary } from "../live/runnerd-codex-transport.js";
import { copyOwnedNodeRuntime } from "../test-support/owned-node-runtime.js";

async function privateCloudNodeCommand(root: string): Promise<string> {
  const directory = join(root, "provider-node");
  await mkdir(directory, { mode: 0o700 });
  const { executable } = await copyOwnedNodeRuntime(directory);
  // Keep Node's name so the verified launcher selects its descriptor loader.
  const command = join(directory, process.platform === "win32" ? "node.exe" : "node");
  await rename(executable, command);
  return command;
}

function buildPrivateCursorCloudProxy(proxyPath: string): void {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const builderUrl = new URL("../../scripts/build-verified-provider-entrypoints.mjs", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", [
    "import { writeFile } from 'node:fs/promises';",
    `const { bundleVerifiedProviderEntrypoints } = await import(${JSON.stringify(builderUrl)});`,
    "const item = (await bundleVerifiedProviderEntrypoints({ write: false })).find(value => value.entrypoint.name === 'cursor-cloud-app-server-proxy');",
    `await writeFile(${JSON.stringify(proxyPath)}, item.verifiedResult.outputFiles[0].contents, { mode: 0o600 });`,
  ].join("\n")], { cwd: packageRoot, timeout: 20_000, stdio: "pipe" });
}

async function currentCloudScopeHeader(runtime: string, sessionId: string): Promise<string> {
  const name = `checkpoint-${createHash("sha256").update(sessionId).digest("hex")}.json`;
  const checkpoint = JSON.parse(await readFile(join(runtime, name), "utf8"));
  expect(checkpoint.relayTurnToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `Bearer ${checkpoint.relayTurnToken}`;
}

it("settles a create rejected during real-facade Stop before cold recovery and the next run", async () => {
  const root = await mkdtemp("/tmp/cc-rejected-stop-");
  const runtime = join(root, "cloud"), stateDirectory = join(root, "session");
  const configPath = join(runtime, "config.json"), socketPath = join(root, "mcp.sock"), proxyPath = join(root, "proxy.cjs");
  const fetchLog = join(root, "fetches.jsonl"), remotePath = join(root, "remote.json");
  const createSeen = join(root, "create-seen"), stopHeld = join(root, "stop-held"), releaseStop = join(root, "release-stop");
  const releaseCreate = join(root, "release-create"), rejected = join(root, "rejected");
  const normalizedSessionId = "cloud-rejected-stop-session";
  buildPrivateCursorCloudProxy(proxyPath);
  const providerNodeCommand = await privateCloudNodeCommand(root);
  const prelude = Buffer.from(`;(() => {
    const assert = require('node:assert/strict'), fs = require('node:fs'), fsp = require('node:fs/promises');
    const paths = ${JSON.stringify({ createSeen, stopHeld, releaseStop, releaseCreate, rejected, fetchLog, remotePath })};
    const wait = async path => { const end = Date.now() + 15000; while (!fs.existsSync(path)) { assert.ok(Date.now() < end, 'controlled gate expired'); await new Promise(resolve => setTimeout(resolve, 5)); } };
    const rename = fsp.rename; let held = false;
    fsp.rename = async function(from, to) {
      await rename.call(this, from, to);
      if (!held && /checkpoint-[a-f0-9]{64}\\.json$/.test(String(to)) && JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'stopping') {
        held = true; fs.writeFileSync(paths.stopHeld, 'held'); await wait(paths.releaseStop);
      }
    };
    const now = '2026-10-30T00:00:00Z', json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    globalThis.fetch = async (input, init = {}) => {
      const target = new URL(String(input)), method = init.method ?? 'GET'; assert.equal(target.origin, 'https://api.cursor.com');
      fs.appendFileSync(paths.fetchLog, JSON.stringify({ method, path: target.pathname, pid: process.pid }) + '\\n');
      if (method === 'POST' && target.pathname === '/v1/agents') {
        if (!fs.existsSync(paths.rejected)) {
          fs.writeFileSync(paths.createSeen, 'seen'); await wait(paths.releaseCreate); fs.writeFileSync(paths.rejected, 'rejected');
          return json({ message: 'controlled definitive rejection' }, 422);
        }
        const body = JSON.parse(String(init.body));
        const run = { id: 'run-33333333-3333-4333-8333-333333333333', agentId: body.agentId, status: 'RUNNING', createdAt: now, updatedAt: now };
        fs.writeFileSync(paths.remotePath, JSON.stringify(run));
        return json({ agent: { id: body.agentId, status: 'ACTIVE', env: { type: 'cloud' }, url: 'https://cursor.com/agents/' + body.agentId, createdAt: now, updatedAt: now, latestRunId: run.id }, run });
      }
      assert.ok(fs.existsSync(paths.remotePath), 'rejected create must not be reconciled as accepted work');
      const run = JSON.parse(fs.readFileSync(paths.remotePath, 'utf8'));
      const runPath = '/v1/agents/' + run.agentId + '/runs/' + run.id;
      if (method === 'GET' && target.pathname === runPath + '/stream') return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (method === 'POST' && target.pathname === runPath + '/cancel') { run.status = 'CANCELLED'; fs.writeFileSync(paths.remotePath, JSON.stringify(run)); return json({ id: run.id }); }
      if (method === 'GET' && target.pathname === runPath) return json(run);
      throw new Error('Unexpected controlled Cloud request');
    };
  })();\n`);
  const built = await readFile(proxyPath), firstLine = built.indexOf(10) + 1;
  await writeFile(proxyPath, Buffer.concat([built.subarray(0, firstLine), prelude, built.subarray(firstLine)]), { mode: 0o600 });
  await mkdir(runtime, { mode: 0o700 });
  const cursorCloud = { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/repo" }] };
  await writeFile(configPath, JSON.stringify({ ...cursorCloud, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId } }), { mode: 0o600 });
  const identity = { runnerInstanceId: "runner-cloud-rejected", environmentLeaseId: "lease-cloud-rejected", runId: "00000000-0000-4000-8000-000000000781", normalizedSessionId, turnId: "turn-rejected", itemId: "item-rejected" };
  const environment = { PATH: process.env.PATH, CURSOR_API_KEY: "synthetic-key", PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath,
    PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: join(runtime, "artifacts"), PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath,
    PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: "synthetic-token", PAPERCLIP_CURSOR_CLOUD_RELAY_URL: "https://relay.example.test/mcp",
    PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 60_000) };
  const options = { provider: "cursor_cloud" as const, cursorCloud, stateDirectory, runnerBinary: defaultCapabilityRunnerdBinary(), providerNodeCommand,
    cursorCloudProxyPath: proxyPath, cursorCloudProxySha256: `sha256:${createHash("sha256").update(await readFile(proxyPath)).digest("hex")}`,
    lifecyclePolicy: { mode: "per_turn" as const }, environment };
  const first = createRunnerdCodexTransport({ ...options, prpIdentity: identity }), bundles = [first];
  let stop: Promise<unknown> | undefined;
  try {
    await first.transport.request("thread/start", { cwd: root, model: "pinned-model", baseInstructions: "Only the assigned task.", dynamicTools: [] });
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Controlled rejected task" }] });
    await vi.waitFor(async () => expect(await readFile(createSeen, "utf8")).toBe("seen"));
    const checkpointPath = join(runtime, `checkpoint-${createHash("sha256").update(normalizedSessionId).digest("hex")}.json`);
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({ phase: "creating", pendingOperation: "create_agent" });
    let stopDone = false;
    stop = first.transport.request("turn/interrupt", {}).finally(() => { stopDone = true; });
    await vi.waitFor(async () => expect(await readFile(stopHeld, "utf8")).toBe("held"));
    await writeFile(releaseCreate, "release");
    await vi.waitFor(async () => expect(await readFile(rejected, "utf8")).toBe("rejected"));
    expect(stopDone).toBe(false);
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({ phase: "stopping", pendingOperation: "create_agent" });
    await writeFile(releaseStop, "release"); await stop;
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({ phase: "idle", terminalStatus: "REJECTED", pendingOperation: null, requestedAgentId: null });
    expect((await readFile(fetchLog, "utf8")).trim().split("\n").map(line => JSON.parse(line))).toMatchObject([{ method: "POST", path: "/v1/agents" }]);
    await first.transport.close(); expect(first.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    const stopped = JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8"));
    expect(stopped).toMatchObject({ lifecycle: "prepared", providerTerminationReceipt: { remoteStopped: true, remoteRunId: null } });
    const recovered = createRunnerdCodexTransport({ ...options, prpIdentity: identity, resumeProviderSession: { driverSessionId: normalizedSessionId, providerSessionId: normalizedSessionId } }); bundles.push(recovered);
    await expect(recovered.transport.request("thread/read", {})).resolves.toMatchObject({ thread: { id: normalizedSessionId } });
    expect(JSON.parse(await readFile(checkpointPath, "utf8"))).toMatchObject({ phase: "idle", terminalStatus: "REJECTED", pendingOperation: null });
    await recovered.transport.close(); expect(recovered.evidence().runnerExited).toBe(true);
    const next = createRunnerdCodexTransport({ ...options, prpIdentity: { ...identity, runId: "00000000-0000-4000-8000-000000000782", turnId: "turn-next", itemId: "item-next" }, baseInstructions: "Only the next assigned task." }); bundles.push(next);
    await next.transport.request("thread/read", {});
    await next.transport.request("turn/start", { input: [{ type: "text", text: "Next admitted task" }] });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(remotePath, "utf8"))).toMatchObject({ status: "RUNNING" }));
    await next.transport.request("turn/interrupt", {}); await next.transport.close();
    expect(next.evidence().runnerExited).toBe(true);
    expect(JSON.parse(await readFile(remotePath, "utf8"))).toMatchObject({ status: "CANCELLED" });
    const creates = (await readFile(fetchLog, "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(call => call.method === "POST" && call.path === "/v1/agents");
    expect(creates).toHaveLength(2); expect(creates[1].pid).not.toBe(creates[0].pid);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    await writeFile(releaseCreate, "release"); await writeFile(releaseStop, "release");
    await stop?.catch(() => undefined);
    for (const bundle of bundles) await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it("opens and closes the real Cloud facade without a provider prompt", async () => {
  const root = await mkdtemp("/tmp/cc-runner-launch-");
  const runtime = join(root, "cloud");
  const configPath = join(runtime, "config.json");
  const socketPath = join(root, "mcp.sock");
  const fetchLog = join(root, "unexpected-fetches.jsonl");
  const proxyPath = join(root, "cloud-proxy.cjs");
  buildPrivateCursorCloudProxy(proxyPath);
  const providerNodeCommand = await privateCloudNodeCommand(root);
  const builtProxy = await readFile(proxyPath);
  const firstLine = builtProxy.indexOf(10) + 1;
  const guard = Buffer.from(`globalThis.fetch = async () => { require("node:fs").appendFileSync(${JSON.stringify(fetchLog)}, "unexpected fetch\\n", { mode: 0o600 }); throw new Error("Cloud launch preflight forbids provider requests"); };\n`);
  await writeFile(proxyPath, Buffer.concat([builtProxy.subarray(0, firstLine), guard, builtProxy.subarray(firstLine)]), { mode: 0o600 });
  await mkdir(runtime, { mode: 0o700 });
  const normalizedSessionId = "cloud-launch-session";
  const cursorCloud = { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/repo" }] };
  await writeFile(configPath, JSON.stringify({ ...cursorCloud, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId } }), { mode: 0o600 });
  const bundle = createRunnerdCodexTransport({
    provider: "cursor_cloud", cursorCloud,
    stateDirectory: join(root, "runner-session"),
    runnerBinary: defaultCapabilityRunnerdBinary(), providerNodeCommand,
    cursorCloudProxyPath: proxyPath,
    cursorCloudProxySha256: `sha256:${createHash("sha256").update(await readFile(proxyPath)).digest("hex")}`,
    lifecyclePolicy: { mode: "per_turn" },
    prpIdentity: { runnerInstanceId: "runner-cloud-launch", environmentLeaseId: "lease-cloud-launch",
      runId: "00000000-0000-4000-8000-000000000761", normalizedSessionId, turnId: "turn-cloud-launch", itemId: "item-cloud-launch" },
    environment: {
      PATH: process.env.PATH,
      CURSOR_API_KEY: "synthetic-cloud-launch-key",
      PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath,
      PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: join(runtime, "artifacts"),
      PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath,
      PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: "synthetic-cloud-relay-token",
      PAPERCLIP_CURSOR_CLOUD_RELAY_URL: "https://relay.example.test/mcp/native-runs/00000000-0000-4000-8000-000000000761",
      PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 60_000),
    },
  });
  try {
    await expect(bundle.transport.request("thread/start", { cwd: root, model: "explicit-model", baseInstructions: "Do only the assigned task.", dynamicTools: [] }))
      .resolves.toMatchObject({ thread: { id: normalizedSessionId } });
    expect((await stat(socketPath)).isSocket()).toBe(true);
    const checkpointName = (await readdir(runtime)).find(name => /^checkpoint-[a-f0-9]{64}\.json$/u.test(name));
    expect(checkpointName).toBeDefined();
    const checkpoint = JSON.parse(await readFile(join(runtime, checkpointName!), "utf8"));
    expect(checkpoint).toMatchObject({ phase: "idle", agentId: null, runId: null, pendingOperation: null });
    await bundle.transport.close();
    expect(bundle.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    await expect(stat(fetchLog)).rejects.toHaveProperty("code", "ENOENT");
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("preserves native Cloud tool identity and redacted output through the real Rust facade", async () => {
  const root = await mkdtemp("/tmp/cc-tool-facade-");
  const runtime = join(root, "cloud");
  const configPath = join(runtime, "config.json");
  const socketPath = join(root, "mcp.sock");
  const proxyPath = join(root, "cloud-proxy.cjs");
  const fetchLog = join(root, "controlled-fetches.jsonl");
  buildPrivateCursorCloudProxy(proxyPath);
  const providerNodeCommand = await privateCloudNodeCommand(root);
  const runId = "run-22222222-2222-4222-8222-222222222222";
  const fixture = Buffer.from(`;(() => {
    const assert = require('node:assert/strict'), fs = require('node:fs');
    let agentId = '', status = 'RUNNING';
    const now = '2026-10-28T00:00:00Z', runId = ${JSON.stringify(runId)};
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const run = () => ({ id: runId, agentId, status, createdAt: now, updatedAt: now });
    globalThis.fetch = async (input, init = {}) => {
      const target = new URL(String(input)); assert.equal(target.origin, 'https://api.cursor.com');
      const path = target.pathname, method = init.method ?? 'GET';
      fs.appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ method, path }) + '\\n', { mode: 0o600 });
      if (path === '/v1/agents' && method === 'POST') {
        agentId = JSON.parse(String(init.body)).agentId;
        return json({ agent: { id: agentId, status: 'ACTIVE', env: { type: 'cloud' }, url: 'https://cursor.com/agents/' + agentId, createdAt: now, updatedAt: now, latestRunId: runId }, run: run() });
      }
      assert.equal(path.startsWith('/v1/agents/' + agentId + '/runs/' + runId), true);
      if (path.endsWith('/stream') && method === 'GET') return new Response(new ReadableStream({ start(controller) {
        const args = { toolCallId: 'synthetic-private-argument' };
        const result = { error: { message: 'Discovery failed synthetic-cloud-launch-key synthetic-cloud-relay-token' } };
        for (const [index, state] of ['running', 'error'].entries()) controller.enqueue(new TextEncoder().encode('id: ' + (index + 1) + '\\nevent: tool_call\\ndata: ' + JSON.stringify({ callId: 'cloud-native-tool', name: 'get_mcp_tools', status: state, args, result }) + '\\n\\n'));
        init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/cancel') && method === 'POST') { status = 'CANCELLED'; return json({ id: runId }); }
      if (path.endsWith('/' + runId) && method === 'GET') return json(run());
      throw new Error('Unexpected controlled Cloud request');
    };
  })();\n`);
  const builtProxy = await readFile(proxyPath);
  const firstLine = builtProxy.indexOf(10) + 1;
  await writeFile(proxyPath, Buffer.concat([builtProxy.subarray(0, firstLine), fixture, builtProxy.subarray(firstLine)]), { mode: 0o600 });
  await mkdir(runtime, { mode: 0o700 });
  const normalizedSessionId = "cloud-tool-facade-session";
  const cursorCloud = { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/repo" }] };
  await writeFile(configPath, JSON.stringify({ ...cursorCloud, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId } }), { mode: 0o600 });
  let authority: DurablePrpControlPlane | undefined;
  const bundle = createRunnerdCodexTransport({
    provider: "cursor_cloud", cursorCloud, stateDirectory: join(root, "runner-session"),
    runnerBinary: defaultCapabilityRunnerdBinary(), providerNodeCommand, cursorCloudProxyPath: proxyPath,
    cursorCloudProxySha256: `sha256:${createHash("sha256").update(await readFile(proxyPath)).digest("hex")}`,
    lifecyclePolicy: { mode: "per_turn" },
    prpIdentity: { runnerInstanceId: "runner-cloud-tool", environmentLeaseId: "lease-cloud-tool",
      runId: "00000000-0000-4000-8000-000000000762", normalizedSessionId, turnId: "turn-cloud-tool", itemId: "item-cloud-tool" },
    environment: {
      PATH: process.env.PATH, CURSOR_API_KEY: "synthetic-cloud-launch-key",
      PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath, PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: join(runtime, "artifacts"),
      PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath, PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: "synthetic-cloud-relay-token",
      PAPERCLIP_CURSOR_CLOUD_RELAY_URL: "https://relay.example.test/mcp", PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 60_000),
    },
    controlPlaneRegistration: async core => { authority = core; await core.start(); return { release: () => undefined }; },
  });
  const tools = (): Array<Record<string, unknown>> => authority!.store.state.committedEvents.filter(event => event.eventType.startsWith("tool.execution.")).map(event => ({
    eventType: event.eventType, ...((event.envelope.payload as Record<string, unknown>).payload as Record<string, unknown>),
  }));
  try {
    const opened = await bundle.transport.request("thread/start", { cwd: root, model: "explicit-model", baseInstructions: "Use the assigned tools.", dynamicTools: [] });
    await bundle.transport.request("turn/start", { threadId: (opened.thread as { id: string }).id, input: [{ type: "text", text: "Use the tool." }] });
    await vi.waitFor(() => expect(tools()).toHaveLength(2), { timeout: 10_000 });
    expect(tools()).toMatchObject([
      { eventType: "tool.execution.started", executionId: "cloud-native-tool", transport: "builtin", name: "get_mcp_tools", status: "running", output: expect.stringContaining("Discovery failed [redacted] [redacted]") },
      { eventType: "tool.execution.completed", executionId: "cloud-native-tool", transport: "builtin", name: "get_mcp_tools", status: "failed", output: expect.stringContaining("Discovery failed [redacted] [redacted]") },
    ]);
    for (const tool of tools()) {
      expect(JSON.parse(String(tool.output))).toEqual({ error: { message: "Discovery failed [redacted] [redacted]" } });
      expect(tool).not.toHaveProperty("arguments");
      expect(JSON.stringify(tool)).not.toContain("synthetic-private-argument");
    }
    await bundle.transport.close();
    expect(bundle.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    const calls = (await readFile(fetchLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.path === "/v1/agents" && call.method === "POST")).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/cancel") && call.method === "POST")).toHaveLength(1);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await authority?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

async function cloudQuestionHandoff(terminalDelayMs: number, governed: boolean, planning = false) {
  const root = await mkdtemp("/tmp/cc-question-");
  const runtime = join(root, "cloud");
  const configPath = join(runtime, "config.json");
  const socketPath = join(root, "mcp.sock");
  const proxyPath = join(root, "cloud-proxy.cjs");
  const fetchLog = join(root, "controlled-fetches.jsonl");
  buildPrivateCursorCloudProxy(proxyPath);
  const providerNodeCommand = await privateCloudNodeCommand(root);
  const runId = "run-22222222-2222-4222-8222-222222222222";
  const fixture = Buffer.from(`;(() => {
    const assert = require('node:assert/strict'), fs = require('node:fs');
    let agentId = '', status = 'RUNNING';
    const now = '2026-10-28T00:00:00Z', runId = ${JSON.stringify(runId)};
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const run = () => ({ id: runId, agentId, status, createdAt: now, updatedAt: now });
    globalThis.fetch = async (input, init = {}) => {
      const target = new URL(String(input)); assert.equal(target.origin, 'https://api.cursor.com');
      const path = target.pathname, method = init.method ?? 'GET';
      fs.appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ method, path }) + '\\n', { mode: 0o600 });
      if (path === '/v1/agents' && method === 'POST') {
        if (${planning}) {
          const body = JSON.parse(String(init.body));
          assert.equal(body.mode, 'agent');
          const envelope = JSON.parse(body.prompt.text.split('\\n\\nPaperclip task:\\n').at(-1));
          assert.equal(envelope.executionMode, 'plan');
          assert.equal(envelope.task.workMode, 'planning');
          assert.equal(envelope.planningContext.baseRevisionId, 'plan-revision-3');
          assert.equal(envelope.planningContext.markdown, '# Pinned canonical plan');
        }
        agentId = JSON.parse(String(init.body)).agentId;
        return json({ agent: { id: agentId, status: 'ACTIVE', env: { type: 'cloud' }, url: 'https://cursor.com/agents/' + agentId, createdAt: now, updatedAt: now, latestRunId: runId }, run: run() });
      }
      assert.equal(path.startsWith('/v1/agents/' + agentId + '/runs/' + runId), true);
      if (path.endsWith('/stream') && method === 'GET') return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/cancel') && method === 'POST') { await new Promise(resolve => setTimeout(resolve, ${terminalDelayMs})); status = 'FINISHED'; return json({ id: runId }); }
      if (path.endsWith('/' + runId) && method === 'GET') return json(run());
      throw new Error('Unexpected controlled Cloud request');
    };
  })();\n`);
  const builtProxy = await readFile(proxyPath);
  const firstLine = builtProxy.indexOf(10) + 1;
  await writeFile(proxyPath, Buffer.concat([builtProxy.subarray(0, firstLine), fixture, builtProxy.subarray(firstLine)]), { mode: 0o600 });
  await mkdir(runtime, { mode: 0o700 });
  const normalizedSessionId = "cloud-question-session";
  const cursorCloud = { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/repo" }] };
  await writeFile(configPath, JSON.stringify({ ...cursorCloud, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId } }), { mode: 0o600 });
  let authority: DurablePrpControlPlane | undefined;
  const bundle = createRunnerdCodexTransport({
    provider: "cursor_cloud", cursorCloud, stateDirectory: join(root, "runner-session"),
    runnerBinary: defaultCapabilityRunnerdBinary(), providerNodeCommand, cursorCloudProxyPath: proxyPath,
    cursorCloudProxySha256: `sha256:${createHash("sha256").update(await readFile(proxyPath)).digest("hex")}`,
    lifecyclePolicy: { mode: "per_turn" },
    prpIdentity: { runnerInstanceId: "runner-cloud-question", environmentLeaseId: "lease-cloud-question",
      runId: "00000000-0000-4000-8000-000000000763", normalizedSessionId, turnId: "turn-cloud-question", itemId: "item-cloud-question" },
    environment: {
      PATH: process.env.PATH, CURSOR_API_KEY: "synthetic-cloud-launch-key",
      PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath, PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: join(runtime, "artifacts"),
      PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath, PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: "synthetic-cloud-relay-token",
      PAPERCLIP_CURSOR_CLOUD_RELAY_URL: "https://relay.example.test/mcp", PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 60_000),
    },
    controlPlaneRegistration: async core => { authority = core; await core.start(); return { release: () => undefined }; },
  });
  const questionApplied = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ status: "applied", questionId: "question-controlled" }) }] }));
  bundle.transport.setServerRequestHandler(questionApplied);
  const mcp = async (body: Record<string, unknown>, sessionId?: string): Promise<{ sessionId?: string; value: any }> => {
    const scopeHeader = await currentCloudScopeHeader(runtime, normalizedSessionId);
    return new Promise((accept, reject) => {
    const req = request({ socketPath, path: "/mcp", method: "POST", headers: { Authorization: "Bearer synthetic-cloud-relay-token", [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: scopeHeader, "content-type": "application/json", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) } }, response => {
      let text = "";
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => accept({ sessionId: response.headers["mcp-session-id"] as string | undefined, value: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", ...body }));
    });
  };
  try {
    if (governed) {
      await writeFile(join(root, "AGENTS.md"), "Keep assigned instructions.");
      const digest = "0".repeat(64);
      const context = {
        prompt: { revision: PAPERCLIP_EXECUTION_PROMPT_REVISION, text: PAPERCLIP_EXECUTION_PROMPT, digest: nativeRuntimePromptDigest() },
        instructions: { entryPath: "AGENTS.md", bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: root, fileCount: 1, totalBytes: 27 } },
        skills: [], mcp: { assignmentSetId: "none", digest, bindingId: null },
      };
      const input: NativeExecutionInputV5 = {
        schema: "paperclip.native-execution-input.v5", executionMode: planning ? "plan" : "default",
        planningContext: planning ? { documentId: "plan-document", baseRevisionId: "plan-revision-3", baseRevisionNumber: 3,
          markdown: "# Pinned canonical plan", sha256: createHash("sha256").update("# Pinned canonical plan").digest("hex"), reviewContext: { feedback: "Keep the requested scope" } } : null,
        binding: { companyId: "company", agentId: "agent", issueId: "issue", runId: "00000000-0000-4000-8000-000000000763", executionWorkspaceId: "workspace" },
        task: { identifier: "CLOUD-QUESTION", title: "Ask the assigned question", description: null, prompt: "Ask before proceeding.", workMode: planning ? "planning" : "standard" },
        workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
        session: { normalizedSessionId, driverKind: "cursor_cloud_api", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
        provider: { kind: "cursor_cloud", model: "explicit-model", cursorCloud },
        runtimeContext: { ...context, aggregateDigest: canonicalNativeRuntimeContextDigest(context) },
        completionContract: { id: "contract", sha256: digest, schemaVersion: "paperclip.completion-contract.v1", contract: { revision: "1", objective: "Ask before proceeding.", criteria: [{ id: "question", requirement: "Request the response." }] } },
        interactionResponses: [], credentialBindings: [],
      };
      const yielded: PrpStructuredRunResult = {
        schema: "paperclip.run_result.v1", reportedWorkDisposition: "yielded", summary: "Waiting for the requested response.",
        completionClaim: { contractRevision: "1", objectiveSatisfied: false, criteria: [{ criterionId: "question", status: "unknown", evidenceRefs: ["interaction:pending"] }], remainingWork: [{ description: "Resume after the response.", blocksCompletion: true }] },
        evidence: [{ ref: "interaction:pending" }], verification: [], attentionRequests: [], artifacts: [{ kind: "issue_thread_interaction", ref: "interaction:pending" }],
        continuation: { kind: "response_wake", summary: "Resume from the answer.", idempotencyKey: "interaction-response:pending" },
      };
      const backend = createRunnerdNativeSessionBackend(input, { runnerInstanceId: "runner-cloud-question", transportFactory: () => bundle.transport,
        dynamicTools: [{ name: "request_human_input", description: "Ask the user a required question.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
        dynamicToolHandler: questionApplied,
      });
      const history: PrpEvent[] = [];
      const completeRun = vi.fn(async () => undefined);
      const execution = executeNativeSession({ input, backend, runnerInstanceId: "runner-cloud-question", controlPlaneInstanceId: "control-cloud-question", timeoutMs: 120_000,
        controlPlane: {
          async openRun() {}, async checkpointSession() {}, completeRun,
          async appendEvent(event) { history.push(event); return { cursor: history.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" }; },
          async replayEvents(replay) { return { events: history.filter(event => event.sourceInstanceId === replay.sourceInstanceId && event.sourceSeq > replay.afterSourceSeq), highestContiguousSourceSeq: 0 }; },
        },
        resolveGovernedWait: ({ event }) => event.eventType === "item.completed" && event.payload.kind === "dynamicToolCall" ? yielded : null,
      });
      void execution.catch(() => undefined);
      await Promise.race([execution, vi.waitFor(() => expect(authority?.store.state.commands.some(command => command.type === "turn.start" && command.status === "completed")).toBe(true), { timeout: 10_000 })]);
      const initialized = await mcp({ id: 0, method: "initialize" });
      const response = await mcp({ id: 1, method: "tools/call", params: { name: "request_human_input", arguments: {} } }, initialized.sessionId);
      expect(response.value.result.isError).not.toBe(true);
      await expect(execution).resolves.toMatchObject({ result: yielded });
      expect(completeRun).toHaveBeenCalledOnce();
      expect(history.some(event => event.eventType === "turn.interrupted")).toBe(true);
    } else {
    const opened = await bundle.transport.request("thread/start", { cwd: root, model: "explicit-model", baseInstructions: "Ask the assigned question.", dynamicTools: [{ name: "request_human_input", description: "Ask the user a required question.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
    const threadId = (opened.thread as { id: string }).id;
    const started = await bundle.transport.request("turn/start", { threadId, input: [{ type: "text", text: "Ask before proceeding." }] });
    const initialized = await mcp({ id: 0, method: "initialize" });
    const response = await mcp({ id: 1, method: "tools/call", params: { name: "request_human_input", arguments: {} } }, initialized.sessionId);
    expect(response.value.result.isError).not.toBe(true);
    expect(JSON.stringify(response.value)).toContain("question-controlled");
    expect(questionApplied).toHaveBeenCalledOnce();
    await bundle.transport.request("turn/interrupt", { threadId, turnId: (started.turn as { id: string }).id });
    await vi.waitFor(() => expect(authority!.store.state.committedEvents.some(event => event.eventType === "turn.interrupted")).toBe(true), { timeout: 5_000 });
    expect(authority!.store.state.commands.some(command => command.type === "turn.stop")).toBe(false);
    expect(authority!.store.state.committedEvents.filter(event => ["turn.interrupted", "turn.completed", "turn.failed"].includes(event.eventType))).toHaveLength(1);
    expect(authority!.store.state.commands.filter(command => command.type === "semantic_tool.result")).toHaveLength(1);
    }
    await bundle.transport.close();
    expect(bundle.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    const calls = (await readFile(fetchLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.path === "/v1/agents" && call.method === "POST")).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/cancel") && call.method === "POST")).toHaveLength(1);
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await authority?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

it.each([0, 18_000])("delivers an applied Cloud question and courtesy-interrupt terminal without Stop (%ims)", async terminalDelayMs => {
  await cloudQuestionHandoff(terminalDelayMs, false);
}, 40_000);

it.each([0, 18_000])("settles a governed Cloud question after its allowed cancellation latency (%ims)", async terminalDelayMs => {
  await cloudQuestionHandoff(terminalDelayMs, true);
}, 45_000);

it("preserves semantic planning and its pinned revision through the real Rust Cloud default harness", async () => {
  await cloudQuestionHandoff(0, true, true);
}, 30_000);

async function cloudColdAuthorityRotation(instructions: string, validShutdown = true) {
  const root = await mkdtemp("/tmp/cc-cold-rotation-");
  const runtime = join(root, "cloud");
  const stateDirectory = join(root, "session");
  const configPath = join(runtime, "config.json");
  const socketPath = join(root, "mcp.sock");
  const proxyPath = join(root, "cloud-proxy.cjs");
  const fetchLog = join(root, "fetches.jsonl");
  const remoteStatePath = join(root, "remote.json");
  buildPrivateCursorCloudProxy(proxyPath);
  const providerNodeCommand = await privateCloudNodeCommand(root);
  const fixture = Buffer.from(`;(() => {
    const assert = require('node:assert/strict'), fs = require('node:fs');
    if (!${JSON.stringify(validShutdown)}) {
      const write = process.stdout.write;
      process.stdout.write = function(chunk, ...args) {
        try { const frame = JSON.parse(String(chunk)); if (frame.result?.remoteStopped === true) { frame.result.remoteStopped = false; chunk = JSON.stringify(frame) + '\\n'; } } catch {}
        return write.call(this, chunk, ...args);
      };
    }
    const path = ${JSON.stringify(remoteStatePath)}, now = '2026-10-29T00:00:00Z';
    const read = () => fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, 'utf8')) : { agentId: null, runs: [] };
    const write = state => fs.writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    const agent = state => ({ id: state.agentId, status: 'ACTIVE', env: { type: 'cloud' }, url: 'https://cursor.com/agents/' + state.agentId, createdAt: now, updatedAt: now, latestRunId: state.runs.at(-1).id });
    globalThis.fetch = async (input, init = {}) => {
      const target = new URL(String(input)); assert.equal(target.origin, 'https://api.cursor.com');
      const method = init.method ?? 'GET', state = read();
      const body = init.body ? JSON.parse(String(init.body)) : null;
      fs.appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ method, path: target.pathname, body, pid: process.pid }) + '\\n', { mode: 0o600 });
      if (method === 'POST' && (target.pathname === '/v1/agents' || target.pathname === '/v1/agents/' + state.agentId + '/runs')) {
        if (target.pathname === '/v1/agents') { assert.equal(state.agentId, null); state.agentId = body.agentId; }
        const run = { id: 'run-' + String(state.runs.length + 1).padStart(8, '0') + '-2222-4222-8222-222222222222', agentId: state.agentId, status: 'RUNNING', createdAt: now, updatedAt: now };
        state.runs.push(run); write(state); return json({ agent: agent(state), run });
      }
      if (method === 'GET' && target.pathname === '/v1/agents/' + state.agentId) return json(agent(state));
      const run = state.runs.find(run => target.pathname.startsWith('/v1/agents/' + state.agentId + '/runs/' + run.id));
      assert.ok(run, 'request must bind the retained Agent and an exact Run');
      if (target.pathname.endsWith('/stream') && method === 'GET') return new Response(new ReadableStream({ start(controller) {
        init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      if (target.pathname.endsWith('/cancel') && method === 'POST') { run.status = 'FINISHED'; write(state); return json({ id: run.id }); }
      if (target.pathname.endsWith('/' + run.id) && method === 'GET') return json(run);
      throw new Error('Unexpected controlled Cloud request');
    };
  })();\n`);
  const builtProxy = await readFile(proxyPath);
  const firstLine = builtProxy.indexOf(10) + 1;
  await writeFile(proxyPath, Buffer.concat([builtProxy.subarray(0, firstLine), fixture, builtProxy.subarray(firstLine)]), { mode: 0o600 });
  await mkdir(runtime, { mode: 0o700 });
  const normalizedSessionId = "cloud-cold-session";
  const cursorCloud = { schema: "paperclip.cursor-cloud.config.v1" as const, repos: [{ url: "https://github.com/example/repo" }] };
  await writeFile(configPath, JSON.stringify({ ...cursorCloud, binding: { companyId: "company", agentId: "agent", issueId: "issue", normalizedSessionId } }), { mode: 0o600 });
  const identity = { runnerInstanceId: "runner-cloud-cold", environmentLeaseId: "lease-cloud-cold", runId: "00000000-0000-4000-8000-000000000771", normalizedSessionId, turnId: "turn-first", itemId: "item-first" };
  const nextIdentity = { ...identity, runId: "00000000-0000-4000-8000-000000000772", turnId: "turn-second", itemId: "item-second" };
  const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object", properties: {}, additionalProperties: false } });
  const environment = (token: string, runId: string) => ({ PATH: process.env.PATH, CURSOR_API_KEY: "synthetic-key",
    PAPERCLIP_CURSOR_CLOUD_CONFIG_PATH: configPath, PAPERCLIP_CURSOR_CLOUD_ARTIFACT_ROOT: join(runtime, "artifacts"),
    PAPERCLIP_CURSOR_CLOUD_RELAY_SOCKET_PATH: socketPath, PAPERCLIP_CURSOR_CLOUD_RELAY_TOKEN: token,
    PAPERCLIP_CURSOR_CLOUD_RELAY_URL: `https://relay.example.test/mcp/native-runs/${runId}`, PAPERCLIP_CURSOR_CLOUD_RELAY_EXPIRES_AT: String(Date.now() + 60_000) });
  const options = { provider: "cursor_cloud" as const, cursorCloud, stateDirectory, runnerBinary: defaultCapabilityRunnerdBinary(), providerNodeCommand,
    cursorCloudProxyPath: proxyPath, cursorCloudProxySha256: `sha256:${createHash("sha256").update(await readFile(proxyPath)).digest("hex")}`,
    lifecyclePolicy: { mode: "per_turn" as const } };
  const mcp = async (token: string, body: Record<string, unknown>, sessionId?: string, priorScopeHeader?: string): Promise<{ status: number; sessionId?: string; value: any }> => {
    const scopeHeader = priorScopeHeader ?? await currentCloudScopeHeader(runtime, normalizedSessionId);
    return new Promise((accept, reject) => {
    const req = request({ socketPath, path: "/mcp", method: "POST", headers: { Authorization: `Bearer ${token}`, [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: scopeHeader, "content-type": "application/json", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) } }, response => {
      let text = ""; response.on("data", chunk => { text += chunk; });
      response.on("end", () => {
        try { accept({ status: response.statusCode!, sessionId: response.headers["mcp-session-id"] as string | undefined, value: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    req.on("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", ...body }));
    });
  };
  const first = createRunnerdCodexTransport({ ...options, prpIdentity: identity, environment: environment("token-first", identity.runId) });
  const bundles = [first];
  let secondAuthority: DurablePrpControlPlane | undefined;
  try {
    await first.transport.request("thread/start", { cwd: root, model: "pinned-model", baseInstructions: "FIRST instruction grant", dynamicTools: [tool("first_tool")] });
    await first.transport.request("turn/start", { input: [{ type: "text", text: "Ask before proceeding." }] });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(remoteStatePath, "utf8")).runs).toHaveLength(1));
    const firstScopeHeader = await currentCloudScopeHeader(runtime, normalizedSessionId);
    await first.transport.request("turn/interrupt", {});
    for await (const event of first.transport.notifications()) if (event.method === "turn/completed") break;
    if (!validShutdown) {
      await first.transport.close();
      const unconfirmed = JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8"));
      expect(unconfirmed.lifecycle).not.toBe("prepared");
      expect(unconfirmed).not.toHaveProperty("providerTerminationReceipt");
      expect(first.evidence().runnerExited).toBe(true);
      await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
      return;
    }
    await first.transport.close();
    expect(first.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    const sameAuthority = createRunnerdCodexTransport({ ...options, prpIdentity: identity,
      environment: environment("token-first", identity.runId), baseInstructions: "Must not replace same-authority instructions",
      resumeProviderSession: { driverSessionId: normalizedSessionId, providerSessionId: normalizedSessionId } });
    bundles.push(sameAuthority);
    await expect(sameAuthority.transport.request("thread/read", {})).resolves.toMatchObject({ thread: { id: normalizedSessionId } });
    expect(JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8")).config.instructions).toBe("FIRST instruction grant");
    const sameControl = JSON.parse(await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"), "utf8"));
    expect(sameControl.runAttachTemplate.provider.instructions).toBe("FIRST instruction grant");
    expect(sameControl.commands.some((command: { type: string }) => command.type === "run.attach")).toBe(false);
    expect(JSON.parse(await readFile(remoteStatePath, "utf8")).runs).toHaveLength(1);
    await sameAuthority.transport.close();
    expect(sameAuthority.evidence().runnerExited).toBe(true);
    const priorRunnerBytes = await readFile(join(stateDirectory, "runner", "runner-state.json"));
    const priorCoreBytes = await readFile(join(stateDirectory, "control-plane", "control-plane-state.json"));
    const stopped = JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8"));
    expect(stopped.lifecycle).toBe("prepared");
    expect(stopped.providerTerminationReceipt).toMatchObject({ remoteStopped: true });
    expect(JSON.parse(priorRunnerBytes.toString()).lifecycle).toBe("suspended");
    const checkpointName = (await readdir(runtime)).find(name => /^checkpoint-[a-f0-9]{64}\.json$/u.test(name))!;
    const priorCheckpoint = JSON.parse(await readFile(join(runtime, checkpointName), "utf8"));
    expect(priorCheckpoint).toMatchObject({ phase: "terminal", ownerRunId: identity.runId, pendingTerminalDelivery: null });
    const baselineRoot = join(root, "baseline");
    await cp(stateDirectory, baselineRoot, { recursive: true });
    const second = createRunnerdCodexTransport({ ...options, prpIdentity: nextIdentity,
      environment: environment("token-second", nextIdentity.runId), baseInstructions: instructions, resumeDynamicTools: [tool("second_tool")],
      controlPlaneRegistration: async core => { secondAuthority = core; await core.start(); return { release: () => undefined }; } });
    bundles.push(second);
    const handler = vi.fn(async () => ({ success: true, contentItems: [{ type: "inputText", text: "current-tool-response" }] }));
    second.transport.setServerRequestHandler(handler);
    if (instructions === "") {
      await expect(second.transport.request("thread/read", {})).rejects.toThrow("Cursor Cloud instructions are empty");
      expect((secondAuthority!.store.state.runAttachTemplate!.provider as Record<string, unknown>).instructions).toBe("");
      expect(JSON.parse(await readFile(remoteStatePath, "utf8")).runs).toHaveLength(1);
      return;
    }
    await expect(second.transport.request("thread/read", {})).resolves.toMatchObject({ thread: { id: normalizedSessionId } });
    expect(JSON.parse(await readFile(join(runtime, checkpointName), "utf8"))).toMatchObject({ ownerRunId: nextIdentity.runId, agentId: priorCheckpoint.agentId, runId: priorCheckpoint.runId });
    const archives = await readdir(join(stateDirectory, "authority-epochs"));
    expect(archives).toHaveLength(1);
    const archive = join(stateDirectory, "authority-epochs", archives[0]!);
    expect(await readFile(join(archive, "runner-state.json"))).toEqual(priorRunnerBytes);
    expect(await readFile(join(archive, "control-plane", "control-plane-state.json"))).toEqual(priorCoreBytes);
    await second.transport.request("turn/start", { input: [{ type: "text", text: "Continue from the answer." }] });
    await vi.waitFor(async () => expect(JSON.parse(await readFile(remoteStatePath, "utf8")).runs).toHaveLength(2));
    const retired = await mcp("token-first", { id: 0, method: "initialize" });
    expect(retired.status).toBe(401);
    expect((await mcp("token-second", { id: 0, method: "initialize" }, undefined, firstScopeHeader)).status).toBe(401);
    const initialized = await mcp("token-second", { id: 0, method: "initialize" });
    const catalog = await mcp("token-second", { id: 1, method: "tools/list" }, initialized.sessionId);
    expect(catalog.value.result.tools.map((entry: { name: string }) => entry.name)).toContain("second_tool");
    expect(catalog.value.result.tools.map((entry: { name: string }) => entry.name)).not.toContain("first_tool");
    const response = await mcp("token-second", { id: 2, method: "tools/call", params: { name: "second_tool", arguments: {} } }, initialized.sessionId);
    expect(JSON.stringify(response.value)).toContain("current-tool-response");
    expect(handler).toHaveBeenCalledOnce();
    await second.transport.request("turn/interrupt", {});
    for await (const event of second.transport.notifications()) if (event.method === "turn/completed") break;
    await second.transport.close();
    expect(second.evidence().runnerExited).toBe(true);
    await expect(stat(socketPath)).rejects.toHaveProperty("code", "ENOENT");
    const calls = (await readFile(fetchLog, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const creates = calls.filter(call => call.method === "POST" && (call.path === "/v1/agents" || call.path.endsWith("/runs")));
    expect(creates).toHaveLength(2);
    expect(creates[0].path).toBe("/v1/agents");
    expect(creates[1].path).toBe(`/v1/agents/${priorCheckpoint.agentId}/runs`);
    expect(creates[1].pid).not.toBe(creates[0].pid);
    expect(creates.map(call => call.body.model)).toEqual([{ id: "pinned-model" }, { id: "pinned-model" }]);
    expect(creates[1].body.prompt.text).toContain(instructions);
    expect((secondAuthority!.store.state.runAttachTemplate!.provider as Record<string, unknown>).instructions).toBe(instructions);
    expect(JSON.parse(await readFile(join(stateDirectory, "runner", "codex-provider-state.json"), "utf8")).config.instructions).toBe(instructions);
    expect(creates[1].body.prompt.text).not.toContain("FIRST instruction grant");
    expect(creates[1].body.mcpServers).toEqual([{ name: "paperclip", type: "http", url: `https://relay.example.test/mcp/native-runs/${nextIdentity.runId}`, headers: { Authorization: "Bearer token-second", [RUNNER_TOOL_SCOPE_TOKEN_HEADER]: await currentCloudScopeHeader(runtime, normalizedSessionId) } }]);
    const remote = JSON.parse(await readFile(remoteStatePath, "utf8"));
    expect(new Set(remote.runs.map((run: { id: string }) => run.id)).size).toBe(2);
    expect(remote.runs.every((run: { status: string }) => run.status === "FINISHED")).toBe(true);
    for (const mode of ["warm", "unsettled", "cross-binding", "external", "managed", "agentcore"] as const) {
      const guardRoot = join(root, `guard-${mode}`);
      await cp(baselineRoot, guardRoot, { recursive: true });
      if (mode === "warm") {
        const state = JSON.parse(priorCoreBytes.toString()); state.warmTransition = {};
        await writeFile(join(guardRoot, "control-plane", "control-plane-state.json"), JSON.stringify(state));
      }
      if (mode === "unsettled") {
        const state = JSON.parse(priorRunnerBytes.toString()); state.lifecycle = "ready";
        await writeFile(join(guardRoot, "runner", "runner-state.json"), JSON.stringify(state));
      }
      const guard = createRunnerdCodexTransport({ ...options, stateDirectory: guardRoot,
        provider: mode === "managed" ? "claude_managed" : mode === "agentcore" ? "aws_agentcore" : "cursor_cloud",
        prpIdentity: mode === "cross-binding" ? { ...nextIdentity, normalizedSessionId: "foreign-session" } : nextIdentity,
        ...(mode === "external" ? { readRunnerState: async () => JSON.parse(priorRunnerBytes.toString()) } : {}),
        environment: environment("token-second", nextIdentity.runId), baseInstructions: instructions });
      bundles.push(guard);
      await expect(guard.transport.request("thread/read", {})).rejects.toThrow({ warm: "native_runner_warm_transition_requires_exact_owned_endpoint", unsettled: "native_runner_authority_rotation_requires_settled_state", "cross-binding": "PRP recovery identity does not match the durable session binding", external: "native_runner_prp_run_rotation_unavailable", managed: "native_runner_prp_run_rotation_unavailable", agentcore: "native_runner_prp_run_rotation_unavailable" }[mode]);
      await guard.transport.close();
    }
  } finally {
    for (const bundle of bundles.reverse()) await bundle.transport.close().catch(() => undefined);
    await secondAuthority?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

it.each([{ label: "revised", instructions: "SECOND instruction grant" }, { label: "empty grant rejected", instructions: "" }])("cold-rotates Cloud authority with the same native Agent and current run grants ($label)", async ({ instructions }) => {
  await cloudColdAuthorityRotation(instructions);
}, 40_000);

it("retains an unconfirmed Cloud shutdown without manufacturing cold readiness", async () => {
  await cloudColdAuthorityRotation("Current instructions", false);
}, 30_000);
