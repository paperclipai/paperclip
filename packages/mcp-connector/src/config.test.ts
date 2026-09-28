import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConnectorConfigError, loadConnectorConfig } from "./config.js";

describe("loadConnectorConfig", () => {
  it("reads upstreams from the environment shorthand", () => {
    const config = loadConnectorConfig({
      env: {
        PAPERCLIP_URL: "https://paperclip.example.com/",
        PAPERCLIP_MCP_CONNECTOR_UPSTREAMS: "unifi=http://unifi-network-mcp.unifi-mcp.svc:3000/mcp, nas=http://10.0.0.5:8080/mcp",
        PAPERCLIP_MCP_CONNECTOR_ENROLLMENT_TOKEN: " pcmce_x ",
      },
    });
    expect(config.paperclipUrl).toBe("https://paperclip.example.com");
    expect([...config.upstreams.keys()]).toEqual(["unifi", "nas"]);
    expect(config.upstreams.get("unifi")?.url).toBe("http://unifi-network-mcp.unifi-mcp.svc:3000/mcp");
    expect(config.enrollmentToken).toBe("pcmce_x");
  });

  it("reads a config file and resolves env: header references", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-connector-config-"));
    const path = join(dir, "connector.json");
    writeFileSync(path, JSON.stringify({
      paperclipUrl: "https://paperclip.example.com",
      credentialsFile: "/var/lib/connector/credentials.json",
      upstreams: { unifi: { url: "http://unifi:3000/mcp", headers: { Authorization: "env:UNIFI_TOKEN" } } },
    }));
    const config = loadConnectorConfig({ configPath: path, env: { UNIFI_TOKEN: "Bearer secret" } });
    expect(config.upstreams.get("unifi")?.headers).toEqual({ authorization: "Bearer secret" });
    expect(config.credentialsFile).toBe("/var/lib/connector/credentials.json");
    expect(() => loadConnectorConfig({ configPath: path, env: {} })).toThrow(ConnectorConfigError);
  });

  it.each([
    ["Bad Name", "http://unifi/mcp"],
    ["unifi", "file:///etc/passwd"],
    ["unifi", "http://user:pass@unifi/mcp"],
    ["unifi", "not a url"],
  ])("rejects upstream %s=%s", (name, url) => {
    expect(() => loadConnectorConfig({
      env: { PAPERCLIP_URL: "https://paperclip.example.com", PAPERCLIP_MCP_CONNECTOR_UPSTREAMS: JSON.stringify({ [name]: url }) },
    })).toThrow(ConnectorConfigError);
  });

  it("rejects transport headers and a missing Paperclip URL or upstream list", () => {
    expect(() => loadConnectorConfig({
      env: {
        PAPERCLIP_URL: "https://paperclip.example.com",
        PAPERCLIP_MCP_CONNECTOR_UPSTREAMS: JSON.stringify({ unifi: { url: "http://unifi/mcp", headers: { Host: "evil" } } }),
      },
    })).toThrow(/not allowed/);
    expect(() => loadConnectorConfig({ env: { PAPERCLIP_MCP_CONNECTOR_UPSTREAMS: "unifi=http://unifi/mcp" } })).toThrow(/PAPERCLIP_URL/);
    expect(() => loadConnectorConfig({ env: { PAPERCLIP_URL: "https://paperclip.example.com" } })).toThrow(/at least one upstream/);
  });
});
