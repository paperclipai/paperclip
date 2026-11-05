import {expect,it} from "vitest";
import {chromium} from "@playwright/test";
import {personalSecretSetupURL} from "./external-personal-secret.js";
const origin="https://paperclip.example",path="/RUN/company/settings/secrets",definition="current-definition";
const body=`Open \`${path}?definition=${definition}\` → My secrets → PERSONAL_PUBLISHING_KEY → Set my value, then save. Please don't paste the key in chat. Morgan's PUBLISHING_API_KEY runtime reference is already configured.`;
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SECRET_ROUTE_CANARY!=="1")("admits the visible own-definition route from4716 and rejects unbound or unsafe routes",async()=>{
 const browser=await chromium.launch({headless:true,...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{}}),page=await browser.newPage();
 const render=async(text:string,html?:string)=>page.setContent(`<article id="comment-native"><p>Personal credential setup</p>${html??`<code>${text}</code>`}</article>`);
 try{
  await render(path+"?definition="+definition);
  expect(await personalSecretSetupURL(page,{body,commentId:"native"},origin,"RUN",definition,1000)).toBe(origin+path+"?definition="+definition);
  await render("",`<a href="${path}?definition=${definition}">My secrets</a>`);
  expect(await personalSecretSetupURL(page,{body,commentId:"native"},origin,"RUN",definition,1000)).toBe(origin+path+"?definition="+definition);
  for(const route of ["/OTHER/company/settings/secrets?definition="+definition,"https://foreign.example"+path+"?definition="+definition,path+"?definition=other","/api/companies/current/secrets",""]){
   await render(route);expect(await personalSecretSetupURL(page,{body:body.replace(path+"?definition="+definition,route),commentId:"native"},origin,"RUN",definition,1000)).toBeUndefined();
  }
  await render("",`<code hidden>${path}?definition=${definition}</code>`);
  expect(await personalSecretSetupURL(page,{body,commentId:"native"},origin,"RUN",definition,1000)).toBeUndefined();
  await render(path+"?definition="+definition);
  expect(await personalSecretSetupURL(page,{body:body+" Paste the publishing key here in chat.",commentId:"native"},origin,"RUN",definition,1000)).toBeUndefined();
  expect(await personalSecretSetupURL(page,{body},origin,"RUN",definition,1000)).toBeUndefined();
 }finally{await browser.close();}
});
