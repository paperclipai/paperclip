import { describe, it, expect } from "vitest";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mv = pluginManifestValidator();

function makeManifest(capabilities: string[], overrides: Record<string, unknown> = {}): PaperclipPluginManifestV1 {
  return mv.parseOrThrow({
    id: "test-plugin",
    apiVersion: PLUGIN_API_VERSION,
    version: "1.0.0",
    displayName: "Test Plugin",
    description: "A plugin for testing",
    author: "Acme",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "dist/worker.js" },
    ...overrides,
  });
}

const cv = pluginCapabilityValidator();

// ---------------------------------------------------------------------------
// hasCapability
// ---------------------------------------------------------------------------

describe("hasCapability", () => {
  it("returns true when the capability is declared", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.hasCapability(m, "issues.read")).toBe(true);
  });

  it("returns false when the capability is not declared", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.hasCapability(m, "issues.create")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasAllCapabilities
// ---------------------------------------------------------------------------

describe("hasAllCapabilities", () => {
  it("returns allowed=true when all capabilities are present", () => {
    const m = makeManifest(["issues.read", "issues.create"]);
    const result = cv.hasAllCapabilities(m, ["issues.read", "issues.create"]);
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns allowed=false with the missing list when any capability is absent", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.hasAllCapabilities(m, ["issues.read", "issues.create"]);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("issues.create");
  });

  it("returns allowed=true for an empty required list", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.hasAllCapabilities(m, []);
    expect(result.allowed).toBe(true);
  });

  it("includes pluginId in the result", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.hasAllCapabilities(m, ["issues.read"]).pluginId).toBe("test-plugin");
  });
});

// ---------------------------------------------------------------------------
// hasAnyCapability
// ---------------------------------------------------------------------------

describe("hasAnyCapability", () => {
  it("returns true when at least one capability is declared", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.hasAnyCapability(m, ["issues.create", "issues.read"])).toBe(true);
  });

  it("returns false when none of the capabilities are declared", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.hasAnyCapability(m, ["issues.create", "issues.update"])).toBe(false);
  });

  it("returns false for an empty capability list", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.hasAnyCapability(m, [])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkOperation
// ---------------------------------------------------------------------------

describe("checkOperation", () => {
  it("returns allowed=true when the plugin has all required capabilities", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.checkOperation(m, "issues.list");
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns allowed=false when a required capability is missing", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.checkOperation(m, "issues.create");
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("issues.create");
  });

  it("returns allowed=false for an unknown operation", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.checkOperation(m, "unknown.operation");
    expect(result.allowed).toBe(false);
  });

  it("includes operation and pluginId in the result", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.checkOperation(m, "issues.list");
    expect(result.operation).toBe("issues.list");
    expect(result.pluginId).toBe("test-plugin");
  });
});

// ---------------------------------------------------------------------------
// assertOperation
// ---------------------------------------------------------------------------

describe("assertOperation", () => {
  it("does not throw when the plugin has the required capability", () => {
    const m = makeManifest(["issues.read"]);
    expect(() => cv.assertOperation(m, "issues.list")).not.toThrow();
  });

  it("throws when a required capability is missing", () => {
    const m = makeManifest(["issues.read"]);
    expect(() => cv.assertOperation(m, "issues.create")).toThrow();
  });

  it("throws for an unknown operation", () => {
    const m = makeManifest(["issues.read"]);
    expect(() => cv.assertOperation(m, "unknown.operation")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertCapability
// ---------------------------------------------------------------------------

describe("assertCapability", () => {
  it("does not throw when capability is present", () => {
    const m = makeManifest(["issues.read"]);
    expect(() => cv.assertCapability(m, "issues.read")).not.toThrow();
  });

  it("throws when capability is missing", () => {
    const m = makeManifest(["issues.read"]);
    expect(() => cv.assertCapability(m, "issues.create")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// checkUiSlot
// ---------------------------------------------------------------------------

describe("checkUiSlot", () => {
  it("returns allowed=true when the plugin has the required UI slot capability", () => {
    const m = makeManifest(["ui.sidebar.register"]);
    const result = cv.checkUiSlot(m, "sidebar");
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns allowed=false when the required UI slot capability is missing", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.checkUiSlot(m, "page");
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("ui.page.register");
  });

  it("returns allowed=false for an unknown slot type", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.checkUiSlot(m, "unknown-slot" as never);
    expect(result.allowed).toBe(false);
  });

  it("includes operation name in result", () => {
    const m = makeManifest(["ui.sidebar.register"]);
    const result = cv.checkUiSlot(m, "sidebar");
    expect(result.operation).toContain("sidebar");
  });
});

// ---------------------------------------------------------------------------
// validateManifestCapabilities
// ---------------------------------------------------------------------------

describe("validateManifestCapabilities", () => {
  it("returns allowed=true for a manifest with no declared features", () => {
    const m = makeManifest(["issues.read"]);
    const result = cv.validateManifestCapabilities(m);
    expect(result.allowed).toBe(true);
    expect(result.missing).toEqual([]);
  });

  const sampleTool = {
    name: "my_tool",
    displayName: "My Tool",
    description: "does stuff",
    parametersSchema: { type: "object", properties: {}, required: [] },
  };

  it("returns allowed=true when tools are declared with agent.tools.register capability", () => {
    const m = makeManifest(["agent.tools.register"], { tools: [sampleTool] });
    const result = cv.validateManifestCapabilities(m);
    expect(result.allowed).toBe(true);
  });

  it("returns allowed=false when tools are declared without agent.tools.register (cast bypass)", () => {
    // The Zod schema normally enforces the capability, but the capability validator
    // is also responsible for enforcing it independently. We construct the invalid
    // state via type casting to test the validator's own logic.
    const m = {
      ...makeManifest(["issues.read"]),
      tools: [sampleTool],
    } as PaperclipPluginManifestV1;
    const result = cv.validateManifestCapabilities(m);
    expect(result.allowed).toBe(false);
    expect(result.missing).toContain("agent.tools.register");
  });

  it("includes pluginId in the result", () => {
    const m = makeManifest(["issues.read"]);
    expect(cv.validateManifestCapabilities(m).pluginId).toBe("test-plugin");
  });
});

// ---------------------------------------------------------------------------
// getRequiredCapabilities
// ---------------------------------------------------------------------------

describe("getRequiredCapabilities", () => {
  it("returns the required capabilities for a known operation", () => {
    const caps = cv.getRequiredCapabilities("issues.list");
    expect(caps).toContain("issues.read");
  });

  it("returns an empty array for an unknown operation", () => {
    const caps = cv.getRequiredCapabilities("unknown.op");
    expect(caps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getUiSlotCapability
// ---------------------------------------------------------------------------

describe("getUiSlotCapability", () => {
  it("returns the required capability for a known slot type", () => {
    expect(cv.getUiSlotCapability("sidebar")).toBe("ui.sidebar.register");
    expect(cv.getUiSlotCapability("page")).toBe("ui.page.register");
    expect(cv.getUiSlotCapability("detailTab")).toBe("ui.detailTab.register");
  });

  it("returns undefined for an unknown slot type", () => {
    expect(cv.getUiSlotCapability("unknown-slot" as never)).toBeUndefined();
  });
});
