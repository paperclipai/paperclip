import type {Locator,Page} from "@playwright/test";
export function companySecretMenuDirections(body:string){
 body=body.replace(/[*_`]/g,"");
 return /\b(?:Company\s+)?Settings\s*(?:→|>|then)\s*Secrets\b/i.test(body)&&/\bNew secret\b/i.test(body);
}
export async function companySecretMenuURL(page:Page,reply:{body:string;commentId?:string},origin:string,prefix:string,timeout:number){
 if(!reply.commentId||!companySecretMenuDirections(reply.body))return;
 const deadline=Date.now()+timeout,remaining=()=>{const left=deadline-Date.now();if(left<=0)throw new Error("Company secret menu navigation deadline exceeded");return left;};
 const comment=page.locator(`[id=${JSON.stringify(`comment-${reply.commentId}`)}]`);
 const visible=async(locator:Locator)=>{
  if(await locator.count()!==1||!await locator.isVisible())return false;
  await locator.scrollIntoViewIfNeeded({timeout:remaining()});
  return locator.evaluate(node=>{const rect=node.getBoundingClientRect();return node.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&rect.width>0&&rect.height>0&&rect.right>0&&rect.left<innerWidth&&rect.bottom>0&&rect.top<innerHeight;});
 };
 const supported=(href:string|null,suffix:string)=>{try{const url=new URL(href??"",origin);return url.origin===origin&&url.pathname===`/${prefix}/company/settings${suffix}`&&!url.search&&!url.hash&&!url.username&&!url.password?url.href:undefined;}catch{return;}};
 await comment.waitFor({state:"visible",timeout:remaining()});
 const fragment=comment.getByText("/company/settings/secrets",{exact:false}).last();
 if(!await visible(comment.getByText(/(?:Company\s+)?Settings\s*(?:→|>|then)\s*Secrets/i).last())||!await visible(comment.getByText("New secret",{exact:false}).last()))return;
 const tokens:string[]=reply.body.match(/https?:\/\/[^\s`<>"')]+|(?<![\w/:])\/[^\s`<>"')]+/g)??[];
 if(tokens.includes("/company/settings/secrets")&&(!await visible(fragment)||await fragment.evaluate(node=>!!node.closest("a[href]"))))return;
 for(const anchor of await comment.locator("a[href]").all()){
  const href=await anchor.getAttribute("href"),label=await anchor.innerText();
  if(/settings|secrets?/i.test(`${href} ${label}`)&&!supported(href,"")&&!supported(href,"/secrets"))return;
 }
 for(const token of tokens){
  if(token!=="/company/settings/secrets"&&/settings|secrets?/i.test(token)&&!supported(token,"")&&!supported(token,"/secrets"))return;
 }
 const originalURL=page.url();let navigated=false,openedMenu=false;
 try{
  let settings=page.locator("aside").getByRole("link",{name:"Settings",exact:true});
  if(!await settings.count()){
   const account=page.getByRole("button",{name:"Open account menu",exact:true});
   if(!await visible(account))return;
   await account.click({timeout:remaining()});openedMenu=true;settings=page.locator("[data-flyout-options]").getByRole("link",{name:"Settings",exact:true});
  }
  if(!await visible(settings))return;
  const settingsURL=supported(await settings.getAttribute("href"),"");if(!settingsURL)return;
  navigated=true;await settings.click({timeout:remaining()});await page.waitForURL(settingsURL,{timeout:remaining()});
  const secrets=page.locator("aside").getByRole("link",{name:"Secrets",exact:true});
  await secrets.waitFor({state:"attached",timeout:remaining()});
  if(!await visible(secrets))return;
  const href=supported(await secrets.getAttribute("href"),"/secrets");if(!href)return;
  await secrets.click({timeout:remaining()});
  await page.waitForURL(href,{timeout:remaining()});
  const create=page.getByRole("button",{name:"New secret",exact:true});await create.waitFor({state:"visible",timeout:remaining()});
  if(!await visible(create))return;
  return href;
 }finally{
  if(navigated){await page.goto(originalURL,{waitUntil:"domcontentloaded",timeout});await comment.waitFor({state:"visible",timeout});}
  else if(openedMenu)await page.keyboard.press("Escape");
 }
}
