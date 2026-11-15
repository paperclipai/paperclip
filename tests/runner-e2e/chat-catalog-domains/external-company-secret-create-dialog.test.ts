import {canonicalCompanySecretKey,validCompanySecretMetadata} from "./external-company-secret-confirmation.js";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { stripTypeScriptTypes } from "node:module";
import { expect, it } from "vitest";

it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY !== "1")("waits for the actual company create form to close while its details sheet stays open", async () => {
  const source = await readFile(new URL("./external-private-browser-worker.ts", import.meta.url), "utf8");
  const start = source.indexOf('    if(input.mode === "company-secret-create"){');
  const end = source.indexOf('    if (input.mode === "gateway-token-rotation")', start);
  expect(start >= 0 && end > start).toBe(true);
  const code = stripTypeScriptTypes(`async function operation(input:any,page:any){${source.slice(start, end)}}`);
  const operation = new Function("validCompanySecretMetadata","canonicalCompanySecretKey",`${code};return operation`)(validCompanySecretMetadata,canonicalCompanySecretKey) as (input: unknown, page: Page) => Promise<{ secretId: string; storageClean: boolean }>;
  const ui = await readFile(new URL("../../../ui/src/pages/Secrets.tsx", import.meta.url), "utf8");
  for (const anchor of ['ariaLabel="Who provides the value"', 'title: "Organization"', 'htmlFor="new-secret-name">Name</label>', 'htmlFor="new-secret-value">Value</label>', 'htmlFor="new-secret-vault">Stored in</label>', 'aria-expanded={createMoreOpen}', 'More options', ': "Create secret"}']) expect(ui).toContain(anchor);
  expect(ui).toContain('{secretValueProvider === "user" ? "Environment variable" : "Key"}');
  expect(ui).toContain("setCreateOpen(false)");
  expect(ui).toContain("setDetailSelection(result.item.id)");
  const browser = await chromium.launch({ headless: true, ...(process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE } : {}) });
  const companyId = "11111111-1111-4111-8111-111111111111", secretId = "22222222-2222-4222-8222-222222222222";
  try {
    for (const scenario of ["created", "requested metadata", "several vaults", "wrong stored metadata", "wrong storage", "failed POST", "missing form", "retired form"]) {
      const page = await browser.newPage(); page.setDefaultTimeout(700);
      const companyMetadata=scenario==="requested metadata"||scenario==="wrong stored metadata"?{name:"Deployment API Key",key:"DEPLOYMENT_API_KEY"}:undefined,expectedName=companyMetadata?.name??"Deployment API key";
      await page.route("**/*", async route => {
        if (route.request().method() === "POST") {const posted=route.request().postDataJSON();return route.fulfill({ status: scenario === "failed POST" ? 400 : 201, contentType: "application/json", body: JSON.stringify({ id:secretId,companyId,name:posted.name,key:scenario==="wrong stored metadata"?"other-key":canonicalCompanySecretKey(posted.key),scope:"company",status:"active",provider:scenario==="wrong storage"?"aws_secrets_manager":"local_encrypted" }) });}
        const vaults=scenario==="several vaults"?`<label for="new-secret-vault">Stored in</label><select id="new-secret-vault"><option value="aws_secrets_manager:cfg-1">AWS (default)</option><option value="local_encrypted:">Paperclip encrypted</option></select>`:"";
        const form=scenario==="retired form"?`<section id="create" role="dialog" aria-labelledby="create-title" hidden><h2 id="create-title">Create secret</h2><label for="new-secret-name">Name</label><input id="new-secret-name"><label for="new-secret-provider">Provider</label><select id="new-secret-provider"><option value="local_encrypted">Encrypted</option></select><label for="new-secret-value">Value</label><textarea id="new-secret-value"></textarea><button>Create secret</button></section>`:`<section id="create" role="dialog" aria-labelledby="create-title" hidden><h2 id="create-title">New secret</h2><label for="new-secret-name">Name</label><input id="new-secret-name"><p>Who provides the value</p><div role="radiogroup" aria-label="Who provides the value"><button role="radio" aria-checked="false" onclick="window.org=true;this.setAttribute('aria-checked','true')">Organization One value, shared by every agent you choose.</button><button role="radio" aria-checked="false">Each user Every member adds their own under My secrets.</button></div><label for="new-secret-value">Value</label><textarea id="new-secret-value"></textarea>${vaults}<button aria-expanded="false" aria-controls="new-secret-more" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#new-secret-more').hidden=false">More options</button><div id="new-secret-more" hidden><label for="new-secret-key">Key</label><input id="new-secret-key" oninput="window.keyDirty=true"></div><button onclick="const vault=document.querySelector('#new-secret-vault');if(!window.org||vault&&!vault.value.startsWith('local_encrypted:'))return;const name=document.querySelector('#new-secret-name').value;fetch('/api/companies/${companyId}/secrets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,key:window.keyDirty?document.querySelector('#new-secret-key').value:name.toLowerCase().replaceAll(' ','-')})}).then(r=>{if(r.status===201){document.querySelector('#create').remove();document.querySelector('#details').hidden=false}})">Create secret</button></section>`;
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `<button onclick="${scenario === "missing form" ? "" : "document.querySelector('#create').hidden=false"}">New secret</button>${form}<section id="details" role="dialog" aria-labelledby="details-title" hidden><h2 id="details-title">${expectedName}</h2></section>` });
      });
      const result = operation({ mode: "company-secret-create", companyId, setupURL: "http://127.0.0.1:3300/RUN/company/settings/secrets", credential: "synthetic-private-value",companyMetadata }, page);
      if (scenario === "created"||scenario==="requested metadata"||scenario==="several vaults") {
        expect(await result).toMatchObject({ secretId, storageClean: true,...(companyMetadata?{requestedCompanyName:"Deployment API Key",requestedCompanyKey:"DEPLOYMENT_API_KEY",savedCompanyName:"Deployment API Key",savedCompanyKey:"deployment_api_key"}:{}) });
        expect(await page.getByRole("dialog", { name: expectedName, exact: true }).isVisible()).toBe(true);
      } else await expect(result).rejects.toThrow();
      await page.close();
    }
  } finally { await browser.close(); }
}, 15000);
it("admits canonical Company metadata only through the actual closed receipt guard",async()=>{
 const source=await readFile(new URL("./external-private-browser.ts",import.meta.url),"utf8"),start=source.indexOf("    if (receipt.processIsolation"),end=source.indexOf('    if (input.mode === "gateway-token-rotation")',start);
 expect(start>=0&&end>start).toBe(true);
 const code=stripTypeScriptTypes(`function validate(input:any,receipt:any){${source.slice(start,end)};return receipt;}`),validate=new Function("validCompanySecretMetadata","canonicalCompanySecretKey",`${code};return validate`)(validCompanySecretMetadata,canonicalCompanySecretKey) as (input:unknown,receipt:unknown)=>unknown;
 const input={mode:"company-secret-create",companyMetadata:{name:"Deployment API Key",key:"DEPLOYMENT_API_KEY"}},receipt={processIsolation:true,testRunnerAttached:false,tracingEnabled:false,videoEnabled:false,apiStepRecorder:false,secretUiVisible:true,humanSubmittedSecurely:true,storageClean:true,requestedCompanyName:"Deployment API Key",requestedCompanyKey:"DEPLOYMENT_API_KEY",savedCompanyName:"Deployment API Key",savedCompanyKey:"deployment_api_key"};
 expect(validate(input,receipt)).toBe(receipt);
 for(const bad of [{...receipt,savedCompanyKey:"other"},{...receipt,requestedCompanyName:"different"},{...receipt,humanSubmittedSecurely:false},{...receipt,privateValue:"not permitted"}])expect(()=>validate(input,bad)).toThrow();
 expect(()=>validate({mode:"personal-secret-create"},receipt)).toThrow();
});
