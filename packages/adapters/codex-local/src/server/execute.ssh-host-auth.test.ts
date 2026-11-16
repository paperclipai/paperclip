import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
  prepareWorkspaceForSshExecution,
  restoreWorkspaceFromSshExecution,
  runSshCommand,
  syncDirectoryToSsh,
  startAdapterExecutionTargetPaperclipBridge,
} = vi.hoisted(() => ({
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

import { execute } from "./execute.js";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";
import { buildProviderObservabilityLaunch } from "@paperclipai/adapter-utils/agent-observability";

describe("codex SSH host authentication", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each(["default", "configured", "in_place", "no_config", "observability", "unqualified_observability", "observability_profile", "observability_profile_missing", "observability_profile_symlink", "partial_upload", "partial_upload_in_place", "changed_config", "skill_conflict", "failed_install_retry"])("delivers Codex tools and skills while preserving native SSH authentication (%s)", async mode => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-codex-host-auth-"));
    cleanupDirs.push(root);
    const workspace = path.join(root, "workspace"), remote = path.join(root, "remote-workspace"), userHome = path.join(root, "remote-user");
    const native = mode === "configured" ? path.join(root, "custom-codex") : path.join(userHome, ".codex");
    const controller = path.join(root, "controller-home"), skill = path.join(root, "review");
    for (const dir of [workspace, remote, native, controller, skill, path.join(native, "skills", "manual")]) await mkdir(dir, { recursive: true });
    await writeFile(path.join(controller, "auth.json"), '{"tokens":{"account_id":"controller-only","refresh_token":"fixture-controller-token"}}');
    await writeFile(path.join(native, "auth.json"), "fixture-native-login");
    if (mode.startsWith("observability_profile")) {
      if (mode === "observability_profile") await writeFile(path.join(native, "work.config.toml"), 'model = "remote-profile-model"\n');
      else if (mode === "observability_profile_symlink") {
        await writeFile(path.join(native, "linked.config.toml"), 'model = "remote-linked-model"\n');
        await symlink(path.join(native, "linked.config.toml"), path.join(native, "work.config.toml"));
      }
      await writeFile(path.join(controller, "work.config.toml"), 'model = "controller-profile-model"\n');
    }
    if (mode !== "no_config") await writeFile(path.join(native, "config.toml"), 'model = "native-model"\n[mcp_servers.tools]\nurl = "https://native.example.test/mcp"\n');
    if (mode === "skill_conflict") {
      await mkdir(path.join(native, "skills", "review"));
      await writeFile(path.join(native, "skills", "review", "SKILL.md"), "native review skill");
    }
    await writeFile(path.join(native, "skills", "manual", "SKILL.md"), "native skill");
    await writeFile(path.join(skill, "SKILL.md"), "---\n---\nSelected review skill.\n");
    const bin = path.join(root, "fault-bin"), failCopy = path.join(root, "fail-config-copy");
    if (mode === "failed_install_retry") {
      await mkdir(bin);
      await writeFile(failCopy, "fail once");
      await writeFile(path.join(bin, "cp"), `#!/bin/sh
case "$1" in */config.toml) if [ -f ${shellQuote(failCopy)} ]; then rm -f ${shellQuote(failCopy)}; echo 'fixture config copy failed' >&2; exit 71; fi ;; esac
exec /bin/cp "$@"
`, { mode: 0o700 });
    }
    vi.stubEnv("CODEX_HOME", controller);
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
    const originalRun = runSshCommand.getMockImplementation()!, originalSync = syncDirectoryToSsh.getMockImplementation()!, originalChild = runChildProcess.getMockImplementation()!;
    const staged: string[] = [], remoteAssets: string[] = [];
    let calls = 0;
    try {
      runSshCommand.mockImplementation(async (_spec, command) => {
        const remoteEnv: NodeJS.ProcessEnv = { ...process.env, HOME: userHome, ...(mode === "failed_install_retry" ? { PATH: `${bin}:${process.env.PATH}` } : {}) };
        delete remoteEnv.CODEX_HOME;
        return promisify(execFile)("/bin/sh", ["-c", command!], { env: remoteEnv, timeout: 5000 });
      });
      syncDirectoryToSsh.mockImplementation(async input => {
        staged.push(input!.localDir); remoteAssets.push(input!.remoteDir);
        if (mode === "changed_config") await writeFile(path.join(native, "config.toml"), 'model = "changed-during-setup"\n');
        await expect(stat(path.join(input!.localDir, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
        await mkdir(input!.remoteDir, { recursive: true });
        await cp(input!.localDir, input!.remoteDir, { recursive: true, dereference: true });
        if (mode.startsWith("partial_upload")) throw new Error("fixture partial SSH upload");
      });
      runChildProcess.mockImplementation(async (...args: unknown[]) => {
        if ((args[2] as string[]).includes("--version")) return { exitCode: 0, signal: null, timedOut: false, stdout: mode === "unqualified_observability" ? "codex-cli 0.159.0\n" : "codex-cli 0.160.0\n", stderr: "", pid: 123, startedAt: new Date().toISOString() };
        const env = (args[3] as { env: Record<string, string> }).env;
        expect(env.CODEX_HOME).toBe(native);
        expect(env.HOME).toBeUndefined();
        if (mode.includes("observability") && !mode.endsWith("_missing") && !mode.endsWith("_symlink")) expect(await readFile(path.join(native, `paperclip-observability-${calls === 0 ? "remote-auth" : "remote-auth-next"}.config.toml`), "utf8")).toContain("otel");
        if (mode === "observability_profile_missing" || mode === "observability_profile_symlink") {
          expect(args[2]).toEqual(expect.arrayContaining(["--profile", "work", 'otel.exporter="none"']));
        }
        if (mode === "observability_profile") {
          const profileName = `paperclip-observability-${calls === 0 ? "remote-auth" : "remote-auth-next"}`;
          const profile = await readFile(path.join(native, `${profileName}.config.toml`), "utf8");
          expect(profile).toContain('model = "remote-profile-model"');
          expect(profile).toContain("https://collector.example.test/v1/logs");
          expect(args[2]).toEqual(expect.arrayContaining(["--profile", profileName]));
          expect(await readFile(path.join(native, "work.config.toml"), "utf8")).toBe('model = "remote-profile-model"\n');
        }
        expect(await readFile(path.join(native, "auth.json"), "utf8")).toBe(calls === 0 ? "fixture-native-login" : "fixture-native-refreshed");
        const config = await readFile(path.join(native, "config.toml"), "utf8");
        if (mode !== "no_config") {
          expect(config).toContain('model = "native-model"');
          expect(config).toContain("https://native.example.test/mcp");
        }
        if (calls++ === 0) {
          expect(config).toContain(mode === "no_config" ? '[mcp_servers."tools"]' : '[mcp_servers."paperclip-tools"]');
          expect(config).toContain("fixture-managed-gateway");
          expect(await readFile(path.join(native, "skills", "review", "SKILL.md"), "utf8")).toContain("Selected review");
          await writeFile(path.join(native, "auth.json"), "fixture-native-refreshed");
        } else {
          expect(config).not.toContain("fixture-managed-gateway");
          await expect(stat(path.join(native, "skills", "review"))).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await readFile(path.join(native, "skills", "manual", "SKILL.md"), "utf8")).toBe("native skill");
        return { exitCode: 0, signal: null, timedOut: false, stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n', stderr: "", pid: 123, startedAt: new Date().toISOString() };
      });
      const ctx = { runId: "remote-auth",
        observability: mode.includes("observability") ? buildProviderObservabilityLaunch({ kind: "codex", companyId: "company-1", agentId: "agent-1", revision: "revision", compatibilityKey: "fixture", enabled: mode.startsWith("observability_profile"), logsEndpoint: "https://collector.example.test/v1/logs", tracesEndpoint: "https://collector.example.test/v1/traces", capture: { userPrompts: false, assistantResponses: false, toolDetails: false, toolContent: false } }) : undefined,
        agent: { id: "agent-1", companyId: "company-1", name: "Remote auth", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "codex", ...(mode.startsWith("observability_profile") ? { extraArgs: ["--profile", "work"] } : {}), env: mode === "configured" ? { CODEX_HOME: native } : {},
          paperclipRuntimeSkills: [{ key: "company/review", runtimeName: "review", source: skill }], paperclipSkillSync: { desiredSkills: ["company/review"] } },
        context: { paperclipWorkspace: { cwd: workspace, source: "project_primary" }, paperclipManagedMcp: { managedMcpOnly: true, gateways: [{ name: "tools", endpointPath: "/managed-mcp", bearerToken: "fixture-managed-gateway" }] } },
        executionTarget: { kind: "remote" as const, transport: "ssh" as const, remoteCwd: remote,
          spec: { useHostAuth: true, host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: remote, remoteWorkspacePath: remote, privateKey: null, knownHosts: null, strictHostKeyChecking: true },
          workspaceRealization: { mode: ((mode === "in_place" || mode === "partial_upload_in_place") ? "in_place" : "copy") as "in_place" | "copy", authoritativeRoot: remote, pathAliases: [], outboundRestorePaths: [] } }, onLog: async () => {},
      };
      if (mode === "failed_install_retry") {
        await expect(execute(ctx)).rejects.toThrow();
        expect(runChildProcess).not.toHaveBeenCalled();
        expect(await readdir(path.join(native, "skills"))).toEqual(["manual"]);
        expect(await readFile(path.join(native, "auth.json"), "utf8")).toBe("fixture-native-login");
        expect(await readFile(path.join(native, "config.toml"), "utf8")).toContain('model = "native-model"');
      }
      if (mode === "changed_config" || mode === "skill_conflict" || mode.startsWith("partial_upload")) {
        await expect(execute(ctx)).rejects.toThrow(mode.startsWith("partial_upload") ? "fixture partial SSH upload" : "Cannot install remote Codex runtime configuration");
        expect(runChildProcess).not.toHaveBeenCalled();
        expect(await readFile(path.join(native, "auth.json"), "utf8")).toBe("fixture-native-login");
        if (mode === "changed_config") expect(await readFile(path.join(native, "config.toml"), "utf8")).toBe('model = "changed-during-setup"\n');
        else if (mode === "skill_conflict") expect(await readFile(path.join(native, "skills", "review", "SKILL.md"), "utf8")).toBe("native review skill");
        expect(restoreWorkspaceFromSshExecution).toHaveBeenCalledTimes(mode === "partial_upload_in_place" ? 0 : 1);
      } else {
        expect((await execute(ctx)).exitCode).toBe(0);
        expect((await execute({ ...ctx, runId: "remote-auth-next", config: { ...ctx.config, paperclipRuntimeSkills: [] }, context: { ...ctx.context, paperclipManagedMcp: { managedMcpOnly: true, gateways: [] } } })).exitCode).toBe(0);
        expect(calls).toBe(2);
        expect(await readFile(path.join(native, "auth.json"), "utf8")).toBe("fixture-native-refreshed");
      }
      expect(await readFile(path.join(controller, "auth.json"), "utf8")).toContain("controller-only");
      for (const dir of [...staged, ...remoteAssets]) await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(native)).some(name => name.startsWith(".paperclip-runtime-config.") || name.startsWith("paperclip-observability-"))).toBe(false);
    } finally {
      runSshCommand.mockImplementation(originalRun); syncDirectoryToSsh.mockImplementation(originalSync); runChildProcess.mockImplementation(originalChild); vi.unstubAllEnvs();
    }
  });
});
