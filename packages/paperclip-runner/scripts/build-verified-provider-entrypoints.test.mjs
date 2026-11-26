import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  bundleVerifiedProviderEntrypoints,
  verifiedProviderEntrypoints,
} from "./build-verified-provider-entrypoints.mjs";

test("provider entrypoints include self-contained ESM and descriptor-safe CommonJS bundles", async () => {
  const bundles = await bundleVerifiedProviderEntrypoints({ write: false });
  assert.equal(bundles.length, verifiedProviderEntrypoints.length);
  for (const { entrypoint, result, verifiedResult } of bundles) {
    for (const bundle of [result, verifiedResult]) {
      assert.equal(bundle.outputFiles?.length, 1, entrypoint.name);
      const source = bundle.outputFiles[0].text;
      assert.match(source, /^#!\/usr\/bin\/env node\n/);
    }
    assert.doesNotMatch(
      verifiedResult.outputFiles[0].text,
      /\bimport\.meta\b/,
      entrypoint.name,
    );
  }
});

test("Copilot metadata probe runs as one standalone bundle in a selected pack layout", async (t) => {
  const bundles = await bundleVerifiedProviderEntrypoints({ write: false });
  const bundle = bundles.find(({ entrypoint }) => entrypoint.name === "copilot-metadata-probe");
  assert.ok(bundle, "The provider pack build must include the Copilot metadata probe");
  for (const result of [bundle.result, bundle.verifiedResult]) {
    for (const output of Object.values(result.metafile.outputs)) {
      for (const dependency of output.imports) assert.match(dependency.path, /^node:/);
    }
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-copilot-metadata-cli-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/cli"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"name":"@paperclipai/paperclip-runner","type":"module"}');
  for (const [name, result] of [["copilot-metadata-probe.js", bundle.result], ["copilot-metadata-probe.cjs", bundle.verifiedResult]]) {
    const entry = join(root, "dist/cli", name);
    await writeFile(entry, result.outputFiles[0].contents);
    const run = spawnSync(process.execPath, [entry], {
      cwd: root, env: { PATH: "/usr/bin:/bin", COPILOT_GITHUB_TOKEN: "test-token" }, encoding: "utf8", timeout: 20_000,
    });
    assert.ifError(run.error);
    assert.equal(run.status, 1, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      status: "failed",
      code: "COPILOT_INSTALLATION_INVALID",
      message: "The selected environment does not have the verified Copilot runtime installed.",
      promptSent: false,
    });
  }
});

test("written provider entrypoints satisfy qualified launch permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX launch permissions do not apply on Windows");
    return;
  }
  await bundleVerifiedProviderEntrypoints();
  for (const entrypoint of verifiedProviderEntrypoints) {
    for (const output of [entrypoint.output, entrypoint.verifiedOutput]) {
      const mode = (await stat(output)).mode;
      assert.equal(mode & 0o022, 0, entrypoint.name);
      assert.notEqual(mode & 0o100, 0, entrypoint.name);
    }
  }
});

// Package-layout regression runs in the existing verified-entrypoint test lane.
// Kimi layout suites are selected directly by test:typescript:prep; do not
// import them here or they register twice in that required run.
import "./provision-pi-package.test.mjs";

import "./antigravity-provisioner-layout.test.mjs";
import "./materialize-antigravity-distribution.test.mjs";
import "./materialize-antigravity-cli-distribution.test.mjs";
import "./probe-antigravity-metadata.test.mjs";
import "./patch-antigravity-runtime.test.mjs";
