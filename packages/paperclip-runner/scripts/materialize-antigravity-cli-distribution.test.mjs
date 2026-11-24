import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import declaration from "../antigravity-cli-distributions.json" with { type: "json" };
import { antigravityCliArchiveExecutable, antigravityCliDistribution } from "./materialize-antigravity-cli-distribution.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const sha512 = bytes => createHash("sha512").update(bytes).digest("hex");
const executable = Buffer.from("#!/bin/sh\necho antigravity cli fixture\n");

/** A GNU-style single-member tar like Google's, built in memory. */
function tar({ name = "antigravity", content = executable, mode = 0o755, type = "0", members = [], trailer = Buffer.alloc(1024), magic = "ustar  \0" } = {}) {
  const block = (memberName, bytes, memberType, memberMode) => {
    const header = Buffer.alloc(512);
    header.write(memberName, 0, "utf8");
    header.write(`${memberMode.toString(8).padStart(7, "0")}\0`, 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("15147300000\0", 136);
    header.write("        ", 148);
    header.write(memberType, 156);
    header.write(magic, 257, "latin1");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
    return Buffer.concat([header, bytes, padding]);
  };
  return Buffer.concat([block(name, content, type, mode), ...members.map(member => block(member.name, member.content, member.type ?? "0", member.mode ?? 0o755)), trailer]);
}
const tarGz = options => gzipSync(tar(options));

function pin(archive, { content = executable } = {}) {
  const entries = [{ path: "agy", sha256: sha256(content), size: content.length, executable: true }];
  return {
    url: "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.15-5514532022517760/darwin-arm/fixture.tar.gz",
    archiveFormat: "tar.gz", archiveSize: archive.length, archiveSha512: sha512(archive), archiveSha256: sha256(archive),
    archiveMember: "antigravity", executable: "agy", executableSha512: sha512(content), entries, closureSha256: sha256(JSON.stringify(entries)),
  };
}

/** Copy the scripts into an isolated package so its fixed declaration read sees a fixture. */
async function fixture(t, { archive = tarGz(), platforms } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-cli-provision-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  for (const name of ["materialize-antigravity-cli-distribution.mjs", "materialize-antigravity-distribution.mjs", "provision-antigravity-cli.mjs", "antigravity-provisioner-layout.mjs"]) await copyFile(new URL(name, import.meta.url), join(scripts, name));
  // The registry-server module imports its patcher; the CLI route never calls it.
  await writeFile(join(scripts, "patch-antigravity-runtime.mjs"), "export const ANTIGRAVITY_PATCH_VERSION='unused'; export async function patchAntigravityRuntime() { throw new Error('unused'); }\n");
  const pins = platforms ?? { "darwin-arm64": pin(archive) };
  await writeFile(join(root, "antigravity-cli-distributions.json"), JSON.stringify({ ...declaration, platforms: pins }));
  const archivePath = join(root, "fixture.tar.gz");
  await writeFile(archivePath, archive);
  const api = await import(pathToFileURL(join(scripts, "materialize-antigravity-cli-distribution.mjs")));
  const provisioner = await import(pathToFileURL(join(scripts, "provision-antigravity-cli.mjs")));
  const home = join(root, "home");
  const moduleUrl = "file:///consumer/node_modules/@paperclipai/paperclip-runner/dist/cli/provision-antigravity-cli.cjs";
  const provision = (options = {}) => provisioner.provisionAntigravityCliRuntime({ platform: "darwin", architecture: "arm64", archivePath, home, moduleUrl, ...options });
  const destination = join(home, ".paperclip/runtimes/antigravity-cli/darwin-arm64", pins["darwin-arm64"]?.closureSha256 ?? "none");
  return { root, home, archivePath, api, provision, destination };
}

test("the CLI route pins Google's 1.5.15 archives for macOS ARM and both Linux targets", async () => {
  assert.equal(declaration.schema, "paperclip.antigravity_cli_distribution.v1");
  assert.equal(declaration.version, "1.5.15");
  assert.equal(declaration.build, "1.5.15-5514532022517760");
  assert.deepEqual(declaration.args, ["acp"]);
  assert.deepEqual(declaration.environment, { AGY_CLI_DISABLE_AUTO_UPDATE: "1" });
  assert.deepEqual(Object.keys(declaration.platforms).sort(), ["darwin-arm64", "linux-arm64", "linux-x64"]);
  const sizes = { "darwin-arm64": 86_166_538, "linux-x64": 101_464_790, "linux-arm64": 92_373_221 };
  for (const [target, size] of Object.entries(sizes)) {
    const [platform, architecture] = target.split("-");
    const item = await antigravityCliDistribution(platform, architecture);
    assert.equal(item.archiveSize, size);
    assert.equal(item.closureSha256, sha256(JSON.stringify(item.entries)));
    assert.equal(item.entries[0].path, "agy");
    assert.match(item.url, /^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/1\.5\.15-5514532022517760\//);
  }
  await assert.rejects(antigravityCliDistribution("darwin", "x64"), /no pinned distribution for darwin\/x64/);
  await assert.rejects(antigravityCliDistribution("win32", "x64"), /no pinned distribution for win32\/x64/);
});

test("a declaration that points away from Google's versioned bucket or breaks its own digests is refused", async t => {
  const archive = tarGz();
  for (const change of [
    item => ({ ...item, url: item.url.replace("storage.googleapis.com", "example.com") }),
    item => ({ ...item, url: item.url.replace("1.5.15-5514532022517760", "latest") }),
    item => ({ ...item, url: item.url.replace("https:", "http:") }),
    item => ({ ...item, closureSha256: "0".repeat(64) }),
    item => ({ ...item, archiveSha512: "abc" }),
    item => ({ ...item, archiveMember: "../antigravity" }),
  ]) {
    const f = await fixture(t, { archive, platforms: { "darwin-arm64": change(pin(archive)) } });
    await assert.rejects(f.api.antigravityCliDistribution("darwin", "arm64"), /Antigravity CLI distribution declaration is invalid/);
  }
});

test("tar inspection accepts only the single pinned executable member", () => {
  const item = pin(tarGz());
  assert.deepEqual(antigravityCliArchiveExecutable(tar(), item), executable);
  for (const archive of [
    tar({ name: "../antigravity" }),
    tar({ name: "agy" }),
    tar({ type: "2" }),
    tar({ type: "5" }),
    tar({ mode: 0o4755 }),
    tar({ mode: 0o644 }),
    tar({ magic: "badmg\0" }),
    tar({ members: [{ name: "extra", content: Buffer.from("x") }] }),
    tar({ trailer: Buffer.concat([Buffer.alloc(1023), Buffer.from([1])]) }),
    tar({ trailer: Buffer.alloc(0) }),
    tar().subarray(0, 700),
  ]) assert.throws(() => antigravityCliArchiveExecutable(archive, item), /unexpected contents/);
  const corrupted = tar();
  corrupted[0] ^= 1;
  assert.throws(() => antigravityCliArchiveExecutable(corrupted, item), /unexpected contents/);
});

test("setup verifies the archive and executable, installs beside the registry-server runtime, and re-runs idempotently", async t => {
  const f = await fixture(t);
  const registry = join(f.home, ".paperclip/runtimes/antigravity/darwin-arm64/existing");
  await mkdir(registry, { recursive: true, mode: 0o700 });
  await writeFile(join(registry, "agy_acp_server.par"), "registry server");
  const first = await f.provision();
  assert.equal(first.destination, f.destination);
  assert.equal(first.executable, join(f.destination, "agy"));
  assert.equal(first.status, "installed");
  assert.deepEqual(await readFile(first.executable), executable);
  assert.equal((await lstat(first.executable)).mode & 0o7777, 0o500);
  assert.deepEqual((await readdir(f.destination)).sort(), [".paperclip-antigravity-cli-closure.json", "agy"]);
  const record = JSON.parse(await readFile(join(f.destination, ".paperclip-antigravity-cli-closure.json"), "utf8"));
  assert.equal(record.schema, "paperclip.antigravity_cli_closure.v1");
  assert.equal(record.build, "1.5.15-5514532022517760");
  assert.deepEqual(record.entries, first.entries);
  assert.equal(await readFile(join(registry, "agy_acp_server.par"), "utf8"), "registry server");
  // A re-run verifies in place and needs neither the archive nor the network.
  await rm(f.archivePath);
  const second = await f.provision({ archivePath: undefined, fetch: () => { throw new Error("must not download"); } });
  assert.equal(second.status, "verified");
  assert.equal(second.executable, first.executable);
});

test("a tampered archive, a truncated download and an archive for another platform each install nothing", async t => {
  const archive = tarGz();
  const tampered = Buffer.from(archive);
  tampered[tampered.length - 9] ^= 0xff;
  const otherPlatform = tarGz({ content: Buffer.from("#!/bin/sh\necho linux build\n") });
  for (const [bytes, message] of [
    [tampered, /does not match its pinned SHA-512 digest/],
    [archive.subarray(0, archive.length - 10), /expected \d+ bytes, received \d+/],
    [otherPlatform, /expected \d+ bytes, received \d+|does not match its pinned SHA-512 digest/],
  ]) {
    const f = await fixture(t, { archive });
    await writeFile(f.archivePath, bytes);
    await assert.rejects(f.provision(), error => message.test(error.message) && /Nothing was installed/.test(error.message));
    await assert.rejects(lstat(f.destination), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(f.home, ".paperclip/runtimes/antigravity-cli/darwin-arm64")), []);
  }
});

test("an archive whose executable differs from the pinned executable digest is refused", async t => {
  const other = Buffer.from("#!/bin/sh\necho other\n");
  const archive = tarGz({ content: other });
  // The declaration pins this exact archive, but a different executable.
  const f = await fixture(t, { archive, platforms: { "darwin-arm64": { ...pin(tarGz()), archiveSize: archive.length, archiveSha512: sha512(archive), archiveSha256: sha256(archive) } } });
  await assert.rejects(f.provision(), /executable does not match its pinned digest.*Nothing was installed/s);
  await assert.rejects(lstat(f.destination), { code: "ENOENT" });
});

test("the download path enforces the pinned size while streaming and refuses redirects", async t => {
  const archive = tarGz();
  const f = await fixture(t, { archive });
  const calls = [];
  const oversized = (url, init) => { calls.push({ url, init }); return new Response(Buffer.concat([archive, Buffer.alloc(4096)])); };
  await assert.rejects(f.provision({ archivePath: undefined, fetch: oversized }), /expected \d+ bytes.*Nothing was installed/s);
  assert.equal(calls[0].url, pin(archive).url);
  assert.equal(calls[0].init.redirect, "error");
  await assert.rejects(f.provision({ archivePath: undefined, fetch: () => new Response("gone", { status: 404 }) }), /download failed \(HTTP 404\)/);
  const ok = await f.provision({ archivePath: undefined, fetch: () => new Response(archive) });
  assert.equal(ok.status, "installed");
});

test("a modified installation is retired and replaced from a fresh verified download", async t => {
  const f = await fixture(t);
  const installed = await f.provision();
  await chmod(installed.executable, 0o700);
  await writeFile(installed.executable, "#!/bin/sh\necho tampered\n");
  await chmod(installed.executable, 0o500);
  const pinned = await f.api.antigravityCliDistribution("darwin", "arm64");
  await assert.rejects(f.api.verifyAntigravityCliDistribution(f.destination, pinned), /does not match the pinned executable/);
  const repaired = await f.provision();
  assert.equal(repaired.status, "replaced");
  assert.deepEqual(await readFile(repaired.executable), executable);
  await f.api.verifyAntigravityCliDistribution(f.destination, pinned);
});

test("setup refuses an unpublished provisioner location and an unsupported host", async t => {
  const f = await fixture(t);
  await assert.rejects(f.provision({ moduleUrl: "file:///tmp/provision-antigravity-cli.cjs" }), /published provisioner/);
  await assert.rejects(f.provision({ platform: "win32", architecture: "x64" }), /no pinned distribution for win32\/x64/);
});

test("an unsafe cache parent stops setup without touching a valid installation", async t => {
  const f = await fixture(t);
  const installed = await f.provision();
  const parent = join(f.home, ".paperclip/runtimes/antigravity-cli/darwin-arm64");
  await chmod(parent, 0o777);
  t.after(() => chmod(parent, 0o700).catch(() => undefined));
  await assert.rejects(f.provision(), /shared write access/);
  await chmod(parent, 0o700);
  assert.deepEqual(await readFile(installed.executable), executable);
  assert.equal((await f.provision({ archivePath: undefined, fetch: () => { throw new Error("must not download"); } })).status, "verified");
});

test("a failed replacement keeps the previous installation in place", async t => {
  const f = await fixture(t);
  const installed = await f.provision();
  await chmod(installed.executable, 0o700);
  await writeFile(installed.executable, "#!/bin/sh\necho modified\n");
  await chmod(installed.executable, 0o500);
  await assert.rejects(f.provision({ archivePath: undefined, fetch: () => new Response("gone", { status: 503 }) }), /download failed \(HTTP 503\)/);
  assert.equal(await readFile(installed.executable, "utf8"), "#!/bin/sh\necho modified\n");
  assert.deepEqual(await readdir(join(f.home, ".paperclip/runtimes/antigravity-cli/darwin-arm64")), [installed.closureSha256]);
});

test("setup refuses a linked runtime cache directory, as the launch resolver does", async t => {
  for (const linked of [".paperclip", ".paperclip/runtimes/antigravity-cli"]) {
    const f = await fixture(t);
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "paperclip-antigravity-cli-elsewhere-")));
    t.after(() => rm(elsewhere, { recursive: true, force: true }));
    await mkdir(join(f.home, linked, ".."), { recursive: true, mode: 0o700 });
    await symlink(elsewhere, join(f.home, linked));
    await assert.rejects(f.provision(), /must contain real directories.*Nothing was installed/s);
    assert.deepEqual(await readdir(elsewhere), []);
  }
});
