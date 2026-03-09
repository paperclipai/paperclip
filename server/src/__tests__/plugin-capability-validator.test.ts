import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid manifest with the given capabilities. */
function buildManifest(
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "test-plugin",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A test plugin",
    categories: ["connector"],
    capabilities: [],
    entrypoints: { worker: "worker.js" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator", () => {
  const validator = pluginCapabilityValidator();

  // -----------------------------------------------------------------------
  // hasCapability
  // -----------------------------------------------------------------------

  describe("hasCapability", () => {
    it("returns true when the manifest declares the capability", () => {
      const manifest = buildManifest({ capabilities: ["issues.read", "issues.create"] });
      expect(validator.hasCapability(manifest, "issues.read")).toBe(true);
      expect(validator.hasCapability(manifest, "issues.create")).toBe(true);
    });

    it("returns false when the manifest does not declare the capability", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      expect(validator.hasCapability(manifest, "issues.create")).toBe(false);
    });

    it("returns false for an empty capabilities array", () => {
      const manifest = buildManifest({ capabilities: [] });
      expect(validator.hasCapability(manifest, "issues.read")).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // hasAllCapabilities
  // -----------------------------------------------------------------------

  describe("hasAllCapabilities", () => {
    it("returns allowed=true when all capabilities are declared", () => {
      const manifest = buildManifest({
        capabilities: ["issues.read", "issues.create", "issues.update"],
      });
      const result = validator.hasAllCapabilities(manifest, [
        "issues.read",
        "issues.create",
      ]);
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns allowed=false with missing capabilities listed", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      const result = validator.hasAllCapabilities(manifest, [
        "issues.read",
        "issues.create",
        "issues.update",
      ]);
      expect(result.allowed).toBe(false);
      expect(result.missing).toEqual(["issues.create", "issues.update"]);
    });

    it("returns allowed=true for an empty requirements list", () => {
      const manifest = buildManifest({ capabilities: [] });
      const result = validator.hasAllCapabilities(manifest, []);
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("includes pluginId in the result", () => {
      const manifest = buildManifest({ id: "my-plugin", capabilities: [] });
      const result = validator.hasAllCapabilities(manifest, ["issues.read"]);
      expect(result.pluginId).toBe("my-plugin");
    });
  });

  // -----------------------------------------------------------------------
  // hasAnyCapability
  // -----------------------------------------------------------------------

  describe("hasAnyCapability", () => {
    it("returns true when at least one capability is declared", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      expect(
        validator.hasAnyCapability(manifest, ["issues.read", "issues.create"]),
      ).toBe(true);
    });

    it("returns false when no capabilities match", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      expect(
        validator.hasAnyCapability(manifest, ["issues.create", "issues.update"]),
      ).toBe(false);
    });

    it("returns false for empty requirements", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      expect(validator.hasAnyCapability(manifest, [])).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // checkOperation
  // -----------------------------------------------------------------------

  describe("checkOperation", () => {
    it("allows a known operation when the plugin has the required capability", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      const result = validator.checkOperation(manifest, "issues.list");
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.operation).toBe("issues.list");
    });

    it("rejects a known operation when capability is missing", () => {
      const manifest = buildManifest({ capabilities: [] });
      const result = validator.checkOperation(manifest, "issues.create");
      expect(result.allowed).toBe(false);
      expect(result.missing).toEqual(["issues.create"]);
      expect(result.operation).toBe("issues.create");
    });

    it("rejects an unknown operation by default", () => {
      const manifest = buildManifest({
        capabilities: ["issues.read", "issues.create"],
      });
      const result = validator.checkOperation(manifest, "unknown.operation");
      expect(result.allowed).toBe(false);
      expect(result.operation).toBe("unknown.operation");
    });

    it("checks data-write operations correctly", () => {
      const manifest = buildManifest({ capabilities: ["issues.create"] });
      expect(validator.checkOperation(manifest, "issues.create").allowed).toBe(true);
      expect(validator.checkOperation(manifest, "issues.update").allowed).toBe(false);
    });

    it("checks plugin state operations correctly", () => {
      const manifest = buildManifest({
        capabilities: ["plugin.state.read", "plugin.state.write"],
      });
      expect(validator.checkOperation(manifest, "plugin.state.get").allowed).toBe(true);
      expect(validator.checkOperation(manifest, "plugin.state.set").allowed).toBe(true);
    });

    it("checks runtime operations correctly", () => {
      const manifest = buildManifest({ capabilities: ["http.outbound"] });
      expect(validator.checkOperation(manifest, "http.request").allowed).toBe(true);
      expect(validator.checkOperation(manifest, "events.subscribe").allowed).toBe(false);
    });

    it("checks agent tool operations correctly", () => {
      const manifest = buildManifest({ capabilities: ["agent.tools.register"] });
      expect(validator.checkOperation(manifest, "agent.tools.register").allowed).toBe(true);
      expect(validator.checkOperation(manifest, "agent.tools.execute").allowed).toBe(true);
    });

    it("includes pluginId in the result", () => {
      const manifest = buildManifest({ id: "my-plugin", capabilities: [] });
      const result = validator.checkOperation(manifest, "issues.list");
      expect(result.pluginId).toBe("my-plugin");
    });
  });

  // -----------------------------------------------------------------------
  // assertOperation
  // -----------------------------------------------------------------------

  describe("assertOperation", () => {
    it("does not throw when the plugin has the required capability", () => {
      const manifest = buildManifest({ capabilities: ["issues.read"] });
      expect(() => validator.assertOperation(manifest, "issues.list")).not.toThrow();
    });

    it("throws a 403 HttpError when capability is missing", () => {
      const manifest = buildManifest({ id: "bad-plugin", capabilities: [] });
      expect(() => validator.assertOperation(manifest, "issues.create")).toThrow(
        /Plugin 'bad-plugin' is not allowed to perform 'issues.create'/,
      );
    });

    it("throws for unknown operations", () => {
      const manifest = buildManifest({ id: "test-plugin", capabilities: [] });
      expect(() => validator.assertOperation(manifest, "unknown.op")).toThrow(
        /Plugin 'test-plugin' attempted unknown operation 'unknown.op'/,
      );
    });

    it("thrown error has status 403", () => {
      const manifest = buildManifest({ capabilities: [] });
      try {
        validator.assertOperation(manifest, "issues.create");
        expect.unreachable("should have thrown");
      } catch (error: unknown) {
        expect((error as { status: number }).status).toBe(403);
      }
    });
  });

  // -----------------------------------------------------------------------
  // assertCapability
  // -----------------------------------------------------------------------

  describe("assertCapability", () => {
    it("does not throw when the capability is present", () => {
      const manifest = buildManifest({ capabilities: ["http.outbound"] });
      expect(() => validator.assertCapability(manifest, "http.outbound")).not.toThrow();
    });

    it("throws a 403 HttpError when the capability is missing", () => {
      const manifest = buildManifest({ id: "my-plugin", capabilities: [] });
      expect(() => validator.assertCapability(manifest, "http.outbound")).toThrow(
        /Plugin 'my-plugin' lacks required capability 'http.outbound'/,
      );
    });

    it("thrown error has status 403", () => {
      const manifest = buildManifest({ capabilities: [] });
      try {
        validator.assertCapability(manifest, "events.emit");
        expect.unreachable("should have thrown");
      } catch (error: unknown) {
        expect((error as { status: number }).status).toBe(403);
      }
    });
  });

  // -----------------------------------------------------------------------
  // checkUiSlot
  // -----------------------------------------------------------------------

  describe("checkUiSlot", () => {
    it("allows a sidebar slot when the capability is declared", () => {
      const manifest = buildManifest({ capabilities: ["ui.sidebar.register"] });
      const result = validator.checkUiSlot(manifest, "sidebar");
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("rejects a page slot when the capability is missing", () => {
      const manifest = buildManifest({ capabilities: [] });
      const result = validator.checkUiSlot(manifest, "page");
      expect(result.allowed).toBe(false);
      expect(result.missing).toEqual(["ui.page.register"]);
    });

    it("checks detailTab capability correctly", () => {
      const manifest = buildManifest({ capabilities: ["ui.detailTab.register"] });
      expect(validator.checkUiSlot(manifest, "detailTab").allowed).toBe(true);
    });

    it("checks dashboardWidget capability correctly", () => {
      const manifest = buildManifest({ capabilities: ["ui.dashboardWidget.register"] });
      expect(validator.checkUiSlot(manifest, "dashboardWidget").allowed).toBe(true);
    });

    it("checks settingsPage capability correctly", () => {
      const manifest = buildManifest({
        capabilities: ["instance.settings.register"],
      });
      expect(validator.checkUiSlot(manifest, "settingsPage").allowed).toBe(true);
    });

    it("requires ui.sidebar.register for projectSidebarItem slot", () => {
      const manifest = buildManifest({ capabilities: ["ui.sidebar.register"] });
      const result = validator.checkUiSlot(manifest, "projectSidebarItem");
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("rejects projectSidebarItem slot when ui.sidebar.register is missing", () => {
      const manifest = buildManifest({ capabilities: [] });
      const result = validator.checkUiSlot(manifest, "projectSidebarItem");
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("ui.sidebar.register");
    });

    it("includes pluginId and operation in the result", () => {
      const manifest = buildManifest({ id: "ui-plugin", capabilities: [] });
      const result = validator.checkUiSlot(manifest, "sidebar");
      expect(result.pluginId).toBe("ui-plugin");
      expect(result.operation).toBe("ui.sidebar.register");
    });
  });

  // -----------------------------------------------------------------------
  // validateManifestCapabilities
  // -----------------------------------------------------------------------

  describe("validateManifestCapabilities", () => {
    it("returns allowed=true for a manifest with no features", () => {
      const manifest = buildManifest({ capabilities: [] });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("returns allowed=true when tools + capability are consistent", () => {
      const manifest = buildManifest({
        capabilities: ["agent.tools.register"],
        tools: [
          {
            name: "my-tool",
            displayName: "My Tool",
            description: "A test tool",
            parametersSchema: { type: "object" },
          },
        ],
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(true);
    });

    it("detects missing agent.tools.register when tools are declared", () => {
      const manifest = buildManifest({
        capabilities: [],
        tools: [
          {
            name: "my-tool",
            displayName: "My Tool",
            description: "A test tool",
            parametersSchema: { type: "object" },
          },
        ],
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("agent.tools.register");
    });

    it("detects missing jobs.schedule when jobs are declared", () => {
      const manifest = buildManifest({
        capabilities: [],
        jobs: [{ jobKey: "sync", displayName: "Sync Job" }],
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("jobs.schedule");
    });

    it("detects missing webhooks.receive when webhooks are declared", () => {
      const manifest = buildManifest({
        capabilities: [],
        webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("webhooks.receive");
    });

    it("detects missing UI slot capabilities", () => {
      const manifest = buildManifest({
        capabilities: [],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        ui: {
          slots: [
            {
              type: "sidebar",
              id: "my-sidebar",
              displayName: "Sidebar",
              exportName: "Sidebar",
            },
            {
              type: "page",
              id: "my-page",
              displayName: "Page",
              exportName: "Page",
            },
          ],
        },
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("ui.sidebar.register");
      expect(result.missing).toContain("ui.page.register");
    });

    it("does not duplicate missing capabilities for multiple slots of same type", () => {
      const manifest = buildManifest({
        capabilities: [],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        ui: {
          slots: [
            {
              type: "sidebar",
              id: "sidebar-1",
              displayName: "Sidebar 1",
              exportName: "Sidebar1",
            },
            {
              type: "sidebar",
              id: "sidebar-2",
              displayName: "Sidebar 2",
              exportName: "Sidebar2",
            },
          ],
        },
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.missing.filter((cap) => cap === "ui.sidebar.register")).toHaveLength(1);
    });

    it("manifest with only projectSidebarItem slot requires ui.sidebar.register", () => {
      const manifestWithCapability = buildManifest({
        capabilities: ["ui.sidebar.register"],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        ui: {
          slots: [
            {
              type: "projectSidebarItem",
              id: "files",
              displayName: "Files",
              exportName: "FilesLink",
              entityTypes: ["project"],
            },
          ],
        },
      });
      const resultOk = validator.validateManifestCapabilities(manifestWithCapability);
      expect(resultOk.allowed).toBe(true);

      const manifestWithoutCapability = buildManifest({
        capabilities: [],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        ui: {
          slots: [
            {
              type: "projectSidebarItem",
              id: "files",
              displayName: "Files",
              exportName: "FilesLink",
              entityTypes: ["project"],
            },
          ],
        },
      });
      const resultFail = validator.validateManifestCapabilities(manifestWithoutCapability);
      expect(resultFail.allowed).toBe(false);
      expect(resultFail.missing).toContain("ui.sidebar.register");
    });

    it("detects missing capability for ui.launchers based on placement zone", () => {
      const manifest = buildManifest({
        capabilities: [],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        ui: {
          launchers: [
            {
              id: "open-sidebar",
              displayName: "Open Sidebar",
              placementZone: "sidebar",
              action: {
                type: "navigate",
                target: "/plugins/sidebar",
              },
            },
          ],
        },
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("ui.sidebar.register");
    });

    it.each([
      ["detailTab", "ui.detailTab.register"],
      ["taskDetailView", "ui.detailTab.register"],
      ["dashboardWidget", "ui.dashboardWidget.register"],
      ["toolbarButton", "ui.action.register"],
      ["contextMenuItem", "ui.action.register"],
      ["settingsPage", "instance.settings.register"],
    ] as const)(
      "maps launcher placement %s to %s",
      (placementZone, capability) => {
        const manifest = buildManifest({
          capabilities: [],
          entrypoints: { worker: "worker.js", ui: "ui.js" },
          ui: {
            launchers: [
              {
                id: `${placementZone}-launcher`,
                displayName: `${placementZone} launcher`,
                placementZone,
                ...(placementZone === "detailTab"
                  || placementZone === "taskDetailView"
                  || placementZone === "contextMenuItem"
                  ? { entityTypes: ["issue"] as const }
                  : {}),
                action: {
                  type: "navigate",
                  target: `/plugins/${placementZone}`,
                },
              },
            ],
          },
        });

        const result = validator.validateManifestCapabilities(manifest);
        expect(result.allowed).toBe(false);
        expect(result.missing).toEqual([capability]);
      },
    );

    it("detects missing capability for legacy top-level launchers", () => {
      const manifest = buildManifest({
        capabilities: [],
        launchers: [
          {
            id: "run-action",
            displayName: "Run Action",
            placementZone: "toolbarButton",
            action: {
              type: "performAction",
              target: "sync-now",
            },
          },
        ],
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("ui.action.register");
    });

    it("deduplicates missing capabilities across slots and launchers on the same surface", () => {
      const manifest = buildManifest({
        capabilities: [],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        ui: {
          slots: [
            {
              type: "sidebar",
              id: "sidebar-slot",
              displayName: "Sidebar Slot",
              exportName: "SidebarSlot",
            },
          ],
          launchers: [
            {
              id: "sidebar-launcher",
              displayName: "Sidebar Launcher",
              placementZone: "sidebar",
              action: {
                type: "navigate",
                target: "/plugins/sidebar",
              },
            },
          ],
        },
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.missing.filter((cap) => cap === "ui.sidebar.register")).toHaveLength(1);
    });

    it("detects all missing capabilities at once", () => {
      const manifest = buildManifest({
        capabilities: [],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        tools: [
          {
            name: "tool",
            displayName: "Tool",
            description: "Test",
            parametersSchema: { type: "object" },
          },
        ],
        jobs: [{ jobKey: "job", displayName: "Job" }],
        webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
        ui: {
          slots: [
            {
              type: "dashboardWidget",
              id: "widget",
              displayName: "Widget",
              exportName: "Widget",
            },
          ],
          launchers: [
            {
              id: "open-toolbar",
              displayName: "Open Toolbar",
              placementZone: "toolbarButton",
              action: {
                type: "performAction",
                target: "refresh",
              },
            },
          ],
        },
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(false);
      expect(result.missing).toContain("agent.tools.register");
      expect(result.missing).toContain("jobs.schedule");
      expect(result.missing).toContain("webhooks.receive");
      expect(result.missing).toContain("ui.dashboardWidget.register");
      expect(result.missing).toContain("ui.action.register");
    });

    it("returns allowed=true when all features are properly declared", () => {
      const manifest = buildManifest({
        capabilities: [
          "agent.tools.register",
          "jobs.schedule",
          "webhooks.receive",
          "ui.sidebar.register",
        ],
        entrypoints: { worker: "worker.js", ui: "ui.js" },
        tools: [
          {
            name: "tool",
            displayName: "Tool",
            description: "Test",
            parametersSchema: { type: "object" },
          },
        ],
        jobs: [{ jobKey: "job", displayName: "Job" }],
        webhooks: [{ endpointKey: "hook", displayName: "Hook" }],
        ui: {
          slots: [
            {
              type: "sidebar",
              id: "sidebar",
              displayName: "Sidebar",
              exportName: "Sidebar",
            },
          ],
        },
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it("skips empty feature arrays (no false positives)", () => {
      const manifest = buildManifest({
        capabilities: [],
        tools: [],
        jobs: [],
        webhooks: [],
      });
      const result = validator.validateManifestCapabilities(manifest);
      expect(result.allowed).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // getRequiredCapabilities
  // -----------------------------------------------------------------------

  describe("getRequiredCapabilities", () => {
    it("returns required capabilities for a known operation", () => {
      const caps = validator.getRequiredCapabilities("issues.list");
      expect(caps).toEqual(["issues.read"]);
    });

    it("returns empty array for an unknown operation", () => {
      const caps = validator.getRequiredCapabilities("unknown.operation");
      expect(caps).toEqual([]);
    });

    it("returns the correct capability for state operations", () => {
      expect(validator.getRequiredCapabilities("plugin.state.set")).toEqual([
        "plugin.state.write",
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // getUiSlotCapability
  // -----------------------------------------------------------------------

  describe("getUiSlotCapability", () => {
    it("returns correct capability for each slot type", () => {
      expect(validator.getUiSlotCapability("sidebar")).toBe("ui.sidebar.register");
      expect(validator.getUiSlotCapability("page")).toBe("ui.page.register");
      expect(validator.getUiSlotCapability("detailTab")).toBe("ui.detailTab.register");
      expect(validator.getUiSlotCapability("dashboardWidget")).toBe(
        "ui.dashboardWidget.register",
      );
      expect(validator.getUiSlotCapability("settingsPage")).toBe(
        "instance.settings.register",
      );
    });
  });
});
