import type {Page} from "@playwright/test";
export async function visibleSecretSettingsURL(page:Page,reply:{body:string;commentId?:string},origin:string,prefix:string,timeout:number,definitionId?:string){
 if(!reply.commentId)return;
 const comment=page.locator(`[id=${JSON.stringify(`comment-${reply.commentId}`)}]`);
 await comment.waitFor({state:"visible",timeout});
 const displayed=await comment.evaluate(root=>{
  const shown=(node:Element)=>{for(let element:Element|null=node;element;element=element.parentElement){const style=getComputedStyle(element);if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||Number(style.opacity)===0)return false;}return true;};
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),parts:string[]=[];
  for(let node=walker.nextNode();node;node=walker.nextNode())if(node.parentElement&&shown(node.parentElement)&&!node.parentElement.closest("a[href]"))parts.push(node.textContent??"");
  return {text:parts.join("\n"),links:Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(shown).map(node=>node.href)};
 },undefined,{timeout});
 const supported=(candidate:string)=>{try{const url=new URL(candidate,origin);return url.origin===origin&&url.pathname===`/${prefix}/company/settings/secrets`&&!url.username&&!url.password&&!url.hash&&(definitionId?Array.from(url.searchParams.keys()).every(key=>key==="definition")&&url.searchParams.getAll("definition").length<=1&&(!url.searchParams.has("definition")||url.searchParams.get("definition")===definitionId):!url.search)?url.href:undefined;}catch{return;}};
 const routes=(text:string)=>(text.match(/https?:\/\/[^\s`<>"']+|(?<![\w/:])\/[^\s`<>"']+/g)??[]).map(value=>value.replace(/[.,;!?\])}]+$/,"")).map(supported).filter((value):value is string=>!!value);
 return routes(reply.body).find(route=>displayed.links.some(link=>supported(link)===route)||routes(displayed.text).includes(route));
}
