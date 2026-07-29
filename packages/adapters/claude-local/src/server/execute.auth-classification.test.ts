import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/local/bin/claude"),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureCommandResolvable,
    resolveCommandForLogs,
    runChildProcess,
  };
});

import { execute } from "./execute.js";

function claudeFailureStdout(result: string): string {
  return [
    JSON.stringify({ type: "system", subtype: "init", session_id: "6a3f8f61-1111-4a2b-9c3d-2e4f5a6b7c8d", model: "claude-sonnet" }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "6a3f8f61-1111-4a2b-9c3d-2e4f5a6b7c8d",
      result,
      usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
    }),
  ].join("\n");
}

describe("claude execute auth failure classification", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  async function runExecuteWithProcResult(proc: {
    exitCode: number;
    stdout: string;
    stderr: string;
  }) {
    const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-auth-"));
    cleanupDirs.push(workspaceDir);
    runChildProcess.mockResolvedValue({
      exitCode: proc.exitCode,
      signal: null,
      timedOut: false,
      stdout: proc.stdout,
      stderr: proc.stderr,
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    return await execute({
      runId: "run-auth-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Claude Coder",
        adapterType: "claude_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "claude",
        engine: "cli",
        cwd: workspaceDir,
      },
      context: {},
      onLog: async () => {},
    });
  }

  it("classifies a 401 invalid bearer token failure as claude_auth_required with a plain message", async () => {
    const result = await runExecuteWithProcResult({
      exitCode: 1,
      stdout: claudeFailureStdout("Failed to authenticate. API Error: 401 Invalid bearer token"),
      stderr: "",
    });

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorMessage).toBe(
      "Claude rejected the connected credential. Reconnect a valid Claude credential, then resume.",
    );
    expect(result.errorFamily ?? null).toBeNull();
  });

  it("classifies a 401 invalid OAuth access token failure as claude_auth_required", async () => {
    const result = await runExecuteWithProcResult({
      exitCode: 1,
      stdout: claudeFailureStdout("Failed to authenticate. API Error: 401 OAuth access token is invalid."),
      stderr: "",
    });

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorMessage).toBe(
      "Claude rejected the connected credential. Reconnect a valid Claude credential, then resume.",
    );
  });

  it("classifies an unparsed 401 authentication_error on stderr as claude_auth_required", async () => {
    const result = await runExecuteWithProcResult({
      exitCode: 1,
      stdout: "",
      stderr: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    });

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.errorMessage).toBe(
      "Claude rejected the connected credential. Reconnect a valid Claude credential, then resume.",
    );
  });

  it("keeps the existing 'Not logged in' login flow classification intact", async () => {
    const result = await runExecuteWithProcResult({
      exitCode: 1,
      stdout: "",
      stderr: "Not logged in. Please run `claude login` to authenticate.",
    });

    expect(result.errorCode).toBe("claude_auth_required");
    // The login path keeps its existing message shape (not the invalid-credential copy).
    expect(result.errorMessage).not.toBe(
      "Claude rejected the connected credential. Reconnect a valid Claude credential, then resume.",
    );
  });

  it("does not classify unrelated failures as auth failures", async () => {
    const result = await runExecuteWithProcResult({
      exitCode: 1,
      stdout: claudeFailureStdout("API Error: 500 internal server error"),
      stderr: "",
    });

    expect(result.errorCode).not.toBe("claude_auth_required");
  });
});
