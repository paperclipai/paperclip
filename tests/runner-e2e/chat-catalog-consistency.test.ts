import { chatCatalogTasks } from "./chat-feature-cases.js";
import { expect, it, vi } from "vitest";
import { validateChatCatalogConsistency } from "./chat-catalog-consistency.js";
import { chatCatalogCases } from "./chat-catalog-registry.js";
import { chatCatalogScenarios } from "./chat-catalog-inventory.js";
import { validChatCatalogHumanCounts, chatCatalogHumanHistoryMatches } from "./chat-catalog-contract.js";

it("loads all 242 actual lazy declarations through the admission loaders without executing fixtures", async () => {
  expect(chatCatalogCases).toHaveLength(242);
  expect([...chatCatalogCases.map(row => row.scenarioId), "tasks.create-backlog", "tasks.delegate-announcement"].sort())
    .toEqual(chatCatalogScenarios.map(row => row.id).sort());
  expect(await validateChatCatalogConsistency()).toEqual({ descriptorCount: 242, fixtureCallbacksInvoked: 0 });
});
it("rejects actual declaration drift before any fixture callback executes", async () => {
  const descriptor = chatCatalogCases.find(row => row.scenarioId === "agents.hire-denied")!;
  const callback = vi.fn(() => { throw new Error("Fixture must not execute during preflight"); });
  const runtime = { ...descriptor, setup: callback, observe: callback, grade: callback, verifyResult: callback };
  const importer = async () => ({ [descriptor.exportName]: [runtime] });
  await expect(validateChatCatalogConsistency([descriptor], importer)).resolves.toMatchObject({ descriptorCount: 1 });
  await expect(validateChatCatalogConsistency([{ ...descriptor, sourceFiles: [...descriptor.sourceFiles, "unreviewed.ts"] }], importer)).rejects.toThrow("Runtime descriptor drift");
  await expect(validateChatCatalogConsistency([{ ...descriptor, expectedRunCount: descriptor.expectedRunCount + 1 }], importer)).rejects.toThrow("Runtime descriptor drift");
  expect(callback).not.toHaveBeenCalled();
});
it("preserves the effective one-human limit when optional declaration defaults are used", () => {
  const choice = chatCatalogCases.find(row => row.scenarioId === "execution-environments.choose-capable-target")!;
  const explicit = { ...choice, expectedHumanMessageCount: 1 };
  const effective = (row: typeof choice) => row.expectedHumanMessageCount ?? 1;
  expect(effective(choice)).toBe(1); expect(effective(explicit)).toBe(1);
  expect(validChatCatalogHumanCounts(choice)).toBe(true); expect(validChatCatalogHumanCounts(explicit)).toBe(true);
  expect(validChatCatalogHumanCounts({ ...choice, expectedHumanMessageCount: 0 })).toBe(false);
  const history = { human: [{ id: "canonical", body: "Original query" }], runIds: [], boundary: { humanCommentIds: [], runIds: [] }, renderedQuery: "Original query" };
  for (const implementation of [choice, explicit]) {
    expect(chatCatalogHumanHistoryMatches({ ...history, implementation })).toBe(true);
    expect(chatCatalogHumanHistoryMatches({ ...history, implementation, human: [] })).toBe(false);
    expect(chatCatalogHumanHistoryMatches({ ...history, implementation, human: [...history.human, { id: "extra", body: "Hidden nudge" }] })).toBe(false);
  }
});

it("declares company approval as a static optional extra action without invoking callbacks",async()=>{
 const descriptor=chatCatalogCases.find(row=>row.scenarioId==="secrets.configure-company-secret")!;
 expect(descriptor).toMatchObject({expectedRunCount:3,minimumRunCount:2,expectedHumanMessageCount:2,optionalCompanySecretBindingApproval:true});
 expect(chatCatalogTasks.find(t=>t.id===descriptor.scenarioId)).toMatchObject({expectedRunCount:3,minimumExpectedRunCount:2,expectedHumanMessageCount:2,optionalCompanySecretBindingApproval:true});
 expect(chatCatalogTasks.filter(t=>t.optionalCompanySecretBindingApproval).map(t=>t.id)).toEqual([descriptor.scenarioId]);
 const callback=vi.fn(()=>{throw new Error("No fixture or proof callback during declaration validation");});
 const runtime={...descriptor,setup:callback,observe:callback,grade:callback,verifyResult:callback,expectedCompanySecretBindingApproval:callback};
 const importer=async()=>({[descriptor.exportName]:[runtime]});
 await expect(validateChatCatalogConsistency([descriptor],importer)).resolves.toMatchObject({fixtureCallbacksInvoked:0});
 await expect(validateChatCatalogConsistency([{...descriptor,optionalCompanySecretBindingApproval:undefined}],importer)).rejects.toThrow("Runtime descriptor drift");
 expect(validChatCatalogHumanCounts({...descriptor,scenarioId:"secrets.personal-secret"})).toBe(false);
 expect(callback).not.toHaveBeenCalled();
});

// Full cohort 12 fix run (tasks.ambiguous-task): the person chose the Launch option on the CEO's question card.
// A chosen option saves no comment, so the flow must count the independently verified answer as the second action.
it("counts a verified clarification choice as the ambiguous-task person's second action", async () => {
  const { verifyChatCatalogHumanQuestionAnswer } = await import("./chat-catalog-contract.js");
  const { answeredClarification } = await import("./chat-catalog-domains/internal-tasks.js");
  const implementation = chatCatalogCases.find(row => row.scenarioId === "tasks.ambiguous-task")!;
  const expected = answeredClarification({ state: { answeredQuestion: { interactionId: "card", sourceRunId: "first", userId: "person", questionId: "landing_page_task", optionId: "com-1" } } })!;
  expect(expected).toEqual({ interactionId: "card", sourceRunId: "first", userId: "person", clarificationChoice: { questionId: "landing_page_task", optionId: "com-1" } });
  expect(answeredClarification({ state: { answeredQuestion: { interactionId: "card", sourceRunId: "first", userId: null } } })).toBeUndefined();
  expect(answeredClarification({ state: {} })).toBeUndefined();
  const card = { id: "card", kind: "ask_user_questions", status: "answered", companyId: "co", issueId: "chat", sourceRunId: "first", createdByAgentId: "ceo",
    createdByUserId: null, addresseeUserId: "person", addresseeAgentId: null, resolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
    resolvedByUserId: "person", resolvedByAgentId: null, resolvedAt: "2026-11-13T15:01:47Z",
    result: { answers: [{ questionId: "landing_page_task", optionIds: ["com-1"] }] } };
  const audit = { companyId: "co", entityId: "chat", action: "issue.thread_interaction_answered", actorType: "user", actorId: "person",
    details: { interactionId: "card", interactionKind: "ask_user_questions", interactionStatus: "answered" } };
  const runs = [
    { id: "first", companyId: "co", agentId: "ceo", status: "succeeded", runtimeMode: "native", startedAt: "2026-11-13T15:00:30Z", contextSnapshot: { issueId: "chat", commentId: "query" } },
    { id: "second", companyId: "co", agentId: "ceo", status: "succeeded", runtimeMode: "native", startedAt: "2026-11-13T15:01:48Z", contextSnapshot: { issueId: "chat", interactionId: "card" } },
  ];
  const verify = (overrides: Record<string, unknown> = {}, rows = runs) => verifyChatCatalogHumanQuestionAnswer({ expected, companyId: "co", issueId: "chat", agentId: "ceo",
    canonicalComment: { id: "query", authorUserId: "person" }, interactions: [{ ...card, ...overrides } as never], activity: [audit], runs: rows });
  const answer = verify();
  expect(answer).toMatchObject({ continuationRunId: "second" });
  // A typed "Other" answer, an unanswered card, or no continuation run is not a verified choice.
  expect(verify({ result: { answers: [{ questionId: "landing_page_task", optionIds: [], otherText: "COM-1" }] } })).toBeUndefined();
  expect(verify({ status: "pending" })).toBeUndefined();
  // The product lets the person answer an unaddressed card, or one any resolver but its agent creator may answer.
  expect(verify({ addresseeUserId: null, resolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator" })).toMatchObject({ continuationRunId: "second" });
  expect(verify({ resolverPolicy: "agent_only", effectiveResolverPolicy: "agent_only" })).toBeUndefined();
  expect(verify({ addresseeUserId: "someone-else" })).toBeUndefined();
  // The saved choice must be the Launch option alone.
  expect(verify({ result: { answers: [{ questionId: "landing_page_task", optionIds: ["com-2"] }] } })).toBeUndefined();
  expect(verify({ result: { answers: [{ questionId: "landing_page_task", optionIds: ["com-1", "com-2"] }] } })).toBeUndefined();
  expect(verify({}, runs.slice(0, 1))).toBeUndefined();
  const history = { human: [{ id: "query", body: "Mark the landing-page task as high priority." }], runIds: ["first", "second"],
    boundary: { humanCommentIds: [], runIds: [] }, renderedQuery: "Mark the landing-page task as high priority." };
  expect(chatCatalogHumanHistoryMatches({ ...history, implementation, questionAnswer: answer })).toBe(true);
  expect(chatCatalogHumanHistoryMatches({ ...history, implementation })).toBe(false);
  expect(chatCatalogHumanHistoryMatches({ ...history, implementation: { ...implementation, scenarioId: "tasks.edit-properties" }, questionAnswer: answer })).toBe(false);
});
it("accepts a not_creator card resolved by a person other than its creator, as the server does", async () => {
  const { chatCatalogHumanQuestionPolicies } = await import("./chat-catalog-contract.js");
  const notCreator = { resolverPolicy: "not_creator", requestedResolverPolicy: "not_creator", effectiveResolverPolicy: "not_creator" };
  expect(chatCatalogHumanQuestionPolicies({ ...notCreator, createdByUserId: null }, { userId: "person" })).toBe(true);
  expect(chatCatalogHumanQuestionPolicies({ ...notCreator, createdByUserId: "person" }, { userId: "person" })).toBe(false);
  expect(chatCatalogHumanQuestionPolicies({ ...notCreator, createdByUserId: null })).toBe(false);
  expect(chatCatalogHumanQuestionPolicies({ resolverPolicy: "anyone", effectiveResolverPolicy: "human_only" })).toBe(true);
  expect(chatCatalogHumanQuestionPolicies({ resolverPolicy: "agent_only" }, { userId: "person" })).toBe(false);
});
