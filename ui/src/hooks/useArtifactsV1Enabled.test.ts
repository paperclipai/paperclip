import { describe, expect, it } from "vitest";
import { resolveArtifactsV1Enabled } from "./useArtifactsV1Enabled";

describe("resolveArtifactsV1Enabled", () => {
  it("is off until an instance opts in", () => {
    expect(resolveArtifactsV1Enabled(undefined)).toBe(false);
    expect(resolveArtifactsV1Enabled(null)).toBe(false);
    expect(resolveArtifactsV1Enabled({})).toBe(false);
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: false })).toBe(false);
  });

  it("is on when the setting is", () => {
    expect(resolveArtifactsV1Enabled({ enableArtifactsV1: true })).toBe(true);
  });
});
