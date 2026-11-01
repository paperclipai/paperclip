import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build, transform } from "esbuild";
import { bundleRuntime } from "../../scripts/bundle-runtime.mjs";
import { resolveBundledPluginRuntimeLoader } from "../services/bundled-plugin-runtime.js";

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "image-plugin-runtime-")));
  roots.push(root);
  fs.mkdirSync(path.join(root, "server", "dist-runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "package.json"), JSON.stringify({ name: "@paperclipai/server", type: "module" }));
  const loader = path.join(root, "cli", "node_modules", "tsx", "dist", "loader.mjs");
  fs.mkdirSync(path.dirname(loader), { recursive: true });
  fs.writeFileSync(loader, "export {};\n");
  return { root, loader };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("current image plugin runtime loader", () => {
  it.each(["src/services", "dist/services", "dist-runtime"])("resolves the owning release from server/%s", (location) => {
    const { root, loader } = fixture();
    const moduleDirectory = path.join(root, "server", location);
    fs.mkdirSync(moduleDirectory, { recursive: true });
    expect(resolveBundledPluginRuntimeLoader(moduleDirectory)).toBe(loader);
  });

  it("resolves a bundled entrypoint without preserved source module locations", async () => {
    const { root, loader } = fixture();
    const runtime = path.join(root, "server", "dist-runtime", "index.mjs");
    await build({
      stdin: { contents: `import { resolveBundledPluginRuntimeLoader } from ${JSON.stringify(fileURLToPath(new URL("../services/bundled-plugin-runtime.ts", import.meta.url)))}; process.stdout.write(resolveBundledPluginRuntimeLoader());`, resolveDir: process.cwd() },
      outfile: runtime, bundle: true, platform: "node", format: "esm", target: "node24", logLevel: "silent",
    });
    expect(execFileSync(process.execPath, [runtime], { encoding: "utf8" })).toBe(loader);
  });

  it("uses the production bundler's preserved module location at the dist-runtime entrypoint", async () => {
    const { root, loader } = fixture();
    const service = path.join(root, "server", "dist", "services", "bundled-plugin-runtime.js");
    fs.mkdirSync(path.dirname(service), { recursive: true });
    const source = fs.readFileSync(new URL("../services/bundled-plugin-runtime.ts", import.meta.url), "utf8");
    fs.writeFileSync(service, (await transform(source, { loader: "ts", format: "esm", target: "node24" })).code);
    const entry = path.join(root, "server", "dist", "probe.js");
    fs.writeFileSync(entry, 'import { resolveBundledPluginRuntimeLoader } from "./services/bundled-plugin-runtime.js"; process.stdout.write(resolveBundledPluginRuntimeLoader());');
    const bundled = await bundleRuntime({ entry, outdir: path.join(root, "server", "dist-runtime") });
    expect(execFileSync(process.execPath, [bundled.outfile], { encoding: "utf8" })).toBe(loader);
  });

  it("accepts the baked pnpm target inside the current image node_modules", () => {
    const { root, loader } = fixture();
    const physical = path.join(root, "node_modules", ".pnpm", "tsx@1", "node_modules", "tsx", "dist", "loader.mjs");
    fs.mkdirSync(path.dirname(physical), { recursive: true });
    fs.writeFileSync(physical, "export {};\n");
    fs.rmSync(loader); fs.symlinkSync(path.relative(path.dirname(loader), physical), loader);
    expect(resolveBundledPluginRuntimeLoader(path.join(root, "server", "dist-runtime"))).toBe(physical);
  });

  it("fails explicitly for missing or legacy-home loaders", () => {
    const { root, loader } = fixture();
    const moduleDirectory = path.join(root, "server", "dist-runtime");
    fs.rmSync(loader);
    expect(() => resolveBundledPluginRuntimeLoader(moduleDirectory)).toThrow("missing from the current image");
    const outside = fixture().loader;
    fs.symlinkSync(outside, loader);
    expect(() => resolveBundledPluginRuntimeLoader(moduleDirectory)).toThrow("escapes the current image");
  });
});
