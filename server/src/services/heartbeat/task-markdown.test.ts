import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NATIVE_PLAN_REVIEW_DIRECTIVE, buildPaperclipTaskMarkdown } from "./task-markdown.js";

const issue = {
  id: "task-1",
  identifier: "TEST-1",
  title: "Inspect the evidence",
};

describe("heartbeat task markdown rendering", () => {
  it("tells agents on ordinary tasks when to offer a routine, only while routine offers are enabled", () => {
    for (const nativeRunner of [true, false]) {
      const markdown = buildPaperclipTaskMarkdown({ issue, nativeRunner, routineSuggestionsEnabled: true })!;
      expect(markdown).toContain("Routine offer:");
      expect(markdown).toContain("POST /api/issues/task-1/routine-suggestions");
      expect(markdown).toContain("Do not offer for one-off work");
      expect(markdown).toContain("just before finish_task");
      expect(buildPaperclipTaskMarkdown({ issue, nativeRunner })).not.toContain("Routine offer:");
    }
    // Chats, Ask and Plan work are not repeatable task completions.
    expect(buildPaperclipTaskMarkdown({ issue: { ...issue, conversationAgentId: "agent-1" }, routineSuggestionsEnabled: true }))
      .not.toContain("Routine offer:");
    for (const workMode of ["ask", "planning"]) {
      expect(buildPaperclipTaskMarkdown({ issue: { ...issue, workMode }, routineSuggestionsEnabled: true })).not.toContain("Routine offer:");
    }
  });

  it("carries signup context and proposal boundaries into every onboarding chat turn, greeting only on arrival", () => {
    const input = { issue: { ...issue, conversationAgentId: "agent", description: '{"initialIdea":"Launch a newsletter"}' },
      nativeRunner: true, coordinatorWorkspace: true, onboardingChat: true };
    const greeting = buildPaperclipTaskMarkdown({ ...input, onboardingGreeting: true });
    expect(greeting).toContain("Welcome turn:");
    expect(greeting).toContain("so it streams to the user");
    for (const includeDescription of [true, false]) {
      const followup = buildPaperclipTaskMarkdown({ ...input, includeDescription });
      expect(followup).toContain("Launch a newsletter");
      expect(followup).toContain("concrete goal and clear exit criteria");
      expect(followup).toContain("begin a structured interview only when they request");
      expect(followup).toContain('interactionKind: "suggest_tasks"');
      expect(followup).toContain("acceptance creates the task atomically");
      expect(followup).toContain("omit projectId from the suggestion");
      expect(followup).not.toContain("Coordinator task proposals:");
      expect(followup).toContain("An explicit task-creation request authorizes creating it directly");
      expect(followup).not.toContain("Welcome turn:");
    }
    expect(buildPaperclipTaskMarkdown({ issue })).not.toContain("Onboarding conversation:");
  });
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

  it("tells a native Plan-mode run that Paperclip opens the one plan review card", () => {
    const planning = { issue: { ...issue, workMode: "planning" } };
    expect(buildPaperclipTaskMarkdown({ ...planning, nativeRunner: true })).toContain(NATIVE_PLAN_REVIEW_DIRECTIVE);
    // Adapters keep their own approval flow, and an accepted plan is executed.
    expect(buildPaperclipTaskMarkdown({ ...planning, nativeRunner: false })).not.toContain(NATIVE_PLAN_REVIEW_DIRECTIVE);
    expect(buildPaperclipTaskMarkdown({ ...planning, nativeRunner: true, acceptedPlanContinuation: true,
      taskPlan: { documentId: "plan", revisionId: "revision", revisionNumber: 1, body: "Do it." } })).not.toContain(NATIVE_PLAN_REVIEW_DIRECTIVE);
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

  it("tells a chat agent the person's time zone only when it is known", () => {
    const chat = { id: "chat", identifier: null, title: "Chat", conversationAgentId: "coordinator" };
    const line = "The person's time zone is America/Chicago (from their browser). Read times and dates they give";
    expect(buildPaperclipTaskMarkdown({ issue: chat, personTimeZone: "America/Chicago" })).toContain(line);
    expect(buildPaperclipTaskMarkdown({ issue: chat, personTimeZone: "America/Chicago" })).toContain("save schedules such as routine triggers with that timezone; say the zone when you report a schedule.");
    expect(buildPaperclipTaskMarkdown({ issue: chat, personTimeZone: null })).not.toContain("The person's time zone is");
    expect(buildPaperclipTaskMarkdown({ issue: chat })).not.toContain("The person's time zone is");
    expect(buildPaperclipTaskMarkdown({ issue, personTimeZone: "America/Chicago" })).not.toContain("The person's time zone is");
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
  it("gives a standing chat real company page paths instead of a /<prefix>/ placeholder it could copy into a link", () => {
    const chat = { id: "chat", identifier: "COM-12", title: "Chat", conversationAgentId: "ceo" };
    const markdown = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, conferenceRoomEnabled: true, statusCardsEnabled: true, casesEnabled: true, coordinatorWorkspace: true })!;
    expect(markdown).not.toContain("/<prefix>/");
    expect(markdown).toContain("profile settings at /COM/company/settings/instance/profile");
    expect(markdown).toContain("/COM/issues/<identifier>");
    // Without an identifier the prefix is unknown, so the documented placeholder stays.
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, identifier: null } })).toContain("/<prefix>/issues/<identifier>");
  });
  it("tells a standing chat about the Conference Room only while the experiment is enabled", () => {
    const chat = { id: "chat", identifier: "RUN-1", title: "Chat", conversationAgentId: "ceo" };
    const enabled = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, conferenceRoomEnabled: true });
    expect(enabled).toContain("Conference Room:");
    expect(enabled).toContain("[Open the Conference Room](/RUN/board-chat)");
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
    expect(enabled).toContain("[Launch blockers](/RUN/status/<cardId>)");
    // The named pages are the board's real routes.
    const app = readFileSync(new URL("../../../../ui/src/App.tsx", import.meta.url), "utf8");
    expect(enabled).toContain("Status page at /RUN/status (");
    expect(app).toMatch(/path="status"\s+element=\{<StatusCardsExperimentalGate>/);
    expect(app).toMatch(/path="status\/:cardId"\s+element=\{<StatusCardsExperimentalGate>/);
    expect(buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true })).not.toContain("Status Cards:");
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, conversationAgentId: null }, nativeRunner: true, statusCardsEnabled: true }))
      .not.toContain("Status Cards:");
  });
  it("tells a standing chat to link a case's page by its identifier, only while the Cases experiment is enabled", () => {
    const chat = { id: "chat", identifier: "RUN-1", title: "Chat", conversationAgentId: "ceo" };
    const enabled = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, casesEnabled: true })!;
    expect(enabled).toContain("Cases:");
    expect(enabled).toContain("/RUN/cases/<case identifier>");
    expect(enabled).toContain("[RUN-C1](/RUN/cases/RUN-C1)");
    // The named page is the board's real route.
    const app = readFileSync(new URL("../../../../ui/src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/path="cases\/:caseIdentifier"/);
    expect(buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true })).not.toContain("Cases:");
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, conversationAgentId: null }, nativeRunner: true, casesEnabled: true }))
      .not.toContain("Cases:");
  });
  it("points a standing chat at the responsibility tools, or says the feature is off", () => {
    const chat = { id: "chat", identifier: "RUN-1", title: "Chat", conversationAgentId: "ceo" };
    const enabled = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, responsibilitiesEnabled: true })!;
    expect(enabled).toContain("Areas and responsibilities:");
    expect(enabled).toContain("read them first with list_responsibilities");
    expect(enabled).toContain("Do not ask the person what their responsibilities are or where they are written down before reading them");
    expect(enabled).toContain("/RUN/responsibilities");
    const app = readFileSync(new URL("../../../../ui/src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/path="responsibilities"/);
    const off = buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true, responsibilitiesEnabled: false })!;
    expect(off).toContain("Areas and responsibilities are turned off on this instance");
    expect(off).not.toContain("list_responsibilities");
    expect(buildPaperclipTaskMarkdown({ issue: chat, nativeRunner: true })).not.toContain("Areas and responsibilities");
    expect(buildPaperclipTaskMarkdown({ issue: { ...chat, conversationAgentId: null }, nativeRunner: true, responsibilitiesEnabled: true }))
      .not.toContain("Areas and responsibilities");
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

  it("points the follow-up directive at the wake comment when the wake payload carries its text", () => {
    const input = {
      issue: { id: "issue-48", identifier: "PAP-48", title: "Two small files", workMode: "standard", description: "Two small files are needed." },
      wakeComment: { id: "comment-latest", body: "append three to w1.txt" },
    };
    const assignment = buildPaperclipTaskMarkdown({ ...input, includeWakeComments: false })!;
    expect(assignment).toContain('Follow-up directive:');
    expect(assignment).toContain('Latest wake comment: "comment-latest", shown in the wake payload.');
    expect(assignment).not.toMatch(/Latest wake comment:\n\n/);
    expect(assignment).not.toContain("append three to w1.txt");
    const legacy = buildPaperclipTaskMarkdown(input)!;
    expect(legacy).toContain("Latest wake comment:\n```text\nappend three to w1.txt\n```");
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

    expect(markdown).toContain('Latest wake comment: "comment-file" has attachments only; see the attachment directive.');
    expect(markdown).not.toContain("shown in the wake payload");
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
