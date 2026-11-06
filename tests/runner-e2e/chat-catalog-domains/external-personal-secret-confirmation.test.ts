import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { personalSecretConfirmationHandoff, confirmThenStartPersonalConsumer } from "./external-personal-secret-confirmation.js";
import { personalSecretGuidance } from "./external-personal-secret.js";
import { verifyChatCatalogHumanQuestionAnswer, chatCatalogHumanHistoryMatches } from "../chat-catalog-contract.js";
const binding = { companyId: "company", issueId: "source", agentId: "ceo", userId: "person", runId: "initial", definitionId: "current-definition", canonicalCommentId: "human" };
function card() { return { id: "confirmation", kind: "request_confirmation", status: "pending", companyId: "company", issueId: "source", sourceRunId: "initial", createdByAgentId: "ceo", originCommentIds: ["human"], resolverPolicy: "anyone", continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Never paste personal publishing credentials in chat. Open Settings Secrets, My secrets, Set my value for PERSONAL_PUBLISHING_KEY definition current-definition. When you have saved it, confirm this card so the requirement is recorded.", acceptLabel: "Confirm" } }; }
it("admits the native secure-save confirmation shape without manufacturing a chat reply", () => {
 expect(personalSecretConfirmationHandoff(card(), binding, personalSecretGuidance)).toMatchObject({ interactionId: "confirmation", acceptLabel: "Confirm" });
});
it.each(["company", "issue", "run", "creator", "origin", "definition", "approval", "unsafe", "payload action"])("rejects unbound or non-save %s cards", fault => {
 const row = card();
 if(fault==="company")row.companyId="foreign";if(fault==="issue")row.issueId="foreign";if(fault==="run")row.sourceRunId="foreign";if(fault==="creator")row.createdByAgentId="foreign";if(fault==="origin")row.originCommentIds=[];
 if(fault==="definition")row.payload.prompt=row.payload.prompt.replace("current-definition","foreign-definition");
 if(fault==="approval")row.payload.prompt+=" Approve deployment execution.";if(fault==="unsafe")row.payload.prompt+=" Paste the credential here in chat.";
 if(fault==="payload action")Object.assign(row.payload,{toolAction:{toolName:"deploy"}});
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toBeUndefined();
});
function accounting(){
 const row={...card(),status:"accepted",resolvedByUserId:"person",resolvedAt:"2026-11-05T12:01:00Z",result:{version:1,outcome:"accepted"}};
 const payloadHash=createHash("sha256").update(JSON.stringify(row.payload)).digest("hex");
 return {expected:{interactionId:"confirmation",sourceRunId:"initial",userId:"person",personalSecretConfirmation:{definitionId:"current-definition",secretId:"secret",payloadHash,continuationPolicy:"wake_assignee"}},companyId:"company",issueId:"source",agentId:"ceo",canonicalComment:{id:"human",authorUserId:"person"},interactions:[row],personalSecrets:[{definition:{id:"current-definition"},secret:{id:"secret",companyId:"company",scope:"user",ownerUserId:"person",userSecretDefinitionId:"current-definition",status:"active",createdAt:"2026-11-05T12:00:50Z"}}],activity:[{companyId:"company",entityId:"source",action:"issue.thread_interaction_accepted",actorType:"user",actorId:"person",details:{interactionId:"confirmation",interactionKind:"request_confirmation",interactionStatus:"accepted"}}],runs:[{id:"initial",companyId:"company",agentId:"ceo",status:"succeeded",runtimeMode:"native",startedAt:"2026-11-05T12:00:00Z",contextSnapshot:{issueId:"source",commentId:"human"}},{id:"continuation",companyId:"company",agentId:"ceo",status:"succeeded",runtimeMode:"native",startedAt:"2026-11-05T12:01:01Z",contextSnapshot:{issueId:"source",interactionId:"confirmation"}}]};
}
it("counts initial chat plus one bound actual human confirmation exactly once",()=>{
 const input=accounting(),answer=verifyChatCatalogHumanQuestionAnswer(input as never);expect(answer).toMatchObject({continuationRunId:"continuation"});
 expect(chatCatalogHumanHistoryMatches({implementation:{scenarioId:"secrets.personal-secret",expectedHumanMessageCount:2},human:[{id:"human",body:"Original"}],questionAnswer:answer,runIds:["initial","continuation"],boundary:{humanCommentIds:[],runIds:[]},renderedQuery:"Original"})).toBe(true);
});
it.each(["resolver","audit","payload","save","continuation","canonical"])("rejects forged or out-of-order confirmation %s proof",fault=>{
 const input=accounting();if(fault==="resolver")input.interactions[0]!.resolvedByUserId="other";if(fault==="audit")input.activity[0]!.actorId="other";if(fault==="payload")input.interactions[0]!.payload.prompt+=" changed";if(fault==="save")input.personalSecrets[0]!.secret.createdAt="2026-11-05T12:02:00Z";if(fault==="continuation")input.runs[1]!.contextSnapshot.interactionId="foreign";if(fault==="canonical")input.interactions[0]!.originCommentIds=[];
 expect(verifyChatCatalogHumanQuestionAnswer(input as never)).toBeUndefined();
});
it("starts the authorized consumer only after ordinary confirmation completes, without retries",async()=>{
 let resolve!:()=>void;const accepted=new Promise<void>(r=>resolve=r),confirm=vi.fn(()=>accepted),start=vi.fn(async()=>{});
 const pending=confirmThenStartPersonalConsumer(confirm,start);expect(confirm).toHaveBeenCalledTimes(1);expect(start).not.toHaveBeenCalled();resolve();await pending;expect(start).toHaveBeenCalledTimes(1);
 const rejected=vi.fn(async()=>{throw Error("rejected");});await expect(confirmThenStartPersonalConsumer(rejected,start)).rejects.toThrow("rejected");expect(start).toHaveBeenCalledTimes(1);
});

it("accepts a secure-save acknowledgement with the ordinary default Approve label", () => {
 const row=card();Object.assign(row.payload,{acceptLabel:"Approve"});
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toMatchObject({acceptLabel:"Approve"});
});
it("binds an exact definition URI in visible details through admission and independent response verification", () => {
 const row=card();row.payload.prompt=row.payload.prompt.replace(" definition current-definition","");
 Object.assign(row.payload,{detailsMarkdown:"Open /RUN/company/settings/secrets?definition=current-definition"});
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toBeDefined();
 const input=accounting();Object.assign(input.interactions[0]!.payload,row.payload);input.expected.personalSecretConfirmation.payloadHash=createHash("sha256").update(JSON.stringify(row.payload)).digest("hex");
 expect(verifyChatCatalogHumanQuestionAnswer(input as never)).toBeDefined();
 Object.assign(row.payload,{detailsMarkdown:"Open /RUN/company/settings/secrets?definition=foreign-definition"});
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toBeUndefined();
 Object.assign(input.interactions[0]!.payload,row.payload);input.expected.personalSecretConfirmation.payloadHash=createHash("sha256").update(JSON.stringify(row.payload)).digest("hex");
 expect(verifyChatCatalogHumanQuestionAnswer(input as never)).toBeUndefined();
});

it.each(["After saving, confirm here so I can pick up RUN-1.", "Have you saved your personal credential? Confirm here.", "Save your personal credential. Definition current-definition uses PERSONAL_PUBLISHING_KEY. Then confirm here."])("accepts a bound post-save acknowledgement: %s", ending => {
 const row=card();row.continuationPolicy="wake_assignee_on_accept";
 row.payload.prompt=row.payload.prompt.replace("When you have saved it, confirm this card so the requirement is recorded.",ending);
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toMatchObject({continuationPolicy:"wake_assignee_on_accept"});
});
it.each(["Confirm before saving your personal credential.", "Confirm so you can save your personal credential.", "You saved your personal credential yesterday. Confirm permission to enter a new value.", "After saving your profile, confirm here.", "After saving OTHER_KEY, confirm here.", "Do not save your personal credential. Then confirm here.", "Confirm here before saving. After saving, I will resume."])("rejects a non-post-save acknowledgement: %s", ending => {
 const row=card();row.payload.prompt=row.payload.prompt.replace("When you have saved it, confirm this card so the requirement is recorded.",ending);
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toBeUndefined();
});
it("independently credits either immutable accepted-response policy only with actual save and continuation",()=>{
 const input=accounting();input.interactions[0]!.continuationPolicy="wake_assignee_on_accept";input.expected.personalSecretConfirmation.continuationPolicy="wake_assignee_on_accept";
 expect(verifyChatCatalogHumanQuestionAnswer(input as never)).toMatchObject({continuationRunId:"continuation"});
 input.interactions[0]!.continuationPolicy="wake_assignee";
 expect(verifyChatCatalogHumanQuestionAnswer(input as never)).toBeUndefined();
});
it.each(["pending","declined","historical save","foreign owner","wrong runtime","missing continuation","effect"])("rejects nonqualifying accepted-response %s",fault=>{
 const input=accounting();input.interactions[0]!.continuationPolicy="wake_assignee_on_accept";input.expected.personalSecretConfirmation.continuationPolicy="wake_assignee_on_accept";
 if(fault==="pending")input.interactions[0]!.status="pending";
 if(fault==="declined")input.interactions[0]!.result.outcome="declined";
 if(fault==="historical save")input.personalSecrets[0]!.secret.createdAt="2026-11-04T12:00:00Z";
 if(fault==="foreign owner")input.personalSecrets[0]!.secret.ownerUserId="other";
 if(fault==="wrong runtime")input.runs[1]!.runtimeMode="process";
 if(fault==="missing continuation")input.runs.pop();
 if(fault==="effect")Object.assign(input.interactions[0]!.payload,{toolAction:{toolName:"deploy"}});
 expect(verifyChatCatalogHumanQuestionAnswer(input as never)).toBeUndefined();
});

it.each(["Save your personal credential. Then cancel the save. Then confirm here.", "Save your personal credential. Do not confirm yet. Then confirm here."])("rejects an intervening save or acknowledgement cancellation: %s", ending => {
 const row=card();row.payload.prompt=row.payload.prompt.replace("When you have saved it, confirm this card so the requirement is recorded.",ending);
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toBeUndefined();
});
it("allows an unrelated no-chat warning between secure save and confirmation",()=>{
 const row=card();row.payload.prompt=row.payload.prompt.replace("When you have saved it, confirm this card so the requirement is recorded.","Save your personal credential. Never paste the value in chat. Then confirm here.");
 expect(personalSecretConfirmationHandoff(row,binding,personalSecretGuidance)).toBeDefined();
});
