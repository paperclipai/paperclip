import {expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {canonicalCompanySecretKey,companySecretConfirmationHandoff,validCompanySecretMetadata} from "./external-company-secret-confirmation.js";
import {deploymentSecretGuidance,companyOperatorBindingRequested} from "./external-company-secret.js";
const prompt='I cannot store the deployment key value for you: only a human board operator can enter it. In Settings > Secrets (`/RUN/company/settings/secrets`), choose New secret, name it "Deployment API Key", set key `DEPLOYMENT_API_KEY`, save the value, then accept this card. Do not paste the key here. I will bind the saved secret to Morgan\'s environment.';
const binding={companyId:"company",issueId:"source",agentId:"ceo",userId:"person",runId:"first",canonicalCommentId:"human"};
function card(){return {id:"ack",companyId:"company",issueId:"source",kind:"request_confirmation",status:"pending",sourceRunId:"first",createdByAgentId:"ceo",originCommentIds:["human"],resolverPolicy:"anyone",requestedResolverPolicy:"anyone",effectiveResolverPolicy:"anyone",continuationPolicy:"wake_assignee",createdAt:"2026-11-04T13:29:00Z",payload:{version:1,prompt,acceptLabel:"Confirm",rejectLabel:"Request changes",detailsMarkdown:"",supersedeOnUserComment:false}};}
const guidance=(text:string)=>deploymentSecretGuidance(text)&&!companyOperatorBindingRequested(text);
it("admits the actual safe pending confirmation without pretending it has been answered",()=>{
 expect(companySecretConfirmationHandoff(card(),binding,guidance)).toMatchObject({interactionId:"ack",metadata:{name:"Deployment API Key",key:"DEPLOYMENT_API_KEY"}});
 expect(companySecretConfirmationHandoff(card(),binding,guidance,"accepted")).toBeUndefined();
 const ambiguous=card();ambiguous.payload.prompt=ambiguous.payload.prompt.replace("set key `DEPLOYMENT_API_KEY`","set key an unknown value");expect(companySecretConfirmationHandoff(ambiguous,binding,guidance)).toBeUndefined();
 expect(deploymentSecretGuidance("Only a human board operator can enter it.")).toBe(false);
});
it.each(["source","company","actor","recipient","effect","destination","resolved"])("rejects an unsafe or unbound secure-save ACK: %s",fault=>{
 const row=card();if(fault==="source")row.sourceRunId="other";if(fault==="company")row.companyId="other";if(fault==="actor")row.createdByAgentId="other";if(fault==="recipient")Object.assign(row,{addresseeUserId:"other"});if(fault==="effect")Object.assign(row.payload,{secretProposal:{proposalId:"other"}});if(fault==="destination")row.payload.prompt+=" Send the key by email.";if(fault==="resolved")Object.assign(row,{resolvedByUserId:"person"});
 expect(companySecretConfirmationHandoff(row,binding,guidance)).toBeUndefined();
});
it("requires an actual current-human successful acceptance and rejects injected effects",()=>{
 const accepted={...card(),status:"accepted",resolvedByUserId:"person",resolvedAt:"2026-11-04T13:40:00Z",result:{version:1,outcome:"accepted"}};
 expect(companySecretConfirmationHandoff(accepted,binding,guidance,"accepted")).toBeDefined();
 expect(companySecretConfirmationHandoff({...accepted,resolvedByUserId:"other"},binding,guidance,"accepted")).toBeUndefined();
 expect(companySecretConfirmationHandoff({...accepted,result:{...accepted.result,toolAction:{status:"executed"}}},binding,guidance,"accepted")).toBeUndefined();
});
it("keeps optional metadata bounded and matches the production canonical-key function",async()=>{
 expect(validCompanySecretMetadata(undefined)).toBe(true);expect(validCompanySecretMetadata({name:"Deployment API Key",key:"DEPLOYMENT_API_KEY"})).toBe(true);
 for(const value of [{key:"sk-"+"a".repeat(40)},{key:"other/key"},{name:"value\nmore"},{key:""},{key:"deployment",secretId:"foreign"}])expect(validCompanySecretMetadata(value)).toBe(false);
 const source=await readFile(new URL("../../../server/src/services/secrets.ts",import.meta.url),"utf8"),start=source.indexOf("export function normalizeSecretKey(input: string) {"),end=source.indexOf("\n}",start);
 const actual=new Function(source.slice(start,end+2).replace("export function normalizeSecretKey(input: string)","function normalizeSecretKey(input)")+";return normalizeSecretKey")() as (key:string)=>string;
 for(const key of ["DEPLOYMENT_API_KEY","deployment.api-key"])expect(canonicalCompanySecretKey(key)).toBe(actual(key));
});
