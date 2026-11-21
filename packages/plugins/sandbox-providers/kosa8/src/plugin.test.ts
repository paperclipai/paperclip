import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PluginEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./plugin.js";

const hooks = plugin.definition;
const base = { driverKey: "kosa8", companyId: "company-1", environmentId: "env-12345678abc" };
const root = mkdtempSync(path.join(tmpdir(), "paperclip-kosa8-test-"));
const config = { apiKey: "k8c_live_test", apiUrl: "https://api.test.kosa8" };

interface FakeSandbox {
  id: string;
  state: string;
  name: string;
  labels: Record<string, string>;
}

interface FakeExec {
  id: string;
  child: ChildProcess;
  state: "running" | "exited";
  exit: number | null;
  timedOut: boolean;
}

interface Call {
  method: string;
  route: string;
  body: Record<string, unknown> | undefined;
}

const fake = {
  sandboxes: new Map<string, FakeSandbox>(),
  execs: new Map<string, FakeExec>(),
  calls: [] as Call[],
  next: 0,
  createState: "running",
  override: null as null | ((call: Call) => Response | null),
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function localPath(value: string): string {
  return value === "/workspace" || value.startsWith("/workspace/") ? path.join(root, value) : value;
}

function spawnCommand(cmd: string[], env: string[]): ChildProcess {
  const extra = Object.fromEntries(env.map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]));
  return spawn(cmd[0]!, cmd.slice(1).map(localPath), {
    env: { PATH: process.env.PATH, HOME: root, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
}

async function runBuffered(cmd: string[], env: string[], timeoutS: number): Promise<Response> {
  const child = spawnCommand(cmd, env);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }, timeoutS * 1000);
  const exit = await new Promise<number | null>((resolve) => child.on("close", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 143 : 137))));
  clearTimeout(timer);
  if (timedOut) return json(504, { error: "exec_timeout", message: `the command ran longer than its timeout_s of ${timeoutS} s` });
  return json(200, { exit, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
}

function startBackground(cmd: string[], env: string[], timeoutS: number | undefined): FakeExec {
  const id = `bg_${(fake.next++).toString(16).padStart(16, "0")}`;
  const child = spawnCommand(cmd, env);
  const exec: FakeExec = { id, child, state: "running", exit: null, timedOut: false };
  child.stdout?.resume();
  child.stderr?.resume();
  const timer = timeoutS
    ? setTimeout(() => {
      exec.timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, timeoutS * 1000)
    : null;
  child.on("close", (code) => {
    if (timer) clearTimeout(timer);
    exec.state = "exited";
    exec.exit = code ?? 137;
  });
  fake.execs.set(id, exec);
  return exec;
}

function publicExec(exec: FakeExec) {
  return { id: exec.id, state: exec.state, exit: exec.exit, ...(exec.timedOut ? { timed_out: true } : {}) };
}

async function handle(call: Call): Promise<Response> {
  const { method, route, body } = call;
  if (method === "POST" && route === "/v1/sandboxes") {
    const id = `sbx_${(fake.next++).toString(36)}`;
    const sandbox: FakeSandbox = {
      id,
      state: fake.createState,
      name: String(body?.name ?? id),
      labels: (body?.labels as Record<string, string>) ?? {},
    };
    fake.sandboxes.set(id, sandbox);
    return json(fake.createState === "creating" ? 202 : 201, { sandbox: { ...sandbox } });
  }
  const match = /^\/v1\/sandboxes\/([^/]+)(\/.*)?$/.exec(route);
  if (!match) return json(404, { error: "not_found", message: "no route" });
  const sandbox = fake.sandboxes.get(match[1]!);
  if (!sandbox || sandbox.state === "deleted") return json(404, { error: "not_found", message: "no such sandbox" });
  const rest = match[2] ?? "";
  if (rest === "" && method === "GET") {
    const answer = { ...sandbox };
    if (sandbox.state === "creating") sandbox.state = "running";
    return json(200, { sandbox: answer });
  }
  if (rest === "" && method === "DELETE") {
    sandbox.state = "deleted";
    return json(200, { ok: true, id: sandbox.id });
  }
  if (rest === "/sleep" && method === "POST") {
    if (sandbox.state !== "running" && sandbox.state !== "sleeping") return json(409, { error: "not_running", message: sandbox.state });
    sandbox.state = "sleeping";
    return json(200, { sandbox: { ...sandbox } });
  }
  if (rest === "/wake" && method === "POST") {
    if (sandbox.state !== "sleeping") return json(409, { error: "not_sleeping", message: sandbox.state });
    sandbox.state = "running";
    return json(200, { sandbox: { ...sandbox }, wake_ms: 80 });
  }
  if (rest === "/exec" && method === "POST") {
    if (sandbox.state === "sleeping") sandbox.state = "running";
    const cmd = body?.cmd as string[];
    const env = (body?.env as string[] | undefined) ?? [];
    expect(cmd.length).toBeLessThanOrEqual(256);
    for (const arg of cmd) expect(arg.length).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(64 * 1024);
    const timeoutS = body?.timeout_s as number | undefined;
    if (body?.background) return json(202, { exec: publicExec(startBackground(cmd, env, timeoutS)) });
    expect(timeoutS ?? 0).toBeLessThanOrEqual(90);
    return await runBuffered(cmd, env, timeoutS ?? 90);
  }
  const bg = /^\/exec\/(bg_[0-9a-f]{16})(\/stop)?$/.exec(rest);
  if (bg) {
    const exec = fake.execs.get(bg[1]!);
    if (!exec) return json(404, { error: "not_found", message: "no such background command" });
    if (bg[2]) {
      try {
        process.kill(-exec.child.pid!, "SIGTERM");
      } catch {}
      return json(200, { exec: { id: exec.id, state: "stopping" } });
    }
    return json(200, { exec: publicExec(exec) });
  }
  return json(404, { error: "not_found", message: "no route" });
}

const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  expect(url.origin).toBe("https://api.test.kosa8");
  expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k8c_live_test");
  const call: Call = {
    method: init?.method ?? "GET",
    route: url.pathname,
    body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
  };
  fake.calls.push(call);
  return fake.override?.(call) ?? (await handle(call));
});

function calls(method: string, pattern: RegExp): Call[] {
  return fake.calls.filter((call) => call.method === method && pattern.test(call.route));
}

async function acquire(extra: Record<string, unknown> = {}, cwd = "/workspace/paperclip-workspace") {
  return await hooks.onEnvironmentAcquireLease!({
    ...base,
    config: { ...config, ...extra },
    runId: "run-12345678",
    requestedCwd: cwd,
  });
}

async function execute(lease: { providerLeaseId: string | null; metadata?: Record<string, unknown> }, params: Record<string, unknown>) {
  return await hooks.onEnvironmentExecute!({
    ...base,
    config,
    lease,
    command: "sh",
    ...params,
  } as Parameters<NonNullable<typeof hooks.onEnvironmentExecute>>[0]);
}

describe("kosa8 sandbox provider plugin", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockClear();
    await hooks.onShutdown?.();
    fake.sandboxes.clear();
    for (const exec of fake.execs.values()) {
      try {
        process.kill(-exec.child.pid!, "SIGKILL");
      } catch {}
    }
    fake.execs.clear();
    fake.calls.length = 0;
    fake.createState = "running";
    fake.override = null;
    delete process.env.KOSA8_API_KEY;
    delete process.env.KOSA8_API_URL;
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("declares environment lifecycle handlers", async () => {
    expect(await hooks.onHealth?.()).toEqual({ status: "ok", message: "kosa8 sandbox provider plugin healthy" });
    for (const hook of [
      "onEnvironmentValidateConfig",
      "onEnvironmentProbe",
      "onEnvironmentAcquireLease",
      "onEnvironmentResumeLease",
      "onEnvironmentReleaseLease",
      "onEnvironmentStopLease",
      "onEnvironmentDestroyLease",
      "onEnvironmentInspectLease",
      "onEnvironmentRealizeWorkspace",
      "onEnvironmentExecute",
    ] as const) {
      expect(typeof hooks[hook]).toBe("function");
    }
  });

  it("validates the config", async () => {
    const validate = (raw: Record<string, unknown>) => hooks.onEnvironmentValidateConfig!({ driverKey: "kosa8", config: raw });
    expect(await validate({})).toEqual({ ok: false, errors: ["kosa8 environments require an API key in config or KOSA8_API_KEY."] });
    process.env.KOSA8_API_KEY = "k8c_live_env";
    expect((await validate({})).ok).toBe(true);
    expect((await validate({ size: "3x5" })).errors).toEqual(["size must be 2x4, 4x8, 8x16 or 16x32 (vCPU x GiB)."]);
    expect((await validate({ snapshot: "snap_1", size: "4x8" })).errors?.[0]).toMatch(/^snapshot keeps/);
    expect((await validate({ template: "python", image: "python:3.12" })).errors?.[0]).toMatch(/^template keeps/);
    expect((await validate({ apiUrl: "http://api.example.com" })).errors).toEqual(["apiUrl must use https, except for localhost."]);
    expect((await validate({ apiUrl: "http://localhost:8787" })).ok).toBe(true);
    expect((await validate({ timeoutMs: 0 })).errors).toEqual(["timeoutMs must be between 1 and 86400000."]);
    expect(await validate({ ...config, egressAllow: " api.anthropic.com, *.github.com ", namePrefix: "My Team!" })).toEqual({
      ok: true,
      normalizedConfig: expect.objectContaining({
        egressAllow: "api.anthropic.com,*.github.com",
        namePrefix: "my-team",
        reuseLease: false,
        timeoutMs: 3_600_000,
      }),
    });
  });

  it("acquires a persistent universal sandbox with labels and a workspace", async () => {
    const lease = await acquire({}, "");
    const [create] = calls("POST", /^\/v1\/sandboxes$/);
    expect(create!.body).toEqual({
      size: "2x4",
      image: "kosa8-template/universal-24.04-20261115.2",
      persistent: true,
      name: expect.stringMatching(/^paperclip-env12345-run12345-[0-9a-f]{4}$/),
      labels: { "paperclip-provider": "kosa8", "paperclip-environment": "env-12345678abc", "paperclip-run": "run-12345678" },
    });
    expect(lease.providerLeaseId).toMatch(/^sbx_/);
    expect(lease.metadata).toMatchObject({ provider: "kosa8", remoteCwd: "/workspace/paperclip-workspace", resumedLease: false });
    expect(lease.expiresAt).toBeUndefined();
  });

  it("passes snapshot, template, region and egress settings to kosa8", async () => {
    await acquire({ snapshot: "snap_1", region: "eu-hel1", egressAllow: "api.anthropic.com,*.github.com" });
    await acquire({ template: "python" });
    const [first, second] = calls("POST", /^\/v1\/sandboxes$/);
    expect(first!.body).toMatchObject({ snapshot: "snap_1", region: "eu-hel1", egress: { internet: false, allow: ["api.anthropic.com", "*.github.com"] } });
    expect(first!.body).not.toHaveProperty("size");
    expect(second!.body).toMatchObject({ template: "python", persistent: true });
    expect(second!.body).not.toHaveProperty("image");
  });

  it("waits for a cold-booting sandbox and bounds the lease with delete_after", async () => {
    fake.createState = "creating";
    const requestedExpiresAt = new Date(Date.now() + 600_000).toISOString();
    const lease = await hooks.onEnvironmentAcquireLease!({ ...base, config, runId: "run-1", requestedExpiresAt });
    const [create] = calls("POST", /^\/v1\/sandboxes$/);
    expect(create!.body!.delete_after).toBe(Date.parse(requestedExpiresAt) - 5000);
    expect(lease.expiresAt).toBe(new Date(Date.parse(requestedExpiresAt) - 5000).toISOString());
    await expect(
      hooks.onEnvironmentAcquireLease!({ ...base, config, runId: "run-2", requestedExpiresAt: new Date(Date.now() + 30_000).toISOString() }),
    ).rejects.toThrow(/less than 65 seconds/);
    expect(calls("POST", /^\/v1\/sandboxes$/)).toHaveLength(1);
  });

  it("deletes the sandbox when acquisition fails, and reports a failed cleanup", async () => {
    fake.override = (call) => (call.route.endsWith("/exec") ? json(502, { error: "host_failed", message: "boom" }) : null);
    await expect(acquire()).rejects.toThrow(/host_failed/);
    expect(calls("DELETE", /^\/v1\/sandboxes\/sbx_/)).toHaveLength(1);
    fake.override = (call) =>
      call.route.endsWith("/exec") || call.method === "DELETE" ? json(502, { error: "host_failed", message: "boom" }) : null;
    const error = await acquire().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginEnvironmentCreationCleanupError);
    expect((error as PluginEnvironmentCreationCleanupError).cleanup).toMatchObject({
      companyId: "company-1",
      environmentId: "env-12345678abc",
      runId: "run-12345678",
      labels: { "paperclip-provider": "kosa8" },
    });
  });

  it("runs a short command with args, env, stdin, cwd and separate output streams", async () => {
    const lease = await acquire();
    const result = await execute(lease, {
      args: ["-c", 'printf "%s|%s|%s|" "$1" "$GREETING" "$(pwd)"; cat; echo oops >&2; exit 3', "argv0", "arg with 'quotes' and spaces"],
      env: { GREETING: "hello $USER" },
      stdin: "from stdin",
      timeoutMs: 20_000,
    });
    expect(result).toEqual({
      exitCode: 3,
      timedOut: false,
      stdout: `arg with 'quotes' and spaces|hello $USER|${path.join(root, "workspace/paperclip-workspace")}|from stdin`,
      stderr: "oops\n",
    });
    expect(calls("POST", /\/exec$/).at(-1)!.body!.background).toBeUndefined();
  });

  it("runs a long command in the background and reads large output in chunks", async () => {
    const lease = await acquire();
    const result = await execute(lease, {
      args: ["-c", 'head -c 1500000 /dev/zero | tr "\\0" "a"; printf "%s" "$(cat)" >&2'],
      stdin: "x".repeat(200_000),
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(createHash("sha256").update(result.stdout).digest("hex")).toBe(createHash("sha256").update("a".repeat(1_500_000)).digest("hex"));
    expect(result.stderr).toBe("x".repeat(200_000));
    const background = calls("POST", /\/exec$/).filter((call) => call.body?.background === true);
    expect(background).toHaveLength(1);
    expect(background[0]!.body!.timeout_s).toBe(3600);
    expect(background[0]!.body).not.toHaveProperty("env");
    const staged = calls("POST", /\/exec$/).filter((call) => (call.body?.env as string[] | undefined)?.[0]?.startsWith("PAPERCLIP_K8_CHUNK="));
    expect(staged.length).toBeGreaterThanOrEqual(6);
    const runDir = (background[0]!.body!.cmd as string[])[4]!;
    const check = await execute(lease, { args: ["-c", 'test -e "$1" && echo left || echo gone', "check", runDir], timeoutMs: 20_000 });
    expect(check.stdout).toBe("gone\n");
  });

  it("returns timedOut for a buffered command and for a background command", async () => {
    const lease = await acquire();
    const buffered = await execute(lease, { args: ["-c", "sleep 5"], timeoutMs: 1000 });
    expect(buffered).toMatchObject({ exitCode: null, timedOut: true });
    fake.override = (call) =>
      call.method === "GET" && /\/exec\/bg_/.test(call.route)
        ? json(200, { exec: { id: call.route.split("/").pop(), state: "exited", exit: 137, timed_out: true } })
        : null;
    const background = await execute(lease, { args: ["-c", "sleep 5"] });
    expect(background).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("falls back to a buffered command when the host has no background commands", async () => {
    const lease = await acquire();
    fake.override = (call) =>
      call.body?.background ? json(501, { error: "not_available", message: "background commands are not available on this sandbox's host yet" }) : null;
    const result = await execute(lease, { args: ["-c", "echo fallback"] });
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "fallback\n", stderr: "" });
  });

  it("keeps uploaded inputs for the buffered fallback", async () => {
    const lease = await acquire();
    fake.override = (call) =>
      call.body?.background ? json(501, { error: "not_available", message: "background commands are not available on this sandbox's host yet" }) : null;
    const result = await execute(lease, { args: ["-c", "wc -c | tr -d ' '"], stdin: "y".repeat(200_000), timeoutMs: 120_000 });
    expect(result).toEqual({ exitCode: 0, timedOut: false, stdout: "200000\n", stderr: "" });
    expect(calls("POST", /\/exec$/).some((call) => (call.body?.env as string[] | undefined)?.[0]?.startsWith("PAPERCLIP_K8_CHUNK="))).toBe(true);
  });

  it("retries a background start without timeout_s when the host cannot stop background commands", async () => {
    const lease = await acquire();
    fake.override = (call) =>
      call.body?.background && call.body.timeout_s !== undefined
        ? json(501, { error: "not_available", message: "timeout_s on a background command is not available on this sandbox's host yet" })
        : null;
    const result = await execute(lease, { args: ["-c", "echo ok"] });
    expect(result.stdout).toBe("ok\n");
    expect(calls("POST", /\/exec$/).filter((call) => call.body?.background && call.body.timeout_s === undefined)).toHaveLength(1);
  });

  it("reports a missing lease and rejects invalid env keys", async () => {
    expect(await execute({ providerLeaseId: null }, {})).toEqual({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "No provider lease ID available for execution.",
    });
    const lease = await acquire();
    await expect(execute(lease, { env: { "BAD-KEY": "1" } })).rejects.toThrow(/Invalid sandbox environment variable key/);
  });

  it("deletes the sandbox on release without reuse", async () => {
    const lease = await acquire();
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config, providerLeaseId: lease.providerLeaseId });
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    expect(fake.sandboxes.get(lease.providerLeaseId!)!.state).toBe("deleted");
  });

  it("puts the sandbox to sleep on release with reuse, and wakes it on resume", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    const id = lease.providerLeaseId!;
    expect(await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id })).toBeUndefined();
    expect(fake.sandboxes.get(id)!.state).toBe("sleeping");
    expect(await hooks.onEnvironmentInspectLease!({ ...base, config: reuse, providerLeaseId: id })).toEqual({ providerLeaseId: id, state: "stopped" });
    const resumed = await hooks.onEnvironmentResumeLease!({ ...base, config: reuse, providerLeaseId: id, leaseMetadata: lease.metadata });
    expect(resumed).toMatchObject({ providerLeaseId: id, metadata: { resumedLease: true, remoteCwd: "/workspace/paperclip-workspace" } });
    expect(calls("POST", /\/wake$/)).toHaveLength(1);
    expect(fake.sandboxes.get(id)!.state).toBe("running");
  });

  it("stops tracked commands before sleep when a release cancels active work", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    const id = lease.providerLeaseId!;
    const running = execute(lease, { args: ["-c", "sleep 30"] });
    await vi.waitFor(() => expect(calls("GET", /\/exec\/bg_/).length).toBeGreaterThan(0));
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id, cancelActiveWork: true });
    expect(receipt).toEqual({ providerLeaseId: id, state: "stopped" });
    expect(calls("POST", /\/exec\/bg_[0-9a-f]+\/stop$/)).toHaveLength(1);
    expect([...fake.execs.values()][0]!.state).toBe("exited");
    await running.catch(() => undefined);
  });

  it("ends a command itself when the host cannot stop or time out background commands", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    const id = lease.providerLeaseId!;
    fake.override = (call) => {
      if (call.body?.background && call.body.timeout_s !== undefined) {
        return json(501, { error: "not_available", message: "timeout_s on a background command is not available on this sandbox's host yet" });
      }
      if (/\/exec\/bg_[0-9a-f]+\/stop$/.test(call.route)) {
        return json(501, { error: "not_available", message: "stopping a background command is not available on this sandbox's host yet" });
      }
      return null;
    };
    const running = execute(lease, { args: ["-c", "sleep 30"] });
    await vi.waitFor(() => expect(calls("GET", /\/exec\/bg_/).length).toBeGreaterThan(0));
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id, cancelActiveWork: true });
    expect(receipt).toEqual({ providerLeaseId: id, state: "stopped" });
    expect([...fake.execs.values()][0]!.state).toBe("exited");
    await running.catch(() => undefined);
  });

  it("finishes the cancelled command and refuses new commands before the sandbox sleeps", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    const id = lease.providerLeaseId!;
    const running = execute(lease, { args: ["-c", "sleep 30"] });
    await vi.waitFor(() => expect(calls("GET", /\/exec\/bg_/).length).toBeGreaterThan(0));
    const release = hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id, cancelActiveWork: true });
    await expect(execute(lease, { args: ["-c", "echo late"], timeoutMs: 20_000 })).rejects.toThrow(/is stopping/);
    const receipt = await release;
    const result = await running;
    expect(receipt).toEqual({ providerLeaseId: id, state: "stopped" });
    expect(result.timedOut).toBe(false);
    const sleepIndex = fake.calls.findIndex((call) => call.route.endsWith("/sleep"));
    expect(fake.calls.slice(sleepIndex + 1).filter((call) => call.route.endsWith("/exec"))).toEqual([]);
    expect(fake.sandboxes.get(id)!.state).toBe("sleeping");
  });

  it("stops a buffered command on a cancelling release", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    const id = lease.providerLeaseId!;
    const running = execute(lease, { args: ["-c", "sleep 30"], timeoutMs: 60_000 });
    await vi.waitFor(() => expect(calls("POST", /\/exec$/).length).toBeGreaterThan(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id, cancelActiveWork: true });
    expect(receipt).toEqual({ providerLeaseId: id, state: "stopped" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect((await running).exitCode).not.toBe(0);
  });

  it("keeps a command tracked when its state is unknown, and stops it on release", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    const id = lease.providerLeaseId!;
    let failStatus = true;
    fake.override = (call) =>
      failStatus && call.method === "GET" && /\/exec\/bg_/.test(call.route) ? json(502, { error: "host_failed", message: "flaky" }) : null;
    await expect(execute(lease, { args: ["-c", "sleep 30"] })).rejects.toThrow(/host_failed/);
    failStatus = false;
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: id });
    expect(receipt).toBeUndefined();
    expect(calls("POST", /\/exec\/bg_[0-9a-f]+\/stop$/)).toHaveLength(1);
    expect([...fake.execs.values()][0]!.state).toBe("exited");
  });

  it("reports a timed-out command that cannot be stopped", async () => {
    const lease = await acquire();
    fake.override = (call) => {
      if (call.method === "GET" && /\/exec\/bg_/.test(call.route)) {
        return json(200, { exec: { id: call.route.split("/").pop(), state: "running", exit: null } });
      }
      if (/\/stop$/.test(call.route)) return json(502, { error: "host_failed", message: "cannot stop" });
      return null;
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const running = execute(lease, { args: ["-c", "sleep 30"] });
      await vi.waitFor(() => expect(calls("GET", /\/exec\/bg_/).length).toBeGreaterThan(0));
      vi.setSystemTime(Date.now() + 4_000_000);
      await expect(running).rejects.toThrow(/could not be stopped/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes staged files when a later upload chunk fails", async () => {
    const lease = await acquire();
    let chunks = 0;
    fake.override = (call) => {
      const env = call.body?.env as string[] | undefined;
      if (env?.[0]?.startsWith("PAPERCLIP_K8_CHUNK=") && ++chunks === 2) return json(502, { error: "host_failed", message: "upload broke" });
      return null;
    };
    await expect(execute(lease, { args: ["-c", "cat >/dev/null"], stdin: "y".repeat(200_000), timeoutMs: 20_000 })).rejects.toThrow(/upload broke/);
    fake.override = null;
    const stage = calls("POST", /\/exec$/).find((call) => (call.body?.env as string[] | undefined)?.[0]?.startsWith("PAPERCLIP_K8_CHUNK="))!;
    const runDir = (stage.body!.cmd as string[])[4]!;
    const check = await execute(lease, { args: ["-c", 'test -e "$1" && echo left || echo gone', "check", runDir], timeoutMs: 20_000 });
    expect(check.stdout).toBe("gone\n");
  });

  it("keeps the sandbox asleep for stop and stop_and_retain", async () => {
    const lease = await acquire();
    const id = lease.providerLeaseId!;
    expect(await hooks.onEnvironmentStopLease!({ ...base, config, providerLeaseId: id })).toEqual({ providerLeaseId: id, state: "stopped" });
    expect(
      await hooks.onEnvironmentReleaseLease!({ ...base, config, providerLeaseId: id, resourceDisposition: "stop_and_retain" }),
    ).toEqual({ providerLeaseId: id, state: "stopped" });
    expect(fake.sandboxes.get(id)!.state).toBe("sleeping");
    await expect(hooks.onEnvironmentStopLease!({ ...base, config, providerLeaseId: null })).rejects.toThrow(/No provider lease ID/);
  });

  it("deletes the sandbox when a reuse sleep fails", async () => {
    const reuse = { ...config, reuseLease: true };
    const lease = await acquire({ reuseLease: true });
    fake.override = (call) => (call.route.endsWith("/sleep") ? json(409, { error: "dedicated", message: "cannot be slept" }) : null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const receipt = await hooks.onEnvironmentReleaseLease!({ ...base, config: reuse, providerLeaseId: lease.providerLeaseId });
    expect(receipt).toEqual({ providerLeaseId: lease.providerLeaseId, state: "destroyed" });
    warn.mockRestore();
  });

  it("reports an expired lease on resume of a missing or deleted sandbox", async () => {
    expect(await hooks.onEnvironmentResumeLease!({ ...base, config, providerLeaseId: "sbx_missing" })).toEqual({
      providerLeaseId: null,
      metadata: { expired: true },
    });
    const lease = await acquire();
    await hooks.onEnvironmentDestroyLease!({ ...base, config, providerLeaseId: lease.providerLeaseId });
    expect(await hooks.onEnvironmentResumeLease!({ ...base, config, providerLeaseId: lease.providerLeaseId! })).toEqual({
      providerLeaseId: null,
      metadata: { expired: true },
    });
  });

  it("maps sandbox states on inspect", async () => {
    const lease = await acquire();
    const id = lease.providerLeaseId!;
    const inspect = () => hooks.onEnvironmentInspectLease!({ ...base, config, providerLeaseId: id });
    expect(await inspect()).toEqual({ providerLeaseId: id, state: "active" });
    fake.sandboxes.get(id)!.state = "error";
    expect(await inspect()).toEqual({ providerLeaseId: id, state: "unknown" });
    fake.sandboxes.get(id)!.state = "deleted";
    expect(await inspect()).toEqual({ providerLeaseId: id, state: "destroyed" });
    fake.override = () => json(401, { error: "unauthorized", message: "bad key" });
    await expect(inspect()).rejects.toThrow(/401 unauthorized/);
  });

  it("checks a failed-creation cleanup before it deletes the sandbox", async () => {
    const lease = await acquire();
    await expect(
      hooks.onEnvironmentDestroyLease!({
        ...base,
        config,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: { failedCreateCleanup: { providerLeaseId: lease.providerLeaseId, companyId: "other" } },
      }),
    ).rejects.toThrow(/does not match/);
    expect(fake.sandboxes.get(lease.providerLeaseId!)!.state).toBe("running");
  });

  it("realizes the workspace in the lease directory", async () => {
    const lease = await acquire();
    const result = await hooks.onEnvironmentRealizeWorkspace!({
      ...base,
      config,
      lease: { providerLeaseId: lease.providerLeaseId, metadata: { remoteCwd: "/workspace/other" } },
      workspace: {},
    });
    expect(result).toEqual({ cwd: "/workspace/other", metadata: { provider: "kosa8", remoteCwd: "/workspace/other" } });
  });

  it("probes with a short-lived sandbox and deletes it", async () => {
    const result = await hooks.onEnvironmentProbe!({ ...base, config });
    expect(result).toMatchObject({ ok: true, summary: expect.stringMatching(/^Connected to kosa8 sandbox sbx_/) });
    const [create] = calls("POST", /^\/v1\/sandboxes$/);
    expect(create!.body).toMatchObject({ ttl_s: 900, labels: { "paperclip-run": "probe" } });
    expect([...fake.sandboxes.values()].every((sandbox) => sandbox.state === "deleted")).toBe(true);
    fake.override = (call) => (call.route === "/v1/sandboxes" ? json(402, { error: "payment_required", message: "add a card" }) : null);
    const failed = await hooks.onEnvironmentProbe!({ ...base, config });
    expect(failed).toMatchObject({ ok: false, summary: "kosa8 environment probe failed.", metadata: { error: expect.stringMatching(/payment_required/) } });
  });

  it("retries a rate-limited request", async () => {
    let limited = 1;
    fake.override = (call) => (call.route === "/v1/sandboxes" && limited-- > 0 ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } }) : null);
    const lease = await acquire();
    expect(lease.providerLeaseId).toMatch(/^sbx_/);
    expect(calls("POST", /^\/v1\/sandboxes$/)).toHaveLength(2);
  });
});
