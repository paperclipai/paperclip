import { describe, it, expect } from "vitest";
import { isPluginPackageName, NPM_PLUGIN_PACKAGE_PREFIX } from "../services/plugin-loader.js";

describe("isPluginPackageName", () => {
  // ── NPM_PLUGIN_PACKAGE_PREFIX export ─────────────────────────────────────

  it("exports NPM_PLUGIN_PACKAGE_PREFIX as 'paperclip-plugin-'", () => {
    expect(NPM_PLUGIN_PACKAGE_PREFIX).toBe("paperclip-plugin-");
  });

  // ── prefix-based matches ──────────────────────────────────────────────────

  it("returns true for a package starting with 'paperclip-plugin-'", () => {
    expect(isPluginPackageName("paperclip-plugin-linear")).toBe(true);
  });

  it("returns true for exact prefix (no suffix)", () => {
    expect(isPluginPackageName("paperclip-plugin-")).toBe(true);
  });

  it("returns true for prefix with complex suffix", () => {
    expect(isPluginPackageName("paperclip-plugin-my-cool-tool")).toBe(true);
  });

  // ── scoped package matches ────────────────────────────────────────────────

  it("returns true for @scope/plugin-xxx style package", () => {
    expect(isPluginPackageName("@acme/plugin-linear")).toBe(true);
  });

  it("returns true for @paperclipai/plugin-xxx style package", () => {
    expect(isPluginPackageName("@paperclipai/plugin-debug")).toBe(true);
  });

  it("returns true when local part is exactly 'plugin-'", () => {
    expect(isPluginPackageName("@scope/plugin-")).toBe(true);
  });

  // ── non-matching packages ─────────────────────────────────────────────────

  it("returns false for unscoped package without prefix", () => {
    expect(isPluginPackageName("my-package")).toBe(false);
  });

  it("returns false for scoped package whose local part does not start with 'plugin-'", () => {
    expect(isPluginPackageName("@acme/my-package")).toBe(false);
  });

  it("returns false for 'plugin-' without the full prefix (no scope or paperclip prefix)", () => {
    // 'plugin-x' does not start with 'paperclip-plugin-' and has no '/'
    expect(isPluginPackageName("plugin-x")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPluginPackageName("")).toBe(false);
  });

  it("returns false for a package starting with 'paperclip-' but not 'paperclip-plugin-'", () => {
    expect(isPluginPackageName("paperclip-utils")).toBe(false);
  });

  it("returns false for scoped package whose scope contains 'plugin-'", () => {
    // The check is on the local part, not the scope
    expect(isPluginPackageName("@plugin-scope/my-package")).toBe(false);
  });
});
