import {createHash} from "node:crypto";
import {expect,type Page} from "@playwright/test";
import type {RequestConfirmationInteraction} from "../../../packages/shared/src/types/issue.js";
import {requestConfirmationPayloadSchema} from "../../../packages/shared/src/validators/issue.js";
import {chatCatalogHumanQuestionPolicies} from "../chat-catalog-contract.js";
import type {SecretQuestionBinding} from "./external-secret-question.js";
export const canonicalCompanySecretKey=(input:string)=>input.trim().toLowerCase().replace(/[^a-z0-9_.-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,120);
export function validCompanySecretMetadata(value:unknown):value is {name?:string;key?:string}{
 if(value===undefined)return true;
 if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>key!=="name"&&key!=="key"))return false;
 const metadata=value as {name?:unknown;key?:unknown};
 return Object.entries(metadata).every(([key,v])=>v===undefined||typeof v==="string"&&v.length>0&&v.length<=120&&v.trim()===v&&!/[\r\n=]|https?:\/\//i.test(v)&&!/(?:^|\s)(?:sk|pk|gh[pousr]|github_pat|xox[baprs])[-_]|[A-Za-z0-9]{32}/i.test(v)&&(key!=="key"||/^[a-zA-Z0-9_.-]+$/.test(v)));
}
export interface CompanyConfirmationBinding extends SecretQuestionBinding {canonicalCommentId:string}
export function companySecretConfirmationHandoff(value:unknown,b:CompanyConfirmationBinding,guidance:(text:string)=>boolean,status:"pending"|"accepted"="pending"){
 const row=value as Partial<RequestConfirmationInteraction>|undefined,p=row?.payload;
 if(!row?.id||row.kind!=="request_confirmation"||row.status!==status||row.companyId!==b.companyId||row.issueId!==b.issueId||row.sourceRunId!==b.runId||row.createdByAgentId!==b.agentId||row.createdByUserId||row.addresseeAgentId||(row.addresseeUserId!=null&&row.addresseeUserId!==b.userId)||!row.originCommentIds?.includes(b.canonicalCommentId)||!chatCatalogHumanQuestionPolicies(row)||(row.continuationPolicy!=="wake_assignee"&&row.continuationPolicy!=="wake_assignee_on_accept")||row.dismissedAt||!p||!requestConfirmationPayloadSchema.safeParse(p).success||p.target||p.toolAction||p.secretProposal||p.connectionAuthorization||p.qualityReview
  ||(status==="pending"?row.resolvedByUserId||row.resolvedByAgentId||row.result||row.resolvedAt:row.resolvedByUserId!==b.userId||row.resolvedByAgentId||row.result?.outcome!=="accepted"||row.result.resumeFailure||row.result.toolAction||row.result.secretProposal||!Number.isFinite(Date.parse(String(row.resolvedAt)))))return;
 const text=[row.title,p.prompt,p.detailsMarkdown,p.acceptLabel,p.rejectLabel].filter(Boolean).join("\n");
 if(!guidance(text)||!/\b(?:save|saved|set|entered)\b[^.!?\n]{0,100}\b(?:accept|confirm)\b/i.test(p.prompt)||!/^(?:Confirm|Accept|Done|Saved)$/i.test(p.acceptLabel??""))return;
 const names=[...p.prompt.matchAll(/\bname\s+(?:it|the secret)\s+["“]([^"”\n]{1,120})["”]/gi)],keys=[...p.prompt.matchAll(/\b(?:set\s+)?(?:secret\s+)?key\s+`([a-zA-Z0-9_.-]{1,120})`/gi)];
 if(names.length>1||keys.length>1||/\bname\s+(?:it|the secret)\b/i.test(p.prompt)&&names.length!==1||/\bset\s+(?:the\s+)?key\b/i.test(p.prompt)&&keys.length!==1||!validCompanySecretMetadata({name:names[0]?.[1],key:keys[0]?.[1]}))return;
 return {interactionId:row.id,continuationPolicy:row.continuationPolicy,createdAt:String(row.createdAt),payloadHash:createHash("sha256").update(JSON.stringify(p)).digest("hex"),acceptLabel:p.acceptLabel!,prompt:p.prompt,metadata:{name:names[0]?.[1],key:keys[0]?.[1]}};
}
export async function visibleCompanySecretConfirmationURL(page:Page,handoff:{prompt:string},origin:string,prefix:string,remaining:()=>number){
 const card=page.getByTestId("task-chat-composer-takeover"),prompt=card.getByText(handoff.prompt,{exact:true});
 await expect(prompt).toBeVisible({timeout:remaining()});await prompt.scrollIntoViewIfNeeded({timeout:remaining()});
 const text=await prompt.evaluate(node=>{
  const rect=node.getBoundingClientRect();
  if(!node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||rect.width<=0||rect.height<=0||rect.right<=0||rect.left>=innerWidth||rect.bottom<=0||rect.top>=innerHeight)throw new Error("Company confirmation is not visible");
  for(let p=node.parentElement;p;p=p.parentElement){const style=getComputedStyle(p),box=p.getBoundingClientRect();if(/hidden|clip/.test(style.overflowX)&&(rect.right<=box.left||rect.left>=box.right)||/hidden|clip/.test(style.overflowY)&&(rect.bottom<=box.top||rect.top>=box.bottom))throw new Error("Company confirmation is clipped");}
  return (node as HTMLElement).innerText;
 });
 if(text.replace(/\s+/g," ").trim()!==handoff.prompt.replace(/\s+/g," ").trim())throw new Error("Company confirmation visible text changed");
 const supported=(token:string)=>{try{const url=new URL(token,origin);return url.origin===origin&&url.pathname===`/${prefix}/company/settings/secrets`&&!url.username&&!url.password&&!url.search&&!url.hash?url.href:undefined;}catch{return;}};
 const tokens=text.match(/https?:\/\/[^\s`<>"')]+|(?<![\w/:])\/[^\s`<>"')]+/g)??[],urls=tokens.map(supported);
 if(!tokens.length||urls.some(url=>!url)||new Set(urls).size!==1)throw new Error("Company confirmation lacks its actual current-company route");
 for(const anchor of await card.locator("a[href]").all())if(!supported(await anchor.getAttribute("href")??""))throw new Error("Company confirmation contains a foreign setup link");
 return urls[0]!;
}
export function companySecretSaveMatches(secret:unknown,binding:{companyId:string;userId:string},handoff:{createdAt:string;metadata:{name?:string;key?:string}}){
 const row=secret as {id?:string;companyId?:string;scope?:string;status?:string;createdByUserId?:string;createdAt?:string;name?:string;key?:string}|undefined,createdAt=Date.parse(String(row?.createdAt)),cardAt=Date.parse(handoff.createdAt);
 return !!row?.id&&row.companyId===binding.companyId&&row.scope==="company"&&row.status==="active"&&row.createdByUserId===binding.userId&&Number.isFinite(createdAt)&&Number.isFinite(cardAt)&&createdAt>cardAt&&(!handoff.metadata.name||row.name===handoff.metadata.name)&&(!handoff.metadata.key||row.key===canonicalCompanySecretKey(handoff.metadata.key));
}
export async function acceptCompanySecretConfirmation(page:Page,issueId:string,handoff:{interactionId:string;acceptLabel:string;prompt:string;createdAt:string;metadata:{name?:string;key?:string}},save:{secret:unknown;binding:{companyId:string;userId:string}},remaining:()=>number){
 if(!companySecretSaveMatches(save.secret,save.binding,handoff))throw new Error("Company confirmation cannot precede its current-human secure save");
 const card=page.getByTestId("task-chat-composer-takeover");await expect(card.getByText(handoff.prompt,{exact:true})).toBeVisible({timeout:remaining()});
 const [response]=await Promise.all([page.waitForResponse(res=>new URL(res.url()).pathname===`/api/issues/${issueId}/interactions/${handoff.interactionId}/accept`&&res.request().method()==="POST",{timeout:remaining()}),card.getByRole("button",{name:handoff.acceptLabel,exact:true}).click({timeout:remaining()})]);
 if(!response.ok())throw new Error("Company secure-save acknowledgment failed");return response.json() as Promise<unknown>;
}
