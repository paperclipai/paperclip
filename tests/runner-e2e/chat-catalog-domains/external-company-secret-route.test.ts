import {expect,it} from "vitest";
import {chromium} from "@playwright/test";
import {companySecretSetupURL} from "./external-company-secret.js";
const origin="https://paperclip.example",route="/RUN/company/settings/secrets";
const body="I can't enter the key value myself — company secret values are board-only secure entry, and I won't ask you to paste a secret into chat.\n\nTo add it:\n1. Open `/RUN/company/settings/secrets`.\n2. Click **New secret**.\n3. Use name e.g. **Deployment API key**, env key **DEPLOYMENT_API_KEY**, and enter the deployment key value there.\n4. Save it, then tell me the name/key you used (not the value).\n\nOnce it exists I'll add a `DEPLOYMENT_API_KEY` secret reference to Morgan's agent environment and verify the reference is in place. Saving the secret only stores it; Morgan gets it on its next run after the binding.";
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY!=="1")("admits the actual4587 displayed inline route and rejects absent, foreign, cross-company or hidden routes in offline Chromium",async()=>{
 const browser=await chromium.launch({headless:true,...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{}}),page=await browser.newPage();
 const render=async(text:string,html?:string,id="native")=>{await page.setContent(`<article id="comment-${id}"><p>Use secure Settings Secrets for Morgan's deployment credential environment binding.</p>${html??`<code>${text}</code>`}</article>`);};
 try{
  await render(route);expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).toBe(origin+route);
  await render(route,`<p style="height:1500px">Ordinary reply context</p><code>${route}</code>`);expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).toBe(origin+route);
  for(const html of [`<code style="position:absolute;left:-9999px">${route}</code>`,`<details><summary>More</summary><code>${route}</code></details>`,`<code style="font-size:0">${route}</code>`,`<code style="color:transparent">${route}</code>`,`<code style="opacity:0.001">${route}</code>`,`<div style="overflow:hidden;height:1px"><p style="margin-top:200px"><code>${route}</code></p></div>`]){
   await render(route,html);expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000),html).toBeUndefined();
  }
  await render(route,`<a href="${origin+route}">Open Secrets</a>`);expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).toBe(origin+route);
  for(const target of ["/OTHER/company/settings/secrets","https://foreign.example"+route,"/api/companies/company/secrets"]){await render(target);expect(await companySecretSetupURL(page,{body:body.replace(route,target),commentId:"native"},origin,"RUN",1000)).toBeUndefined();}
  await render(route,`<a href="https://foreign.example${route}">${route}</a>`);expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).toBeUndefined();
  await render("No route");expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).toBeUndefined();
  for(const html of [`<code hidden>${route}</code>`,`<code style="opacity:0">${route}</code>`,`<span style="visibility:hidden"><code>${route}</code></span>`]){await render(route,html);expect(await companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).toBeUndefined();}
  await render(route,undefined,"other-actor");await expect(companySecretSetupURL(page,{body,commentId:"native"},origin,"RUN",1000)).rejects.toThrow();
  await render(route);expect(await companySecretSetupURL(page,{body:body.replace(route,"missing"),commentId:"native"},origin,"RUN",1000)).toBeUndefined();
  expect(await companySecretSetupURL(page,{body:`Open ${route}`,commentId:"native"},origin,"RUN",1000)).toBeUndefined();
  expect(await companySecretSetupURL(page,{body:body+" Paste the key here in chat.",commentId:"native"},origin,"RUN",1000)).toBeUndefined();
 }finally{await browser.close();}
},30000);
