import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorProvisionerPackageRoot } from "./cursor-provisioner-layout.mjs";

test("public server setup owns the same asset root as its vendored runtime", () => {
  assert.equal(cursorProvisionerPackageRoot("file:///consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/cli/provision-cursor.cjs"), "/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner");
});
test("standalone runner setup owns package assets", () => {
  assert.equal(cursorProvisionerPackageRoot("file:///consumer/node_modules/@paperclipai/paperclip-runner/dist/cli/provision-cursor.cjs"), "/consumer/node_modules/@paperclipai/paperclip-runner");
});
test("unbundled and foreign layouts cannot provision outside an owned package", () => {
  for (const url of ["file:///repo/packages/paperclip-runner/scripts/provision-cursor.mjs", "file:///tmp/provision-cursor.cjs", "https://example.com/dist/cli/provision-cursor.js", "file:///consumer/dist/cli/provision-cursor.js?redirect=1"]) assert.throws(() => cursorProvisionerPackageRoot(url), /published provisioner/);
});
