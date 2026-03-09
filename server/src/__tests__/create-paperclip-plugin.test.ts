import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scaffoldPluginProject } from "../../../packages/plugins/create-paperclip-plugin/src/index.js";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "create-paperclip-plugin-"));
}

function rmTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("scaffoldPluginProject", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) rmTmpDir(dir);
    tempDirs.length = 0;
  });

  it("creates expected scaffold files and category defaults for workspace template", () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const outDir = path.join(root, "acme-plugin");

    const created = scaffoldPluginProject({
      pluginName: "@acme/acme-plugin",
      outputDir: outDir,
      template: "workspace",
    });

    expect(created).toBe(outDir);
    expect(fs.existsSync(path.join(outDir, "src", "manifest.ts"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "src", "worker.ts"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "src", "ui", "index.tsx"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "tests", "plugin.spec.ts"))).toBe(true);
    expect(fs.existsSync(path.join(outDir, "rollup.config.mjs"))).toBe(true);

    const manifest = fs.readFileSync(path.join(outDir, "src", "manifest.ts"), "utf8");
    expect(manifest).toContain('id: "acme.acme-plugin"');
    expect(manifest).toContain('categories: ["workspace"]');

    const worker = fs.readFileSync(path.join(outDir, "src", "worker.ts"), "utf8");
    expect(worker).toContain('import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";');
    expect(worker).toContain("runWorker(plugin, import.meta.url);");

    const pkgJson = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf8")) as {
      keywords: string[];
      devDependencies: Record<string, string>;
    };
    expect(pkgJson.keywords).toContain("workspace");
    expect(pkgJson.devDependencies).toMatchObject({
      "@rollup/plugin-node-resolve": "^16.0.1",
      "@rollup/plugin-typescript": "^12.1.2",
      tslib: "^2.8.1",
    });

    const rollupConfig = fs.readFileSync(path.join(outDir, "rollup.config.mjs"), "utf8");
    expect(rollupConfig).toContain('import { nodeResolve } from "@rollup/plugin-node-resolve";');
    expect(rollupConfig).toContain('import typescript from "@rollup/plugin-typescript";');
    expect(rollupConfig).toContain("nodeResolve({");
    expect(rollupConfig).toContain("typescript({");
  });

  it("escapes string values safely in generated manifest", () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const outDir = path.join(root, "quoted-plugin");

    scaffoldPluginProject({
      pluginName: "@acme/quoted-plugin",
      outputDir: outDir,
      displayName: 'Test "Plugin"',
      description: 'Description with "quotes"',
      author: 'Author "Name"',
      category: "ui",
    });

    const manifest = fs.readFileSync(path.join(outDir, "src", "manifest.ts"), "utf8");
    expect(manifest).toContain('displayName: "Test \\"Plugin\\""');
    expect(manifest).toContain('description: "Description with \\"quotes\\""');
    expect(manifest).toContain('author: "Author \\"Name\\""');
    expect(manifest).toContain('categories: ["ui"]');
  });

  it("throws for invalid category", () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const outDir = path.join(root, "bad-category");

    expect(() =>
      scaffoldPluginProject({
        pluginName: "@acme/bad-category",
        outputDir: outDir,
        category: "invalid" as "connector",
      })
    ).toThrow("Invalid category");
  });

  it("throws when output directory already exists", () => {
    const root = mkTmpDir();
    tempDirs.push(root);
    const outDir = path.join(root, "already-there");
    fs.mkdirSync(outDir, { recursive: true });

    expect(() =>
      scaffoldPluginProject({
        pluginName: "@acme/already-there",
        outputDir: outDir,
      })
    ).toThrow("Directory already exists");
  });
});
