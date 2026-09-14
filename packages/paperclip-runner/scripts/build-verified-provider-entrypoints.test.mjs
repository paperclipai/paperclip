import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
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
