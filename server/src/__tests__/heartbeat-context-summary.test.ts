import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  mergeCoalescedContextSnapshot,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

describe("buildPaperclipTaskMarkdown", () => {
  it("surfaces every coalesced wake comment in provider order", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-burst",
        identifier: "PAP-5000",
        title: "Handle a chat burst",
        workMode: "standard",
        description: "Original request",
      },
      wakeComment: {
        id: "comment-3",
        body: "burst-four",
      },
      wakeComments: [
        { id: "comment-1", body: "burst-two" },
        { id: "comment-2", body: "burst-three" },
        { id: "comment-3", body: "burst-four" },
      ],
    });

    expect(markdown).toContain(
      "Address every comment in order. You may answer them together, but do not silently omit any comment.",
    );
    expect(markdown).toContain("Pending wake comments (oldest to newest):");
    expect(markdown).not.toContain("Latest wake comment:");
    expect(markdown!.indexOf("burst-two")).toBeLessThan(
      markdown!.indexOf("burst-three"),
    );
    expect(markdown!.indexOf("burst-three")).toBeLessThan(
      markdown!.indexOf("burst-four"),
    );
  });

  it("surfaces exact wake-comment attachment descriptors and inspection guidance", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-attachments",
        identifier: "PAP-5001",
        title: "Inspect provider files",
        workMode: "standard",
        description: null,
      },
      wakeComments: [
        {
          id: "comment-files",
          body: "Identify the image and quote the text file.",
          attachments: [
            {
              id: "attachment-image",
              filename: "evidence.png",
              contentType: "image/png",
              byteSize: 2048,
              contentPath: "/api/attachments/attachment-image/content",
            },
            {
              id: "attachment-text",
              filename: "phrase.txt",
              contentType: "text/plain",
              byteSize: 128,
              contentPath: "/api/attachments/attachment-text/content",
            },
          ],
        },
      ],
    });

    expect(markdown).toContain(
      'Attachments on wake comment "comment-files":',
    );
    expect(markdown).toContain('"id":"attachment-image"');
    expect(markdown).toContain('"filename":"phrase.txt"');
    expect(markdown).toContain(
      '"contentPath":"/api/attachments/attachment-text/content"',
    );
    expect(markdown).toContain("PAPERCLIP_API_URL");
    expect(markdown).toContain("PAPERCLIP_API_KEY");
    expect(markdown).toContain("never invoke `npx`");
    expect(markdown).toContain(
      "Do not infer file contents from filenames or metadata",
    );
  });

  it.each(["slack", "discord", "telegram", "microsoft-teams", "github"])(
    "directs %s file replies through the bundled artifact handoff",
    (externalChatProvider) => {
      const markdown = buildPaperclipTaskMarkdown({
        issue: {
          id: "issue-file-reply",
          title: "Send the requested image and file",
          workMode: "standard",
          description: null,
        },
        externalChatProvider,
      });
      expect(markdown).toContain("External chat file delivery:");
      expect(markdown).toContain("paperclip-upload-artifact.sh --chat-comment");
      expect(markdown).toContain("installed skill location, not the task workspace");
      expect(markdown).toContain("Do not search for a separate provider tool connection");
      expect(markdown).toContain("do not claim provider delivery merely because binding succeeded");
      expect(markdown).toContain(
        "one helper command per file into as few tool calls as practical",
      );
      expect(markdown).toContain("do not manually bind the same file again");
      expect(markdown).toContain(
        "Retry or investigate only a failed or ambiguous step",
      );
    },
  );

  it("omits external file handoff instructions from non-chat tasks", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-internal",
        title: "An internal task",
        workMode: "standard",
        description: null,
      },
    });
    expect(markdown).not.toContain("External chat file delivery:");
    expect(markdown).not.toContain("External chat turn efficiency:");
  });

  it.each(["slack", "discord", "telegram", "microsoft-teams", "github"])(
    "directs native %s files through scoped tools without legacy credentials",
    (externalChatProvider) => {
      const markdown = buildPaperclipTaskMarkdown({
        issue: {
          id: "native-files",
          title: "Inspect and share requested files",
          workMode: "standard",
          description: null,
        },
        externalChatProvider,
        nativeRunner: true,
        wakeComments: [{
          id: "native-file-comment",
          body: "Inspect this image, then send the requested file.",
          attachments: [{
            id: "native-attachment",
            filename: "image.png",
            contentType: "image/png",
            byteSize: 2048,
            contentPath: "/api/attachments/native-attachment/content",
          }],
        }],
      });
      expect(markdown).toContain("`register_deliverable`");
      expect(markdown).toContain("workspace-relative `contentRef`");
      expect(markdown).toContain("do not confirm provider delivery");
      expect(markdown).toContain("Register or reuse only the requested files");
      expect(markdown).toContain("`list_chat_attachments`");
      expect(markdown).toContain("`reuse_chat_attachment`");
      expect(markdown).toContain(
        "never substitute an earlier file for unavailable current-turn input",
      );
      expect(markdown).toContain("workspace-relative staged attachment descriptors");
      expect(markdown).toContain("clearly state that you could not inspect it");
      expect(markdown).toContain("batch independent reads/inspection with the appropriate available tools");
      expect(markdown).toContain("Compute exact sizes and SHA-256 hashes in the same preparation step");
      expect(markdown).toContain("batch independent per-file registrations into as few tool calls as practical");
      expect(markdown).toContain("one registration and a distinct stable idempotencyKey per file");
      expect(markdown).toContain("wait for each receipt before the final-response protocol");
      expect(markdown).toContain("retry only a failed or ambiguous step with its original key");
      expect(markdown).toContain("current source/generation authorization, exact-byte reuse, or approval gates");
      expect(markdown).toContain("skip a separate preamble and narration before each step");
      expect(markdown).toContain("Keep useful wait, blocker, permission, and failure updates");
      expect(markdown).toContain("do not suppress transport-managed progress");
      expect(markdown).toContain('"id":"native-attachment"');
      expect(markdown).not.toContain("paperclip-upload-artifact.sh");
      expect(markdown).not.toContain("PAPERCLIP_API_KEY");
      expect(markdown).not.toContain("/api/attachments/");
    },
  );

  it.each([
    { nativeRunner: false, externalChatProvider: "slack" },
    { nativeRunner: true, externalChatProvider: null },
  ])("keeps native media batching out of unrelated instruction paths: %j", (mode) => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { id: "other-workflow", identifier: null, title: "Other work" },
      ...mode,
    });
    expect(markdown).not.toContain("batch independent per-file registrations");
    expect(markdown).not.toContain("skip a separate preamble and narration before each step");
  });

  it("does not imply that GitHub chat grants attachment or repository-tool access", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-github-chat",
        identifier: "PAP-5002",
        title: "Inspect a GitHub comment",
        workMode: "standard",
        description: null,
      },
      wakeComments: [
        {
          id: "comment-github",
          body: "Inspect https://user-images.githubusercontent.com/example/file.png",
        },
      ],
      externalChatProvider: "github",
    });

    expect(markdown).toContain("GitHub chat attachment note:");
    expect(markdown).toContain(
      "does not grant repository-tool or attachment-download authority",
    );
    expect(markdown).toContain(
      "do not ask for another chat connection",
    );
    expect(markdown).toContain(
      "attach the file directly to this Paperclip task or paste the needed text",
    );
    expect(markdown).toContain(
      "Never borrow browser cookies or forward credentials to an attachment URL",
    );
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

    expect(acceptedConfirmation).toContain(
      "Implement the accepted plan on this issue when the work is small and cohesive.",
    );
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
    expect(acceptedConfirmation).toContain(
      "Implement the accepted plan on this issue when the work is small and cohesive.",
    );
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

  it("adds dry-run containment guidance for skill-test issues", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-skill-test",
        identifier: "PAP-417",
        title: "Test skill draft",
        workMode: "skill_test",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"skill_test\"");
    expect(assignment).toContain("Skill test mode directive:");
    expect(assignment).toContain("Make no durable changes outside this issue.");
    expect(assignment).toContain("Write your final output as issue document `output`");
  });

  it("strips the description for the compact resume variant but keeps directives and the wake comment", () => {
    const input = {
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Ship the fix",
        workMode: "standard",
        description: "Full multi-paragraph brief that the session already received.",
      },
      wakeComment: {
        id: "comment-1",
        body: "Please also update the changelog.",
      },
    };

    const full = buildPaperclipTaskMarkdown(input);
    expect(full).toContain("Issue description:");
    expect(full).toContain("Full multi-paragraph brief that the session already received.");

    const compact = buildPaperclipTaskMarkdown({ ...input, includeDescription: false });
    expect(compact).not.toContain("Issue description:");
    expect(compact).not.toContain("Full multi-paragraph brief");
    expect(compact).toContain("- Issue: \"PAP-3404\"");
    expect(compact).toContain("Please also update the changelog.");
  });

  it("makes the latest wake comment the immediate follow-up request", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-follow-up",
        identifier: "PAP-418",
        title: "Original task",
        workMode: "standard",
        description: "Reply with the original answer.",
      },
      wakeComment: {
        id: "comment-follow-up",
        body: "Reply with the new answer instead.",
      },
    });

    expect(commentWake).toContain("The latest wake comment is the immediate request for this run.");
    expect(commentWake).toContain("Do not repeat an earlier requested output from the issue description");
    expect(commentWake).toContain("Reply with the new answer instead.");
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

  it("preserves a deferred interaction when a later comment joins its successor wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
      { preserveExistingInteractionContinuation: true },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("keeps a queued comment when an interaction joins its successor wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeCommentIds: ["comment-1"],
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "ask_user_questions",
        interactionStatus: "answered",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      { preserveExistingInteractionContinuation: true },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("ask_user_questions");
    expect(merged.interactionStatus).toBe("answered");
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
    expect(merged.wakeCommentIds).toEqual(["comment-1"]);
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
