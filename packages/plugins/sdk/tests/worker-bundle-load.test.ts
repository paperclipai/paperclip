/**
 * Regression test for the node-platform ESM worker createRequire banner.
 *
 * Verifies that a worker bundle built with the SDK preset can load CJS
 * transitive deps that call require(<builtin>) at module-load time, without
 * throwing "Dynamic require of X is not supported".
 *
 * Background: on Node.js <=22.11.x (pre-native-require-in-ESM), esbuild's
 * __require shim throws when `typeof require === "undefined"`. The createRequire
 * banner makes require available so the shim passes through. Node.js >=22.12.0
 * provides require natively in ESM, so the runtime test passes unconditionally
 * there — the important invariant for fleet plugins is that the banner is
 * present in the bundle so plugins work on the target (node20).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import * as esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";

import { createPluginBundlerPresets } from "../src/bundlers.js";

describe("worker-bundle-load: node-platform ESM with CJS require(builtin)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeTempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-sdk-bundle-"));
    tempDirs.push(dir);
    return dir;
  }

  async function buildFixtureBundle(opts: {
    tmpDir: string;
    nodeWorkerBanner?: string | false;
  }): Promise<string> {
    const { tmpDir, nodeWorkerBanner } = opts;
    const srcDir = path.join(tmpDir, "src");
    const outDir = path.join(tmpDir, "dist");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    // Fake CJS dep that calls require("buffer") at module load time — the
    // same pattern that causes the crash in msal-node transitive deps.
    fs.writeFileSync(
      path.join(srcDir, "fake-cjs-dep.cjs"),
      'module.exports.getBuffer = function() { return require("buffer").Buffer; };\n',
    );

    // Minimal worker entry that imports the CJS dep and exercises require().
    const workerEntry = path.join(srcDir, "worker.ts");
    fs.writeFileSync(
      workerEntry,
      [
        "import { getBuffer } from './fake-cjs-dep.cjs';",
        "console.log(String(getBuffer().isBuffer(null)));",
      ].join("\n") + "\n",
    );

    const presets = createPluginBundlerPresets({
      workerEntry,
      outdir: outDir,
      sourcemap: false,
      ...(nodeWorkerBanner !== undefined ? { nodeWorkerBanner } : {}),
    });

    await esbuild.build(presets.esbuild.worker);

    // esbuild names the output after the entry file: worker.ts → worker.js
    return path.join(outDir, "worker.js");
  }

  function runBundle(bundlePath: string): { exitCode: number | null; combined: string } {
    // Load the ESM bundle via `node --input-type=module` so the temp dir does
    // not need a package.json with "type":"module".
    const result = spawnSync(
      process.execPath,
      ["--input-type=module"],
      {
        input: `import ${JSON.stringify(pathToFileURL(bundlePath).href)};\n`,
        timeout: 15_000,
        encoding: "utf-8",
      },
    );
    return {
      exitCode: result.status,
      combined: (result.stdout ?? "") + (result.stderr ?? ""),
    };
  }

  // --- Unit tests: banner presence in config objects ---

  it("default preset esbuild worker config has createRequire banner", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.esbuild.worker.banner?.js).toContain("createRequire");
    expect(presets.esbuild.worker.banner?.js).toContain("import.meta.url");
  });

  it("default preset rollup worker output config has createRequire banner", () => {
    const presets = createPluginBundlerPresets();
    expect(presets.rollup.worker.output.banner).toContain("createRequire");
    expect(presets.rollup.worker.output.banner).toContain("import.meta.url");
  });

  it("nodeWorkerBanner:false omits banner from esbuild and rollup configs", () => {
    const presets = createPluginBundlerPresets({ nodeWorkerBanner: false });
    expect(presets.esbuild.worker.banner).toBeUndefined();
    expect(presets.rollup.worker.output.banner).toBeUndefined();
  });

  it("custom nodeWorkerBanner string is forwarded to esbuild and rollup", () => {
    const custom = "// custom banner";
    const presets = createPluginBundlerPresets({ nodeWorkerBanner: custom });
    expect(presets.esbuild.worker.banner?.js).toBe(custom);
    expect(presets.rollup.worker.output.banner).toBe(custom);
  });

  it("banner is absent from UI and manifest esbuild presets (browser/node manifest)", () => {
    const presets = createPluginBundlerPresets({ uiEntry: "src/ui.tsx" });
    // manifest is node+esm but does not have CJS-interop concerns (externalized deps)
    expect(presets.esbuild.manifest.banner).toBeUndefined();
    // ui bundle is browser-targeted, never needs require()
    expect(presets.esbuild.ui?.banner).toBeUndefined();
  });

  // --- Integration test: bundle built with banner loads cleanly ---

  it("bundle built with default preset executes without Dynamic require crash", async () => {
    const tmpDir = makeTempDir();
    const bundlePath = await buildFixtureBundle({ tmpDir });

    // Confirm the banner is baked into the bundle source.
    const bundleSrc = fs.readFileSync(bundlePath, "utf-8");
    expect(bundleSrc).toContain("createRequire");

    // Run the bundle. On Node >=22.12 require() is natively available in ESM;
    // on older runtimes the banner is what makes this succeed.
    const { exitCode, combined } = runBundle(bundlePath);
    expect(combined).not.toMatch(/Dynamic require/i);
    expect(exitCode).toBe(0);
  });

  it("bundle built with nodeWorkerBanner:false does not contain createRequire", async () => {
    const tmpDir = makeTempDir();
    const bundlePath = await buildFixtureBundle({ tmpDir, nodeWorkerBanner: false });

    const bundleSrc = fs.readFileSync(bundlePath, "utf-8");
    expect(bundleSrc).not.toContain("createRequire");
    // The __require shim IS still present (esbuild-generated)
    expect(bundleSrc).toContain("__require");
  });
});
