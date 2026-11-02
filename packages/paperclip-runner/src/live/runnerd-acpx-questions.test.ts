import { describe, expect, it } from "vitest";
import { bridgedCodexQuestionParams } from "./runnerd-codex-transport.js";
import { normalizeAcpFormElicitation } from "../drivers/acpx/acp-question-adapter.js";
import { createCodexQuestionResponseContext, normalizeCodexQuestionSet, runtimeRequestKind, runtimeRequestResponse } from "../drivers/codex/codex-question-adapter.js";

describe("ACPX questions through the shared runner transport", () => {
  it("keeps Claude's form and answer identities intact through the round trip", () => {
    const form = normalizeAcpFormElicitation({ mode: "form", message: "Interview", requestedSchema: {
      type: "object", required: ["organization", "goal"], properties: {
        organization: { type: "string", description: "What does your organization do?" },
        goal: { type: "string", description: "What should we achieve?" },
        timing: { type: "string", oneOf: [{ const: "today", title: "Today" }, { const: "later", title: "Later" }] },
      },
    } })!;
    const origin = { adapter: "acpx-runtime-sidecar", provider: "claude", method: "elicitation/create" };
    const params = bridgedCodexQuestionParams({ requestId: "question-1", input: form.questionSet, origin }, origin.method, "session", "turn")!;
    expect(runtimeRequestKind(origin.method)).toBe("elicitation");
    const context = createCodexQuestionResponseContext();
    const shown = normalizeCodexQuestionSet(origin.method, params, context)!;
    expect(shown).toEqual(form.questionSet);
    const [org, goal, timing] = shown.questions;
    const response = { schema: "paperclip.question_response.v1" as const, answers: {
      [org!.id]: { text: "Garden club" }, [goal!.id]: { text: "Welcome note" },
      [timing!.id]: { selectedOptionIds: [timing!.options![1]!.id] },
    } };
    expect(runtimeRequestResponse({ requestId: "question-1", requestKind: "elicitation", method: origin.method,
      turnId: "turn", itemId: "item", status: "pending", prompt: "Interview", input: shown }, { action: "submit", response }, context)).toEqual({ action: "submit", response });
    expect(form.accept(response)).toEqual({ action: "accept", content: { organization: "Garden club", goal: "Welcome note", timing: "later" } });
  });
  it("does not admit an invalid canonical question set", () => {
    expect(() => normalizeCodexQuestionSet("elicitation/create", { questionSet: { schema: "bad", questions: [] } }, createCodexQuestionResponseContext())).toThrow();
  });
});
