import { describe, expect, it } from "vitest";
import manifest, { PLUGIN_ID } from "./manifest.js";

describe("manifest", () => {
  it("declares id, worker entrypoint, and required capabilities", () => {
    expect(PLUGIN_ID).toBe("paperclipai.plugin-partner-bridge");
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining(["http.outbound", "companies.read", "plugin.state.read", "plugin.state.write", "jobs.schedule", "activity.log.write"]),
    );
  });
  it("exposes the bridge-sync job and an instanceConfigSchema with the link + transport fields", () => {
    expect(manifest.jobs?.some((j) => j.jobKey === "bridge-sync")).toBe(true);
    const props = (manifest.instanceConfigSchema as { properties: Record<string, unknown> }).properties;
    for (const k of ["paperclipBaseUrl", "couchUrl", "hermesBaseUrl", "inboundSecret", "links"]) {
      expect(props[k]).toBeDefined();
    }
  });
});
