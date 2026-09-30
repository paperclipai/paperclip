import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { bindRemoteNativeFixture, createRemoteTargetWatch, isRemoteRunRoot, parseRemoteProcStat, type RemoteNativeFixtureOptions, type RemoteNativeSnapshot } from "./remote-native-fixtures.js";

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
    let result: unknown = structuredClone(current);
    if (request.op === "publish") { current.setup = { path: request.path, published: true, sha256: hash(request.text) }; result = current.setup; }
    if (request.op === "close") result = { closed: true };
    if (request.op === "arm") result = { armed: true, sealed: false };
    if (request.op === "attached") result = { clientScript: `${request.root}/client.cjs`, clientSocket: `${request.root}/attached.sock` };
    return { exitCode: 0, result: JSON.stringify({ ok: true, result }) };
  });
  const get = vi.fn(async () => ({ id: "sandbox", labels, process: { executeCommand } }));
  const apiGet = vi.fn(async (path: string) => path.includes("/environments/") ? [structuredClone(lease)] : structuredClone(lease));
  const options: RemoteNativeFixtureOptions = { api: { get: apiGet as RemoteNativeFixtureOptions["api"]["get"] }, daytona: { get }, sdkVersion: "0.203.0", authority, nodeSha256: hash("node"), runnerdSha256: hash("runnerd"), targets: ["result.txt"], actionFile: "action.txt", deadlineAt: Date.now() + 60_000 };
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
  it("arms before publish, binds long receipt before teardown and preserves exact final bytes", async () => {
    const h = harness(), f = await bindRemoteNativeFixture(h.options);
    expect(h.calls.map(c => c.request.op)).toEqual(["install", "wait", "arm"]); expect(f.baseline.processes.live).toEqual([21]);
    expect(h.calls[1]!.timeout).toBeLessThanOrEqual(45); expect(h.calls[1]!.request.timeoutMs).toBe(h.calls[1]!.timeout! * 1000);
    await f.publishAction("action.txt", "write only result.txt");
    await expect(f.publishAction("action.txt", "retry")).rejects.toThrow("publish_bound");
    const bytes = "\nUnicode 🪴 literal \\n\n";
    const final = { ...structuredClone(h.current), processes: { ...h.current.processes, live: [] }, files: { "result.txt": Buffer.from(bytes).toString("base64") } };
    final.targets["result.txt"] = { ...final.targets["result.txt"]!, absent: false, sha256: hash(bytes), mutationCount: 1 };
    h.resolveTerminal(final); h.apiGet.mockRejectedValue(new Error("lease already deleted"));
    expect((await f.finish()).processes.live).toEqual([]); expect((await f.readFile("result.txt")).toString()).toBe(bytes);
    await f.close(); expect(h.calls.map(c => c.request.op)).toEqual(["install", "wait", "arm", "publish"]);
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
    expect(h.calls.map(c => c.request.op)).toEqual(["install", "close"]);
  });
  it("refuses action publication without a confirmed receipt channel", async () => {
    const h = harness(); h.override(r => r.op === "arm" ? { exitCode: 0, result: JSON.stringify({ ok: true, result: { armed: false, sealed: false } }) } : undefined);
    await expect(bindRemoteNativeFixture(h.options)).rejects.toThrow("receipt_channel_not_armed");
    expect(h.calls.map(c => c.request.op)).toEqual(["install", "wait", "arm", "close"]);
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
    const install = h.calls[0]!; const source = install.request.source as string;
    expect(() => new Script(source)).not.toThrow(); expect(source).not.toContain("__name(");
    const rpcQuoted = install.command.match(/ -e (.+) '[A-Za-z0-9+/=]+'$/su)![1]!;
    const rpc = rpcQuoted.slice(1, -1).replaceAll("'\\''", "'");
    expect(() => new Script(rpc)).not.toThrow();
    expect(rpc).toContain("startedAt+20000"); expect(install.timeout).toBeLessThanOrEqual(27); expect(rpc).toContain("r.timeoutMs-(Date.now()-startedAt)");
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
      expect(wait.timeout).toBe(45); expect(wait.request.timeoutMs).toBe(45_000);
      expect(install.request.config.observerTtlMs).toBe(45_000); expect(install.timeout).toBe(25);
      let settled = false;
      const result = f.finish().then(() => { settled = true; return "unexpected pass"; }, error => { settled = true; return error.message; });
      await vi.advanceTimersByTimeAsync(44_999); expect(settled).toBe(false);
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
      await vi.advanceTimersByTimeAsync(42_000);
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
      const h = harness(), f = await bindRemoteNativeFixture(h.options); await vi.advanceTimersByTimeAsync(60_000);
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
  it("retains transient create/delete events and detects same-path parent replacement", async () => {
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
  async function observerHarness() {
    const h = harness(); await bindRemoteNativeFixture(h.options);
    const { source, config } = h.calls[0]!.request;
    const intervals: Array<() => void> = [], timers: Array<{ fn: () => void; ms: number }> = [];
    const proc = new Map<number, { ppid: number; group: number; ticks: string; argv: string[] }>([[21, { ppid: 1, group: 21, ticks: "100", argv: ["/workspace/.paperclip-runtime/paperclip-runner/bin/paperclip-runnerd", "--run-id", "run", "--environment-lease-id", "workspace-id", "--lifecycle-mode", "per_turn", "--state-dir", "/workspace/.paperclip-runtime/paperclip-runner/sessions/" + "a".repeat(64) + "/runner"] }]]);
    const files = new Map<string, Buffer>([[`${config.root}/observer.cjs`, Buffer.from(source)], [config.sentinel.path, Buffer.from(JSON.stringify({ version: 1, provider: "daytona", token: config.sentinel.token, companyId: "company", environmentId: "environment" }))]]);
    const watches: Array<{ path: string; callback: (_kind: string, name: string | null) => void; closed: boolean }> = [];
    const handlers: Array<(socket: any) => void> = [], children: any[] = [];
    const missing = () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
    const fds = new Map<number, string>(); let nextFd = 50, runtimeInode = 4n;
    const symbolicLinks = new Set<string>();
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
        const directory = path === config.root || path === "/workspace" || path === "/workspace/.paperclip-runtime" || path === "/workspace/.paperclip-runtime/paperclip-runner";
        if (!directory && !files.has(path) && !symbolicLinks.has(path)) return missing();
        return { dev: 1n, ino: path === config.root ? 2n : path === "/workspace/.paperclip-runtime/paperclip-runner" ? runtimeInode : 3n, mtimeNs: 4n, ctimeNs: 5n, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => symbolicLinks.has(path), size: files.get(path)?.length ?? 0 };
      },
      realpathSync: (path: string) => path,
      readdirSync(path: string) { if (path === "/proc") return [...proc.keys()].map(String); if (path === "/workspace") return [".paperclip-runtime", ...[...files.keys(), ...symbolicLinks].filter(p => p.startsWith("/workspace/") && !p.slice(11).includes("/")).map(p => p.slice(11))]; if (path === "/workspace/.paperclip-runtime") return ["reusable-sandbox-lease.json", "paperclip-runner", ...[...files.keys()].filter(p => p.startsWith(path + "/") && !p.slice(path.length + 1).includes("/") && !p.endsWith("reusable-sandbox-lease.json")).map(p => p.slice(path.length + 1))]; if (path.startsWith("/workspace/.paperclip-runtime/paperclip-runner")) throw new Error("excluded runtime must not be traversed"); return []; },
      watch(path: string, options: unknown, callback?: (_kind: string, name: string | null) => void) {
        const entry = { path, callback: (callback ?? options) as (_kind: string, name: string | null) => void, closed: false }; watches.push(entry);
        return Object.assign(new EventEmitter(), { close: () => { entry.closed = true; } });
      },
      writeFileSync(path: string, content: string, opts: { flag: string }) {
        if (opts.flag === "wx" && files.has(path)) throw new Error("EEXIST"); files.set(path, Buffer.from(content));
        for (const w of watches) if (!w.closed && path.slice(0, path.lastIndexOf("/")) === w.path) w.callback("rename", path.slice(w.path.length + 1));
      },
      rmSync: vi.fn(),
    };
    const server = { listen: vi.fn(), close: vi.fn() };
    const net = { createServer(fn: (socket: any) => void) { handlers.push(fn); return server; } };
    const context = {
      require(name: string) { if (name === "node:fs") return fs; if (name === "node:net") return net; if (name === "node:child_process") return { spawn: vi.fn(() => { const child = Object.assign(new EventEmitter(), { pid: 88, exitCode: null, signalCode: null, kill: vi.fn() }); children.push(child); return child; }) }; if (name === "node:path") return { join: (...paths: string[]) => paths.join("/"), dirname: (path: string) => path.slice(0, path.lastIndexOf("/")), basename: (path: string) => path.slice(path.lastIndexOf("/") + 1) }; if (name === "node:crypto") return { createHash }; throw new Error("unexpected module"); },
      process: { argv: ["node", `${config.root}/observer.cjs`, Buffer.from(JSON.stringify(config)).toString("base64")], execPath: "/node", hrtime: { bigint: () => 12345n }, exit: vi.fn() },
      Buffer, __filename: `${config.root}/observer.cjs`,
      setInterval(fn: () => void) { intervals.push(fn); return 1; }, clearInterval: vi.fn(),
      setTimeout(fn: () => void, ms: number) { timers.push({ fn, ms }); return { unref() {} }; },
    };
    new Script(source).runInNewContext(context);
    function request(op: string, args: Record<string, unknown> = {}) {
      const replies: any[] = [], socket = Object.assign(new EventEmitter(), { end: (value: string) => replies.push(JSON.parse(value)), destroy: vi.fn() });
      handlers[0]!(socket); socket.emit("data", Buffer.from(JSON.stringify({ op, nonce: config.nonce, ...args }) + "\n")); return replies;
    }
    return { request, proc, files, watches, fs, intervals, timers, config, handlers, children, symbolicLinks, replaceRuntimeRoot() { runtimeInode = 999n; } };
  }
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
