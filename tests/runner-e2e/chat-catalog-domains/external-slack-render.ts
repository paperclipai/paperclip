import {createHash} from "node:crypto";
import type {ChatCatalogContext} from "../chat-catalog-contract.js";
import {renderRuntimeArtifact,type RuntimeRenderedNode} from "./runtime-rendered-artifact.js";
export interface SlackLaunchRendering {sha256:string;nodes:RuntimeRenderedNode[];usableSignup:boolean}
export function hasSlackLaunchRendering(value:SlackLaunchRendering){
 return value.usableSignup&&value.nodes.some(node=>(node.tag==="H1"||node.role==="heading")&&/\bAcorn\s+Notes\b/i.test(node.text))&&value.nodes.some(node=>node.tag==="P"&&node.text.length>=20);
}
/** Independently retrieved bytes only. Both contexts have no authenticated
 * storage, scripts or network; no generated site can call back into the app. */
export async function renderSlackLaunchArtifact(ctx:ChatCatalogContext,html:string):Promise<SlackLaunchRendering>{
 const nodes=await renderRuntimeArtifact(ctx,html),browser=ctx.input.page.context().browser();if(!browser)throw new Error("Slack result rendering requires the existing browser");
 const preview=await browser.newContext({javaScriptEnabled:false});
 try{
  const page=await preview.newPage();await page.route("**/*",route=>route.abort());await page.setContent(html,{waitUntil:"domcontentloaded"});
  const usableSignup=await page.locator("a[href]").evaluateAll(elements=>{
   const visible=(element:Element)=>{const box=element.getBoundingClientRect();if(box.width<2||box.height<2||box.right<=0||box.left>=innerWidth)return false;for(let node:Element|null=element;node;node=node.parentElement){const css=getComputedStyle(node);if(css.display==="none"||css.visibility==="hidden"||Number(css.opacity)===0||css.pointerEvents==="none")return false;}return true;};
   if(elements.length>500)throw new Error("Slack launch navigation exceeds finite inspection bound");
   return elements.some(element=>{if(!visible(element)||element.getAttribute("aria-disabled")==="true"||!/join|sign.?up|subscribe|early access/i.test(element.textContent??""))return false;
    const href=element.getAttribute("href")??"";
    if(href.startsWith("#")){const target=document.getElementById(href.slice(1));return !!target&&visible(target)&&(target.textContent?.trim().length??0)>=15;}
    try{const url=new URL(href);return url.protocol==="https:"&&!url.username&&!url.password&&!!url.hostname;}catch{return false;}
   });
  });
  return {sha256:createHash("sha256").update(html).digest("hex"),nodes,usableSignup};
 }finally{await preview.close();}
}
