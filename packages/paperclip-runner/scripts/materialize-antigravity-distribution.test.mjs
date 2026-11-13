import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { antigravityArchiveEntries, antigravityDistribution } from "./materialize-antigravity-distribution.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = [
  { path: "agy_acp_server.par", content: Buffer.from("native ACP server fixture\n") },
  { path: "localharness_external", content: Buffer.from("owned native child fixture\n") },
];

// A minimal stored ZIP fixture exercises the real inspector and filesystem.
// Integrity comes from the checked-in archive and complete-file SHA-256 pins.
function zip(entries = files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const content = entry.content ?? Buffer.from("fixture");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(0x314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100755) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, content);
    centrals.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

async function fixture(t, { expectedFiles = files, expectedVendorFiles = files, archive = zip(), patchSuffix = "", baseDirectory = tmpdir(), changeParentDuringPatch = false } = {}) {
  const root = await realpath(await mkdtemp(join(baseDirectory, "paperclip-antigravity-provision-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  for (const name of ["materialize-antigravity-distribution.mjs", "antigravity-provisioner-layout.mjs", "provision-antigravity.mjs"]) await copyFile(new URL(name, import.meta.url), join(scripts, name));
  const admissionSource = "# trusted test admission source\n";
  const admissionSourceSha256 = hash(admissionSource);
  await writeFile(join(scripts, "patch-antigravity-runtime.admission.py"), admissionSource);
  await writeFile(join(scripts, "patch-antigravity-runtime.mjs"), `
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const ANTIGRAVITY_PATCH_VERSION='1.4.3-paperclip.1';
export async function patchAntigravityRuntime({source,destination}) {
 await writeFile(${JSON.stringify(join(root, "patch.called"))},'called');
 await mkdir(destination,{mode:0o700});
 for(const name of ['agy_acp_server.par','localharness_external']) {
  const content=await readFile(join(source,name));
  await writeFile(join(destination,name),name==='agy_acp_server.par'?Buffer.concat([content,Buffer.from(${JSON.stringify(patchSuffix)})]):content,{mode:0o500});
 }
 ${changeParentDuringPatch ? `await chmod(${JSON.stringify(join(root, "home/.paperclip/runtimes/antigravity/darwin-arm64"))},0o777);` : ""}
 return {version:ANTIGRAVITY_PATCH_VERSION,admissionSourceSha256:${JSON.stringify(admissionSourceSha256)}};
}
`);
  const entries = expectedFiles.map(entry => ({ path: entry.path, sha256: hash(entry.content), size: entry.content.length, executable: true }));
  const closureSha256 = hash(JSON.stringify(entries));
  const vendorEntries = expectedVendorFiles.map(entry => ({ path: entry.path, sha256: hash(entry.content), size: entry.content.length, executable: true }));
  // The code is copied into an isolated package so its normal fixed manifest
  // read uses a tiny trusted fixture. Production has no manifest-path override.
  await writeFile(join(root, "antigravity-distributions.json"), JSON.stringify({
    schema: "paperclip.antigravity_distribution.v1", version: "1.4.3",
    platforms: { "darwin-arm64": {
      url: "https://dl.google.com/agy-extensions/releases/macos/fixture.zip",
      archiveSha256: hash(archive), closureSha256, vendorEntries, vendorClosureSha256: hash(JSON.stringify(vendorEntries)), patchVersion: "1.4.3-paperclip.1", admissionSourceSha256, provisioning: "verified-closure",
      executable: "agy_acp_server.par", args: [], entries,
    } },
  }));
  const archivePath = join(root, "fixture.zip");
  await writeFile(archivePath, archive);
  const api = await import(pathToFileURL(join(scripts, "materialize-antigravity-distribution.mjs")));
  const provisioner = await import(pathToFileURL(join(scripts, "provision-antigravity.mjs")));
  const home = join(root, "home");
  const destination = join(home, ".paperclip/runtimes/antigravity/darwin-arm64", closureSha256);
  const options = { platform: "darwin", architecture: "arm64", archivePath, destination };
  const provision = () => provisioner.provisionAntigravityRuntime({ ...options, home, moduleUrl: "file:///consumer/node_modules/@paperclipai/paperclip-runner/dist/cli/provision-antigravity.cjs" });
  return { root, destination, options, api, provision, distribution: await api.antigravityDistribution("darwin", "arm64") };
}

test("the inspected native mac ARM closure is pinned; other platforms remain inventory-only", async () => {
  const pin = await antigravityDistribution("darwin", "arm64");
  assert.equal(pin.version, "1.4.3");
  assert.deepEqual(pin.entries.map(entry => entry.path), files.map(entry => entry.path));
  assert.equal(hash(JSON.stringify(pin.entries)), pin.closureSha256);
  for (const [platform, architecture] of [["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"]]) await assert.rejects(antigravityDistribution(platform, architecture), /inventory-only/);
  await assert.rejects(antigravityDistribution("win32", "x64"), /no pinned distribution/);
});

test("ZIP inspection rejects traversal, absolute names, duplicates, links and partial closure", () => {
  assert.deepEqual(antigravityArchiveEntries(zip()).map(entry => entry.path), files.map(entry => entry.path));
  for (const entries of [
    [{ ...files[0], path: "../agy_acp_server.par" }, files[1]],
    [{ ...files[0], path: "/agy_acp_server.par" }, files[1]],
    [{ ...files[0], path: "dir\\agy_acp_server.par" }, files[1]],
    [files[0], files[0]],
    [{ ...files[0], mode: 0o120755 }, files[1]],
    [{ ...files[0], mode: 0o060755 }, files[1]],
    [files[0]],
  ]) assert.throws(() => antigravityArchiveEntries(zip(entries)), /unsafe or unsupported ZIP/);
});

test("ZIP inspection rejects disagreeing headers and overlapping payloads", () => {
  const disagreeing = zip();
  disagreeing.writeUInt16LE(8, 8);
  assert.throws(() => antigravityArchiveEntries(disagreeing), /unsafe or unsupported ZIP/);
  const overlapping = zip();
  const end = overlapping.length - 22;
  const central = overlapping.readUInt32LE(end + 16);
  const secondCentral = central + 46 + Buffer.byteLength(files[0].path);
  overlapping.writeUInt32LE(0, secondCentral + 42);
  assert.throws(() => antigravityArchiveEntries(overlapping), /unsafe or unsupported ZIP/);
});

test("a corrupted archive never installs and its temporary directory is removed", async t => {
  const { api, options, destination } = await fixture(t);
  await writeFile(options.archivePath, "corrupt archive");
  await assert.rejects(api.materializePinnedAntigravityDistribution(options), /archive digest mismatch/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(destination, "..")), []);
});

test("installation preserves and verifies the complete two-binary closure", async t => {
  const { api, options, destination, distribution } = await fixture(t);
  const result = await api.materializePinnedAntigravityDistribution(options);
  assert.equal(result.executable, join(destination, files[0].path));
  assert.equal(result.closureSha256, distribution.closureSha256);
  for (const file of files) {
    assert.deepEqual(await readFile(join(destination, file.path)), file.content);
    assert.equal((await lstat(join(destination, file.path))).mode & 0o777, 0o500);
  }
  assert.equal((await api.verifyAntigravityDistribution(destination, distribution)).sha256, distribution.closureSha256);
  assert.deepEqual(await readdir(join(destination, "..")), [distribution.closureSha256]);
  await assert.rejects(api.materializePinnedAntigravityDistribution(options), /already exists/);
});

test("a failed full-closure check leaves no partial installation", async t => {
  const expectedFiles = files.map(file => ({ ...file, content: Buffer.from(`wrong expected ${file.path}`) }));
  const { api, options, destination } = await fixture(t, { expectedFiles });
  await assert.rejects(api.materializePinnedAntigravityDistribution(options), /full execution closure digest mismatch/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(destination, "..")), []);
});

test("verified vendor bytes are patched and only the separately pinned final closure is installed", async t => {
  const patchSuffix = "\nowned native admission patch\n";
  const expectedFiles = files.map((file, index) => ({ ...file, content: index === 0 ? Buffer.concat([file.content, Buffer.from(patchSuffix)]) : file.content }));
  const { api, options, destination, root, distribution } = await fixture(t, { expectedFiles, patchSuffix });
  await api.materializePinnedAntigravityDistribution(options);
  assert.equal(await readFile(join(root, "patch.called"), "utf8"), "called");
  assert.notEqual(distribution.vendorClosureSha256, distribution.closureSha256);
  assert.deepEqual(await readFile(join(destination, files[0].path)), expectedFiles[0].content);
  assert.deepEqual(await readFile(join(destination, files[1].path)), files[1].content);
  await api.verifyAntigravityDistribution(destination, distribution);
});

test("vendor closure mismatch stops before the owned patch executes", async t => {
  const expectedVendorFiles = files.map(file => ({ ...file, content: Buffer.from(`wrong vendor ${file.path}`) }));
  const { api, options, root, destination } = await fixture(t, { expectedVendorFiles });
  await assert.rejects(api.materializePinnedAntigravityDistribution(options), /vendor execution closure digest mismatch/);
  await assert.rejects(readFile(join(root, "patch.called")), { code: "ENOENT" });
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  assert.deepEqual(await readdir(join(destination, "..")), []);
});

test("changed admission patch source is rejected before extraction or native execution", async t => {
  const { api, options, root, destination } = await fixture(t);
  await writeFile(join(root, "scripts/patch-antigravity-runtime.admission.py"), "# changed admission source\n");
  await assert.rejects(api.materializePinnedAntigravityDistribution(options), /patch source digest mismatch/);
  await assert.rejects(lstat(destination), { code: "ENOENT" });
  await assert.rejects(readFile(join(root, "patch.called")), { code: "ENOENT" });
});

test("repeated setup verifies installed bytes and refuses corruption without download or replacement", async t => {
  const { provision, destination, options } = await fixture(t);
  await provision();
  await rm(options.archivePath);
  await provision();
  const binary = join(destination, files[1].path);
  await chmod(binary, 0o700);
  await writeFile(binary, "corrupted native child");
  await assert.rejects(provision(), /full execution closure digest mismatch/);
  assert.equal(await readFile(binary, "utf8"), "corrupted native child");
});

test("rewriting the cached record or passing altered pins cannot authorize changed bytes", async t => {
  const { provision, api, destination, distribution } = await fixture(t);
  await provision();
  const recordPath = join(destination, api.ANTIGRAVITY_TREE_MANIFEST);
  await chmod(recordPath, 0o600);
  await writeFile(recordPath, JSON.stringify({ ...distribution, closureSha256: "a".repeat(64) }));
  await assert.rejects(provision(), /cached closure record/);
  await assert.rejects(api.verifyAntigravityDistribution(destination, { ...distribution, closureSha256: "a".repeat(64) }), /checked-in distribution pins/);
});

test("cached links, hardlinks, extra files and missing children fail closed", async t => {
  for (const kind of ["symlink", "hardlink", "extra", "missing", "record-link"]) {
    const current = await fixture(t);
    await current.provision();
    const child = join(current.destination, files[1].path);
    if (kind === "extra") await writeFile(join(current.destination, "unexpected-native-child"), "unexpected");
    else if (kind === "record-link") {
      const record = join(current.destination, current.api.ANTIGRAVITY_TREE_MANIFEST);
      const target = join(current.root, "record-copy.json");
      await copyFile(record, target);
      await rm(record);
      await symlink(target, record);
    } else {
      const target = join(current.root, "native-child-copy");
      await copyFile(child, target);
      await rm(child);
      if (kind === "symlink") await symlink(target, child);
      if (kind === "hardlink") await link(target, child);
    }
    await assert.rejects(current.provision(), /both native binaries|links or special files/);
  }
});

test("cached assets with shared write access and linked runtime roots fail closed", async t => {
  const { provision, api, destination, distribution, root } = await fixture(t);
  await provision();
  const binary = join(destination, files[1].path);
  await chmod(binary, 0o777);
  await assert.rejects(provision(), /unsafe file permissions/);
  await chmod(binary, 0o500);
  const linked = join(root, "linked-runtime");
  await symlink(destination, linked);
  await assert.rejects(api.verifyAntigravityDistribution(linked, distribution), /real directory/);
  await chmod(destination, 0o777);
  await assert.rejects(provision(), /private write access/);
  await chmod(destination, 0o700);
});

test("a private cached closure is rejected when another user could replace its parent entry", async t => {
  const { provision, destination } = await fixture(t);
  await provision();
  const parent = join(destination, "..");
  await chmod(parent, 0o777);
  try { await assert.rejects(provision(), /ancestor.*write|unsafe.*ancestor/); }
  finally { await chmod(parent, 0o700); }
});

test("publication refuses a replaceable cache parent before patching or creating a temporary installation", async t => {
  const { api, options, destination, root } = await fixture(t);
  const parent = join(destination, "..");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o777);
  try {
    await assert.rejects(api.materializePinnedAntigravityDistribution(options), /ancestor.*write|unsafe.*ancestor/);
    await assert.rejects(readFile(join(root, "patch.called")), { code: "ENOENT" });
    assert.deepEqual(await readdir(parent), []);
  } finally { await chmod(parent, 0o700); }
});

test("package pin sources beneath a replaceable ancestor cannot authorize installation", async t => {
  const { api, options, root } = await fixture(t);
  await chmod(root, 0o777);
  try { await assert.rejects(api.materializePinnedAntigravityDistribution(options), /ancestor.*write|unsafe.*ancestor/); }
  finally { await chmod(root, 0o700); }
});

test("canonical parent aliases keep a private owned installation valid", async t => {
  const { api, options, distribution, root } = await fixture(t);
  const home = join(root, "private-home");
  await mkdir(home, { mode: 0o700 });
  const alias = join(root, "home-alias");
  await symlink(home, alias);
  const destination = join(alias, "cache", distribution.closureSha256);
  await api.materializePinnedAntigravityDistribution({ ...options, destination });
  assert.equal((await api.verifyAntigravityDistribution(destination, distribution)).sha256, distribution.closureSha256);
});

test("a root-owned sticky temporary ancestor protects the private installation", async t => {
  const temporary = await realpath("/tmp");
  const stat = await lstat(temporary);
  if (stat.uid !== 0 || !(stat.mode & 0o1000)) return t.skip("requires the host's root-owned sticky temporary directory");
  const { provision, api, destination, distribution } = await fixture(t, { baseDirectory: "/tmp" });
  await provision();
  assert.equal((await api.verifyAntigravityDistribution(destination, distribution)).sha256, distribution.closureSha256);
});

test("source and cached ownership are checked for the current execution principal", async t => {
  const { api, provision, destination } = await fixture(t);
  await provision();
  const getuid = process.getuid;
  if (!getuid || getuid() === 0) return t.skip("requires a non-root principal to model foreign ownership without changing filesystem privileges");
  // Keep the real kernel metadata; model a different verifier principal rather
  // than chowning files or running another user's process during the test.
  process.getuid = () => getuid() + 1;
  try {
    await assert.rejects(api.antigravityDistributionClosure(destination), /untrusted filesystem owner/);
    await assert.rejects(api.antigravityDistribution("darwin", "arm64"), /untrusted filesystem owner/);
  } finally { process.getuid = getuid; }
});

test("a parent made replaceable while patching cannot receive a published runtime", async t => {
  const { api, options, destination } = await fixture(t, { changeParentDuringPatch: true });
  try {
    await assert.rejects(api.materializePinnedAntigravityDistribution(options), /ancestor.*write|unsafe.*ancestor/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(destination, "..")), []);
  } finally { await chmod(join(destination, ".."), 0o700); }
});
