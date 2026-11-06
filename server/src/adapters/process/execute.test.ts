import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "../types.js";

const runChildProcessMock = vi.hoisted(() => vi.fn());
const resolveCommandForLogsMock = vi.hoisted(() =>
  vi.fn(async (command: string) => command),
);

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../utils.js")>("../utils.js");
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
    resolveCommandForLogs: resolveCommandForLogsMock,
  };
});

import { execute } from "./execute.js";

function baseCtx(
  overrides: Partial<AdapterExecutionContext> & {
    config?: Record<string, unknown>;
    context?: Record<string, unknown>;
  } = {},
): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "EnvProbe",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/bin/true",
      args: [],
      cwd: "/tmp",
      ...(overrides.config ?? {}),
    },
    context: overrides.context ?? {},
    onLog: async () => {},
    authToken: "run-token",
    ...overrides,
  };
}

afterEach(() => {
  runChildProcessMock.mockReset();
  resolveCommandForLogsMock.mockClear();
});

describe("process adapter execute wake env", () => {
  it("injects PAPERCLIP_TASK_ID and wake fields from context", async () => {
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(
      baseCtx({
        context: {
          taskId: "issue-abc",
          wakeReason: "issue_assigned",
          wakeCommentId: "comment-1",
          issueIds: ["issue-abc", "issue-def", ""],
        },
      }),
    );

    expect(runChildProcessMock).toHaveBeenCalledOnce();
    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(env.PAPERCLIP_RUN_ID).toBe("run-1");
    expect(env.PAPERCLIP_API_KEY).toBe("run-token");
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-abc");
    expect(env.PAPERCLIP_WAKE_REASON).toBe("issue_assigned");
    expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBe("comment-1");
    expect(env.PAPERCLIP_LINKED_ISSUE_IDS).toBe("issue-abc,issue-def");
  });

  it("falls back to context.issueId when taskId is absent", async () => {
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(
      baseCtx({
        context: {
          issueId: "issue-from-id",
          commentId: "legacy-comment",
        },
      }),
    );

    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-from-id");
    expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBe("legacy-comment");
    expect(env.PAPERCLIP_WAKE_REASON).toBeUndefined();
    expect(env.PAPERCLIP_LINKED_ISSUE_IDS).toBeUndefined();
  });

  it("omits TASK_ID when wake context has no issue/task id", async () => {
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(baseCtx({ context: {} }));

    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(env.PAPERCLIP_TASK_ID).toBeUndefined();
    expect(env.PAPERCLIP_RUN_ID).toBe("run-1");
  });

  it("prefers context.taskId over context.issueId when both are present", async () => {
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(
      baseCtx({
        context: {
          taskId: "task-wins",
          issueId: "issue-loses",
        },
      }),
    );

    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(env.PAPERCLIP_TASK_ID).toBe("task-wins");
  });

  it("treats whitespace-only taskId and issueId as absent", async () => {
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(
      baseCtx({
        context: {
          taskId: "   ",
          issueId: "\t",
          wakeReason: "  ",
          wakeCommentId: "\n",
          issueIds: ["  ", "issue-ok", ""],
        },
      }),
    );

    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(env.PAPERCLIP_TASK_ID).toBeUndefined();
    expect(env.PAPERCLIP_WAKE_REASON).toBeUndefined();
    expect(env.PAPERCLIP_WAKE_COMMENT_ID).toBeUndefined();
    expect(env.PAPERCLIP_LINKED_ISSUE_IDS).toBe("issue-ok");
  });

  it("prefers runtime wake TASK_ID over adapterConfig.env spoof", async () => {
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    await execute(
      baseCtx({
        config: {
          command: "/bin/true",
          cwd: "/tmp",
          env: {
            PAPERCLIP_TASK_ID: "attacker-issue",
            PAPERCLIP_API_KEY: "attacker-key",
          },
        },
        context: { issueId: "issue-real" },
      }),
    );

    const env = runChildProcessMock.mock.calls[0][3].env as Record<string, string>;
    expect(env.PAPERCLIP_TASK_ID).toBe("issue-real");
    expect(env.PAPERCLIP_API_KEY).toBe("run-token");
  });
});
