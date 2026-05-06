import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  runChildProcess,
  ensureCommandResolvable,
  resolveCommandForLogs,
} = vi.hoisted(() => ({
  runChildProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify({ type: "message", role: "assistant", content: "done" }),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
  ensureCommandResolvable: vi.fn(async () => undefined),
  resolveCommandForLogs: vi.fn(async () => "/usr/bin/copilot"),
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

describe("copilot execute", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    vi.clearAllMocks();
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop();
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("renders Paperclip prompt through adapter-utils and invokes copilot programmatic JSON mode", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-copilot-"));
    cleanupDirs.push(rootDir);
    const workspaceDir = path.join(rootDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    const instructionsPath = path.join(rootDir, "AGENTS.md");
    await writeFile(instructionsPath, "Use TDD.\n", "utf8");
    const meta: unknown[] = [];

    const result = await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CopilotCoder",
        adapterType: "copilot_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "copilot",
        instructionsFilePath: instructionsPath,
        model: "gpt-5.2",
      },
      context: {
        taskId: "issue-1",
        paperclipWake: {
          reason: "issue_assigned",
          issue: {
            id: "issue-1",
            identifier: "PAP-1",
            title: "Do task",
            status: "in_progress",
            priority: "high",
          },
          comments: [],
          fallbackFetchNeeded: false,
        },
        paperclipWorkspace: {
          cwd: workspaceDir,
          source: "project_primary",
        },
      },
      authToken: "paperclip-token",
      onLog: async () => {},
      onMeta: async (entry) => {
        meta.push(entry);
      },
    });

    expect(result.summary).toBe("done");
    expect(runChildProcess).toHaveBeenCalledTimes(1);
    const call = runChildProcess.mock.calls[0] as unknown as
      | [string, string, string[], { cwd: string; env: Record<string, string> }]
      | undefined;
    expect(call?.[1]).toBe("copilot");
    expect(call?.[2]).toContain("-p");
    expect(call?.[2]).toContain("--output-format=json");
    expect(call?.[2]).toContain("--no-ask-user");
    expect(call?.[2]).not.toContain("--allow-all");
    expect(call?.[3].cwd).toBe(workspaceDir);
    expect(call?.[3].env.PAPERCLIP_API_KEY).toBe("paperclip-token");
    expect(JSON.stringify(meta[0])).toContain("Use TDD.");
    expect(JSON.stringify(meta[0])).toContain("PAP-1");
  });

  it("reports timeout and nonzero auth failures", async () => {
    runChildProcess.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Authentication required. Run copilot login.",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-auth",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CopilotCoder",
        adapterType: "copilot_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "copilot",
      },
      context: {},
      onLog: async () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("copilot_auth_required");
    expect(result.errorMessage).toContain("Authentication required");

    runChildProcess.mockResolvedValueOnce({
      exitCode: 124,
      signal: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      pid: 124,
      startedAt: new Date().toISOString(),
    });

    const timeoutResult = await execute({
      runId: "run-timeout",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "CopilotCoder",
        adapterType: "copilot_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "copilot",
        timeoutSec: 7,
      },
      context: {},
      onLog: async () => {},
    });

    expect(timeoutResult.timedOut).toBe(true);
    expect(timeoutResult.errorMessage).toBe("Timed out after 7s");
  });

  it("neutralizes inherited COPILOT_ALLOW_ALL unless adapter env explicitly opts in", async () => {
    const originalAllowAll = process.env.COPILOT_ALLOW_ALL;
    process.env.COPILOT_ALLOW_ALL = "true";
    try {
      await execute({
        runId: "run-env-default",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CopilotCoder",
          adapterType: "copilot_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "copilot",
        },
        context: {},
        onLog: async () => {},
      });

      let call = runChildProcess.mock.calls[0] as unknown as
        | [string, string, string[], { env: Record<string, string> }]
        | undefined;
      expect(call?.[3].env.COPILOT_ALLOW_ALL).toBe("false");

      await execute({
        runId: "run-env-explicit",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "CopilotCoder",
          adapterType: "copilot_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: "copilot",
          env: {
            COPILOT_ALLOW_ALL: "true",
          },
        },
        context: {},
        onLog: async () => {},
      });

      call = runChildProcess.mock.calls[1] as unknown as
        | [string, string, string[], { env: Record<string, string> }]
        | undefined;
      expect(call?.[3].env.COPILOT_ALLOW_ALL).toBe("true");
    } finally {
      if (originalAllowAll === undefined) {
        delete process.env.COPILOT_ALLOW_ALL;
      } else {
        process.env.COPILOT_ALLOW_ALL = originalAllowAll;
      }
    }
  });
});
