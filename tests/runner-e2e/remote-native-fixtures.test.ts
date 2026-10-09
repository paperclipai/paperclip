import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS, bindRemoteNativeFixture, createRemoteTargetWatch, isRemoteRunRoot, parseRemoteProcStat, remoteNativeFixtureDiagnostics, type RemoteNativeFixtureOptions, type RemoteNativeSnapshot } from "./remote-native-fixtures.js";

import { createRemoteNativeBootstrap } from "./remote-native-bootstrap.js";

const hash = (s: string) => `sha256:${createHash("sha256").update(s).digest("hex")}`;
const bootId = "12345678-1234-1234-1234-123456789abc";
const authority = { companyId: "company", environmentId: "environment", runId: "run", leaseId: "lease", sandboxId: "sandbox", image: `registry/image@sha256:${"a".repeat(64)}` };
const binding = { ...authority, remoteCwd: "/workspace" };
const root = { pid: 21, ppid: 1, startTicks: "100", bootId };
function snapshot(): RemoteNativeSnapshot {
  return { binding, observedAtMs: 1000, observedMonotonicNs: "10000", receivedAtMs: 1000, complete: true, workspace: { "existing.txt": hash("original") },
    targets: { "result.txt": { absent: true, sha256: null, parent: { dev: "1", ino: "2" }, mutationCount: 0, complete: true } },
    watcher: { complete: true, targetMutationCount: 0, workspaceMutationCount: 0 },
    processes: { captured: true, root, journal: [root], live: [21] }, scope: { kind: "user_workspace", excludedRuntime: { relativePath: ".paperclip-runtime/paperclip-runner", absolutePath: "/workspace/.paperclip-runtime/paperclip-runner", dev: "1", ino: "4", runnerExecutableSha256: hash("runnerd") }, observedPrpEnvironmentLeaseId: "workspace-id", prpEnvironmentLeaseIdVerified: false }, setup: { path: "action.txt", sha256: null, published: false }, attached: null };
}
function readiness() { return { ready: true, binding, root, runtime: { dev: "1", ino: "4", runnerExecutableSha256: hash("runnerd") } }; }
function harness() {
  let lease: Record<string, unknown> = { id: "lease", companyId: "company", environmentId: "environment", heartbeatRunId: "run", provider: "daytona", providerLeaseId: "sandbox", status: "active", releasedAt: null,
    metadata: { sandboxId: "sandbox", image: authority.image, reuseLease: false, remoteCwd: "/workspace", workspaceSentinel: { path: "/workspace/.paperclip-runtime/reusable-sandbox-lease.json", token: "fixture-sentinel-token", result: "written", runId: "run", providerLeaseId: "sandbox" } } };
  const labels: Record<string, string> = { "paperclip-provider": "daytona", "paperclip-company-id": "company", "paperclip-environment-id": "environment", "paperclip-run-id": "run", "paperclip-reuse-lease": "false" };
  const calls: Array<{ command: string; request: Record<string, any>; timeout: number | undefined }> = [];
  let resolveTerminal!: (v: unknown) => void, rejectTerminal!: (e: unknown) => void;
  const terminal = new Promise((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  const current = snapshot();
  let override: ((request: Record<string, any>) => unknown) | undefined;
  const executeCommand = vi.fn(async (command: string, _cwd?: string, _env?: Record<string, string>, timeout?: number) => {
    const encoded = command.match(/ '([A-Za-z0-9+/=]+)'$/u)?.[1];
    if (!encoded) throw new Error("invalid command");
    const request = JSON.parse(Buffer.from(encoded, "base64").toString()); calls.push({ command, request, timeout });
    if (request.op === "wait") return { exitCode: 0, result: JSON.stringify({ ok: true, result: await terminal }) };
    if (override) { const result = override(request); if (result !== undefined) return result as { exitCode: number; result: string }; }
    let result: unknown = request.op === "runtime-ready" ? readiness() : structuredClone(current);
    if (request.op === "publish") { current.setup = { path: request.path, published: true, sha256: hash(request.text) }; result = current.setup; }
    if (request.op === "close") result = { closed: true };
    if (request.op === "arm") result = { armed: true, sealed: false };
    if (request.op === "attached") result = { clientScript: `${request.root}/client.cjs`, clientSocket: `${request.root}/attached.sock` };
    return { exitCode: 0, result: JSON.stringify({ ok: true, result }) };
  });
  const get = vi.fn(async () => ({ id: "sandbox", labels, process: { executeCommand } }));
  const apiGet = vi.fn(async (path: string) => path.includes("/environments/") ? [structuredClone(lease)] : structuredClone(lease));
  const options: RemoteNativeFixtureOptions = { api: { get: apiGet as RemoteNativeFixtureOptions["api"]["get"] }, daytona: { get }, sdkVersion: "0.203.0", authority, nodeSha256: hash("node"), runnerdSha256: hash("runnerd"), targets: ["result.txt"], actionFile: "action.txt", deadlineAt: Date.now() + REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS + 18_000 };
  return { options, current, labels, calls, executeCommand, apiGet, get, resolveTerminal, rejectTerminal,
    setLease(value: Record<string, unknown>) { lease = value; }, lease: () => lease, override(fn: typeof override) { override = fn; } };
}

describe("remote native lease admission", () => {
  it.each(["companyId", "environmentId", "heartbeatRunId", "providerLeaseId", "provider", "status"])("rejects wrong %s before executing any remote command", async key => {
    const h = harness(); h.setLease({ ...h.lease(), [key]: "foreign" });
    await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("lease_scope"); expect(h.executeCommand).not.toHaveBeenCalled();
  });
  it("rejects protected runtime targets and insufficient setup budget before SDK access", async () => {
    for (const patch of [{ targets: [".paperclip-runtime/paperclip-runner/bin/forbidden"] }, { actionFile: ".paperclip-runtime/paperclip-runner/task.txt" }, { deadlineAt: Date.now() + 1000 }]) {
      const h = harness(); await expect(bindRemoteNativeFixture({ ...h.options, ...patch })).rejects.toThrow(); expect(h.get).not.toHaveBeenCalled();
    }
  });
  it("requires exact SDK, immutable image and executable hashes", async () => {
    for (const input of [{ sdkVersion: "0.204.0" }, { nodeSha256: "unknown" }, { authority: { ...authority, image: "image:latest" } }]) {
      const h = harness(); await expect(bindRemoteNativeFixture({ ...h.options, ...input } as RemoteNativeFixtureOptions)).rejects.toThrow(); expect(h.get).not.toHaveBeenCalled();
    }
  });
  it("rejects reuse, foreign metadata and sentinel binding", async () => {
    for (const patch of [{ reuseLease: true }, { sandboxId: "other" }, { image: "image:latest" }, { remoteCwd: "/workspace/../foreign" }, { workspaceSentinel: { token: "fixture-sentinel-token" } }]) {
      const h = harness(); h.setLease({ ...h.lease(), metadata: { ...(h.lease().metadata as object), ...patch } });
      await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow(); expect(h.executeCommand).not.toHaveBeenCalled();
    }
  });
  it("rejects wrong ownership labels and never discovers a sandbox by name", async () => {
    const h = harness(); h.labels["paperclip-run-id"] = "other";
    await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("sandbox_labels"); expect(h.get).toHaveBeenCalledExactlyOnceWith("sandbox"); expect(h.executeCommand).not.toHaveBeenCalled();
  });
  it("waits beyond the old 20s install subdeadline for staging, then installs exactly once before action", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(); h.options.deadlineAt += 60_000;
      h.override(r => r.op === "runtime-ready" && Date.now() < 1_021_000 ? { exitCode: 0, result: JSON.stringify({ ok: true, result: { ready: false } }) } : undefined);
      const pending = bindRemoteNativeFixture(h.options);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.calls.every(c => c.request.op === "runtime-ready")).toBe(true);
      await vi.advanceTimersByTimeAsync(1000); const fixture = await pending;
      expect(h.calls.filter(c => c.request.op === "install")).toHaveLength(1);
      expect(h.calls.find(c => c.request.op === "install")!.timeout).toBe(25);
      expect(h.calls.at(-1)!.request.op).toBe("arm");
      expect(h.apiGet).toHaveBeenCalledTimes((h.calls.filter(c => c.request.op === "runtime-ready").length + 2) * 2);
      await fixture.close();
    } finally { vi.useRealTimers(); }
  });
  it("reserves readiness after a late lease with delayed admission and installation", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(); h.options.deadlineAt = Date.now() + REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS;
      const initialGet = h.get.getMockImplementation()!;
      h.get.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 9000)); return initialGet(); });
      h.override(r => {
        if (r.op === "runtime-ready" || r.op === "install") return new Promise(resolve => setTimeout(() => resolve({
          exitCode: 0, result: JSON.stringify({ ok: true, result: r.op === "runtime-ready" ? readiness() : snapshot() }),
        }), r.op === "runtime-ready" ? 9000 : 24_000));
        return undefined;
      });
      const pending = bindRemoteNativeFixture(h.options);
      // Retain a rejected setup for the assertion below while fake clocks advance.
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(8999); expect(h.calls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(9001); expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install"]);
      expect(h.calls.find(c => c.request.op === "install")!.timeout).toBe(25);
      await vi.advanceTimersByTimeAsync(24_000); const fixture = await pending;
      expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "wait", "arm"]);
      expect(h.options.deadlineAt - Date.now()).toBe(22_000);
      await fixture.publishAction("action.txt", "task"); expect(h.calls.at(-1)!.request.op).toBe("publish");
      await fixture.close();
    } finally { vi.useRealTimers(); }
  });
  it.each([42_000, 43_000, REMOTE_FIXTURE_MIN_SETUP_BUDGET_MS - 1])("rejects a %ims late setup window before remote work", async budget => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(); h.options.deadlineAt = Date.now() + budget;
      await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("insufficient_setup_budget");
      expect(h.apiGet).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
  it("never installs on a missing runtime and reserves installation and teardown inside the original deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(); h.override(r => r.op === "runtime-ready" ? { exitCode: 0, result: '{"ok":true,"result":{"ready":false}}' } : undefined);
      const outcome = bindRemoteNativeFixture(h.options).catch(error => error);
      await vi.advanceTimersByTimeAsync(h.options.deadlineAt - 42_000 - Date.now());
      expect((await outcome).message).toContain("readiness_deadline");
      expect(h.calls.every(c => c.request.op === "runtime-ready")).toBe(true);
      expect(Date.now()).toBe(h.options.deadlineAt - 42_000);
    } finally { vi.useRealTimers(); }
  });
  it.each(["lease", "binding", "shape", "pin", "unknown-error"])("rejects %s during readiness without installing or publishing", async variant => {
    const h = harness();
    h.override(r => {
      if (r.op !== "runtime-ready") return undefined;
      if (variant === "lease") { h.setLease({ ...h.lease(), heartbeatRunId: "other" }); return { exitCode: 0, result: '{"ok":true,"result":{"ready":false}}' }; }
      if (variant === "unknown-error") return { exitCode: 2, result: 'SECRET sdk stderr' };
      const value: any = readiness();
      if (variant === "binding") value.binding = { ...binding, leaseId: "foreign" };
      if (variant === "pin") value.runtime.runnerExecutableSha256 = hash("foreign");
      if (variant === "shape") value.extra = "secret";
      return { exitCode: 0, result: JSON.stringify({ ok: true, result: value }) };
    });
    const error = await bindRemoteNativeFixture(h.options).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(h.calls.every(c => c.request.op === "runtime-ready")).toBe(true);
    expect(JSON.stringify(remoteNativeFixtureDiagnostics(error))).not.toContain("SECRET");
  });
  it.each(["extra", "foreign-phase", "unknown-code", "malformed"])("drops %s remote diagnostic content without retry", async variant => {
    const h = harness();
    h.override(r => r.op === "runtime-ready" ? { exitCode: 2, result: variant === "malformed" ? "PRIVATE stderr" : JSON.stringify({ ok: false, diagnostic: { phase: variant === "foreign-phase" ? "close" : r.op, code: variant === "unknown-code" ? "PRIVATE stderr" : "socket_error", ...(variant === "extra" ? { private: "PRIVATE stderr" } : {}) } }) } : undefined);
    const error = await bindRemoteNativeFixture(h.options).catch(error => error);
    expect(remoteNativeFixtureDiagnostics(error)).toEqual([{ phase: "runtime-ready", code: "invalid_response" }]);
    expect(error.message).not.toContain("PRIVATE"); expect(h.calls).toHaveLength(1);
  });
  it("persists safe startup diagnostics through the real bootstrap catch without publishing an action", async () => {
    const h = harness(), evidence = vi.fn(async () => {});
    h.override(r => r.op === "runtime-ready" ? { exitCode: 2, result: JSON.stringify({ ok: false, diagnostic: { phase: "runtime-ready", code: "runtime_binary_identity" } }) } : undefined);
    const bootstrap = createRemoteNativeBootstrap({ ...h.options, companyId: "company", environmentId: "environment", agentId: "agent", image: authority.image, evidence,
      api: { get: (async (path: string) => path === "/api/issues/issue" ? { id: "issue", companyId: "company", assigneeAgentId: "agent" }
        : path === "/api/heartbeat-runs/run" ? { id: "run", companyId: "company", agentId: "agent", status: "running", executionStage: "preparing" }
          : [{ ...h.lease(), issueId: "issue" }]) as RemoteNativeFixtureOptions["api"]["get"] },
    }, async options => bindRemoteNativeFixture({ ...h.options, actionFile: options.actionFile }));
    bootstrap.prompt("nonce");
    const actionPrompt = vi.fn(async () => "PRIVATE ACTION");
    await expect(bootstrap.bindAndRelease({ issueId: "issue", runId: "run", targets: ["result.txt"], actionPrompt })).rejects.toThrow("runtime_binary_identity");
    expect(actionPrompt).not.toHaveBeenCalled();
    expect(evidence).toHaveBeenCalledWith("remote-native-bootstrap-startup-run.json", expect.objectContaining({
      phase: "observer_setup", fixtureDiagnostics: [{ phase: "runtime-ready", code: "runtime_binary_identity" }],
    }));
    expect(JSON.stringify(evidence.mock.calls)).not.toContain("PRIVATE ACTION");
    expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready"]);
  });
  it.each(["pid", "ppid", "startTicks", "bootId"])("rejects changed %s between readiness and baseline despite extra observer process fields", async key => {
    const h = harness();
    const changed = { state: "S", group: 21, ...root, [key]: key === "bootId" ? "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" : key === "startTicks" ? "999" : 99 };
    h.current.processes = { captured: true, root: changed, journal: [changed], live: [changed.pid] };
    await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("runtime_identity_changed");
    expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "close"]);
  });
  it("retains the closed read phase on transport errors without leaking text", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options);
    h.override(r => r.op === "read" ? { exitCode: 2, result: JSON.stringify({ ok: false, diagnostic: { phase: "read", code: "socket_error" } }) } : undefined);
    const error = await f.readFile("result.txt").catch(error => error);
    expect(remoteNativeFixtureDiagnostics(error)).toEqual([{ phase: "read", code: "socket_error" }]);
    await f.close();
  });
  it("retains only allowlisted install and cleanup diagnostics with no uncertain retry", async () => {
    const h = harness();
    h.override(r => ["install", "close"].includes(r.op) ? { exitCode: 2, result: JSON.stringify({ ok: false, diagnostic: { phase: r.op, code: r.op === "install" ? "runtime_identity_changed" : "socket_error" } }) } : undefined);
    const error = await bindRemoteNativeFixture(h.options).catch(error => error);
    expect(error.message).toContain("startup_failed_cleanup_unproven");
    expect(remoteNativeFixtureDiagnostics(error)).toEqual([{ phase: "close", code: "socket_error" }, { phase: "install", code: "runtime_identity_changed" }]);
    expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "close"]);
  });
  it("arms before publish, binds long receipt before teardown and preserves exact final bytes", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options);
    expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "wait", "arm"]); expect(f.baseline.processes.live).toEqual([21]);
    expect(h.calls[2]!.timeout).toBeLessThanOrEqual(67); expect(h.calls[2]!.request.timeoutMs).toBe(h.calls[2]!.timeout! * 1000);
    await f.publishAction("action.txt", "write only result.txt");
    await expect(f.publishAction("action.txt", "retry")).rejects.toThrow("publish_bound");
    const bytes = "\nUnicode 🪴 literal \\n\n";
    const final = { ...structuredClone(h.current), processes: { ...h.current.processes, live: [] }, files: { "result.txt": Buffer.from(bytes).toString("base64") } };
    final.targets["result.txt"] = { ...final.targets["result.txt"]!, absent: false, sha256: hash(bytes), mutationCount: 1 };
    h.resolveTerminal(final); h.apiGet.mockRejectedValue(new Error("lease already deleted"));
    expect((await f.finish()).processes.live).toEqual([]); expect((await f.readFile("result.txt")).toString()).toBe(bytes);
    await f.close(); expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "wait", "arm", "publish"]);
  });
  it("fails closed when lease deletion beats the terminal receipt", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options); await f.publishAction("action.txt", "task");
    h.rejectTerminal(new Error("channel closed before receipt")); await expect(f.finish()).rejects.toThrow("remote_command_failed_or_deadline");
  });
  it("rejects lease rotation before subsequent commands", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options); const count = h.calls.length;
    h.setLease({ ...h.lease(), heartbeatRunId: "next-run" });
    await expect(f.snapshot("pending")).rejects.toThrow("lease_scope"); expect(h.calls).toHaveLength(count);
  });
  it.each(["live", "incomplete", "missing-root", "bad-file"])("rejects %s terminal proof without weakening assertions", async type => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options); await f.publishAction("action.txt", "task");
    const end: any = { ...structuredClone(h.current), processes: { ...h.current.processes, live: [] }, files: {} };
    if (type === "live") end.processes.live = [21];
    if (type === "incomplete") end.watcher.complete = false;
    if (type === "missing-root") end.processes = { captured: false, root: null, journal: [], live: [] };
    if (type === "bad-file") end.targets["result.txt"] = { ...end.targets["result.txt"], absent: false, sha256: hash("missing") };
    h.resolveTerminal(end); await expect(f.finish()).rejects.toThrow();
  });
  it("reports only closed terminal failure reasons without weakening retirement proof", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options);
    await f.publishAction("action.txt", "task");
    const end = { ...structuredClone(h.current), complete: false,
      processes: { ...h.current.processes, live: [] }, files: {},
      failureCodes: ["process_pid_reused", "secret-provider-payload", "process_pid_reused", { arbitrary: "payload" }] };
    h.resolveTerminal(end);
    const error = await f.finish().catch(error => error);
    expect(error.message).toContain("terminal_evidence_incomplete:published=true,complete=false");
    expect(error.message).toContain(":process_pid_reused");
    expect(error.message).not.toContain("secret-provider-payload");
    expect(error.message).not.toContain("arbitrary");
    expect(remoteNativeFixtureDiagnostics(error)).toEqual([{ phase: "wait", code: "terminal_evidence_incomplete" }]);
  });
  it("keeps a fixture-owned cross-root sentinel distinct from workspace targets", async () => {
    const h = harness(); h.options.crossRoot = { initialText: "outside sentinel" };
    h.current.targets["@cross-root"] = { absent: false, sha256: hash("outside sentinel"), parent: { dev: "1", ino: "outside" }, mutationCount: 0, complete: true };
    h.current.targets["@cross-root"]!.parent.ino = "42";
    const f = await bindRemoteNativeFixture(h.options);
    expect(f.outsideTarget).toMatch(/^\/tmp\/pc-native-[a-f0-9]{36}\/cross-root-target$/u);
    expect(f.outsideTarget!.startsWith(f.remoteCwd + "/")).toBe(false);
    expect(f.baseline.targets["@cross-root"]!.sha256).toBe(hash("outside sentinel"));
  });
  it("cleans only its admitted observer on a failed startup receipt and never publishes", async () => {
    const h = harness(); h.current.processes = { captured: false, root: null, journal: [], live: [] };
    await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("bootstrap_not_held");
    expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "close"]);
  });
  it("refuses action publication without a confirmed receipt channel", async () => {
    const h = harness(); h.override(r => r.op === "arm" ? { exitCode: 0, result: JSON.stringify({ ok: true, result: { armed: false, sealed: false } }) } : undefined);
    await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("receipt_channel_not_armed");
    expect(h.calls.map(c => c.request.op)).toEqual(["runtime-ready", "install", "wait", "arm", "close"]);
  });
  it("bounds malformed command output and does not replay an uncertain publish", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options);
    h.override(r => r.op === "publish" ? { exitCode: 0, result: "x".repeat(262145) } : undefined);
    await expect(f.publishAction("action.txt", "task")).rejects.toThrow("output_bound");
    await expect(f.publishAction("action.txt", "task")).rejects.toThrow("publish_bound");
    expect(h.calls.filter(c => c.request.op === "publish")).toHaveLength(1);
  });
  it("ships syntactically valid closed Node programs with exact binary and no provider env", async () => {
    const h = harness(); await bindRemoteNativeFixture(h.options);
    const install = h.calls.find(c => c.request.op === "install")!; const source = install.request.source as string;
    expect(() => new Script(source)).not.toThrow(); expect(source).not.toContain("__name(");
    const rpcQuoted = install.command.match(/ -e (.+) '[A-Za-z0-9+/=]+'$/su)![1]!;
    const rpc = rpcQuoted.slice(1, -1).replaceAll("'\\''", "'");
    expect(() => new Script(rpc)).not.toThrow();
    expect(rpc).not.toContain("startedAt+20000"); expect(install.timeout).toBeLessThanOrEqual(27); expect(rpc).toContain("r.timeoutMs-(Date.now()-startedAt)");
    expect(source).toContain("/proc/"); expect(source).toContain("workspaceWatch"); expect(source).toContain("finalReceipt.files");
    expect(install.command).toMatch(/^\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin /u);
    expect(install.request.config.runnerdSha256).toBe(hash("runnerd"));
    expect(source).not.toMatch(/execSync|execFileSync/u);
  });
});

describe("cell deadline and cleanup bounds", () => {
  it("expires finish with 15s reserved, bounds SDK/socket/observer clocks, and handles late SDK failure", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(), f = await bindRemoteNativeFixture(h.options);
      await f.publishAction("action.txt", "task");
      const install = h.calls.find(c => c.request.op === "install")!, wait = h.calls.find(c => c.request.op === "wait")!;
      expect(wait.timeout).toBe(67); expect(wait.request.timeoutMs).toBe(67_000);
      expect(install.request.config.observerTtlMs).toBe(67_000); expect(install.timeout).toBe(25);
      let settled = false;
      const result = f.finish().then(() => { settled = true; return "unexpected pass"; }, error => { settled = true; return error.message; });
      await vi.advanceTimersByTimeAsync(66_999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(await result).toContain("deadline");
      expect(Date.now()).toBe(h.options.deadlineAt - 15_000);
      h.rejectTerminal(new Error("late SDK close after host deadline")); await Promise.resolve();
      await f.close(); expect(h.calls.at(-1)!.request.op).toBe("close"); expect(h.calls.at(-1)!.timeout).toBe(10);
    } finally { vi.useRealTimers(); }
  });
  it("shortens a late ordinary RPC and never gives it a fresh timeout window", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(), f = await bindRemoteNativeFixture(h.options);
      await vi.advanceTimersByTimeAsync(64_000);
      await f.snapshot("late-but-bounded"); const call = h.calls.at(-1)!;
      expect(call.timeout).toBe(3); expect(call.request.timeoutMs).toBe(3000);
      await vi.advanceTimersByTimeAsync(3000);
      const count = h.calls.length; await expect(f.snapshot("too-late")).rejects.toThrow("receipt_deadline"); expect(h.calls).toHaveLength(count);
      await f.close(); h.rejectTerminal(new Error("late SDK rejection")); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
  it("bounds cleanup after cell expiry and rejects finish immediately after explicit close", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    try {
      const h = harness(), f = await bindRemoteNativeFixture(h.options); await vi.advanceTimersByTimeAsync(82_000);
      h.override(r => r.op === "close" ? new Promise(() => {}) : undefined);
      const close = f.close().then(() => "unexpected", error => error.message);
      await vi.advanceTimersByTimeAsync(9999); expect(h.calls.at(-1)!.request.timeoutMs).toBe(10_000);
      await vi.advanceTimersByTimeAsync(1); expect(await close).toContain("deadline");
      await expect(f.finish()).rejects.toThrow("deadline"); h.rejectTerminal(new Error("late")); await Promise.resolve();
      const h2 = harness(), f2 = await bindRemoteNativeFixture(h2.options);
      await f2.close(); await expect(f2.finish()).rejects.toThrow("closed_before_receipt");
      h2.rejectTerminal(new Error("ordinary close ended socket")); await Promise.resolve();
    } finally { vi.useRealTimers(); }
  });
});

describe("independent filesystem and process observations", () => {
  it.skipIf(process.platform !== "linux")("retains transient create/delete events and detects same-path parent replacement", async () => {
    const dir = await mkdtemp(join(tmpdir(), "remote-watch-")); const watcher = createRemoteTargetWatch(dir, "denied.txt");
    try {
      await writeFile(join(dir, "denied.txt"), "forbidden"); await rm(join(dir, "denied.txt"));
      await vi.waitFor(() => expect(watcher.snapshot().mutationCount).toBeGreaterThan(0));
      expect(watcher.snapshot().complete).toBe(true);
      await rename(dir, `${dir}-old`); await writeFile(dir, "replacement");
      expect(watcher.snapshot().complete).toBe(false);
    } finally { watcher.close(); await rm(dir, { recursive: true, force: true }); await rm(`${dir}-old`, { recursive: true, force: true }); }
  });
  it("marks lost filenames/watch errors incomplete", () => {
    let callback!: (_kind: string, filename: string | null) => void;
    const emitter = Object.assign(new EventEmitter(), { close: vi.fn() });
    const stat = { isDirectory: () => true, isSymbolicLink: () => false, dev: 1n, ino: 2n, mtimeNs: 3n, ctimeNs: 4n };
    const watcher = createRemoteTargetWatch("/test", "file", { watch: ((_path: unknown, cb: typeof callback) => { callback = cb; return emitter; }) as any, lstatSync: (() => stat) as any });
    callback("rename", null); expect(watcher.snapshot().complete).toBe(false); watcher.close();
  });
  it("parses Linux start ticks around unusual comm names and excludes shared/wrong-run daemons", () => {
    const fields = ["S", "1", "21", ...Array(16).fill("0"), "123456"];
    const p = parseRemoteProcStat(21, `21 (name with ) parens) ${fields.join(" ")}`, bootId);
    expect(p.startTicks).toBe("123456"); expect(isRemoteRunRoot(["/opt/paperclip-runnerd", "--run-id", "run", "--lifecycle-mode", "per_turn"], "run", p)).toBe(true);
    expect(isRemoteRunRoot(["/opt/paperclip-runnerd", "--run-id", "foreign", "--lifecycle-mode", "per_turn"], "run", p)).toBe(false);
    expect(isRemoteRunRoot(["/opt/paperclip-runnerd", "--run-id", "run", "--lifecycle-mode", "persistent"], "run", p)).toBe(false);
    expect(isRemoteRunRoot(["/opt/paperclip-runnerd", "--run-id", "run", "--lifecycle-mode", "per_turn"], "run", { ...p, group: 1 })).toBe(false);
    expect(parseRemoteProcStat(21, `21 (reused) ${fields.slice(0, -1).join(" ")} 999999`, bootId).startTicks).not.toBe(p.startTicks);
  });
});

describe("actual generated observer state machine", () => {
  async function observerHarness(deferStartup = false, transformed?: { command: string; observer: string }) {
    const h = harness(); await bindRemoteNativeFixture(h.options);
    const install = h.calls.find(c => c.request.op === "install")!;
    if (transformed) {
      install.request.source = transformed.observer;
      install.command = transformed.command;
    }
    const { source, config } = install.request;
    const intervals: Array<() => void> = [], timers: Array<{ fn: () => void; ms: number }> = [];
    const proc = new Map<number, { ppid: number; group: number; ticks: string; argv: string[] }>([[21, { ppid: 1, group: 21, ticks: "100", argv: ["/workspace/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd", "--run-id", "run", "--environment-lease-id", "workspace-id", "--lifecycle-mode", "per_turn", "--state-dir", "/workspace/.paperclip-runtime/paperclip-runner/sessions/" + "a".repeat(64) + "/runner"] }]]);
    const files = new Map<string, Buffer>([[`${config.root}/observer.cjs`, Buffer.from(source)], [config.sentinel.path, Buffer.from(JSON.stringify({ version: 1, provider: "daytona", token: config.sentinel.token, companyId: "company", environmentId: "environment" }))]]);
    const watches: Array<{ path: string; callback: (_kind: string, name: string | null) => void; closed: boolean }> = [];
    const handlers: Array<(socket: any) => void> = [], children: any[] = [];
    const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    const fds = new Map<number, string>(); let nextFd = 50, runtimeInode = 4n;
    const symbolicLinks = new Set<string>();
    const directories = new Set(["/tmp", "/workspace", "/workspace/.paperclip-runtime", "/workspace/.paperclip-runtime/paperclip-runner", "/workspace/.paperclip-runtime/paperclip-runner/sessions"]);
    if (!deferStartup) directories.add(config.root);
    const listeners = new Map<string, (socket: any) => void>();
    const fs = {
      constants: { O_RDONLY: 0, O_NOFOLLOW: 131072 },
      openSync(path: string, flags: number) { expect(flags).toBe(131072); if (!files.has(path)) return missing(); const fd = nextFd++; fds.set(fd, path); return fd; },
      closeSync(fd: number) { fds.delete(fd); },
      fstatSync(fd: number) { const value = fs.lstatSync(fds.get(fd)!); return { ...value, size: BigInt(value.size) }; },
      readFileSync(path: string | number, encoding?: string) {
        if (typeof path === "number") path = fds.get(path)!;
        let value: Buffer | undefined;
        if (path === "/proc/sys/kernel/random/boot_id") value = Buffer.from(bootId);
        else if (path.startsWith("/proc/")) {
          const [, , raw, field] = path.split("/"), p = proc.get(Number(raw)); if (!p) return missing();
          if (field === "stat") value = Buffer.from(`${raw} (runner) S ${p.ppid} ${p.group} ${Array(16).fill("0").join(" ")} ${p.ticks}`);
          if (field === "cmdline") value = Buffer.from(p.argv.join("\0") + "\0");
          if (field === "exe") value = Buffer.from("runnerd");
        } else value = files.get(path);
        if (!value) return missing(); return encoding ? value.toString() : value;
      },
      lstatSync(path: string) {
        const directory = directories.has(path);
        if (!directory && !files.has(path) && !symbolicLinks.has(path)) return missing();
        return { dev: 1n, ino: path === config.root ? 2n : path === "/workspace/.paperclip-runtime/paperclip-runner" ? runtimeInode : 3n, mtimeNs: 4n, ctimeNs: 5n, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => symbolicLinks.has(path), size: files.get(path)?.length ?? 0 };
      },
      realpathSync: (path: string) => path,
      readdirSync(path: string) { if (path === "/proc") return [...proc.keys()].map(String); if (path === "/workspace") return [".paperclip-runtime", ...[...files.keys(), ...symbolicLinks].filter(p => p.startsWith("/workspace/") && !p.slice(11).includes("/")).map(p => p.slice(11))]; if (path === "/workspace/.paperclip-runtime") return ["reusable-sandbox-lease.json", "paperclip-runner", ...[...files.keys()].filter(p => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/") && !p.endsWith("reusable-sandbox-lease.json")).map(p => p.slice(path.length + 1))]; if (path.startsWith("/workspace/.paperclip-runtime/paperclip-runner")) throw new Error("excluded runtime must not be traversed"); return []; },
      watch(path: string, options: unknown, callback?: (_kind: string, name: string | null) => void) {
        const entry = { path, callback: (callback ?? options) as (_kind: string, name: string | null) => void, closed: false }; watches.push(entry);
        return Object.assign(new EventEmitter(), { close: () => { entry.closed = true; } });
      },
      mkdirSync: vi.fn((path: string) => {
        if (!directories.has(path.slice(0, path.lastIndexOf("/")))) return missing();
        if (directories.has(path) || files.has(path)) throw new Error("EEXIST");
        directories.add(path);
      }),
      existsSync: (path: string) => directories.has(path) || files.has(path) || listeners.has(path),
      writeFileSync(path: string, content: string, opts: { flag: string }) {
        if (!directories.has(path.slice(0, path.lastIndexOf("/")))) return missing();
        if (opts.flag === "wx" && files.has(path)) throw new Error("EEXIST"); files.set(path, Buffer.from(content));
        for (const w of watches) if (!w.closed && path.slice(0, path.lastIndexOf("/")) === w.path) w.callback("rename", path.slice(w.path.length + 1));
      },
      rmSync: vi.fn(),
    };
    const server = {
      listen: vi.fn((path: string) => {
        if (!directories.has(path.slice(0, path.lastIndexOf("/")))) return missing();
        if (listeners.has(path)) throw new Error("EADDRINUSE");
        listeners.set(path, handlers.at(-1)!);
      }),
      close: vi.fn(() => listeners.clear()),
    };
    const net = { createServer(fn: (socket: any) => void) { handlers.push(fn); return server; } };
    const context = {
      require(name: string) { if (name === "node:fs") return fs; if (name === "node:net") return net; if (name === "node:child_process") return { spawn: vi.fn(() => { const child = Object.assign(new EventEmitter(), { pid: 88, exitCode: null, signalCode: null, kill: vi.fn() }); children.push(child); return child; }) }; if (name === "node:path") return { join: (...paths: string[]) => paths.join("/"), dirname: (path: string) => path.slice(0, path.lastIndexOf("/")), basename: (path: string) => path.slice(path.lastIndexOf("/") + 1) }; if (name === "node:crypto") return { createHash }; throw new Error("unexpected module"); },
      process: { argv: ["node", `${config.root}/observer.cjs`, Buffer.from(JSON.stringify(config)).toString("base64")], execPath: "/node", hrtime: { bigint: () => 12345n }, exit: vi.fn() },
      Buffer, __filename: `${config.root}/observer.cjs`,
      setInterval(fn: () => void) { intervals.push(fn); return 1; }, clearInterval: vi.fn(),
      setTimeout(fn: () => void, ms: number) { timers.push({ fn, ms }); return { unref() {} }; },
    };
    if (deferStartup) files.delete(`${config.root}/observer.cjs`);
    else new Script(source).runInNewContext(context);
    function request(op: string, args: Record<string, unknown> = {}) {
      const replies: any[] = [], socket = Object.assign(new EventEmitter(), { end: (value: string) => replies.push(JSON.parse(value)), destroy: vi.fn() });
      handlers[0]!(socket); socket.emit("data", Buffer.from(JSON.stringify({ op, nonce: config.nonce, ...args }) + "\n")); return replies;
    }
    return { request, proc, files, watches, fs, intervals, timers, config, handlers, children, symbolicLinks, context, server, directories, listeners, install: h.calls.find(c => c.request.op === "install")!, replaceRuntimeRoot() { runtimeInode = 999n; } };
  }
  async function generatedRpc(o: Awaited<ReturnType<typeof observerHarness>>, request: Record<string, unknown>, mutateSource = (source: string) => source) {
    const quoted = o.install.command.match(/ -e (.+) '[A-Za-z0-9+/=]+'$/su)![1]!;
    const source = quoted.slice(1, -1).replaceAll("'\\''", "'");
    const forwarded: string[] = [], connections: Array<{ client: any; observer: any }> = [];
    let output = "";
    const process = { argv: ["node", Buffer.from(JSON.stringify(request)).toString("base64")], execPath: "/node", exitCode: 0, exit: vi.fn(), stdout: { write: (value: string) => { output += value; } } };
    const spawn = vi.fn((_node: string, argv: string[]) => {
      expect(argv[0]).toBe(`${o.config.root}/observer.cjs`);
      // Execute the actual installed observer, using its actual serialized config.
      o.context.process.argv = ["node", ...argv];
      new Script(o.files.get(argv[0]!)!.toString()).runInNewContext(o.context);
      return { unref: vi.fn() };
    });
    const fs = { ...o.fs,
      readFileSync(path: string, encoding?: string) { return path === "/node" ? Buffer.from("node") : o.fs.readFileSync(path, encoding); } };
    const net = { connect(path: string) {
      expect(path).toBe(`${o.config.root}/control.sock`);
      const client: any = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), destroy: vi.fn() });
      const handler = o.listeners.get(path);
      if (!handler) { queueMicrotask(() => client.emit("error", new Error("ECONNREFUSED"))); return client; }
      const observer: any = Object.assign(new EventEmitter(), {
        end(value: string) { client.emit("data", Buffer.from(value)); client.emit("end"); observer.emit("close"); },
        destroy: vi.fn(() => { client.emit("error", new Error("observer closed socket")); observer.emit("close"); }),
      });
      client.write = (value: string) => { forwarded.push(value); observer.emit("data", Buffer.from(value)); };
      connections.push({ client, observer }); handler(observer);
      queueMicrotask(() => client.emit("connect")); return client;
    } };
    new Script(mutateSource(source)).runInNewContext({ require(name: string) {
      if (name === "node:fs") return fs;
      if (name === "node:net") return net;
      if (name === "node:child_process") return { spawn };
      if (name === "node:crypto") return { createHash };
      throw new Error("unexpected RPC module");
    }, process, Buffer, setTimeout: (fn: () => void, ms: number) => {
      // Advance only the bounded readiness polls; retain watchdogs as inert VM timers.
      if (ms === 10 || ms === 50) queueMicrotask(fn);
      return { unref() {} };
    } });
    await new Promise<void>(resolve => setImmediate(resolve));
    return { output, process, forwarded, spawn, connections };
  }
  it("executes readiness and installation after the actual pinned tsx production transform", async () => {
    const modulePath = fileURLToPath(new URL("./remote-native-fixtures.ts", import.meta.url));
    const loaderPath = fileURLToPath(new URL("../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url));
    const script = `
      import { bindRemoteNativeFixture } from ${JSON.stringify(modulePath)};
      const binding = ${JSON.stringify(binding)}, ready = ${JSON.stringify(readiness())};
      const lease = { id: binding.leaseId, companyId: binding.companyId, environmentId: binding.environmentId, heartbeatRunId: binding.runId,
        provider: 'daytona', providerLeaseId: binding.sandboxId, status: 'active', releasedAt: null,
        metadata: { sandboxId: binding.sandboxId, image: binding.image, reuseLease: false, remoteCwd: binding.remoteCwd,
          workspaceSentinel: { path: binding.remoteCwd+'/.paperclip-runtime/reusable-sandbox-lease.json', token: 'fixture-sentinel-token', result: 'written', runId: binding.runId, providerLeaseId: binding.sandboxId } } };
      let programs;
      const sandbox = { id: binding.sandboxId, labels: { 'paperclip-provider':'daytona','paperclip-company-id':binding.companyId,'paperclip-environment-id':binding.environmentId,'paperclip-run-id':binding.runId,'paperclip-reuse-lease':'false' },
        process: { async executeCommand(command) {
          const encoded = command.slice(command.lastIndexOf(" '")+2,-1), request = JSON.parse(Buffer.from(encoded,'base64'));
          if(request.op==='runtime-ready') return {exitCode:0,result:JSON.stringify({ok:true,result:ready})};
          if(request.op==='install') programs = { command, observer:request.source };
          return {exitCode:0,result:JSON.stringify({ok:true,result:request.op==='close'?{closed:true}:{}})};
        } } };
      try { await bindRemoteNativeFixture({ authority: ${JSON.stringify(authority)}, api:{get:async p=>p.includes('/environments/')?[lease]:lease}, daytona:{get:async()=>sandbox},
        sdkVersion:'0.203.0',nodeSha256:${JSON.stringify(hash("node"))},runnerdSha256:${JSON.stringify(hash("runnerd"))},targets:['result.txt'],actionFile:'action.txt',deadlineAt:Date.now()+82000 }); } catch {}
      if(!programs) throw Error('No captured generated programs');
      process.stdout.write(JSON.stringify(programs));
    `;
    const transformed = JSON.parse(execFileSync(process.execPath, ["--import", loaderPath, "--input-type=module", "-e", script], {
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TSX_DISABLE_CACHE: "1" }, timeout: 10_000, maxBuffer: 256 * 1024, encoding: "utf8",
    }));
    expect(transformed.command).not.toContain("__name("); expect(transformed.observer).not.toContain("__name(");
    const o = await observerHarness(true, transformed);
    const ready = await generatedRpc(o, { ...o.install.request, op: "runtime-ready" });
    expect(JSON.parse(ready.output)).toEqual({ ok: true, result: readiness() });
    const installed = await generatedRpc(o, o.install.request);
    expect(installed.process.exitCode).toBe(0); expect(JSON.parse(installed.output).result.complete).toBe(true);
    const closed = await generatedRpc(o, { op: "close", root: o.config.root, nonce: o.config.nonce, nodeSha256: hash("node"), timeoutMs: 10_000 });
    expect(JSON.parse(closed.output)).toEqual({ ok: true, result: { closed: true } });
    o.timers.find(t => t.ms === 100)!.fn(); expect(o.watches.every(w => w.closed)).toBe(true);
  });
  it("executes the actual readiness probe without creating an observer, then revalidates its exact identity at install", async () => {
    const o = await observerHarness(true);
    const ready = await generatedRpc(o, { ...o.install.request, op: "runtime-ready" });
    expect(JSON.parse(ready.output)).toEqual({ ok: true, result: readiness() });
    expect(ready.spawn).not.toHaveBeenCalled(); expect(o.fs.mkdirSync).not.toHaveBeenCalled(); expect(o.watches).toHaveLength(0);
    o.replaceRuntimeRoot();
    const changed = await generatedRpc(o, o.install.request);
    expect(JSON.parse(changed.output).diagnostic.code).toBe("runtime_identity_changed");
    expect(changed.spawn).not.toHaveBeenCalled(); expect(o.fs.mkdirSync).not.toHaveBeenCalled();
  });
  it.each(["absent", "foreign-run", "foreign-group", "ambiguous", "wrong-binary", "symlink", "disappeared"])("checks generated runtime readiness: %s", async variant => {
    const o = await observerHarness(true), runtimePath = "/workspace/.paperclip-runtime/paperclip-runner";
    if (variant === "absent") o.directories.delete(runtimePath);
    if (variant === "foreign-run") o.proc.get(21)!.argv[2] = "foreign";
    if (variant === "foreign-group") o.proc.get(21)!.group = 99;
    if (variant === "ambiguous") o.proc.set(22, { ...o.proc.get(21)!, group: 22 });
    if (variant === "symlink") o.symbolicLinks.add(runtimePath);
    if (variant === "disappeared") o.proc.clear();
    const request = { ...o.install.request, op: variant === "disappeared" ? "install" : "runtime-ready", config: { ...o.config, ...(variant === "wrong-binary" ? { runnerdSha256: hash("wrong") } : {}) } };
    const result = await generatedRpc(o, request), parsed = JSON.parse(result.output);
    if (["absent", "foreign-run", "foreign-group"].includes(variant)) expect(parsed).toEqual({ ok: true, result: { ready: false } });
    else expect(parsed).toEqual({ ok: false, diagnostic: { phase: request.op, code: { ambiguous: "ambiguous_run_root", "wrong-binary": "runtime_binary_identity", symlink: "runtime_root_identity", disappeared: "runtime_not_ready" }[variant] } });
    expect(result.spawn).not.toHaveBeenCalled(); expect(o.fs.mkdirSync).not.toHaveBeenCalled();
  });
  it("uses the closed read phase for actual generated socket errors", async () => {
    const o = await observerHarness(true);
    const read = await generatedRpc(o, { op: "read", root: o.config.root, nonce: o.config.nonce, nodeSha256: hash("node"), timeoutMs: 10_000, path: "result.txt" });
    expect(JSON.parse(read.output)).toEqual({ ok: false, diagnostic: { phase: "read", code: "socket_error" } });
    expect(read.spawn).not.toHaveBeenCalled();
  });
  it("executes generated install through the bounded observer socket, then closes the exact observer", async () => {
    const o = await observerHarness(true);
    expect(Buffer.byteLength(o.install.request.source)).toBeGreaterThan(8192);
    const installed = await generatedRpc(o, o.install.request);
    expect(installed.process.exitCode).toBe(0);
    const baseline = JSON.parse(installed.output);
    expect(baseline.ok).toBe(true); expect(baseline.result.complete).toBe(true);
    expect(baseline.result.processes.root).toMatchObject({ ...root, group: 21, state: "S" });
    // Feed the actual generated observer receipt through the real host reader,
    // including parseRemoteProcStat's extra fields and different key order.
    const h = harness(); h.override(request => request.op === "install" ? { exitCode: 0, result: installed.output } : undefined);
    const fixture = await bindRemoteNativeFixture(h.options);
    expect(fixture.baseline.processes.root).toEqual(baseline.result.processes.root);
    await fixture.close();
    expect(installed.spawn).toHaveBeenCalledTimes(1);
    expect(installed.forwarded.map(value => JSON.parse(value))).toEqual([{ op: "snapshot", nonce: o.config.nonce }]);
    expect(Buffer.byteLength(installed.forwarded[0]!)).toBeLessThan(8192);
    const closed = await generatedRpc(o, { op: "close", root: o.config.root, nonce: o.config.nonce, nodeSha256: hash("node"), timeoutMs: 10_000 });
    expect(closed.process.exitCode).toBe(0); expect(JSON.parse(closed.output)).toEqual({ ok: true, result: { closed: true } });
    expect(closed.spawn).not.toHaveBeenCalled();
    expect(closed.forwarded[0]).not.toContain('"source"'); expect(closed.forwarded[0]).not.toContain('"config"');
    expect(o.watches.length).toBeGreaterThan(0); expect(o.watches.every(w => w.closed)).toBe(true);
    expect(o.context.clearInterval).toHaveBeenCalled(); expect(o.server.close).toHaveBeenCalled();
    o.timers.find(t => t.ms === 100)!.fn();
    expect(closed.connections[0]!.observer.destroy).toHaveBeenCalled();
    expect(o.fs.rmSync).toHaveBeenCalledExactlyOnceWith(o.config.root, { recursive: true, force: true });
    expect(o.context.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("rejects a generated install mutant that omits its parent directory creation", async () => {
    const o = await observerHarness(true);
    const installed = await generatedRpc(o, o.install.request, source => {
      const mutant = source.replace("fs.mkdirSync(c.root,{mode:0o700});", "");
      expect(mutant).not.toBe(source); return mutant;
    });
    expect(installed.process.exitCode).toBe(2); expect(JSON.parse(installed.output).diagnostic).toEqual({ phase: "install", code: "remote_unknown" });
    expect(installed.spawn).not.toHaveBeenCalled(); expect(installed.connections).toHaveLength(0);
    expect(o.files.has(`${o.config.root}/observer.cjs`)).toBe(false);
    expect(o.directories.has(o.config.root)).toBe(false); expect(o.watches).toHaveLength(0);
  });
  it("rejects a generated observer mutant that never listens, even after handler registration", async () => {
    const o = await observerHarness(true);
    const source = o.install.request.source as string;
    const mutant = source.replace("server.listen(path.join(config.root,'control.sock'));", "");
    expect(mutant).not.toBe(source);
    const installed = await generatedRpc(o, { ...o.install.request, source: mutant });
    expect(installed.process.exitCode).toBe(2); expect(JSON.parse(installed.output).diagnostic).toEqual({ phase: "install", code: "socket_error" });
    expect(installed.spawn).toHaveBeenCalledTimes(1); expect(o.handlers).toHaveLength(1);
    expect(o.server.listen).not.toHaveBeenCalled(); expect(o.listeners.size).toBe(0);
    expect(installed.connections).toHaveLength(0); expect(installed.forwarded).toHaveLength(0);
    // A failed connection cannot close the unlistening observer. Its owned TTL still retires it.
    o.timers.find(t => t.ms > 1000)!.fn(); o.timers.find(t => t.ms === 100)!.fn();
    expect(o.watches.every(w => w.closed)).toBe(true);
    expect(o.fs.rmSync).toHaveBeenCalledExactlyOnceWith(o.config.root, { recursive: true, force: true });
    expect(o.context.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("still rejects an oversized control request and can close its observer afterward", async () => {
    const o = await observerHarness();
    const oversized = await generatedRpc(o, { op: "snapshot", root: o.config.root, nonce: o.config.nonce, nodeSha256: hash("node"), timeoutMs: 10_000, unexpected: "x".repeat(8192) });
    expect(oversized.process.exitCode).toBe(2); expect(JSON.parse(oversized.output).diagnostic).toEqual({ phase: "snapshot", code: "socket_error" });
    expect(oversized.connections[0]!.observer.destroy).toHaveBeenCalled();
    const closed = await generatedRpc(o, { op: "close", root: o.config.root, nonce: o.config.nonce, nodeSha256: hash("node"), timeoutMs: 10_000 });
    expect(JSON.parse(closed.output)).toEqual({ ok: true, result: { closed: true } });
    o.timers.find(t => t.ms === 100)!.fn();
    expect(o.watches.every(w => w.closed)).toBe(true); expect(o.context.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("acknowledges receipt-channel readiness only after the long waiter connects", async () => {
    const o = await observerHarness(); const arm = o.request("arm"); expect(arm).toHaveLength(0);
    o.request("wait"); expect(arm).toEqual([{ ok: true, result: { armed: true, sealed: false } }]);
    o.proc.set(1, { ppid: 0, group: 1, ticks: "1", argv: ["/sbin/init"] });
    expect(o.request("snapshot")[0].result.processes.captured).toBe(true);
  });
  it("arms exact remote root then seals drained no-live proof and retained bytes", async () => {
    const o = await observerHarness(); expect(o.request("snapshot")[0].result.processes.captured).toBe(true);
    const wait = o.request("wait"); expect(wait).toHaveLength(0);
    expect(o.request("publish", { path: "action.txt", text: "do task" })[0].ok).toBe(true);
    o.fs.writeFileSync("/workspace/result.txt", "exact 🪴\n", { flag: "wx" });
    o.proc.set(22, { ppid: 21, group: 21, ticks: "200", argv: ["/node"] }); o.intervals[0]!();
    o.proc.clear(); o.intervals[0]!(); expect(wait).toHaveLength(0); // Watch drain is mandatory.
    o.timers.find(t => t.ms === 100)!.fn();
    const final = wait[0].result;
    expect(final.complete).toBe(true); expect(final.processes.live).toEqual([]); expect(final.processes.journal.map((p: any) => p.pid)).toEqual([21, 22]);
    expect(Buffer.from(final.files["result.txt"], "base64").toString()).toBe("exact 🪴\n");
    expect(final.watcher.workspaceMutationCount).toBe(1); expect(final.workspace["action.txt"]).toBeUndefined(); expect(final.setup.sha256).toBe(hash("do task"));
    expect(o.watches.every(w => w.closed)).toBe(true);
  });
  it("links the attached client to the exact run and writes the marker only after independent child exit", async () => {
    const o = await observerHarness(); o.request("snapshot");
    const config = { marker: "result.txt", markerText: "settled", delayMs: 500, clientNonce: "test-client-nonce" };
    const fixture = o.request("attached", config)[0].result;
    o.proc.set(23, { ppid: 21, group: 21, ticks: "300", argv: ["/node", fixture.clientScript, fixture.clientSocket, config.clientNonce] });
    const replies: any[] = [], socket = Object.assign(new EventEmitter(), { end: (value: string) => replies.push(JSON.parse(value)), destroy: vi.fn() });
    o.handlers[1]!(socket); socket.emit("data", Buffer.from(JSON.stringify({ nonce: config.clientNonce, pid: 23 }) + "\n"));
    expect(o.children).toHaveLength(1); expect(replies).toHaveLength(0); expect(o.files.has("/workspace/result.txt")).toBe(false);
    o.children[0].exitCode = 0; o.children[0].emit("exit", 0, null);
    expect(replies).toEqual([{ code: 0 }]); expect(o.files.get("/workspace/result.txt")?.toString()).toBe("settled");
    o.proc.delete(23); const a = o.request("snapshot")[0].result.attached;
    expect(a.commandExit.code).toBe(0); expect(BigInt(a.commandExit.observedMonotonicNs)).toBeLessThanOrEqual(BigInt(a.markerWrittenMonotonicNs));
    expect(a.clientExitedAtMs).not.toBeNull(); expect(a.connections).toBe(1);
  });
  it("never starts attached work for a same-argv client outside the captured run", async () => {
    const o = await observerHarness(); o.request("snapshot");
    const config = { marker: "result.txt", markerText: "settled", delayMs: 500, clientNonce: "test-client-nonce" };
    const fixture = o.request("attached", config)[0].result;
    o.proc.set(23, { ppid: 1, group: 23, ticks: "300", argv: ["/node", fixture.clientScript, fixture.clientSocket, config.clientNonce] });
    const socket = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    o.handlers[1]!(socket); socket.emit("data", Buffer.from(JSON.stringify({ nonce: config.clientNonce, pid: 23 }) + "\n"));
    expect(o.children).toHaveLength(0); expect(socket.destroy).toHaveBeenCalled();
    expect(o.request("snapshot")[0].result.attached.failure).toBe("client_rejected");
  });
  it("scopes actual runtime symlinks/state churn out while retaining sentinel and sibling coverage", async () => {
    const o = await observerHarness();
    o.symbolicLinks.add("/workspace/.paperclip-runtime/paperclip-runner/provider-pack");
    o.files.set("/workspace/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd", Buffer.alloc(100000));
    o.fs.writeFileSync("/workspace/.paperclip-runtime/paperclip-runner/sessions/state.json", "runtime churn", { flag: "wx" });
    const before = o.request("snapshot")[0].result;
    expect(before.complete).toBe(true); expect(before.watcher.workspaceMutationCount).toBe(0);
    expect(Object.keys(before.workspace)).toContain(".paperclip-runtime/reusable-sandbox-lease.json");
    expect(Object.keys(before.workspace).some(p => p.startsWith(".paperclip-runtime/paperclip-runner"))).toBe(false);
    expect(before.scope.excludedRuntime.ino).toBe("4"); expect(before.scope.observedPrpEnvironmentLeaseId).toBe("workspace-id");
    expect(before.scope.prpEnvironmentLeaseIdVerified).toBe(false);
    o.fs.writeFileSync("/workspace/.paperclip-runtime/user-file", "not runtime internal", { flag: "wx" });
    const after = o.request("snapshot")[0].result;
    expect(after.watcher.workspaceMutationCount).toBe(1); expect(after.workspace[".paperclip-runtime/user-file"]).toBe(hash("not runtime internal"));
  });
  it("rejects runtime root replacement, foreign workspace symlinks and sentinel tampering", async () => {
    const replaced = await observerHarness(); replaced.replaceRuntimeRoot(); expect(replaced.request("snapshot")[0].ok).toBe(false);
    const linked = await observerHarness(); linked.symbolicLinks.add("/workspace/user-link"); expect(linked.request("snapshot")[0].ok).toBe(false);
    const sentinel = await observerHarness(); sentinel.files.set(sentinel.config.sentinel.path, Buffer.from(JSON.stringify({ token: "foreign" })));
    expect(sentinel.request("snapshot")[0].ok).toBe(false);
  });
  it("marks PID reuse incomplete rather than mistaking a new process for retired authority", async () => {
    const o = await observerHarness(); o.request("snapshot"); const wait = o.request("wait");
    o.proc.set(21, { ppid: 1, group: 99, ticks: "999", argv: ["/unrelated"] }); o.intervals[0]!(); o.timers.find(t => t.ms === 100)!.fn();
    expect(wait[0].result.complete).toBe(false); expect(wait[0].result.processes.root.startTicks).toBe("100");
    expect(wait[0].result.failureCodes).toContain("process_pid_reused");
  });
  it("counts transient workspace create/delete and rejects changed setup-file bytes", async () => {
    const o = await observerHarness(); o.request("snapshot");
    o.fs.writeFileSync("/workspace/transient.txt", "not allowed", { flag: "wx" }); o.files.delete("/workspace/transient.txt");
    for (const w of o.watches) if (w.path === "/workspace") w.callback("rename", "transient.txt");
    const snapshot = o.request("snapshot")[0].result;
    expect(snapshot.workspace["transient.txt"]).toBeUndefined(); expect(snapshot.watcher.workspaceMutationCount).toBe(2);
    o.request("publish", { path: "action.txt", text: "approved" }); o.files.set("/workspace/action.txt", Buffer.from("replacement"));
    expect(o.request("snapshot")[0].ok).toBe(false);
  });
  it("rejects ambiguous run roots and malformed observed PRP identifiers", async () => {
    const o = await observerHarness(); const p = o.proc.get(21)!;
    o.proc.set(22, { ...p, group: 22, ticks: "200" }); expect(o.request("snapshot")[0].result.complete).toBe(false);
    const other = await observerHarness(); other.proc.get(21)!.argv[4] = "bad value with spaces";
    expect(other.request("snapshot")[0].ok).toBe(false);
  });
});
