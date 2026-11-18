import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxRecoveryBinding } from "./recovery-identity.js";
import { prepareAcpxRuntimeSandbox } from "./runtime-sandbox.js";

const SELF_SCHEDULING = ["CronCreate", "CronDelete", "CronList", "ScheduleWakeup"];
const RETAINED = ["Agent", "Bash", "ListAgents", "SendMessage", "TaskStop", "Workflow"];
const agentEntry = createRequire(import.meta.url).resolve("@agentclientprotocol/claude-agent-acp/dist/index.js");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

async function fakeAnthropicApi(): Promise<{ url: string; offered: string[][] }> {
  const offered: string[][] = [];
  const api = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method !== "POST" || request.url?.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.url?.includes("count_tokens") ? JSON.stringify({ input_tokens: 1 }) : JSON.stringify({ data: [], has_more: false }));
      return;
    }
    const body = JSON.parse(raw || "{}");
    if (Array.isArray(body.tools)) offered.push(body.tools.map((tool: { name: string }) => tool.name));
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const frame of [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model ?? "claude-sonnet-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Local fixture complete." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]) response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(api.address() as { port: number }).port}`, offered };
}

async function promptOnce(env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const agent = spawn(process.execPath, [agentEntry], { cwd, env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>(resolve => agent.once("close", () => resolve()));
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= stopProcessGroup(agent.pid!, closed);
  cleanup.push(stop);
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void }>();
  const send = (message: Record<string, unknown>) => agent.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method: string, params: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  createInterface({ input: agent.stdout }).on("line", line => {
    let message: { id?: number; method?: string; result?: Record<string, unknown>; error?: unknown };
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(message.error); else waiter?.resolve(message.result ?? {});
    } else if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "Not supported by this fixture" } });
    }
  });
  agent.once("exit", code => { for (const waiter of pending.values()) waiter.reject(new Error(`claude-agent-acp exited with ${code}`)); });
  await request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
  const session = await request("session/new", { cwd, mcpServers: [] });
  await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Report this local fixture's result. Do not call tools." }] });
  await stop();
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try { process.kill(-pid, signal); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function stopProcessGroup(pid: number, closed: Promise<void>): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const deadline = (ms: number) => new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), ms).unref());
  if (await Promise.race([closed, deadline(5_000)]) === "timeout") signalGroup(pid, "SIGKILL");
  await closed;
  for (let attempt = 0; signalGroup(pid, 0); attempt += 1) {
    if (attempt === 50) signalGroup(pid, "SIGKILL");
    if (attempt > 100) throw new Error(`claude-agent-acp process group ${pid} did not exit`);
    await deadline(50);
  }
}

function fixtureEnvironment(apiUrl: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, ANTHROPIC_API_KEY: "local-fixture-only", ANTHROPIC_BASE_URL: apiUrl,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

const launchOnlyEnvironment = { DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", ENABLE_TOOL_SEARCH: "false" };

it("withholds Claude's self-scheduling tools from a Paperclip-launched ACPX session", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-scheduling-tools-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = join(root, "workspace"), runtimeDirectory = join(root, "runtime");
  await Promise.all([mkdir(workspace), mkdir(runtimeDirectory)]);
  const binding = await createAcpxRecoveryBinding({
    runtimeDirectory, normalizedSessionId: "claude-scheduling-tools", workingDirectory: workspace,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"), requestedModel: "claude-sonnet-5",
    permissionMode: "approve-reads",
  });
  const api = await fakeAnthropicApi();
  const sandbox = await prepareAcpxRuntimeSandbox({ binding, agent: "claude", environment: fixtureEnvironment(api.url) });
  await sandbox.initializeOwnedConfiguration?.();
  await promptOnce({ ...sandbox.launchEnvironment, ...launchOnlyEnvironment, TMPDIR: root }, workspace);
  expect(api.offered.length).toBeGreaterThan(0);
  const offered = api.offered.reduce((longest, tools) => tools.length > longest.length ? tools : longest);
  for (const tool of SELF_SCHEDULING) expect(offered).not.toContain(tool);
  for (const tool of RETAINED) expect(offered).toContain(tool);
}, 60_000);

it("withholds Claude's cron tools when the run uses a preconfigured home", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-scheduling-tools-home-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = join(root, "workspace"), runtimeDirectory = join(root, "runtime"), home = join(root, "home");
  await Promise.all([mkdir(workspace), mkdir(runtimeDirectory), mkdir(home)]);
  const binding = await createAcpxRecoveryBinding({
    runtimeDirectory, normalizedSessionId: "claude-scheduling-tools-home", workingDirectory: workspace,
    profile: resolveQualifiedAcpxProfile("claude", "claude-sonnet-5"), requestedModel: "claude-sonnet-5",
    permissionMode: "approve-reads",
  });
  const api = await fakeAnthropicApi();
  const sandbox = await prepareAcpxRuntimeSandbox({ binding, agent: "claude", environment: {
    ...fixtureEnvironment(api.url), HOME: home, PAPERCLIP_RUNNER_HOME_MODE: "preconfigured",
  } });
  await promptOnce({ ...sandbox.launchEnvironment, ...launchOnlyEnvironment, TMPDIR: root }, workspace);
  expect(api.offered.length).toBeGreaterThan(0);
  const offered = api.offered.reduce((longest, tools) => tools.length > longest.length ? tools : longest);
  for (const tool of ["CronCreate", "CronDelete", "CronList"]) expect(offered).not.toContain(tool);
  for (const tool of RETAINED) expect(offered).toContain(tool);
}, 60_000);
