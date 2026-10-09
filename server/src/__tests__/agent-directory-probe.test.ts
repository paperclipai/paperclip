import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import childProcess, { execFileSync } from "node:child_process";
import { prepareAdapterExecutionTargetRuntime } from "@paperclipai/adapter-utils/execution-target";
import { captureDirectorySnapshot } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { prepareSandboxManagedRuntime } from "@paperclipai/adapter-utils/sandbox-managed-runtime";
import { agentDirectoryBaselineDigest, agentDirectoryProbeProgram, observeLocalAgentDirectory, probeAgentDirectory, retireAgentDirectoryTransferScratch, agentDirectoryTransferCleanupProgram } from "../services/agent-directory-probe.js";

describe("stable live agent directory observation", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "agent-directory-probe-")));
    fs.mkdirSync(join(root, "notes"));
    fs.writeFileSync(join(root, "AGENTS.md"), "Instructions\n");
    fs.writeFileSync(join(root, "notes", "memory.bin"), Buffer.from([0, 1, 255]));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
  function productionPrograms(): { probe: string; cleanup: string } {
    // Product/dev starts the server with tsx. Vitest's own transform does not
    // reproduce the lexical helpers injected into function.toString() there.
    const loader = createRequire(import.meta.url).resolve("tsx");
    const source = new URL("../services/agent-directory-probe.ts", import.meta.url).href;
    const program = `import { agentDirectoryProbeProgram, agentDirectoryTransferCleanupProgram } from ${JSON.stringify(source)}; process.stdout.write(JSON.stringify({probe:agentDirectoryProbeProgram,cleanup:agentDirectoryTransferCleanupProgram}));`;
    return JSON.parse(execFileSync(process.execPath, ["--import", loader, "--input-type=module", "--eval", program], {
      cwd: root, env: { TSX_DISABLE_CACHE: "1", HOME: root, TMPDIR: root }, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    }));
  }
  it("runs a self-contained live probe after the production tsx transform", () => {
    const { probe } = productionPrograms();
    const observe = () => JSON.parse(execFileSync(process.execPath, ["-e", probe, root], {
      env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, stdio: "pipe",
    }));
    const before = probeAgentDirectory(root);
    expect(observe()).toEqual(before);
    fs.writeFileSync(join(root, "AGENTS.md"), "Changed instructions\n");
    expect(observe()).toEqual(probeAgentDirectory(root));
    expect(observe().digest).not.toBe(before.digest);
    fs.symlinkSync(join(root, "AGENTS.md"), join(root, "unsafe"));
    expect(observe).toThrow();
  });
  it("runs bounded transfer cleanup after the production tsx transform", () => {
    const { cleanup } = productionPrograms();
    const scratch = join(root, ".paperclip-runtime", "agent-files");
    const retire = () => execFileSync(process.execPath, ["-e", cleanup, root], {
      env: {}, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, stdio: "pipe",
    });
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(join(scratch, "unexpected"), "retain");
    expect(retire).toThrow();
    expect(fs.readFileSync(join(scratch, "unexpected"), "utf8")).toBe("retain");
    fs.unlinkSync(join(scratch, "unexpected"));
    retire();
    expect(fs.existsSync(join(root, ".paperclip-runtime"))).toBe(false);
    expect(fs.readFileSync(join(root, "AGENTS.md"), "utf8")).toBe("Instructions\n");
    expect(fs.readFileSync(join(root, "notes", "memory.bin"))).toEqual(Buffer.from([0, 1, 255]));
  });
  it("matches the complete materialized baseline and the actual remote Node program", async () => {
    const baseline = await captureDirectorySnapshot(root);
    const observed = probeAgentDirectory(root);
    expect(observed.digest).toBe(agentDirectoryBaselineDigest(baseline));
    const remote = JSON.parse(execFileSync(process.execPath, ["-e", agentDirectoryProbeProgram, root], { encoding: "utf8", env: {}, timeout: 10_000 }));
    expect(remote).toEqual(observed);
  });
  it.runIf(process.platform === "darwin")("accepts only the observing Darwin host's fixed system aliases", () => {
    const alias = root.replace(/^\/private(?=\/(tmp|var|etc)\/)/, "");
    expect(alias).not.toBe(root);
    const observed = probeAgentDirectory(root);
    expect(probeAgentDirectory(alias)).toEqual(observed);
    const remote = JSON.parse(execFileSync(process.execPath, ["-e", agentDirectoryProbeProgram, alias], { encoding: "utf8", env: {}, timeout: 10_000 }));
    expect(remote).toEqual(observed);
    // A Linux remote cannot inherit the controller's Darwin exception.
    expect(() => execFileSync(process.execPath, ["-e", agentDirectoryProbeProgram.replace("platform:process.platform", "platform:'linux'"), alias],
      { encoding: "utf8", env: {}, timeout: 10_000, stdio: "pipe" })).toThrow();
    fs.symlinkSync(root, join(root, "redirect"));
    expect(() => probeAgentDirectory(`${alias}/redirect`)).toThrow();
  });
  it("observes the complete agent directory after the actual remote transfer", async () => {
    const remote = `${root}-remote`;
    fs.mkdirSync(remote);
    const target = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd: remote,
      runner: { execute: async (input: Parameters<import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner["execute"]>[0]) => ({
        stdout: execFileSync(input.command, input.args ?? [], { cwd: input.cwd, input: input.stdin, encoding: "utf8",
          env: { PATH: process.env.PATH, ...input.env }, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 }),
        stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(),
      }) } };
    let runtime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | undefined;
    try {
      const baseline = await captureDirectorySnapshot(root);
      runtime = await prepareAdapterExecutionTargetRuntime({ target, runId: "probe-transfer", adapterKey: "agent-files",
        workspaceLocalDir: root, workspaceRemoteDir: remote, syncWorkspace: true, workspaceBaseline: baseline,
        workspaceGitSnapshot: null, workspaceFileMode: "all", workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
      expect(fs.readdirSync(`${remote}/.paperclip-runtime`)).toEqual(["agent-files"]);
      expect(fs.readdirSync(`${remote}/.paperclip-runtime/agent-files`)).toEqual([]);
      execFileSync(process.execPath, ["-e", agentDirectoryTransferCleanupProgram, remote], { env: {}, timeout: 10_000 });
      expect(() => probeAgentDirectory(remote)).not.toThrow();
      expect(probeAgentDirectory(remote).digest).toBe(agentDirectoryBaselineDigest(baseline));
    } finally { await runtime?.cleanupWorkspaceSnapshot?.(); fs.rmSync(remote, { recursive: true, force: true }); }
  });
  it("keeps restart fallback transfer scratch outside the native memory directory", async () => {
    const remoteCwd = `${root}-remote`;
    const agentHome = join(remoteCwd, ".paperclip-runtime", "agent-files", "agent", "original-run");
    const scratch = join(remoteCwd, ".paperclip-runtime", "paperclip-runner", "agent-file-transfers", "agent", "original-run");
    fs.mkdirSync(agentHome, { recursive: true });
    fs.cpSync(root, agentHome, { recursive: true });
    const target = { kind: "remote" as const, transport: "sandbox" as const, remoteCwd,
      // A newly bound controller target may have no native sync hooks. Exercise
      // the production command/base64 fallback rather than a transport mock.
      runner: { execute: async (input: Parameters<import("@paperclipai/adapter-utils/command-managed-runtime").CommandManagedRuntimeRunner["execute"]>[0]) => ({
        stdout: execFileSync(input.command, input.args ?? [], { cwd: input.cwd, input: input.stdin, encoding: "utf8",
          env: { PATH: process.env.PATH, ...input.env }, timeout: input.timeoutMs, maxBuffer: 32 * 1024 * 1024 }),
        stderr: "", exitCode: 0, signal: null, timedOut: false, pid: null, startedAt: new Date().toISOString(),
      }) } };
    let runtime: Awaited<ReturnType<typeof prepareAdapterExecutionTargetRuntime>> | undefined;
    try {
      const baseline = await captureDirectorySnapshot(root);
      runtime = await prepareAdapterExecutionTargetRuntime({ target, runId: "restart-transfer", adapterKey: "agent-files",
        workspaceLocalDir: root, workspaceRemoteDir: agentHome, runtimeRootDir: scratch,
        syncWorkspace: true, workspaceInboundMode: "adopt_remote", workspaceBaseline: baseline,
        workspaceGitSnapshot: null, workspaceFileMode: "all", workspaceExclude: [".paperclip-runtime", ".paperclip-runtime/**"] });
      const memory = "0123456789abcdef0123456789abcdef\n";
      fs.writeFileSync(join(agentHome, "notes", "memory.txt"), memory);
      await runtime.restoreWorkspace();
      expect(fs.readFileSync(join(root, "notes", "memory.txt"), "utf8")).toBe(memory);
      // A transfer must not introduce a reserved path that the product's own
      // full agent-directory probe rejects, including after controller recovery.
      expect(() => probeAgentDirectory(agentHome)).not.toThrow();
      expect(fs.existsSync(join(agentHome, ".paperclip-runtime"))).toBe(false);
      expect(runtime.runtimeRootDir).toBe(scratch);
      expect(fs.readdirSync(scratch)).toEqual([]);
    } finally { await runtime?.cleanupWorkspaceSnapshot?.(); fs.rmSync(remoteCwd, { recursive: true, force: true }); }
  });
  it.each(["outside", "reserved-root", "relative", "traversal", "trailing-slash", "nul"])("rejects %s transfer scratch before filesystem work", async kind => {
    const reserved = join(root, ".paperclip-runtime");
    const invalid = {
      outside: `${root}-foreign/scratch`, "reserved-root": reserved, relative: ".paperclip-runtime/scratch",
      traversal: `${reserved}/../../scratch`, "trailing-slash": `${reserved}/scratch/`, nul: `${reserved}/scratch\0`,
    }[kind]!;
    await expect(prepareSandboxManagedRuntime({
      spec: { transport: "sandbox", provider: "fixture", sandboxId: "owned", remoteCwd: root, apiKey: null },
      adapterKey: "agent-files", client: {} as never, workspaceLocalDir: root, runtimeRootDir: invalid,
    })).rejects.toThrow("Transfer scratch must remain within the lease runtime tree");
    expect(fs.existsSync(reserved)).toBe(false);
  });
  it.each(["file", "extra-directory", "symlink", "race"])("fails closed on %s in transfer-owned scratch without deleting contents", kind => {
    const parent = join(root, ".paperclip-runtime"), scratch = join(parent, "agent-files");
    fs.mkdirSync(scratch, { recursive: true });
    const retained = join(parent, "retained.txt");
    if (kind === "file") fs.writeFileSync(join(scratch, "retained.txt"), "keep");
    if (kind === "extra-directory") fs.mkdirSync(join(parent, "unknown"));
    if (kind === "symlink") { fs.rmdirSync(scratch); fs.symlinkSync(join(root, "notes"), scratch); }
    if (kind === "race") {
      const rmdir = fs.rmdirSync;
      vi.spyOn(fs, "rmdirSync").mockImplementation(((directory: fs.PathLike) => {
        if (directory === scratch) fs.writeFileSync(retained, "concurrent bytes");
        return rmdir(directory);
      }) as typeof rmdir);
    }
    expect(() => retireAgentDirectoryTransferScratch(root)).toThrow();
    expect(fs.existsSync(parent)).toBe(true);
    if (kind === "file") expect(fs.readFileSync(join(scratch, "retained.txt"), "utf8")).toBe("keep");
    if (kind === "race") expect(fs.readFileSync(retained, "utf8")).toBe("concurrent bytes");
    expect(fs.existsSync(join(root, "notes", "memory.bin"))).toBe(true);
  });
  it("runs the local observation in its bounded credential-free child", async () => {
    expect(await observeLocalAgentDirectory(root)).toEqual(probeAgentDirectory(root));
  });
  it.each(["timeout", "oversized", "malformed"])("rejects %s local-child observations", async kind => {
    const stub = vi.spyOn(childProcess, "execFile").mockImplementation(((file: string, args: string[], options: object, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      expect(file).toBe(process.execPath);
      expect(args).toEqual(["-e", agentDirectoryProbeProgram, root]);
      expect(options).toMatchObject({ cwd: root, env: {}, timeout: 10_000, maxBuffer: 1024, killSignal: "SIGKILL" });
      callback(kind === "timeout" ? Object.assign(new Error("timed out"), { killed: true, signal: "SIGKILL" }) : null,
        kind === "oversized" ? "x".repeat(1025) : "{}", "");
      return {} as childProcess.ChildProcess;
    }) as typeof childProcess.execFile);
    await expect(observeLocalAgentDirectory(root)).rejects.toThrow();
    expect(stub).toHaveBeenCalledOnce();
  });
  it.each(["edit", "add", "remove", "mode"])("detects a legitimate %s", change => {
    const before = probeAgentDirectory(root);
    if (change === "edit") fs.writeFileSync(join(root, "AGENTS.md"), "New instructions\n");
    if (change === "add") fs.writeFileSync(join(root, "new.txt"), "New");
    if (change === "remove") fs.unlinkSync(join(root, "notes", "memory.bin"));
    if (change === "mode") fs.chmodSync(join(root, "AGENTS.md"), 0o700);
    expect(probeAgentDirectory(root).digest).not.toBe(before.digest);
  });
  it.each(["symlink", "hardlink", "reserved"])("rejects %s entries", kind => {
    if (kind === "symlink") fs.symlinkSync(join(root, "AGENTS.md"), join(root, "unsafe"));
    if (kind === "hardlink") fs.linkSync(join(root, "AGENTS.md"), join(root, "unsafe"));
    if (kind === "reserved") fs.mkdirSync(join(root, ".paperclip-runtime"));
    expect(() => probeAgentDirectory(root)).toThrow();
  });
  it("detects file mutation during a bounded read", () => {
    const read = fs.readSync;
    let changed = false;
    vi.spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof read>) => {
      const result = Reflect.apply(read, fs, args);
      if (!changed) { changed = true; fs.appendFileSync(join(root, "AGENTS.md"), "Concurrent change"); }
      return result;
    }) as typeof read);
    expect(() => probeAgentDirectory(root)).toThrow(/changed|grew/);
  });
  it("fails on unreadable observations instead of reporting unchanged", () => {
    vi.spyOn(fs, "openSync").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
    expect(() => probeAgentDirectory(root)).toThrow("denied");
  });
  it("does not let matching replacement bytes preserve the pinned root identity", () => {
    const before = probeAgentDirectory(root);
    const retired = `${root}-retired`;
    fs.renameSync(root, retired);
    try { fs.cpSync(retired, root, { recursive: true }); expect(probeAgentDirectory(root).identity).not.toBe(before.identity); }
    finally { fs.rmSync(retired, { recursive: true, force: true }); }
  });
  it("rejects excluded/incomplete baselines", async () => {
    const baseline = await captureDirectorySnapshot(root);
    expect(() => agentDirectoryBaselineDigest({ ...baseline, exclude: ["notes"] })).toThrow("Incomplete");
  });
});
