import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { createSecretEnvRedactionScanner, redactKnownSecretEnvValues } from "@paperclipai/adapter-utils/secret-env-redaction";
import type { AdapterUsageCheckpoint } from "@paperclipai/adapter-utils";

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

describe("OpenCode cost accounting when redaction hides a display record", () => {
  const marker = "***REDACTED***";
  const step = (input: number | string, cost: number | string = 0.0025) => JSON.stringify({
    type: "step_finish", sessionID: "cost-session",
    part: { reason: "done", cost, tokens: { input, output: 7, reasoning: 0, cache: { read: 0, write: 0 } } },
  });
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-cost-"));
    vi.stubEnv("XDG_CONFIG_HOME", home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  // Display text is what the redacted log carries (a counter matching a known
  // secret becomes the bare marker, so that JSON line no longer parses);
  // control text is the sanitized copy, where the same counter becomes 0.
  async function run(display: string[], control: string[], onUsage?: (receipt: AdapterUsageCheckpoint) => Promise<void>) {
    const commandPath = path.join(home, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockImplementation((async (_runId: string, _target: unknown, _command: string, _args: string[], opts: { onLog: (stream: "stdout" | "stderr", text: string) => Promise<void> }) => {
      const stdout = display.join("\n") + "\n";
      await opts.onLog("stdout", stdout);
      return probeResult({ stdout, controlOutput: { stdout: control.join("\n") + "\n", stderr: "" } });
    }) as never);
    return execute({
      runId: "cost-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: home, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: createPromptContextFixture(),
      onLog: async () => {},
      onUsage,
    });
  }

  const unpricedStep = (input: number | string) => JSON.stringify({
    type: "step_finish", part: { tokens: { input, output: 7 } },
  });

  it("does not equate parsed counts when redaction hides a different step", async () => {
    const damaged = unpricedStep(marker).replace(`"${marker}"`, marker);
    const onUsage = vi.fn(async (_receipt: AdapterUsageCheckpoint) => {});
    const result = await run([unpricedStep(-1), unpricedStep(5), damaged], [unpricedStep(5), unpricedStep(0)], onUsage);
    expect(result.usageComplete).toBe(false);
    expect(result.costStatus).toBe("unpriced");
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false, costStatus: "unpriced" }));
  });

  it.each([false, true])("preserves invalid full-stream usage when control is capped (%s)", async capped => {
    const records = [unpricedStep(-1), unpricedStep(5)];
    const onUsage = vi.fn(async (_receipt: AdapterUsageCheckpoint) => {});
    const result = await run(records, capped ? records.slice(1) : records, onUsage);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 7, cachedInputTokens: 0 });
    expect(result.usageComplete).toBe(false);
    expect(result.costStatus).toBe("unpriced");
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ complete: false, costStatus: "unpriced" }));
  });

  it("keeps complete full-stream usage when control holds only a valid suffix", async () => {
    const result = await run([step(4), step(5)], [step(5)]);
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 14, cachedInputTokens: 0 });
    expect(result.usageComplete).toBe(true);
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });

  it("keeps the control total when a redacted step is missing from the display stream", async () => {
    // Step 1's input matched a secret: unparseable in display, input 0 in control.
    const result = await run([step(marker).replace(`"${marker}"`, marker), step(5)], [step(0), step(5)]);
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });

  it("reports unknown instead of a partial sum when control also lost a record", async () => {
    // Control capture kept only the later step, so no view holds both records.
    const result = await run([step(marker).replace(`"${marker}"`, marker), step(5), step(6)], [step(6)]);
    expect(result.costUsd).toBeNull();
  });

  async function runRedacted(records: string[], onUsage?: (receipt: AdapterUsageCheckpoint) => Promise<void>) {
    const raw = records.join("\n");
    const control = createSecretEnvRedactionScanner(["123456"], 1024 * 1024);
    control.append(raw);
    return run([redactKnownSecretEnvValues(raw, ["123456"])], [control.snapshot()], onUsage);
  }

  it.each([false, true])("reports a redacted price as unknown (later priced step=%s)", async later => {
    const result = await runRedacted([step(4, 0.123456), ...(later ? [step(5)] : [])]);
    expect(result.costUsd).toBeNull();
  });

  it("preserves genuine zero cost", async () => {
    expect((await runRedacted([step(4, 0)])).costUsd).toBe(0);
  });

  it("ignores damaged content events with accounting words", async () => {
    const text = JSON.stringify({ type: "text", part: { text: 'Discuss "cost" and tokens', cost: 123456 } });
    expect((await runRedacted([text, step(4), step(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it("counts a damaged partial numeric token once", async () => {
    expect((await runRedacted([step(912345678), step(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it.each([0.123456123456, 0.1234567123456])("keeps repeatedly redacted prices unknown (%s)", async price => {
    expect((await runRedacted([step(4, price), step(5)])).costUsd).toBeNull();
  });

  it("recovers priced records whose counters contain repeated matches", async () => {
    expect((await runRedacted([step(123456123456), step(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it.each(["text", "tool_use", "error", "usage"])("ignores %s envelopes with top-level usage", async type => {
    const content = JSON.stringify({ type, part: { text: "ok" }, usage: { input: 123456 } });
    expect((await runRedacted([content, step(4), step(5)])).costUsd).toBeCloseTo(0.005, 6);
  });

  it("never publishes a complete priced subtotal after a lost display record", async () => {
    const onUsage = vi.fn(async (_receipt: AdapterUsageCheckpoint) => {});
    const result = await runRedacted([step(4, 0.123456), step(5)], onUsage);
    expect(result.costUsd).toBeNull();
    expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ costUsd: null, costStatus: "unpriced", complete: true }));
  });

  it("leaves a fully readable stream on the checkpoint total", async () => {
    const result = await run([step(4), step(5)], [step(4), step(5)]);
    expect(result.costUsd).toBeCloseTo(0.005, 6);
  });
});
