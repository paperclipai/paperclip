import { describe, expect, it } from "vitest";
import { resolveArtifactsV1Enabled } from "./useArtifactsV1Enabled";

describe("resolveArtifactsV1Enabled", () => {
  it("is on before settings load and on every unmanaged instance", () => {
    expect(resolveArtifactsV1Enabled(undefined)).toBe(true);
    expect(resolveArtifactsV1Enabled(null)).toBe(true);
    expect(resolveArtifactsV1Enabled({})).toBe(true);
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: true })).toBe(true);
  });

  it("ignores a stored false, which other experiment writes persist", () => {
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: false })).toBe(true);
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: false, managedKeys: {} })).toBe(true);
  });

  it("honours a hosting operator's managed value", () => {
    const managedKeys = { enableArtifactsV1: { managed: true as const, managedBy: "paperclip-cloud" as const } };
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: false, managedKeys })).toBe(false);
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: true, managedKeys })).toBe(true);
  });
});
