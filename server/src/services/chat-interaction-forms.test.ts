import { describe, expect, it } from "vitest";
import type { IssueThreadInteraction, RequestItemVerdictsInteraction } from "@paperclipai/shared";
import { chatInteractionForm, chatItemVerdicts } from "./chat-interaction-forms.js";
import { chatQuestionFormActionRecords, createChatQuestionFormDraft, parseChatQuestionFormSubmitTokenPayload } from "./chat-question-forms.js";

function review(): RequestItemVerdictsInteraction {
  return {
    id: "review-1", kind: "request_item_verdicts", status: "pending", summary: "Review the migration",
    payload: { version: 1, prompt: "Check both artifacts", items: [{ id: "api", label: "API", description: "The route" }, { id: "docs", label: "Docs" }], verdicts: ["approve", "reject"], requireReasonOn: ["reject"] },
    result: null,
  } as RequestItemVerdictsInteraction;
}

describe("Slack item reviews", () => {
  it("maps opaque form values to canonical verdicts and requires the reason for rejection", () => {
    const source = review();
    const view = chatInteractionForm(source, "slack")!;
    expect(view.summary).toContain(source.payload.prompt);
    const draft = createChatQuestionFormDraft(view, { nativeProvider: "slack" })!;
    const payload = parseChatQuestionFormSubmitTokenPayload(chatQuestionFormActionRecords(draft, { companyId: "company", conversationId: "conversation", endpointId: "endpoint", publicationId: "publication" })[1].payload)!;
    const answers = [{ questionId: "verdict:api", optionIds: ["approve"] }, { questionId: "verdict:docs", optionIds: ["reject"] }];
    const missing = chatItemVerdicts(source, answers, payload)!;
    const reasonField = payload.fields.find(field => field.questionId === "reason:docs")!;
    expect(missing.errors).toEqual({ [reasonField.fieldId]: "Explain why you chose reject." });
    const complete = chatItemVerdicts(source, [...answers, { questionId: "reason:docs", optionIds: [], otherText: "  Missing examples  " }], payload)!;
    expect(complete).toEqual({ errors: {}, verdicts: [{ id: "api", verdict: "approve" }, { id: "docs", verdict: "reject", reason: "Missing examples" }] });
    expect(chatItemVerdicts(source, [{ questionId: "verdict:api", optionIds: ["approve"] }, { questionId: "verdict:docs", optionIds: ["approve"] }], payload)!.errors).toEqual({});
  });

  it("shows only unresolved items and preserves full context", () => {
    const source = review();
    source.result = { version: 1, outcome: "resolved", complete: false, items: [{ id: "api", verdict: "approve" }] } as RequestItemVerdictsInteraction["result"];
    const view = chatInteractionForm(source, "slack")!;
    expect(view.payload.questions.map(question => question.id)).toEqual(["verdict:docs", "reason:docs"]);
    expect(source.kind).toBe("request_item_verdicts");
  });

  it("keeps unsupported providers, attachments, and oversize reviews on the complete surface", () => {
    const source = review();
    expect(chatInteractionForm(source, "telegram")).toBeNull();
    expect(chatInteractionForm({ ...source, payload: { ...source.payload, items: [{ id: "api", label: "API", attachmentId: "attachment" }] } } as IssueThreadInteraction, "slack")).toBeNull();
    expect(chatInteractionForm({ ...source, payload: { ...source.payload, items: Array.from({ length: 13 }, (_, i) => ({ id: `item-${i}`, label: `Item ${i}` })) } }, "slack")).toBeNull();
  });
});
