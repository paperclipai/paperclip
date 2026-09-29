import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { COPILOT_DISTRIBUTIONS, materializePinnedCopilotBinary, resolveCopilotDistribution } from "./materialize-copilot-binary.mjs";
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(version = "1.0.88") {
  const root = await mkdtemp(join(tmpdir(), "paperclip-copilot-materializer-")); directories.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@github/copilot-linux-x64", version }));
  await writeFile(join(root, "copilot"), "#!/bin/sh\nexit 98\n", { mode: 0o755 });
  return root;
}
test("pins every requested platform and rejects unqualified platforms", () => {
  assert.deepEqual(Object.keys(COPILOT_DISTRIBUTIONS), ["darwin-arm64", "darwin-x64", "linux-x64"]);
  for (const [key, value] of Object.entries(COPILOT_DISTRIBUTIONS)) {
    assert.match(value.executableDigest, /^[a-f0-9]{64}$/);
    assert.match(value.archiveIntegrity, /^sha512-/);
    assert.equal(resolveCopilotDistribution(...key.split("-")), value);
  }
  assert.throws(() => resolveCopilotDistribution("linux", "arm64"), /not pinned/);
});
test("refuses a different version before opening or executing the binary", async () => {
  const packageRoot = await fixture("1.0.89");
  assert.throws(() => materializePinnedCopilotBinary({ packageRoot, platform: "linux", architecture: "x64" }), /Expected/);
});
test("refuses executable tampering even when package metadata claims the right version", async () => {
  const packageRoot = await fixture();
  assert.throws(() => materializePinnedCopilotBinary({ packageRoot, platform: "linux", architecture: "x64" }), /digest/);
});
test("refuses executable symlinks, directory entries and writable binaries", async () => {
  const packageRoot = await fixture(); const binary = join(packageRoot, "copilot");
  await chmod(binary, 0o777);
  assert.throws(() => materializePinnedCopilotBinary({ packageRoot, platform: "linux", architecture: "x64" }), /permissions/);
  await rm(binary); await symlink(join(packageRoot, "package.json"), binary);
  assert.throws(() => materializePinnedCopilotBinary({ packageRoot, platform: "linux", architecture: "x64" }));
  await rm(binary); await mkdir(binary);
  assert.throws(() => materializePinnedCopilotBinary({ packageRoot, platform: "linux", architecture: "x64" }), /regular file/);
});
