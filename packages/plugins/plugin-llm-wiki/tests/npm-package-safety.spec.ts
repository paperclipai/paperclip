import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..", "..");

type PackageJson = {
  name: string;
  private?: boolean;
  files?: string[];
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
};

type ReleaseManifestEntry = { dir: string; name: string; publishFromCi: boolean };

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const packageJson = readJson<PackageJson>(join(PACKAGE_DIR, "package.json"));

describe("LLM Wiki npm package", () => {
  // The only published build (0.1.0) bundles an SDK that predates host
  // invocation scopes, so every worker -> host callback is rejected (#8036).
  // A refreshed build only reaches npm if the release flow publishes it.
  it("is enrolled in CI release publishing", () => {
    const manifest = readJson<ReleaseManifestEntry[]>(join(REPO_ROOT, "scripts", "release-package-manifest.json"));
    expect(manifest).toContainEqual({
      dir: "packages/plugins/plugin-llm-wiki",
      name: packageJson.name,
      publishFromCi: true,
    });
  });

  it("is publishable as a public scoped package", () => {
    expect(packageJson.private).not.toBe(true);
    expect(packageJson.publishConfig?.access).toBe("public");
  });

  it("replaces the workspace SDK dependency with the released SDK when packed", () => {
    expect(packageJson.scripts?.prepack).toContain("generate-plugin-package-json.mjs");
    expect(packageJson.scripts?.postpack).toContain("mv package.dev.json package.json");
  });

  // npm renames a packaged `.gitignore` to `.npmignore` on install, so a
  // runtime-required template with that name disappears from the published
  // package (#5986). Ignore-file templates must use a non-dot name.
  it("ships no packaged file that npm would rename on install", () => {
    const packagedDirs = (packageJson.files ?? []).filter((entry) => statSync(join(PACKAGE_DIR, entry), { throwIfNoEntry: false })?.isDirectory());
    const hazardous = packagedDirs
      .flatMap((dir) => walk(join(PACKAGE_DIR, dir)))
      .map((path) => relative(PACKAGE_DIR, path))
      .filter((path) => /(^|\/)\.(git|npm)ignore$/.test(path));
    expect(hazardous).toEqual([]);
  });
});
