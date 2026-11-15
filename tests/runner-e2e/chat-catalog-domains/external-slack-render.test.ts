import {expect,it} from "vitest";
import {chromium} from "@playwright/test";
import type {ChatCatalogContext} from "../chat-catalog-contract.js";
import {hasSlackLaunchRendering,renderSlackLaunchArtifact,type SlackLaunchRendering} from "./external-slack-render.js";
const valid=():SlackLaunchRendering=>({sha256:"actual-downloaded-hash",usableSignup:true,nodes:[{tag:"H1",role:null,text:"Acorn Notes",href:null,inNavigation:false,color:"rgb(0, 0, 0)",background:"rgb(255, 255, 255)"},{tag:"P",role:null,text:"A calm shared notebook for the whole research team.",href:null,inNavigation:false,color:"rgb(0, 0, 0)",background:"rgb(255, 255, 255)"}]});
it("requires an actually visible product heading, substantive content and usable signup",()=>{
 expect(hasSlackLaunchRendering(valid())).toBe(true);
 expect(hasSlackLaunchRendering({...valid(),nodes:[]})).toBe(false);
 expect(hasSlackLaunchRendering({...valid(),usableSignup:false})).toBe(false);
 expect(hasSlackLaunchRendering({...valid(),nodes:valid().nodes.filter(node=>node.tag!=="H1")})).toBe(false);
});
it.skipIf(process.env.PAPERCLIP_CHAT_EVAL_SLACK_RENDER_CANARY!=="1")("rejects actual hidden/blank bytes and inert signup controls in isolated offline Chromium",async()=>{
 const browser=await chromium.launch({headless:true,...process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?{executablePath:process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE}:{}}),context=await browser.newContext(),page=await context.newPage(),ctx={input:{page}} as unknown as ChatCatalogContext;
 const body='<html><body><main><h1>Acorn Notes</h1><p>A calm shared notebook for the whole research team.</p><a href="#signup">Join the list</a><section id="signup"><p>Join our research notebook early access list.</p></section></main></body></html>';
 try{for(const [html,expected] of [[body,true],[body.replace('<main>','<main style="display:none">'),false],[body.replace('<h1>','<h1 style="opacity:0">'),false],[body.replace('href="#signup"','href="javascript:void(0)"'),false],[body.replace('id="signup"','id="unrelated"'),false]] as const)expect(hasSlackLaunchRendering(await renderSlackLaunchArtifact(ctx,html))).toBe(expected);}
 finally{await context.close();await browser.close();}
},30000);
