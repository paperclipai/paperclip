import { afterEach, expect, it, vi } from "vitest";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { promisify } from "node:util";
import type { CommandManagedDuplexChannel, CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { startAdapterExecutionTargetPaperclipBridge } from "@paperclipai/adapter-utils/execution-target";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createNativeGitHubAccess, type NativeGitHubAccess } from "./native-github-access.js";
import { OpenCodeServerDriver } from "@paperclipai/paperclip-runner";
import { createCapabilityRunnerdProviderEnvironment } from "@paperclipai/paperclip-runner/live";
const scope = { companyId: "company-a", agentId: "agent-a", issueId: "task-a" };
const run = (runId: string) => ({ ...scope, runId });
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function localDuplexChannel(command: readonly string[], cwd: string): CommandManagedDuplexChannel {
  const child = spawn(command[0]!, command.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const buffered: Buffer[] = [];
  let dataListener: ((chunk: Uint8Array) => void) | undefined;
  let exitListener: ((exit: { exitCode: number | null }) => void) | undefined;
  let exit: { exitCode: number | null } | undefined;
  child.stdin.on("error", () => undefined);
  child.stderr.resume();
  child.stdout.on("data", (chunk: Buffer) => dataListener ? dataListener(chunk) : buffered.push(chunk));
  const closed = new Promise<void>(resolve => child.once("close", code => {
    exit = { exitCode: code };
    exitListener?.(exit);
    resolve();
  }));
  return {
    write: data => { child.stdin.write(data); },
    onData: listener => { dataListener = listener; for (const chunk of buffered.splice(0)) listener(chunk); },
    onExit: listener => { exitListener = listener; if (exit) listener(exit); },
    stop: () => { child.kill(); },
    close: async () => { child.kill(); await closed; },
  };
}
async function broker(resolveCredentials = vi.fn(async (binding: ReturnType<typeof run>) => ({
  status: "available", env: { GH_TOKEN: `fixture-${binding.runId}` },
})), remote = false, bridgeUnavailable = false, onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
duplex?: { enabled?: boolean; capability: boolean; unavailable?: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "native-github-reuse-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "real-bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "gh"), `#!${process.execPath}\nprocess.stdout.write(process.env.GH_TOKEN || 'anonymous');`, { mode: 0o700 });
  const execute = vi.fn<CommandManagedRuntimeRunner["execute"]>(async (input) => {
    const startedAt = new Date().toISOString();
    const child = promisify(execFile)(input.command, input.args ?? [], {
      cwd: input.cwd ?? root, env: { ...process.env, ...input.env }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    });
    child.child.stdin?.on("error", () => undefined);
    child.child.stdin?.end(input.stdin ?? "");
    const result = await child;
    return { ...result, exitCode: 0, signal: null, timedOut: false, pid: null, startedAt };
  });
  const openDuplexChannel = vi.fn<NonNullable<CommandManagedRuntimeRunner["openDuplexChannel"]>>(async input => {
    if (duplex?.unavailable) throw new Error("fixture channel unavailable");
    return localDuplexChannel(input.command, root);
  });
  const target = remote ? { kind: "remote" as const, transport: "sandbox" as const, providerKey: "test",
    remoteCwd: root, runner: { execute, ...(duplex ? { openDuplexChannel } : {}) }, streamRunLogs: false,
    ...(duplex ? { enableSandboxDuplexBridge: duplex.enabled, effectiveCapabilities: {
      reusableLeases: true, nativeSyncIn: false, nativeSyncOut: false, persistentProcessSessions: false,
      independentControlCommands: true, incrementalSessionOutput: false, concurrentSyncOperations: false,
      duplexCommandStream: duplex.capability, runnerWebSocketIngress: false,
    } } : {}) } : null;
  const bridgeModes: (string | undefined)[] = [];
  const result = await createNativeGitHubAccess({ scope, target, cwd: root,
    env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, PAPERCLIP_API_KEY: "old-run-api-key" }, resolveCredentials, onLog },
    bridgeUnavailable ? async () => { throw new Error("fixture bridge unavailable"); } : async input => {
      const bridge = await startAdapterExecutionTargetPaperclipBridge(input);
      bridgeModes.push(bridge?.env.PAPERCLIP_API_BRIDGE_MODE);
      return bridge;
    });
  cleanups.push(result.stop);
  return Object.assign(result, { root, resolveCredentials, execute, openDuplexChannel, bridgeModes });
}
function request(broker: NativeGitHubAccess, extra: RequestInit = {}, endpoint = "/runtime-tools/github/credentials") {
  return fetch(broker.env.PAPERCLIP_GITHUB_BROKER_URL + endpoint, {
    method: "POST", body: "{}", headers: { authorization: `Bearer ${broker.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, "content-type": "application/json" }, ...extra,
  });
}
it.each([false, true])("resolves managed GitHub credentials from OpenCode shell operations (runner projection: %s)", async throughRunner => {
  const b = await broker();
  const command = path.join(b.root, "fake-opencode-server.mjs");
  const fixture = new URL("../../../../packages/paperclip-runner/test/fixtures/fake-opencode-server.mjs", import.meta.url);
  await writeFile(command, await readFile(fixture), { mode: 0o700 });
  const source = { ...b.env, OPENROUTER_API_KEY: "fixture-provider-key", PAPERCLIP_API_KEY: "controller-must-not-cross" };
  const environment = throughRunner ? createCapabilityRunnerdProviderEnvironment({
    provider: "opencode",
    options: { environment: source, stateDirectory: b.root },
    identity: { runnerInstanceId: "runner-a", environmentLeaseId: "lease-a", runId: "a", normalizedSessionId: "github", turnId: "turn-a", itemId: "item-a" },
    codexHome: path.join(b.root, "codex-home"),
    runtimeContextPath: path.join(b.root, "context.json"),
    hasRuntimeContext: false,
  }) : source;
  const driver = new OpenCodeServerDriver({
    model: "openrouter/z-ai/glm-5.3", runtimeDirectory: b.root, command, environment,
  });
  const session = await driver.openSession({ runId: "a", normalizedSessionId: "github", workingDirectory: b.root });
  cleanups.push(() => session.close({ reason: "test complete" }));
  const operate = async () => {
    await session.startTurn({ message: { role: "user", text: "managed-github-operation" } });
    for await (const event of session.events()) {
      if (event.eventType === "turn.completed") break;
      if (event.eventType === "turn.failed") throw new Error("OpenCode fixture turn failed");
    }
    return JSON.parse(await readFile(path.join(b.root, "github", "data", "fake-github-operation.json"), "utf8"));
  };
  const releaseA = b.activate(run("a"));
  expect(await operate()).toMatchObject({ stdout: "fixture-a", error: null });
  releaseA();
  const releaseB = b.activate(run("b"));
  expect(await operate()).toMatchObject({ stdout: "fixture-b", error: null });
  releaseB();
  expect(await operate()).toMatchObject({ stdout: "anonymous", error: null });
  expect(b.resolveCredentials.mock.calls.map(([binding]) => binding.runId)).toEqual(["a", "b"]);
  const childEnvironment = JSON.parse(await readFile(path.join(b.root, "github", "data", "fake-environment.json"), "utf8"));
  expect(childEnvironment.keys).not.toContain("PAPERCLIP_API_KEY");
  expect(childEnvironment.githubTokenPresent).toBe(false);
}, 30000);
it("uses the selected duplex transport across credential rotation without file polling", async () => {
  const b = await broker(undefined, true, false, undefined, { enabled: true, capability: true });
  expect(b.bridgeModes).toEqual(["http2_v1"]);
  expect(b.openDuplexChannel).toHaveBeenCalledOnce();
  const commandsAfterStartup = b.execute.mock.calls.length;
  expect((await request(b)).status).toBe(403);
  const releaseA = b.activate(run("a"));
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-a" } });
  releaseA();
  expect((await request(b)).status).toBe(403);
  const releaseB = b.activate(run("b"));
  releaseA();
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-b" } });
  expect(b.resolveCredentials.mock.calls.map(([binding]) => binding.runId)).toEqual(["a", "b"]);
  expect(b.execute.mock.calls).toHaveLength(commandsAfterStartup);
  releaseB();
  await b.stop();
  expect(() => b.activate(run("c"))).toThrow("closed");
});
it("marks a lost HTTP/2 bridge unavailable before the next warm admission", async () => {
  const b = await broker(undefined, true, false, undefined, { enabled: true, capability: true });
  const release = b.activate(run("a"));
  expect((await request(b)).status).toBe(200);
  release();
  expect(b.ready).toBe(true);
  const channel = await b.openDuplexChannel.mock.results[0]!.value;
  channel.stop();
  await vi.waitFor(() => expect(b.ready).toBe(false), { timeout: 2000 });
});
it("closes a healthy HTTP/2 bridge without reporting a lost active run", async () => {
  const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => undefined);
  const b = await broker(undefined, true, false, onLog, { enabled: true, capability: true });
  const release = b.activate(run("a"));
  expect((await request(b)).status).toBe(200);
  release();
  await b.stop();
  expect(b.ready).toBe(false);
  expect(onLog.mock.calls.filter(([, chunk]) => chunk.includes("channel lost"))).toEqual([]);
});
it.each([
  { enabled: false, capability: true, unavailable: false, opens: 0 },
  { enabled: undefined, capability: true, unavailable: false, opens: 0 },
  { enabled: true, capability: false, unavailable: false, opens: 0 },
  { enabled: true, capability: true, unavailable: true, opens: 1 },
])("retains authorized file fallback with duplex settings %j", async options => {
  const b = await broker(undefined, true, false, undefined, options);
  expect(b.bridgeModes).toEqual(["queue_v1"]);
  expect(b.openDuplexChannel).toHaveBeenCalledTimes(options.opens);
  const release = b.activate(run("fallback"));
  expect(await (await request(b)).json()).toMatchObject({ env: { GH_TOKEN: "fixture-fallback" } });
  release();
  expect((await request(b)).status).toBe(403);
});
it.each([false, true])("keeps one live parent and its original launcher environment across two authorized runs (callback bridge: %s)", async (remote) => {
  const b = await broker(undefined, remote);
  const parent = spawn(process.execPath, ["-e", `
    const {execFile}=require('node:child_process');
    require('node:readline').createInterface({input:process.stdin}).on('line', () => {
      execFile('gh', [], (error, stdout, stderr) => console.log(JSON.stringify({pid:process.pid, value:stdout, error:error?.message, stderr})));
    });
  `], { env: { ...process.env, ...b.env, PAPERCLIP_API_KEY: "stale-api-key" }, stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(async () => { const exited = new Promise<void>(resolve => parent.once("exit", () => resolve())); parent.kill(); await exited; });
  const lines = createInterface({ input: parent.stdout });
  const operation = () => new Promise<{ pid: number; value: string; stderr: string }>(resolve => {
    lines.once("line", line => resolve(JSON.parse(line))); parent.stdin.write("run\n");
  });
  expect((await request(b)).status).toBe(403);
  const releaseA = b.activate(run("run-a"));
  const a = await operation();
  expect(a.value).toBe("fixture-run-a");
  releaseA();
  expect((await operation()).value).toBe("anonymous");
  const releaseB = b.activate(run("run-b"));
  releaseA(); // A's delayed cleanup cannot revoke B.
  const second = await operation();
  expect(second.value).toBe("fixture-run-b");
  expect(second.pid).toBe(a.pid);
  expect(b.resolveCredentials.mock.calls.map(([binding]) => binding.runId)).toEqual(["run-a", "run-b"]);
  expect(await readFile(path.join(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), "utf8")).not.toContain(b.env.PAPERCLIP_GITHUB_BROKER_TOKEN);
  releaseB(); await b.stop();
  await expect(access(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR)).rejects.toThrow();
}, 45_000);
it("rejects other scopes, concurrent bindings, browser requests and forged authority", async () => {
  const b = await broker();
  for (const field of ["companyId", "agentId", "issueId"] as const) {
    expect(() => b.activate({ ...run("a"), [field]: "other" })).toThrow("scope mismatch");
  }
  const release = b.activate(run("a"));
  expect(() => b.activate(run("b"))).toThrow("busy");
  const rejectedHeaders: Record<string, string>[] = [{ authorization: "Bearer wrong" }, { authorization: "é".repeat(71) },
    { authorization: `Bearer ${b.env.PAPERCLIP_GITHUB_BRIDGE_TOKEN}`, origin: "https://browser.test" }];
  for (const headers of rejectedHeaders) {
    expect((await request(b, { headers })).status).toBe(403);
  }
  expect((await request(b, {}, "/api/companies")).status).toBe(404);
  expect((await request(b, { method: "GET", body: undefined })).status).toBe(404);
  const response = await request(b, { body: JSON.stringify({ runId: "b", responsibleUserId: "other" }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(b.resolveCredentials).toHaveBeenCalledExactlyOnceWith(run("a"));
  release(); await b.stop();
  expect(() => b.activate(run("b"))).toThrow("closed");
});
it("does not release an in-flight credential after its run has been replaced", async () => {
  let complete!: (value: { status: string; env: { GH_TOKEN: string } }) => void;
  const resolver = vi.fn(() => new Promise<{ status: string; env: { GH_TOKEN: string } }>(resolve => { complete = resolve; }));
  const b = await broker(resolver);
  const release = b.activate(run("a"));
  const pending = request(b);
  await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
  release(); b.activate(run("b"));
  complete({ status: "available", env: { GH_TOKEN: "must-not-escape" } });
  const response = await pending;
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain("must-not-escape");
});
it.each([403, 409, 500])("preserves denial/steering without leaking errors (%s)", async (status) => {
  const b = await broker(vi.fn(async () => { throw Object.assign(new Error("secret-value"), { status }); }));
  b.activate(run("a"));
  const response = await request(b);
  expect(response.status).toBe(status === 500 ? 503 : status);
  expect(await response.text()).not.toContain("secret-value");
});

it.each([false, true])("keeps anonymous launchers usable when the remote broker cannot start (logging fails: %s)", async (loggingFails) => {
  const onLog = vi.fn(async () => { if (loggingFails) throw new Error("fixture log sink unavailable"); });
  const b = await broker(undefined, true, true, onLog);
  expect(onLog).toHaveBeenCalledWith("stderr", expect.stringContaining("continuing without managed GitHub access"));
  b.activate(run("a"));
  expect(b.ready).toBe(false);
  expect(b.env.PAPERCLIP_GITHUB_BROKER_TOKEN).toBe("");
  const result = await promisify(execFile)(path.join(b.env.PAPERCLIP_GITHUB_LAUNCHER_DIR, "gh"), [], {
    env: { ...process.env, ...b.env, GH_TOKEN: "ambient-must-not-leak" },
  });
  expect(result.stdout).toBe("anonymous");
  expect(b.resolveCredentials).not.toHaveBeenCalled();
});
