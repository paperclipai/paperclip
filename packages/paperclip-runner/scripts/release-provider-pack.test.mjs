import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import profiles from "../acpx-profiles.json" with { type: "json" };
import distributions from "../cursor-distributions.json" with { type: "json" };
import { verifyReleaseProviderPack } from "./release-provider-pack.mjs";
import { makeRunnerReleaseArchive, readRunnerReleaseArchive, verifyReleaseDaemonMetadata, verifyRunnerReleaseData } from "../../../scripts/release-runner-artifacts.mjs";
import { gzipSync, gunzipSync } from "node:zlib";

const revision = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
function fixture() {
  const payload = { target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: revision,
    pins: { acpx: profiles.acpxVersion },
    acpxProfileDigests: Object.fromEntries(["grok", "claude", "codex"].map(agent => [agent, profiles.profiles[agent].commandDigest])),
    providers: { cursor: { version: profiles.profiles.cursor.agentServerVersion, profileDigest: profiles.profiles.cursor.commandDigest,
      closureDigest: `sha256:${distributions.platforms["linux-x64"].closureSha256}`, qualification: "qualified",
      path: "provider-assets/cursor/linux-x64", sha256: digest } } };
  return payload;
}
function seal(payload) { return { schema: "paperclip-runner/remote-provider-pack/v1", payload,
  digest: `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}` }; }
function daemonMetadata() { return { schema: 'paperclip-runner/runnerd-build-metadata/v1', binaryName: 'paperclip-runnerd',
  packageName: '@paperclipai/paperclip-runner', packageVersion: '0.0.0', binaryContractVersion: 2, nativeExecutionVersion: 1,
  harnessDriverVersion: 1, prp: { name: 'paperclip.runner', minimumVersion: 1, maximumVersion: 2 },
  durableSessionCapabilities: ['unlimited_runtime', 'connection_lease_renewal'],
  prpTransportModes: ['dial_ws_loopback', 'dial_wss', 'listen_ws'] }; }

test('release daemon compatibility rejects lookalikes, incompatible contracts and missing production capabilities', () => {
  assert.equal(verifyReleaseDaemonMetadata(daemonMetadata()).binaryContractVersion, 2);
  for (const mismatch of [
    { schema: 'other' }, { binaryName: 'other' }, { packageName: 'other' }, { packageVersion: '' },
    { binaryContractVersion: 999 }, { nativeExecutionVersion: 2 }, { harnessDriverVersion: 2 },
    { prp: { name: 'other', minimumVersion: 1, maximumVersion: 2 } },
    { prp: { name: 'paperclip.runner', minimumVersion: 2, maximumVersion: 2 } },
    { prp: { name: 'paperclip.runner', minimumVersion: 1, maximumVersion: 1 } },
    { durableSessionCapabilities: ['unlimited_runtime'] }, { prpTransportModes: ['dial_ws_loopback'] },
  ]) assert.throws(() => verifyReleaseDaemonMetadata({ ...daemonMetadata(), ...mismatch }));
});

function releaseData() {
  const files = new Map(), platforms = {};
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
    const bytes = Buffer.alloc(64);
    if (target === "linux-x64") { bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(62, 18); }
    else { bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4); }
    files.set(`bin/${target}/paperclip-runnerd`, bytes);
    platforms[target] = { path: `${target}/paperclip-runnerd`, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
  }
  const pack = seal(fixture());
  files.set("remote-provider-packs/linux-x64/provider-pack.json", Buffer.from(JSON.stringify(pack)));
  files.set("bin/release-manifest.json", Buffer.from(JSON.stringify({ schema: "paperclip.runner.release-binaries.v1", sourceRevision: revision,
    platforms, remoteProviderPack: { target: "linux-x64", sourceRevision: revision, digest: pack.digest } })));
  files.set("assembly-receipt.json", Buffer.from(JSON.stringify({ schema: "paperclip.runner.release-assembly.v1", sourceRevision: revision,
    sourcePins: { profiles: `sha256:${createHash("sha256").update(readFileSync(new URL('../acpx-profiles.json', import.meta.url))).digest('hex')}`,
      distributions: `sha256:${createHash("sha256").update(readFileSync(new URL('../cursor-distributions.json', import.meta.url))).digest('hex')}` },
    providerImage: { sourceRevision: revision, platform: "linux/amd64", imageId: digest },
    linuxDaemonImage: { sourceRevision: revision, platform: "linux/amd64", imageId: digest },
    daemonMetadata: Object.fromEntries(Object.keys(platforms).map(target => [target, daemonMetadata()])),
    files: Object.fromEntries([...files].map(([path, bytes]) => [path, `sha256:${createHash("sha256").update(bytes).digest("hex")}`])) })));
  return files;
}

test("release transfer preserves only the assembled daemon and actual provider-pack data", () => {
  const files = releaseData(), archive = makeRunnerReleaseArchive(files, revision);
  const checksum = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
  assert.deepEqual(readRunnerReleaseArchive(archive, revision, checksum), files);
  assert.throws(() => readRunnerReleaseArchive(archive, "c".repeat(40), checksum), /source mismatch/);
  assert.throws(() => readRunnerReleaseArchive(archive, revision, digest), /archive checksum mismatch/);
});

test('the real transfer CLI validates before extraction, restores executable modes and refuses output links', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-release-transfer-'));
  const helper = fileURLToPath(new URL('../../../scripts/release-runner-artifacts.mjs', import.meta.url));
  try {
    const archive = makeRunnerReleaseArchive(releaseData(), revision), archivePath = join(root, 'assets.tar.gz');
    const checksumPath = join(root, 'assets.sha256'), output = join(root, 'output');
    writeFileSync(archivePath, archive); writeFileSync(checksumPath, digest);
    const invoke = (...args) => spawnSync(process.execPath, [helper, ...args], { encoding: 'utf8' });
    let result = invoke('unpack', revision, archivePath, checksumPath, output);
    assert.equal(result.status, 1); assert.match(result.stderr, /archive checksum mismatch/);
    assert.equal(existsSync(output), false, 'No data can be written before the entire envelope passes');
    writeFileSync(checksumPath, `sha256:${createHash('sha256').update(archive).digest('hex')}`);
    result = invoke('unpack', revision, archivePath, checksumPath, output);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(lstatSync(join(output, 'bin/darwin-arm64/paperclip-runnerd')).mode & 0o777, 0o755);
    assert.equal(lstatSync(join(output, 'assembly-receipt.json')).mode & 0o777, 0o644);
    const destination = join(root, 'copy'), outside = join(root, 'outside');
    mkdirSync(join(destination, 'bin/darwin-arm64'), { recursive: true });
    // A dangling link is still a link, even though existsSync returns false.
    symlinkSync(outside, join(destination, 'bin/darwin-arm64/paperclip-runnerd'));
    result = invoke('copy', revision, output, destination);
    assert.equal(result.status, 1); assert.match(result.stderr, /artifact link/);
    assert.equal(existsSync(outside), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('image-sourced Linux daemon recording validates data without executing its ELF on the host', () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-image-daemon-record-'));
  const helper = fileURLToPath(new URL('../../../scripts/release-runner-artifacts.mjs', import.meta.url));
  try {
    // This header fixture cannot execute. Successful recording proves this
    // transfer leg consumes image-probed metadata rather than host execution.
    const binary = join(root, 'runnerd'), metadata = join(root, 'metadata.json'), imagePath = join(root, 'image.json');
    const image = `ghcr.io/paperclipai/paperclip@${digest}`;
    writeFileSync(binary, releaseData().get('bin/linux-x64/paperclip-runnerd'), { mode: 0o755 });
    writeFileSync(metadata, JSON.stringify(daemonMetadata()));
    const imageData = { Os: 'linux', Architecture: 'amd64', Id: digest, RepoDigests: [image],
      Config: { Labels: { 'org.opencontainers.image.revision': revision }, Env: ['PRIVATE_TOKEN=do-not-export'] } };
    writeFileSync(imagePath, JSON.stringify([imageData]));
    const output = join(root, 'output');
    let result = spawnSync(process.execPath, [helper, 'record-image-binary', revision, binary, metadata, imagePath, output, image], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const receipt = readFileSync(join(output, 'receipt.json'), 'utf8');
    assert.equal(JSON.parse(receipt).providerImage.requestedImage, image);
    assert.equal(JSON.parse(receipt).sha256, `sha256:${createHash('sha256').update(readFileSync(binary)).digest('hex')}`);
    assert.doesNotMatch(receipt, /PRIVATE_TOKEN|do-not-export|Config/);
    imageData.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40);
    writeFileSync(imagePath, JSON.stringify([imageData]));
    const wrong = join(root, 'wrong');
    result = spawnSync(process.execPath, [helper, 'record-image-binary', revision, binary, metadata, imagePath, wrong, image], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(existsSync(wrong), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release transfer rejects links, unsafe or duplicate paths, truncation and permissions before extraction", () => {
  const archive = makeRunnerReleaseArchive(releaseData(), revision);
  for (const corrupt of [
    tar => { tar.fill(0, 0, 100); tar.write("../paperclip-runnerd", 0); },
    tar => { tar[156] = 50; },
    tar => { tar.subarray(0, 100).copy(tar, 1024); },
    tar => { tar.write("00004755\0", 100, 8); },
  ]) {
    const tar = gunzipSync(archive); corrupt(tar);
    const headerStart = tar[1024] === tar[0] && tar.subarray(1024, 1124).equals(tar.subarray(0, 100)) ? 1024 : 0;
    const header = tar.subarray(headerStart, headerStart + 512); header.fill(32, 148, 156);
    const sum = [...header].reduce((sum, byte) => sum + byte, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    const bytes = gzipSync(tar), hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.throws(() => readRunnerReleaseArchive(bytes, revision, hash), /Unsafe|forbidden|permissions/);
  }
  const truncated = archive.subarray(0, archive.length - 4);
  assert.throws(() => readRunnerReleaseArchive(truncated, revision, `sha256:${createHash("sha256").update(truncated).digest("hex")}`));
});

test("release data rejects rehashed wrong targets and provider-image provenance", () => {
  const files = releaseData();
  files.set("bin/darwin-arm64/paperclip-runnerd", files.get("bin/linux-x64/paperclip-runnerd"));
  const receipt = JSON.parse(files.get("assembly-receipt.json"));
  receipt.files["bin/darwin-arm64/paperclip-runnerd"] = `sha256:${createHash("sha256").update(files.get("bin/darwin-arm64/paperclip-runnerd")).digest("hex")}`;
  files.set("assembly-receipt.json", Buffer.from(JSON.stringify(receipt)));
  assert.throws(() => verifyRunnerReleaseData(files, revision), /architecture mismatch/);
  for (const changes of [{ sourceRevision: "c".repeat(40) }, { requestedImage: `ghcr.io/paperclipai/paperclip@${digest}`, repoDigests: [] }]) {
    const source = releaseData(), receipt = JSON.parse(source.get("assembly-receipt.json"));
    Object.assign(receipt.providerImage, changes); source.set("assembly-receipt.json", Buffer.from(JSON.stringify(receipt)));
    assert.throws(() => verifyRunnerReleaseData(source, revision), /image (?:source|digest) mismatch/);
  }
  const incompatible = releaseData(), incompatibleReceipt = JSON.parse(incompatible.get('assembly-receipt.json'));
  incompatibleReceipt.daemonMetadata['linux-x64'].nativeExecutionVersion = 999;
  incompatible.set('assembly-receipt.json', Buffer.from(JSON.stringify(incompatibleReceipt)));
  assert.throws(() => verifyRunnerReleaseData(incompatible, revision), /Incompatible daemon nativeExecutionVersion/);
  const mixed = releaseData(), mixedReceipt = JSON.parse(mixed.get('assembly-receipt.json'));
  mixedReceipt.linuxDaemonImage.imageId = `sha256:${'c'.repeat(64)}`;
  mixed.set('assembly-receipt.json', Buffer.from(JSON.stringify(mixedReceipt)));
  assert.throws(() => verifyRunnerReleaseData(mixed, revision), /same verified image/);
});

test("release transfer binds qualification JSON snapshots to the selected source", () => {
  const files = releaseData();
  assert.throws(() => verifyRunnerReleaseData(files, revision, { profiles: Buffer.from('{}'), distributions: Buffer.from('{}') }), /source profile snapshot mismatch/);
  for (const snapshots of [[{}, distributions], [profiles, {}], [null, null]]) {
    assert.throws(() => verifyReleaseProviderPack(seal(fixture()), revision, ...snapshots), /Invalid release qualification snapshots/);
  }
  const noCursorVersion = structuredClone(profiles); delete noCursorVersion.profiles.cursor.agentServerVersion;
  const malformedClosure = structuredClone(distributions); malformedClosure.platforms['linux-x64'].closureSha256 = 'unknown';
  for (const snapshots of [[noCursorVersion, distributions], [profiles, malformedClosure]]) {
    assert.throws(() => verifyReleaseProviderPack(seal(fixture()), revision, ...snapshots), /Invalid release qualification snapshots/);
  }
  const altered = structuredClone(profiles); altered.profiles.claude.commandDigest = digest;
  assert.throws(() => verifyReleaseProviderPack(seal(fixture()), revision, altered, distributions), /ACPX profiles/);
  assert.equal(verifyReleaseProviderPack(seal(fixture()), revision, profiles, distributions).payload.runnerSourceRevision, revision);
});

test("accepts a pack whose source and profiles match the assembled release", () => {
  const manifest = seal(fixture()); assert.equal(verifyReleaseProviderPack(manifest, revision), manifest);
});
for (const field of ["version", "profileDigest", "closureDigest", "qualification", "path"]) {
  test(`rejects an independently rehashed stale Cursor ${field}`, () => {
    const payload = fixture(); payload.providers.cursor[field] = field.endsWith("Digest") ? digest : "stale";
    assert.throws(() => verifyReleaseProviderPack(seal(payload), revision), /Cursor identity/);
  });
}
test("rejects omitted Cursor, conflicting legacy inventory, stale sources and forged payload digests", () => {
  const missing = fixture(); delete missing.providers.cursor;
  assert.throws(() => verifyReleaseProviderPack(seal(missing), revision), /Cursor identity/);
  const mixed = fixture(); mixed.candidateProviders = { cursor: { ...mixed.providers.cursor, profileDigest: digest } };
  assert.throws(() => verifyReleaseProviderPack(seal(mixed), revision), /Cursor identity/);
  const old = fixture(); old.runnerSourceRevision = "c".repeat(40);
  assert.throws(() => verifyReleaseProviderPack(seal(old), revision), /release source/);
  const forged = seal(fixture()); forged.digest = digest;
  assert.throws(() => verifyReleaseProviderPack(forged, revision), /payload digest/);
});

test("release assembly rejects rehashed stale or missing packs before staging any files", () => {
  const root = mkdtempSync(join(tmpdir(), "release-provider-pack-"));
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    // Run the actual assembler in an isolated layout so it cannot overwrite built artifacts.
    for (const file of ["scripts/stage-release-runner-binaries.mjs", "scripts/release-provider-pack.mjs", "src/live/runner-binary.ts", "acpx-profiles.json", "cursor-distributions.json"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(source, file), join(root, file));
    }
    const platforms = {};
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      const bytes = Buffer.alloc(64);
      if (target === "linux-x64") {
        bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(62, 18);
      } else {
        bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
      }
      const path = join(root, target); writeFileSync(path, bytes);
      platforms[target] = { path, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    }
    const payload = fixture(); payload.providers.cursor.profileDigest = digest;
    const bytes = JSON.stringify(seal(payload)), path = join(root, "provider-pack.json"); writeFileSync(path, bytes);
    const manifest = { sourceRevision: revision, platforms, remoteProviderPack: { path, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` } };
    for (const error of [/Cursor identity/, /requires the matching Linux remote provider pack/]) {
      writeFileSync(join(root, "release.json"), JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [join(root, "scripts/stage-release-runner-binaries.mjs"), join(root, "release.json")], { encoding: "utf8" });
      assert.equal(result.status, 1); assert.match(result.stderr, error);
      assert.equal(existsSync(join(root, "dist")), false);
      delete manifest.remoteProviderPack;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
