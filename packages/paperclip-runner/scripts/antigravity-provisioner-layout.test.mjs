import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravityProvisionerDestination, antigravityProvisionerPackageRoot, antigravityRuntimeCachePath } from "./antigravity-provisioner-layout.mjs";

test("both published setup layouts share the OS-user cache", () => {
  const distribution = { platform: "darwin", architecture: "arm64", closureSha256: "a".repeat(64) };
  for (const root of ["/usr/local/lib/node_modules", "/Users/operator/project/node_modules"]) {
    for (const suffix of ["@paperclipai/server/dist/vendor/paperclip-runner/cli/provision-antigravity.cjs", "@paperclipai/paperclip-runner/dist/cli/provision-antigravity.cjs"]) {
      const url = `file://${root}/${suffix}`;
      assert.equal(antigravityProvisionerDestination(url, distribution, "/Users/operator"), `/Users/operator/.paperclip/runtimes/antigravity/darwin-arm64/${distribution.closureSha256}`);
      assert.match(antigravityProvisionerPackageRoot(url), /paperclip-runner$/);
    }
  }
});

test("foreign layouts and cache identities cannot redirect setup", () => {
  for (const url of ["file:///repo/scripts/provision-antigravity.mjs", "file:///tmp/provision-antigravity.cjs", "https://example.com/dist/cli/provision-antigravity.js", "file:///consumer/dist/cli/provision-antigravity.js?redirect=1"]) assert.throws(() => antigravityProvisionerPackageRoot(url), /published provisioner/);
  for (const values of [["../escape", "darwin", "arm64", "/Users/operator"], ["a".repeat(64), "../escape", "arm64", "/Users/operator"], ["a".repeat(64), "darwin", "arm64", "relative-home"]]) assert.throws(() => antigravityRuntimeCachePath(...values), /cache identity/);
});
