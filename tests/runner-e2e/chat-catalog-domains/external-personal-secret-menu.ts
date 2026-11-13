import {expect,type Locator,type Page} from "@playwright/test";
export interface PersonalSecretMenuNavigation {advertisedHint:string;observedNavigationRoute:string;expectedDefinitionId:string;visibleDefinitionKey:string;viaMySecrets:true;limitation:string}
export async function personalSecretMenuNavigation(page:Page,reply:{body:string;commentId?:string},origin:string,prefix:string,definitionId:string,timeout:number):Promise<PersonalSecretMenuNavigation|undefined>{
 const hint="/company/settings/secrets",text=reply.body.replace(/[*`]/g,"");
 if(!reply.commentId||!text.includes(definitionId)||!/Settings\s*(?:→|>|then)\s*Secrets/i.test(text)||!/My secrets/i.test(text)||!/PERSONAL_PUBLISHING_KEY/.test(text)||!/Set my value/i.test(text))return;
 const tokens=(reply.body.match(/https?:\/\/[^\s`<>"']+|(?<![\w/:])\/[^\s`<>"']+/g)??[]).map(value=>value.replace(/[.,;!?\])}]+$/,""));
 if(tokens.filter(token=>token===hint).length!==1)return;
 const deadline=Date.now()+timeout,remaining=()=>{const ms=deadline-Date.now();if(ms<=0)throw new Error("Personal menu navigation deadline exceeded");return ms;};
 const visible=async(node:Locator)=>{
  if(await node.count()!==1||!await node.isVisible())return false;
  await node.scrollIntoViewIfNeeded({timeout:remaining()});
  return node.evaluate(node=>{const r=node.getBoundingClientRect();if(!node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})||r.width<=0||r.height<=0||r.bottom<=0||r.top>=innerHeight||r.right<=0||r.left>=innerWidth)return false;for(let p=node.parentElement;p;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/hidden|clip/.test(s.overflowX)&&(r.right<=b.left||r.left>=b.right)||/hidden|clip/.test(s.overflowY)&&(r.bottom<=b.top||r.top>=b.bottom))return false;}return true;});
 };
 const waitVisible=async(node:Locator)=>{try{await expect.poll(()=>visible(node),{timeout:Math.max(1,remaining()-200),intervals:[50,100,250]}).toBe(true);return true;}catch{return false;}};
 const comment=page.locator(`[id=${JSON.stringify(`comment-${reply.commentId}`)}]`);
 await comment.waitFor({state:"visible",timeout:remaining()});
 const code=comment.locator("code").filter({hasText:hint});
 if(!await visible(code)||await code.innerText()!==hint||await code.evaluate(node=>!!node.closest("a[href]")))return;
 for(const part of [definitionId,"PERSONAL_PUBLISHING_KEY","My secrets","Set my value"]){if(!await visible(comment.getByText(part,{exact:false}).last()))return;}
 const issueLinks=new Set<string>();
 for(const anchor of await comment.locator("a[href]").all()){
  const href=await anchor.getAttribute("href");try{const u=new URL(href??"",origin);if(u.origin!==origin||u.username||u.password||!u.pathname.startsWith(`/${prefix}/issues/`)||!await visible(anchor))return;issueLinks.add(u.href);}catch{return;}
 }
 for(const token of tokens){if(token===hint)continue;try{if(!issueLinks.has(new URL(token,origin).href))return;}catch{return;}}
 const supported=(href:string|null,suffix:string)=>{try{const u=new URL(href??"",origin);return u.origin===origin&&u.pathname===`/${prefix}/company/settings${suffix}`&&!u.search&&!u.hash&&!u.username&&!u.password?u.href:undefined;}catch{return;}};
 const original=page.url();let navigated=false,opened=false;
 try{
  let settings=page.locator("aside").getByRole("link",{name:"Settings",exact:true});
  if(!await settings.count()){
   const account=page.getByRole("button",{name:"Open account menu",exact:true});if(!await visible(account))return;
   await account.click({timeout:remaining()});opened=true;settings=page.locator("[data-flyout-options]").getByRole("link",{name:"Settings",exact:true});
  }
  if(!await waitVisible(settings))return;const target=supported(await settings.getAttribute("href"),"");if(!target)return;
  navigated=true;await settings.click({timeout:remaining()});await page.waitForURL(target,{timeout:remaining()});
  const secrets=page.locator("aside").getByRole("link",{name:"Secrets",exact:true});await secrets.waitFor({state:"attached",timeout:remaining()});if(!await visible(secrets))return;
  const href=supported(await secrets.getAttribute("href"),"/secrets");if(!href)return;
  await secrets.click({timeout:remaining()});await page.waitForURL(href,{timeout:remaining()});
  const tab=page.getByRole("tab",{name:"My secrets",exact:true});await tab.waitFor({state:"attached",timeout:remaining()});if(!await visible(tab))return;await tab.click({timeout:remaining()});
  const own=page.getByRole("listitem").filter({has:page.getByText("PERSONAL_PUBLISHING_KEY",{exact:true})});
  if(!await waitVisible(own)||!await waitVisible(own.getByRole("button",{name:"Set value",exact:true})))return;
  return {advertisedHint:hint,observedNavigationRoute:href,expectedDefinitionId:definitionId,visibleDefinitionKey:"PERSONAL_PUBLISHING_KEY",viaMySecrets:true,limitation:"The advertised inline hint is noncanonical; only actual current-company UI hrefs authorized navigation. Private worker must independently verify definition and owner before entry."};
 }finally{if(navigated)await page.goto(original,{waitUntil:"domcontentloaded",timeout:Math.max(1,deadline-Date.now())});else if(opened)await page.keyboard.press("Escape");}
}
