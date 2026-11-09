import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPaperclipTaskMarkdown } from "./task-markdown.js";

const issue = {
  id: "task-1",
  identifier: "TEST-1",
  title: "Inspect the evidence",
};

describe("heartbeat task markdown rendering", () => {
  it.each([true, false])("keeps native task clarification in the current task on full and resumed assignments (description=%s)", (includeDescription) => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { ...issue, description: "Write a blog post about our launch." },
      nativeRunner: true,
      includeDescription,
    });

    expect(markdown).toContain("Task clarification directive:");
    expect(markdown).toContain("Inspect the available task description, plan, conversation, prior answers, and relevant references before asking");
    expect(markdown).toContain("ask one focused question at a time in this task");
    expect(markdown).toContain('interactionKind: "questions", payload.questions');
    expect(markdown).toContain('resolverPolicy: "human_only", continuationPolicy: "wake_assignee"');
    expect(markdown).toContain("stable idempotencyKey");
    expect(markdown).toContain("do not send the user to a separate chat or create a replacement task");
    expect(markdown).toContain("Reuse an existing relevant pending question");
    expect(markdown).toContain("an unanswered question is not consent");
    expect(markdown).toContain("A human-dismissed request is deferred to history");
    expect(markdown).toContain("Do not invent material user intent or success criteria");
  });

  it("preserves execution of a clear accepted plan without imposing clarification", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { ...issue, workMode: "planning" },
      nativeRunner: true,
      acceptedPlanContinuation: true,
      taskPlan: { documentId: "plan", revisionId: "revision", revisionNumber: 1, body: "Write a 300-word launch post for customers using the supplied brief." },
    });

    expect(markdown).toContain("If the outcome and success criteria are clear enough to act, proceed without a setup checklist or ritual questions");
    expect(markdown).toContain("When a missing decision materially changes the outcome");
    expect(markdown).toContain("Implement the accepted plan on this issue");
    expect(markdown).toContain("Write a 300-word launch post for customers using the supplied brief.");
  });

  it.each([
    { nativeRunner: false, coordinatorWorkspace: true, conversationAgentId: null },
    { nativeRunner: undefined, coordinatorWorkspace: false, conversationAgentId: null },
    { nativeRunner: true, coordinatorWorkspace: false, conversationAgentId: "coordinator" },
    { nativeRunner: true, coordinatorWorkspace: true, conversationAgentId: "coordinator" },
  ])("does not add native task clarification to adapter or standing-chat assignments: %j", ({ conversationAgentId, ...input }) => {
    expect(buildPaperclipTaskMarkdown({ issue: { ...issue, conversationAgentId }, ...input }))
      .not.toContain("Task clarification directive:");
  });

  it("shows inferred task proposals only for opted-in native conversations while preserving explicit creation", () => {
    const issue = { id: "chat", identifier: null, title: "Chat", conversationAgentId: "coordinator" };
    const classic = buildPaperclipTaskMarkdown({ issue, nativeRunner: true });
    expect(classic).not.toContain("Coordinator task proposals:");
    const optedIn = buildPaperclipTaskMarkdown({ issue, nativeRunner: true, coordinatorWorkspace: true });
    expect(optedIn).toContain('interactionKind: "suggest_tasks"');
    expect(optedIn).toContain("acceptance creates the task atomically");
    expect(optedIn).toContain("If the user explicitly authorized task creation, use create_task directly");
    expect(buildPaperclipTaskMarkdown({ issue, nativeRunner: false, coordinatorWorkspace: true }))
      .not.toContain("Coordinator task proposals:");
  });
  it("tells a standing chat about the Conference Room only while the experiment is enabled", () => {
    const chat = { id: "chat", identifier: "RUN-1", title: "Chat", conversationAgentId: "ceo" };
    const enabled = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, conferenceRoomEnabled: true });
    expect(enabled).toContain("Conference Room:");
    expect(enabled).toContain("[Open the Conference Room](/<prefix>/board-chat)");
    expect(enabled).toContain("does not carry over this conversation's history");
    expect(buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true })).not.toContain("board-chat");
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, conversationAgentId: null }, nativeRunner: true, conferenceRoomEnabled: true }))
      .not.toContain("board-chat");
  });
  it("tells a standing chat what a status card is, how to create and refresh one, and to reply now with its link, only while the experiment is enabled", () => {
    const chat = { id: "chat", identifier: "RUN-1", title: "Chat", conversationAgentId: "ceo" };
    const enabled = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, statusCardsEnabled: true })!;
    expect(enabled).toContain("Status Cards:");
    expect(enabled).toContain("A status card is a saved Paperclip feature, not a document or comment");
    expect(enabled).toContain("POST /api/companies/{companyId}/status-cards");
    expect(enabled).toContain("POST /api/status-cards/{id}/refresh");
    expect(enabled).toContain("Do not sleep or poll the card. Report the outcome the response gives");
    expect(enabled).toContain("enqueued false otherwise means no run started, so say why from card.state");
    expect(enabled).toContain("[Launch blockers](/<prefix>/status/<cardId>)");
    // The named pages are the board's real routes.
    const app = readFileSync(new URL("../../../../ui/src/App.tsx", import.meta.url), "utf8");
    expect(enabled).toContain("Status page at /<prefix>/status (");
    expect(app).toMatch(/path="status"\s+element=\{<StatusCardsExperimentalGate>/);
    expect(app).toMatch(/path="status\/:cardId"\s+element=\{<StatusCardsExperimentalGate>/);
    expect(buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true })).not.toContain("Status Cards:");
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, conversationAgentId: null }, nativeRunner: true, statusCardsEnabled: true }))
      .not.toContain("Status Cards:");
  });
  it("returns null without a task or a nonempty wake comment", () => {
    expect(buildPaperclipTaskMarkdown({ issue: null })).toBeNull();
    expect(buildPaperclipTaskMarkdown({
      issue: null,
      wakeComments: [{ id: "empty", body: " \n " }],
    })).toBeNull();
  });

  it("renders comment-only context in order without changing the input", () => {
    const input = {
      issue: null,
      wakeComments: [
        Object.freeze({ id: "first", body: "  First request.  " }),
        Object.freeze({ id: "empty", body: "  " }),
        Object.freeze({ id: "last", body: "\nLatest request.\n" }),
      ],
    };
    const before = structuredClone(input);
    const markdown = buildPaperclipTaskMarkdown(input)!;

    expect(markdown).toContain("Pending wake comments (oldest to newest):");
    expect(markdown.indexOf('("first")')).toBeLessThan(markdown.indexOf('("last")'));
    expect(markdown).toContain("\nFirst request.\n");
    expect(markdown).toContain("\nLatest request.\n");
    expect(markdown).not.toContain('("empty")');
    expect(input).toEqual(before);
    expect(buildPaperclipTaskMarkdown(input)).toBe(markdown);
  });

  it("quotes task scalars and keeps embedded code fences inside the description", () => {
    const description = "First line.\n````text\nQuoted instruction.\n````\nLast line.";
    const title = 'A "quoted" title\nwith a second line';
    const markdown = buildPaperclipTaskMarkdown({
      issue: { ...issue, title, description },
    });

    expect(markdown).toContain(`- Title: ${JSON.stringify(title)}`);
    expect(markdown).toContain(`Issue description:\n\`\`\`\`\`text\n${description}\n\`\`\`\`\``);
  });

  it("keeps the nearest six ancestors and reports omitted ancestor context", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue,
      ancestors: Array.from({ length: 7 }, (_, index) => ({
        id: `ancestor-${index + 1}`,
        title: `Ancestor title ${index + 1}`,
      })),
    });

    expect(markdown).toContain("- Parent: ancestor-1 Ancestor title 1");
    expect(markdown).toContain("- Ancestor 6: ancestor-6 Ancestor title 6");
    expect(markdown).not.toContain("ancestor-7");
    expect(markdown).toContain("[ancestor context truncated after 6 entries]");
  });

  it.each([true, false])("retains attachment-only wakes with hidden comment bodies (native=%s)", (nativeRunner) => {
    const contentPath = "/api/attachments/attachment-1/content";
    const markdown = buildPaperclipTaskMarkdown({
      issue: null,
      nativeRunner,
      includeWakeComments: false,
      wakeComments: [{
        id: "comment-file",
        body: "  ",
        attachments: [{
          id: "attachment-1",
          filename: "evidence.txt",
          contentType: "text/plain",
          byteSize: 42,
          contentPath,
        }],
      }],
    });

    expect(markdown).toContain('Attachments on wake comment "comment-file":');
    expect(markdown).toContain('"filename":"evidence.txt"');
    expect(markdown).toContain("Attachment directive:");
    if (nativeRunner) {
      expect(markdown).not.toContain(contentPath);
      expect(markdown).toContain("read_task_attachment");
    } else {
      expect(markdown).toContain(contentPath);
      expect(markdown).toContain("PAPERCLIP_API_KEY");
    }
  });

  it("keeps a rejected plan from granting execution through an older acceptance", () => {
    const markdown = buildPaperclipTaskMarkdown({
      issue: { ...issue, workMode: "planning" },
      acceptedPlanContinuation: true,
      interaction: { kind: "request_confirmation", status: "accepted" },
      acceptedPlan: { revisionId: "old-approved-revision", revisionNumber: 1 },
      planReview: { status: "rejected", reason: "Revise the scope.\n```\nQuoted feedback.\n```" },
    });

    expect(markdown).toContain("Rejected plan review directive:");
    expect(markdown).toContain("Make the plan only. Do not write code or perform implementation work.");
    expect(markdown).toContain("This is not approval to implement or hand off execution tasks.");
    expect(markdown).toContain("````text\nRevise the scope.");
    expect(markdown).not.toContain("Implement the accepted plan");
    expect(markdown).not.toContain("old-approved-revision");
  });
});
