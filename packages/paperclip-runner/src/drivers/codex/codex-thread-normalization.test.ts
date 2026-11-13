import { describe, expect, it } from "vitest";

import {
  boundedCodexWorkspaceStat,
  codexThreadLineage,
  codexWorkspaceRelativePath,
  isBoundCodexNotification,
  parseCodexThreadGoal,
  safeCodexRequestResponse,
} from "./codex-thread-normalization.js";

describe("Codex thread normalization", () => {
  it("normalizes goals and snake-case subagent lineage", () => {
    expect(parseCodexThreadGoal({
      threadId: "thread-1",
      objective: "Complete the task",
      status: "active",
      tokenBudget: 10_000,
      tokensUsed: 500,
      timeUsedSeconds: 30,
      createdAt: 1,
      updatedAt: 2,
    })).toMatchObject({
      threadId: "thread-1",
      status: "active",
      tokenBudget: 10_000,
      tokensUsed: 500,
    });
    expect(parseCodexThreadGoal({
      threadId: "thread-1",
      objective: "",
      status: "active",
    })).toBeNull();
    for (const invalidNumber of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(parseCodexThreadGoal({
        threadId: "thread-1",
        objective: "Invalid counters must fail closed",
        status: "active",
        tokensUsed: invalidNumber,
      })).toBeNull();
    }

    expect(codexThreadLineage({
      id: "child",
      sessionId: "provider-child",
      status: { type: "idle" },
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent",
            depth: 2,
            agent_nickname: "builder",
            agent_role: "worker",
          },
        },
      },
    })).toEqual({
      threadId: "child",
      providerSessionId: "provider-child",
      parentThreadId: "parent",
      depth: 2,
      nickname: "builder",
      role: "worker",
      status: "idle",
    });
  });

  it("admits only bound notifications and safe workspace paths", () => {
    const binding = { runId: "run-1", threadIds: ["thread-1"] };
    expect(isBoundCodexNotification({
      method: "turn/started",
      params: { threadId: "thread-1" },
    }, binding)).toBe(true);
    expect(isBoundCodexNotification({
      method: "item/completed",
      params: {
        thread: {
          id: "unbound-child",
          source: { subagent: { thread_spawn: { parent_thread_id: "thread-1" } } },
        },
      },
    }, binding)).toBe(false);
    expect(isBoundCodexNotification({
      method: "item/completed",
      params: { runId: "run-1" },
    }, binding)).toBe(false);
    expect(isBoundCodexNotification({
      method: "thread/started",
      params: {
        thread: {
          id: "child-thread",
          source: { subagent: { thread_spawn: { parent_thread_id: "thread-1" } } },
        },
      },
    }, binding)).toBe(true);
    expect(isBoundCodexNotification({
      method: "turn/started",
      params: { threadId: "other-thread" },
    }, binding)).toBe(false);
    expect(isBoundCodexNotification({
      method: "item/completed",
      params: { runId: "other-run", threadId: "thread-1" },
    }, binding)).toBe(false);
    expect(isBoundCodexNotification({
      method: "unknown/provider/event",
      params: { runId: "run-1" },
    }, binding)).toBe(false);
    expect(isBoundCodexNotification({
      method: "warning",
      params: {},
    }, binding)).toBe(false);

    expect(codexWorkspaceRelativePath("src\\index.ts")).toBe("src/index.ts");
    expect(codexWorkspaceRelativePath("../secret")).toBeNull();
    expect(codexWorkspaceRelativePath("/absolute/path")).toBeNull();
    expect(codexWorkspaceRelativePath("C:/host/path")).toBeNull();
    expect(codexWorkspaceRelativePath("C:../secret")).toBeNull();
    expect(codexWorkspaceRelativePath("c:..\\secret")).toBeNull();
    expect(codexWorkspaceRelativePath("Z:relative\\host-path")).toBeNull();
    expect(boundedCodexWorkspaceStat(12)).toBe(12);
    expect(boundedCodexWorkspaceStat(-1)).toBeNull();
  });

  it("returns provider-safe terminal responses for unresolved requests", () => {
    expect(safeCodexRequestResponse("item/permissions/requestApproval")).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(safeCodexRequestResponse("mcpServer/elicitation/request", "cancel")).toEqual({
      action: "cancel",
      content: null,
      _meta: null,
    });
    expect(safeCodexRequestResponse("tool/requestUserInput")).toEqual({ answers: {} });
    expect(safeCodexRequestResponse("applyPatchApproval")).toEqual({ decision: "decline" });
  });
});
