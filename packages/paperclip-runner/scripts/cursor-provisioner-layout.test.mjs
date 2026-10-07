import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorProvisionerDestination, cursorProvisionerPackageRoot } from "./cursor-provisioner-layout.mjs";

test("recognizes the public server's vendored setup entrypoint", () => {
  assert.equal(cursorProvisionerPackageRoot("file:///consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/cli/provision-cursor.cjs"), "/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner");
});
test("recognizes the standalone runner's setup entrypoint", () => {
  assert.equal(cursorProvisionerPackageRoot("file:///consumer/node_modules/@paperclipai/paperclip-runner/dist/cli/provision-cursor.cjs"), "/consumer/node_modules/@paperclipai/paperclip-runner");
});
test("unbundled and foreign layouts cannot provision outside an owned package", () => {
  for (const url of ["file:///repo/packages/paperclip-runner/scripts/provision-cursor.mjs", "file:///tmp/provision-cursor.cjs", "https://example.com/dist/cli/provision-cursor.js", "file:///consumer/dist/cli/provision-cursor.js?redirect=1"]) assert.throws(() => cursorProvisionerPackageRoot(url), /published provisioner/);
});

test("global and local npm installations provision the same account-owned pinned cache", () => {
  const distribution = { platform: "linux", architecture: "x64", closureSha256: "a".repeat(64) };
  for (const prefix of ["/usr/local/lib/node_modules", "/home/operator/project/node_modules"]) {
    assert.equal(cursorProvisionerDestination(`file://${prefix}/@paperclipai/server/dist/vendor/paperclip-runner/cli/provision-cursor.cjs`, distribution, "/home/operator"),
      `/home/operator/.paperclip/runtimes/cursor/linux-x64/${distribution.closureSha256}`);
  }
});
