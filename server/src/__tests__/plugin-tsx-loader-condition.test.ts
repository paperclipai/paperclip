import { describe, expect, it } from "vitest";
import path from "node:path";
import { isRepoLocalPluginPath, REPO_ROOT } from "../services/plugin-loader.js";

describe("isRepoLocalPluginPath", () => {
  it("returns true for a package inside the repository", () => {
    const pkgPath = path.join(REPO_ROOT, "packages", "plugins", "examples", "plugin-hello-world-example");
    expect(isRepoLocalPluginPath(pkgPath)).toBe(true);
  });

  it("returns true when the package path equals the repository root", () => {
    expect(isRepoLocalPluginPath(REPO_ROOT)).toBe(true);
  });

  it("returns false for a package outside the repository", () => {
    const outside = path.join(REPO_ROOT, "..", "external-plugin");
    expect(isRepoLocalPluginPath(outside)).toBe(false);
  });

  it("returns false for a sibling directory that merely shares the repo name prefix", () => {
    const sibling = path.join(path.dirname(REPO_ROOT), path.basename(REPO_ROOT) + "-external");
    expect(isRepoLocalPluginPath(sibling)).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isRepoLocalPluginPath(null)).toBe(false);
    expect(isRepoLocalPluginPath(undefined)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isRepoLocalPluginPath("")).toBe(false);
  });
});
