import { describe, it, expect } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "./plugin-capability-validator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(
  capabilities: PaperclipPluginManifestV1["capabilities"],
  extras: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id: "test-plugin",
    apiVersion: PLUGIN_API_VERSION,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A plugin used in unit tests",
    author: "Test Author",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "dist/worker.js" },
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.hasCapability", () => {
  it("returns true when the manifest declares the capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(v.hasCapability(m, "issues.read")).toBe(true);
  });

  it("returns false when the manifest does not declare the capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(v.hasCapability(m, "issues.create")).toBe(false);
  });

  it("returns false for an empty capabilities list", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest([] as unknown as PaperclipPluginManifestV1["capabilities"]);
    expect(v.hasCapability(m, "issues.read")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAllCapabilities
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.hasAllCapabilities", () => {
  it("returns allowed:true when all requested capabilities are declared", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "issues.create"]);
    const result = v.hasAllCapabilities(m, ["issues.read", "issues.create"]);
    expect(result.allowed).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("returns allowed:false and lists missing capabilities", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.hasAllCapabilities(m, ["issues.read", "issues.create"]);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("issues.create");
  });

  it("includes the pluginId in the result", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.hasAllCapabilities(m, ["issues.read"]);
    expect(result.pluginId).toBe("test-plugin");
  });

  it("returns allowed:true for an empty requirements list", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.hasAllCapabilities(m, []);
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasAnyCapability
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.hasAnyCapability", () => {
  it("returns true when at least one capability matches", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(v.hasAnyCapability(m, ["issues.read", "issues.create"])).toBe(true);
  });

  it("returns false when none of the capabilities match", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(v.hasAnyCapability(m, ["issues.create", "issues.update"])).toBe(false);
  });

  it("returns false for an empty capabilities list", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(v.hasAnyCapability(m, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkOperation
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.checkOperation", () => {
  it("returns allowed:true when the plugin has the required capability for the operation", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.checkOperation(m, "issues.list");
    expect(result.allowed).toBe(true);
    expect(result.missing).toHaveLength(0);
    expect(result.operation).toBe("issues.list");
  });

  it("returns allowed:false with missing capabilities when the plugin lacks them", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.checkOperation(m, "issues.create");
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("issues.create");
  });

  it("rejects an unknown operation by default (allowed:false, missing:[])", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "issues.create"]);
    const result = v.checkOperation(m, "completely.unknown.operation");
    expect(result.allowed).toBe(false);
    expect(result.missing).toHaveLength(0);
  });

  it("gates agent.tools.register on the correct capability", () => {
    const v = pluginCapabilityValidator();
    const without = makeManifest(["issues.read"]);
    expect(v.checkOperation(without, "agent.tools.register").allowed).toBe(false);

    const with_ = makeManifest(["issues.read", "agent.tools.register"]);
    expect(v.checkOperation(with_, "agent.tools.register").allowed).toBe(true);
  });

  it("gates secrets.resolve on secrets.read-ref capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "secrets.read-ref"]);
    expect(v.checkOperation(m, "secrets.resolve").allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertOperation
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.assertOperation", () => {
  it("does not throw when the operation is allowed", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(() => v.assertOperation(m, "issues.list")).not.toThrow();
  });

  it("throws when the operation is not allowed", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(() => v.assertOperation(m, "issues.create")).toThrow();
  });

  it("throws for an unknown operation", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(() => v.assertOperation(m, "no.such.op")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertCapability
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.assertCapability", () => {
  it("does not throw when the manifest has the capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(() => v.assertCapability(m, "issues.read")).not.toThrow();
  });

  it("throws when the manifest lacks the capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    expect(() => v.assertCapability(m, "issues.create")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkUiSlot
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.checkUiSlot", () => {
  it("returns allowed:true when the manifest has the required ui capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "ui.sidebar.register"]);
    const result = v.checkUiSlot(m, "sidebar");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed:false when the manifest lacks the required ui capability", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.checkUiSlot(m, "sidebar");
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("ui.sidebar.register");
  });

  it("returns allowed:true for a page slot with ui.page.register", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "ui.page.register"]);
    const result = v.checkUiSlot(m, "page");
    expect(result.allowed).toBe(true);
  });

  it("returns allowed:true for a dashboardWidget slot with ui.dashboardWidget.register", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "ui.dashboardWidget.register"]);
    const result = v.checkUiSlot(m, "dashboardWidget");
    expect(result.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateManifestCapabilities
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.validateManifestCapabilities", () => {
  it("returns allowed:true for a manifest with no feature declarations", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"]);
    const result = v.validateManifestCapabilities(m);
    expect(result.allowed).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("returns allowed:false when tools are declared without agent.tools.register", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"], {
      tools: [
        {
          name: "my_tool",
          displayName: "My Tool",
          description: "A test tool",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    });
    const result = v.validateManifestCapabilities(m);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("agent.tools.register");
  });

  it("returns allowed:true when tools are declared with agent.tools.register", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read", "agent.tools.register"], {
      tools: [
        {
          name: "my_tool",
          displayName: "My Tool",
          description: "A test tool",
          parametersSchema: { type: "object", properties: {} },
        },
      ],
    });
    const result = v.validateManifestCapabilities(m);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed:false when jobs are declared without jobs.schedule", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"], {
      jobs: [{ jobKey: "daily-sync", displayName: "Daily Sync", description: "Sync daily", schedule: "0 0 * * *" }],
    });
    const result = v.validateManifestCapabilities(m);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("jobs.schedule");
  });

  it("reports multiple missing capabilities at once", () => {
    const v = pluginCapabilityValidator();
    const m = makeManifest(["issues.read"], {
      tools: [
        { name: "t", displayName: "T", description: "test", parametersSchema: { type: "object", properties: {} } },
      ],
      jobs: [{ jobKey: "j", displayName: "J", description: "job", schedule: "* * * * *" }],
    });
    const result = v.validateManifestCapabilities(m);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("agent.tools.register");
    expect(result.missing).toContain("jobs.schedule");
  });
});

// ---------------------------------------------------------------------------
// getRequiredCapabilities
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.getRequiredCapabilities", () => {
  it("returns the capabilities required for a known operation", () => {
    const v = pluginCapabilityValidator();
    const caps = v.getRequiredCapabilities("issues.list");
    expect(caps).toContain("issues.read");
  });

  it("returns an empty array for an unknown operation", () => {
    const v = pluginCapabilityValidator();
    const caps = v.getRequiredCapabilities("no.such.operation");
    expect(Array.isArray(caps)).toBe(true);
    expect(caps).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getUiSlotCapability
// ---------------------------------------------------------------------------

describe("pluginCapabilityValidator.getUiSlotCapability", () => {
  it("returns the capability for the sidebar slot type", () => {
    const v = pluginCapabilityValidator();
    expect(v.getUiSlotCapability("sidebar")).toBe("ui.sidebar.register");
  });

  it("returns the capability for the page slot type", () => {
    const v = pluginCapabilityValidator();
    expect(v.getUiSlotCapability("page")).toBe("ui.page.register");
  });

  it("returns the capability for the detailTab slot type", () => {
    const v = pluginCapabilityValidator();
    expect(v.getUiSlotCapability("detailTab")).toBe("ui.detailTab.register");
  });

  it("returns the capability for the commentAnnotation slot type", () => {
    const v = pluginCapabilityValidator();
    expect(v.getUiSlotCapability("commentAnnotation")).toBe("ui.commentAnnotation.register");
  });
});
