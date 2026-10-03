import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS } from "./output-inactivity-monitor.js";
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
    expect(prompt).toContain(custom ? "Custom agent instruction." : "Continue your Paperclip conversation");
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
  });

  it("retains the session identity when the output-inactivity monitor fires", async () => {
    const commandPath = path.join(configHome, "fake-opencode-monitor");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // The mocked run outlives the inactivity window (50ms < 300ms), so the
    // monitor fires while the run is still pending and no kill target is
    // ever provided by the mock.
    runProcessMock
      .mockReset()
      .mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return probeResult({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });
      });
    const result = await execute({
      runId: "run-monitor-session",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "sess_keep", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5",
        env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        outputInactivityTimeoutMs: 50,
      },
      context: createPromptContextFixture(),
      onLog: async () => {},
    });
    expect(result.errorCode).toBe("opencode_output_inactivity_monitor");
    // The interrupted session may still be resumable — the result must keep
    // its identity instead of instructing the resolver to clear it.
    expect(result.sessionId).toBe("sess_keep");
    expect(result.sessionParams).toMatchObject({ sessionId: "sess_keep" });
    expect(result.sessionDisplayId).toBe("sess_keep");
    expect(result.clearSession).toBe(false);
  });

  it("awaits both queued monitor diagnostics before the run resolves", { timeout: 20_000 }, async () => {
    if (process.platform === "win32") return;
    const commandPath = path.join(configHome, "fake-opencode-diagnostic");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // The monitor fires (50ms) before the mocked run spawns (150ms), so the
    // fired diagnostic and the pre-spawn termination note both queue. The
    // diagnostic write is slow (250ms — the heartbeat logger persists
    // asynchronously) while every other write is fast: a cleanup that awaited
    // only the most recent write would resolve the run first and drop the
    // diagnostic explaining the termination.
    runProcessMock
      .mockReset()
      .mockImplementation(async (...args: unknown[]) => {
        const options = args[4] as
          | { onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> }
          | undefined;
        await new Promise((resolve) => setTimeout(resolve, 150));
        await options?.onSpawn?.({ pid: 999_999, processGroupId: null, startedAt: new Date().toISOString() });
        return probeResult({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });
      });
    // The mocked spawn reports an unowned pid. The local termination path
    // would otherwise issue a real process.kill against it — on a host where
    // that pid belongs to an unrelated process, this test could terminate it.
    // Intercept every kill aimed at the fake pid: signal-0 probes report the
    // deterministic "no such process" the targetless mock implies, while real
    // signals are recorded and dropped; everything else passes through to the
    // original process.kill.
    const mockedPid = 999_999;
    const mockedPidSignals: string[] = [];
    const realKill = process.kill.bind(process);
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
        if (pid !== mockedPid) return realKill(pid, signal);
        if (signal === 0 || signal === undefined) {
          const err = new Error("ESRCH") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        mockedPidSignals.push(String(signal));
        return true;
      }) as typeof process.kill);
    let diagnosticLoggedAt = 0;
    let result: Awaited<ReturnType<typeof execute>>;
    try {
      result = await execute({
        runId: "run-monitor-diagnostic",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: "sess_diag", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: commandPath, cwd: configHome, model: "openai/gpt-5",
          env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
          outputInactivityTimeoutMs: 50,
        },
        context: createPromptContextFixture(),
        onLog: async (_stream, chunk) => {
          const line = String(chunk);
          if (line.includes("adapter.invoke") && line.includes("no opencode activity")) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            diagnosticLoggedAt = Date.now();
          }
        },
      });
    } finally {
      killSpy.mockRestore();
    }
    const resolvedAt = Date.now();
    expect(result.errorCode).toBe("opencode_output_inactivity_monitor");
    // The monitor must still go through the termination path for the reported
    // pid (SIGTERM first), even though the mock never provided a live target.
    expect(mockedPidSignals).toContain("SIGTERM");
    expect(diagnosticLoggedAt).toBeGreaterThan(0);
    // The run must not finalize while either queued diagnostic write is still
    // in flight — awaiting only the latest one would orphan the earlier one.
    expect(resolvedAt).toBeGreaterThanOrEqual(diagnosticLoggedAt);
  });

  it("holds the run resolve until a surviving group tears down, honoring the full grace before SIGKILL", { timeout: 20_000 }, async () => {
    if (process.platform === "win32") return;
    // A real detached process group that ignores SIGTERM, mirroring a
    // detached tool subprocess that survived its parent's SIGTERM and closed
    // its inherited stdio.
    const child = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done'], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pgid = child.pid!;
    const groupAlive = () => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let groupWasAliveAfterSpawn = false;
    await fs.writeFile(path.join(configHome, "fake-opencode-grace"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    let terminatedAt = 0;
    const logs: string[] = [];
    runProcessMock
      .mockReset()
      .mockImplementation(async (...args: unknown[]) => {
        const options = args[4] as
          | { onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> }
          | undefined;
        await options?.onSpawn?.({ pid: pgid, processGroupId: pgid, startedAt: new Date().toISOString() });
        groupWasAliveAfterSpawn = groupAlive();
        // Stay silent past the 50ms inactivity window, then resolve while the
        // SIGTERM grace is still running — opencode exiting promptly after
        // SIGTERM is exactly the scenario the finally block must handle.
        await new Promise((resolve) => setTimeout(resolve, 200));
        return probeResult({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });
      });
    try {
      const result = await execute({
        runId: "run-monitor-grace",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: "sess_grace", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: path.join(configHome, "fake-opencode-grace"),
          cwd: configHome,
          model: "openai/gpt-5",
          env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
          outputInactivityTimeoutMs: 50,
        },
        context: createPromptContextFixture(),
        onLog: async (_stream, chunk) => {
          logs.push(String(chunk));
          if (String(chunk).includes("terminating opencode child via SIGTERM")) {
            terminatedAt = Date.now();
          }
        },
      });
      expect(groupWasAliveAfterSpawn).toBe(true);
      expect(result.errorCode).toBe("opencode_output_inactivity_monitor");
      const monitorInfo = result.resultJson?.outputInactivityMonitor as
        | { terminationSignal?: NodeJS.Signals | null }
        | undefined;
      expect(monitorInfo?.terminationSignal).toBe("SIGKILL");
      // The scheduled grace-end SIGKILL fires during the teardown wait above,
      // and the result must report the actually-delivered escalation signal —
      // not the stale SIGTERM captured when termination began.
      // The result must land only after the surviving group tore down: the
      // heartbeat executor may immediately start the next queued run for the
      // same agent once this result resolves, and that run must not race a
      // tool subprocess that is still writing to the shared workspace. The
      // group cannot be probed for absence here — an SIGKILLed orphan can
      // linger as an unreaped zombie group member on hosts whose pid 1 never
      // reaps — so the proof is that the resolve happened only after the
      // scheduled grace-end SIGKILL, with its settle window granted.
      const exit = await exited;
      expect(exit.signal).toBe("SIGKILL");
      expect(terminatedAt).toBeGreaterThan(0);
      expect(Date.now() - terminatedAt).toBeGreaterThanOrEqual(
        OPENCODE_OUTPUT_INACTIVITY_MONITOR_SIGTERM_GRACE_MS - 500,
      );
      expect(logs.some((line) => line.includes("holding the run result until teardown completes"))).toBe(true);
    } finally {
      if (groupAlive()) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await exited.catch(() => undefined);
    }
  });

  it("resolves promptly when a surviving group tears itself down before the grace ends", { timeout: 20_000 }, async () => {
    if (process.platform === "win32") return;
    // A real detached group that ignores SIGTERM but self-exits well inside
    // the 5s grace window.
    const child = spawn("sh", ["-c", 'trap "" TERM; sleep 0.4 & wait'], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const pgid = child.pid!;
    const groupAlive = () => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let groupWasAliveAfterSpawn = false;
    await fs.writeFile(path.join(configHome, "fake-opencode-selfexit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock
      .mockReset()
      .mockImplementation(async (...args: unknown[]) => {
        const options = args[4] as
          | { onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> }
          | undefined;
        await options?.onSpawn?.({ pid: pgid, processGroupId: pgid, startedAt: new Date().toISOString() });
        groupWasAliveAfterSpawn = groupAlive();
        await new Promise((resolve) => setTimeout(resolve, 200));
        return probeResult({ exitCode: null, signal: "SIGTERM", stdout: "", stderr: "" });
      });
    try {
      const startedAt = Date.now();
      const result = await execute({
        runId: "run-monitor-selfexit",
        agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
        runtime: { sessionId: "sess_selfexit", sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: {
          command: path.join(configHome, "fake-opencode-selfexit"),
          cwd: configHome,
          model: "openai/gpt-5",
          env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
          outputInactivityTimeoutMs: 50,
        },
        context: createPromptContextFixture(),
        onLog: async () => {},
      });
      expect(groupWasAliveAfterSpawn).toBe(true);
      expect(result.errorCode).toBe("opencode_output_inactivity_monitor");
      // Teardown finished on its own, so the run must resolve shortly after
      // — not hold out the remainder of the 5s grace waiting for a kill that
      // is no longer needed.
      expect(Date.now() - startedAt).toBeLessThan(4_000);
      expect(groupAlive()).toBe(false);
      const exit = await exited;
      expect(exit.signal).toBeNull();
    } finally {
      if (groupAlive()) {
        try {
          process.kill(-pgid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      await exited.catch(() => undefined);
    }
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
