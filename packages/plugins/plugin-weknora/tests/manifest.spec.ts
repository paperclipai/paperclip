import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "../../../shared/dist/index.js";
import manifest, { SKILL_KEYS, TOOL_NAMES } from "../src/manifest.js";
import { normalizeBaseUrl, normalizeConfig } from "../src/config.js";

describe("WeKnora manifest and config contract", () => {
  it("declares the exact thin connector boundary", () => {
    expect(pluginManifestV1Schema.safeParse(manifest)).toMatchObject({ success: true });
    expect(manifest.id).toBe("paperclipai.plugin-weknora");
    expect(manifest.capabilities).toEqual([
      "http.outbound", "secrets.read-ref", "instance.settings.register", "agent.tools.register",
      "api.routes.register", "ui.sidebar.register", "ui.page.register", "skills.managed",
      "agents.managed", "projects.managed", "routines.managed", "activity.log.write", "metrics.write",
    ]);
    expect(manifest.database).toBeUndefined();
    expect(manifest.localFolders).toBeUndefined();
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(Object.values(TOOL_NAMES));
    expect(manifest.tools).toHaveLength(7);
    for (const tool of manifest.tools ?? []) {
      expect(tool.parametersSchema.properties).toHaveProperty("companyId", { type: "string" });
      expect(tool.parametersSchema.required).toContain("companyId");
    }
    expect(manifest.tools?.some((tool) => /ingest|fix|rebuild|write/i.test(tool.name))).toBe(false);
    expect(manifest.skills?.map((skill) => skill.skillKey)).toEqual([...SKILL_KEYS]);
    expect(manifest.agents?.every((agent) => agent.status === "paused")).toBe(true);
    expect(manifest.routines?.every((routine) => routine.status === "paused" && routine.triggers?.every((trigger) => trigger.enabled === false))).toBe(true);
    expect(manifest.instanceConfigSchema?.properties).toMatchObject({ apiKeyRef: { format: "secret-ref" }, resourceUrls: { default: "handle" }, enableWriteActions: { default: false } });
  });

  it("normalizes the API root and validates the secret boundary", () => {
    expect(normalizeBaseUrl("https://weknora.example/" )).toBe("https://weknora.example/api/v1");
    expect(normalizeBaseUrl("https://weknora.example/api/v1/" )).toBe("https://weknora.example/api/v1");
    expect(() => normalizeBaseUrl("https://user:pass@weknora.example")).toThrow(/credentials/);
    expect(() => normalizeBaseUrl("https://weknora.example#secret")).toThrow(/fragment/);
    expect(normalizeConfig({ baseUrl: "https://weknora.example", apiKeyRef: { type: "secret_ref", secretId: "secret-1" } })).toMatchObject({
      baseUrl: "https://weknora.example/api/v1",
      defaultKnowledgeBaseIds: [],
      maxResults: 8,
      resourceUrls: "handle",
      enableWriteActions: false,
    });
  });
});
