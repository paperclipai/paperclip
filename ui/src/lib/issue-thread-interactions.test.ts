import { describe, expect, it } from "vitest";
import {
  buildIssueThreadInteractionSummary,
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getQuestionAnswerLabels,
} from "./issue-thread-interactions";

describe("buildSuggestedTaskTree", () => {
  it("preserves parent-child relationships from client keys", () => {
    const roots = buildSuggestedTaskTree([
      {
        clientKey: "root",
        title: "Root",
      },
      {
        clientKey: "child",
        parentClientKey: "root",
        title: "Child",
      },
      {
        clientKey: "grandchild",
        parentClientKey: "child",
        title: "Grandchild",
      },
    ]);

    expect(roots).toHaveLength(1);
    expect(roots[0]?.task.clientKey).toBe("root");
    expect(roots[0]?.children[0]?.task.clientKey).toBe("child");
    expect(countSuggestedTaskNodes(roots[0]!)).toBe(3);
    expect(collectSuggestedTaskClientKeys(roots[0]!)).toEqual(["root", "child", "grandchild"]);
  });
});

describe("issue thread interaction helpers", () => {
  it("summarizes task and question interactions", () => {
    expect(buildIssueThreadInteractionSummary({
      id: "interaction-1",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "suggest_tasks",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:00:00.000Z",
      payload: {
        version: 1,
        tasks: [
          { clientKey: "task-1", title: "One" },
          { clientKey: "task-2", title: "Two" },
        ],
      },
    })).toBe("Suggested 2 tasks");

    expect(buildIssueThreadInteractionSummary({
      id: "interaction-accepted",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "suggest_tasks",
      status: "accepted",
      continuationPolicy: "wake_assignee",
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:00:00.000Z",
      payload: {
        version: 1,
        tasks: [
          { clientKey: "task-1", title: "One" },
          { clientKey: "task-2", title: "Two" },
        ],
      },
      result: {
        version: 1,
        createdTasks: [{ clientKey: "task-1", issueId: "child-1" }],
        skippedClientKeys: ["task-2"],
      },
    })).toBe("Accepted 1 of 2 tasks");

    expect(buildIssueThreadInteractionSummary({
      id: "interaction-2",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "ask_user_questions",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:00:00.000Z",
      payload: {
        version: 1,
        questions: [
          {
            id: "question-1",
            prompt: "Pick one",
            selectionMode: "single",
            options: [{ id: "option-1", label: "Option 1" }],
          },
        ],
      },
    })).toBe("Asked 1 question");

    expect(buildIssueThreadInteractionSummary({
      id: "interaction-answered",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "ask_user_questions",
      status: "answered",
      continuationPolicy: "wake_assignee",
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:00:00.000Z",
      payload: {
        version: 1,
        questions: [
          {
            id: "question-1",
            prompt: "Pick one",
            selectionMode: "single",
            options: [{ id: "option-1", label: "Option 1" }],
          },
        ],
      },
      result: {
        version: 1,
        answers: [{ questionId: "question-1", optionIds: ["option-1"] }],
      },
    })).toBe("Answered 1 question");
  });

  it("maps stored option ids back to labels for answered summaries", () => {
    const labels = getQuestionAnswerLabels({
      question: {
        id: "question-1",
        prompt: "Pick options",
        selectionMode: "multi",
        options: [
          { id: "option-1", label: "Option 1" },
          { id: "option-2", label: "Option 2" },
        ],
      },
      answers: [
        {
          questionId: "question-1",
          optionIds: ["option-2", "option-1"],
        },
      ],
    });

    expect(labels).toEqual(["Option 2", "Option 1"]);
  });
});
