export type McpDiscoveryProfile = "personal-mcp" | "dot-mcp";
export interface McpDiscovery {
  origin: string;
  authorizationOrigin: string;
  profiles: McpDiscoveryProfile[];
}
const profiles = ["personal-mcp","dot-mcp"] as const;
function origin(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid MCP discovery origin");
  const url = new URL(value);
  if (url.origin !== value || url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("Invalid MCP discovery origin");
  return value;
}
export function parseMcpDiscovery(value: unknown): McpDiscovery {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid MCP discovery snapshot");
  const row = value as Record<string,unknown>;
  const selected=row.profiles;
  if (Object.keys(row).sort().join() !== "authorizationOrigin,origin,profiles" || !Array.isArray(selected) || !selected.length || selected.length > 2
    || selected.some((profile,index) => !profiles.includes(profile) || index > 0 && profiles.indexOf(profile) <= profiles.indexOf(selected[index-1]))) throw new Error("Invalid MCP discovery profiles");
  return { origin: origin(row.origin), authorizationOrigin: origin(row.authorizationOrigin), profiles: selected as McpDiscoveryProfile[] };
}
export function mcpDiscoveryDocuments(raw: McpDiscovery): Array<{ path: string; document: Record<string,unknown> }> {
  const input = parseMcpDiscovery(raw), documents: Array<{ path: string; document: Record<string,unknown> }> = [];
  for (const profile of input.profiles) {
    const dot = profile === "dot-mcp", endpoint = dot ? "/mcp/runner" : "/mcp/paperclip", oauthPath = dot ? "/mcp/runner/oauth" : "/mcp/oauth";
    const issuer = dot ? input.origin + oauthPath : input.origin, prefix = input.origin + oauthPath;
    const scopes = dot ? ["paperclip:agent","offline_access"] : ["paperclip:read","paperclip:write","paperclip:configure","offline_access"];
    const resource = { resource: input.origin + endpoint, authorization_servers: [issuer], scopes_supported: dot ? scopes : scopes.slice(0,3), bearer_methods_supported: ["header"], resource_name: dot ? "Paperclip agent" : "Paperclip" };
    if (!dot) documents.push({ path: "/.well-known/oauth-protected-resource", document: resource });
    documents.push({ path: "/.well-known/oauth-protected-resource" + endpoint, document: resource });
    documents.push({ path: "/.well-known/oauth-authorization-server" + (dot ? oauthPath : ""), document: {
      issuer, authorization_endpoint: input.authorizationOrigin + oauthPath + "/authorize", token_endpoint: prefix + "/token", registration_endpoint: prefix + "/register", revocation_endpoint: prefix + "/revoke",
      response_types_supported: ["code"], grant_types_supported: ["authorization_code","refresh_token","urn:ietf:params:oauth:grant-type:device_code"], device_authorization_endpoint: prefix + "/device_authorization",
      token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], scopes_supported: scopes,
      authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: true,
    } });
  }
  return documents;
}
