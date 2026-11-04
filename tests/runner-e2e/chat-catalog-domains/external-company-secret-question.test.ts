import { expect,it,vi } from "vitest";
import { questionSetToAskUserQuestionsPayload } from "../../../packages/shared/src/question-set.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const port=vi.hoisted(()=>({observation:{} as Record<string,unknown>}));
vi.mock("./external-support.js",async original=>({...await original<typeof import("./external-support.js")>(),observeExternal:async()=>port.observation}));
import { companySecretExternalCases,companySecretQuestionHandoff } from "./external-company-secret.js";
const binding={companyId:"company",issueId:"source",agentId:"ceo",userId:"person",runId:"initial"};
function question(){return {id:"question",companyId:"company",issueId:"source",sourceRunId:"initial",createdByAgentId:"ceo",addresseeUserId:"person",resolverPolicy:"human_only",continuationPolicy:"wake_assignee",kind:"ask_user_questions",status:"pending",payload:questionSetToAskUserQuestionsPayload({schema:"paperclip.question_set.v1",description:"Use secure Settings Secrets to add the deployment credential, then bind its reference in Morgan's environment as DEPLOYMENT_API_KEY. Never paste the key in chat.",questions:[{id:"saved",prompt:"Have you saved and bound the deployment key for Morgan?",answerMode:"single_select",required:true,options:[{id:"yes",label:"Saved and bound for Morgan"},{id:"later",label:"Not yet"}]}]})};}
it("admits a bound secure company-entry confirmation",()=>expect(companySecretQuestionHandoff(question(),binding)).toMatchObject({interactionId:"question",optionId:"yes"}));
it.each(["key","owner","run","actor","company","source","unsafe chat","text value"])("rejects %s",fault=>{const row=question();
 if(fault==="key")row.payload.questionSet!.description=row.payload.questionSet!.description!.replace("DEPLOYMENT_API_KEY","OTHER_API_KEY");
 if(fault==="owner")row.addresseeUserId="other";
 if(fault==="run")row.sourceRunId="other";
 if(fault==="actor")row.createdByAgentId="other";
 if(fault==="company")row.companyId="other";
 if(fault==="source")row.issueId="other";
 if(fault==="unsafe chat")row.payload.questionSet!.description+=" Paste the deployment key here in chat.";
 if(fault==="text value")row.payload.questionSet!.questions[0]!.customAnswer={enabled:true};
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();});

it("actual company act admits its safe question before private human entry",async()=>{
 const query="Add our deployment API key so Morgan can use it.",run={id:"initial",companyId:"company",agentId:"ceo",runtimeMode:"native",status:"succeeded",contextSnapshot:{issueId:"source",commentId:"human"}};
 port.observation={companyId:"company",phaseReplies:[],links:[],interactions:[question()]};
 let reached=false;
 const ctx={observationDeadlineAt:Date.now()+450000,scenario:{query},input:{fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{get:async(path:string)=>{
 if(path.endsWith("/comments?order=asc"))return [{id:"human",companyId:"company",issueId:"source",authorUserId:"person",body:query}];
 if(path.endsWith("/secrets")){reached=true;throw Error("NEXT_REAL_HUMAN_PHASE");}throw Error("Unexpected read");
 }}},refreshIssue:async()=>{},issue:()=>({id:"source",companyId:"company",conversationState:"waiting"}),allRuns:async()=>[run]} as unknown as ChatCatalogContext;
 await expect(companySecretExternalCases[0]!.act!(ctx,{currentPersonId:"person"})).rejects.toThrow("NEXT_REAL_HUMAN_PHASE");expect(reached).toBe(true);
});
