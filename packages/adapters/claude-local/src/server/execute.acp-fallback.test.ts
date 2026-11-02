import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLocalProcessSandboxSpawnTarget, type LocalProcessSandboxOptions } from "@paperclipai/adapter-utils/local-process-sandbox";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

import { execute } from "./execute.js";

async function filesystemConfinementRuns(): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const workspace = os.tmpdir();
  try {
    const target = await buildLocalProcessSandboxSpawnTarget({
      executable: process.execPath,
      args: ["-e", ""],
      cwd: workspace,
      options: { workspaceDir: workspace, filesystemScope: "workspace" },
    });
    const status = spawnSync(target.command, target.args, { cwd: target.cwd }).status;
    await target.cleanup?.();
    return status === 0;
  } catch {
    return false;
  }
}

const confinementRuns = await filesystemConfinementRuns();

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { model: "claude-opus-5", ...config },
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not start CLI after default ACP fails", async () => {
    const ctx = buildContext();
    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ engine: "cli", networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("mounts the durable transcript directory a managed connection links into the Claude config dir", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-confined-transcripts-"));
    try {
      const providerHome = path.join(root, "home", "provider");
      const durableTranscripts = path.join(root, "companies", "company-1", "agents", "agent-1", "claude-transcripts", "scope");
      await fs.mkdir(providerHome, { recursive: true });
      await fs.mkdir(durableTranscripts, { recursive: true });
      await fs.symlink(durableTranscripts, path.join(providerHome, "projects"));
      const managedConfig = {
        engine: "cli",
        managedAiConnection: { provider: "anthropic", method: "subscription" },
        env: { CLAUDE_CONFIG_DIR: providerHome },
      };
      const transcriptMount = { path: await fs.realpath(durableTranscripts), access: "rw" };
      const sandboxPaths = () => runAdapterExecutionTargetProcess.mock.calls
        .map((call) => (call as unknown[])[4] as { localProcessSandbox?: { managedPaths: unknown[] } })
        .find((options) => options?.localProcessSandbox)?.localProcessSandbox?.managedPaths;

      await execute(buildContext({ ...managedConfig, filesystemScope: "workspace" }) as never);
      expect(sandboxPaths()).toContainEqual(transcriptMount);
      const siblingTranscripts = path.join(path.dirname(await fs.realpath(durableTranscripts)), "other-task");
      for (const mount of sandboxPaths() as Array<{ path: string }>) {
        expect(siblingTranscripts.startsWith(`${mount.path}${path.sep}`)).toBe(false);
      }

      vi.clearAllMocks();
      await execute(buildContext({ ...managedConfig, networkScope: "allowlist" }) as never);
      expect(sandboxPaths()).not.toContainEqual(transcriptMount);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(confinementRuns)("lets a confined run read its own transcripts but not another task's or agent's", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claude-transcript-isolation-")));
    try {
      const providerHome = path.join(root, "home", "provider");
      const transcriptsDir = path.join(root, "companies", "company-1", "agents", "agent-1", "claude-transcripts");
      const own = path.join(transcriptsDir, "own", "projects");
      const other = path.join(transcriptsDir, "other", "projects");
      const otherAgent = path.join(root, "companies", "company-1", "agents", "agent-2", "claude-transcripts", "own", "projects");
      for (const dir of [providerHome, own, other, otherAgent]) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(own, "session.jsonl"), "own");
      await fs.writeFile(path.join(other, "session.jsonl"), "other");
      await fs.writeFile(path.join(otherAgent, "session.jsonl"), "other agent");
      await fs.symlink(own, path.join(providerHome, "projects"));

      await execute(buildContext({
        engine: "cli",
        managedAiConnection: { provider: "anthropic", method: "subscription" },
        env: { CLAUDE_CONFIG_DIR: providerHome },
        filesystemScope: "workspace",
      }) as never);
      const sandbox = runAdapterExecutionTargetProcess.mock.calls
        .map((call) => (call as unknown[])[4] as { localProcessSandbox?: LocalProcessSandboxOptions })
        .find((options) => options?.localProcessSandbox)!.localProcessSandbox!;
      const read = (file: string) =>
        `try{process.stdout.write(require("fs").readFileSync(${JSON.stringify(file)},"utf8"))}catch(e){process.stdout.write(e.code)}`;
      const target = await buildLocalProcessSandboxSpawnTarget({
        executable: process.execPath,
        args: ["-e", `${read(path.join(providerHome, "projects", "session.jsonl"))};process.stdout.write("|");${read(path.join(other, "session.jsonl"))};process.stdout.write("|");${read(path.join(otherAgent, "session.jsonl"))}`],
        cwd: sandbox.workspaceDir,
        options: sandbox,
      });
      try {
        const output = execFileSync(target.command, target.args, { cwd: target.cwd, env: { ...process.env, ...target.env }, encoding: "utf8" });
        expect(output).toBe("own|ENOENT|ENOENT");
      } finally {
        await target.cleanup?.();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
