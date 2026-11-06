import {expect,it} from "vitest";
import {chromium} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {acceptCompanySecretConfirmation,companySecretConfirmationHandoff,visibleCompanySecretConfirmationURL} from "./external-company-secret-confirmation.js";
import {deploymentSecretGuidance} from "./external-company-secret.js";
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY!=="1")("uses the actual visible route and one real confirmation POST only after a current-human save",async()=>{
 const ui=await readFile(new URL("../../../ui/src/components/IssueThreadInteractionCard.tsx",import.meta.url),"utf8");expect(ui).toContain("data-decision-prompt");expect(ui).toContain("onAcceptInteraction(interaction)");
 const browser=await chromium.launch({headless:true,...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{})});
 try{for(const fault of ["none","pre-save","foreign owner","hidden","foreign route","failed accept"]){
  const page=await browser.newPage();page.setDefaultTimeout(700);let posts=0;
  const prompt=`In Settings > Secrets (\`${fault==="foreign route"?"https://foreign.invalid/RUN/company/settings/secrets":"/RUN/company/settings/secrets"}\`), choose New secret and save the deployment key value, then accept this card. Do not paste it in chat. I will bind the secret to Morgan's environment.`;
  const row={id:"ack",companyId:"company",issueId:"source",kind:"request_confirmation",status:"pending",sourceRunId:"first",createdByAgentId:"ceo",originCommentIds:["human"],resolverPolicy:"anyone",requestedResolverPolicy:"anyone",effectiveResolverPolicy:"anyone",continuationPolicy:"wake_assignee",createdAt:"2026-11-04T13:29:00Z",payload:{version:1,prompt,acceptLabel:"Confirm",rejectLabel:"Request changes"}},binding={companyId:"company",userId:"person",agentId:"ceo",issueId:"source",runId:"first",canonicalCommentId:"human"};
  const handoff=companySecretConfirmationHandoff(row,binding,deploymentSecretGuidance)!;expect(handoff).toBeDefined();
  await page.route("**/*",async route=>{if(route.request().method()==="POST"){posts++;return route.fulfill({status:fault==="failed accept"?403:200,contentType:"application/json",body:JSON.stringify({...row,status:"accepted",resolvedByUserId:"person",resolvedAt:"2026-11-04T13:40:00Z",result:{version:1,outcome:"accepted"}})});}return route.fulfill({contentType:"text/html",body:`<section data-testid="task-chat-composer-takeover" ${fault==="hidden"?'style="display:none"':""}><div data-decision-prompt>${prompt.replaceAll("&","&amp;").replaceAll("<","&lt;")}</div><button onclick="fetch('/api/issues/source/interactions/ack/accept',{method:'POST'})">Confirm</button></section>`});});
  await page.goto("http://127.0.0.1:3300/RUN/chats/ceo");const remaining=()=>700;
  const saved=fault==="pre-save"?undefined:{id:"secret",companyId:"company",scope:"company",status:"active",createdByUserId:fault==="foreign owner"?"other":"person",createdAt:"2026-11-04T13:35:00Z",name:"Deployment API key",key:"deployment-api-key"};
  const act=async()=>{const url=await visibleCompanySecretConfirmationURL(page,handoff,"http://127.0.0.1:3300","RUN",remaining);expect(url).toBe("http://127.0.0.1:3300/RUN/company/settings/secrets");return acceptCompanySecretConfirmation(page,"source",handoff,{secret:saved,binding},remaining);};
  if(fault==="none"){const accepted=await act();expect(companySecretConfirmationHandoff(accepted,binding,deploymentSecretGuidance,"accepted")).toBeDefined();expect(posts).toBe(1);}else{await expect(act()).rejects.toThrow();expect(posts).toBe(fault==="failed accept"?1:0);}
  await page.close();
 }}finally{await browser.close();}
},15000);
