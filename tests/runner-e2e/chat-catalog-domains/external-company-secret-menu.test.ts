import {expect,it} from "vitest";
import {chromium} from "@playwright/test";
import {companySecretSetupURL,deploymentSecretGuidance} from "./external-company-secret.js";
const origin="https://paperclip.example",chat=origin+"/RUN/chat",settings="/RUN/company/settings",secrets=settings+"/secrets";
const body="Use Company settings → Secrets (company-prefixed `/company/settings/secrets`) via New secret to enter the deployment key on that page (not in chat). After saving, I will bind the secret reference to Morgan's environment.";
const directions='<strong>Company settings → Secrets</strong> (company-prefixed <code>/company/settings/secrets</code>) via <strong>New secret</strong>';
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY!=="1")("uses actual visible company menu links and preserves the bound chat without accepting unsafe alternatives",async()=>{
 expect(deploymentSecretGuidance(body)).toBe(true);
 const browser=await chromium.launch({headless:true,...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{}}),page=await browser.newPage();
 const scenarios=[
  {name:"ordinary menu",settings,secrets,accepted:true},
  {name:"company switcher menu",settings,secrets,accepted:true,menu:true},
  {name:"separate Markdown emphasis",settings,secrets,accepted:true,body:"Open **Settings** then **Secrets**, **New secret**. Enter the deployment key in the secure form. After saving, I will bind its secret reference to Morgan's environment.",markup:"<strong>Settings</strong> then <strong>Secrets</strong>, <strong>New secret</strong>"},
  {name:"no route example",settings,secrets,accepted:true,body:"Open Settings then Secrets, New secret. Enter the deployment key in the secure form. After saving, I will bind its secret reference to Morgan's environment.",markup:"Settings then Secrets, New secret"},
  {name:"plain directions",settings,secrets,accepted:true,markup:"Company settings → Secrets (company-prefixed /company/settings/secrets) via New secret"},
  {name:"missing Settings",settings:"",secrets},
  {name:"hidden Settings",settings,secrets,hidden:true},
  {name:"wrong company Settings",settings:"/OTHER/company/settings",secrets},
  {name:"foreign Settings",settings:"https://foreign.example"+settings,secrets},
  {name:"wrong company Secrets",settings,secrets:"/OTHER/company/settings/secrets"},
  {name:"foreign Secrets",settings,secrets:"https://foreign.example"+secrets},
  {name:"explicit bad reply URL",settings,secrets,extra:`<a href="https://foreign.example${secrets}">Secrets</a>`},
  {name:"anchored symbolic fragment",settings,secrets,markup:directions.replace('<code>','<a href="/company/settings/secrets"><code>').replace('</code>','</code></a>')},
  {name:"hidden instructions",settings,secrets,throws:true,markup:`<div hidden>${directions}</div>`},
 ];
 try{
  for(const scenario of scenarios){
   const clicked:string[]=[];
   await page.unroute("**/*");await page.route("**/*",async route=>{
    const path=new URL(route.request().url()).pathname;
    const content=path===settings?`<aside><nav><a href="${scenario.secrets}">Secrets</a></nav></aside>`:path===secrets?'<h1>Secrets</h1><button>New secret</button>':`<article id="comment-native">${scenario.markup??directions}${scenario.extra??""}</article><aside><nav>${scenario.menu?`<button aria-label="Open Runner organization switcher" onclick="document.querySelector('[role=menu]').hidden=false">Organization</button><div role="menu" hidden><a role="menuitem" href="${scenario.settings}">Settings</a></div>`:scenario.settings?`<a ${scenario.hidden?"hidden":""} href="${scenario.settings}">Settings</a>`:""}</nav></aside>`;
    if(path!=="/RUN/chat")clicked.push(path);
    await route.fulfill({contentType:"text/html; charset=utf-8",body:content});
   });
   await page.goto(chat);
   if(scenario.throws)await expect(companySecretSetupURL(page,{body:scenario.body??body,commentId:"native"},origin,"RUN",1500),scenario.name).rejects.toThrow();
   else expect(await companySecretSetupURL(page,{body:scenario.body??body,commentId:"native"},origin,"RUN",1500),scenario.name).toBe(scenario.accepted?origin+secrets:undefined);
   expect(page.url(),scenario.name).toBe(chat);
   if(scenario.accepted)expect(clicked).toEqual([settings,secrets]);
   else expect(clicked.some(path=>path.startsWith("/OTHER/")),scenario.name).toBe(false);
  }
 }finally{await browser.close();}
},30000);
