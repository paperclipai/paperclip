import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
const copyScriptPath = fileURLToPath(
  new URL("../../../scripts/copy-onboarding-assets.mjs", import.meta.url),
);

describe("server package build script", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("copies static runtime asset directories into dist via the cross-platform copy script", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    expect(buildScript).toContain("node ../scripts/copy-onboarding-assets.mjs");
  });

  it("copy script mirrors src/onboarding-assets and src/built-ins into dist", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "server-build-assets-"));

    mkdirSync(path.join(tempDir, "src", "onboarding-assets", "nested"), { recursive: true });
    writeFileSync(path.join(tempDir, "src", "onboarding-assets", "logo.svg"), "<svg/>");
    writeFileSync(path.join(tempDir, "src", "onboarding-assets", "nested", "guide.md"), "# guide");
    mkdirSync(path.join(tempDir, "src", "built-ins", "agents"), { recursive: true });
    writeFileSync(path.join(tempDir, "src", "built-ins", "agents", "ceo.yaml"), "role: ceo");

    execFileSync(process.execPath, [copyScriptPath], { cwd: tempDir });

    expect(readFileSync(path.join(tempDir, "dist", "onboarding-assets", "logo.svg"), "utf8")).toBe(
      "<svg/>",
    );
    expect(
      readFileSync(path.join(tempDir, "dist", "onboarding-assets", "nested", "guide.md"), "utf8"),
    ).toBe("# guide");
    expect(
      readFileSync(path.join(tempDir, "dist", "built-ins", "agents", "ceo.yaml"), "utf8"),
    ).toBe("role: ceo");
  });

  it("copy script fails loudly when an asset source directory is missing", () => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), "server-build-assets-"));

    mkdirSync(path.join(tempDir, "src", "onboarding-assets"), { recursive: true });
    // src/built-ins intentionally absent.

    expect(() => execFileSync(process.execPath, [copyScriptPath], { cwd: tempDir })).toThrow();
  });
});
