import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-create-paperclip-plugin-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("create-paperclip-plugin entrypoints", () => {
  it("keeps src/index.ts import-safe when process.argv points at another bundled CLI", async () => {
    const originalArgv = process.argv;
    const outputRoot = makeTempDir();

    try {
      process.argv = [process.execPath, path.resolve("cli/dist/index.js"), "demo-plugin", "--output", outputRoot];
      const library = await import("./index.js");

      expect(library.scaffoldPluginProject).toBeTypeOf("function");
      expect(fs.existsSync(path.join(outputRoot, "demo-plugin"))).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("runs scaffolding from src/bin.ts", async () => {
    const { runCli } = await import("./bin.js");
    const outputRoot = makeTempDir();
    const stdout: string[] = [];
    const outputDir = path.join(outputRoot, "demo-plugin");

    const result = runCli(
      [
        process.execPath,
        "create-paperclip-plugin",
        "demo-plugin",
        "--output",
        outputRoot,
        "--sdk-path",
        path.resolve("packages/plugins/sdk"),
      ],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => {
          throw new Error(message);
        },
        exit: (code) => {
          throw new Error(`unexpected exit ${code}`);
        },
      },
    );

    expect(result).toBe(outputDir);
    expect(stdout).toEqual([`Created plugin scaffold at ${outputDir}`]);
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "package.json"), "utf8"))).toMatchObject({
      name: "demo-plugin",
      paperclipPlugin: {
        manifest: "./dist/manifest.js",
        worker: "./dist/worker.js",
        ui: "./dist/ui/",
      },
    });
  });

  it("scaffolds a plugin connector for the connector template", async () => {
    const { scaffoldPluginProject } = await import("./index.js");
    const outputDir = scaffoldPluginProject({ pluginName: "records-plugin", outputDir: path.join(makeTempDir(), "records-plugin"), template: "connector" });
    const manifest = fs.readFileSync(path.join(outputDir, "src", "manifest.ts"), "utf8");
    const worker = fs.readFileSync(path.join(outputDir, "src", "worker.ts"), "utf8");
    expect(manifest).toContain('"connectors.provide"');
    expect(manifest).toContain('transport: "plugin"');
    expect(manifest).toContain('name: "lookup_record"');
    expect(worker).toContain('ctx.connectors.register("records", "lookup_record"');
    expect(worker).toContain("`Record ${id} (${region})`");
    const defaults = scaffoldPluginProject({ pluginName: "plain-plugin", outputDir: path.join(makeTempDir(), "plain-plugin") });
    expect(fs.readFileSync(path.join(defaults, "src", "manifest.ts"), "utf8")).not.toContain("connectors.provide");
  });
});
