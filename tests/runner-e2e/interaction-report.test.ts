import { describe, expect, it } from "vitest";
import {
  interactionReportTitle,
  renderInteractionCard,
} from "./interaction-report.js";
import type { Row } from "./first-task-scoring.js";
const row = (kind: string, payload: object, result?: object): Row => ({
  id: "card",
  kind,
  status: result ? "answered" : "pending",
  payload,
  result,
});
const face = (r: Row) =>
  renderInteractionCard(r).split('<details class="transcript-raw">')[0];

describe("static interaction cards", () => {
  it("shows every legacy question with options, help, requirements, and recorded free text", () => {
    const r = row(
      "ask_user_questions",
      {
        submitLabel: "Continue",
        questions: [
          {
            id: "q",
            prompt: "How can we help?",
            helpText: "Choose a starting point",
            required: true,
            selectionMode: "single",
            options: [
              {
                id: "plan",
                label: "Make a plan",
                description: "Start with a proposal",
              },
              { id: "custom", label: "I have a task", freeText: true },
            ],
          },
        ],
      },
      {
        answers: [
          { questionId: "q", optionIds: [], otherText: "Write a welcome note" },
        ],
      },
    );
    const s = face(r);
    for (const v of [
      "How can we help?",
      "Choose a starting point",
      "Required",
      "Make a plan",
      "Start with a proposal",
      "Write a welcome note",
      "Continue",
      "Recorded answer",
    ])
      expect(s).toContain(v);
    expect(s).toContain('disabled checked aria-label="I have a task"');
    expect(s).not.toContain('aria-label="Other"');
  });
  it("supports canonical multi-select and text questions without inventing an Other option", () => {
    const r = row(
      "ask_user_questions",
      {
        questionSet: {
          title: "Project choices",
          submitLabel: "Send",
          questions: [
            {
              id: "q",
              prompt: "Which channels?",
              answerMode: "multi_select",
              required: false,
              options: [
                { id: "a", label: "Email", recommended: true },
                { id: "b", label: "Chat" },
              ],
            },
            {
              id: "text",
              prompt: "Describe your team",
              answerMode: "text",
              required: true,
            },
          ],
        },
      },
      {
        answers: {
          q: { selectedOptionIds: ["a", "b"] },
          text: { text: "Two volunteers" },
        },
      },
    );
    const s = face(r);
    expect(s.match(/type="checkbox" disabled checked/g)).toHaveLength(2);
    expect(s).toContain("Recommended");
    expect(s).toContain("Two volunteers");
    expect(s).toContain("Question 2 of 2");
    expect(s).not.toContain('aria-label="Other"');
  });
  it("keeps closed legacy select sets closed", () => {
    expect(
      face(
        row("ask_user_questions", {
          questions: [
            { id: "q", prompt: "Pick one", allowOther: false, options: [] },
          ],
        }),
      ),
    ).not.toContain('aria-label="Other"');
  });
  it("renders proposal target, exact action labels, and a rejected decision", () => {
    const r = row(
      "request_confirmation",
      {
        prompt: "Create the note?",
        detailsMarkdown: "One short document",
        acceptLabel: "Accept proposal",
        rejectLabel: "Request changes",
        target: {
          type: "issue_document",
          label: "Welcome plan",
          revisionNumber: 2,
          key: "plan",
        },
      },
      { outcome: "rejected", reason: "Too broad" },
    );
    const s = face(r);
    for (const v of [
      "Create the note?",
      "Welcome plan",
      "Revision 2",
      "Accept proposal",
      "✓ Request changes",
      "Too broad",
    ])
      expect(s).toContain(v);
  });
  it("distinguishes checkbox defaults from submitted selections", () => {
    const p = {
      prompt: "Choose work",
      minSelected: 1,
      maxSelected: 2,
      defaultSelectedOptionIds: ["a"],
      options: [
        { id: "a", label: "Draft" },
        { id: "b", label: "Review" },
      ],
    };
    expect(face(row("request_checkbox_confirmation", p))).toContain(
      "Preselected defaults · not submitted",
    );
    const s = face(
      row("request_checkbox_confirmation", p, {
        outcome: "accepted",
        selectedOptionIds: ["b"],
      }),
    );
    expect(s).toContain('disabled checked aria-label="Review"');
    expect(s).not.toContain('disabled checked aria-label="Draft"');
    expect(s).not.toContain("not submitted");
    const rejected = row("request_checkbox_confirmation", p, {
      outcome: "rejected",
    });
    expect(face(rejected)).not.toContain("disabled checked");
  });
  it("shows per-item verdicts, reasons, previews and remaining undecided items", () => {
    const r = row(
      "request_item_verdicts",
      {
        prompt: "Review drafts",
        verdicts: ["approve", "reject", "defer"],
        items: [
          { id: "a", label: "Draft A", previewMarkdown: "First draft" },
          { id: "b", label: "Draft B" },
        ],
      },
      {
        items: [{ id: "a", verdict: "reject", reason: "Wrong date" }],
        complete: false,
      },
    );
    const s = face(r);
    for (const v of [
      "First draft",
      "✓ Reject",
      "Wrong date",
      "Draft B",
      "Defer",
      "Reason required for",
    ])
      expect(s).toContain(v);
  });
  it("shows suggested task structure and outcomes while omitting hidden preview tasks", () => {
    const r = row(
      "suggest_tasks",
      {
        tasks: [
          { clientKey: "parent", title: "Welcome campaign", priority: "high" },
          {
            clientKey: "child",
            parentClientKey: "parent",
            title: "Write note",
            description: "Two sentences",
            assigneeAgentId: "agent",
          },
          {
            clientKey: "hidden",
            title: "Hidden runtime task",
            hiddenInPreview: true,
          },
        ],
      },
      {
        createdTasks: [
          { clientKey: "parent", issueId: "new", identifier: "FIR-2" },
        ],
        skippedClientKeys: ["child"],
      },
    );
    const s = renderInteractionCard(
      r,
      new Map([["agent", "Garden lead"]]),
    ).split('<details class="transcript-raw">')[0];
    for (const v of [
      "Created · FIR-2",
      "Skipped",
      "Garden lead",
      "Parent",
      "Welcome campaign",
      "Two sentences",
    ])
      expect(s).toContain(v);
    expect(s).not.toContain("Hidden runtime task");
    expect(renderInteractionCard(r)).toContain("Hidden runtime task");
  });
  it("renders connection requests and authorization metadata without active auth links or images", () => {
    const r = row(
      "connection_intent",
      {
        serviceName: "Gmail",
        requestingAgentName: "Alex",
        phase: "needs_retry",
        serviceLogoUrl: "https://example.test/tracking.png",
        purpose: "ai",
      },
      { outcome: "declined", reason: "Use another inbox" },
    );
    const s = face(r);
    for (const v of [
      "Connect Gmail",
      "Alex",
      "Try again",
      "Agent runtime authentication",
      "Use another inbox",
    ])
      expect(s).toContain(v);
    expect(s).not.toMatch(/<(img|iframe)|href=/);
    const auth = row("request_confirmation", {
      prompt: "Connect your account",
      connectionAuthorization: {
        providerName: "Gmail",
        connectionName: "Work inbox",
        requestingAgentName: "Alex",
      },
    });
    expect(interactionReportTitle(auth)).toBe("Connection authorization");
    expect(face(auth)).toContain("Work inbox");
  });
  it("renders tool approvals, permission scope and execution failure", () => {
    const r = row(
      "request_confirmation",
      {
        prompt: "Send this email?",
        toolAction: {
          toolDisplayName: "Send email",
          appDisplayName: "Gmail",
          risk: "write",
          previewMarkdown: "To the garden club",
          argumentsSummaryJson: '{"subject":"Welcome"}',
          rememberActionScope: "Send garden club emails",
        },
      },
      {
        outcome: "accepted",
        toolAction: { status: "failed", errorMessage: "Delivery failed" },
      },
    );
    const s = face(r);
    for (const v of [
      "Approve &amp; run",
      "Decline",
      "Always allow",
      "Send garden club emails",
      "Tool execution",
      "Delivery failed",
    ])
      expect(s).toContain(v);
    expect(interactionReportTitle(r)).toBe("Tool action approval");
  });
  it("renders credential-binding display metadata and outcome", () => {
    const r = row(
      "request_confirmation",
      {
        secretProposal: {
          sourceSecretLabel: "Work credential",
          targetAgentName: "Alex",
          configPath: "env.API_KEY",
          justification: "Required for the task",
        },
      },
      { outcome: "accepted", secretProposal: { status: "executed" } },
    );
    for (const v of [
      "Work credential",
      "Alex",
      "env.API_KEY",
      "Required for the task",
      "Approve &amp; bind",
      "executed",
    ])
      expect(face(r)).toContain(v);
  });
  it("escapes untrusted text and makes every choice and action inert", () => {
    const r = row("ask_user_questions", {
      questions: [
        {
          id: "q",
          prompt: "<script>alert(1)</script>",
          options: [
            {
              id: "a",
              label: '\" onfocus=\"alert(1)',
              description: "<img src=x onerror=alert(1)>",
            },
          ],
        },
      ],
    });
    const s = renderInteractionCard(r);
    expect(s).toContain("&lt;script&gt;");
    expect(s).not.toMatch(/<(script|img|form)\b/);
    for (const tag of s.match(/<(?:input|button)\b[^>]*>/g) ?? [])
      expect(tag).toMatch(/\bdisabled\b/);
  });
  it("keeps unknown kinds inspectable without presenting invented controls", () => {
    const r = row("future_widget", { prompt: "A future card", values: [1, 2] });
    expect(face(r)).toContain("No visual renderer");
    expect(face(r)).not.toContain("<button");
    expect(renderInteractionCard(r)).toContain("&quot;values&quot;");
  });
});
