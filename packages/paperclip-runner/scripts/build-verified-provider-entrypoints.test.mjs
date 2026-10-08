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
      if (entrypoint.name === "acpx-runtime-sidecar") {
        assert.ok(Object.keys(bundle.metafile.inputs).some(path => path.endsWith("qualified-runtime-artifacts.json")),
          "Both provider bundle formats must include the shared runtime qualification data");
        assert.match(source, /paperclip\.acpx-runtime-artifacts\.v1/);
        assert.match(source, /12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad/);
        assert.match(source, /fe503f65c6289d59c23e5b21ae44f03583f997dd33a2cbfc75ab4f96fb8fc73f/);
        assert.doesNotMatch(source, /require\(["'][^"']*qualified-runtime-artifacts\.json/);
      }
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
