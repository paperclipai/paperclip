import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const buildScript: string = JSON.parse(readFileSync(packageJsonPath, "utf8")).scripts.build;

describe("shared package build script", () => {
  let workDir: string | undefined;

  afterEach(() => {
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  });

  it("avoids POSIX-only commands that cmd.exe cannot run", () => {
    expect(buildScript).not.toMatch(/\bmkdir -p\b/);
    expect(buildScript).not.toMatch(/(^|&&\s*)cp\s/);
  });

  it("stages cliplab LICENSE and PROVENANCE.md into dist without a shell", () => {
    const payload = buildScript.match(/node -e "([^"]+)"/)?.[1];
    expect(payload).toBeDefined();

    workDir = mkdtempSync(path.join(tmpdir(), "shared-build-script-"));
    mkdirSync(path.join(workDir, "src", "cliplab"), { recursive: true });
    writeFileSync(path.join(workDir, "src", "cliplab", "LICENSE"), "license-body");
    writeFileSync(path.join(workDir, "src", "cliplab", "PROVENANCE.md"), "provenance-body");

    execFileSync(process.execPath, ["-e", payload!], { cwd: workDir });

    expect(readFileSync(path.join(workDir, "dist", "cliplab", "LICENSE"), "utf8")).toBe("license-body");
    expect(readFileSync(path.join(workDir, "dist", "cliplab", "PROVENANCE.md"), "utf8")).toBe(
      "provenance-body",
    );
  });
});
