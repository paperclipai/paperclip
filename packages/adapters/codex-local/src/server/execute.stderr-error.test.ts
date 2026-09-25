import { beforeEach, describe, expect, it, vi } from "vitest";

const YOLO_WARNING = "YOLO mode is enabled. All tool calls will be automatically approved.";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
  tempCodexHome: "/tmp/paperclip-codex-stderr-error-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) =>
    `[paperclip] Codex ACP default unavailable; falling back to Codex CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    readPaperclipRuntimeSkillEntries,
  };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return {
    ...actual,
    prepareCodexRuntimeConfig,
  };
});

import { execute, firstMeaningfulStderrLine } from "./execute.js";

function mockFailedProcess(stderr: string) {
  runAdapterExecutionTargetProcess.mockImplementation(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr,
    pid: 123,
    startedAt: new Date().toISOString(),
  }));
}

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Codex Coder",
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
      outputInactivityTimeoutMs: null,
      env: { OPENAI_API_KEY: "test-key" },
      ...config,
    },
    context: {},
    onLog: vi.fn(async (_stream: "stdout" | "stderr", _chunk: string) => {}),
  };
}

describe("codex_local stderr fallback error derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the benign YOLO approvals warning and surfaces the real stderr error", async () => {
    mockFailedProcess(
      [
        YOLO_WARNING,
        "Error: unexpected status 400 Bad Request: {\"error\":{\"message\":\"The requested model 'gpt-5.3-codex-spark' does not exist.\",\"code\":\"model_not_found\"}}",
      ].join("\n"),
    );

    const result = await execute(buildContext() as never);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toContain("model_not_found");
    expect(result.errorMessage).not.toContain("YOLO mode");
  });

  it("skips adapter-injected [paperclip] diagnostic lines when picking the fallback error", async () => {
    mockFailedProcess(
      [
        "[paperclip] Codex ACP default unavailable; falling back to Codex CLI. Set engine=acp to require ACP or engine=cli to silence this fallback.",
        YOLO_WARNING,
        "Error: stream disconnected before completion",
      ].join("\n"),
    );

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("Error: stream disconnected before completion");
  });

  it("falls back to the first non-empty stderr line when every line is benign", async () => {
    mockFailedProcess(`${YOLO_WARNING}\n`);

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe(YOLO_WARNING);
  });

  it("falls back to the exit-code message when stderr is empty", async () => {
    mockFailedProcess("\n  \n");

    const result = await execute(buildContext() as never);

    expect(result.errorMessage).toBe("Codex exited with code 1");
  });
});

describe("firstMeaningfulStderrLine", () => {
  it("returns the first line that is not a known benign warning", () => {
    expect(firstMeaningfulStderrLine(`${YOLO_WARNING}\nError: boom`)).toBe("Error: boom");
    expect(firstMeaningfulStderrLine("[paperclip] Confining Codex with workspace scope.\nError: boom")).toBe(
      "Error: boom",
    );
  });

  it("keeps the first non-empty line when all lines are benign", () => {
    expect(firstMeaningfulStderrLine(`${YOLO_WARNING}\n[paperclip] note\n`)).toBe(YOLO_WARNING);
  });

  it("returns an empty string for blank input", () => {
    expect(firstMeaningfulStderrLine("")).toBe("");
    expect(firstMeaningfulStderrLine(" \n\t\n")).toBe("");
  });
});

describe("pre-provider launcher capacity contract", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockLauncher(change: (proc: Record<string, unknown>, nonce: string) => void = () => {}) {
    runAdapterExecutionTargetProcess.mockImplementation(async (...args: unknown[]) => {
      const options = args[4] as { env: Record<string, string>; onLog: (stream: string, text: string) => Promise<void> };
      const nonce = options.env.PAPERCLIP_LAUNCHER_NONCE;
      const proc = { exitCode: 5, signal: null, timedOut: false, stdout: "",
        stderr: `launcher: no free slot\npaperclip-launcher:v1:capacity_unavailable:${nonce}\n`,
        pid: 123, startedAt: new Date().toISOString() };
      change(proc, nonce);
      await options.onLog("stdout", proc.stdout);
      await options.onLog("stderr", proc.stderr);
      return proc;
    });
  }

  it("accepts only this attempt's capacity refusal, preserving setup logs and session identity", async () => {
    prepareCodexRuntimeConfig.mockResolvedValueOnce({ cleanup: vi.fn(async () => {}),
      notes: ["Managed MCP setup complete."] } as never);
    mockLauncher();
    const context = buildContext({ launcherCapacityRecovery: true });
    context.runtime = { sessionId: "prior-session", sessionParams: null, sessionDisplayId: "prior-session", taskKey: null } as never;
    const result = await execute(context as never);
    expect(result).toMatchObject({ errorCode: "launcher_capacity_unavailable", errorFamily: null,
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false,
        launcher: { version: 1, outcome: "capacity_unavailable" } },
      sessionId: "prior-session", resultJson: { stdout: "" } });
    expect(context.onLog.mock.calls.some((call) => String(call[1]).includes("Managed MCP setup complete."))).toBe(true);
    expect(result.resultJson?.stderr).toContain("launcher: no free slot");
    expect(runAdapterExecutionTargetProcess.mock.calls[0]?.[4].env.PAPERCLIP_LAUNCHER_NONCE).toMatch(/^[a-f0-9]{32}$/);
  });

  it.each([
    ["unmarked exit 5", (proc: Record<string, unknown>) => { proc.stderr = "launcher: no free slot"; }],
    ["unknown version", (proc: Record<string, unknown>) => { proc.stderr = String(proc.stderr).replace(":v1:", ":v2:"); }],
    ["unknown outcome", (proc: Record<string, unknown>) => { proc.stderr = String(proc.stderr).replace("capacity_unavailable", "quota_unknown"); }],
    ["stale nonce", (proc: Record<string, unknown>) => { proc.stderr = String(proc.stderr).replace(/:[^:\n]+\n$/, `:${"f".repeat(32)}\n`); }],
    ["duplicate", (proc: Record<string, unknown>) => { proc.stderr = String(proc.stderr).repeat(2); }],
    ["malformed sibling", (proc: Record<string, unknown>) => { proc.stderr += "paperclip-launcher:broken\n"; }],
    ["trailing data", (proc: Record<string, unknown>) => { proc.stderr = String(proc.stderr).trimEnd() + " unexpected\n"; }],
    ["provider text", (proc: Record<string, unknown>) => { proc.stdout = "work started"; }],
    ["whitespace output", (proc: Record<string, unknown>) => { proc.stdout = "\n"; }],
    ["protocol event", (proc: Record<string, unknown>) => { proc.stdout = '{"type":"thread.started","thread_id":"provider-session"}\n'; }],
    ["usage event", (proc: Record<string, unknown>) => { proc.stdout = '{"type":"turn.completed","usage":{"input_tokens":4}}\n'; }],
    ["stderr protocol", (proc: Record<string, unknown>) => { proc.stderr += '{"type":"thread.started","thread_id":"provider-session"}\n'; }],
    ["success", (proc: Record<string, unknown>) => { proc.exitCode = 0; }],
    ["other exit", (proc: Record<string, unknown>) => { proc.exitCode = 1; }],
    ["signal", (proc: Record<string, unknown>) => { proc.signal = "SIGTERM"; }],
    ["timeout", (proc: Record<string, unknown>) => { proc.timedOut = true; }],
    ["transport", (proc: Record<string, unknown>) => { proc.errorCode = "duplex_channel_lost"; }],
    ["cancellation", (proc: Record<string, unknown>) => { proc.errorCode = "cancelled"; }],
    ["auth conflict", (proc: Record<string, unknown>) => { proc.stderr += "refresh_token_expired\n"; }],
    ["quota conflict", (proc: Record<string, unknown>) => { proc.stderr += "You've hit your usage limit\n"; }],
    ["upstream conflict", (proc: Record<string, unknown>) => { proc.stderr += "We're currently experiencing high demand\n"; }],
  ])("rejects %s as launcher recovery", async (_name, change) => {
    mockLauncher(change as (proc: Record<string, unknown>) => void);
    const result = await execute(buildContext({ launcherCapacityRecovery: true }) as never);
    expect(result.executionRecovery).toBeUndefined();
    expect(result.errorCode).not.toBe("launcher_capacity_unavailable");
    if (_name === "transport") expect(result.errorCode).toBe("duplex_channel_lost");
    if (_name === "timeout") expect(result.timedOut).toBe(true);
    if (_name === "signal") expect(result.signal).toBe("SIGTERM");
    if (_name === "cancellation") expect(result.errorCode).toBe("cancelled");
  });

  it("requires explicit opt-in and ignores a configured nonce", async () => {
    mockLauncher((_proc, nonce) => expect(nonce).toBeUndefined());
    const result = await execute(buildContext({ env: {
      OPENAI_API_KEY: "test-key", PAPERCLIP_LAUNCHER_NONCE: "a".repeat(32),
    } }) as never);
    expect(result.executionRecovery).toBeUndefined();
    expect(result.errorCode).not.toBe("launcher_capacity_unavailable");
  });

  it("does not erase an earlier provider attempt when an unknown-session fallback finds capacity unavailable", async () => {
    mockLauncher();
    runAdapterExecutionTargetProcess.mockResolvedValueOnce({ exitCode: 1, signal: null, timedOut: false,
      stdout: '{"type":"error","message":"unknown session"}\n', stderr: "", pid: 123,
      startedAt: new Date().toISOString() });
    const context = buildContext({ launcherCapacityRecovery: true });
    context.runtime = { sessionId: "prior-session", sessionParams: null, sessionDisplayId: "prior-session", taskKey: null } as never;
    const result = await execute(context as never);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(2);
    expect(result.executionRecovery).toBeUndefined();
    expect(result.errorCode).not.toBe("launcher_capacity_unavailable");
  });
});
