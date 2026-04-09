import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readPackageVersion(packageJsonPath: string): string {
  const manifest = JSON.parse(
    fs.readFileSync(packageJsonPath, "utf8"),
  ) as { version: string };
  return manifest.version;
}

function resolveFrom(fromPath: string, specifier: string): string {
  return require.resolve(specifier, { paths: [fromPath] });
}

function findVirtualStorePackageDir(prefix: string): string | null {
  const virtualStoreDir = path.join(repoRoot, "node_modules/.pnpm");
  if (!fs.existsSync(virtualStoreDir)) {
    return null;
  }
  const match = fs
    .readdirSync(virtualStoreDir)
    .find((entry) => entry.startsWith(prefix));
  return match ? path.join(virtualStoreDir, match) : null;
}

describe("workspace vitest jsdom resolution", () => {
  it("keeps the live vitest resolution on jsdom 27 regardless of lockfile metadata", () => {
    const vitestDir = path.dirname(require.resolve("vitest/package.json"));
    const jsdomPackageJson = resolveFrom(vitestDir, "jsdom/package.json");
    const htmlEncodingSnifferPackageJson = resolveFrom(
      path.dirname(jsdomPackageJson),
      "html-encoding-sniffer/package.json",
    );

    expect(readPackageVersion(jsdomPackageJson)).toBe("27.2.0");
    expect(readPackageVersion(htmlEncodingSnifferPackageJson)).toBe("4.0.0");
    expect(jsdomPackageJson).not.toContain("jsdom@28");
    expect(htmlEncodingSnifferPackageJson).not.toContain(
      "html-encoding-sniffer@6",
    );
  });

  it("treats forced nested html-encoding-sniffer 6 loads as a manual path hazard, not the live vitest graph", () => {
    const nestedSnifferDir = findVirtualStorePackageDir(
      "html-encoding-sniffer@6.0.0",
    );

    if (!nestedSnifferDir) {
      expect(nestedSnifferDir).toBeNull();
      return;
    }

    const nestedSnifferEntry = path.join(
      nestedSnifferDir,
      "node_modules/html-encoding-sniffer/lib/html-encoding-sniffer.js",
    );
    expect(() => require(nestedSnifferEntry)).toThrowError(
      /ES Module .*encoding-lite\.js/,
    );
  });
});
