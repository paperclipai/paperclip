import { describe, it, expect, vi } from "vitest";
import type { AskUserQuestionsPayload } from "../../packages/shared/src/types/issue.js";
import {
  assertChatHandoff,
  assertChatTaskHandoff,
  chatQuestionPresentation,
  chatRunFailure,
  collectChatRunEvidence,
  readRunningChatLog,
  isResetRun,
  type ChatIssue,
  type ChatRun,
} from "./chat-flow.js";
import type { RunnerApi } from "./api.js";
import { chatMarker } from "./chat-cases.js";
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
  it("keeps chat markers literal across rich-text and Markdown boundaries", () => {
    for (const prefix of ["CHAT", "DRAFT", "OLDCONTEXT"] as const) {
      expect(chatMarker(prefix, "abc123-1")).toBe(`${prefix}abc1231`);
      expect(chatMarker(prefix, "abc_123-1")).toMatch(/^[a-zA-Z0-9]+$/);
    }
    expect(chatMarker("OLDCONTEXT", "one-1")).not.toBe(
      chatMarker("CHAT", "one-1"),
    );
    expect(chatMarker("CHAT", "one-1")).not.toBe(chatMarker("CHAT", "two-1"));
  });
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
  it("requires a plan for plan handoff, while direct requests need only normal task assignment", () => {
    expect(() => assertChatTaskHandoff(task, [run], source)).not.toThrow();
    expect(() =>
      assertChatHandoff(task, { ...plan, body: "" }, [run], source),
    ).toThrow();
    expect(() =>
      assertChatTaskHandoff({ ...task, projectId: null }, [run], source),
    ).toThrow();
  });
  it("uses durable free-text labels, multi-selection, and the supplied submit label", () => {
    const payload: AskUserQuestionsPayload = {
      version: 1,
      submitLabel: "Send brief",
      questions: [
        {
          id: "audience",
          prompt: "Who is it for?",
          selectionMode: "multi",
          required: true,
          options: [
            { id: "members", label: "New members" },
            {
              id: "custom",
              label: "Another audience or occasion",
              freeText: true,
            },
          ],
        },
      ],
    };
    const presentation = chatQuestionPresentation(payload);
    expect(presentation.submitLabel).toBe("Send brief");
    expect(presentation.questions[0]).toMatchObject({
      answerMode: "multi_select",
      customAnswer: { enabled: true, label: "Another audience or occasion" },
    });
    const nativePayload: AskUserQuestionsPayload = {
      ...payload,
      questionSet: {
        schema: "paperclip.question_set.v1",
        submitLabel: "Continue",
        questions: [
          {
            id: "audience",
            prompt: "Who is it for?",
            required: true,
            answerMode: "text",
          },
        ],
      },
    };
    expect(chatQuestionPresentation(nativePayload)).toBe(
      nativePayload.questionSet,
    );
  });
  it("retains reset events without requesting a provider log, and does not hide missing real logs", async () => {
    const get = vi.fn().mockResolvedValue([{ type: "session_reset" }]);
    const reset = { ...run, resultJson: { conversationReset: true } };
    await expect(collectChatRunEvidence({ get }, reset)).resolves.toEqual({
      runId: run.id,
      log: null,
      events: [{ type: "session_reset" }],
    });
    expect(get.mock.calls).toEqual([
      [`/api/heartbeat-runs/${run.id}/events?limit=1000`],
    ]);
    get.mockRejectedValue(new Error("Run log not found"));
    await expect(collectChatRunEvidence({ get }, run)).rejects.toThrow(
      "Run log not found",
    );
  });
  it("waits for a newly running provider's log file without swallowing server failures", async () => {
    const get = vi.fn().mockResolvedValue({ status: () => 404 });
    const api = { request: { get } } as unknown as Pick<RunnerApi, "request">;
    await expect(readRunningChatLog(api, "starting")).resolves.toBeUndefined();
    get.mockResolvedValue({
      status: () => 200,
      ok: () => true,
      json: async () => ({ content: "streamed reply" }),
    });
    await expect(readRunningChatLog(api, "running")).resolves.toBe(
      "streamed reply",
    );
    get.mockResolvedValue({ status: () => 500, ok: () => false });
    await expect(readRunningChatLog(api, "broken")).rejects.toThrow(
      "log returned 500",
    );
  });
  it("fails promptly on terminal provider failures while permitting only expected cancellations", () => {
    expect(chatRunFailure([run])).toBeUndefined();
    expect(chatRunFailure([{ ...run, status: "running" }])).toBeUndefined();
    expect(
      chatRunFailure([
        {
          ...run,
          status: "failed",
          errorCode: "permission_denied",
          error: "sandbox unavailable",
        },
      ]),
    ).toContain("run run failed (permission_denied): sandbox unavailable");
    expect(chatRunFailure([{ ...run, status: "cancelled" }])).toContain(
      "cancelled",
    );
    expect(
      chatRunFailure([{ ...run, status: "cancelled" }], true),
    ).toBeUndefined();
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
