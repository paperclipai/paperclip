import {expect,it} from "vitest";
import {chromium} from "@playwright/test";
import {personalSecretSetupURL,personalSecretGuidance} from "./external-personal-secret.js";
const origin="https://paperclip.example",chat=origin+"/RUN/chat",settings="/RUN/company/settings",secrets=settings+"/secrets",definition="6263be21-6958-4e2b-a76a-f0e20331245c";
const body=`I can't set a personal credential for you; never share it in chat. Open Settings → Secrets at \`/company/settings/secrets\`. Under My secrets, find PERSONAL_PUBLISHING_KEY (definition \`${definition}\`) and choose Set my value. Enter the publishing credential there and save.`;
const markup=`<p>Open Settings → Secrets at <code>/company/settings/secrets</code>.</p><p>Under My secrets, find PERSONAL_PUBLISHING_KEY (definition <code>${definition}</code>) and choose Set my value.</p>`;
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY!=="1")("discovers the current Personal UI route independently of the5169 inline hint and rejects unbound alternatives",async()=>{
 expect(personalSecretGuidance(body)).toBe(true);
 const browser=await chromium.launch({headless:true,...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{}}),page=await browser.newPage();
 const scenarios=[
  {name:"actual-style Account navigation",accepted:true},
  {name:"missing menu",missing:true},
  {name:"hidden menu",hidden:true},
  {name:"wrong company Settings",settings:"/OTHER/company/settings"},
  {name:"foreign Secrets",secrets:"https://foreign.example/company/settings/secrets"},
  {name:"wrong definition",body:body.replace(definition,"other-definition"),markup:markup.replace(definition,"other-definition")},
  {name:"foreign anchor",extra:'<a href="https://foreign.example">Setup</a>'},
  {name:"anchored hint",markup:markup.replace('<code>/company/settings/secrets</code>','<a href="/company/settings/secrets"><code>/company/settings/secrets</code></a>')},
  {name:"other bare path",body:body.replace('/company/settings/secrets','/OTHER/company/settings/secrets'),markup:markup.replace('/company/settings/secrets','/OTHER/company/settings/secrets')},
  {name:"unsafe guidance",body:body+" Paste the key here in chat."},
  {name:"missing own entry",noEntry:true},
 ];
 try{for(const scenario of scenarios){
  const paths:string[]=[];await page.unroute("**/*");await page.route("**/*",async route=>{
   const path=new URL(route.request().url()).pathname;paths.push(path);
   const content=path===settings?`<aside><a href="${scenario.secrets??secrets}">Secrets</a></aside>`:path===secrets?`<button role="tab">My secrets</button>${scenario.noEntry?"":'<ul><li><code>PERSONAL_PUBLISHING_KEY</code><button>Set value</button></li></ul>'}`:`<article id="comment-native">${scenario.markup??markup}${scenario.extra??""}</article>${scenario.missing?"":`<aside><button ${scenario.hidden?"hidden":""} aria-label="Open account menu" onclick="document.querySelector('[data-flyout-options]').hidden=false">Person</button></aside><div data-flyout-options hidden><a href="${scenario.settings??settings}">Settings</a></div>`}`;
   await route.fulfill({contentType:"text/html; charset=utf-8",body:content});
  });await page.goto(chat);
  let proof:unknown;
  expect(await personalSecretSetupURL(page,{body:scenario.body??body,commentId:"native"},origin,"RUN",definition,1500,p=>{proof=p;}),scenario.name).toBe(scenario.accepted?origin+secrets:undefined);
  if(scenario.accepted){expect(proof).toMatchObject({advertisedHint:"/company/settings/secrets",observedNavigationRoute:origin+secrets,definitionId:definition,viaMySecrets:true});expect(paths).toEqual(["/RUN/chat",settings,secrets,"/RUN/chat"]);}
  expect(paths.some(p=>p.startsWith("/OTHER/")),scenario.name).toBe(false);expect(page.url(),scenario.name).toBe(chat);
 }}finally{await browser.close();}
},30000);
