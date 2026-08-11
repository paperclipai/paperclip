import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  mergeCoalescedContextSnapshot,
  projectWakeIssueDescription,
  projectWakeRelatedChildIssues,
  projectWakeRelatedLinkedDocuments,
  resolveWakeContextMode,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
  wakeContextLimits,
} from "../services/heartbeat.js";

describe("buildPaperclipTaskMarkdown", () => {
  it("surfaces the immediate parent's description so a delegated assignee sees the authoritative spec (HELA-7803)", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "child-1",
        identifier: "PAP-9001",
        title: "Implement widget",
        description: "Do the child work.",
      },
      ancestors: [
        {
          id: "parent-1",
          identifier: "PAP-9000",
          title: "Widget umbrella",
          status: "in_progress",
          priority: "high",
          description: "AUTHORITATIVE DoR: build the widget with REQ-01..REQ-05.",
        },
        {
          id: "grandparent-1",
          identifier: "PAP-8000",
          title: "Program epic",
          description: "Deep ancestor description that must NOT be fully inlined verbatim-at-length.",
        },
      ],
    });

    expect(markdown).toContain("Authoritative parent / ancestor context:");
    // Immediate parent description is inlined (retires the hand-copied-DoR workaround).
    expect(markdown).toContain("AUTHORITATIVE DoR: build the widget with REQ-01..REQ-05.");
    // Deeper ancestor still gets a (bounded) excerpt but the nearest parent is prioritized.
    expect(markdown).toContain("- Parent: PAP-9000 Widget umbrella (in_progress) [high]");
    expect(markdown).toContain("- Ancestor 2: PAP-8000 Program epic");
  });

  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"planning\"");
    expect(assignment).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");

    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("Make the plan only.");
  });

  it("adds accepted-plan continuation guidance for standard-work issues when the wake is flagged as a plan continuation", () => {
    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-2",
        identifier: "PAP-415",
        title: "Implement the fix",
        workMode: "standard",
        description: null,
      },
      acceptedPlanContinuation: true,
    });

    expect(acceptedConfirmation).toContain("Accepted plan directive:");
    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("- Work mode: \"planning\"");
  });

  it("adds answer-only guidance for ask-mode issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-ask",
        identifier: "PAP-416",
        title: "Explain the tradeoff",
        workMode: "ask",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"ask\"");
    expect(assignment).toContain("Ask mode directive:");
    expect(assignment).toContain("Answer the question directly in the issue thread.");
    expect(assignment).toContain("Do not write implementation code");
    expect(assignment).toContain("do not produce an implementation plan");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.checkboxSelection).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves resolved interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        checkboxSelection: {
          prompt: "Delete selected files?",
          selectedOptionIds: ["file-b"],
          selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
        },
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
    expect(merged.checkboxSelection).toEqual({
      prompt: "Delete selected files?",
      selectedOptionIds: ["file-b"],
      selectedOptions: [{ id: "file-b", label: "b.txt", description: "Generated build output" }],
    });
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      paperclipWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        paperclipWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});

describe("resolveWakeContextMode (HELA-7804 opt-in fat mode)", () => {
  it("defaults to thin unless the agent explicitly opts into fat", () => {
    expect(resolveWakeContextMode(undefined)).toBe("thin");
    expect(resolveWakeContextMode(null)).toBe("thin");
    expect(resolveWakeContextMode({})).toBe("thin");
    expect(resolveWakeContextMode({ contextMode: "thin" })).toBe("thin");
    expect(resolveWakeContextMode({ contextMode: "verbose" })).toBe("thin");
    expect(resolveWakeContextMode("fat")).toBe("thin"); // non-object runtimeConfig
  });

  it("honors an explicit fat opt-in", () => {
    expect(resolveWakeContextMode({ contextMode: "fat" })).toBe("fat");
  });

  it("raises inline comment budgets only in fat mode", () => {
    const thin = wakeContextLimits("thin");
    const fat = wakeContextLimits("fat");
    expect(fat.maxComments).toBeGreaterThan(thin.maxComments);
    expect(fat.maxTotalBodyChars).toBeGreaterThan(thin.maxTotalBodyChars);
  });
});

describe("projectWakeIssueDescription (HELA-7804 description across surfaces)", () => {
  it("returns null for empty/absent descriptions", () => {
    expect(projectWakeIssueDescription(null)).toEqual({ description: null, descriptionTruncated: false });
    expect(projectWakeIssueDescription(undefined)).toEqual({ description: null, descriptionTruncated: false });
    expect(projectWakeIssueDescription("")).toEqual({ description: null, descriptionTruncated: false });
  });

  it("passes short descriptions through untruncated", () => {
    const result = projectWakeIssueDescription("Full DoR spec.");
    expect(result).toEqual({ description: "Full DoR spec.", descriptionTruncated: false });
  });

  it("truncates long descriptions and flags the truncation", () => {
    const long = "x".repeat(5_000);
    const result = projectWakeIssueDescription(long);
    expect(result.descriptionTruncated).toBe(true);
    expect(result.description).not.toBeNull();
    expect(result.description!.length).toBeLessThan(long.length);
    expect(long.startsWith(result.description!)).toBe(true);
  });
});

describe("projectWakeRelatedLinkedDocuments (HELA-7804 Related context)", () => {
  it("emits key + title only in thin mode (no bodies)", () => {
    const { documents, truncated } = projectWakeRelatedLinkedDocuments(
      [{ key: "plan", title: "Plan", body: "x".repeat(9_000) }],
      "thin",
    );
    expect(truncated).toBe(false);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toEqual({ key: "plan", title: "Plan" });
    expect(documents[0]).not.toHaveProperty("body");
  });

  it("inlines bounded doc bodies in fat mode under a shared budget", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      key: `doc-${i}`,
      title: `Doc ${i}`,
      body: "y".repeat(3_000),
    }));
    const { documents } = projectWakeRelatedLinkedDocuments(rows, "fat");
    const withBody = documents.filter((d) => typeof d.body === "string");
    // Each body is individually capped and the total is bounded, so not every doc can carry a body.
    expect(withBody.length).toBeGreaterThan(0);
    expect(withBody.length).toBeLessThan(rows.length);
    const totalBodyChars = withBody.reduce((sum, d) => sum + (d.body?.length ?? 0), 0);
    expect(totalBodyChars).toBeLessThanOrEqual(8_000);
    expect(withBody[0].bodyTruncated).toBe(true);
  });

  it("caps the number of linked docs and flags truncation", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, title: `t${i}`, body: null }));
    const { documents, truncated } = projectWakeRelatedLinkedDocuments(rows, "thin");
    expect(documents.length).toBeLessThan(rows.length);
    expect(truncated).toBe(true);
  });

  it("preserves a null title without slicing", () => {
    const { documents } = projectWakeRelatedLinkedDocuments([{ key: "k", title: null }], "thin");
    expect(documents[0].title).toBeNull();
  });
});

describe("projectWakeRelatedChildIssues (HELA-7804 Related context)", () => {
  it("surfaces open children with identifier/title/status", () => {
    const { children, truncated } = projectWakeRelatedChildIssues([
      { identifier: "HELA-7805", title: "Seed child summary", status: "todo" },
      { identifier: "HELA-7806", title: "Browser lane", status: "in_progress" },
    ]);
    expect(truncated).toBe(false);
    expect(children).toEqual([
      { identifier: "HELA-7805", title: "Seed child summary", status: "todo" },
      { identifier: "HELA-7806", title: "Browser lane", status: "in_progress" },
    ]);
  });

  it("caps the number of children and truncates long titles", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({
      identifier: `HELA-${i}`,
      title: "t".repeat(400),
      status: "todo",
    }));
    const { children, truncated } = projectWakeRelatedChildIssues(rows);
    expect(children.length).toBeLessThan(rows.length);
    expect(truncated).toBe(true);
    expect(children[0].title.length).toBeLessThan(400);
  });
});
