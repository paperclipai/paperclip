import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

// The real probe spawns `opencode --version`; unit tests below control the
// reported version instead of launching a fake CLI.
vi.mock("./version.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, probeOpenCodeCliVersion: vi.fn(async () => null) };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { probeOpenCodeCliVersion } from "./version.js";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);
const versionProbeMock = vi.mocked(probeOpenCodeCliVersion);

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

describe("OpenCode version guard", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-version-"));
    versionProbeMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function callExecute(
    extraEnv: Record<string, string> = {},
    extraConfig: Record<string, unknown> = {},
    runImpl?: (...args: unknown[]) => unknown,
  ) {
    const commandPath = path.join(root, "opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    if (runImpl) {
      runProcessMock.mockImplementation(runImpl as never);
    } else {
      runProcessMock.mockResolvedValue(probeResult({
        stdout: JSON.stringify({ type: "text", sessionID: "version-guard", part: { text: "ok" } }),
      }));
    }
    return execute({
      runId: "run-version-guard",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath,
        cwd: root,
        model: "openai/gpt-5",
        env: { OPENCODE_ALLOW_ALL_MODELS: "1", ...extraEnv },
        ...extraConfig,
      },
      context: {},
      onLog: async () => {},
    });
  }

  function lastExecutionArgs(): string[] {
    return (runProcessMock.mock.calls.at(-1)?.[3] ?? []) as string[];
  }

  it("fails fast with an actionable message when OpenCode's major version is unsupported", async () => {
    versionProbeMock.mockResolvedValue({ version: "3.0.1", major: 3, minor: 0, patch: 1, supported: false });
    await expect(callExecute()).rejects.toThrow(/OpenCode 3\.0\.1 is not supported/);
  });

  it.each(["1.18.34", "2.0.26"])("runs normally on a qualified major (%s)", async (version) => {
    const [major, minor, patch] = version.split(".").map(Number);
    versionProbeMock.mockResolvedValue({ version, major, minor, patch, supported: true });
    const result = await callExecute();
    expect(result.exitCode).toBe(0);
  });

  it("keeps the separate --variant flag on OpenCode V1", async () => {
    versionProbeMock.mockResolvedValue({ version: "1.18.34", major: 1, minor: 18, patch: 34, supported: true });
    await callExecute({}, { model: "paperclip/deepseek-flash", variant: "high" });
    const args = lastExecutionArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("paperclip/deepseek-flash");
    expect(args[args.indexOf("--variant") + 1]).toBe("high");
  });

  it("folds the variant into the model and omits --variant on OpenCode V2", async () => {
    versionProbeMock.mockResolvedValue({ version: "2.0.26", major: 2, minor: 0, patch: 26, supported: true });
    await callExecute({}, { model: "paperclip/deepseek-flash", variant: "high" });
    const args = lastExecutionArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("paperclip/deepseek-flash#high");
    expect(args).not.toContain("--variant");
  });

  it.each(["1.18.34", "2.0.26"])("auto-approves permissions on the run by default (%s)", async (version) => {
    const [major, minor, patch] = version.split(".").map(Number);
    versionProbeMock.mockResolvedValue({ version, major, minor, patch, supported: true });
    await callExecute();
    expect(lastExecutionArgs()).toContain("--auto");
  });

  it("omits --auto when headless skip-permissions is disabled", async () => {
    versionProbeMock.mockResolvedValue({ version: "1.18.34", major: 1, minor: 18, patch: 34, supported: true });
    await callExecute({}, { dangerouslySkipPermissions: false });
    expect(lastExecutionArgs()).not.toContain("--auto");
  });

  it("surfaces a tool error when OpenCode exits non-zero with capped output", async () => {
    versionProbeMock.mockResolvedValue({ version: "1.18.34", major: 1, minor: 18, patch: 34, supported: true });
    const result = await callExecute({}, {}, async (...callArgs: unknown[]) => {
      const options = callArgs[4] as
        | { onLog?: (stream: string, chunk: string) => Promise<void> }
        | undefined;
      await options?.onLog?.(
        "stdout",
        `${JSON.stringify({
          type: "tool_use",
          sessionID: "ses_x",
          part: { state: { status: "error", error: "boom: command failed" } },
        })}\n`,
      );
      return probeResult({ exitCode: 1, stdout: "", stderr: "" });
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("boom: command failed");
  });

  it("treats a non-zero exit after a final answer as complete", async () => {
    versionProbeMock.mockResolvedValue({ version: "2.0.24", major: 2, minor: 0, patch: 24, supported: true });
    const result = await callExecute({}, {}, async (...callArgs: unknown[]) => {
      const options = callArgs[4] as
        | { onLog?: (stream: string, chunk: string) => Promise<void> }
        | undefined;
      for (const record of [
        { type: "step_start", sessionID: "s" },
        { type: "step_finish", sessionID: "s", part: { reason: "tool-calls" } },
        { type: "step_start", sessionID: "s" },
        { type: "text", sessionID: "s", part: { text: "Готово." } },
      ]) {
        await options?.onLog?.("stdout", `${JSON.stringify(record)}\n`);
      }
      return probeResult({ exitCode: 1, stdout: "", stderr: "" });
    });
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
  });

  it("does not recover a non-zero exit when the transport reports an error code", async () => {
    versionProbeMock.mockResolvedValue({ version: "2.0.24", major: 2, minor: 0, patch: 24, supported: true });
    const result = await callExecute({}, {}, async (...callArgs: unknown[]) => {
      const options = callArgs[4] as
        | { onLog?: (stream: string, chunk: string) => Promise<void> }
        | undefined;
      await options?.onLog?.(
        "stdout",
        `${JSON.stringify({ type: "text", sessionID: "s", part: { text: "Готово." } })}\n`,
      );
      return probeResult({ exitCode: 1, stdout: "", stderr: "", errorCode: "duplex_channel_lost" });
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("duplex_channel_lost");
  });

  it("does not recover a non-zero exit when a tool error scrolled past the captured tail", async () => {
    versionProbeMock.mockResolvedValue({ version: "2.0.24", major: 2, minor: 0, patch: 24, supported: true });
    const result = await callExecute({}, {}, async (...callArgs: unknown[]) => {
      const options = callArgs[4] as
        | { onLog?: (stream: string, chunk: string) => Promise<void> }
        | undefined;
      await options?.onLog?.(
        "stdout",
        `${JSON.stringify({
          type: "tool_use",
          sessionID: "s",
          part: { state: { status: "error", error: "early tool boom" } },
        })}\n`,
      );
      // Push the tool error beyond the 256 KiB raw tail and the display cap.
      await options?.onLog?.(
        "stdout",
        `${JSON.stringify({ type: "step_start", sessionID: "s" })}\n`.repeat(20_000),
      );
      await options?.onLog?.(
        "stdout",
        `${JSON.stringify({ type: "text", sessionID: "s", part: { text: "Готово." } })}\n`,
      );
      return probeResult({ exitCode: 1, stdout: "", stderr: "" });
    });
    expect(result.exitCode).toBe(1);
  });

  it("does not recover a non-zero exit that did not end on a final answer", async () => {
    versionProbeMock.mockResolvedValue({ version: "2.0.24", major: 2, minor: 0, patch: 24, supported: true });
    const result = await callExecute({}, {}, async (...callArgs: unknown[]) => {
      const options = callArgs[4] as
        | { onLog?: (stream: string, chunk: string) => Promise<void> }
        | undefined;
      await options?.onLog?.(
        "stdout",
        `${JSON.stringify({ type: "step_start", sessionID: "s" })}\n`,
      );
      return probeResult({ exitCode: 1, stdout: "", stderr: "" });
    });
    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("OpenCode exited with code 1");
  });

  it("allows an unverified major version when the escape hatch is set", async () => {
    versionProbeMock.mockResolvedValue({ version: "3.0.1", major: 3, minor: 0, patch: 1, supported: false });
    const result = await callExecute({ PAPERCLIP_OPENCODE_ALLOW_UNSUPPORTED_VERSION: "1" });
    expect(result.exitCode).toBe(0);
  });
});
