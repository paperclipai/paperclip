import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runAdapterExecutionTargetProcess: vi.fn(),
    startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({
      env: {},
      stop: async () => {},
    })),
  };
});

vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    prepareWorkspaceForSshExecution: vi.fn(async () => ({ gitBacked: false })),
    restoreWorkspaceFromSshExecution: vi.fn(async () => undefined),
    runSshCommand: vi.fn(async () => ({ stdout: "/home/agent", stderr: "", exitCode: 0 })),
    syncDirectoryToSsh: vi.fn(async () => undefined),
  };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "You are agent agent-1");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("delivers assignment context on an ordinary task turn and rebuilds it after resume fallback", async () => {
    const commandPath = path.join(configHome, "fake-opencode-context");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prompts: string[] = [];
    runProcessMock
      .mockReset()
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "error", error: "unknown session" }) }))
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "fresh", part: { text: "done" } }) }));
    await execute({
      runId: "run-context-fallback",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: createPromptContextFixture(),
      onLog: async () => {},
      onMeta: async (meta) => { prompts.push(String(meta.prompt ?? "")); },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Compact assignment");
    expect(prompts[1]).toContain("## Owned assignment");
    for (const prompt of prompts) expect(prompt).not.toContain("Execution contract:");
    expect(prompts[1]).toContain("You are agent agent-1 (OpenCode).");
    expect(prompts[1]).toContain("Connection tools:");
  });

  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "paperclip");
      expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("passes an OpenRouter key and complete model to OpenCode without logging the key", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-openrouter",
        part: { text: "done" },
      }),
    }));
    const logs: string[] = [];
    const metadata: unknown[] = [];

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.model).toBe(model);
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { line: "v1", banner: "1.18.32", inV1Home: true, inV2Home: false },
    { line: "v2", banner: "opencode v2.0.18", inV1Home: false, inV2Home: true },
    { line: "unknown", banner: null, inV1Home: true, inV2Home: true },
  ])(
    "routes skill injection to the homes for the detected OpenCode line (line=$line)",
    async ({ line, banner, inV1Home, inV2Home }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-line-home-"));
      const home = path.join(root, "agent-home");
      const workspace = path.join(root, "workspace");
      const commandPath = path.join(root, "opencode");
      const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
      await fs.mkdir(workspace, { recursive: true });
      const script = banner
        ? `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "${banner}"\n  exit 0\nfi\nexit 0\n`
        : "#!/bin/sh\nexit 0\n";
      await fs.writeFile(commandPath, script, "utf8");
      await fs.chmod(commandPath, 0o755);

      const isSkillLink = async (target: string) =>
        (await fs.lstat(target).catch(() => null))?.isSymbolicLink() ?? false;
      // Inspect the skills homes AT RUN TIME: the v2 home follows the run's
      // effective XDG_CONFIG_HOME (the isolated runtime config home when
      // active), which is cleaned up when the run ends.
      const runTimeSkills: { xdgConfigHome: string | null; v1Link: boolean; v2Link: boolean } = {
        xdgConfigHome: null,
        v1Link: false,
        v2Link: false,
      };

      runProcessMock.mockReset();
      runProcessMock.mockImplementation(async (_runId, _target, _cmd, _args, options) => {
        const runEnv = (options as { env: Record<string, string> }).env;
        const effectiveXdgConfigHome = runEnv.XDG_CONFIG_HOME ?? path.join(home, ".config");
        runTimeSkills.xdgConfigHome = runEnv.XDG_CONFIG_HOME ?? null;
        runTimeSkills.v1Link = await isSkillLink(path.join(home, ".claude", "skills", "paperclip"));
        runTimeSkills.v2Link = await isSkillLink(
          path.join(effectiveXdgConfigHome, "opencode", "skills", "paperclip"),
        );
        return probeResult({
          stdout: JSON.stringify({
            type: "text",
            sessionID: `session-line-${line}`,
            part: { text: "done" },
          }),
        });
      });
      const logs: string[] = [];

      try {
        const result = await execute({
          runId: `run-line-${line}`,
          agent: {
            id: "agent-1",
            companyId: "company-1",
            name: "OpenCode Coder",
            adapterType: "opencode_local",
            adapterConfig: {},
          },
          runtime: {
            sessionId: null,
            sessionParams: null,
            sessionDisplayId: null,
            taskKey: null,
          },
          config: {
            command: commandPath,
            cwd: workspace,
            model: "openai/gpt-5",
            env: {
              HOME: home,
              OPENCODE_ALLOW_ALL_MODELS: "1",
            },
            paperclipRuntimeSkills: [{
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source: skillSource,
            }],
            promptTemplate: "Run the task.",
          },
          context: {},
          onLog: async (_stream, chunk) => {
            logs.push(chunk);
          },
        });

        expect(result.exitCode).toBe(0);
        // The detected line decides the skill home: v1 → the HOME-based
        // ~/.claude/skills, v2 → the EFFECTIVE config home the run sees (its own
        // XDG_CONFIG_HOME, i.e. the isolated runtime config home when active),
        // undetectable → both (legacy-safe).
        expect(runTimeSkills.v1Link).toBe(inV1Home);
        expect(runTimeSkills.v2Link).toBe(inV2Home);
        const logText = logs.join("");
        const effectiveXdgConfigHome = runTimeSkills.xdgConfigHome ?? path.join(home, ".config");
        if (inV2Home) {
          // The injected v2 path must match the run's actual XDG_CONFIG_HOME.
          expect(runTimeSkills.xdgConfigHome).toBeTruthy();
          expect(logText).toContain(
            `Injected OpenCode skill "paperclipai/paperclip/paperclip" into ${path.join(effectiveXdgConfigHome, "opencode", "skills")}`,
          );
        } else {
          // A v1 run never touches a v2 home.
          await expect(
            fs.lstat(path.join(home, ".config", "opencode", "skills", "paperclip")),
          ).rejects.toThrow();
        }
        if (banner) {
          expect(logText).toContain(`Detected OpenCode ${banner} (line: ${line}).`);
        } else {
          expect(logText).toContain("version probe returned no version");
        }
        // Local runs leave OPENCODE_DB untouched so v2 state resolves to the
        // operator's persistent database (isolation is opt-in via
        // adapterConfig.opencodeDataDir or the managed remote homes).
        const runCall = runProcessMock.mock.calls.at(-1)!;
        expect((runCall[4] as { env: Record<string, string> }).env.OPENCODE_DB).toBeUndefined();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});

describe("remote execution target OpenCode state database", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    runProcessMock.mockReset();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it.each([false, true])(
    "never points OPENCODE_DB at a host temp path for remote targets (managed=%s)",
    async (managed) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-remote-db-"));
      cleanupDirs.push(root);
      const workspaceDir = path.join(root, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      runProcessMock.mockReset();
      runProcessMock.mockResolvedValue(probeResult({
        stdout: JSON.stringify({
          type: "text",
          sessionID: "session-remote-db",
          part: { text: "done" },
        }),
      }));

      const runId = managed ? "run-remote-db-managed" : "run-remote-db";
      const managedRemoteWorkspace = `/remote/workspace/.paperclip-runtime/runs/${runId}/workspace`;

      const result = await execute({
        runId,
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Builder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "opencode",
          model: "openai/gpt-5",
          env: {
            XDG_CONFIG_HOME: path.join(root, "config"),
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          ...(managed ? {
            managedAiConnection: { provider: "openrouter", method: "api_key" },
          } : {}),
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

      expect(result.exitCode).toBe(0);
      const runCall = runProcessMock.mock.calls.at(-1)!;
      const runEnv = (runCall[4] as { env: Record<string, string> }).env;
      if (managed) {
        // Managed remote runs re-pin OPENCODE_DB inside the remote managed home.
        const runtimeRootDir = `${managedRemoteWorkspace}/.paperclip-runtime/opencode`;
        expect(runEnv.OPENCODE_DB).toBe(
          `${runtimeRootDir}/managed-auth/${runId}/data/opencode/opencode.db`,
        );
      } else {
        // Unmanaged remote runs omit it entirely rather than inheriting a
        // host temp path the target cannot see.
        expect(runEnv.OPENCODE_DB).toBeUndefined();
      }
      // The pre-fix value pointed into the host's isolated config temp dir.
      expect(runEnv.OPENCODE_DB ?? "").not.toContain("paperclip-opencode-config-");
    },
  );
});
