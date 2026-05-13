import { describe, expect, it } from "vitest";
import type { OdysseusPluginManifestV1 } from "@odysseus/shared";
import { createTestHarness } from "@odysseus/plugin-sdk/testing";

describe("plugin SDK test harness", () => {
  it("requires skills.managed capability before resetting a missing declaration", async () => {
    const manifest: OdysseusPluginManifestV1 = {
      id: "odysseus.test-missing-managed-skill-capability",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Missing Managed Skill Capability",
      description: "Test plugin",
      author: "Odysseus",
      categories: ["automation"],
      capabilities: [],
      entrypoints: { worker: "./dist/worker.js" },
      skills: [{
        skillKey: "wiki-maintainer",
        displayName: "Wiki Maintainer",
      }],
    };
    const harness = createTestHarness({ manifest });

    await expect(harness.ctx.skills.managed.reset("unknown-skill", "company-1")).rejects.toThrow(
      "missing required capability 'skills.managed'",
    );
  });
});
