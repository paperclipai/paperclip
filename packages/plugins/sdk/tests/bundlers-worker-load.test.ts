/**
 * Regression test: node-platform ESM worker bundles must not crash with
 * "Dynamic require of X is not supported" when CJS transitive deps call
 * require(<builtin>) at load time.
 *
 * The fix is the createRequire banner added to the esbuild worker preset in
 * createPluginBundlerPresets(). This test builds a fixture worker that imports
 * a synthetic CJS module calling require("buffer"), then loads the *built*
 * dist bundle in a child process — the only approach that catches packaging
 * regressions that mocked unit tests miss (SAG-3542 / SAG-3543).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "../src/bundlers.js";

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let workerWithBannerPath: string;
let workerWithoutBannerPath: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "pc-sdk-bundler-test-"));

  const srcDir = join(tmpDir, "src");
  mkdirSync(srcDir);

  // Synthetic CJS module that calls require("buffer") at load time —
  // mirrors the safe-buffer → jws → jsonwebtoken chain from @azure/msal-node.
  writeFileSync(
    join(tmpDir, "cjs-require-builtin.cjs"),
    [
      "// Simulates a CJS dep (safe-buffer/jws) that requires a Node builtin.",
      'const buf = require("buffer");',
      "module.exports = { Buffer: buf.Buffer };",
    ].join("\n"),
  );

  // Minimal fixture worker that imports the CJS dep.
  writeFileSync(
    join(srcDir, "worker.ts"),
    [
      "// Fixture: imports a CJS dep that calls require('buffer') at load time.",
      'import cjsDep from "../cjs-require-builtin.cjs";',
      "export default { name: 'fixture-worker', cjsDep };",
    ].join("\n"),
  );

  const workerEntry = join(srcDir, "worker.ts");

  // Build WITH the default banner (createRequire present).
  const presetsWithBanner = createPluginBundlerPresets({
    workerEntry,
    outdir: join(tmpDir, "dist-with-banner"),
    sourcemap: false,
  });
  await esbuild.build(presetsWithBanner.esbuild.worker);
  workerWithBannerPath = join(tmpDir, "dist-with-banner", "worker.js");

  // Build WITHOUT the banner (opt-out via nodeWorkerBanner: false).
  const presetsNoBanner = createPluginBundlerPresets({
    workerEntry,
    outdir: join(tmpDir, "dist-no-banner"),
    sourcemap: false,
    nodeWorkerBanner: false,
  });
  await esbuild.build(presetsNoBanner.esbuild.worker);
  workerWithoutBannerPath = join(tmpDir, "dist-no-banner", "worker.js");
}, 60_000);

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// Child-process loader helper
// ---------------------------------------------------------------------------

function loadBundleInChildProcess(workerPath: string): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const workerUrl = `file://${workerPath}`;
  // Strip PAPERCLIP_* vars so any runWorker() call fails fast (no host
  // connection) rather than spinning a retry loop that delays the child exit.
  const childEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("PAPERCLIP_")) {
      childEnv[k] = v;
    }
  }

  const loaderScript = `
import("${workerUrl}")
  .then(() => process.exit(0))
  .catch((e) => {
    const msg = String(e?.message ?? e);
    if (msg.includes("Dynamic require")) {
      process.stderr.write("[regression] Dynamic-require at load: " + msg + "\\n");
      process.exit(1);
    }
    // Any other error (e.g. worker failing to reach Paperclip host) is not a
    // packaging regression — the banner did its job.
    process.exit(0);
  });
`;

  const result = spawnSync(process.execPath, ["--input-type=module"], {
    input: loaderScript,
    timeout: 15_000,
    encoding: "utf8",
    env: childEnv,
  });

  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createPluginBundlerPresets — node worker ESM + CJS compat banner", () => {
  it("default preset: dist/worker.js loads without a Dynamic-require error", () => {
    const { status, stderr, stdout } = loadBundleInChildProcess(workerWithBannerPath);
    const combined = stderr + stdout;

    expect(
      combined,
      "dist/worker.js crashed with a Dynamic-require error — " +
        "the createRequire banner in the worker preset may be missing",
    ).not.toContain("Dynamic require");

    expect(
      status,
      `child exited with code ${status}; stderr: ${stderr}`,
    ).not.toBe(1);
  });

  it("nodeWorkerBanner: false — no banner means Dynamic-require error appears (sanity check)", () => {
    // This test proves the regression test is exercising the right code path:
    // removing the banner MUST cause the load-time crash on the fixture.
    const { stderr, stdout } = loadBundleInChildProcess(workerWithoutBannerPath);
    const combined = stderr + stdout;

    expect(
      combined,
      "Expected a Dynamic-require error when banner is suppressed, but none appeared — " +
        "the fixture may not be triggering the CJS require path",
    ).toContain("Dynamic require");
  });
});
