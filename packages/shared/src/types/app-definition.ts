import type { ConnectionGrantKind, ToolConnectionOwnership, ToolConnectionPurpose, ToolConnectionTransport, VercelConnectPrincipalMode } from "./tool-access.js";
export type AppCategory = "ai"|"analytics"|"commerce"|"communication"|"content"|"data"|"developer"|"productivity"|"other";
export type OAuthRedirectConstraints = "https-or-loopback-http";
export const CONNECTION_CREDENTIAL_MINTERS = ["aws_mcp"] as const;
export type ConnectionCredentialMinter = (typeof CONNECTION_CREDENTIAL_MINTERS)[number];
export interface FieldDef { key:string; label:string; type:"text"|"password"|"textarea"|"datetime"|"select"|"checkbox"; required?:boolean; advanced?:boolean; hidden?:boolean; placeholder?:string; helperMd?:string; secret?:boolean; prefix?:string; defaultValue?:string|boolean; validation?:{pattern?:string;maxLength?:number}; options?:Array<{value:string;label:string}>; transport?:{location:"query"|"header";name:string;format?:"string"|"csv"|"boolean";omitFalse?:boolean} }
export const PLUGIN_CONNECTOR_TOOL_TIMEOUT_MIN_MS = 1_000;
export const PLUGIN_CONNECTOR_TOOL_TIMEOUT_MAX_MS = 60_000;
export const PLUGIN_CONNECTOR_TOOL_DEFAULT_TIMEOUT_MS = 30_000;
/** One tool a plugin worker serves for a `transport: "plugin"` method. */
export interface PluginConnectorToolDef { name:string; displayName?:string; description?:string; risk:"read"|"write"|"destructive"; parametersSchema:Record<string,unknown>; timeoutMs?:number }
export type PluginConnectorTools = { kind:"static"; list:PluginConnectorToolDef[] } | { kind:"dynamic" };
export interface ConnectionMethodDef { ai?: import("../ai-connections.js").AiConnectionMetadata; key:string; label?:string; purpose?:ToolConnectionPurpose; provider?:"slack"|"github"|"discord"|"microsoft-teams"|"telegram"|"agentmail"|"imessage-photon"|"speko"; transport:ToolConnectionTransport; settingsSchema?:Record<string,unknown>; tools?:PluginConnectorTools; timeoutMs?:number; auth:"oauth"|"api_key"|"none"; oauthStrategy?:"paperclip_cloud_connector"|"paperclip_id_connector"; connectorProfile?:string; oauthClientSecretRequired?:boolean; oauthClientRegistration?:"dcr";  capabilityProfile?:{key:string;label:string;description?:string}; grantKinds?:ConnectionGrantKind[]; ownershipModes:ToolConnectionOwnership[]; whenToUse:string; defaults?:{serverUrl?:string;serverUrlTemplate?:string;discoveryUrl?:string|null;serviceHost?:string;templateKey?:string;authorizationEndpoint?:string;tokenEndpoint?:string;metadataUrl?:string;scopesHint?:string[];oauthAuthorizationParams?:{access_type?:"offline";prompt?:"consent"};toolArgumentDefaults?:Record<string,unknown>;mcpSessionRequired?:boolean}; tenantFields?:FieldDef[]; extensionFields?:FieldDef[]; configRequirements?:{atLeastOneOf?:string[]}; credentialFields?:FieldDef[]; keyPlacement?:{location:"header"|"query"|"body_json"|"env";name:string;prefix?:string|null}; /** The control plane mints this method's Authorization header at call time; stored credential fields are minter inputs, never headers. */ credentialMinter?:ConnectionCredentialMinter; credentialSources?:{vercelConnect?:{services:string[];principalModes:VercelConnectPrincipalMode[];scopes:string[];header:{name:string;prefix?:string|null}}}; guidanceMd:string; consoleLinks?:{register?:string;keys?:string;settings?:string;docs?:string}; warnings?:string[]; variants?:Array<{key:string;label:string;whenToUse:string;tenantFields?:FieldDef[]}>; riskTier:"S1"|"S2"|"S3"|"S4"; requiredResourceFilters?:string[] }
export interface AppReviewedTools { reviewedAt:string; sourceUrl?:string; read?:string[]; write?:string[]; destructive?:string[]; unlisted?:"read"|"write"|"destructive"; quarantineNewEntries?:boolean }
/** Present only on connectors a plugin provides; `slug` is then namespaced by plugin key. */
export interface AppPluginSource { pluginKey:string; appSlug:string; /** The implicit connector of legacy top-level manifest `tools`. */ legacyTools?:true }
export interface AppDefinition { experimentalFeatureKey?: import("../feature-catalog.js").InstanceFeatureKey; aiConnectionRouter?: { pluginKey: string }; plugin?: AppPluginSource; reviewedTools?: AppReviewedTools; agentInstructions?: import("../connection-instructions.js").ConnectionInstructionTemplate; schemaVersion:1; slug:string; name:string; description:string; categories:AppCategory[]; tags?:string[]; featured?:boolean; branding:{logoUrl:string;darkLogoUrl?:string;backgroundColor?:string;accentColor?:string}; urlPatterns:string[]; docsUrl?:string; setupPrerequisite?:{title:string;description:string;steps?:string[];actionLabel:string;actionUrl:string}; redirectConstraints?:OAuthRedirectConstraints; methods:ConnectionMethodDef[]; suggestable?:boolean; availability?:{available:boolean;reason?:string;robotEmail?:string}; ownershipAvailability?:Partial<Record<ToolConnectionOwnership,boolean>> }

export type SelfServeMcpAuthMode =
  | "dcr"
  | "dcr_cimd"
  | "dcr_or_api_key"
  | "customer_oauth"
  | "api_key"
  | "generated_url"
  | "public"
  | "provider_approval";

export interface SelfServeMcpResearchEntry {
  slug: string;
  name: string;
  wave: 1 | 2 | 3 | 4 | "blocked";
  status: "self_serve" | "blocked";
  docsUrl: string;
  serverUrl: string;
  authMode: SelfServeMcpAuthMode;
  prerequisite: string;
  riskTier: "S1" | "S2" | "S3" | "S4";
  verifiedAt?: string;
}

export interface SelfServeMcpResearchManifest {
  schemaVersion: 1;
  verifiedAt: string;
  entries: SelfServeMcpResearchEntry[];
}
