import { describe, expect, it } from "vitest";
import { PLUGIN_CAPABILITIES } from "../constants.js";
import { pluginManagedRoutineDeclarationSchema, pluginManifestV1Schema, pluginUiSlotDeclarationSchema } from "./plugin.js";

describe("plugin capability constants", () => {
  it("exposes each capability once", () => {
    expect(new Set(PLUGIN_CAPABILITIES).size).toBe(PLUGIN_CAPABILITIES.length);
  });
});

describe("plugin managed routine validators", () => {
  it("accepts core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.parse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "default" },
    });

    expect(parsed.issueTemplate?.surfaceVisibility).toBe("default");
  });

  it("rejects non-core issue surface visibility values in routine templates", () => {
    const parsed = pluginManagedRoutineDeclarationSchema.safeParse({
      routineKey: "wiki.refresh",
      title: "Refresh Wiki",
      issueTemplate: { surfaceVisibility: "normal" },
    });

    expect(parsed.success).toBe(false);
  });
});

describe("plugin managed skill validators", () => {
  const baseManifest = {
    id: "paperclip.test-managed-skills",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Managed Skills",
    description: "Managed skills test plugin.",
    author: "Paperclip",
    categories: ["automation"],
    entrypoints: { worker: "./dist/worker.js" },
  } as const;

  it("requires skills.managed when managed skills are declared", () => {
    const parsed = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: [],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("skills.managed"))).toBe(true);
  });

  it("accepts managed skills with the skills.managed capability", () => {
    const parsed = pluginManifestV1Schema.parse({
      ...baseManifest,
      capabilities: ["skills.managed"],
      skills: [{ skillKey: "wiki-maintainer", displayName: "Wiki Maintainer" }],
    });

    expect(parsed.skills?.[0]?.skillKey).toBe("wiki-maintainer");
  });
});

describe("plugin UI slot validators", () => {
  it("accepts route-scoped sidebar slots with a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.parse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
      routePath: "wiki",
    });

    expect(parsed.routePath).toBe("wiki");
  });

  it("requires route-scoped sidebar slots to declare a routePath", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "wiki-route-sidebar",
      displayName: "Wiki Sidebar",
      exportName: "WikiSidebar",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toBe("routeSidebar slots require routePath");
  });

  it("keeps reserved company route protection for route-scoped sidebars", () => {
    const parsed = pluginUiSlotDeclarationSchema.safeParse({
      type: "routeSidebar",
      id: "settings-route-sidebar",
      displayName: "Settings Sidebar",
      exportName: "SettingsSidebar",
      routePath: "settings",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.message.includes("reserved by the host"))).toBe(true);
  });
});
