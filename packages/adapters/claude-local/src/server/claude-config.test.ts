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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildRemoteClaudeConfigMaterializationCommand,
  CLAUDE_TOOL_SHELL_PREFIX_SCRIPT,
  materializeRemoteClaudeConfig,
  prepareClaudeConfigSeed,
  prepareSandboxClaudeProbeRuntime,
  resolveRemoteClaudeToolShellPrefixPath,
} from "./claude-config.js";

const execFileAsync = promisify(execFile);

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

describe("Claude tool shell prefix", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function installPrefix() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-tool-prefix-"));
    cleanupDirs.push(root);
    const prefixPath = path.join(root, "runtime", "tool-shell-prefix.sh");
    const command = buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: path.join(root, "runtime", "config"),
      remoteClaudeConfigSeedDir: path.join(root, "runtime", "config-seed"),
      remoteToolShellPrefixPath: prefixPath,
    });
    const { stdout } = await execFileAsync("/bin/sh", ["-c", command], { env: { PATH: process.env.PATH ?? "" } });
    return { root, prefixPath, stdout };
  }

  async function runThroughPrefix(prefixPath: string, commandString: string, env: Record<string, string>) {
    const { stdout } = await execFileAsync(prefixPath, [commandString], { env });
    return stdout.trim();
  }

  it("installs the script as a private executable and reports the install", async () => {
    const { prefixPath, stdout } = await installPrefix();
    await expect(fs.readFile(prefixPath, "utf8")).resolves.toBe(CLAUDE_TOOL_SHELL_PREFIX_SCRIPT);
    expect((await fs.stat(prefixPath)).mode & 0o777).toBe(0o700);
    expect(stdout).toContain("[paperclip] Installed the Claude tool shell prefix.");
    await expect(fs.stat(`${prefixPath}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the materialization command unchanged without a prefix path", () => {
    const command = buildRemoteClaudeConfigMaterializationCommand({
      remoteClaudeConfigDir: "/sandbox/runtime/config",
      remoteClaudeConfigSeedDir: "/sandbox/runtime/config-seed",
    });
    expect(command.endsWith("done")).toBe(true);
    expect(command).not.toContain("tool shell prefix");
  });

  it.runIf(process.platform === "linux")(
    "raises the tool command's out-of-memory score and keeps the caller's score",
    async () => {
      const { prefixPath } = await installPrefix();
      const before = (await fs.readFile("/proc/self/oom_score_adj", "utf8")).trim();
      const score = await runThroughPrefix(prefixPath, "cat /proc/self/oom_score_adj", {
        PATH: process.env.PATH ?? "",
        SHELL: "/bin/bash",
      });
      expect(score).toBe("1000");
      expect((await fs.readFile("/proc/self/oom_score_adj", "utf8")).trim()).toBe(before);
    },
  );

  it("runs the command string in the shell Claude Code selects", async () => {
    const { root, prefixPath } = await installPrefix();
    const bash = (await execFileAsync("/bin/sh", ["-c", "command -v bash"])).stdout.trim();
    const probe = 'if [ -n "${BASH_VERSION:-}" ]; then echo bash; else echo other; fi';
    await expect(runThroughPrefix(prefixPath, probe, { PATH: process.env.PATH ?? "", SHELL: bash }))
      .resolves.toBe("bash");
    await expect(runThroughPrefix(prefixPath, probe, {
      PATH: process.env.PATH ?? "",
      SHELL: bash,
      CLAUDE_CODE_SHELL: "/missing/bash",
    })).resolves.toBe("bash");
    const binDir = path.join(root, "bin");
    await fs.mkdir(binDir, { recursive: true });
    await fs.symlink(bash, path.join(binDir, "bash"));
    await expect(runThroughPrefix(prefixPath, probe, { PATH: binDir, SHELL: "/bin/sh" }))
      .resolves.toBe("bash");
    await expect(runThroughPrefix(prefixPath, `printf '%s' "q'uote"`, { PATH: process.env.PATH ?? "", SHELL: bash }))
      .resolves.toBe("q'uote");
    await expect(execFileAsync(prefixPath, ["exit 7"], { env: { PATH: process.env.PATH ?? "", SHELL: bash } }))
      .rejects.toMatchObject({ code: 7 });
  });

  it("keeps an operator prefix", () => {
    expect(resolveRemoteClaudeToolShellPrefixPath({ CLAUDE_CODE_SHELL_PREFIX: "/opt/audit.sh" }, "/sandbox/runtime"))
      .toBeNull();
    expect(resolveRemoteClaudeToolShellPrefixPath({}, "/sandbox/runtime"))
      .toBe("/sandbox/runtime/tool-shell-prefix.sh");
  });

  it("reports no install when the sandbox does not confirm it", async () => {
    const target: AdapterExecutionTarget = {
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
    await expect(materializeRemoteClaudeConfig({
      runId: "run-1",
      target,
      remoteClaudeConfigDir: "/sandbox/runtime/config",
      remoteClaudeConfigSeedDir: "/sandbox/runtime/config-seed",
      remoteToolShellPrefixPath: "/sandbox/runtime/tool-shell-prefix.sh",
      options: { cwd: "/home/daytona/paperclip-workspace", env: {} },
    })).resolves.toEqual({ toolShellPrefixInstalled: false });
  });
});
