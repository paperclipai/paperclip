import { describe, expect, it } from "vitest";
import {
  buildIssueThreadInteractionSummary,
  buildSuggestedTaskTree,
  collectSuggestedTaskClientKeys,
  countSuggestedTaskNodes,
  getCheckboxConfirmationSelectedLabels,
  getItemVerdictProgress,
  getRequestConfirmationTargetHref,
  getQuestionAnswerLabels,
  normalizeRequestConfirmationTargetHref,
} from "./issue-thread-interactions";
import type { RequestItemVerdictsInteraction } from "./issue-thread-interactions";

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

    expect(buildIssueThreadInteractionSummary({
      id: "interaction-expired",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "ask_user_questions",
      status: "expired",
      continuationPolicy: "wake_assignee",
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:05:00.000Z",
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
        answers: [],
        expirationReason: "superseded_by_comment",
        commentId: "11111111-1111-4111-8111-111111111111",
      },
    })).toBe("Question expired after comment");
  });

  it("summarizes checkbox confirmation interactions by count", () => {
    const base = {
      id: "interaction-checkbox",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "request_checkbox_confirmation" as const,
      continuationPolicy: "wake_assignee" as const,
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:00:00.000Z",
      payload: {
        version: 1 as const,
        prompt: "Pick items",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
      },
    };

    expect(buildIssueThreadInteractionSummary({ ...base, status: "pending" }))
      .toBe("Requested a selection from 3 options");

    expect(buildIssueThreadInteractionSummary({
      ...base,
      status: "accepted",
      result: { version: 1, outcome: "accepted", selectedOptionIds: ["a", "c"] },
    })).toBe("Confirmed 2 of 3 options");

    expect(buildIssueThreadInteractionSummary({
      ...base,
      status: "accepted",
      result: { version: 1, outcome: "accepted", selectedOptionIds: [] },
    })).toBe("Confirmed with no options selected");

    expect(buildIssueThreadInteractionSummary({
      ...base,
      status: "expired",
      result: { version: 1, outcome: "stale_target" },
    })).toBe("Selection expired after target changed");
  });

  it("maps selected checkbox option ids back to labels", () => {
    const labels = getCheckboxConfirmationSelectedLabels({
      payload: {
        version: 1,
        prompt: "Pick items",
        options: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Bravo" },
          { id: "c", label: "Charlie" },
        ],
      },
      result: { version: 1, outcome: "accepted", selectedOptionIds: ["c", "a", "missing"] },
    });

    expect(labels).toEqual(["Charlie", "Alpha"]);
  });

  it("allows only safe confirmation target hrefs for rendering", () => {
    for (const href of [
      "https://example.com/checklist",
      "http://example.com/checklist",
      "/PAP/issues/PAP-123#document-plan",
      "#document-plan",
    ]) {
      expect(normalizeRequestConfirmationTargetHref(href)).toBe(href);
    }

    for (const href of [
      "file:///tmp/x",
      "mailto:user@example.com",
      "slack://channel?id=1",
      "vscode://file/tmp/x",
      "ftp://example.com/file",
      "//evil.example/path",
    ]) {
      expect(normalizeRequestConfirmationTargetHref(href)).toBeNull();
    }
  });

  it("does not return unsafe custom target hrefs from accepted payloads", () => {
    expect(getRequestConfirmationTargetHref({
      issueId: "issue-1",
      target: {
        type: "custom",
        key: "unsafe-target",
        label: "Unsafe target",
        href: "file:///tmp/x",
      },
    })).toBeNull();

    expect(getRequestConfirmationTargetHref({
      issueId: "issue-1",
      target: {
        type: "issue_document",
        issueId: "issue-2",
        key: "plan",
        revisionId: "11111111-1111-4111-8111-111111111111",
        href: "slack://channel?id=1",
      },
    })).toBe("/issues/issue-2#document-plan");
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
          otherText: "A written answer",
        },
      ],
    });

    expect(labels).toEqual(["Option 2", "Option 1", "Other: A written answer"]);
  });
});

describe("per-item verdict helpers", () => {
  function verdictInteraction(
    overrides: Partial<RequestItemVerdictsInteraction> = {},
  ): RequestItemVerdictsInteraction {
    return {
      id: "interaction-verdicts",
      companyId: "company-1",
      issueId: "issue-1",
      kind: "request_item_verdicts",
      status: "pending",
      continuationPolicy: "wake_assignee",
      createdAt: "2026-04-06T12:00:00.000Z",
      updatedAt: "2026-04-06T12:00:00.000Z",
      payload: {
        version: 1,
        prompt: "Review the posts.",
        items: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        verdicts: ["approve", "reject"],
        requireReasonOn: ["reject"],
      },
      ...overrides,
    } as RequestItemVerdictsInteraction;
  }

  it("counts decided items and lists still-pending ids in payload order", () => {
    const progress = getItemVerdictProgress({
      payload: verdictInteraction().payload,
      result: {
        version: 1,
        outcome: "resolved",
        complete: false,
        items: [
          { id: "a", verdict: "approve", resolvedByUserId: "u", resolvedAt: "2026-04-06T12:01:00.000Z" },
          { id: "c", verdict: "reject", reason: "no", resolvedByUserId: "u", resolvedAt: "2026-04-06T12:01:00.000Z" },
        ],
      },
    });
    expect(progress).toMatchObject({ total: 3, decided: 2, approved: 1, rejected: 1, deferred: 0 });
    expect(progress.pendingItemIds).toEqual(["b"]);
  });

  it("summarizes pending, complete, and superseded verdict cards", () => {
    expect(buildIssueThreadInteractionSummary(verdictInteraction())).toBe("0 of 3 decided");

    expect(buildIssueThreadInteractionSummary(verdictInteraction({
      status: "answered",
      result: {
        version: 1,
        outcome: "resolved",
        complete: true,
        items: [
          { id: "a", verdict: "approve", resolvedByUserId: "u", resolvedAt: "2026-04-06T12:01:00.000Z" },
          { id: "b", verdict: "approve", resolvedByUserId: "u", resolvedAt: "2026-04-06T12:01:00.000Z" },
          { id: "c", verdict: "reject", reason: "no", resolvedByUserId: "u", resolvedAt: "2026-04-06T12:01:00.000Z" },
        ],
      },
    }))).toBe("3 decided · 2 approved · 1 rejected");

    expect(buildIssueThreadInteractionSummary(verdictInteraction({
      status: "expired",
      result: {
        version: 1,
        outcome: "superseded_by_comment",
        complete: false,
        items: [],
      },
    }))).toBe("Verdicts expired after comment");
  });
});
