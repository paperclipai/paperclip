import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { questionSetToAskUserQuestionsPayload } from "../../../packages/shared/src/question-set.js";
const port = vi.hoisted(() => ({ observation: {} as Record<string, unknown> }));
vi.mock("./external-support.js", async original => ({ ...await original<typeof import("./external-support.js")>(), observeExternal: async () => port.observation }));
import { personalSecretExternalCases, personalSecretQuestionHandoff } from "./external-personal-secret.js";
afterEach(() => { vi.useRealTimers(); });
export function question() {
  return { id: "question", companyId: "company", issueId: "source", sourceRunId: "initial", createdByAgentId: "ceo",
    addresseeUserId: "person", resolverPolicy: "human_only", continuationPolicy: "wake_assignee", kind: "ask_user_questions", status: "pending",
    payload: questionSetToAskUserQuestionsPayload({ schema: "paperclip.question_set.v1", title: "Personal publishing credential",
      description: "Set your own personal publishing value securely in My secrets. Never paste the credential in chat.", questions: [{ id: "saved", prompt: "Have you set your own value?", answerMode: "single_select", required: true,
        helpText: "Settings → Secrets → My secrets → Set my value. Definition definition (PERSONAL_PUBLISHING_KEY).", options: [
          { id: "yes", label: "Yes, entered", description: "My personal value is saved in My secrets." },
          { id: "later", label: "Not yet", description: "I still need to set my value." },
        ] }] }),
  };
}
it("actual personal-secret act admits a bound secure-entry question before any private human action", async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const query = "Set up my personal publishing credential for this task.";
  const run = { id: "initial", companyId: "company", agentId: "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: "source", commentId: "human" } };
  const human = { id: "human", companyId: "company", issueId: "source", authorUserId: "person", body: query };
  port.observation = { companyId: "company", phaseReplies: [], links: [], interactions: [question()] };
  let reached = false;
  const ctx = { observationDeadlineAt: 640_000, scenario: { query }, input: { fixtures: { company: { id: "company", issuePrefix: "ACORN" }, agent: { id: "ceo" } }, api: { get: async (path: string) => {
    if (path.endsWith("/comments?order=asc")) return [human];
    if (path.endsWith("/me/user-secrets")) { reached = true; throw Error("NEXT_REAL_HUMAN_PHASE"); }
    throw Error("Unexpected API read");
  } } }, refreshIssue: async () => {}, issue: () => ({ id: "source", companyId: "company", conversationState: "waiting" }), allRuns: async () => [run] } as unknown as ChatCatalogContext;
  const pending = personalSecretExternalCases[0]!.act!(ctx, { sourceIssueId: "source", currentPersonId: "person", definitionId: "definition" }).catch((error: Error) => error);
  await vi.advanceTimersByTimeAsync(1000);
  const result = await pending; expect(result?.message).toBe("NEXT_REAL_HUMAN_PHASE"); expect(reached).toBe(true);
});

const binding = { companyId: "company", issueId: "source", agentId: "ceo", userId: "person", runId: "initial", definitionId: "definition" };
it.each(["definition", "owner", "run", "actor", "company", "source", "unsafe chat", "text value"] as const)("rejects %s question handoffs", fault => {
  const row = question();
  if (fault === "definition") row.payload.questionSet!.questions[0]!.helpText = "Settings Secrets My secrets Set my value wrong-definition PERSONAL_PUBLISHING_KEY";
  if (fault === "owner") row.addresseeUserId = "other-person";
  if (fault === "run") row.sourceRunId = "other-run";
  if (fault === "actor") row.createdByAgentId = "other-agent";
  if (fault === "company") row.companyId = "other-company";
  if (fault === "source") row.issueId = "other-source";
  if (fault === "unsafe chat") row.payload.questionSet!.description = "Enter your personal publishing credential here in chat.";
  if (fault === "text value") row.payload.questionSet!.questions[0]!.customAnswer = { enabled: true };
  expect(personalSecretQuestionHandoff(row, binding)).toBeUndefined();
});
it("does not treat a pending or wrong-person answer as the saved-value acknowledgement", () => {
  const row = question();
  expect(personalSecretQuestionHandoff(row, binding)).toMatchObject({ interactionId: "question", optionId: "yes" });
  expect(personalSecretQuestionHandoff(row, binding, "answered")).toBeUndefined();
  const answered = { ...row, status: "answered", resolvedByUserId: "other-person", result: { version: 1, answers: [{ questionId: "saved", optionIds: ["yes"] }] } };
  expect(personalSecretQuestionHandoff(answered, binding, "answered")).toBeUndefined();
});
it("uses bound completion context for terse answers without treating permission or negation as completion", () => {
  const withChoice = (label: string, prompt = "Have you saved your own value?") => {
    const row = question(), qs = row.payload.questionSet!;
    row.payload = questionSetToAskUserQuestionsPayload({ ...qs, questions: [{ ...qs.questions[0]!, prompt,
      options: [{ id: "yes", label }, { id: "later", label: "Not yet" }] }] });
    return personalSecretQuestionHandoff(row, binding);
  };
  expect(withChoice("Done")).toMatchObject({ optionId: "yes" });
  expect(withChoice("Yes")).toMatchObject({ optionId: "yes" });
  expect(withChoice("Not done")).toBeUndefined();
  expect(withChoice("Done for Riley")).toBeUndefined();
  expect(withChoice("Yes", "May I save the value for you?")).toBeUndefined();
});

it.each(["header", "title", "submitLabel"] as const)("rejects unsafe chat instructions in rendered %s", field => {
  const row = question(), qs = row.payload.questionSet!;
  const unsafe = "Enter your personal publishing credential here in chat.";
  if (field === "header") qs.questions[0]!.header = unsafe;
  else qs[field] = unsafe;
  expect(personalSecretQuestionHandoff(row, binding)).toBeUndefined();
});

it("accepts explicit own-value completion and contextual Yes while rejecting foreign or prospective answers", () => {
  const choose = (prompt: string, label: string, description?: string, header?: string, helpText?: string) => {
    const row = question(), qs = row.payload.questionSet!;
    row.payload = questionSetToAskUserQuestionsPayload({ ...qs, questions: [{ ...qs.questions[0]!, prompt, header,
      helpText: [qs.questions[0]!.helpText, helpText].filter(Boolean).join("\n"),
      options: [{ id: "yes", label, description }, { id: "later", label: "Not yet" }] }] });
    return personalSecretQuestionHandoff(row, binding);
  };
  expect(choose("Is your personal value saved?", "Yes, entered", "My personal value is saved in My secrets.")).toMatchObject({ optionId: "yes" });
  expect(choose("Did you save your own value?", "Yes")).toMatchObject({ optionId: "yes" });
  expect(choose("Is your personal value saved?", "Yes")).toMatchObject({ optionId: "yes" });
  expect(choose("Confirm your setup", "Yes", undefined, "Have you saved your own value?")).toMatchObject({ optionId: "yes" });
  expect(choose("Confirm your setup", "Yes", undefined, undefined, "Did you save your own value?")).toMatchObject({ optionId: "yes" });
  expect(choose("Have you saved your own value?", "Added to company secrets")).toBeUndefined();
  expect(choose("May I save the value for you?", "Yes, saved", "My personal value is saved.")).toBeUndefined();
});
