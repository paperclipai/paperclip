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
  it("preserves the host-prepared tool environment in an external work-folder sandbox", async () => {
    const fixture = await sandboxFixture("codex");
    const home = join(fixture.root, "home");
    const sandbox = await prepareAcpxRuntimeSandbox({
      binding: fixture.binding, agent: "codex",
      environment: {
        HOME: home, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
        ...Object.fromEntries(["task", "agent", "user", "project", "repos"].map((scope) =>
          [`PAPERCLIP_${scope.toUpperCase()}_DIR`, join(home, scope)])),
      },
    });
    expect(await readFile(join(sandbox.agentHomeDirectory, "config.toml"), "utf8"))
      .toBe("allow_login_shell = false\n\n[features]\nshell_snapshot = false\n");
  });

  it.each(["approve-all", "approve-reads", "deny-all"] as const)(
    "uses the external sandbox boundary only for explicitly approved Codex execution (%s)", async (permissionMode) => {
      const fixture = await sandboxFixture("codex");
      const home = join(fixture.root, "home");
      const environment = {
        HOME: home, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1",
        INITIAL_AGENT_MODE: "agent-full-access",
        ...Object.fromEntries(["task", "agent", "user", "project", "repos"].map((scope) =>
          [`PAPERCLIP_${scope.toUpperCase()}_DIR`, join(home, scope)])),
      };
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: { ...fixture.binding, permissionMode }, agent: "codex", environment,
      });
      expect(sandbox.launchEnvironment.INITIAL_AGENT_MODE).toBe(permissionMode === "approve-all" ? "agent-full-access" : undefined);
      const local = await prepareAcpxRuntimeSandbox({
        binding: { ...fixture.binding, permissionMode }, agent: "codex",
        environment: { ...environment, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: undefined },
      });
      expect(local.launchEnvironment.INITIAL_AGENT_MODE).toBeUndefined();
    },
  );

  it.each([
    ["pi", "OPENROUTER_API_KEY", "pi-home"],
    ["claude", "ANTHROPIC_API_KEY", "claude-home"],
    ["codex", "OPENAI_API_KEY", "codex-home"],
  ] as const)(
    "creates a private %s filesystem and split environment",
    async (agent, credentialName, homeSuffix) => {
      const fixture = await sandboxFixture(agent);
      const sandbox = await prepareAcpxRuntimeSandbox({
        binding: fixture.binding,
        agent,
        environment: {
          PATH: process.env.PATH,
          [credentialName]: "provider-secret",
          UNRELATED_SECRET: "must-not-enter",
          HTTPS_PROXY: "https://proxy-user:proxy-password@example.test",
          PAPERCLIP_NATIVE_MCP_URL:
            "https://mcp.example.test/connect?ticket=secret",
          PAPERCLIP_NATIVE_MCP_TOKEN: "native-secret",
          PAPERCLIP_GITHUB_BROKER_TOKEN: "github-secret",
          PAPERCLIP_PI_TOOL_BRIDGE_TOKEN: "untrusted-bridge-secret",
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
      expect(sandbox.launchEnvironment.PAPERCLIP_GITHUB_BROKER_TOKEN).toBe("github-secret");
      expect(sandbox.persistedEnvironment.PAPERCLIP_GITHUB_BROKER_TOKEN).toBeUndefined();
      expect(sandbox.launchEnvironment.PAPERCLIP_PI_TOOL_BRIDGE_TOKEN).toBeUndefined();
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
      if (agent === "pi") {
        const extensionPath = join(sandbox.agentHomeDirectory, "extensions", "paperclip-runner-tools.js");
        const extension = await readFile(extensionPath, "utf8");
        expect(extension).toContain("pi.registerTool");
        expect(extension).not.toContain("github-secret");
        expect(extension).not.toContain("untrusted-bridge-secret");
        if (process.platform !== "win32") {
          expect((await stat(extensionPath)).mode & 0o777).toBe(0o600);
        }
        await expect(
          readFile(join(sandbox.agentHomeDirectory, "settings.json"), "utf8"),
        ).resolves.toContain('"defaultProjectTrust":"never"');
      }
    },
  );

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

async function sandboxFixture(agent: "pi" | "claude" | "codex") {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-sandbox-"));
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const runtimeDirectory = join(root, "runtime");
  await Promise.all([mkdir(workspace), mkdir(runtimeDirectory)]);
  const models = {
    pi: "openrouter/deepseek/deepseek-v4-flash-0731",
    claude: "claude-sonnet-5",
    codex: "gpt-5.6-sol",
  } as const;
  const binding = await createAcpxRecoveryBinding({
    runtimeDirectory,
    normalizedSessionId: `sandbox-${agent}`,
    workingDirectory: workspace,
    profile: resolveQualifiedAcpxProfile(agent, models[agent]),
    requestedModel: models[agent],
    permissionMode: "approve-reads",
  });
  return { root, binding };
}
