import { z } from "zod";
import { jsonSchemaSchema } from "./json-schema.js";
import { CONNECTION_CREDENTIAL_MINTERS, PLUGIN_CONNECTOR_TOOL_TIMEOUT_MAX_MS, PLUGIN_CONNECTOR_TOOL_TIMEOUT_MIN_MS } from "../types/app-definition.js";
import { INSTANCE_FEATURE_KEYS } from "../feature-catalog.js";
import { connectionInstructionTemplateSchema } from "../connection-instructions.js";
import { AI_CONNECTION_CAPABILITIES, aiConnectionMetadataSchema } from "../ai-connections.js";
import { connectionGrantKindSchema, toolConnectionOwnershipSchema, toolConnectionPurposeSchema, toolConnectionTransportSchema } from "./tool-access.js";
const appBrandAssetUrlSchema=z.string().refine((value)=>{
 if(/^\/brands\/apps\/[a-z0-9][a-z0-9._-]*\.(?:svg|png)$/i.test(value))return true;
 try{return new URL(value).protocol==="https:";}catch{return false;}
},{message:"Brand assets must be HTTPS URLs or local /brands/apps SVG/PNG paths"});
const field=z.object({key:z.string().min(1),label:z.string().min(1),type:z.enum(["text","password","textarea","datetime","select","checkbox"]),required:z.boolean().optional(),advanced:z.boolean().optional(),hidden:z.boolean().optional(),placeholder:z.string().optional(),helperMd:z.string().optional(),secret:z.boolean().optional(),prefix:z.string().optional(),defaultValue:z.union([z.string(),z.boolean()]).optional(),validation:z.object({pattern:z.string().optional(),maxLength:z.number().int().positive().optional()}).optional(),options:z.array(z.object({value:z.string(),label:z.string()})).optional(),transport:z.object({location:z.enum(["query","header"]),name:z.string().min(1),format:z.enum(["string","csv","boolean"]).optional(),omitFalse:z.boolean().optional()}).optional()}).superRefine((v,c)=>{if(v.required&&v.type!=="checkbox"&&!v.placeholder)c.addIssue({code:"custom",message:"Required fields need placeholders",path:["placeholder"]});if(v.type==="select"&&(!v.options||v.options.length===0))c.addIssue({code:"custom",message:"Select fields need options",path:["options"]});if(v.hidden&&v.defaultValue===undefined)c.addIssue({code:"custom",message:"Hidden fields need defaults",path:["defaultValue"]})});
/** Tool names a plugin connector serves: lowercase letters, digits and underscores. */
export const PLUGIN_CONNECTOR_TOOL_NAME = /^[a-z0-9_]{1,64}$/;
const pluginToolTimeoutMsSchema=z.number().int().min(PLUGIN_CONNECTOR_TOOL_TIMEOUT_MIN_MS).max(PLUGIN_CONNECTOR_TOOL_TIMEOUT_MAX_MS);
const pluginStaticToolSchema=z.object({
  name:z.string().regex(PLUGIN_CONNECTOR_TOOL_NAME,"Tool names may contain only a-z, 0-9 and _"),
  displayName:z.string().min(1).max(200).optional(),
  description:z.string().min(1).max(4000).optional(),
  risk:z.enum(["read","write","destructive"]),
  parametersSchema:jsonSchemaSchema,
  timeoutMs:pluginToolTimeoutMsSchema.optional(),
}).strict();
/**
 * Tools of a method served by a plugin worker (`transport: "plugin"`). Static
 * tools are declared here; dynamic tools come from the worker's `listTools`
 * for each connection and carry their own risk.
 */
export const pluginMethodToolsSchema=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("static"),list:z.array(pluginStaticToolSchema).min(1).max(500)}).strict(),
  z.object({kind:z.literal("dynamic")}).strict(),
]).superRefine((value,ctx)=>{
  if(value.kind!=="static")return;
  const seen=new Set<string>();
  value.list.forEach((tool,index)=>{
    if(seen.has(tool.name))ctx.addIssue({code:"custom",message:`Duplicate tool ${tool.name}`,path:["list",index,"name"]});
    seen.add(tool.name);
  });
});
/**
 * Per-connection settings are a flat object of simple fields, which the board
 * renders as a form. Keeping to this shape means every schema a manifest can
 * declare can also be filled in.
 */
const SETTINGS_FIELD_TYPES=new Set(["string","number","integer","boolean"]);
const SETTINGS_FIELD_KEYS=new Set(["type","title","description","default","enum","format","minimum","maximum","minLength","maxLength","pattern"]);
export function isSupportedPluginSettingsSchema(schema:Record<string,unknown>):boolean{
  const allowedRoot=new Set(["type","title","description","properties","required","additionalProperties"]);
  if(schema.type!=="object"||Object.keys(schema).some((key)=>!allowedRoot.has(key)))return false;
  const properties=schema.properties??{};
  if(!properties||typeof properties!=="object"||Array.isArray(properties))return false;
  const names=Object.keys(properties);
  if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.some((name)=>typeof name!=="string"||!names.includes(name))))return false;
  return Object.values(properties as Record<string,unknown>).every((field)=>{
    if(!field||typeof field!=="object"||Array.isArray(field))return false;
    const record=field as Record<string,unknown>;
    // Settings are stored as plain connection configuration, so they cannot
    // hold secrets: credentials belong in credentialFields, which are vaulted.
    if(record.format==="secret-ref"||record.format==="password")return false;
    // Choices must be strings or numbers; a boolean is a checkbox, not a select.
    if(record.enum!==undefined&&(record.type==="boolean"||!Array.isArray(record.enum)||record.enum.some((value)=>typeof value!=="string"&&typeof value!=="number")))return false;
    return typeof record.type==="string"&&SETTINGS_FIELD_TYPES.has(record.type)&&Object.keys(record).every((key)=>SETTINGS_FIELD_KEYS.has(key));
  });
}
export const connectionMethodDefSchema=z.object({key:z.string().min(1),label:z.string().min(1).optional(),purpose:z.union([toolConnectionPurposeSchema,z.literal("ai")]).optional(),provider:z.enum(["slack","github","discord","microsoft-teams","telegram","speko","agentmail","imessage-photon"]).optional(),transport:z.union([toolConnectionTransportSchema,z.literal("runtime_auth"),z.literal("plugin")]),settingsSchema:jsonSchemaSchema.optional(),tools:pluginMethodToolsSchema.optional(),timeoutMs:pluginToolTimeoutMsSchema.optional(),ai:aiConnectionMetadataSchema.optional(),auth:z.enum(["oauth","api_key","none"]),oauthStrategy:z.enum(["paperclip_cloud_connector","paperclip_id_connector"]).optional(),connectorProfile:z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/).optional(),oauthClientSecretRequired:z.boolean().optional(),oauthClientRegistration:z.literal("dcr").optional(),capabilityProfile:z.object({key:z.string().min(1),label:z.string().min(1),description:z.string().min(1).optional()}).optional(),grantKinds:z.array(connectionGrantKindSchema).min(1).optional(),ownershipModes:z.array(toolConnectionOwnershipSchema).min(1),whenToUse:z.string().min(1),defaults:z.object({serverUrl:z.string().url().optional(),serverUrlTemplate:z.string().regex(/^https:\/\//).optional(),discoveryUrl:z.string().url().nullable().optional(),serviceHost:z.string().optional(),templateKey:z.string().optional(),authorizationEndpoint:z.string().url().optional(),tokenEndpoint:z.string().url().optional(),metadataUrl:z.string().url().optional(),scopesHint:z.array(z.string()).optional(),oauthAuthorizationParams:z.object({access_type:z.literal("offline").optional(),prompt:z.literal("consent").optional()}).optional(),toolArgumentDefaults:z.record(z.string(),z.unknown()).optional(),mcpSessionRequired:z.boolean().optional()}).optional(),tenantFields:z.array(field).optional(),extensionFields:z.array(field).optional(),configRequirements:z.object({atLeastOneOf:z.array(z.string().min(1)).min(1).optional()}).optional(),credentialFields:z.array(field).optional(),keyPlacement:z.object({location:z.enum(["header","query","body_json","env"]),name:z.string().min(1),prefix:z.string().nullable().optional()}).optional(),credentialMinter:z.enum(CONNECTION_CREDENTIAL_MINTERS).optional(),credentialSources:z.object({vercelConnect:z.object({services:z.array(z.string().min(1)).min(1),principalModes:z.array(z.enum(["app","user"])).min(1),scopes:z.array(z.string().min(1)).min(1),header:z.object({name:z.string().min(1),prefix:z.string().nullable().optional()})}).optional()}).optional(),guidanceMd:z.string().min(1),consoleLinks:z.object({register:z.string().url().optional(),keys:z.string().url().optional(),settings:z.string().url().optional(),docs:z.string().url().optional()}).optional(),warnings:z.array(z.string()).optional(),variants:z.array(z.object({key:z.string(),label:z.string(),whenToUse:z.string(),tenantFields:z.array(field).optional()})).optional(),riskTier:z.enum(["S1","S2","S3","S4"]),requiredResourceFilters:z.array(z.string()).optional()}).superRefine((v,c)=>{if((v.transport==="runtime_auth")!==Boolean(v.ai))c.addIssue({code:"custom",message:"Runtime authentication requires AI metadata and AI metadata requires runtime_auth",path:["ai"]});if(v.ai&&!AI_CONNECTION_CAPABILITIES[v.ai.provider].methods[v.ai.method])c.addIssue({code:"custom",message:"Unsupported AI sign-in method",path:["ai","method"]});if(v.ai&&v.auth!==(v.ai.method==="subscription"?"oauth":"api_key"))c.addIssue({code:"custom",message:"AI sign-in method must match authentication",path:["auth"]});if(v.oauthClientRegistration&&(v.auth!=="oauth"||v.transport!=="mcp_remote"||!v.ownershipModes.includes("dcr")))c.addIssue({code:"custom",message:"DCR client registration requires a remote MCP OAuth method with DCR ownership",path:["oauthClientRegistration"]});if(v.defaults?.mcpSessionRequired&&v.transport!=="mcp_remote")c.addIssue({code:"custom",message:"MCP session initialization preferences require remote MCP transport",path:["defaults","mcpSessionRequired"]});const purpose=v.purpose??"tool";if((purpose==="ai")!==(v.transport==="runtime_auth"))c.addIssue({code:"custom",message:"AI methods require runtime_auth and runtime_auth requires AI purpose",path:["purpose"]});if(["chat_sdk","voice"].includes(v.transport)&&purpose!=="channel")c.addIssue({code:"custom",message:"Chat SDK methods must be channel connections",path:["purpose"]});if(purpose==="channel"&&!["chat_sdk","voice"].includes(v.transport)&&!(v.provider==="agentmail"&&v.transport==="rest_api"))c.addIssue({code:"custom",message:"Channel connections must use the Chat SDK transport",path:["transport"]});if(purpose==="channel"&&((v.provider==="speko")!==(v.transport==="voice")))c.addIssue({code:"custom",message:"Speko channels require the voice transport",path:["transport"]});if(purpose==="channel"&&!v.provider)c.addIssue({code:"custom",message:"Channel connections require a chat provider",path:["provider"]});if((v.transport==="plugin")!==Boolean(v.tools))c.addIssue({code:"custom",message:"Plugin-served methods declare tools, and only plugin-served methods may",path:["tools"]});if(v.settingsSchema&&!isSupportedPluginSettingsSchema(v.settingsSchema))c.addIssue({code:"custom",message:"settingsSchema must be an object of simple fields (string, number, integer or boolean)",path:["settingsSchema"]});if(v.timeoutMs!==undefined&&v.transport!=="plugin")c.addIssue({code:"custom",message:"timeoutMs applies only to plugin-served methods",path:["timeoutMs"]});if(v.settingsSchema&&v.transport!=="plugin")c.addIssue({code:"custom",message:"settingsSchema applies only to plugin-served methods",path:["settingsSchema"]});if(v.transport==="plugin"&&(purpose!=="tool"||v.auth==="oauth"||v.oauthStrategy))c.addIssue({code:"custom",message:"Plugin-served methods provide tools with no authentication or an API key",path:["auth"]});if(v.credentialMinter&&(v.transport!=="mcp_remote"||v.auth!=="api_key"||v.keyPlacement||v.credentialSources))c.addIssue({code:"custom",message:"Minted credentials require an API-key remote MCP method without keyPlacement or another credential source",path:["credentialMinter"]});if(v.auth==="api_key"&&!v.keyPlacement&&!v.credentialMinter&&purpose!=="channel"&&v.transport!=="plugin")c.addIssue({code:"custom",message:"API-key tool methods require keyPlacement",path:["keyPlacement"]});if(v.oauthStrategy&&v.auth!=="oauth")c.addIssue({code:"custom",message:"OAuth strategies require OAuth auth",path:["oauthStrategy"]});if(v.oauthStrategy&&!v.connectorProfile)c.addIssue({code:"custom",message:"Paperclip Cloud connector methods require connectorProfile",path:["connectorProfile"]});if(v.connectorProfile&&!v.oauthStrategy)c.addIssue({code:"custom",message:"connectorProfile requires a Paperclip Cloud OAuth strategy",path:["connectorProfile"]});if(v.credentialSources?.vercelConnect&&(v.transport!=="mcp_remote"||v.auth==="none"))c.addIssue({code:"custom",message:"Vercel Connect requires an authenticated remote MCP method",path:["credentialSources","vercelConnect"]});const keys=new Set([...(v.tenantFields??[]),...(v.extensionFields??[])].map((entry)=>entry.key));for(const key of v.configRequirements?.atLeastOneOf??[])if(!keys.has(key))c.addIssue({code:"custom",message:"Config requirement references an unknown field",path:["configRequirements","atLeastOneOf"]});if(v.defaults?.serverUrl&&v.defaults.serverUrlTemplate)c.addIssue({code:"custom",message:"Use either serverUrl or serverUrlTemplate",path:["defaults"]});for(const placeholder of v.defaults?.serverUrlTemplate?.matchAll(/\{([a-zA-Z0-9_-]+)\}/g)??[])if(!keys.has(placeholder[1]))c.addIssue({code:"custom",message:"Server URL template references an unknown field",path:["defaults","serverUrlTemplate"]})});
const reviewedToolNameListSchema=z.array(z.string().min(1).max(200)).max(1000);
/**
 * A connector's reviewed tool risk, declared as data so any connector (core or
 * plugin-provided) gets the same classification wherever its definition goes.
 * Provider hints that mark a tool destructive or writable always win; listed
 * names are matched exactly, and any unlisted name gets `unlisted`.
 */
export const reviewedToolsSchema=z.object({
  reviewedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceUrl:z.string().url().optional(),
  read:reviewedToolNameListSchema.default([]),
  write:reviewedToolNameListSchema.default([]),
  destructive:reviewedToolNameListSchema.default([]),
  unlisted:z.enum(["read","write","destructive"]).default("write"),
  quarantineNewEntries:z.boolean().default(false),
}).strict().superRefine((value,ctx)=>{
  const seen=new Map<string,string>();
  for(const level of ["read","write","destructive"] as const){
    value[level].forEach((name,index)=>{
      const previous=seen.get(name);
      if(previous)ctx.addIssue({code:"custom",message:`Tool ${name} is listed as both ${previous} and ${level}`,path:[level,index]});
      seen.set(name,level);
    });
  }
});
export const appDefinitionSchema=z.object({experimentalFeatureKey:z.enum(INSTANCE_FEATURE_KEYS).optional(),agentInstructions:connectionInstructionTemplateSchema.optional(),aiConnectionRouter:z.object({pluginKey:z.string().min(1)}).optional(),plugin:z.object({pluginKey:z.string().min(1),appSlug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),legacyTools:z.literal(true).optional()}).strict().optional(),reviewedTools:reviewedToolsSchema.optional(),schemaVersion:z.literal(1),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),name:z.string().min(1),description:z.string().min(1),categories:z.array(z.enum(["ai","analytics","commerce","communication","content","data","developer","productivity","other"])).min(1),tags:z.array(z.string().min(1)).optional(),featured:z.boolean().optional(),branding:z.object({logoUrl:appBrandAssetUrlSchema,darkLogoUrl:appBrandAssetUrlSchema.optional(),backgroundColor:z.string().optional(),accentColor:z.string().optional()}),urlPatterns:z.array(z.string()),docsUrl:z.string().url().optional(),setupPrerequisite:z.object({title:z.string().min(1),description:z.string().min(1),steps:z.array(z.string().min(1)).min(1).optional(),actionLabel:z.string().min(1),actionUrl:z.string().url()} ).optional(),redirectConstraints:z.enum(["https-or-loopback-http"]).optional(),methods:z.array(connectionMethodDefSchema),suggestable:z.boolean().optional(),availability:z.object({available:z.boolean(),reason:z.string().optional(),robotEmail:z.string().optional()}).optional(),ownershipAvailability:z.object({platform_shared:z.boolean().optional(),platform_provisioned:z.boolean().optional(),customer:z.boolean().optional(),dcr:z.boolean().optional()}).optional()}).superRefine((value, ctx) => {
  if (value.plugin && value.aiConnectionRouter) ctx.addIssue({ code: "custom", message: "A plugin connector cannot also be a connection pool", path: ["plugin"] });
  if (value.aiConnectionRouter) {
    if (value.methods.length !== 0) ctx.addIssue({ code: "custom", message: "Pooled connectors use existing connections, not authentication methods", path: ["methods"] });
    if (!value.categories.includes("ai")) ctx.addIssue({ code: "custom", message: "Pooled connectors must use the AI category", path: ["categories"] });
  } else if (value.methods.length === 0) {
    ctx.addIssue({ code: "custom", message: "Connectors require at least one connection method", path: ["methods"] });
  }
});
export const appDefinitionsSchema=z.array(appDefinitionSchema).superRefine((v,c)=>{const s=new Set<string>();v.forEach((a,i)=>{if(s.has(a.slug))c.addIssue({code:"custom",message:"Duplicate slug",path:[i,"slug"]});s.add(a.slug)})});
