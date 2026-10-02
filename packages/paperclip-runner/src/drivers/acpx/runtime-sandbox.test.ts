import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import { createAcpxRecoveryBinding } from "./recovery-identity.js";
import {
  prepareAcpxRuntimeSandbox,
  refreshCopilotSystemInstructions,
  readAcpxRecoveryWorkspace,
} from "./runtime-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ACPX runtime sandbox", () => {
  it("restores Grok permission controls on recovery without importing compatible hooks or credentials", async () => {
    const fixture = await sandboxFixture("grok");
    const sandbox = await prepareAcpxRuntimeSandbox({ binding: fixture.binding, agent: "grok" });
    const configPath = join(sandbox.agentHomeDirectory, "config.toml");
    const requirementsPath = join(sandbox.agentHomeDirectory, "requirements.toml");
    await writeFile(configPath, '[permission]\nallow = ["Bash"]\n');
    await writeFile(requirementsPath, '[ui]\ndisable_bypass_permissions_mode = false\n');
    await prepareAcpxRuntimeSandbox({ binding: fixture.binding, agent: "grok" });
    const config = await readFile(configPath, "utf8");
    expect(config).toContain('ask = ["Bash", "Read", "Edit", "Grep", "MCPTool", "WebFetch", "WebSearch"]');
    expect(config).not.toContain('allow =');
    expect(config).toContain('login_shell_capture = false');
    expect(config).toContain('exclude = ["XAI_API_KEY"]');
    expect(config).toContain('[compat.claude]\nhooks = false\nmcps = false');
    expect(await readFile(requirementsPath, "utf8")).toContain('disable_bypass_permissions_mode = true');
    expect((await stat(requirementsPath)).mode & 0o777).toBe(0o600);
  });

  it.each(["claude-sonnet-5", "sonnet", "custom-deployment-id"])(
    "preserves the requested Claude model %s in its isolated settings",
    async (model) => {
      const fixture = await sandboxFixture("claude");
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: { ...fixture.binding, requestedModel: model },
        agent: "claude",
      });
      const settingsPath = join(sandbox.agentHomeDirectory, "settings.json");
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
        model,
        availableModels: [model],
      });
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600);
    },
  );

  it("pins Claude's exact model in isolated settings on open and recovery", async () => {
    const fixture = await sandboxFixture("claude");
    for (const model of ["claude-sonnet-5", "custom-claude-model"]) {
      const binding = { ...fixture.binding, requestedModel: model, effectiveModel: model };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const sandbox = await prepareAcpxRuntimeSandbox({ binding, agent: "claude" });
        const settings = JSON.parse(await readFile(join(sandbox.agentHomeDirectory, "settings.json"), "utf8"));
        expect(settings).toMatchObject({ model, availableModels: [model] });
      }
    }
  });

  it.each([
    ["pi", "OPENROUTER_API_KEY", "pi-home"],
    ["claude", "ANTHROPIC_API_KEY", "claude-home"],
    ["codex", "OPENAI_API_KEY", "codex-home"],
    ["cursor", "CURSOR_API_KEY", "cursor-home"],
    ["copilot", "COPILOT_GITHUB_TOKEN", "copilot-home"],
  ] as const)(
    "creates a private %s filesystem and split environment",
    async (agent, credentialName, homeSuffix) => {
      const fixture = await sandboxFixture(agent);
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent,
        providerPolicy: { readOnly: false, systemInstructions: "bound instructions" },
        environment: {
          PATH: process.env.PATH,
          [credentialName]: "provider-secret",
          UNRELATED_SECRET: "must-not-enter",
          HOME: "/ambient/home", XDG_CONFIG_HOME: "/ambient/config", CURSOR_CONFIG_DIR: "/ambient/cursor",
          COPILOT_HOME: "/ambient/copilot", COPILOT_PKG_CACHE_HOME: "/ambient/extraction-cache", COPILOT_ALLOW_ALL: "true",
          PAPERCLIP_PI_READ_ONLY: "1", PAPERCLIP_PI_READ_ROOTS: '["/"]', PAPERCLIP_PI_ENTRYPOINT: "/ambient/pi.js",
          HTTPS_PROXY: "https://proxy-user:proxy-password@example.test",
          PAPERCLIP_NATIVE_MCP_URL:
            "https://mcp.example.test/connect?ticket=secret",
          PAPERCLIP_NATIVE_MCP_TOKEN: "native-secret",
        },
      });

      expect(sandbox.agentHomeDirectory).toContain(homeSuffix);
      expect(sandbox.launchEnvironment[credentialName]).toBe("provider-secret");
      expect(sandbox.launchEnvironment.HTTPS_PROXY).toContain("proxy-password");
      expect(sandbox.launchEnvironment.UNRELATED_SECRET).toBeUndefined();
      expect(
        sandbox.launchEnvironment.PAPERCLIP_NATIVE_MCP_TOKEN,
      ).toBeUndefined();
      expect(sandbox.launchEnvironment.HOME).toBe(sandbox.homeDirectory);
      expect(sandbox.launchEnvironment.XDG_CONFIG_HOME).toBe(
        sandbox.configDirectory,
      );
      expect(sandbox.launchEnvironment.XDG_DATA_HOME).toBe(
        sandbox.dataDirectory,
      );
      expect(sandbox.launchEnvironment.XDG_CACHE_HOME).toBe(
        sandbox.cacheDirectory,
      );
      expect(Object.isFrozen(sandbox.launchEnvironment)).toBe(true);
      expect(sandbox.persistedEnvironment[credentialName]).toBeUndefined();
      expect(sandbox.persistedEnvironment.HTTPS_PROXY).toBeUndefined();
      expect(
        sandbox.persistedEnvironment.PAPERCLIP_NATIVE_MCP_URL,
      ).toBeUndefined();
      expect(
        sandbox.persistedEnvironment.PAPERCLIP_NATIVE_MCP_TOKEN,
      ).toBeUndefined();
      expect(sandbox.persistedEnvironment.HOME).toBe(sandbox.homeDirectory);
      if (agent === "codex") {
        const config = await readFile(
          join(sandbox.agentHomeDirectory, "config.toml"),
          "utf8",
        );
        expect(config).toBe("[features]\nshell_snapshot = false\n");
        expect(config).not.toContain("provider-secret");
      }
      expect(await readFile(sandbox.workspaceRecordPath, "utf8")).toBe(
        `${fixture.binding.workspacePath}\n`,
      );
      const recoveryWorkspace = await readAcpxRecoveryWorkspace({
        runtimeDirectory: join(fixture.root, "runtime"),
        normalizedSessionId: `sandbox-${agent}`,
      });
      expect(recoveryWorkspace.path).toBe(fixture.binding.workspacePath);
      expect(() => recoveryWorkspace.assertHeld()).not.toThrow();
      await recoveryWorkspace.close();
      expect((await lstat(sandbox.root)).isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") {
        expect((await stat(sandbox.root)).mode & 0o777).toBe(0o700);
        expect((await stat(sandbox.workspaceRecordPath)).mode & 0o777).toBe(
          0o600,
        );
      }
      expect(sandbox.protectedPaths).toEqual([dirname(dirname(sandbox.root))]);
      expect(sandbox.launchEnvironment.PAPERCLIP_PI_ENTRYPOINT).toBeUndefined();
      expect(sandbox.launchEnvironment.COPILOT_PKG_CACHE_HOME).toBeUndefined();
      if (agent === "cursor") {
        expect(sandbox.launchEnvironment).toMatchObject({
          CURSOR_CONFIG_DIR: sandbox.agentHomeDirectory, CURSOR_DATA_DIR: sandbox.dataDirectory,
          AGENT_CLI_CREDENTIAL_STORE: "memory", NO_OPEN_BROWSER: "1", NODE_DISABLE_COMPILE_CACHE: "1",
        });
      }
      if (agent === "copilot") {
        expect(sandbox.launchEnvironment).toMatchObject({
          COPILOT_HOME: sandbox.agentHomeDirectory, COPILOT_CACHE_HOME: sandbox.cacheDirectory,
          COPILOT_AUTO_UPDATE: "false", COPILOT_ALLOW_ALL: "false", COPILOT_DISABLE_TERMINAL_TITLE: "true", NO_COLOR: "1",
        });
        expect(JSON.parse(await readFile(join(sandbox.agentHomeDirectory, "config.json"), "utf8"))).toEqual({
          autoUpdate: false, trustedFolders: [], disableAllHooks: true, memory: false,
          ide: { autoConnect: false, openDiffOnEdit: false },
        });
      }
      if (agent === "pi") {
        expect(sandbox.launchEnvironment).toMatchObject({
          PAPERCLIP_PI_READ_ONLY: "0", PAPERCLIP_PI_READ_ROOTS: "[]",
          PAPERCLIP_PI_PROTECTED_ROOTS: JSON.stringify(sandbox.protectedPaths),
          PAPERCLIP_PI_SYSTEM_INSTRUCTIONS: "bound instructions",
        });
        expect(sandbox.persistedEnvironment.PAPERCLIP_PI_SYSTEM_INSTRUCTIONS).toBeUndefined();
        await expect(
          readFile(join(sandbox.agentHomeDirectory, "settings.json"), "utf8"),
        ).resolves.toContain('"defaultProjectTrust":"never"');
      }
    },
  );

  it("requires Pi task policy and validates assigned roots independently from approval mode", async () => {
    const fixture = await sandboxFixture("pi");
    await expect(prepareAcpxRuntimeSandbox({ binding: fixture.binding, agent: "pi" })).rejects.toThrow("explicit task execution policy");
    const readRoot = join(fixture.root, "assigned-skills");
    await mkdir(readRoot);
    const sandbox = await prepareAcpxRuntimeSandbox({
      binding: { ...fixture.binding, permissionMode: "approve-all" }, agent: "pi",
      providerPolicy: { readOnly: true, readRoots: [readRoot], protectedPaths: ["/verified/provider-pack"] },
    });
    expect(sandbox.launchEnvironment.PAPERCLIP_PI_READ_ONLY).toBe("1");
    expect(JSON.parse(sandbox.launchEnvironment.PAPERCLIP_PI_READ_ROOTS!)).toHaveLength(1);
    expect(sandbox.protectedPaths).toContain("/verified/provider-pack");
    for (const readRoots of [["/"], ["relative"], ["/missing/assigned-skills"]]) {
      await expect(prepareAcpxRuntimeSandbox({ binding: fixture.binding, agent: "pi", providerPolicy: { readOnly: false, readRoots } })).rejects.toThrow();
    }
    await expect(prepareAcpxRuntimeSandbox({ binding: fixture.binding, agent: "pi", providerPolicy: { readOnly: false, systemInstructions: "x".repeat(32 * 1024 + 1) } })).rejects.toThrow("bounded size");
  });

  it("re-prepares and re-synchronizes an existing private sandbox", async () => {
    const fixture = await sandboxFixture("claude");
    const first = await prepareAcpxRuntimeSandbox({
      binding: fixture.binding,
      agent: "claude",
      environment: { ANTHROPIC_API_KEY: "first" },
    });
    const second = await prepareAcpxRuntimeSandbox({
      binding: fixture.binding,
      agent: "claude",
      environment: { ANTHROPIC_API_KEY: "second" },
    });

    expect(second.root).toBe(first.root);
    expect(second.launchEnvironment.ANTHROPIC_API_KEY).toBe("second");
    expect(await readFile(second.workspaceRecordPath, "utf8")).toBe(
      `${fixture.binding.workspacePath}\n`,
    );
  });

  it.runIf(process.platform !== "win32")(
    "repairs existing directory permissions through its no-follow handle",
    async () => {
      const fixture = await sandboxFixture("codex");
      const first = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent: "codex",
      });
      await chmod(first.root, 0o755);

      const second = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent: "codex",
      });

      expect(second.root).toBe(first.root);
      expect((await stat(second.root)).mode & 0o777).toBe(0o700);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symbolic-link ACPX namespace",
    async () => {
      const fixture = await sandboxFixture("codex");
      const namespace = dirname(fixture.binding.runtimeRoot);
      const outside = join(fixture.root, "outside");
      await mkdir(outside);
      await symlink(outside, namespace);

      await expect(
        prepareAcpxRuntimeSandbox({
          binding: fixture.binding,
          agent: "codex",
        }),
      ).rejects.toThrow(/real directory|escaped/);
    },
  );

  it("rejects a malformed workspace recovery record", async () => {
    const fixture = await sandboxFixture("codex");
    const sandbox = await prepareAcpxRuntimeSandbox({
      binding: fixture.binding,
      agent: "codex",
    });
    const handle = await open(sandbox.workspaceRecordPath, "a");
    await handle.write("extra");
    await handle.close();

    await expect(
      readAcpxRecoveryWorkspace({
        runtimeDirectory: join(fixture.root, "runtime"),
        normalizedSessionId: "sandbox-codex",
      }),
    ).rejects.toThrow("record is invalid");
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a substituted workspace recovery record",
    async () => {
      const fixture = await sandboxFixture("codex");
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent: "codex",
      });
      await rm(sandbox.workspaceRecordPath);
      await symlink(fixture.binding.workspacePath, sandbox.workspaceRecordPath);

      await expect(
        readAcpxRecoveryWorkspace({
          runtimeDirectory: join(fixture.root, "runtime"),
          normalizedSessionId: "sandbox-codex",
        }),
      ).rejects.toThrow("record is unavailable");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a substituted recovery session directory",
    async () => {
      const fixture = await sandboxFixture("codex");
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent: "codex",
      });
      const outside = join(fixture.root, "outside-recovery");
      await mkdir(outside);
      await rm(sandbox.root, { recursive: true });
      await symlink(outside, sandbox.root);

      await expect(
        readAcpxRecoveryWorkspace({
          runtimeDirectory: join(fixture.root, "runtime"),
          normalizedSessionId: "sandbox-codex",
        }),
      ).rejects.toThrow("runtime directory is unavailable");
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a recovery session directory swapped after its handle is pinned",
    async () => {
      const fixture = await sandboxFixture("codex");
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent: "codex",
      });
      const displacedRoot = `${sandbox.root}-displaced`;

      await expect(
        readAcpxRecoveryWorkspace(
          {
            runtimeDirectory: join(fixture.root, "runtime"),
            normalizedSessionId: "sandbox-codex",
          },
          {
            afterRuntimeRootPinned: async () => {
              await rename(sandbox.root, displacedRoot);
              await mkdir(sandbox.root);
              await writeFile(
                join(sandbox.root, "workspace"),
                `${fixture.binding.workspacePath}\n`,
              );
            },
          },
        ),
      ).rejects.toThrow("workspace record is unavailable");
    },
  );

  it.runIf(process.platform !== "win32")(
    "pins the recovered workspace until provider admission",
    async () => {
      const fixture = await sandboxFixture("codex");
      await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent: "codex",
      });
      const recoveryWorkspace = await readAcpxRecoveryWorkspace({
        runtimeDirectory: join(fixture.root, "runtime"),
        normalizedSessionId: "sandbox-codex",
      });
      const displacedWorkspace = `${fixture.binding.workspacePath}-displaced`;
      await rename(fixture.binding.workspacePath, displacedWorkspace);
      await mkdir(fixture.binding.workspacePath);

      expect(() => recoveryWorkspace.assertHeld()).toThrow(
        "workspace changed before provider admission",
      );
      await recoveryWorkspace.close();
    },
  );
});

it("refreshes Copilot native instructions privately on every admission, including removal", async () => {
  const fixture = await sandboxFixture("copilot");
  const prepare = async (systemInstructions: string) => {
    const sandbox = await prepareAcpxRuntimeSandbox({
      binding: fixture.binding, agent: "copilot", providerPolicy: { readOnly: false, systemInstructions },
    });
    await refreshCopilotSystemInstructions(sandbox, systemInstructions);
    return sandbox;
  };
  const first = await prepare("Original registered instructions.");
  const path = join(first.agentHomeDirectory, "copilot-instructions.md");
  expect(await readFile(path, "utf8")).toBe("Original registered instructions.\n");
  await prepareAcpxRuntimeSandbox({ binding: fixture.binding, agent: "copilot",
    providerPolicy: { readOnly: false, systemInstructions: "Contender must not write during preparation." } });
  expect(await readFile(path, "utf8")).toBe("Original registered instructions.\n");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(first.protectedPaths).toContain(dirname(dirname(first.root)));
  expect(path.startsWith(`${first.protectedPaths[0]}/`)).toBe(true);
  const target = join(fixture.root, "unrelated-file");
  await writeFile(target, "Do not overwrite.");
  await rm(path);
  await symlink(target, path);
  await prepare("Current registered instructions.");
  expect((await lstat(path)).isSymbolicLink()).toBe(false);
  expect(await readFile(target, "utf8")).toBe("Do not overwrite.");
  expect(await readFile(path, "utf8")).toBe("Current registered instructions.\n");
  await prepare("");
  expect(await readFile(path, "utf8")).toBe("\n");
  await expect(prepare("x".repeat(32 * 1024 + 1))).rejects.toThrow("bounded size");
  expect(await readFile(path, "utf8")).toBe("\n");
});

async function sandboxFixture(agent: "pi" | "claude" | "codex" | "grok" | "cursor" | "copilot") {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-sandbox-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const runtimeDirectory = join(root, "runtime");
  await Promise.all([mkdir(workspace), mkdir(runtimeDirectory)]);
  const models = {
    grok: "grok-4.7",
    pi: "openrouter/deepseek/deepseek-v4-flash-0731",
    claude: "claude-sonnet-5",
    codex: "gpt-5.6-sol",
    cursor: "provider-model-cursor",
    copilot: "provider-model-copilot",
  } as const;
  const binding = await createAcpxRecoveryBinding({
    runtimeDirectory,
    normalizedSessionId: `sandbox-${agent}`,
    workingDirectory: workspace,
    profile: resolveQualifiedAcpxProfile(agent, models[agent]),
    requestedModel: models[agent],
    ...(agent === "pi" ? { piThinkingLevel: "low" as const } : {}),
    permissionMode: "approve-reads",
  });
  return { root, binding };
}
