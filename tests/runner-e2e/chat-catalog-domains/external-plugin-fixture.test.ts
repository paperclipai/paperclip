import { describe, expect, it } from "vitest";
import { pluginManifestV1Schema } from "../../../packages/shared/src/validators/plugin.js";
import { previewFixtureManifest } from "./external-plugin-fixture.js";

describe("vetted disposable preview plugin manifest", () => {
  it("passes the actual product manifest contract with a scoped route, tool, managed job and secure field", () => {
    const manifest = previewFixtureManifest("paperclip.eval-preview-fixture");
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(true);
    expect(manifest.apiRoutes?.[0]).toMatchObject({ auth: "board", companyResolution: { from: "query", key: "companyId" } });
    expect(manifest.jobs).toHaveLength(1); expect(manifest.tools).toHaveLength(1);
    expect(manifest.instanceConfigSchema).toMatchObject({ required: ["apiKey"], properties: { apiKey: { format: "secret-ref" } } });
  });
  it("rejects a plausible unscoped API route before package admission", () => {
    const manifest = previewFixtureManifest("paperclip.eval-preview-fixture");
    manifest.apiRoutes![0]!.path = "/api/companies/:companyId/secrets";
    expect(pluginManifestV1Schema.safeParse(manifest).success).toBe(false);
  });
});
