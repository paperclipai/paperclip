import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";

// A shared handle so the managed-config test can force the runtime preparation
// step to throw an error that carries untrusted markers.
const { prepareAdapterExecutionTargetRuntime } = vi.hoisted(() => ({
  prepareAdapterExecutionTargetRuntime: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetUsesManagedHome: () => true,
    maybeRunSandboxInstallCommand: async () => null,
    prepareAdapterExecutionTargetRuntime,
  };
});

import {
  isManagedClaudeConfigPath,
  materializeLocalManagedClaudeConfig,
  materializeLocalManagedClaudeHomeRoot,
  prepareClaudeConfigSeed,
  prepareSandboxClaudeProbeRuntime,
  resolveManagedClaudeAgentHomeDir,
  resolveManagedClaudeHomeRootDir,
} from "./claude-config.js";

describe("prepareClaudeConfigSeed", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  function createEnv(root: string, sourceDir: string): NodeJS.ProcessEnv {
    return {
      HOME: root,
      PAPERCLIP_HOME: path.join(root, "paperclip-home"),
      PAPERCLIP_INSTANCE_ID: "test-instance",
      CLAUDE_CONFIG_DIR: sourceDir,
    };
  }

  it("reuses the same snapshot path when the seeded files are unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-seed-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      theme: "light",
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, ".credentials.json"), JSON.stringify({ token: "local" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);

    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(first).toBe(second);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.access(path.join(first, ".credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps an existing snapshot intact when the seeded files change", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-race-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "light" }), "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const first = await prepareClaudeConfigSeed(env, onLog, "company-1");

    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    const second = await prepareClaudeConfigSeed(env, onLog, "company-1");

    expect(second).not.toBe(first);
    await expect(fs.readFile(path.join(first, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "light", permissions: { defaultMode: "default" } }));
    await expect(fs.readFile(path.join(second, "settings.json"), "utf8"))
      .resolves.toBe(JSON.stringify({ theme: "dark", permissions: { defaultMode: "default" } }));
  });

  it("strips local-only settings from remote Claude config seeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-boundary-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, "settings.json"), JSON.stringify({
      permissions: {
        defaultMode: "dontAsk",
        allow: ["Bash(op item *)"],
      },
      hooks: { PreToolUse: [{ matcher: "*" }] },
      mcpServers: { local: { command: "secret-local-server" } },
      permissionMode: "dontAsk",
      skipDangerousModePermissionPrompt: true,
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "settings.local.json"), JSON.stringify({
      permissions: { defaultMode: "bypassPermissions" },
    }), "utf8");
    await fs.writeFile(path.join(sourceDir, "credentials.json"), JSON.stringify({ token: "local" }), "utf8");
    await fs.writeFile(path.join(sourceDir, "CLAUDE.md"), "local instructions", "utf8");

    const onLog = vi.fn(async () => {});
    const env = createEnv(root, sourceDir);
    const seedDir = await prepareClaudeConfigSeed(env, onLog, "company-1");
    const remoteSettings = JSON.parse(await fs.readFile(path.join(seedDir, "settings.json"), "utf8"));

    expect(remoteSettings.permissions).toEqual({ defaultMode: "default" });
    expect(remoteSettings.hooks).toBeUndefined();
    expect(remoteSettings.mcpServers).toBeUndefined();
    expect(remoteSettings.permissionMode).toBeUndefined();
    expect(remoteSettings.skipDangerousModePermissionPrompt).toBeUndefined();
    await expect(fs.access(path.join(seedDir, "settings.local.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(path.join(seedDir, "credentials.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(seedDir, "CLAUDE.md"), "utf8"))
      .resolves.toBe("local instructions");
  });
});

describe("prepareSandboxClaudeProbeRuntime managed-config diagnostics", () => {
  const cleanupDirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  const sandboxTarget: AdapterExecutionTarget = {
    kind: "remote",
    transport: "sandbox",
    providerKey: "daytona",
    remoteCwd: "/home/daytona/paperclip-workspace",
    runner: {
      execute: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
        pid: null,
        startedAt: new Date().toISOString(),
      }),
    },
  };

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("keeps a thrown config-materialization error out of every check and the log", async () => {
    // The runtime preparation throws an error that carries two untrusted values:
    // an opaque credential marker and a proxy marker. Neither may reach a check
    // or the server log. The log carries only the fixed context, the allowlisted
    // classification, and the safe error class name.
    const opaqueCredMarker = "OPAQUECREDMARKERconfig";
    const proxyMarker = "http://user:pass@proxy.corp.internal:3128";

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-config-mgmt-"));
    cleanupDirs.push(root);
    const sourceDir = path.join(root, "claude-source");
    await fs.mkdir(sourceDir, { recursive: true });

    for (const key of ["CLAUDE_CONFIG_DIR", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) {
      savedEnv[key] = process.env[key];
    }
    process.env.CLAUDE_CONFIG_DIR = sourceDir;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";

    prepareAdapterExecutionTargetRuntime.mockRejectedValueOnce(
      new Error(`materialize failed with ${opaqueCredMarker} via ${proxyMarker}`),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const checks = await prepareSandboxClaudeProbeRuntime({
      runId: "run-1",
      target: sandboxTarget,
      // The probe passes no CLAUDE_CONFIG_DIR, so the managed branch runs.
      cwd: "/home/daytona/paperclip-workspace",
      companyId: "company-1",
      env: {},
      installCommand: "install-claude",
      detectCommand: "claude",
      targetIsRemote: true,
      targetIsSandbox: true,
      helloProbeTimeoutSec: 30,
    });

    const failed = checks.find((check) => check.code === "claude_managed_config_dir_failed");
    expect(failed).toBeTruthy();
    const checkText = JSON.stringify(checks);
    expect(checkText).not.toContain(opaqueCredMarker);
    expect(checkText).not.toContain("proxy.corp.internal");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(warnSpy.mock.calls);
    expect(loggedText).not.toContain(opaqueCredMarker);
    expect(loggedText).not.toContain("proxy.corp.internal");
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      classification: "spawn_error",
      errorClass: "Error",
    });
    warnSpy.mockRestore();
  });
});

describe("resolveManagedClaudeAgentHomeDir / isManagedClaudeConfigPath", () => {
  it("scopes the agent home dir under the company/agent tree and recognizes it as managed", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: "/paperclip-home",
      PAPERCLIP_INSTANCE_ID: "test-instance",
    };
    const dirA = resolveManagedClaudeAgentHomeDir(env, "company-1", "agent-a");
    const dirB = resolveManagedClaudeAgentHomeDir(env, "company-1", "agent-b");

    expect(dirA).not.toBe(dirB);
    expect(dirA).toContain(path.join("companies", "company-1", "agents", "agent-a", "claude-home"));
    expect(isManagedClaudeConfigPath(env, "company-1", dirA)).toBe(true);
    expect(isManagedClaudeConfigPath(env, "company-1", path.join(os.homedir(), ".claude"))).toBe(false);
    expect(isManagedClaudeConfigPath(env, undefined, dirA)).toBe(false);
  });
});

describe("materializeLocalManagedClaudeConfig", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("seeds settings/CLAUDE.md and copies a login without clobbering an existing one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-managed-"));
    cleanupDirs.push(root);
    const hostDir = path.join(root, "host-claude");
    const managedDir = path.join(root, "agent-claude-home");
    await fs.mkdir(hostDir, { recursive: true });
    await fs.writeFile(path.join(hostDir, "settings.json"), JSON.stringify({ theme: "dark" }), "utf8");
    await fs.writeFile(path.join(hostDir, "credentials.json"), JSON.stringify({ token: "host-secret" }), "utf8");

    const onLog = vi.fn(async () => {});
    await materializeLocalManagedClaudeConfig({
      claudeConfigDir: managedDir,
      hostClaudeConfigDir: hostDir,
      companyId: "company-1",
      onLog,
    });

    await expect(fs.readFile(path.join(managedDir, "credentials.json"), "utf8")).resolves.toContain("host-secret");
    expect(onLog.mock.calls[0]?.[1]).toContain("login copied in");

    // A login already present in the managed dir must never be overwritten by
    // a later materialize call, even if the host credentials change.
    await fs.writeFile(path.join(managedDir, "credentials.json"), JSON.stringify({ token: "agent-own-secret" }), "utf8");
    await fs.writeFile(path.join(hostDir, "credentials.json"), JSON.stringify({ token: "host-secret-rotated" }), "utf8");
    await materializeLocalManagedClaudeConfig({
      claudeConfigDir: managedDir,
      hostClaudeConfigDir: hostDir,
      companyId: "company-1",
      onLog,
    });
    await expect(fs.readFile(path.join(managedDir, "credentials.json"), "utf8")).resolves.toContain("agent-own-secret");
  });
});

describe("resolveManagedClaudeHomeRootDir", () => {
  it("scopes a per-agent home root distinct from the config dir and from other agents", () => {
    const env: NodeJS.ProcessEnv = {
      PAPERCLIP_HOME: "/paperclip-home",
      PAPERCLIP_INSTANCE_ID: "test-instance",
    };
    const homeRootA = resolveManagedClaudeHomeRootDir(env, "company-1", "agent-a");
    const homeRootB = resolveManagedClaudeHomeRootDir(env, "company-1", "agent-b");
    const configDirA = resolveManagedClaudeAgentHomeDir(env, "company-1", "agent-a");

    expect(homeRootA).not.toBe(homeRootB);
    expect(homeRootA).not.toBe(configDirA);
    expect(homeRootA).toContain(path.join("companies", "company-1", "agents", "agent-a", "claude-home-root"));
    expect(isManagedClaudeConfigPath(env, "company-1", homeRootA)).toBe(true);
  });
});

describe("materializeLocalManagedClaudeHomeRoot", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("copies the host's top-level .claude.json without clobbering an existing one", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-home-root-"));
    cleanupDirs.push(root);
    const hostHomeDir = path.join(root, "host-home");
    const homeRootDir = path.join(root, "agent-claude-home-root");
    await fs.mkdir(hostHomeDir, { recursive: true });
    await fs.writeFile(path.join(hostHomeDir, ".claude.json"), JSON.stringify({ oauthAccount: "host-secret" }), "utf8");

    const onLog = vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {});
    await materializeLocalManagedClaudeHomeRoot({ homeRootDir, hostHomeDir, onLog });

    await expect(fs.readFile(path.join(homeRootDir, ".claude.json"), "utf8")).resolves.toContain("host-secret");
    expect(onLog.mock.calls[0]?.[1]).toContain(".claude.json copied in");

    // Once the managed home root has its own .claude.json, a later host
    // rotation must never clobber it.
    await fs.writeFile(path.join(homeRootDir, ".claude.json"), JSON.stringify({ oauthAccount: "agent-own-secret" }), "utf8");
    await fs.writeFile(path.join(hostHomeDir, ".claude.json"), JSON.stringify({ oauthAccount: "host-secret-rotated" }), "utf8");
    await materializeLocalManagedClaudeHomeRoot({ homeRootDir, hostHomeDir, onLog });
    await expect(fs.readFile(path.join(homeRootDir, ".claude.json"), "utf8")).resolves.toContain("agent-own-secret");
  });

  it("never touches the host's .claude.json", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-local-home-root-"));
    cleanupDirs.push(root);
    const hostHomeDir = path.join(root, "host-home");
    const homeRootDir = path.join(root, "agent-claude-home-root");
    await fs.mkdir(hostHomeDir, { recursive: true });
    await fs.writeFile(path.join(hostHomeDir, ".claude.json"), JSON.stringify({ oauthAccount: "host-secret" }), "utf8");

    await materializeLocalManagedClaudeHomeRoot({ homeRootDir, hostHomeDir, onLog: async () => {} });

    await expect(fs.readFile(path.join(hostHomeDir, ".claude.json"), "utf8")).resolves.toContain("host-secret");
  });
});
