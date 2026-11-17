import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  executeAcp,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
  executeAcp: vi.fn(async (_ctx?: unknown) => ({ exitCode: 0, signal: null, timedOut: false, resultJson: { engine: "acp" } })),
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "remote failure",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn<typeof import("@paperclipai/adapter-utils/server-utils").ensureCommandResolvable>(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/codex"),
  prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
  restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
  runSshCommand: vi.fn(async (_spec?: unknown, _command?: string) => ({ stdout: Buffer.from("{}").toString("base64"), stderr: "" })),
  syncDirectoryToSsh: vi.fn(async (_input?: { localDir: string; remoteDir: string }) => undefined),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
    env: {
      PAPERCLIP_API_URL: "http://127.0.0.1:4310",
      PAPERCLIP_API_KEY: "bridge-token",
      PAPERCLIP_API_BRIDGE_MODE: "queue_v1",
    },
    stop: async () => {},
  })),
}));

vi.mock("./acp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./acp.js")>();
  return { ...actual, createCodexAcpExecutor: () => executeAcp };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/ssh")>(
    "@paperclipai/adapter-utils/ssh",
  );
  return {
    ...actual,
    prepareWorkspaceForSshExecution,
    restoreWorkspaceFromSshExecution,
    runSshCommand,
    syncDirectoryToSsh,
  };
});

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    startAdapterExecutionTargetPaperclipBridge,
  };
});

import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";

describe("codex remote execution", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function managedSshAcpContext(engine?: string) {
    return {
      runId: "managed-ssh-acp", agent: { id: "agent-1", companyId: "company-1", name: "Selected agent", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task" },
      config: { engine, managedAiConnection: { provider: "openai", method: "subscription", identity: "selected-account" },
        env: { OPENAI_API_KEY: "fixture-selected-token" } } as Record<string, unknown>,
      context: {}, onLog: async () => {},
      executionTarget: { kind: "remote" as const, transport: "ssh" as const, remoteCwd: "/remote/workspace",
        spec: { useHostAuth: false as boolean | undefined, host: "ssh.example.test", port: 22, username: "agent", remoteCwd: "/remote/workspace", remoteWorkspacePath: "/remote/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true },
        workspaceRealization: { mode: "copy" as "copy" | "in_place", authoritativeRoot: "/remote/workspace", pathAliases: [], outboundRestorePaths: [] } },
    };
  }

  it.each([undefined, "acp"])("admits managed SSH ACP through the public execution entry (engine=%s)", async engine => {
    const ctx = managedSshAcpContext(engine);
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils");
    const bin = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-client-probe-"));
    cleanupDirs.push(bin);
    await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const originalResolve = ensureCommandResolvable.getMockImplementation()!;
    ensureCommandResolvable.mockImplementationOnce(actual.ensureCommandResolvable);
    const previousPath = process.env.PATH;
    process.env.PATH = bin;
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "fixture-server-secret";
    try {
      expect(await execute(ctx)).toMatchObject({ exitCode: 0, resultJson: { engine: "acp" } });
      expect(executeAcp).toHaveBeenCalledWith(ctx);
      const probe = ensureCommandResolvable.mock.calls[0] as unknown as unknown[];
      expect(probe[0]).toBe("codex-acp");
      expect(Object.keys(probe[2] as Record<string, unknown>)).toEqual(["PATH"]);
      expect((probe[2] as Record<string, unknown>).PATH === bin).toBe(true);
      expect(probe[3]).toMatchObject({ remoteExecution: { host: "ssh.example.test", useHostAuth: false } });
    } finally {
      ensureCommandResolvable.mockReset().mockImplementation(originalResolve);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it.each(["host auth", "legacy auth", "missing account", "in-place", "confinement", "missing SSH client"])("rejects unsupported SSH ACP at the public execution entry: %s", async reason => {
    const ctx = managedSshAcpContext("acp");
    const originalResolve = ensureCommandResolvable.getMockImplementation()!;
    if (reason === "host auth") ctx.executionTarget.spec.useHostAuth = true;
    if (reason === "legacy auth") ctx.executionTarget.spec.useHostAuth = undefined;
    if (reason === "missing account") delete ctx.config.managedAiConnection;
    if (reason === "in-place") ctx.executionTarget.workspaceRealization.mode = "in_place";
    if (reason === "confinement") ctx.config.filesystemScope = "workspace";
    const previousPath = process.env.PATH;
    if (reason === "missing SSH client") {
      const bin = await mkdtemp(path.join(os.tmpdir(), "paperclip-no-ssh-client-"));
      cleanupDirs.push(bin);
      process.env.PATH = bin;
      const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils");
      ensureCommandResolvable.mockImplementationOnce(actual.ensureCommandResolvable);
    }
    try {
      expect(await execute(ctx)).toMatchObject({ exitCode: 1, errorCode: "adapter_engine_unavailable" });
      expect(executeAcp).not.toHaveBeenCalled();
    } finally {
      ensureCommandResolvable.mockReset().mockImplementation(originalResolve);
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it.each([false, true])("retains a managed SSH Codex conversation across turns and removes credentials (second turn throws=%s)", async fails => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-ssh-resume-"));
    cleanupDirs.push(root);
    const workspace = path.join(root, "workspace"), home = path.join(root, "account"), secondHome = path.join(root, "next-invocation");
    await mkdir(workspace); await mkdir(home); await mkdir(secondHome);
    const auth = (account: string, marker: string, last_refresh: string) => JSON.stringify({ tokens: {
      account_id: account, access_token: `fixture-access-${marker}`, refresh_token: `fixture-refresh-${marker}`, id_token: `fixture-id-${marker}`,
    }, last_refresh });
    const credential = auth("selected", "before", "2000-01-01T00:00:00Z");
    const refreshed = auth("selected", "after", new Date().toISOString());
    const otherCredential = auth("other", "other", "2000-01-01T00:00:00Z");
    await writeFile(path.join(home, "auth.json"), credential);
    await writeFile(path.join(secondHome, "auth.json"), credential);
    const executeShell = promisify(execFile);
    const originalRun = runChildProcess.getMockImplementation()!;
    let firstRemoteHome: string | undefined;
    let otherRemoteHome: string | undefined;
    const privateRoots: string[] = [];
    let calls = 0;
    runSshCommand.mockImplementation(async (_spec, command) => {
      const result = await executeShell("sh", ["-c", command!]);
      if (command!.includes("mktemp -d")) privateRoots.push(result.stdout.trim());
      return result;
    });
    syncDirectoryToSsh.mockImplementation(async input => { await cp(input!.localDir, input!.remoteDir, { recursive: true }); });
    runChildProcess.mockImplementation(async (...args: unknown[]) => {
      const env = (args[3] as { env: Record<string, string> }).env;
      const remoteHome = env.CODEX_HOME!;
      calls++;
      expect(await readFile(path.join(remoteHome, "auth.json"), "utf8")).toBe(calls === 1 ? credential : calls === 2 ? refreshed : otherCredential);
      if (calls === 1) {
        firstRemoteHome = remoteHome;
        await mkdir(path.join(remoteHome, "sessions"));
        await writeFile(path.join(remoteHome, "sessions", "rollout.jsonl"), "fixture conversation");
        await writeFile(path.join(remoteHome, "state_5.sqlite"), "fixture native index");
        await writeFile(path.join(remoteHome, "auth.json"), refreshed);
      } else if (calls === 2) {
        expect(remoteHome).toBe(firstRemoteHome);
        expect(args[2]).toContain("resume");
        expect(args[2]).toContain("ssh-thread");
        expect(await readFile(path.join(remoteHome, "sessions", "rollout.jsonl"), "utf8")).toBe("fixture conversation");
        expect(await readFile(path.join(remoteHome, "state_5.sqlite"), "utf8")).toBe("fixture native index");
        if (fails) throw new Error("fixture provider failed");
      } else {
        if (calls === 3) otherRemoteHome = remoteHome;
        expect(remoteHome).not.toBe(firstRemoteHome);
        expect(args[2]).not.toContain("resume");
        await expect(readFile(path.join(remoteHome, "sessions", "rollout.jsonl"))).rejects.toThrow("ENOENT");
        if (calls === 3) {
          await mkdir(path.join(remoteHome, "sessions"));
          await writeFile(path.join(remoteHome, "sessions", "rollout.jsonl"), "other conversation");
        }
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: JSON.stringify({ type: "thread.started", thread_id: calls < 3 ? "ssh-thread" : "other-thread" })+'\n{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n', stderr: "", pid: 123, startedAt: new Date().toISOString() };
    });
    const ctx = {
      agent: { id: "agent-1", companyId: "company-1", name: "Selected agent", adapterType: "codex_local", adapterConfig: {} },
      config: { engine: "cli", command: "codex", managedAiConnection: { identity: "generation-one", sessionIdentity: "selected-account", provider: "openai", method: "subscription" }, env: { CODEX_HOME: home, OPENAI_API_KEY: "" } },
      context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
      executionTarget: { kind: "remote" as const, transport: "ssh" as const, remoteCwd: workspace,
        spec: { useHostAuth: false, host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: workspace, remoteWorkspacePath: workspace, privateKey: null, knownHosts: null, strictHostKeyChecking: true },
        workspaceRealization: { mode: "in_place" as const, authoritativeRoot: workspace, pathAliases: [], outboundRestorePaths: [] } }, onLog: async () => {},
    };
    try {
      const first = await execute({ ...ctx, runId: "first", runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-one" } });
      expect(first.sessionId).toBe("ssh-thread");
      const saved = sessionCodec.deserialize(JSON.parse(JSON.stringify(sessionCodec.serialize(first.sessionParams!))))!;
      expect(saved).toMatchObject({ remoteExecution: first.sessionParams!.remoteExecution,
        sshCodexConversationId: first.sessionParams!.sshCodexConversationId, sshCodexAccountScope: first.sessionParams!.sshCodexAccountScope });
      expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(refreshed);
      await writeFile(path.join(secondHome, "auth.json"), refreshed);
      expect(await readdir(firstRemoteHome!)).toEqual(expect.arrayContaining(["sessions", "state_5.sqlite"]));
      expect(await readdir(firstRemoteHome!)).not.toContain("auth.json");
      const second = execute({ ...ctx, runId: "second", config: { ...ctx.config,
        managedAiConnection: { ...ctx.config.managedAiConnection, identity: "generation-two" }, env: { CODEX_HOME: secondHome, OPENAI_API_KEY: "" } },
        runtime: { sessionId: first.sessionId!, sessionParams: saved, sessionDisplayId: first.sessionId!, taskKey: "task-one" } });
      if (fails) await expect(second).rejects.toThrow("fixture provider failed");
      else expect((await second).sessionId).toBe("ssh-thread");
      expect(calls).toBe(2);
      expect((await readdir(firstRemoteHome!)).sort()).toEqual(["sessions", "state_5.sqlite"]);
      expect((await stat(firstRemoteHome!)).mode & 0o077).toBe(0);
      if (!fails) {
        await writeFile(path.join(secondHome, "auth.json"), otherCredential);
        const switched = await execute({ ...ctx, runId: "other-account", config: { ...ctx.config,
          managedAiConnection: { ...ctx.config.managedAiConnection, identity: "other-account", sessionIdentity: "other-account" }, env: { CODEX_HOME: secondHome, OPENAI_API_KEY: "" } },
          runtime: { sessionId: first.sessionId!, sessionParams: first.sessionParams!, sessionDisplayId: first.sessionId!, taskKey: "task-one" } });
        expect(switched.sessionId).toBe("other-thread");
        expect(switched.sessionParams?.sshCodexAccountScope).not.toBe(first.sessionParams?.sshCodexAccountScope);
        expect(switched.resultJson).toMatchObject({ sessionReset: { code: "codex_ssh_session_state_unavailable" } });
        expect(await readdir(otherRemoteHome!)).not.toContain("auth.json");
        expect(await readFile(path.join(firstRemoteHome!, "sessions", "rollout.jsonl"), "utf8")).toBe("fixture conversation");
        const oldShape = { sessionId: switched.sessionId!, cwd: workspace, remoteExecution: switched.sessionParams!.remoteExecution };
        const legacy = await execute({ ...ctx, runId: "old-saved-shape", config: { ...ctx.config,
          managedAiConnection: { ...ctx.config.managedAiConnection, identity: "other-account", sessionIdentity: "other-account" }, env: { CODEX_HOME: secondHome, OPENAI_API_KEY: "" } },
          runtime: { sessionId: switched.sessionId!, sessionParams: oldShape, sessionDisplayId: switched.sessionId!, taskKey: "task-one" } });
        expect(legacy.resultJson).toMatchObject({ sessionReset: { code: "codex_ssh_session_state_unavailable" } });
        expect(await readFile(path.join(otherRemoteHome!, "sessions", "rollout.jsonl"), "utf8")).toBe("other conversation");
      }
      for (const dir of privateRoots) await expect(stat(dir)).rejects.toThrow("ENOENT");
    } finally {
      runChildProcess.mockImplementation(originalRun);
      runSshCommand.mockReset().mockResolvedValue({ stdout: Buffer.from("{}").toString("base64"), stderr: "" });
      syncDirectoryToSsh.mockReset().mockResolvedValue(undefined);
    }
  });

  it("stages only the selected agent subscription and returns SSH refreshes to that account", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-selected-ssh-"));
    cleanupDirs.push(root);
    const workspace = path.join(root, "workspace"), home = path.join(root, "selected-account");
    await mkdir(workspace); await mkdir(home);
    const auth = (marker: string, last_refresh: string) => JSON.stringify({
      tokens: { account_id: "selected-account", access_token: `fixture-access-${marker}`, refresh_token: `fixture-refresh-${marker}`, id_token: `fixture-id-${marker}` }, last_refresh,
    });
    await writeFile(path.join(home, "auth.json"), auth("before", "2000-01-01T00:00:00Z"), { mode: 0o600 });
    const refreshed = auth("after", new Date().toISOString());
    runSshCommand.mockImplementation(async (_spec, command) => ({ stdout: command?.includes("mktemp -d")
      ? "/tmp/paperclip-ssh-runtime.selected\n" : Buffer.from(refreshed).toString("base64"), stderr: "" }));
    try {
      await execute({ runId: "selected", agent: { id: "agent-1", companyId: "company-1", name: "Selected agent", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "codex", managedAiConnection: { identity: "selected-account", provider: "openai", method: "subscription" }, env: { CODEX_HOME: home, OPENAI_API_KEY: "" } },
        context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" } },
        executionTransport: { remoteExecution: { useHostAuth: false, host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/workspace", remoteWorkspacePath: "/workspace", privateKey: null, knownHosts: null, strictHostKeyChecking: true } }, onLog: async () => {},
      });
      const invocation = runChildProcess.mock.calls[0] as unknown as [string, string, string[], { env: Record<string, string> }];
      expect(invocation[3].env).toMatchObject({ CODEX_HOME: "/tmp/paperclip-ssh-runtime.selected/home", HOME: "/tmp/paperclip-ssh-runtime.selected", OPENAI_API_KEY: "" });
      expect(await readFile(path.join(home, "auth.json"), "utf8")).toBe(refreshed);
      expect(runSshCommand).toHaveBeenCalledWith(expect.anything(), "rm -rf -- '/tmp/paperclip-ssh-runtime.selected'", expect.anything());
    } finally {
      runSshCommand.mockReset().mockResolvedValue({ stdout: Buffer.from("{}").toString("base64"), stderr: "" });
    }
  });

  it("prepares the workspace, syncs CODEX_HOME, and restores workspace changes for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-1/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(rootDir, "instructions.md"), "Use the remote workspace.\n", "utf8");
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");
    const alternateWorkspaceDir = path.join(rootDir, "alternate-workspace");
    await mkdir(alternateWorkspaceDir, { recursive: true });

    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
          strategy: "git_worktree",
          workspaceId: "workspace-1",
          repoUrl: "https://github.com/paperclipai/paperclip.git",
          repoRef: "main",
          branchName: "feature/remote-codex",
          worktreePath: workspaceDir,
        },
        paperclipWorkspaces: [
          {
            workspaceId: "workspace-1",
            cwd: workspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "main",
          },
          {
            workspaceId: "workspace-2",
            cwd: alternateWorkspaceDir,
            repoUrl: "https://github.com/paperclipai/paperclip.git",
            repoRef: "feature/other",
          },
        ],
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceForSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    // The home asset now syncs a curated *staged* allowlist dir, not the raw
    // managed CODEX_HOME, and carries no `exclude` denylist.
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
      followSymlinks?: boolean;
      exclude?: string[];
    };
    expect(homeSyncArgs.localDir).not.toBe(codexHomeDir);
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(homeSyncArgs.followSymlinks).toBe(true);
    expect(homeSyncArgs.exclude).toBeUndefined();

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2]).not.toContain("--skip-git-repo-check");
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe(managedRemoteWorkspace);
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_WORKTREE_PATH).toBeUndefined();
    expect(JSON.parse(call?.[3].env.PAPERCLIP_WORKSPACES_JSON ?? "[]")).toEqual([
      {
        workspaceId: "workspace-1",
        cwd: managedRemoteWorkspace,
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "main",
      },
      {
        workspaceId: "workspace-2",
        repoUrl: "https://github.com/paperclipai/paperclip.git",
        repoRef: "feature/other",
      },
    ]);
    expect(call?.[3].env.PAPERCLIP_API_URL).toBe("http://127.0.0.1:4310");
    expect(call?.[3].env.PAPERCLIP_API_BRIDGE_MODE).toBe("queue_v1");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
    expect(startAdapterExecutionTargetPaperclipBridge).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledWith(expect.objectContaining({
      localDir: workspaceDir,
      remoteDir: managedRemoteWorkspace,
    }));
  });

  it("stages only the allowlist into the home asset: keeps config.toml/skills/auth, drops session+sqlite state, no exclude", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-allowlist-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });

    // Seed the managed home with the files Codex needs (config.toml carries a
    // provider-routing block; skills injected) plus large runtime decoys the
    // old 4-name denylist missed.
    await writeFile(path.join(codexHomeDir, "auth.json"), '{"tokens":{"account_id":"a","refresh_token":"r"}}', "utf8");
    await writeFile(
      path.join(codexHomeDir, "config.toml"),
      'model_provider = "bifrost"\n\n[model_providers.bifrost]\nname = "bifrost"\n',
      "utf8",
    );
    await writeFile(path.join(codexHomeDir, "instructions.md"), "hi\n", "utf8");
    await mkdir(path.join(codexHomeDir, "skills", "demo"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "skills", "demo", "SKILL.md"), "# demo\n", "utf8");
    // Decoys:
    await writeFile(path.join(codexHomeDir, "logs_2.sqlite"), "x", "utf8");
    await writeFile(path.join(codexHomeDir, "state_5.sqlite"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "sessions"), { recursive: true });
    await writeFile(path.join(codexHomeDir, "sessions", "rollout.jsonl"), "x", "utf8");
    await mkdir(path.join(codexHomeDir, "tmp"), { recursive: true });
    await symlink("/usr/bin/env", path.join(codexHomeDir, "tmp", "arg0"));

    // Snapshot the staged dir contents at sync time — execute() removes the
    // staged temp dir on teardown, so we cannot read it after execute returns.
    let stagedSnapshot:
      | { localDir: string; entries: string[]; skillEntries: string[]; configToml: string; authJson: string }
      | null = null;
    (syncDirectoryToSsh as unknown as {
      mockImplementationOnce: (fn: (args: { localDir: string }) => Promise<void>) => void;
    }).mockImplementationOnce(async (args: { localDir: string }) => {
      const entries = (await readdir(args.localDir)).sort();
      const skillEntries = entries.includes("skills")
        ? (await readdir(path.join(args.localDir, "skills"))).sort()
        : [];
      const configToml = entries.includes("config.toml")
        ? await readFile(path.join(args.localDir, "config.toml"), "utf8")
        : "";
      const authJson = entries.includes("auth.json")
        ? await readFile(path.join(args.localDir, "auth.json"), "utf8")
        : "";
      stagedSnapshot = { localDir: args.localDir, entries, skillEntries, configToml, authJson };
    });

    await execute({
      runId: "run-allowlist",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(stagedSnapshot).not.toBeNull();
    const snap = stagedSnapshot as unknown as {
      localDir: string;
      entries: string[];
      skillEntries: string[];
      configToml: string;
      authJson: string;
    };
    // Allowlist present; decoys gone.
    expect(snap.entries).toEqual(
      ["auth.json", "config.json", "config.toml", "instructions.md", "skills"]
        .filter((e) => e !== "config.json") // no config.json was seeded
        .sort(),
    );
    for (const decoy of ["logs_2.sqlite", "state_5.sqlite", "sessions", "tmp", "plugins"]) {
      expect(snap.entries).not.toContain(decoy);
    }
    // Phase-3 behavioral invariants: provider routing + skills + auth survive staging.
    expect(snap.configToml).toContain("[model_providers.bifrost]");
    expect(snap.configToml).toContain("model_provider");
    expect(snap.skillEntries).toContain("demo");
    expect(snap.authJson).toContain("refresh_token");

    // The staged temp dir is removed after execute completes (cleanup on teardown).
    await expect(readdir(snap.localDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not resume saved Codex sessions for remote SSH execution without a matching remote identity", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-no-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: "/remote/workspace",
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2].slice(call[2].indexOf("exec"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ]);
  });

  it("resumes saved Codex sessions for remote SSH execution when the remote identity matches", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-remote-resume-match-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-ssh-resume/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-ssh-resume",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTransport: {
        remoteExecution: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as [string, string, string[]] | undefined;
    expect(call?.[2].slice(call[2].indexOf("exec"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "session-123",
      "-",
    ]);
  });

  it("uses the provider-neutral execution target contract for remote SSH execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-target-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    const managedRemoteWorkspace = "/remote/workspace/.paperclip-runtime/runs/run-target/workspace";
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-target",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-123",
        sessionParams: {
          sessionId: "session-123",
          cwd: managedRemoteWorkspace,
          remoteExecution: {
            transport: "ssh",
            host: "127.0.0.1",
            port: 2222,
            username: "fixture",
            remoteCwd: managedRemoteWorkspace,
          },
        },
        sessionDisplayId: "session-123",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: {
          CODEX_HOME: codexHomeDir,
        },
      },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/remote/workspace",
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/remote/workspace",
          remoteCwd: "/remote/workspace",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[2].slice(call[2].indexOf("exec"))).toEqual([
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "session-123",
      "-",
    ]);
    expect(call?.[3].env.CODEX_HOME).toBe(`${managedRemoteWorkspace}/.paperclip-runtime/codex/home`);
    expect(call?.[3].remoteExecution?.remoteCwd).toBe(managedRemoteWorkspace);
  });

  it("runs in place at the authoritative root without archive prepare or restore", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-in-place-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const codexHomeDir = path.join(rootDir, "codex-home");
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(codexHomeDir, { recursive: true });
    await writeFile(path.join(codexHomeDir, "auth.json"), "{}", "utf8");

    await execute({
      runId: "run-in-place",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CodexCoder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { engine: "cli", command: "codex", env: { CODEX_HOME: codexHomeDir } },
      context: {
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "task_session",
        },
      },
      executionTarget: {
        kind: "remote",
        transport: "ssh",
        remoteCwd: "/copied/workspace",
        workspaceRealization: {
          mode: "in_place",
          authoritativeRoot: "/app",
          pathAliases: [],
          outboundRestorePaths: [],
        },
        spec: {
          host: "127.0.0.1",
          port: 2222,
          username: "fixture",
          remoteWorkspacePath: "/app",
          remoteCwd: "/app",
          privateKey: "PRIVATE KEY",
          knownHosts: "[127.0.0.1]:2222 ssh-ed25519 AAAA",
          strictHostKeyChecking: true,
        },
      },
      onLog: async () => {},
    });

    expect(prepareWorkspaceForSshExecution).not.toHaveBeenCalled();
    expect(syncDirectoryToSsh).toHaveBeenCalledTimes(1);
    expect(restoreWorkspaceFromSshExecution).not.toHaveBeenCalled();
    const homeSyncArgs = (syncDirectoryToSsh.mock.calls[0] as unknown[])?.[0] as {
      localDir: string;
      remoteDir: string;
    };
    expect(homeSyncArgs.localDir).toContain("paperclip-codex-home-sync");
    expect(homeSyncArgs.remoteDir).toBe("/app/.paperclip-runtime/codex/home");
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { env: Record<string, string>; remoteExecution?: { remoteCwd: string } | null }]
      | undefined;
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_CWD).toBe("/app");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_REALIZATION_MODE).toBe("in_place");
    expect(call?.[3].env.PAPERCLIP_WORKSPACE_AUTHORITATIVE_ROOT).toBe("/app");
    expect(call?.[3].env.CODEX_HOME).toBe("/app/.paperclip-runtime/codex/home");
    expect(call?.[3].remoteExecution?.remoteCwd).toBe("/app");
  });

  it("reselects the full assignment and bootstrap guidance after a failed resume", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-cli-fallback-context-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });

    runChildProcess
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "unknown thread id session-old",
        pid: 123,
        startedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "thread.started", thread_id: "session-fresh" }),
          JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
        ].join("\\n"),
        stderr: "",
        pid: 124,
        startedAt: new Date().toISOString(),
      });

    await execute({
      runId: "run-codex-cli-fallback-context",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Codex Coder",
        adapterType: "codex_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "session-old",
        sessionParams: { sessionId: "session-old", cwd: workspaceDir },
        sessionDisplayId: "session-old",
        taskKey: null,
      },
      config: {
        engine: "cli",
        command: "codex",
        env: { OPENAI_API_KEY: "fixture-openai-key" },
      },
      context: {
        ...createPromptContextFixture(),
        paperclipWorkspace: { cwd: workspaceDir, source: "project_primary" },
      },
      onLog: async () => {},
    });

    expect(runChildProcess).toHaveBeenCalledTimes(2);
    const first = (runChildProcess.mock.calls[0] as unknown as [string, string, string[], { stdin?: string }])[3]?.stdin ?? "";
    const retry = (runChildProcess.mock.calls[1] as unknown as [string, string, string[], { stdin?: string }])[3]?.stdin ?? "";
    expect(first).toContain("## Compact assignment");
    expect(first).not.toContain("Explain the next step before starting work.");
    expect(retry).toContain("## Owned assignment");
    expect(retry).toContain("Explain the next step before starting work.");
    expect(retry).not.toContain("## Compact assignment");
    expect(retry.indexOf("comment-first")).toBeLessThan(retry.indexOf("comment-second"));
    expect(retry.split("Append the same ledger entry.")).toHaveLength(3);
  });

});
