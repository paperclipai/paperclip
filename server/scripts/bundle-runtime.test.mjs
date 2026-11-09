import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bundleRuntime, preserveModuleLocation } from "./bundle-runtime.mjs";

const execFileAsync = promisify(execFile);

function write(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe("bundleRuntime", () => {
  let root;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(path.join(tmpdir(), "paperclip-bundle-runtime-")));
    const pkg = path.join(root, "packages", "fixture");
    write(path.join(pkg, "package.json"), JSON.stringify({ name: "@paperclipai/fixture", type: "module", exports: { ".": "./src/index.ts" } }));
    write(path.join(pkg, "src", "asset.txt"), "asset beside its source\n");
    write(path.join(pkg, "src", "helper.ts"), "export const double = (value: number): number => value * 2;\n");
    write(path.join(pkg, "src", "index.ts"), [
      "import { readFileSync } from \"node:fs\";",
      "import { double } from \"./helper.js\";",
      "import { onlyForPackage } from \"package-private-dep\";",
      "import { nodeBuild } from \"dual-build-dep\";",
      "export const asset = readFileSync(new URL(\"./asset.txt\", import.meta.url), \"utf8\").trim();",
      "export const location = import.meta.dirname;",
      "export const values = { doubled: double(21), onlyForPackage, nodeBuild };",
      "",
    ].join("\n"));
    write(path.join(pkg, "node_modules", "package-private-dep", "package.json"), JSON.stringify({ name: "package-private-dep", type: "module", main: "index.js" }));
    write(path.join(pkg, "node_modules", "package-private-dep", "index.js"), "export const onlyForPackage = \"resolved from the package\";\n");
    write(path.join(pkg, "node_modules", "dual-build-dep", "package.json"), JSON.stringify({
      name: "dual-build-dep", exports: { ".": { module: "./bundler/index.js", default: "./node.cjs" } },
    }));
    write(path.join(pkg, "node_modules", "dual-build-dep", "node.cjs"), "exports.nodeBuild = \"node build\";\n");
    write(path.join(pkg, "node_modules", "dual-build-dep", "bundler", "index.js"), "export * from \"./extensionless\";\n");

    const server = path.join(root, "server");
    mkdirSync(path.join(server, "node_modules", "@paperclipai"), { recursive: true });
    symlinkSync(pkg, path.join(server, "node_modules", "@paperclipai", "fixture"), "dir");
    write(path.join(server, "package.json"), JSON.stringify({ name: "server", type: "module" }));
    for (const [version, flavor] of [["1", "installed at build"], ["2", "replaced after build"]]) {
      const store = path.join(root, "node_modules", ".pnpm", `server-dep@${version}`);
      write(path.join(store, "package.json"), JSON.stringify({ name: "server-dep", type: "module", main: "index.js" }));
      write(path.join(store, "index.js"), `export const flavor = ${JSON.stringify(flavor)};\n`);
    }
    symlinkSync(path.join(root, "node_modules", ".pnpm", "server-dep@1"), path.join(server, "node_modules", "server-dep"), "dir");
    write(path.join(server, "dist", "late.js"), "import { values } from \"@paperclipai/fixture\";\nexport const late = () => values.doubled + 1;\n");
    write(path.join(server, "dist", "index.js"), [
      "import { asset, location, values } from \"@paperclipai/fixture\";",
      "import { flavor } from \"server-dep\";",
      "import { pathToFileURL } from \"node:url\";",
      "const { late } = await import(\"./late.js\");",
      "// The server only starts when it is the main module.",
      "if (pathToFileURL(process.argv[1]).href === import.meta.url) {",
      "  console.log(JSON.stringify({ asset, location, values, flavor, late: late(), entryDir: import.meta.dirname }));",
      "}",
      "",
    ].join("\n"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("bundles workspace TypeScript and runs with plain node", async () => {
    const outdir = path.join(root, "server", "dist-runtime");
    const summary = await bundleRuntime({ entry: path.join(root, "server", "dist", "index.js"), outdir });
    expect(summary.outfile).toBe(path.join(outdir, "index.mjs"));

    const { stdout } = await execFileAsync(process.execPath, [summary.outfile], { cwd: path.join(root, "server"), timeout: 30_000 });
    const output = JSON.parse(stdout);
    expect(output.values).toEqual({ doubled: 42, onlyForPackage: "resolved from the package", nodeBuild: "node build" });
    expect(output.late).toBe(43);
    expect(output.asset).toBe("asset beside its source");
    expect(output.location).toBe(path.join(root, "packages", "fixture", "src"));
    expect(output.entryDir).toBe(path.join(root, "server", "dist"));
  });

  it("emits a server module that loads without starting the server", async () => {
    const outdir = path.join(root, "server", "dist-runtime");
    const summary = await bundleRuntime({ entry: path.join(root, "server", "dist", "index.js"), outdir });
    expect(summary.serverModule).toBe(path.join(outdir, "server.mjs"));
    const probe = path.join(root, "server", "probe.mjs");
    write(probe, `await import(${JSON.stringify(pathToFileURL(summary.serverModule).href)});\nconsole.log("loaded");\n`);
    const loaded = await execFileAsync(process.execPath, [probe], { cwd: path.join(root, "server"), timeout: 30_000 });
    expect(loaded.stdout.trim()).toBe("loaded");
    const started = await execFileAsync(process.execPath, [summary.outfile], { cwd: path.join(root, "server"), timeout: 30_000 });
    expect(JSON.parse(started.stdout).late).toBe(43);
  });

  it("leaves the server's own dependencies to runtime resolution", async () => {
    const outdir = path.join(root, "server", "dist-runtime");
    const summary = await bundleRuntime({ entry: path.join(root, "server", "dist", "index.js"), outdir });
    rmSync(path.join(root, "server", "node_modules", "server-dep"));
    symlinkSync(path.join(root, "node_modules", ".pnpm", "server-dep@2"), path.join(root, "server", "node_modules", "server-dep"), "dir");
    const { stdout } = await execFileAsync(process.execPath, [summary.outfile], { cwd: path.join(root, "server"), timeout: 30_000 });
    expect(JSON.parse(stdout).flavor).toBe("replaced after build");
  });

  it("keeps third-party packages external", async () => {
    const outdir = path.join(root, "server", "dist-runtime");
    await bundleRuntime({ entry: path.join(root, "server", "dist", "index.js"), outdir });
    const { stdout } = await execFileAsync("grep", ["-rl", "resolved from the package", outdir], { encoding: "utf8" }).catch(() => ({ stdout: "" }));
    expect(stdout.trim()).toBe("");
  });
});

describe("preserveModuleLocation", () => {
  it("replaces import.meta location properties with the original path", () => {
    const file = "/srv/app/packages/x/src/mod.ts";
    const out = preserveModuleLocation("a(import.meta.url); b(import.meta.dirname); c(import.meta.filename); d(import.meta.resolve);", file);
    expect(out).toBe(`a("file:///srv/app/packages/x/src/mod.ts"); b("/srv/app/packages/x/src"); c("/srv/app/packages/x/src/mod.ts"); d(import.meta.resolve);`);
  });
});
