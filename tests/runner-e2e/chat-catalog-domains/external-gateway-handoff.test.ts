import { expect, it } from "vitest";
import { publicRotationMessages, rotationQuestionHandoff } from "./external-gateway-handoff.js";
const target = { companyId: "company", issueId: "source", personId: "person", agentId: "ceo", gatewayId: "gateway-id", runIds: ["run"] };
const item = { id: "message", type: "agentMessage", status: "completed", phase: "commentary", text: "An authorized human must perform the one-time token replacement privately." };
const event = { companyId: "company", agentId: "ceo", runId: "run", eventType: "item.completed", payload: { prpEvent: { runId: "run", payload: { item } } } };
const card = { id: "card", kind: "ask_user_questions", status: "pending", companyId: "company", issueId: "source", createdByAgentId: "ceo", addresseeUserId: "person", sourceRunId: "run", title: "Replace token", summary: "Authorized human token management", payload: { questionSet: { description: "Open Website test client gateway gateway-id; replace only Old test client. Leave unrelated client unchanged; never paste credentials in chat." } } };
it("projects only completed public messages from the actual source run", () => {
  expect(publicRotationMessages([event], target)).toHaveLength(1);
  for (const wrong of [
    { ...event, companyId: "foreign" }, { ...event, agentId: "foreign" }, { ...event, runId: "foreign" },
    { ...event, eventType: "item.started" },
    { ...event, payload: { prpEvent: { runId: "run", payload: { item: { ...item, phase: "analysis" } } } } },
    { ...event, payload: { prpEvent: { runId: "run", payload: { item: { ...item, type: "reasoning" } } } } },
    { ...event, payload: { prpEvent: { runId: "foreign", payload: { item } } } },
  ]) expect(publicRotationMessages([wrong], target)).toEqual([]);
});
it("binds a real addressed pending question to exact company/person/source/gateway/token", () => {
  const messages = publicRotationMessages([event], target);
  expect(rotationQuestionHandoff([card], messages, target)?.body).toContain(item.text);
  for (const wrong of [
    { ...card, companyId: "foreign" }, { ...card, issueId: "foreign" }, { ...card, addresseeUserId: "foreign" },
    { ...card, sourceRunId: "foreign" }, { ...card, createdByAgentId: "foreign" }, { ...card, status: "answered" },
    { ...card, payload: { questionSet: { description: card.payload.questionSet.description.replace("gateway-id", "other-id") } } },
    { ...card, payload: { questionSet: { description: "Open Website test client gateway gateway-id; replace Unrelated client." } } },
  ]) expect(rotationQuestionHandoff([wrong], messages, target)).toBeUndefined();
  expect(rotationQuestionHandoff([card, card], messages, target)).toBeUndefined();
  expect(rotationQuestionHandoff([], messages, target)).toBeUndefined();
});

it("can use an actual exact public message without manufacturing a question", () => {
  const messages = publicRotationMessages([{ ...event, payload: { prpEvent: { runId: "run", payload: { item: { ...item, text: card.payload.questionSet.description } } } } }], target);
  expect(rotationQuestionHandoff([], messages, target)?.body).toBe(card.payload.questionSet.description);
  expect(rotationQuestionHandoff([], [{ ...messages[0]!, phase: "analysis" } as never], target)).toBeUndefined();
});
