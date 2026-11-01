import { describe, expect, it, vi } from "vitest";
import { createClientMetadataResolver, mcpRedirectMatches } from "../services/public-mcp/client-metadata.js";
import { mcpInvitation, mcpSetupMarkdown } from "@paperclipai/shared";
import { renderMcpSetup } from "../services/public-mcp/setup.js";

const id = "https://assistant.example/client.json";
const document = { client_id: id, client_name: "Example", redirect_uris: ["http://127.0.0.1:1234/callback"] };
const response = (data: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json", ...headers } });
describe("public MCP client metadata", () => {
  it("allows only the port to change for declared native loopback clients", () => {
    const registered = ["http://127.0.0.1/callback", "http://localhost/callback", "http://[::1]/callback"];
    for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(mcpRedirectMatches(registered, `http://${host}:55023/callback`, true)).toBe(true);
      expect(mcpRedirectMatches(registered, `http://${host}:55023/callback`, false)).toBe(false);
    }
    for (const uri of ["http://127.0.0.1:55023/other", "http://127.0.0.1:55023/callback?next=evil", "http://127.0.0.1:55023/callback#code", "http://127.0.0.1.evil.test:55023/callback", "http://evil@127.0.0.1:55023/callback", "https://127.0.0.1:55023/callback", "http://127.0.0.2:55023/callback"]) {
      expect(mcpRedirectMatches(registered, uri, true)).toBe(false);
    }
    expect(mcpRedirectMatches(["https://example.com/callback"], "https://example.com:55023/callback", true)).toBe(false);
    expect(mcpRedirectMatches(["http://127.0.0.1/callback"], "http://localhost:55023/callback", true)).toBe(false);
  });
  it("validates the client identity and bounds cache reuse", async () => {
    const fetch = vi.fn(async () => response(document, { "cache-control": "max-age=300" }));
    const resolve = createClientMetadataResolver(fetch);
    expect((await resolve(id)).client_name).toBe("Example");
    await resolve(id); expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toEqual(new URL(id));
  });
  it("selects implemented grants from a client's broader published capabilities", async () => {
    const metadata = { ...document, redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"] };
    expect((await createClientMetadataResolver(async () => response(metadata))(id)).grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect((await createClientMetadataResolver(async () => response({ ...metadata, grant_types: ["client_credentials"] }))(id)).grant_types).toEqual([]);
    await expect(createClientMetadataResolver(async () => response({ ...metadata, grant_types: [null] }))(id)).rejects.toThrow();
  });
  it("selects public PKCE only when broader client authentication capabilities include none", async () => {
    const metadata = { ...document, token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"] };
    expect((await createClientMetadataResolver(async () => response(metadata))(id)).token_endpoint_auth_method).toBe("none");
    for (const unsupported of [
      { ...metadata, token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { ...metadata, token_endpoint_auth_methods_supported: undefined },
      { ...metadata, token_endpoint_auth_method: "none", token_endpoint_auth_methods_supported: ["private_key_jwt"] },
      { ...metadata, token_endpoint_auth_methods_supported: [null] },
    ]) await expect(createClientMetadataResolver(async () => response(unsupported))(id)).rejects.toThrow();
  });
  it("recognizes older loopback-only native metadata without widening declared web clients", async () => {
    expect((await createClientMetadataResolver(async () => response(document))(id)).application_type).toBe("native");
    expect((await createClientMetadataResolver(async () => response({ ...document, application_type: "web" }))(id)).application_type).toBe("web");
    expect((await createClientMetadataResolver(async () => response({ ...document, redirect_uris: [...document.redirect_uris, "https://remote.example/callback"] }))(id)).application_type).toBeUndefined();
  });
  it.each([
    { ...document, client_id: "https://other.example/client.json" },
    { ...document, redirect_uris: ["https://name:secret@example.com/callback"] },
    { ...document, token_endpoint_auth_method: "client_secret_post" },
    { ...document, client_name: "x".repeat(33000) },
  ])("rejects mismatched or unsafe metadata", async data => {
    await expect(createClientMetadataResolver(async () => response(data))(id)).rejects.toThrow();
  });
  it("never follows redirects and honors no-store", async () => {
    await expect(createClientMetadataResolver(async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }))(id)).rejects.toThrow();
    const fetch = vi.fn(async () => response(document, { "cache-control": "no-store" }));
    const resolve = createClientMetadataResolver(fetch); await resolve(id); await resolve(id);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each(["https://127.0.0.1/client.json", "https://169.254.169.254/client.json", "https://[::1]/client.json", "http://assistant.example/client.json"])("rejects private or insecure metadata URL %s", async url => {
    await expect(createClientMetadataResolver()(url)).rejects.toThrow();
  });
});
describe("assistant invitation content", () => {
  it("contains no credential and tells a cold client to verify actual access", () => {
    const resource = "https://paperclip.example/mcp/paperclip";
    const company = { id: "44444444-4444-4444-8444-444444444444", name: "Butter" };
    expect(mcpInvitation(resource, company)).toContain("company=" + company.id);
    const markdown = mcpSetupMarkdown(resource, company.id);
    expect(markdown).toContain("paperclip_connection");
    expect(markdown).toContain("restart");
    expect(markdown).not.toContain("paperclip_whoami");
    expect(markdown).not.toContain("pcmcp_at_");
    expect(renderMcpSetup(resource, company.id)).toContain("Instructions for assistants");
    expect(renderMcpSetup(resource, company.id)).not.toContain(company.name);
  });
});
