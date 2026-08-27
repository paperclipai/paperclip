import { describe,expect,it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DEFINITIONS } from "./app-definitions.generated.js";
import { APP_STORE_DEFINITIONS, APP_STORE_HIDDEN_SLUGS, CONNECTABLE_APP_DEFINITIONS, appSupportsCatalogSetup, getAvailableConnectionMethod, getRecommendedConnectionMethod, recommendedDefaultsForApp, resolveConnectionMethodServerUrl } from "./app-definitions.js";
import { BLOCKED_MCP_PROVIDERS, SELF_SERVE_MCP_CANDIDATES, SELF_SERVE_MCP_RESEARCH } from "./self-serve-mcp-research.js";
import { appDefinitionsSchema } from "./validators/app-definition.js";
describe("AppDefinition catalog",()=>{
 it("validates all Wave 1 definitions",()=>expect(()=>appDefinitionsSchema.parse(APP_DEFINITIONS)).not.toThrow());
 it("contains every established provider plus the reviewed self-serve catalog",()=>{
 expect(APP_DEFINITIONS.map((app)=>app.slug)).toEqual(expect.arrayContaining(["zapier","github","slack","notion","posthog","linear","google-sheets","context7","composio","oauth-generic","api-key-generic","sentry","vercel","anthropic","gmail","google-drive","google-docs","google-slides","google-calendar","google-chat","google-people","google-workspace-search"]));
  expect(SELF_SERVE_MCP_CANDIDATES).toHaveLength(43);
  expect(BLOCKED_MCP_PROVIDERS.map((entry)=>entry.slug)).toEqual(["g2","vercel","zomato"]);
  const definitionSlugs=new Set(APP_DEFINITIONS.map((app)=>app.slug));
  const connectableSlugs=new Set(CONNECTABLE_APP_DEFINITIONS.map((app)=>app.slug));
  expect(SELF_SERVE_MCP_CANDIDATES.filter((entry)=>!definitionSlugs.has(entry.slug))).toEqual([]);
  expect(SELF_SERVE_MCP_CANDIDATES.filter((entry)=>!connectableSlugs.has(entry.slug))).toEqual([]);
  for(const entry of BLOCKED_MCP_PROVIDERS)expect(connectableSlugs.has(entry.slug)).toBe(false);
 });
 it("keeps a complete, unique, dated evidence ledger for all 46 researched MCP providers",()=>{
  expect(SELF_SERVE_MCP_RESEARCH.verifiedAt).toBe("2026-08-26");
  expect(SELF_SERVE_MCP_RESEARCH.entries).toHaveLength(46);
  expect(new Set(SELF_SERVE_MCP_RESEARCH.entries.map((entry)=>entry.slug))).toHaveProperty("size",46);
  for(const entry of SELF_SERVE_MCP_RESEARCH.entries){
   expect(new URL(entry.docsUrl).protocol).toBe("https:");
   expect(new URL(entry.serverUrl).protocol).toBe("https:");
   expect(entry.authMode).toBeTruthy();
   expect(entry.prerequisite.length).toBeGreaterThan(10);
   expect(["S1","S2","S3","S4"]).toContain(entry.riskTier);
  }
 });
 it("uses the reviewed current endpoints and configuration modes",()=>{
  const method=(slug:string,key?:string)=>APP_DEFINITIONS.find((app)=>app.slug===slug)?.methods.find((candidate)=>!key||candidate.key===key);
  expect(method("jira")?.defaults?.serverUrl).toBe("https://mcp.atlassian.com/v1/mcp/authv2");
  expect(method("jira")?.defaults?.scopesHint).toEqual([
    "read:me",
    "read:account",
    "offline_access",
    "email",
    "read:jira-work",
    "write:jira-work",
    "search:confluence",
    "read:confluence-user",
    "read:page:confluence",
    "write:page:confluence",
    "read:comment:confluence",
    "write:comment:confluence",
    "read:space:confluence",
    "read:hierarchical-content:confluence",
    "write:component:compass",
    "read:component:compass",
    "read:scorecard:compass",
    "write:scorecard:compass",
    "read:event:compass",
    "read:metric:compass",
    "read:all:twg",
    "write:all:twg",
  ]);
  expect(method("cloudinary")?.defaults?.serverUrl).toBe("https://asset-management.mcp.cloudinary.com/mcp");
  expect(method("kernel")?.defaults?.serverUrl).toBe("https://mcp.onkernel.com/mcp");
  expect(method("resend")?.defaults?.serverUrl).toBe("https://mcp.resend.com/mcp");
  expect(method("clickhouse")?.defaults?.serverUrl).toBe("https://mcp.clickhouse.cloud/clickstack");
  expect(method("clickhouse")?.tenantFields?.[0]?.transport).toEqual({location:"header",name:"x-service-id"});
  expect(method("mem0")).toMatchObject({auth:"api_key",keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "}});
  expect(method("mem0")?.defaults?.serverUrl).toBe("https://mcp.mem0.ai/mcp/");
  expect(method("xero")?.defaults?.scopesHint).toEqual([
   "openid","profile","email","offline_access","accounting.settings","accounting.invoices.read","accounting.reports.aged.read","accounting.reports.balancesheet.read","accounting.reports.profitandloss.read",
  ]);
  expect(APP_DEFINITIONS.find((app)=>app.slug==="pagerduty")?.methods.map((candidate)=>({key:candidate.key,serverUrl:candidate.defaults?.serverUrl}))).toEqual([
   {key:"mcp-api-key-us",serverUrl:"https://mcp.pagerduty.com/mcp"},
   {key:"mcp-api-key-eu",serverUrl:"https://mcp.eu.pagerduty.com/mcp"},
  ]);
  expect(method("context7")).toMatchObject({auth:"none",defaults:{serverUrl:"https://mcp.context7.com/mcp"}});
  expect(APP_DEFINITIONS.find((app)=>app.slug==="planetscale")?.methods.map((candidate)=>candidate.key)).toEqual(["mcp-oauth","mcp-insights-only"]);
  const postman=APP_DEFINITIONS.find((app)=>app.slug==="postman");
  expect(postman?.methods.map((candidate)=>candidate.key)).toEqual([
   "mcp-oauth-minimal","mcp-oauth-code","mcp-oauth-full","mcp-eu-key-minimal","mcp-eu-key-code","mcp-eu-key-full",
  ]);
  expect(getAvailableConnectionMethod(postman!)?.key).toBe("mcp-oauth-full");
  expect(postman?.methods.filter((candidate)=>candidate.auth==="api_key").every((candidate)=>
   candidate.keyPlacement?.name==="Authorization"&&candidate.keyPlacement.prefix==="Bearer "
  )).toBe(true);
  expect(method("supabase")?.tenantFields?.find((field)=>field.key==="readOnly")?.defaultValue).toBe(false);
  expect(method("asana")?.ownershipModes).toEqual(["customer"]);
  expect(method("zapier")).toMatchObject({key:"generated-url",auth:"none",defaults:{}});
  expect(method("zapier")?.credentialFields).toBeUndefined();
 });
 it("uses discovery-first Notion MCP OAuth metadata",()=>{
  const notion=APP_DEFINITIONS.find((app)=>app.slug==="notion");
  expect(notion?.redirectConstraints).toBe("https-or-loopback-http");
  expect(notion?.methods[0]?.defaults).toEqual({serverUrl:"https://mcp.notion.com/mcp"});
 });
 it("preserves required Linear OAuth scopes",()=>expect(APP_DEFINITIONS.find((app)=>app.slug==="linear")?.methods[0]?.defaults?.scopesHint).toEqual(["read","write"]));
 it("requests only Hugging Face's MCP read scope",()=>expect(APP_DEFINITIONS.find((app)=>app.slug==="hugging-face")?.methods[0]?.defaults?.scopesHint).toEqual(["read-mcp"]));
 it("defaults S2-S4 write and destructive actions to ask-first",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods)expect(recommendedDefaultsForApp(app,method.key)).toEqual({access:"all_agents",askFirstRiskLevels:method.riskTier==="S1"?[]:["write","destructive"]})});
 it("defaults explicit read/write capability groups to their write-capable method",()=>{
  const drive=APP_DEFINITIONS.find((app)=>app.slug==="google-drive")!;
  const gmail=APP_DEFINITIONS.find((app)=>app.slug==="gmail")!;
  expect(getAvailableConnectionMethod(drive)?.key).toBe("customer-write-oauth");
  expect(getAvailableConnectionMethod(gmail)?.key).toBe("customer-draft-oauth");
  expect(getRecommendedConnectionMethod(drive.methods.filter((candidate)=>candidate.ownershipModes.includes("customer")))?.key).toBe("customer-write-oauth");
 });
 it("explains Google Workspace Developer Preview enrollment before connection",()=>{
  const googleWorkspaceMcpSlugs=["gmail","google-drive","google-docs","google-slides","google-calendar","google-chat","google-people","google-workspace-search"];
  for(const slug of googleWorkspaceMcpSlugs){
   const prerequisite=APP_DEFINITIONS.find((app)=>app.slug===slug)?.setupPrerequisite;
   expect(prerequisite?.actionUrl,slug).toBe("https://developers.google.com/workspace/preview");
   expect(prerequisite?.description,slug).toContain("does not enable unrelated Paperclip customers");
   expect(prerequisite?.steps?.join(" "),slug).toContain("final project-registration email");
  }
 });
 it("withholds unverified and reserved providers from the app store without deleting their definitions",()=>{
  expect([...APP_STORE_HIDDEN_SLUGS].sort()).toEqual([
   "beehiiv","bitly","brex","candid","coda","composio","context7","egnyte","embat","github","kernel","local-falcon","make","manufact","oreilly","planetscale","razorpay","sanity","similarweb","slack","ticket-tailor","ticktick","xero",
  ]);
  expect(APP_STORE_DEFINITIONS).toHaveLength(35);
  const connectableSlugs=new Set(CONNECTABLE_APP_DEFINITIONS.map((entry)=>entry.slug));
  const storeSlugs=new Set(APP_STORE_DEFINITIONS.map((entry)=>entry.slug));
  for(const slug of APP_STORE_HIDDEN_SLUGS){
   expect(connectableSlugs.has(slug),slug).toBe(true);
   expect(storeSlugs.has(slug),slug).toBe(false);
  }
 });
 it("ships complete local branding provenance for all 35 store-visible providers",()=>{
  const uiPublic=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../../ui/public");
  const manifest=JSON.parse(fs.readFileSync(path.join(uiPublic,"brands/apps/manifest.json"),"utf8")) as {providers:Array<{slug:string;catalogVisible:boolean;localAsset:string;darkAsset?:string;officialSourceUrl:string;upstreamAssetUrl:string;assetType:"svg"|"png";darkVariantRequired:boolean}>};
  const visible=manifest.providers.filter((entry)=>entry.catalogVisible);
  expect(visible).toHaveLength(35);
  expect(new Set(visible.map((entry)=>entry.slug))).toHaveProperty("size",35);
  expect(new Set(visible.map((entry)=>entry.localAsset))).toHaveProperty("size",35);
  expect(new Set(APP_STORE_DEFINITIONS.map((entry)=>entry.slug))).toEqual(new Set(visible.map((entry)=>entry.slug)));
  for(const app of APP_STORE_DEFINITIONS){
   const provenance=visible.find((entry)=>entry.slug===app.slug)!;
   expect(provenance).toBeTruthy();
   expect(provenance.localAsset).toBe(app.branding.logoUrl);
   expect(provenance.darkAsset).toBe(app.branding.darkLogoUrl);
   expect(provenance.darkVariantRequired).toBe(Boolean(provenance.darkAsset));
   expect(new URL(provenance.officialSourceUrl).protocol).toBe("https:");
   expect(new URL(provenance.upstreamAssetUrl).protocol).toBe("https:");
   expect(provenance.localAsset).toMatch(/^\/brands\/apps\/.+\.(svg|png)$/);
   expect(provenance.localAsset).not.toContain("google.com/s2/favicons");
   const asset=fs.readFileSync(path.join(uiPublic,provenance.localAsset));
   if(provenance.assetType==="png"){
    expect(asset.subarray(0,8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(asset.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(asset.readUInt32BE(20)).toBeGreaterThanOrEqual(128);
   }else{
    const svg=asset.toString("utf8");
    expect(svg).toMatch(/^<svg\b/);
    expect(svg).not.toMatch(/<script|<foreignObject|\son[a-z]+\s*=/i);
   }
   if(provenance.darkAsset)expect(fs.existsSync(path.join(uiPublic,provenance.darkAsset))).toBe(true);
  }
 });
 it("keeps every researched self-serve candidate implemented while blocked providers stay absent",()=>{
  const definitions=new Map(CONNECTABLE_APP_DEFINITIONS.map((entry)=>[entry.slug,entry]));
  for(const candidate of SELF_SERVE_MCP_CANDIDATES)expect(appSupportsCatalogSetup(definitions.get(candidate.slug))).toBe(true);
  for(const blocked of BLOCKED_MCP_PROVIDERS)expect(definitions.has(blocked.slug)).toBe(false);
 });
 it("ships each Google Workspace surface as an independent personal OAuth app",()=>{
  const expected={
   gmail:"https://gmailmcp.googleapis.com/mcp/v1",
   "google-drive":"https://drivemcp.googleapis.com/mcp/v1",
   "google-docs":"https://docsmcp.googleapis.com/mcp/v1",
   "google-sheets":"https://sheetsmcp.googleapis.com/mcp/v1",
   "google-slides":"https://slidesmcp.googleapis.com/mcp/v1",
   "google-calendar":"https://calendarmcp.googleapis.com/mcp/v1",
   "google-chat":"https://chatmcp.googleapis.com/mcp/v1",
   "google-people":"https://people.googleapis.com/mcp/v1",
   "google-workspace-search":"https://workspacemcp.googleapis.com/mcp/v1",
  } as const;
  for(const [slug,serverUrl] of Object.entries(expected)){
   const app=APP_DEFINITIONS.find((candidate)=>candidate.slug===slug);
   expect(app,slug).toBeTruthy();
   expect(app?.methods.some((method)=>method.oauthStrategy==="paperclip_id_connector")).toBe(true);
   for(const method of app?.methods.filter((candidate)=>candidate.auth==="oauth")??[]){
    expect(method.grantKinds,`${slug}:${method.key}`).toEqual(["user"]);
    expect(method.defaults?.serverUrl,`${slug}:${method.key}`).toBe(serverUrl);
    expect(method.capabilityProfile,`${slug}:${method.key}`).toBeTruthy();
   }
  }
 });
 it("advertises managed Gmail methods with their profile-scoped grants",()=>{
  const gmail=APP_DEFINITIONS.find((app)=>app.slug==="gmail");
  const managedMethods=gmail?.methods.filter((method)=>method.oauthStrategy==="paperclip_id_connector")??[];
  expect(managedMethods.map((method)=>method.key)).toEqual(["paperclip-read","paperclip-draft"]);
  expect(managedMethods.map((method)=>[method.connectorProfile,method.defaults?.scopesHint])).toEqual([
   ["gmail.read",["https://www.googleapis.com/auth/gmail.readonly"]],
   ["gmail.draft",[
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
   ]],
  ]);
 });
 it("configures Shopify's current UCP and compatibility MCP methods without OAuth",()=>{const shopify=APP_DEFINITIONS.find((app)=>app.slug==="shopify");expect(shopify?.methods.map((method)=>method.key)).toEqual(["ucp-commerce","storefront-mcp"]);const ucp=shopify?.methods[0];const compatibility=shopify?.methods[1];expect(ucp).toMatchObject({auth:"none",defaults:{serverUrlTemplate:"https://{storeDomain}/api/ucp/mcp",toolArgumentDefaults:{meta:{"ucp-agent":{profile:"https://shopify.dev/ucp/agent-profiles/examples/2026-04-08/valid-with-capabilities.json"}}}},tenantFields:[expect.objectContaining({key:"storeDomain",required:true})]});expect(compatibility).toMatchObject({auth:"none",defaults:{serverUrlTemplate:"https://{storeDomain}/api/mcp"}});expect(resolveConnectionMethodServerUrl(ucp!,{storeDomain:"paperclip-demo.myshopify.com"})).toBe("https://paperclip-demo.myshopify.com/api/ucp/mcp");expect(resolveConnectionMethodServerUrl(compatibility!,{storeDomain:"paperclip-demo.myshopify.com"})).toBe("https://paperclip-demo.myshopify.com/api/mcp");expect(resolveConnectionMethodServerUrl(ucp!,{})).toBeNull();expect(shopify?.setupPrerequisite).toMatchObject({title:"Launch the storefront before connecting",actionUrl:"https://admin.shopify.com/"});expect(shopify?.setupPrerequisite?.steps?.join(" ")).toContain("Storefront visibility to Public")});
 it("offers PostHog OAuth and API-key methods with zero-config defaults and advanced narrowing",()=>{const posthog=APP_DEFINITIONS.find((app)=>app.slug==="posthog");expect(posthog?.methods.map((method)=>method.key)).toEqual(["mcp-oauth","mcp-api-key"]);for(const method of posthog?.methods??[]){const projectField=method.tenantFields?.find((field)=>field.key==="projectId");expect(method.riskTier).toBe("S3");expect(method.tenantFields?.find((field)=>field.key==="readOnly")).toMatchObject({defaultValue:false,advanced:true});expect(projectField).toMatchObject({advanced:true,transport:{location:"header",name:"x-posthog-project-id"}});expect(projectField?.required).not.toBe(true);expect(method.tenantFields?.filter((field)=>field.advanced).map((field)=>field.key)).toEqual(["projectId","readOnly","features","tools"]);expect(method.tenantFields?.find((field)=>field.key==="mode")).toMatchObject({hidden:true,defaultValue:"tools",transport:{location:"query",name:"mode"}});expect(method.configRequirements).toBeUndefined();expect(method.requiredResourceFilters).toBeUndefined();expect(method.guidanceMd).toContain("optional advanced controls")}});
 it("requires only reviewed provider or safety-boundary configuration on the default path",()=>{const required=APP_DEFINITIONS.flatMap((app)=>app.methods.flatMap((method)=>[...(method.tenantFields??[]),...(method.extensionFields??[])].filter((field)=>field.required&&field.advanced!==true&&!field.hidden).map((field)=>`${app.slug}:${method.key}:${field.key}`))).sort();expect(required).toEqual(["clickhouse:mcp-oauth:serviceId","shopify:storefront-mcp:storeDomain","shopify:ucp-commerce:storeDomain","supabase:mcp-api-key:projectRef","supabase:mcp-oauth:projectRef"])});
 it("limits Vercel Connect setup to the reviewed pilot methods",()=>{
  const reviewed=APP_DEFINITIONS.flatMap((app)=>app.methods.flatMap((method)=>method.credentialSources?.vercelConnect?[{slug:app.slug,key:method.key,review:method.credentialSources.vercelConnect}]:[]));
  expect(reviewed.map(({slug,key})=>`${slug}:${key}`).sort()).toEqual(["linear:mcp-oauth","notion:mcp-oauth","posthog:mcp-api-key","posthog:mcp-oauth"]);
  expect(reviewed.find(({slug})=>slug==="linear")?.review).toMatchObject({services:["linear"],principalModes:["user"],scopes:["read","write"],header:{name:"Authorization",prefix:"Bearer "}});
  expect(reviewed.find(({slug,key})=>slug==="posthog"&&key==="mcp-oauth")?.review.services).toEqual(["posthog","mcp.posthog.com/mcp"]);
  expect(reviewed.find(({slug,key})=>slug==="posthog"&&key==="mcp-api-key")?.review.principalModes).toEqual(["app"]);
  expect(APP_DEFINITIONS.find((app)=>app.slug==="vercel")?.availability?.available).toBe(false);
 });
 it("enforces method and field invariants",()=>{for(const app of APP_DEFINITIONS)for(const method of app.methods){if(method.auth==="api_key")expect(method.keyPlacement).toBeTruthy();if(method.auth==="oauth")expect(method.ownershipModes.length).toBeGreaterThan(0);for(const field of method.credentialFields??[])if(field.required&&field.type!=="checkbox")expect(field.placeholder).toBeTruthy()}});
});
