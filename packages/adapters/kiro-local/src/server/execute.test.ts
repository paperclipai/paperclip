import { describe, expect, it, vi, beforeEach } from "vitest";
import { execute } from "./execute.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// Mock the server-utils module
vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual("@paperclipai/adapter-utils/server-utils");
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn(() => Promise.resolve()),
    ensureCommandResolvable: vi.fn(() => Promise.resolve()),
    ensurePathInEnv: vi.fn((env) => env),
    renderTemplate: vi.fn((template: string) => template),
    joinPromptSections: vi.fn((sections: string[]) => sections.filter(Boolean).join("\n\n")),
    buildPaperclipEnv: vi.fn(() => ({ PAPERCLIP_AGENT_ID: "test-agent" })),
    redactEnvForLogs: vi.fn((env) => env),
    runChildProcess: vi.fn(),
  };
});

// Mock the parse module
vi.mock("./parse.js", () => ({
  parseKiroOutput: vi.fn((stdout: string, stderr: string) => ({
    summary: stdout.trim(),
    costUsd: stderr.includes("Credits") ? 0.04 : null,
    timeSeconds: stderr.includes("Time") ? 1 : null,
  })),
  isKiroUnknownSessionError: vi.fn((stdout: string, stderr: string) =>
    stdout.toLowerCase().includes("unknown session") || stderr.toLowerCase().includes("unknown session"),
  ),
}));

import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { parseKiroOutput, isKiroUnknownSessionError } from "./parse.js";

describe("execute", () => {
  const mockContext: AdapterExecutionContext = {
    runId: "test-run-123",
    agent: { id: "agent-1", companyId: "company-1", name: "Test Agent" },
    runtime: { sessionId: null, sessionParams: null },
    config: {
      command: "kiro-cli",
      model: "auto",
      cwd: "/tmp/test",
    },
    context: {},
    onLog: vi.fn(),
    onMeta: vi.fn(),
    onSpawn: vi.fn(),
    authToken: "test-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes headless kiro-cli with expected arguments", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Response from kiro-cli",
      stderr: "",
    });

    const result = await execute(mockContext);

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toBeNull();
    expect(result.summary).toBe("Response from kiro-cli");
  });

  it("extracts cost and time from stderr", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Response",
      stderr: "Credits: 0.04 • Time: 5s",
    });

    const result = await execute(mockContext);

    expect(result.costUsd).toBe(0.04);
  });

  it("handles timeout correctly", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
    });

    const result = await execute(mockContext);

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("Timed out");
  });

  it("returns error message for non-zero exit code", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Authentication failed",
    });

    const result = await execute(mockContext);

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).toBe("Authentication failed");
  });

  it("returns no error for exit code 0", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Success",
      stderr: "",
    });

    const result = await execute(mockContext);

    expect(result.errorMessage).toBeNull();
  });

  describe("session resume", () => {
    it("passes --resume flag when session can be resumed", async () => {
      vi.mocked(runChildProcess).mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "Resumed session response",
        stderr: "",
      });

      const contextWithSession: AdapterExecutionContext = {
        ...mockContext,
        runtime: {
          sessionId: "session-abc",
          sessionParams: null,
        },
      };

      await execute(contextWithSession);

      const callArgs = vi.mocked(runChildProcess).mock.calls[0];
      const args = callArgs[2] as string[];
      expect(args).toContain("--resume");
      expect(callArgs[3]).toMatchObject({
        timeoutSec: 0,
        graceSec: 15,
      });
    });

    it("does not pass --resume when session cwd differs", async () => {
      vi.mocked(runChildProcess).mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "New session response",
        stderr: "",
      });

      const contextWithMismatchedSession: AdapterExecutionContext = {
        ...mockContext,
        runtime: {
          sessionId: "session-xyz",
          sessionParams: {
            sessionId: "session-xyz",
            cwd: "/other/directory",
          },
        },
      };

      await execute(contextWithMismatchedSession);

      expect(mockContext.onLog).toHaveBeenCalledWith(
        "stdout",
        expect.stringContaining("will not be resumed"),
      );
    });

    it("retries without --resume on unknown session error", async () => {
      vi.mocked(runChildProcess)
        .mockResolvedValueOnce({
          exitCode: 1,
          signal: null,
          timedOut: false,
          stdout: "Error: unknown session",
          stderr: "",
        })
        .mockResolvedValueOnce({
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "New session response",
          stderr: "",
        });

      vi.mocked(isKiroUnknownSessionError).mockReturnValue(true);

      const contextWithSession: AdapterExecutionContext = {
        ...mockContext,
        runtime: {
          sessionId: "session-lost",
          sessionParams: null,
        },
      };

      const result = await execute(contextWithSession);

      expect(runChildProcess).toHaveBeenCalledTimes(2);
      expect(mockContext.onLog).toHaveBeenCalledWith(
        "stdout",
        expect.stringContaining("retrying with a fresh session"),
      );
      expect(result.exitCode).toBe(0);
    });

    it("does not retry on non-session errors", async () => {
      vi.mocked(runChildProcess).mockResolvedValue({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "Network error",
        stderr: "",
      });

      vi.mocked(isKiroUnknownSessionError).mockReturnValue(false);

      const contextWithSession: AdapterExecutionContext = {
        ...mockContext,
        runtime: {
          sessionId: "session-abc",
          sessionParams: null,
        },
      };

      const result = await execute(contextWithSession);

      expect(runChildProcess).toHaveBeenCalledTimes(1);
      expect(result.exitCode).toBe(1);
    });
  });

  it("uses custom model from config", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Response",
      stderr: "",
    });

    const contextWithModel: AdapterExecutionContext = {
      ...mockContext,
      config: {
        ...mockContext.config,
        model: "claude-sonnet-4.5",
      },
    };

    await execute(contextWithModel);

    expect(runChildProcess).toHaveBeenCalled();
  });

  it("includes extra args when provided", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Response",
      stderr: "",
    });

    const contextWithArgs: AdapterExecutionContext = {
      ...mockContext,
      config: {
        ...mockContext.config,
        extraArgs: ["--custom-flag", "value"],
      },
    };

    await execute(contextWithArgs);

    expect(runChildProcess).toHaveBeenCalled();
  });

  it("sets provider and biller to kiro", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Response",
      stderr: "",
    });

    const result = await execute(mockContext);

    expect(result.provider).toBe("kiro");
    expect(result.biller).toBe("kiro");
    expect(result.billingType).toBe("credits");
  });

  it("includes resultJson with stdout and stderr", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Output line",
      stderr: "Credits: 0.04 • Time: 1s",
    });

    const result = await execute(mockContext);

    expect(result.resultJson).toEqual({
      stdout: "Output line",
      stderr: "Credits: 0.04 • Time: 1s",
    });
  });

  it("preserves session info in result", async () => {
    vi.mocked(runChildProcess).mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Response",
      stderr: "",
    });

    const contextWithSession: AdapterExecutionContext = {
      ...mockContext,
      runtime: {
        sessionId: "test-session",
        sessionParams: null,
      },
    };

    const result = await execute(contextWithSession);

    expect(result.sessionId).toBe("test-session");
    expect(result.sessionDisplayId).toBe("test-session");
    expect(result.sessionParams).toEqual({
      sessionId: "test-session",
      cwd: "/tmp/test",
    });
  });
});
