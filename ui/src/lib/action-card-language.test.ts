import { describe, expect, it } from "vitest";
import {
  buildActionCardLanguage,
  type ActionCardLanguageInput,
} from "./action-card-language";

const technicalSamples: ActionCardLanguageInput[] = [
  {
    family: "request_confirmation",
    prompt: "Approve POST /api/issues/abc123 through update_issue_status?",
    acceptLabel: "execute_effect_0",
    rejectLabel: "reject_request",
    technicalDetails: ["targetIssueId=abc123", "effectType=update_issue_status"],
  },
  {
    family: "request_checkbox_confirmation",
    prompt: "Select document UUIDs for DELETE /api/files",
    acceptLabel: "delete_selected",
    safetyFacts: ["Deletion is permanent."],
    technicalDetails: ["optionIds=[file-1,file-2]"],
  },
  {
    family: "ask_user_questions",
    prompt: "Choose the JSON serialization mode for the POST callback.",
    submitLabel: "submit_answers",
    technicalDetails: ["questionId=serialization-mode", "callback=/api/runs/resume"],
  },
  {
    family: "suggest_tasks",
    prompt: "Persist the following issue graph through the tasks API.",
    acceptLabel: "create_issue_records",
    technicalDetails: ["clientKey=root-1", "parentId=PAP-123"],
  },
  {
    family: "request_item_verdicts",
    prompt: "Apply effect metadata to each item and POST the resulting verdicts.",
    primaryLabel: "apply_effects",
    technicalDetails: ["effectType=assign_issue", "itemId=item-1"],
  },
];

describe("buildActionCardLanguage", () => {
  it.each(technicalSamples)(
    "leads $family with a board decision and keeps machine wording technical",
    (sample) => {
      const language = buildActionCardLanguage(sample);

      expect(language.decision).toBeTruthy();
      expect(language.consequence).toBeTruthy();
      expect(language.nonEffect).toBeTruthy();
      expect(language.primaryAction).toMatch(/\b(approve|add|answer|choose|apply|confirm|delete|review|submit|continue|request|decline)\b/i);
      expect(language.decision).not.toMatch(/\/api\/|effectType|targetIssueId|UUID|POST|DELETE|callback|serialization|issue graph/i);
      expect(language.consequence).not.toMatch(/\/api\/|effectType|targetIssueId|UUID|callback|itemId/i);
      expect(language.technicalDetails.join(" ")).toContain(sample.technicalDetails?.[0] ?? "");
    },
  );

  it("keeps safety-critical facts visible while separating identifiers and effect metadata", () => {
    const language = buildActionCardLanguage({
      family: "request_confirmation",
      prompt: "POST a private customer export to an external webhook.",
      consequence: "The export will be sent outside the company.",
      technicalDetails: ["POST /api/exports", "effectType=external_write", "runId=abc123"],
    });

    expect(language.safetyFacts).toEqual(expect.arrayContaining([
      "The export will be sent outside the company.",
    ]));
    expect(language.safetyFacts.join(" ")).toMatch(/external|private/i);
    expect(language.technicalDetails.join(" ")).toContain("effectType=external_write");
    expect(language.technicalDetails.join(" ")).toContain("runId=abc123");
  });

  it.each([
    ["cost", "This may cost $20 from the project budget."],
    ["deletion", "Deletion is permanent."],
    ["external write", "This sends a record outside the company."],
    ["access", "This changes who has access to the workspace."],
    ["privacy", "This includes private customer information."],
    ["irreversible", "This cannot be undone."],
  ])("keeps %s facts in the visible safety set", (_name, fact) => {
    const language = buildActionCardLanguage({
      family: "request_confirmation",
      prompt: "Choose an outcome for this request.",
      safetyFacts: [fact],
    });

    expect(language.safetyFacts).toContain(fact);
  });
});
