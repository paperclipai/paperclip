import { describe, expect, it, vi } from "vitest";
import { parseBuildVersion, readBuildVersion } from "../build-version.js";

describe("parseBuildVersion", () => {
  it("trims a stamped git describe string", () => {
    expect(parseBuildVersion("  v2026.722.0-15-g4c55f0d\n")).toBe("v2026.722.0-15-g4c55f0d");
  });

  it("accepts an already-resolved version verbatim", () => {
    expect(parseBuildVersion("2026.725.0-canary.2")).toBe("2026.725.0-canary.2");
  });

  it("rejects empty and whitespace-bearing values", () => {
    expect(parseBuildVersion("")).toBeNull();
    expect(parseBuildVersion("   ")).toBeNull();
    expect(parseBuildVersion("v1 with spaces")).toBeNull();
    expect(parseBuildVersion(null)).toBeNull();
    expect(parseBuildVersion(undefined)).toBeNull();
  });
});

describe("readBuildVersion", () => {
  it("prefers an explicit environment version over the file", () => {
    const readTextFile = vi.fn(() => "v9999.0.0-0-g0000000");

    expect(
      readBuildVersion({
        environmentVersion: "v2026.722.0-15-g4c55f0d",
        readTextFile,
      }),
    ).toBe("v2026.722.0-15-g4c55f0d");
    expect(readTextFile).not.toHaveBeenCalled();
  });

  it("reads the build marker when no environment version is set", () => {
    expect(
      readBuildVersion({
        environmentVersion: null,
        buildVersionPath: "/app/.paperclip-build-version",
        readTextFile: (path) => {
          expect(path).toBe("/app/.paperclip-build-version");
          return "v2026.722.0-15-g4c55f0d\n";
        },
      }),
    ).toBe("v2026.722.0-15-g4c55f0d");
  });

  it("returns null when neither the environment nor the file provides a version", () => {
    expect(
      readBuildVersion({
        environmentVersion: null,
        readTextFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toBeNull();
  });
});
