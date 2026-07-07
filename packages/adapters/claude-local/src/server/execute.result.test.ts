import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { runChildProcess, ensureCommandResolvable, resolveCommandForLogs } = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "claude"),
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

describe("claude run failure classification", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  const runExecute = async (proc: { exitCode: number; stdout: string; stderr?: string }) => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-claude-result-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    const instructionsPath = path.join(rootDir, "instructions.md");
    await mkdir(workspaceDir, { recursive: true });
    await writeFile(instructionsPath, "Do the work.\n", "utf8");

    runChildProcess.mockResolvedValueOnce({
      exitCode: proc.exitCode,
      signal: null,
      timedOut: false,
      stdout: proc.stdout,
      stderr: proc.stderr ?? "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const logLines: string[] = [];
    const result = await execute({
      runId: "run-1",
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
        instructionsFilePath: instructionsPath,
        cwd: workspaceDir,
      },
      context: {},
      onLog: async (_stream, chunk) => {
        logLines.push(chunk);
      },
    });
    return { result, logLines };
  };

  it("classifies a subtype=success result as succeeded even when the process exits non-zero", async () => {
    const { result, logLines } = await runExecute({
      exitCode: 1,
      stdout: [
        JSON.stringify({ type: "system", subtype: "init", session_id: "11111111-1111-4111-8111-111111111111", model: "claude-sonnet" }),
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          session_id: "11111111-1111-4111-8111-111111111111",
          result: "Shipped the fix and opened a PR.",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
        }),
      ].join("\n"),
    });

    expect(result.errorMessage).toBeNull();
    expect(result.errorCode).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.summary).toBe("Shipped the fix and opened a PR.");
    expect(logLines.join("")).toContain("treating the run as succeeded");
  });

  it("still fails a non-zero exit without a parsed result", async () => {
    const { result } = await runExecute({
      exitCode: 1,
      stdout: "not json at all",
      stderr: "claude: something broke",
    });

    expect(result.errorMessage).toBe("Claude exited with code 1: claude: something broke");
  });

  it("still fails an is_error=true result even with subtype=success", async () => {
    const { result } = await runExecute({
      exitCode: 1,
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        session_id: "11111111-1111-4111-8111-111111111111",
        result: "something went sideways",
      }),
    });

    expect(result.errorMessage).toBe("Claude run failed: subtype=success: something went sideways");
  });
});
