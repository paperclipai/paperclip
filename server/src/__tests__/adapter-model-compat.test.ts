import { describe, expect, it } from "vitest";
import { getStaticAdapterModels, listAdapterModels } from "../adapters/index.js";

describe("adapter model compatibility", () => {
  describe("getStaticAdapterModels", () => {
    it("returns static models for claude_local", () => {
      const models = getStaticAdapterModels("claude_local");
      expect(models).not.toBeNull();
      expect(models!.length).toBeGreaterThan(0);
      expect(models!.some((m) => m.id.startsWith("claude-"))).toBe(true);
    });

    it("returns static models for codex_local", () => {
      const models = getStaticAdapterModels("codex_local");
      expect(models).not.toBeNull();
      expect(models!.length).toBeGreaterThan(0);
    });

    it("returns static models for hermes_local", () => {
      const models = getStaticAdapterModels("hermes_local");
      expect(models).not.toBeNull();
      expect(models!.length).toBeGreaterThan(0);
    });

    it("returns null for process adapter (no models)", () => {
      const models = getStaticAdapterModels("process");
      expect(models).toBeNull();
    });

    it("returns null for http adapter (no models)", () => {
      const models = getStaticAdapterModels("http");
      expect(models).toBeNull();
    });

    it("returns null for opencode_local (dynamic-only)", () => {
      const models = getStaticAdapterModels("opencode_local");
      expect(models).toBeNull();
    });

    it("returns null for pi_local (dynamic-only)", () => {
      const models = getStaticAdapterModels("pi_local");
      expect(models).toBeNull();
    });

    it("returns null for unknown adapter type", () => {
      const models = getStaticAdapterModels("nonexistent_adapter");
      expect(models).toBeNull();
    });
  });

  describe("cross-adapter model incompatibility", () => {
    it("claude models are NOT in codex_local static list", async () => {
      const claudeModels = getStaticAdapterModels("claude_local")!;
      const codexModels = getStaticAdapterModels("codex_local")!;
      expect(claudeModels).not.toBeNull();
      expect(codexModels).not.toBeNull();

      const codexIds = new Set(codexModels.map((m) => m.id));
      for (const cm of claudeModels) {
        expect(codexIds.has(cm.id)).toBe(false);
      }
    });

    it("codex models are NOT in claude_local static list", () => {
      const claudeModels = getStaticAdapterModels("claude_local")!;
      const codexModels = getStaticAdapterModels("codex_local")!;

      const claudeIds = new Set(claudeModels.map((m) => m.id));
      for (const cm of codexModels) {
        expect(claudeIds.has(cm.id)).toBe(false);
      }
    });
  });

  describe("listAdapterModels", () => {
    it("returns models for claude_local", async () => {
      const models = await listAdapterModels("claude_local");
      expect(models.length).toBeGreaterThan(0);
    });

    it("returns empty array for unknown adapter type", async () => {
      const models = await listAdapterModels("nonexistent");
      expect(models).toEqual([]);
    });
  });
});
