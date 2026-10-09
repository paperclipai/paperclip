import assert from "node:assert/strict";
import test from "node:test";
import { hermesProvisionerDestination, hermesProvisionerLayout } from "./hermes-provisioner-layout.mjs";

test("Hermes setup locates packaged Python materialization resources in both layouts", () => {
  for (const [url, root, provider] of [
    ["file:///consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/cli/provision-hermes.cjs", "/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner", "/consumer/node_modules/@paperclipai/server/dist/vendor/paperclip-runner/providers/hermes"],
    ["file:///consumer/node_modules/@paperclipai/paperclip-runner/dist/cli/provision-hermes.js", "/consumer/node_modules/@paperclipai/paperclip-runner", "/consumer/node_modules/@paperclipai/paperclip-runner/dist/providers/hermes"],
  ]) {
    assert.deepEqual(hermesProvisionerLayout(url), { root, provider, materializer: provider + "/materialize-hermes.py" });
  }
});
test("global and local npm setup share the execution account's pinned cache", () => {
  for (const prefix of ["/usr/local/lib/node_modules/paperclipai/node_modules", "/consumer/node_modules"]) {
    assert.equal(hermesProvisionerDestination(`file://${prefix}/@paperclipai/server/dist/vendor/paperclip-runner/cli/provision-hermes.cjs`, "a".repeat(64), "linux", "x64", "/home/operator"), "/home/operator/.paperclip/runtimes/hermes/linux-x64/" + "a".repeat(64));
  }
});
test("unbundled, foreign and parameterized setup paths cannot select cache authority", () => {
  for (const url of ["file:///repo/scripts/provision-hermes.mjs", "file:///tmp/provision-hermes.cjs", "https://example.com/dist/cli/provision-hermes.js", "file:///consumer/dist/cli/provision-hermes.cjs?redirect=1"]) assert.throws(() => hermesProvisionerLayout(url), /published provisioner/);
});
