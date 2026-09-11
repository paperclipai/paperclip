import { describe, it, expect } from "vitest";
import {
  assertChatHandoff,
  isResetRun,
  type ChatIssue,
  type ChatRun,
} from "./chat-flow.js";
import { runnerMatrix } from "./catalog.js";
import { isPublicRunnerScreenshotRoute } from "./screenshot-policy.js";

const source: ChatIssue = {
  id: "chat",
  companyId: "co",
  title: "Chat",
  status: "in_review",
  assigneeAgentId: "agent",
};
const task: ChatIssue = {
  ...source,
  id: "work",
  parentId: null,
  projectId: "project",
};
const plan = {
  body: "# Relevant plan",
  latestRevisionId: "revision",
  updatedAt: "2026-09-11T10:00:00Z",
};
const run: ChatRun = {
  id: "run",
  companyId: "co",
  agentId: "agent",
  status: "succeeded",
  startedAt: "2026-09-11T10:00:01Z",
};
describe("chat acceptance contracts", () => {
  it("has exactly six workflows on the four chosen local profiles", () => {
    const matrix = runnerMatrix.filter(
      (cell) => cell.suite.id === "agent-chat",
    );
    expect(matrix).toHaveLength(24);
    expect(new Set(matrix.map((cell) => cell.profile.id))).toEqual(
      new Set([
        "legacy-codex",
        "legacy-claude",
        "runner-codex",
        "runner-acpx-claude",
      ]),
    );
    expect(new Set(matrix.map((cell) => cell.task.id)).size).toBe(6);
    expect(
      matrix.every(
        (cell) =>
          cell.environment.id === "local" &&
          cell.task.expectedTerminalState.issue === "in_review",
      ),
    ).toBe(true);
  });
  it("rejects missing plan, chat children, wrong assignments, and execution before the plan", () => {
    expect(() => assertChatHandoff(task, plan, [run], source)).not.toThrow();
    for (const invalid of [
      { ...task, parentId: "chat" },
      { ...task, projectId: null },
      { ...task, assigneeAgentId: "other" },
    ])
      expect(() => assertChatHandoff(invalid, plan, [run], source)).toThrow();
    expect(() =>
      assertChatHandoff(task, { ...plan, body: "" }, [run], source),
    ).toThrow();
    expect(() =>
      assertChatHandoff(
        task,
        { ...plan, updatedAt: "2026-09-11T10:00:02Z" },
        [run],
        source,
      ),
    ).toThrow();
    expect(() => assertChatHandoff(task, plan, [], source)).toThrow();
  });
  it("separates reset control runs from provider runs without treating failures as resets", () => {
    expect(isResetRun(run)).toBe(false);
    expect(isResetRun({ ...run, status: "failed" })).toBe(false);
    expect(
      isResetRun({ ...run, contextSnapshot: { conversationReset: true } }),
    ).toBe(true);
  });
  it("only publishes screenshots of the exact disposable chat", () => {
    const target = {
      issuePrefix: "E2E",
      issueId: "chat",
      issueIdentifier: null,
      chatAgentId: "fixture-agent",
    };
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3199/E2E/chats/fixture-agent",
        target,
      ),
    ).toBe(true);
    expect(
      isPublicRunnerScreenshotRoute(
        "http://127.0.0.1:3199/E2E/chats/another-agent",
        target,
      ),
    ).toBe(false);
    expect(
      isPublicRunnerScreenshotRoute(
        "https://example.com/E2E/chats/fixture-agent",
        target,
      ),
    ).toBe(false);
  });
});
