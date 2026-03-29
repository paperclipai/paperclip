import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("worker", () => {
  describe("onValidateConfig", () => {
    it("accepts valid config", async () => {
      const result = await plugin.definition.onValidateConfig!({
        githubAppId: "123",
        githubInstallationId: "456",
        privateKeySecret: "pk",
        orgName: "test-org",
        companyId: "company-1",
        webhookSecretRef: "wh",
        pollIntervalMinutes: 5,
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it("rejects missing required fields", async () => {
      const result = await plugin.definition.onValidateConfig!({});
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThanOrEqual(6);
    });

    it("rejects invalid pollIntervalMinutes", async () => {
      const result = await plugin.definition.onValidateConfig!({
        githubAppId: "123",
        githubInstallationId: "456",
        privateKeySecret: "pk",
        orgName: "test-org",
        companyId: "company-1",
        webhookSecretRef: "wh",
        pollIntervalMinutes: 60,
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("pollIntervalMinutes must be between 1 and 30");
    });
  });

  describe("setup", () => {
    it("registers all handlers during setup", async () => {
      const harness = createTestHarness({
        manifest,
        capabilities: [...manifest.capabilities],
        config: {
          githubAppId: "123",
          githubInstallationId: "456",
          privateKeySecret: "pk",
          orgName: "test-org",
          companyId: "company-1",
          webhookSecretRef: "wh",
        },
      });

      // Pre-seed repos state to skip initial sync (which would call GitHub API)
      await harness.ctx.state.set(
        { scopeKind: "instance", stateKey: "repos" },
        ["test-org/repo"],
      );

      await plugin.definition.setup(harness.ctx);

      // Verify data handlers registered by calling getData
      // This triggers ensureInitialized but repos already exist so no API call
      const syncStatus = await harness.getData("sync-status", {});
      expect(syncStatus).toBeDefined();
      expect((syncStatus as any).orgName).toBe("test-org");
      expect((syncStatus as any).trackedRepos).toBe(1);
    });
  });

  describe("manifest", () => {
    it("has correct plugin ID", () => {
      expect(manifest.id).toBe("paperclip.github-sync");
    });

    it("declares required capabilities", () => {
      expect(manifest.capabilities).toContain("issues.read");
      expect(manifest.capabilities).toContain("issues.create");
      expect(manifest.capabilities).toContain("issues.update");
      expect(manifest.capabilities).toContain("agents.read");
      expect(manifest.capabilities).toContain("projects.read");
      expect(manifest.capabilities).toContain("http.outbound");
      expect(manifest.capabilities).toContain("webhooks.receive");
      expect(manifest.capabilities).toContain("events.subscribe");
    });

    it("declares the poll job", () => {
      expect(manifest.jobs).toHaveLength(1);
      expect(manifest.jobs![0].jobKey).toBe("github-poll");
    });

    it("declares the webhook endpoint", () => {
      expect(manifest.webhooks).toHaveLength(1);
      expect(manifest.webhooks![0].endpointKey).toBe("github-events");
    });

    it("declares UI slots", () => {
      const slotTypes = manifest.ui!.slots.map((s) => s.type);
      expect(slotTypes).toContain("dashboardWidget");
      expect(slotTypes).toContain("settingsPage");
      expect(slotTypes).toContain("detailTab");
    });
  });
});
