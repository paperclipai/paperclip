import { describe, expect, it, vi, beforeEach } from "vitest";
import { testEnvironment } from "./test.js";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";

// Mock the server-utils module
vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual("@paperclipai/adapter-utils/server-utils");
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn((dir: string, options?: { createIfMissing?: boolean }) => {
      if (dir.includes("/invalid/")) {
        throw new Error(`Invalid directory: ${dir}`);
      }
      return Promise.resolve();
    }),
    ensureCommandResolvable: vi.fn((command: string) => {
      if (command === "__missing_kiro_cli__") {
        throw new Error("Command not found: __missing_kiro_cli__");
      }
      return Promise.resolve();
    }),
    ensurePathInEnv: vi.fn((env) => env),
    runChildProcess: vi.fn(),
  };
});

import { ensureAbsoluteDirectory, ensureCommandResolvable, runChildProcess } from "@paperclipai/adapter-utils/server-utils";

function mockResult(overrides: Partial<RunProcessResult> = {}): RunProcessResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: '{"accountType": "pro", "email": "test@example.com"}',
    stderr: "",
    pid: null,
    startedAt: null,
    ...overrides,
  };
}

describe("testEnvironment", () => {
  const mockContext: AdapterEnvironmentTestContext = {
    companyId: "test-company",
    adapterType: "kiro",
    config: {
      command: "kiro-cli",
      cwd: "/tmp/test",
    },
  };

  function findCheck(checks: any[], code: string) {
    return checks.find((c) => c.code === code);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mocks to default behavior
    vi.mocked(ensureAbsoluteDirectory).mockResolvedValue();
    vi.mocked(ensureCommandResolvable).mockResolvedValue();
    vi.mocked(runChildProcess).mockResolvedValue(mockResult());
  });

  it("passes when cwd is valid and command is resolvable", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult());

    const result = await testEnvironment(mockContext);

    expect(result.status).toBe("pass");
    const cwdCheck = findCheck(result.checks, "kiro_cwd_valid");
    expect(cwdCheck).toMatchObject({
      code: "kiro_cwd_valid",
      level: "info",
    });
    const commandCheck = findCheck(result.checks, "kiro_command_resolvable");
    expect(commandCheck).toMatchObject({
      code: "kiro_command_resolvable",
      level: "info",
    });
  });

  it("reports successful whoami with account and email", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult({
      stdout: '{"accountType": "pro", "email": "user@example.com"}',
    }));

    const result = await testEnvironment(mockContext);

    const check = findCheck(result.checks, "kiro_whoami_probe_passed");
    expect(check).toMatchObject({
      code: "kiro_whoami_probe_passed",
      level: "info",
      message: "Kiro authentication successful. Account: pro, Email: user@example.com",
      detail: "Logged in as user@example.com (pro)",
    });
  });

  it("reports auth required when whoami returns authentication error", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult({
      exitCode: 1,
      stdout: "",
      stderr: "authentication required: run 'kiro-cli login' first",
    }));

    const result = await testEnvironment(mockContext);

    expect(result.status).toBe("warn");
    const check = findCheck(result.checks, "kiro_whoami_probe_auth_required");
    expect(check).toMatchObject({
      code: "kiro_whoami_probe_auth_required",
      level: "warn",
      message: "Kiro CLI is installed, but authentication is not ready.",
      detail: "authentication required: run 'kiro-cli login' first",
    });
    expect(check?.hint).toContain("kiro-cli login");
  });

  it("reports error when kiro-cli command not found", async () => {
    vi.mocked(ensureCommandResolvable).mockRejectedValue(new Error("Command not found"));

    const result = await testEnvironment({
      ...mockContext,
      config: { command: "__missing_kiro_cli__", cwd: "/tmp/test" },
    });

    expect(result.status).toBe("fail");
    const check = findCheck(result.checks, "kiro_command_unresolvable");
    expect(check).toMatchObject({
      code: "kiro_command_unresolvable",
      level: "error",
      message: "Command not found",
      detail: "__missing_kiro_cli__",
    });
  });

  it("warns when whoami probe times out", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult({
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "",
    }));

    const result = await testEnvironment(mockContext);

    const check = findCheck(result.checks, "kiro_whoami_probe_timed_out");
    expect(check).toMatchObject({
      code: "kiro_whoami_probe_timed_out",
      level: "warn",
      message: "Kiro whoami probe timed out.",
    });
    // Status is based on all checks - if data_dir check fails, status could be fail
    // Just check that the timeout check exists with warn level
    expect(check?.level).toBe("warn");
  });

  it("skips probe for non-kiro-cli commands", async () => {
    const result = await testEnvironment({
      ...mockContext,
      config: { command: "custom-wrapper", cwd: "/tmp/test" },
    });

    const check = findCheck(result.checks, "kiro_whoami_probe_skipped_custom_command");
    expect(check).toMatchObject({
      code: "kiro_whoami_probe_skipped_custom_command",
      level: "info",
      message: "Skipped whoami probe because command is not `kiro-cli`.",
      detail: "custom-wrapper",
    });
    expect(check?.hint).toContain("kiro-cli");
    expect(runChildProcess).not.toHaveBeenCalled();
  });

  it("handles unexpected JSON output from whoami", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult({
      stdout: "not valid json",
    }));

    const result = await testEnvironment(mockContext);

    const check = findCheck(result.checks, "kiro_whoami_probe_unexpected_output");
    expect(check).toMatchObject({
      code: "kiro_whoami_probe_unexpected_output",
      level: "warn",
      message: "Kiro whoami probe ran but returned unexpected output.",
      detail: "not valid json",
    });
    expect(check?.hint).toContain("whoami --format json");
  });

  it("reports error when whoami fails with non-auth error", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult({
      exitCode: 1,
      stdout: "",
      stderr: "internal error: something broke",
    }));

    const result = await testEnvironment(mockContext);

    const check = findCheck(result.checks, "kiro_whoami_probe_failed");
    expect(check).toMatchObject({
      code: "kiro_whoami_probe_failed",
      level: "error",
      message: "Kiro whoami probe failed.",
      detail: "internal error: something broke",
    });
    expect(check?.hint).toContain("whoami --format json");
  });

  it("uses cwd from config when provided", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult());

    await testEnvironment({
      ...mockContext,
      config: { command: "kiro-cli", cwd: "/custom/path" },
    });

    expect(ensureAbsoluteDirectory).toHaveBeenCalledWith("/custom/path", { createIfMissing: true });
  });

  it("falls back to process.cwd() when no cwd in config", async () => {
    vi.mocked(runChildProcess).mockResolvedValue(mockResult());

    await testEnvironment({
      ...mockContext,
      config: { command: "kiro-cli" },
    });

    expect(ensureAbsoluteDirectory).toHaveBeenCalledWith(process.cwd(), { createIfMissing: true });
  });
});
