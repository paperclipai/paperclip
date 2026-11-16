import type {Page,Locator} from "@playwright/test";
export async function visibleSecretSettingsURL(page:Page,reply:{body:string;commentId?:string},origin:string,prefix:string,timeout:number,definitionId?:string){
 if(!reply.commentId)return;
 const comment=page.locator(`[id=${JSON.stringify(`comment-${reply.commentId}`)}]`);
 await comment.waitFor({state:"visible",timeout});
 const supported=(candidate:string)=>{try{const url=new URL(candidate,origin);return url.origin===origin&&url.pathname===`/${prefix}/company/settings/secrets`&&!url.username&&!url.password&&!url.hash&&(definitionId?Array.from(url.searchParams.keys()).every(key=>key==="definition")&&url.searchParams.getAll("definition").length<=1&&(!url.searchParams.has("definition")||url.searchParams.get("definition")===definitionId):!url.search)?url.href:undefined;}catch{return;}};
 const routes=(text:string)=>(text.match(/https?:\/\/[^\s`<>"']+|(?<![\w/:])\/[^\s`<>"']+/g)??[]).map(value=>value.replace(/[.,;!?\])}]+$/,"")).map(supported).filter((value):value is string=>!!value);
 const ordinaryScroll=async(node:Locator)=>{
  if(!await node.isVisible())return;
  const reachable=await node.evaluate(node=>{
   const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
   if(/absolute|fixed/.test(style.position)&&(rect.right<=0||rect.left>=innerWidth||rect.bottom<=0||rect.top>=innerHeight))return false;
   for(let parent=node.parentElement;parent;parent=parent.parentElement){
    const style=getComputedStyle(parent),box=parent.getBoundingClientRect();
    if(/hidden|clip/.test(style.overflowX)&&(rect.right<=box.left||rect.left>=box.right))return false;
    if(/hidden|clip/.test(style.overflowY)&&(rect.bottom<=box.top||rect.top>=box.bottom))return false;
   }
   return true;
  });
  if(reachable)await node.scrollIntoViewIfNeeded({timeout});
 };
 const tokens=(reply.body.match(/https?:\/\/[^\s`<>"']+|(?<![\w/:])\/[^\s`<>"']+/g)??[]).map(value=>value.replace(/[.,;!?\])}]+$/,""));
 for(const token of tokens.filter(token=>!!supported(token))){
  const node=comment.getByText(token,{exact:false}).last();
  if(await node.count())await ordinaryScroll(node);
 }
 for(const anchor of await comment.locator("a[href]").all())if(supported(await anchor.getAttribute("href")??""))await ordinaryScroll(anchor);
 const displayed=await comment.evaluate(root=>{
  const shown=(node:Element,rect:DOMRect)=>{
   const leaf=getComputedStyle(node);if(parseFloat(leaf.fontSize)<=0||leaf.color==="transparent"||/rgba\([^)]*,\s*0\)/.test(leaf.color))return false;
   let opacity=1;
   for(let element:Element|null=node;element;element=element.parentElement){
    const style=getComputedStyle(element);opacity*=Number(style.opacity);
    if(style.display==="none"||style.visibility==="hidden"||style.visibility==="collapse"||opacity<0.05)return false;
    if(element instanceof HTMLDetailsElement&&!element.open&&!element.querySelector(":scope > summary")?.contains(node))return false;
    const box=element.getBoundingClientRect();
    if(/hidden|clip/.test(style.overflowX)&&(rect.right<=box.left||rect.left>=box.right))return false;
    if(/hidden|clip/.test(style.overflowY)&&(rect.bottom<=box.top||rect.top>=box.bottom))return false;
   }
   return rect.width>0&&rect.height>0&&rect.right>0&&rect.left<innerWidth&&rect.bottom>0&&rect.top<innerHeight;
  };
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),parts:string[]=[];
  for(let node=walker.nextNode();node;node=walker.nextNode())if(node.parentElement&&!node.parentElement.closest("a[href]")){
   for(const match of (node.textContent??"").matchAll(/https?:\/\/[^\s`<>"']+|(?<![\w/:])\/[^\s`<>"']+/g)){
    const range=document.createRange();range.setStart(node,match.index!);range.setEnd(node,match.index!+match[0].length);
    if(Array.from(range.getClientRects()).some(rect=>shown(node.parentElement!,rect)))parts.push(match[0]);
   }
  }
  return {text:parts.join("\n"),links:Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]")).filter(node=>shown(node,node.getBoundingClientRect())).map(node=>node.href)};
 },undefined,{timeout});
 return routes(reply.body).find(route=>displayed.links.some(link=>supported(link)===route)||routes(displayed.text).includes(route));
}
