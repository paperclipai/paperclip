import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { verifyCapabilityManifest } from "./stock-harness-manifest.js";

describe("stock harness generated instruction metadata", () => {
  it("requires generated capability manifests for the current skill sources", async () => {
    expect(await verifyCapabilityManifest()).toBe(true);
  });
  it("rejects a stale manifest before provider admission", async () => {
    await expect(verifyCapabilityManifest(path => path.endsWith("capabilities.yaml")
      ? "stale skill anchors" : readFileSync(path, "utf8"))).rejects.toThrow("manifest drift");
  });
  it("rejects unavailable generated evidence", async () => {
    await expect(verifyCapabilityManifest(() => { throw new Error("missing generated evidence"); }))
      .rejects.toThrow("missing generated evidence");
  });
  it("rejects a stale source inventory before provider admission", async () => {
    await expect(verifyCapabilityManifest(undefined, () => { throw new Error("source inventory drift"); }))
      .rejects.toThrow("source inventory drift");
  });
});
