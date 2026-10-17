import { describe, expect, it } from "vitest";
import { parseNpmPackageSpec } from "./npm-package-spec.js";

describe("parseNpmPackageSpec", () => {
  it("splits an exact scoped package version", () => {
    expect(parseNpmPackageSpec("@kujolang/paperclip@0.1.5")).toEqual({
      packageName: "@kujolang/paperclip",
      version: "0.1.5",
    });
  });

  it("splits unscoped ranges and tags", () => {
    expect(parseNpmPackageSpec("paperclip-plugin@^2.0.0")).toEqual({
      packageName: "paperclip-plugin",
      version: "^2.0.0",
    });
    expect(parseNpmPackageSpec("paperclip-plugin@next")).toEqual({
      packageName: "paperclip-plugin",
      version: "next",
    });
  });

  it("preserves an unversioned scoped package", () => {
    expect(parseNpmPackageSpec("@kujolang/paperclip")).toEqual({
      packageName: "@kujolang/paperclip",
      version: undefined,
    });
  });

  it("accepts a matching separate version", () => {
    expect(parseNpmPackageSpec("@kujolang/paperclip@0.1.5", "0.1.5")).toEqual({
      packageName: "@kujolang/paperclip",
      version: "0.1.5",
    });
  });

  it("rejects an empty or conflicting version", () => {
    expect(() => parseNpmPackageSpec("@kujolang/paperclip@")).toThrow(
      "npm package version cannot be empty",
    );
    expect(() => parseNpmPackageSpec("@kujolang/paperclip@0.1.5", "0.1.4")).toThrow(
      "conflicts with --version 0.1.4",
    );
  });
});
