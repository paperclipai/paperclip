import { describe, expect, it } from "vitest";
import { MEMORY_CONNECTOR_IDS, isMemoryConnectorId } from "./memory-connectors.js";
import { getConnectableAppDefinition, credentialConfigPath } from "./app-definitions.js";
import { INSTANCE_FEATURE_CATALOG } from "./feature-catalog.js";
import { instanceExperimentalSettingsSchema, patchInstanceExperimentalSettingsSchema } from "./validators/instance.js";

describe("experimental memory connectors", () => {
  it("defaults off and preserves patch semantics", () => {
    expect(instanceExperimentalSettingsSchema.parse({}).enableMemoryConnectors).toBe(false);
    expect(patchInstanceExperimentalSettingsSchema.parse({})).not.toHaveProperty("enableMemoryConnectors");
    expect(patchInstanceExperimentalSettingsSchema.parse({ enableMemoryConnectors: true })).toEqual({ enableMemoryConnectors: true });
    expect(INSTANCE_FEATURE_CATALOG.enableMemoryConnectors).toMatchObject({ tier: "managed", selfHostedDefault: false, cloudDefault: false });
    expect(isMemoryConnectorId("notion")).toBe(false);
  });
  it.each(MEMORY_CONNECTOR_IDS)("has a supported, branded %s setup method", (slug) => {
    const app = getConnectableAppDefinition(slug)!;
    expect(app).toBeDefined();
    expect(app.branding.logoUrl).toMatch(new RegExp(`/brands/apps/${slug}\\.`));
    expect(app.methods).toHaveLength(1);
    expect(app.methods[0]!.transport).toBe(slug === "cognee" ? "local_stdio" : "mcp_remote");
  });
  it("uses provider-documented auth and endpoint paths", () => {
    const method = (slug: string) => getConnectableAppDefinition(slug)!.methods[0]!;
    expect(method("mem0")).toMatchObject({ auth: "api_key", defaults: { serverUrl: "https://mcp.mem0.ai/mcp/" }, keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " } });
    expect(method("honcho")).toMatchObject({ auth: "api_key", defaults: { serverUrl: "https://mcp.honcho.dev" }, keyPlacement: { location: "header", name: "Authorization", prefix: "Bearer " } });
    expect(method("zep")).toMatchObject({ auth: "oauth", grantKinds: ["user"], ownershipModes: ["dcr"], defaults: { serverUrl: "https://api.getzep.com/mcp", scopesHint: ["graph:read", "graph:write"] } });
    expect(method("supermemory")).toMatchObject({ auth: "oauth", grantKinds: ["user"], defaults: { serverUrl: "https://mcp.supermemory.ai/mcp" } });
    const cognee = method("cognee");
    expect(cognee.defaults).toEqual({ templateKey: "paperclip.cognee-cloud" });
    expect(cognee.credentialFields!.map(field => credentialConfigPath(field, cognee))).toEqual(["env.COGNEE_BASE_URL", "env.COGNEE_API_KEY"]);
    expect(credentialConfigPath(method("mem0").credentialFields![0]!, method("mem0"))).toBe("credentials.authorization");
  });
});
