import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { COPILOT_DISTRIBUTIONS, materializePinnedCopilotBinary, resolveCopilotDistribution, writeCopilotMaterialization } from "./materialize-copilot-binary.mjs";
const directories = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(version = "1.0.88") {
  const root = await mkdtemp(join(tmpdir(), "paperclip-copilot-materializer-")); directories.push(root);
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@github/copilot-linux-x64", version }));
  await writeFile(join(root, "copilot"), "#!/bin/sh\nexit 98\n", { mode: 0o755 });
  return fs.realpathSync(root);
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

const outputFiles = () => [
  { path: "copilot", bytes: Buffer.from("verified executable"), executable: true },
  { path: "distribution/nested/first.js", bytes: Buffer.from("verified first asset"), executable: false },
  { path: "distribution/nested/last.js", bytes: Buffer.from("verified last asset"), executable: false },
  { path: ".paperclip-copilot-closure.json", bytes: Buffer.from("verified closure"), executable: false },
];

test("partial inner writes roll back only owned entries and permit a clean retry", async t => {
  const root = await fixture(); const output = join(root, "output"); await mkdir(output);
  await writeFile(join(output, "caller-file"), "preserve");
  const originalWrite = fs.writeFileSync; let calls = 0;
  const mocked = t.mock.method(fs.default, "writeFileSync", (fd, bytes, ...args) => {
    if (++calls === 3) { originalWrite(fd, bytes.subarray(0, 3)); throw Object.assign(new Error("injected partial write"), { code: "ENOSPC" }); }
    return originalWrite(fd, bytes, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => writeCopilotMaterialization(output, outputFiles()), /injected partial write/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(output), ["caller-file"]);
  assert.equal(await readFile(join(output, "caller-file"), "utf8"), "preserve");
  writeCopilotMaterialization(output, outputFiles());
  for (const file of outputFiles()) assert.deepEqual(await readFile(join(output, file.path)), file.bytes);
});

test("failure preserves preexisting binary, directories, assets and closure", async () => {
  for (const collision of outputFiles()) {
    const root = await fixture(); const output = join(root, "output"); await mkdir(output);
    await mkdir(join(output, "distribution/nested"), { recursive: true });
    await writeFile(join(output, collision.path), "preexisting");
    assert.throws(() => writeCopilotMaterialization(output, outputFiles()), /EEXIST/);
    assert.equal(await readFile(join(output, collision.path), "utf8"), "preexisting");
    const kept = (await readdir(join(output, "distribution/nested"))).sort();
    assert.deepEqual(kept, collision.path.startsWith("distribution/") ? [collision.path.split("/").at(-1)] : []);
    assert.equal(fs.statSync(join(output, "distribution")).isDirectory(), true);
  }
});

test("rollback refuses a replaced owned entry and never removes foreign files", async t => {
  const root = await fixture(); const output = join(root, "output"); await mkdir(output);
  const originalWrite = fs.writeFileSync; let calls = 0;
  const mocked = t.mock.method(fs.default, "writeFileSync", (fd, bytes, ...args) => {
    if (++calls === 3) {
      fs.renameSync(join(output, "copilot"), join(output, "caller-retained-copy"));
      originalWrite(join(output, "copilot"), "foreign replacement", { flag: "wx" });
      throw new Error("injected replacement race");
    }
    return originalWrite(fd, bytes, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => writeCopilotMaterialization(output, outputFiles()), error => error instanceof AggregateError && error.errors.some(e => /entry identity changed/.test(e.message))); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(join(output, "copilot"), "utf8"), "foreign replacement");
  assert.equal(await readFile(join(output, "caller-retained-copy"), "utf8"), "verified executable");
});

test("owned cleanup never follows a preexisting destination symlink", async () => {
  const root = await fixture(); const output = join(root, "output"); const outside = join(root, "outside");
  await mkdir(output); await mkdir(outside); await symlink(outside, join(output, "distribution"));
  assert.throws(() => writeCopilotMaterialization(output, outputFiles()), /redirects through links/);
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(output), ["distribution"]);
});

test("in-place failure leaves the pinned source executable untouched", async t => {
  const root = await fixture(); const before = await readFile(join(root, "copilot"));
  const originalWrite = fs.writeFileSync; let calls = 0;
  const mocked = t.mock.method(fs.default, "writeFileSync", (fd, bytes, ...args) => {
    if (++calls === 2) { originalWrite(fd, bytes.subarray(0, 2)); throw new Error("injected asset failure"); }
    return originalWrite(fd, bytes, ...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => writeCopilotMaterialization(root, outputFiles().slice(1)), /injected asset failure/); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual((await readdir(root)).sort(), ["copilot", "package.json"]);
  assert.deepEqual(await readFile(join(root, "copilot")), before);
  writeCopilotMaterialization(root, outputFiles().slice(1));
  assert.deepEqual(await readFile(join(root, "copilot")), before);
});
