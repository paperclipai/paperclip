import { describe, expect, it } from "vitest";
import { getConnectableAppDefinition } from "./app-definitions.js";
import { isRemoteMcpConnectorMethod, REMOTE_MCP_CONNECTOR_METHODS } from "./remote-mcp-connectors.js";
import { connectToolAppSchema, finishToolAppSchema } from "./validators/tool-access.js";
import { instanceExperimentalSettingsSchema, patchInstanceExperimentalSettingsSchema } from "./validators/instance.js";
import { INSTANCE_FEATURE_CATALOG } from "./feature-catalog.js";

describe("independent remote MCP connectors", () => {
  it("requires an explicit MCP aggregators opt-in for self-hosted and managed instances", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enableMcpAggregators).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableMcpAggregators: true })).toEqual({ enableMcpAggregators: true });
    expect(patchInstanceExperimentalSettingsSchema.parse({})).not.toHaveProperty("enableMcpAggregators");
    expect(INSTANCE_FEATURE_CATALOG.enableMcpAggregators).toMatchObject({ tier: "managed", cloudDefault: false, selfHostedDefault: false });
  });
  for (const [provider, methodKey] of Object.entries(REMOTE_MCP_CONNECTOR_METHODS)) {
    it(`${provider} has its own catalog and accepts URL plus explicit credentials`, () => {
      const definition = getConnectableAppDefinition(provider)!;
      expect(definition.slug).toBe(provider);
      const method = definition.methods.find((method) => method.key === methodKey)!;
      expect(method.transport).toBe("mcp_remote");
      if (provider !== "zapier") expect(method.ownershipModes).toContain("dcr");
      expect(connectToolAppSchema.safeParse({ galleryKey: provider, connectionMethodKey: methodKey, link: "https://example.com/mcp", authMode: "bearer", credentialValues: { "credentials.authorization": "test-secret", "headers.X-User-ID": "test-user" } }).success).toBe(true);
    });
  }
  it("removes the legacy Composio API-key method", () => {
    expect(isRemoteMcpConnectorMethod("composio", "api-key")).toBe(false);
    expect(getConnectableAppDefinition("composio")?.methods.find((method) => method.key === "api-key")).toBeUndefined();
    expect(connectToolAppSchema.safeParse({ galleryKey: "composio", connectionMethodKey: "api-key", authMode: "bearer" }).success).toBe(false);
  });
  it("allows removing all agent access without changing the tool choices", () => {
    expect(finishToolAppSchema.safeParse({ access: { agentIds: [] } }).success).toBe(true);
    expect(finishToolAppSchema.safeParse({ access: { agentIds: ["not-an-agent-id"] } }).success).toBe(false);
  });
  it("rejects unsafe header overrides and draft saving on unrelated connectors", () => {
    expect(connectToolAppSchema.safeParse({ galleryKey: "arcade", connectionMethodKey: "mcp", credentialValues: { "headers.Host": "evil.example" } }).success).toBe(false);
    expect(connectToolAppSchema.safeParse({ galleryKey: "github", saveDraft: true }).success).toBe(false);
  });
});
