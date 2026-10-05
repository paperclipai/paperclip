import { describe, expect, it } from "vitest";
import { connectionAgentInstructionsSchema, connectionInstructionContext, defaultConnectionAgentInstructions } from "./connection-instructions.js";
import { getConnectableAppDefinition } from "./app-definitions.js";
import { connectToolAppSchema, createToolConnectionSchema, finishToolAppSchema, updateToolConnectionSchema } from "./validators/tool-access.js";
import { appDefinitionSchema } from "./validators/app-definition.js";

describe("generic connection instructions", () => {
  it.each(["honcho", "mem0", "zep", "supermemory", "cognee"])("validates and enables the reviewed %s default", (slug) => {
    const app = appDefinitionSchema.parse(getConnectableAppDefinition(slug));
    const settings = connectionAgentInstructionsSchema.parse(defaultConnectionAgentInstructions(app.agentInstructions));
    expect(settings.enabled).toBe(true);
    expect(settings.template?.version).toBeGreaterThan(0);
    expect(settings.text).toContain("current task");
    expect(settings.text).toContain("approvals");
  });
  it("supports non-memory templates and saved settings without a template", () => {
    const app = { ...getConnectableAppDefinition("notion")!, agentInstructions: { id: "handbook", version: 1, text: "Consult the current release checklist." } };
    expect(appDefinitionSchema.parse(app).agentInstructions).toEqual(app.agentInstructions);
    const value = { enabled: false, text: "Keep this custom paragraph." };
    expect(updateToolConnectionSchema.parse({ agentInstructions: value }).agentInstructions).toEqual(value);
    expect(connectToolAppSchema.parse({ galleryKey: "notion", agentInstructions: value }).agentInstructions).toEqual(value);
    expect(finishToolAppSchema.parse({ enabledCatalogEntryIds: [], askFirstCatalogEntryIds: [], access: "all_agents", agentInstructions: value }).agentInstructions).toEqual(value);
    expect(createToolConnectionSchema.parse({ name: "Handbook", transport: "mcp_remote", agentInstructions: value }).agentInstructions).toEqual(value);
    expect(defaultConnectionAgentInstructions(getConnectableAppDefinition("notion")?.agentInstructions)).toBeNull();
  });
  it("withholds unconfigured instructions and never includes secret fields", () => {
    const app = getConnectableAppDefinition("honcho")!;
    expect(connectionInstructionContext(app, { methodConfig: { workspaceId: " " } })).toBeNull();
    expect(connectionInstructionContext(app, { methodConfig: { workspaceId: " team ", apiKey: "secret" } })).toEqual({ workspaceId: "team" });
  });
  it("allows explicit clearing and rejects blank or unbounded text", () => {
    expect(updateToolConnectionSchema.parse({ agentInstructions: null }).agentInstructions).toBeNull();
    expect(connectionAgentInstructionsSchema.safeParse({ enabled: true, text: " " }).success).toBe(false);
    expect(connectionAgentInstructionsSchema.safeParse({ enabled: true, text: "a".repeat(2001) }).success).toBe(false);
  });
});
