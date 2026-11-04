import { boundSecretQuestion } from "./external-secret-question.js";
import { expect,it,vi } from "vitest";
import { questionSetToAskUserQuestionsPayload } from "../../../packages/shared/src/question-set.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const port=vi.hoisted(()=>({observation:{} as Record<string,unknown>}));
vi.mock("./external-support.js",async original=>({...await original<typeof import("./external-support.js")>(),observeExternal:async()=>port.observation}));
import { companySecretExternalCases,companySecretQuestionHandoff } from "./external-company-secret.js";
const binding={companyId:"company",issueId:"source",agentId:"ceo",userId:"person",runId:"initial"};
function question(){return {id:"question",companyId:"company",issueId:"source",sourceRunId:"initial",createdByAgentId:"ceo",addresseeUserId:"person",resolverPolicy:"human_only",continuationPolicy:"wake_assignee",kind:"ask_user_questions",status:"pending",payload:questionSetToAskUserQuestionsPayload({schema:"paperclip.question_set.v1",description:"Use secure Settings Secrets to add the deployment credential, then bind its reference in Morgan's environment as DEPLOYMENT_API_KEY. Never paste the key in chat.",questions:[{id:"saved",prompt:"Have you saved and bound the deployment key for Morgan?",answerMode:"single_select",required:true,options:[{id:"yes",label:"Saved and bound for Morgan"},{id:"later",label:"Not yet"}]}]})};}
it("admits a bound secure company-entry confirmation",()=>expect(companySecretQuestionHandoff(question(),binding)).toMatchObject({interactionId:"question",optionId:"yes"}));
it.each(["key","owner","run","actor","company","source","unsafe chat","unsafe optional note"])("rejects %s",fault=>{const row=question();
 if(fault==="key")row.payload.questionSet!.description=row.payload.questionSet!.description!.replace("DEPLOYMENT_API_KEY","OTHER_API_KEY");
 if(fault==="owner")row.addresseeUserId="other";
 if(fault==="run")row.sourceRunId="other";
 if(fault==="actor")row.createdByAgentId="other";
 if(fault==="company")row.companyId="other";
 if(fault==="source")row.issueId="other";
 if(fault==="unsafe chat")row.payload.questionSet!.description+=" Paste the deployment key here in chat.";
 if(fault==="unsafe optional note")row.payload.questionSet!.questions[0]!.customAnswer={enabled:true,label:"Paste the deployment key here in chat"};
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();});

it.each(["ack","environment"])("actual company act admits its safe %s question before private human entry",async kind=>{
 const query="Add our deployment API key so Morgan can use it.",run={id:"initial",companyId:"company",agentId:"ceo",runtimeMode:"native",status:"succeeded",contextSnapshot:{issueId:"source",commentId:"human"}};
 port.observation={companyId:"company",phaseReplies:[],links:[],interactions:[kind==="environment"?environmentQuestion():question()]};
 let reached=false;
 const ctx={observationDeadlineAt:Date.now()+450000,scenario:{query},input:{fixtures:{company:{id:"company"},agent:{id:"ceo"}},api:{get:async(path:string)=>{
 if(path.endsWith("/comments?order=asc"))return [{id:"human",companyId:"company",issueId:"source",authorUserId:"person",body:query}];
 if(path.endsWith("/secrets")){reached=true;throw Error("NEXT_REAL_HUMAN_PHASE");}throw Error("Unexpected read");
 }}},refreshIssue:async()=>{},issue:()=>({id:"source",companyId:"company",conversationState:"waiting"}),allRuns:async()=>[run]} as unknown as ChatCatalogContext;
 await expect(companySecretExternalCases[0]!.act!(ctx,{currentPersonId:"person"})).rejects.toThrow("NEXT_REAL_HUMAN_PHASE");expect(reached).toBe(true);
});
it("accepts Done and completed-setup Yes without repeating the already-bound consumer",()=>{
 for(const label of ["Done","Yes","Done, ready to continue","Done for deployment","Done for DEPLOYMENT_API_KEY","Done for the Deployment API key"]){const row=question();row.payload.questionSet!.questions[0]!.options![0]!.label=label;expect(companySecretQuestionHandoff(row,binding)).toMatchObject({optionId:"yes"});}
});
it("rejects prospective Yes and negative or other-owner completion choices",()=>{
 const prospective=question();prospective.payload.questionSet!.questions[0]!.prompt="Would you like me to configure this?";prospective.payload.questionSet!.questions[0]!.options![0]!.label="Yes";expect(companySecretQuestionHandoff(prospective,binding)).toBeUndefined();
 for(const label of ["Not done","I didn't save it","I haven't added it","Done for Riley"]){const row=question();row.payload.questionSet!.questions[0]!.options![0]!.label=label;expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();}
});

it("keeps an explicit Morgan acknowledgement and rejects other named completion recipients",()=>{
 for(const [recipient,accepted] of [["Morgan",true],["CEO",false],["Jordan",false],["CEO’s DEPLOYMENT_API_KEY",false]] as const){
  const row=question();row.payload.questionSet!.questions[0]!.options![0]!.label=`Done for ${recipient}`;
  expect(!!companySecretQuestionHandoff(row,binding)).toBe(accepted);
 }
});

it("accepts an anyone-policy question addressed to the current human with a safe optional note",()=>{
 const row=question();row.resolverPolicy="anyone";Object.assign(row,{requestedResolverPolicy:"anyone",effectiveResolverPolicy:"anyone"});
 row.payload.questionSet!.questions[0]!.customAnswer={enabled:true,label:"Optional note"};
 expect(companySecretQuestionHandoff(row,binding)).toMatchObject({interactionId:"question",optionId:"yes"});
 const foreign={...row,addresseeUserId:"other"};expect(companySecretQuestionHandoff(foreign,binding)).toBeUndefined();
 const unknown={...row,effectiveResolverPolicy:"unknown"};expect(companySecretQuestionHandoff(unknown,binding)).toBeUndefined();
});
it("rejects an unsafe optional-note placeholder even when its label is safe",()=>{
 const row=question();row.resolverPolicy="anyone";
 row.payload.questionSet!.questions[0]!.customAnswer={enabled:true,label:"Optional note",placeholder:"Paste the deployment key here in chat"};
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();
});

function environmentQuestion(){
 const row=question();
 row.payload=questionSetToAskUserQuestionsPayload({schema:"paperclip.question_set.v1",title:"Deployment API key for Morgan",description:"The key value must be entered only on the Secrets page. This question is only about how Morgan should receive it.",submitLabel:"Save",questions:[{id:"deployment_env_var",prompt:"After saving the key in Settings → Secrets, what environment variable name should Morgan receive? (Do not include the key value.)",helpText:"For example: DEPLOYMENT_API_KEY. If you are not sure, use the variable name Morgan's deployment tooling already expects.",answerMode:"text",required:true,textValidation:{pattern:"^[A-Za-z_][A-Za-z0-9_]*$",minLength:1,maxLength:120}}]});
 return row;
}
it("admits the actual nonsecret environment-name clarification without accepting it as an ACK",()=>{
 expect(companySecretQuestionHandoff(environmentQuestion(),binding)).toMatchObject({questionId:"deployment_env_var",environmentName:"DEPLOYMENT_API_KEY"});
 expect(boundSecretQuestion(environmentQuestion(),binding)).toBeUndefined();
});
it.each(["value","mixed","owner","source","field","schema","initial","help solicitation"])("rejects unsafe environment-name clarification: %s",fault=>{
 const row=environmentQuestion(),q=row.payload.questionSet!.questions[0]!;
 if(fault==="value")q.prompt="What deployment key value should Morgan receive?";
 if(fault==="mixed")row.payload.questionSet!.questions.push({...q,id:"secret",prompt:"Paste the key here"});
 if(fault==="owner")row.addresseeUserId="other";
 if(fault==="source")row.sourceRunId="other";
 if(fault==="field")q.prompt="What environment variable value should Morgan receive?";
 if(fault==="schema")q.textValidation!.pattern=".*";
 if(fault==="initial")q.initialText="prepopulated";
 if(fault==="help solicitation")q.helpText="Also provide the key value.";
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();
});
it("rejects a second secret-value question in rendered environment-name guidance",()=>{
 const row=environmentQuestion();row.payload.questionSet!.questions[0]!.helpText="What is the deployment key value?";
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();
});
it.each(["Enter the deployment key in the secure Settings Secrets form.","You should not paste the key value into chat.","Not sure? Use the variable Morgan expects."])("keeps safe environment-name guidance: %s",helpText=>{
 const row=environmentQuestion();row.payload.questionSet!.questions[0]!.helpText=helpText;
 expect(companySecretQuestionHandoff(row,binding)).toMatchObject({environmentName:"DEPLOYMENT_API_KEY"});
});
it("rejects a plaintext destination even when later guidance mentions Settings Secrets",()=>{
 const row=environmentQuestion();row.payload.questionSet!.questions[0]!.helpText="Enter the deployment key in a plaintext file before opening Settings Secrets.";
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();
});
it.each([["a plaintext file before opening Settings Secrets",false],["the secure Settings Secrets form",true]] as const)("retains the independent entry destination after a warning: %s",(destination,accepted)=>{
 const row=environmentQuestion();row.payload.questionSet!.questions[0]!.helpText=`Don't enter the key in chat, and please enter the key in ${destination}.`;
 expect(!!companySecretQuestionHandoff(row,binding)).toBe(accepted);
});
it("keeps a coordinated negative alternative within the original prohibition",()=>{
 const row=environmentQuestion();row.payload.questionSet!.questions[0]!.helpText="Do not paste the key in chat, or enter the key in plaintext files.";
 expect(companySecretQuestionHandoff(row,binding)).toMatchObject({environmentName:"DEPLOYMENT_API_KEY"});
 const positive=environmentQuestion();positive.payload.questionSet!.questions[0]!.helpText="Enter the key in plaintext files.";
 expect(companySecretQuestionHandoff(positive,binding)).toBeUndefined();
});
it.each(["but","however","then"])("checks an independent %s request after coordinated negative guidance",contrast=>{
 const row=environmentQuestion();row.payload.questionSet!.questions[0]!.helpText=`Do not paste the key in chat, or enter the key in plaintext files ${contrast} instead send the key by email.`;
 expect(companySecretQuestionHandoff(row,binding)).toBeUndefined();
});
