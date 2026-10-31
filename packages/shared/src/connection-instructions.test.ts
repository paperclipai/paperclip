import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("regenerates templates from each app definition, including non-memory edits and removal", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const fixture = mkdtempSync(join(tmpdir(), "paperclip-app-instructions-"));
    const definitions = join(fixture, "packages/shared/src/app-definitions");
    const readApp = (slug: string) => JSON.parse(readFileSync(join(definitions, `${slug}.json`), "utf8"));
    const writeApp = (slug: string, app: unknown) => writeFileSync(join(definitions, `${slug}.json`), JSON.stringify(app));
    const generate = () => execFileSync(process.execPath, [join(root, "scripts/ingest-app-definitions.mjs"), "--definitions-only"], { cwd: fixture, stdio: "pipe" });
    try {
      for (const source of [
        "ui/public/brands/apps/manifest.json",
        "packages/shared/src/self-serve-mcp-research.json",
        "doc/connections/tool-method-permission-reviews.json",
        "packages/shared/src/app-definitions",
        "scripts/app-definition-overrides",
      ]) {
        mkdirSync(dirname(join(fixture, source)), { recursive: true });
        cpSync(join(root, source), join(fixture, source), { recursive: true });
      }
      const notion = readApp("notion");
      notion.agentInstructions = { id: "notion.handbook", version: 2, text: "Consult the current release checklist." };
      writeApp("notion", notion);
      generate();
      expect(readApp("notion").agentInstructions).toEqual(notion.agentInstructions);
      for (const slug of ["honcho", "mem0", "zep", "supermemory", "cognee"]) {
        expect(readApp(slug).agentInstructions).toEqual(getConnectableAppDefinition(slug)?.agentInstructions);
      }
      expect(readApp("linear").agentInstructions).toBeUndefined();

      notion.agentInstructions.text = "Check the updated handbook before a release.";
      notion.agentInstructions.version++;
      writeApp("notion", notion);
      const mem0 = readApp("mem0");
      delete mem0.agentInstructions;
      writeApp("mem0", mem0);
      generate();
      expect(readApp("notion").agentInstructions).toEqual(notion.agentInstructions);
      expect(readApp("mem0").agentInstructions).toBeUndefined();

      notion.agentInstructions.text = " ";
      writeApp("notion", notion);
      expect(generate).toThrow("notion: invalid agent instruction template");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
