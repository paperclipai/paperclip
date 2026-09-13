import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const workflow = readFileSync(path.join(root, ".github/workflows/runner-full-stack-e2e.yml"), "utf8");
const runtime = "tests/runner-e2e/reporting-runtime";

it("locks every reporting registry artifact with integrity and exact direct versions", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, runtime, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(path.join(root, runtime, "package-lock.json"), "utf8"));
  expect(manifest.private).toBe(true);
  expect(manifest.engines).toEqual({ node: ">=24.11.0" });
  expect(lock.packages[""].engines).toEqual(manifest.engines);
  // 3.1.6 fixes the six URI parsing advisories affecting the inherited 3.1.2 lock.
  expect(manifest.overrides["fast-uri"]).toBe("3.1.6");
  expect(lock.packages["node_modules/fast-uri"].version).toBe("3.1.6");
  expect(manifest.scripts).toBeUndefined();
  expect(lock.lockfileVersion).toBe(3);
  expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
  expect(Object.keys(manifest.dependencies).sort()).toEqual(["@playwright/test", "ajv", "tsx", "zod"]);
  for (const version of Object.values(manifest.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  for (const [name, value] of Object.entries(lock.packages) as Array<[string, Record<string, unknown>]>) {
    if (!name) continue;
    expect(value.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(value.resolved).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    expect(value.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/);
    expect(value.link).toBeUndefined();
  }
});

for (const [job, next] of [["report", "publish_history"], ["publish_history", "pages"]]) {
  describe(`${job} reviewed reporting runtime`, () => {
    const block = workflow.slice(workflow.indexOf(`  ${job}:`), workflow.indexOf(`  ${next}:`));
    const install = block.match(/- name: Install integrity-locked reporting runtime without lifecycle scripts\n        run: \|\n((?:          .*\n|\n)+)/)?.[1]
      .split("\n").map((line) => line.slice(10)).join("\n");
    it("never resolves root/target dependencies or executes lifecycle scripts before publication", () => {
      expect(block).toContain("ref: ${{ github.sha }}");
      expect(block).not.toContain("needs.target_lock.outputs");
      expect(install).toContain(`npm ci --prefix ${runtime} --ignore-scripts --no-audit --no-fund`);
      expect(block).not.toMatch(/pnpm (?:install|exec|test)|npm install|--no-frozen-lockfile|--lockfile-only/);
      expect(block).toContain(`${runtime}/node_modules/tsx/dist/cli.mjs`);
      if (job === "publish_history") {
        const credentials = block.indexOf("Exchange GitHub OIDC");
        expect(block.indexOf("npm ci")).toBeLessThan(credentials);
        expect(block.slice(credentials)).not.toMatch(/npm (?:ci|install)|pnpm|npx/);
        expect(block.indexOf("cli.js install --with-deps --only-shell chromium")).toBeLessThan(credentials);
      }
    });

    it.each(["clean", "stale-lock", "existing-root-modules"])("real offline npm ci handles %s without root or dependency lifecycle execution", (scenario) => {
      expect(install).toBeTruthy();
      const dir = mkdtempSync(path.join(os.tmpdir(), "trusted-report-runtime-"));
      try {
        const prefix = path.join(dir, runtime);
        mkdirSync(path.join(prefix, "fixture/package"), { recursive: true });
        const trap = "node -e \"require('fs').writeFileSync('LIFECYCLE-RAN','bad')\"";
        writeFileSync(path.join(prefix, "fixture/package/package.json"), JSON.stringify({ name: "owned-fixture", version: "1.0.0", scripts: { postinstall: trap } }));
        execFileSync("tar", ["-czf", "../fixture.tgz", "package"], { cwd: path.join(prefix, "fixture") });
        const integrity = "sha512-" + createHash("sha512").update(readFileSync(path.join(prefix, "fixture.tgz"))).digest("base64");
        const manifest = { name: "report-fixture", version: "1.0.0", private: true, dependencies: { "owned-fixture": "file:fixture.tgz" }, scripts: { postinstall: trap } };
        writeFileSync(path.join(prefix, "package.json"), JSON.stringify(manifest));
        const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: {
          "": { name: manifest.name, version: manifest.version, dependencies: manifest.dependencies, hasInstallScript: true },
          "node_modules/owned-fixture": { version: "1.0.0", resolved: "file:fixture.tgz", integrity, hasInstallScript: true },
        } };
        const lockBytes = JSON.stringify(lock);
        writeFileSync(path.join(prefix, "package-lock.json"), lockBytes);
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "never-install-root", scripts: { preinstall: "exit 91", postinstall: trap } }));
        writeFileSync(path.join(dir, "pnpm-lock.yaml"), "unchanged-root-lock\n");
        mkdirSync(path.join(dir, "packages/adapter-utils"), { recursive: true });
        execFileSync("git", ["init", "--quiet"], { cwd: dir });
        execFileSync("git", ["add", "."], { cwd: dir });
        execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "fixture"], { cwd: dir });
        if (scenario === "stale-lock") writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ ...manifest, dependencies: { "missing-from-reviewed-lock": "9.0.0" } }));
        if (scenario === "existing-root-modules") mkdirSync(path.join(dir, "node_modules"));
        const result = spawnSync("bash", ["-c", install!], { cwd: dir, encoding: "utf8", env: {
          PATH: process.env.PATH, HOME: dir, NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_CACHE: path.join(dir, "empty-npm-cache"),
          NPM_CONFIG_USERCONFIG: path.join(dir, "no-user-npmrc"), NPM_CONFIG_UPDATE_NOTIFIER: "false",
        } });
        if (scenario !== "clean") expect(result.status, result.stderr).not.toBe(0);
        else {
          expect(result.status, result.stderr).toBe(0);
          expect(existsSync(path.join(dir, "node_modules/owned-fixture/package.json"))).toBe(true);
        }
        for (const location of [dir, prefix, path.join(prefix, "node_modules/owned-fixture")]) expect(existsSync(path.join(location, "LIFECYCLE-RAN"))).toBe(false);
        expect(readFileSync(path.join(prefix, "package-lock.json"), "utf8")).toBe(lockBytes);
        expect(readFileSync(path.join(dir, "pnpm-lock.yaml"), "utf8")).toBe("unchanged-root-lock\n");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });
}
