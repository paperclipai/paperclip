import assert from "node:assert/strict";
import test from "node:test";

import { hasManifestChange } from "./prepare-pr-lockfile.mjs";

test("manifest changes include workspace package manifests", () => {
  assert.equal(hasManifestChange(["packages/plugins/plugin-paperclip-github/package.json"]), true);
});

test("manifest changes include root dependency config", () => {
  assert.equal(hasManifestChange(["pnpm-workspace.yaml"]), true);
  assert.equal(hasManifestChange([".npmrc"]), true);
  assert.equal(hasManifestChange(["pnpmfile.cjs"]), true);
});

test("non-manifest changes do not refresh the lockfile", () => {
  assert.equal(hasManifestChange(["README.md", "server/src/app.ts"]), false);
});
