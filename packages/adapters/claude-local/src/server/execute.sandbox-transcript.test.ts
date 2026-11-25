import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const execFileAsync = promisify(execFile);

/**
 * Stands in for the sandbox provider: each lease is a fresh local directory,
 * the runtime asset upload copies the staged directories into it, and shell
 * commands run in it. Claude itself is faked: it writes a transcript under
 * CLAUDE_CONFIG_DIR and refuses `--resume` of a session it has no transcript for.
 */
const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    prepareAdapterExecutionTargetRuntime,
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => null),
  };
});

import { execute } from "./execute.js";
import { resetClaudeCliCapabilitiesCacheForTests } from "./cli-capabilities.js";
import { resolveClaudeTranscriptStorePath } from "./sandbox-session-transcript.js";

type Asset = {
  key: string;
  localDir: string;
  restore?: (ctx: { assetDir: string; readFile: (remotePath: string) => Promise<Buffer> }) => Promise<void>;
};

function result(stdout: string, exitCode = 0): RunProcessResult {
  return { exitCode, signal: null, timedOut: false, stdout, stderr: "", pid: null, startedAt: new Date().toISOString() };
}

function encodeCwd(cwd: string) {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

function createLease(leaseRoot: string, leaseId: string, claudeRuns: string[][]): AdapterSandboxExecutionTarget {
  const remoteCwd = path.join(leaseRoot, "workspace");
  const runner = {
    execute: vi.fn(async (input: { command: string; args?: string[]; env?: Record<string, string> }) => {
      const args = input.args ?? [];
      if (input.command === "claude") {
        if (args.includes("--version")) return result("2.1.284 (Claude Code)\n");
        if (args.includes("--help")) return result("--effort\n");
        claudeRuns.push(args);
        const configDir = input.env?.CLAUDE_CONFIG_DIR ?? "";
        const projectDir = path.join(configDir, "projects", encodeCwd(remoteCwd));
        const resumeIndex = args.indexOf("--resume");
        const resumed = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
        const sessionId = resumed ?? randomUUID();
        const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
        if (resumed) {
          const previous = await readFile(transcriptPath, "utf8").catch(() => null);
          if (previous === null) {
            return result(
              JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, session_id: sessionId, errors: [`No conversation found with session ID: ${sessionId}`] }),
              1,
            );
          }
        }
        await mkdir(projectDir, { recursive: true });
        await writeFile(transcriptPath, `${JSON.stringify({ type: "user", leaseId })}\n`, { flag: "a" });
        return result([
          JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet" }),
          JSON.stringify({ type: "result", subtype: "success", session_id: sessionId, result: "ok", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }),
        ].join("\n"));
      }
      const script = args[args.length - 1] ?? "";
      if (/command -v|which /.test(script) && /claude/.test(script)) return result("/usr/local/bin/claude\n");
      try {
        const { stdout } = await execFileAsync("sh", ["-c", script], { cwd: remoteCwd });
        return result(stdout);
      } catch (error) {
        const failed = error as { code?: number; stdout?: string };
        return result(failed.stdout ?? "", typeof failed.code === "number" ? failed.code : 1);
      }
    }),
  };
  return {
    kind: "remote",
    transport: "sandbox",
    providerKey: "kubernetes",
    environmentId: "env-1",
    leaseId,
    remoteCwd,
    shellCommand: "sh",
    streamRunLogs: false,
    runner,
  };
}

describe("claude sandbox session transcript across leases", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    resetClaudeCliCapabilitiesCacheForTests();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function setup() {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-transcript-carry-"));
    cleanupDirs.push(rootDir);
    const hostClaudeConfigDir = path.join(rootDir, "host-claude");
    const workspaceDir = path.join(rootDir, "host-workspace");
    await mkdir(hostClaudeConfigDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_HOME", path.join(rootDir, "paperclip-home"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", hostClaudeConfigDir);

    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input: {
      target: AdapterSandboxExecutionTarget;
      assets?: Asset[];
    }) => {
      const runtimeRootDir = path.join(input.target.remoteCwd, ".paperclip-runtime", "claude");
      const assetDirs: Record<string, string> = {};
      for (const asset of input.assets ?? []) {
        assetDirs[asset.key] = path.join(runtimeRootDir, asset.key);
        await mkdir(assetDirs[asset.key], { recursive: true });
        await cp(asset.localDir, assetDirs[asset.key], { recursive: true });
      }
      return {
        target: input.target,
        workspaceRemoteDir: input.target.remoteCwd,
        runtimeRootDir,
        assetDirs,
        additionalSourceDirs: {},
        additionalSourceFailures: [],
        workspaceSyncSnapshot: null,
        restoreWorkspace: async () => {
          for (const asset of input.assets ?? []) {
            await asset.restore?.({ assetDir: assetDirs[asset.key], readFile: (remotePath) => readFile(remotePath) });
          }
        },
      };
    });
    return { rootDir, hostClaudeConfigDir, workspaceDir };
  }

  async function runOnLease(input: {
    runId: string;
    target: AdapterSandboxExecutionTarget;
    workspaceDir: string;
    sessionParams: Record<string, unknown> | null;
    logs: string[];
  }) {
    return await execute({
      runId: input.runId,
      agent: { id: "agent-1", companyId: "company-1", name: "Claude Coder", adapterType: "claude_local", adapterConfig: {} },
      runtime: {
        sessionId: typeof input.sessionParams?.sessionId === "string" ? input.sessionParams.sessionId : null,
        sessionParams: input.sessionParams,
        sessionDisplayId: null,
        taskKey: "issue-1",
      },
      config: { model: "claude-opus-5", engine: "cli", command: "claude", paperclipRuntimeSkills: [] },
      context: { paperclipWorkspace: { cwd: input.workspaceDir, source: "project_primary" } },
      executionTarget: input.target,
      onLog: async (_stream, chunk) => {
        input.logs.push(chunk);
      },
    });
  }

  it("resumes the session on a new lease after carrying its transcript", async () => {
    const { rootDir, hostClaudeConfigDir, workspaceDir } = await setup();
    const remoteCwdRoot = path.join(rootDir, "pod");
    const claudeRuns: string[][] = [];

    // Both leases realize the workspace at the same remote path, like the Kubernetes provider.
    const firstLogs: string[] = [];
    const first = await runOnLease({
      runId: "run-1",
      target: createLease(remoteCwdRoot, "lease-1", claudeRuns),
      workspaceDir,
      sessionParams: null,
      logs: firstLogs,
    });
    expect(first.exitCode).toBe(0);
    const sessionId = first.sessionId as string;
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.sessionParams?.remoteExecution).toMatchObject({ transport: "sandbox", leaseId: "lease-1" });

    const storePath = resolveClaudeTranscriptStorePath({
      storeConfigDir: hostClaudeConfigDir,
      remoteCwd: path.join(remoteCwdRoot, "workspace"),
      sessionId,
    });
    expect(await readFile(storePath, "utf8")).toContain("lease-1");
    expect(firstLogs.join("")).toContain(`Saved Claude session "${sessionId}" transcript`);

    // The first pod is gone; the next run gets a new, empty lease.
    await rm(remoteCwdRoot, { recursive: true, force: true });
    const secondLogs: string[] = [];
    const second = await runOnLease({
      runId: "run-2",
      target: createLease(remoteCwdRoot, "lease-2", claudeRuns),
      workspaceDir,
      sessionParams: first.sessionParams ?? null,
      logs: secondLogs,
    });

    const secondLog = secondLogs.join("");
    expect(second.exitCode).toBe(0);
    expect(secondLog).not.toContain("does not match the current execution target");
    expect(secondLog).toContain(`Restored Claude session "${sessionId}" transcript from an earlier sandbox lease`);
    expect(claudeRuns).toHaveLength(2);
    expect(claudeRuns[1]).toEqual(expect.arrayContaining(["--resume", sessionId]));
    expect(second.sessionId).toBe(sessionId);
    expect(second.sessionParams?.remoteExecution).toMatchObject({ leaseId: "lease-2" });
    // The stored transcript now holds both leases' turns.
    const stored = await readFile(storePath, "utf8");
    expect(stored).toContain("lease-1");
    expect(stored).toContain("lease-2");
  });

  it("starts a fresh session without failing when the earlier lease's transcript was not saved", async () => {
    const { rootDir, workspaceDir } = await setup();
    const remoteCwd = path.join(rootDir, "pod", "workspace");
    const sessionId = randomUUID();
    const claudeRuns: string[][] = [];
    const logs: string[] = [];

    const run = await runOnLease({
      runId: "run-2",
      target: createLease(path.join(rootDir, "pod"), "lease-2", claudeRuns),
      workspaceDir,
      sessionParams: {
        sessionId,
        cwd: workspaceDir,
        remoteExecution: { transport: "sandbox", providerKey: "kubernetes", environmentId: "env-1", leaseId: "lease-1", remoteCwd },
      },
      logs,
    });

    const log = logs.join("");
    expect(run.exitCode).toBe(0);
    expect(log).toContain(
      `Claude session "${sessionId}" was saved on an earlier sandbox lease and could not be carried over: no saved transcript. Starting a fresh session.`,
    );
    expect(claudeRuns).toHaveLength(1);
    expect(claudeRuns[0]).not.toContain("--resume");
    expect(run.sessionId).not.toBe(sessionId);
  });

  async function listFilesRecursive(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  }

  it.each([
    { name: "a different environment", mismatch: { environmentId: "env-other" } },
    { name: "a different provider", mismatch: { providerKey: "e2b" } },
    { name: "a different remote cwd", mismatch: { remoteCwd: "/elsewhere/workspace" } },
  ])("does not upload or resume a transcript saved on $name", async ({ mismatch }) => {
    const { rootDir, hostClaudeConfigDir, workspaceDir } = await setup();
    const podRoot = path.join(rootDir, "pod");
    const savedRemoteExecution = {
      transport: "sandbox",
      providerKey: "kubernetes",
      environmentId: "env-1",
      leaseId: "lease-1",
      remoteCwd: path.join(podRoot, "workspace"),
      ...mismatch,
    };
    const sessionId = randomUUID();
    const secret = `transcript-bytes-that-must-not-leave-${randomUUID()}`;
    const storePath = resolveClaudeTranscriptStorePath({
      storeConfigDir: hostClaudeConfigDir,
      remoteCwd: savedRemoteExecution.remoteCwd,
      sessionId,
    });
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, `${JSON.stringify({ type: "user", secret })}\n`);
    const claudeRuns: string[][] = [];
    const logs: string[] = [];
    const uploadedAssets: Array<{ key: string; files: string[] }> = [];
    const prepare = prepareAdapterExecutionTargetRuntime.getMockImplementation()!;
    prepareAdapterExecutionTargetRuntime.mockImplementation(async (input: { assets?: Asset[] }) => {
      for (const asset of input.assets ?? []) {
        uploadedAssets.push({ key: asset.key, files: await readdir(asset.localDir).catch(() => []) });
      }
      return await prepare(input);
    });

    const run = await runOnLease({
      runId: "run-2",
      target: createLease(podRoot, "lease-2", claudeRuns),
      workspaceDir,
      sessionParams: { sessionId, cwd: workspaceDir, remoteExecution: savedRemoteExecution },
      logs,
    });

    expect(run.exitCode).toBe(0);
    expect(logs.join("")).toContain("does not match the current execution target");
    expect(claudeRuns[0]).not.toContain("--resume");
    // Nothing was staged for upload ...
    const transcriptAsset = uploadedAssets.find((asset) => asset.key === "session-transcript");
    expect(transcriptAsset?.files ?? []).toEqual([]);
    // ... and no byte of the saved transcript reached the lease.
    for (const file of await listFilesRecursive(podRoot)) {
      expect(await readFile(file, "utf8").catch(() => "")).not.toContain(secret);
    }
    expect(await readFile(storePath, "utf8")).toContain(secret);
  });
});
