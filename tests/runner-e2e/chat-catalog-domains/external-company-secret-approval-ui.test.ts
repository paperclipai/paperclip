import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { acceptCompanySecretBindingApproval } from "./external-company-secret.js";
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("submits the visible intended binding card and checks its real human response receipt", async () => {
 const browser=await chromium.launch({headless:true,...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{}});
 const payload={version:1,prompt:"Bind Deployment API key to Morgan as env.DEPLOYMENT_API_KEY?"};
 const marker={interactionId:"approval",proposalId:"proposal",sourceRunId:"second",initialRunId:"first",userId:"person",secretId:"secret",targetAgentId:"morgan",configPath:"env.DEPLOYMENT_API_KEY",payloadHash:createHash("sha256").update(JSON.stringify(payload)).digest("hex"),humanInputId:"saved",humanInputKind:"comment" as const};
 try{for(const scenario of ["accepted","wrong person","failed POST"]){
  const page=await browser.newPage();let posts=0;
  await page.route("**/*",async route=>{
   if(route.request().method()==="POST"){posts++;expect(new URL(route.request().url()).pathname).toBe("/api/issues/source/interactions/approval/accept");return route.fulfill({status:scenario==="failed POST"?403:200,contentType:"application/json",body:JSON.stringify({id:"approval",companyId:"company",issueId:"source",status:"accepted",resolvedByUserId:scenario==="wrong person"?"other":"person",payload})});}
   await route.fulfill({contentType:"text/html; charset=utf-8",body:'<section data-testid="task-chat-interaction" id="interaction-approval">Deployment API key Morgan env.DEPLOYMENT_API_KEY<button onclick="fetch(\'/api/issues/source/interactions/approval/accept\',{method:\'POST\'})">Create binding</button></section>'});
  });
  await page.goto("http://127.0.0.1:3300/RUN/chat");
  const action=acceptCompanySecretBindingApproval(page,"company","source",marker,()=>1000);
  if(scenario==="accepted")await action;else await expect(action).rejects.toThrow();
  expect(posts).toBe(1);await page.close();
 }}finally{await browser.close();}
},15000);
