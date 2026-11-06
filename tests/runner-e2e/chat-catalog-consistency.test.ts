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
