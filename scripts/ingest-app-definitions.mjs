import fs from "node:fs"; import path from "node:path";
const root=process.cwd(); const corpus=process.env.PAPERCLIP_CONTENT_TEMPLATES??path.resolve(root,"../../../paperclip-content/research/connections/vercel/templates");
const out=path.join(root,"packages/shared/src/app-definitions"); const favicon=d=>`https://www.google.com/s2/favicons?domain=${d}&sz=128`;
const field=(key,label,placeholder)=>({key,label,type:"password",required:true,placeholder,secret:true});
const method=(key,transport,auth,defaults,riskTier,guidanceMd,extra={})=>({key,transport,auth,ownershipModes:auth==="oauth"?["customer","dcr"]:["customer"],whenToUse:transport==="mcp_remote"?"Use the provider-hosted connection for the quickest setup.":"Use credentials from your provider account.",defaults,guidanceMd,riskTier,...extra});
const apps=[
["zapier","Zapier","Reach thousands of apps through your Zapier account.","productivity","zapier.com",["https://mcp.zapier.com/*"],method("mcp-key","mcp_remote","api_key",{serverUrl:"https://mcp.zapier.com/api/mcp"},"S3","Create a Zapier MCP connection, then paste its token here.",{credentialFields:[field("authorization","Zapier MCP token","Paste your Zapier token")],keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "}})],
["github","GitHub","Read code and pull requests, and coordinate repository work.","developer","github.com",["https://api.githubcopilot.com/mcp/*"],method("mcp-key","mcp_remote","api_key",{serverUrl:"https://api.githubcopilot.com/mcp/"},"S3","Create a fine-grained token limited to the repositories agents should use.",{credentialFields:[field("authorization","GitHub token","github_pat_...")],keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "},requiredResourceFilters:["organization","repository"]})],
["slack","Slack","Search channels and coordinate team communication.","communication","slack.com",["https://mcp.slack.com/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.slack.com/mcp",authorizationEndpoint:"https://slack.com/oauth/v2/authorize",tokenEndpoint:"https://slack.com/api/oauth.v2.access",scopesHint:["channels:read","chat:write","search:read"]},"S3","Connect a Slack workspace and limit access to the channels agents need.",{requiredResourceFilters:["workspace","channel"]})],
["notion","Notion","Read and update pages in your Notion workspace.","content","notion.so",["https://mcp.notion.com/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.notion.com/mcp",authorizationEndpoint:"https://api.notion.com/v1/oauth/authorize",tokenEndpoint:"https://api.notion.com/v1/oauth/token",scopesHint:["read_content","update_content"]},"S3","Connect Notion for workspace content. Share only the pages and databases agents should use.",{requiredResourceFilters:["workspace","page","database"]})],
["linear","Linear","Create, update, and read Linear issues.","productivity","linear.app",["https://mcp.linear.app/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.linear.app/mcp",authorizationEndpoint:"https://linear.app/oauth/authorize",tokenEndpoint:"https://api.linear.app/oauth/token",scopesHint:["read","write"]},"S2","Register a Linear OAuth app and add Paperclip's redirect URI before connecting.",{requiredResourceFilters:["workspace","team","project"]})],
["google-sheets","Google Sheets","Read and update selected spreadsheets.","data","sheets.google.com",["https://docs.google.com/spreadsheets/*","https://sheets.google.com/*"],method("local","local_stdio","none",{templateKey:"paperclip.google-sheets"},"S3","Share each spreadsheet with the Paperclip robot email, then paste the sheet links.",{requiredResourceFilters:["spreadsheet"]})],
["context7","Context7","Look up current documentation for software libraries.","developer","context7.com",["https://mcp.context7.com/*"],method("mcp","mcp_remote","none",{serverUrl:"https://mcp.context7.com/mcp"},"S1","Connect Context7 to give agents current library documentation.")],
["oauth-generic","OAuth app","Connect a provider using your own OAuth client.","other","oauth.net",[],method("oauth","rest_api","oauth",{},"S3","Register an OAuth client with the provider and add Paperclip's redirect URI.",{credentialFields:[{...field("clientId","Client ID","Paste the client ID"),type:"text",secret:false},field("clientSecret","Client secret","Paste the client secret")]})],
["api-key-generic","API key app","Connect an API using a key from your provider.","other","openapis.org",[],method("api-key","rest_api","api_key",{},"S3","Create a restricted API key and paste it here.",{credentialFields:[field("apiKey","API key","Paste the API key")],keyPlacement:{location:"header",name:"Authorization",prefix:"Bearer "}})],
["sentry","Sentry","Investigate errors, releases, and production issues.","developer","sentry.io",["https://mcp.sentry.dev/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.sentry.dev/mcp",discoveryUrl:"https://sentry.io/.well-known/oauth-authorization-server"},"S2","Connect the Sentry organization and projects agents need for incident work.",{requiredResourceFilters:["organization","project","environment"]})],
["vercel","Vercel","Inspect projects, deployments, and runtime logs.","developer","vercel.com",["https://mcp.vercel.com/*"],method("mcp-oauth","mcp_remote","oauth",{serverUrl:"https://mcp.vercel.com/mcp"},"S3","Connect the Vercel team and projects agents should operate.",{requiredResourceFilters:["team","project","environment"]})],
["anthropic","Anthropic","Use Anthropic APIs with a restricted key.","ai","anthropic.com",["https://api.anthropic.com/*"],method("api-key","rest_api","api_key",{serviceHost:"api.anthropic.com"},"S3","Create a key in the Anthropic Console and rotate it if it has been exposed.",{credentialFields:[field("apiKey","API key","sk-ant-api03-...")],keyPlacement:{location:"header",name:"x-api-key"}})],
].map(([slug,name,description,category,domain,urlPatterns,m])=>({schemaVersion:1,slug,name,description,categories:[category],featured:["zapier","github","slack","notion","linear"].includes(slug),branding:{logoUrl:favicon(domain)},urlPatterns,methods:[m]}));
const parseTableRow=(line)=>line.slice(1,-1).split("|").map((cell)=>cell.trim());
const parseCapture=(fileName)=>{
 const markdown=fs.readFileSync(path.join(corpus,fileName),"utf8");
 const stateMatches=[...markdown.matchAll(/^## State: (.+)$/gm)];
 if(stateMatches.length===0) throw new Error(`${fileName}: no captured states`);
 return stateMatches.map((match,index)=>{
  const body=markdown.slice(match.index+match[0].length,stateMatches[index+1]?.index??markdown.length);
  const inputsBlock=body.match(/### Inputs\n([\s\S]*?)(?=\n### |$)/)?.[1]??"";
  const inputRows=inputsBlock.split("\n").filter((line)=>line.startsWith("|")).slice(2).map(parseTableRow);
  const fields=inputRows.map(([label,tagType,required,placeholder,prefilledValue,checked])=>({label,tagType,required:required.toLowerCase()==="yes",placeholder:placeholder||null,prefilledValue:prefilledValue||null,checked:checked.toLowerCase()==="true"}));
  const linksBlock=body.match(/### Links\n([\s\S]*?)(?=\n## |$)/)?.[1]??"";
  const links=linksBlock.split("\n").map((line)=>line.match(/^(.+?) → (https?:\/\/\S+)$/)).filter(Boolean).map((link)=>({label:link[1].trim(),href:link[2]}));
  return {label:match[1].trim(),fields,links};
 });
};
const inferState=(slug,state)=>{
 const label=state.label.toLowerCase();
 const fieldText=state.fields.map((field)=>field.label.toLowerCase()).join(" ");
 const transport=slug==="oauth-generic"||slug==="api-key-generic"||label.includes("path: api")||label.includes("api key form")?"rest_api":"mcp_remote";
 const auth=slug==="oauth-generic"||label.includes("oauth")||fieldText.includes("client id")?"oauth":slug==="api-key-generic"||label.includes("api key")||fieldText.includes("api key")?"api_key":null;
 const ownershipModes=[];
 if(label.includes("managed")) ownershipModes.push("platform_shared");
 if(label.includes("your own credentials")||label.includes("manual")||label.includes("api key")) ownershipModes.push("customer");
 if(slug==="oauth-generic"&&!label.includes("manually")) ownershipModes.push("dcr");
 return {label:state.label,transport,auth,ownershipModes:[...new Set(ownershipModes)],fieldCount:state.fields.length,linkCount:state.links.length};
};
const validateApp=(app)=>{
 if(app.schemaVersion!==1||!app.slug||!app.name||!Array.isArray(app.methods)||app.methods.length===0) throw new Error(`${app.slug||"unknown"}: invalid AppDefinition`);
 for(const connectionMethod of app.methods){
  if(connectionMethod.auth==="api_key"&&!connectionMethod.keyPlacement) throw new Error(`${app.slug}/${connectionMethod.key}: api_key requires keyPlacement`);
  if(connectionMethod.auth==="oauth"&&connectionMethod.ownershipModes.length===0) throw new Error(`${app.slug}/${connectionMethod.key}: oauth requires ownershipModes`);
  for(const connectionField of [...connectionMethod.tenantFields??[],...connectionMethod.extensionFields??[],...connectionMethod.credentialFields??[]]) if(connectionField.required&&connectionField.type!=="checkbox"&&!connectionField.placeholder) throw new Error(`${app.slug}/${connectionMethod.key}/${connectionField.key}: required field needs placeholder`);
 }
};
const captureFiles=fs.readdirSync(corpus).filter((fileName)=>fileName.endsWith(".md")&&fileName!=="INDEX.md").sort();
if(captureFiles.length!==99) throw new Error(`Expected 99 captures, found ${captureFiles.length}`);
const parsedCaptures=Object.fromEntries(captureFiles.map((fileName)=>[path.basename(fileName,".md"),parseCapture(fileName)]));
const reviewReport={schemaVersion:1,corpusSize:captureFiles.length,providers:captureFiles.map((fileName)=>{const slug=path.basename(fileName,".md");const states=parsedCaptures[slug].map((state)=>inferState(slug,state));return {slug,stateCount:states.length,states,ambiguities:states.filter((state)=>!state.auth).map((state)=>`Auth is not explicit in capture state: ${state.label}`)};})};
for(const app of apps){validateApp(app);if(parsedCaptures[app.slug]&&parsedCaptures[app.slug].length===0) throw new Error(`${app.slug}: capture has no states`);}
fs.mkdirSync(out,{recursive:true}); for(const app of apps) fs.writeFileSync(path.join(out,`${app.slug}.json`),JSON.stringify(app,null,2)+"\n");
fs.writeFileSync(path.join(root,"packages/shared/src/app-definitions.ingestion-report.json"),JSON.stringify(reviewReport,null,2)+"\n");
const imports=apps.map((a,i)=>`import a${i} from "./app-definitions/${a.slug}.json" with { type: "json" };`).join("\n");
fs.writeFileSync(path.join(root,"packages/shared/src/app-definitions.generated.ts"),`${imports}\nimport type { AppDefinition } from "./types/app-definition.js";\nexport const APP_DEFINITIONS=[${apps.map((_,i)=>`a${i}`).join(",")}] as AppDefinition[];\n`);
const ambiguityCount=reviewReport.providers.reduce((total,provider)=>total+provider.ambiguities.length,0);
console.log(`Parsed ${captureFiles.length} captures and ${reviewReport.providers.reduce((total,provider)=>total+provider.stateCount,0)} states; emitted ${apps.length} Wave 1 definitions and flagged ${ambiguityCount} states for review.`);
