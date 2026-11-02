import { describe, expect, it } from "vitest";
import { createTestHarness } from "../src/testing.js";
import type { PaperclipPluginManifestV1 } from "../src/types.js";
const manifest = {
  id: "fixture",
  apiVersion: 1,
  resourceLifecycle: ["project"],
  capabilities: ["projects.instance-secrets", "events.subscribe"],
} as PaperclipPluginManifestV1;
describe("project instance secret harness", () => {
  it("returns only seeded company/project credentials and isolates returned copies", async () => {
    const h = createTestHarness({ manifest });
    h.seed({
      projects: [{ id: "project", companyId: "company" }] as never,
      projectInstanceSecrets: [
        {
          companyId: "company",
          projectId: "project",
          values: { mount_grants: "fixture" },
        },
      ],
    });
    const values = await h.ctx.projects.getInstanceSecrets(
      "project",
      "company",
    );
    expect(values).toEqual({ mount_grants: "fixture" });
    values.mount_grants = "changed";
    expect(
      await h.ctx.projects.getInstanceSecrets("project", "company"),
    ).toEqual({ mount_grants: "fixture" });
    await expect(
      h.ctx.projects.getInstanceSecrets("project", "other"),
    ).rejects.toThrow();
    await expect(
      h.ctx.projects.getInstanceSecrets("missing", "company"),
    ).rejects.toThrow();
    h.seed({
      projects: [
        { id: "project", companyId: "company", archivedAt: "2020-01-01" },
      ] as never,
    });
    await expect(
      h.ctx.projects.getInstanceSecrets("project", "company"),
    ).rejects.toThrow();
    const denied = createTestHarness({ manifest, capabilities: [] });
    await expect(
      denied.ctx.projects.getInstanceSecrets("project", "company"),
    ).rejects.toThrow();
  });
});
