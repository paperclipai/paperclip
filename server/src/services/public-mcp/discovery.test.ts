import { describe, expect, it } from "vitest";
import { mcpDiscoveryDocuments, parseMcpDiscovery } from "./discovery.js";
import { createMcpWakeAdmission, parseMcpWakeAdmission } from "./wake-admission.js";
import { DOT_RUNNER_MCP_SCOPES, PUBLIC_MCP_SCOPES } from "@paperclipai/shared";
const snapshot = { origin: "https://tenant.example.test", authorizationOrigin: "https://browser.example.test", profiles: ["personal-mcp","dot-mcp"] as ("personal-mcp"|"dot-mcp")[] };
describe("MCP owner discovery snapshot",()=>{
  it("preserves dedicated issuers, real scope contracts and configured browser authorization origin",()=>{
    const documents = mcpDiscoveryDocuments(snapshot);
    expect(documents).toHaveLength(5);
    const personal = documents.find(entry=>entry.path==="/.well-known/oauth-authorization-server")!.document;
    expect(personal).toMatchObject({issuer:snapshot.origin,authorization_endpoint:snapshot.authorizationOrigin+"/mcp/oauth/authorize",token_endpoint:snapshot.origin+"/mcp/oauth/token",scopes_supported:[...PUBLIC_MCP_SCOPES],client_id_metadata_document_supported:true});
    const dot = documents.find(entry=>entry.path==="/.well-known/oauth-authorization-server/mcp/runner/oauth")!.document;
    expect(dot).toMatchObject({issuer:snapshot.origin+"/mcp/runner/oauth",authorization_endpoint:snapshot.authorizationOrigin+"/mcp/runner/oauth/authorize",scopes_supported:[...DOT_RUNNER_MCP_SCOPES]});
    expect(documents.find(entry=>entry.path==="/.well-known/oauth-protected-resource/mcp/paperclip")!.document.scopes_supported).toEqual(["paperclip:read","paperclip:write","paperclip:configure"]);
    expect(mcpDiscoveryDocuments({...snapshot,profiles:["personal-mcp"]}).some(entry=>entry.path.includes("runner"))).toBe(false);
  });
  it("binds public snapshot changes to the private cycle generation and rejects unfamiliar shapes",()=>{
    const input = { stackId:"stack",ownerId:"00000000-0000-4000-8000-000000000001",capabilityGeneration:"a".repeat(64),challenge:"c".repeat(64),tokens:[] };
    const old = createMcpWakeAdmission(input), current = createMcpWakeAdmission({...input,discovery:snapshot});
    expect(parseMcpWakeAdmission(old)).toEqual(old);
    expect(current.generation).not.toBe(old.generation);
    expect(()=>parseMcpWakeAdmission({...current,discovery:{...snapshot,authorizationOrigin:"https://changed.example.test"}})).toThrow();
    for(const change of [{profiles:["muse"]},{profiles:["dot-mcp","personal-mcp"]},{origin:"https://tenant.example.test/path"},{enabled:true},{profiles:[]}])expect(()=>parseMcpDiscovery({...snapshot,...change})).toThrow();
  });
});
