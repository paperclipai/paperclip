export const ASANA_CONNECTOR_PROFILE_ID = "asana.mcp" as const;
export type AsanaConnectorProfileId = typeof ASANA_CONNECTOR_PROFILE_ID;

export const ASANA_MCP_URL = "https://mcp.asana.com/v2/mcp";
export const ASANA_MCP_DISCOVERY_URL = "https://mcp.asana.com/.well-known/oauth-protected-resource/v2";
export const ASANA_CONNECTOR_SCOPES = ["default"] as const;

export function isAsanaConnectorProfileId(value: string): value is AsanaConnectorProfileId {
  return value === ASANA_CONNECTOR_PROFILE_ID;
}
