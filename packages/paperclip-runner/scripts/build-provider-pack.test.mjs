import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProviderPack } from "./build-provider-pack.mjs";
import { canonicalJson, sha256File, sha256Tree, prepareProviderTree, writeProviderTreeSidecar, verifyProviderTree } from "./provider-pack-integrity.mjs";
const revision = "a".repeat(40);
function fixture(runTest) {
  const parent = mkdtempSync(join(tmpdir(), "canonical-provider-test-"));
  const workspaceRoot = join(parent, "source"), outputRoot = join(parent, "output");
  const lock = "the dedicated immutable resolution\n";
  const hash = createHash("sha256").update(lock).digest("hex");
  mkdirSync(join(workspaceRoot, "docker/daytona-runner"), { recursive: true });
  writeFileSync(join(workspaceRoot, "docker/daytona-runner/provider-dependencies.lock.yaml"), lock);
  writeFileSync(join(workspaceRoot, "docker/daytona-runner/Dockerfile"), `ARG PAPERCLIP_RUNNER_LOCK_SHA256=${hash}\n`);
  writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "different CI resolution");
  const calls = [];
  function exported(args, tamper) {
    const exportRoot = args[args.indexOf("--output") + 1].slice("type=local,dest=".length);
    // BuildKit's local exporter owns the outer directory and creates it 0700.
    // The nested pack must retain the mode bound in its integrity manifest.
    mkdirSync(exportRoot, { recursive: true, mode: 0o700 });
    chmodSync(exportRoot, 0o700);
    const destination = join(exportRoot, "provider-pack");
    const paths = {
      nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml",
      opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
      opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
    };
    const artifacts = {};
    for (const [name, path] of Object.entries(paths)) {
      const file = join(destination, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, name === "productionLock" ? lock : name);
      artifacts[name] = { path, sha256: sha256File(file) };
    }
    for (const name of ["node_modules/@agentclientprotocol/codex-acp/dist/index.js", "node_modules/pi/vendor/pi", "node_modules/.bin/pi"]) {
      mkdirSync(dirname(join(destination, name)), { recursive: true });
      writeFileSync(join(destination, name), "additional runtime bytes", { mode: 0o755 });
    }
    symlinkSync("pi/vendor/pi", join(destination, "node_modules/pi-link"));
    const distDigest = sha256Tree(join(destination, "dist"));
    const tree = prepareProviderTree(destination);
    const payload = { exportTreeDigest: tree.digest, target: { platform: "linux", architecture: "x64" },
      runnerSourceRevision: args.find((value) => value.startsWith("PAPERCLIP_RUNNER_SOURCE_REVISION=")).split("=")[1],
      artifacts, distDigest, bridgeDigest: `sha256:${createHash("sha256").update(artifacts.opencodeProxy.sha256).update("\n")
        .update(artifacts.acpxSidecar.sha256).update("\n").update(distDigest).digest("hex")}` };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}` };
    writeFileSync(join(destination, "provider-pack.json"), JSON.stringify(manifest));
    writeProviderTreeSidecar(destination, tree);
    tamper?.(destination);
  }
  const run = (command, args, options) => { calls.push({ command, args, options }); exported(args); return { status: 0 }; };
  try { runTest({ parent, workspaceRoot, outputRoot, hash, calls, run, exported }); }
  finally { rmSync(parent, { recursive: true, force: true }); }
}
test("workflow entry isolates the canonical linux stage from root dependency graph and stale outputs", () => fixture((f) => {
  mkdirSync(join(f.workspaceRoot, "node_modules"));
  writeFileSync(join(f.workspaceRoot, "node_modules/stale"), "must not be assembled");
  const first = buildProviderPack({ ...f, revision });
  writeFileSync(join(f.workspaceRoot, "pnpm-lock.yaml"), "another CI lock");
  const second = buildProviderPack({ ...f, revision });
  assert.equal(first.manifest.digest, second.manifest.digest);
  for (const call of f.calls) {
    assert.equal(call.command, "docker");
    assert.equal(call.args[call.args.indexOf("--platform") + 1], "linux/amd64");
    assert.equal(call.args[call.args.indexOf("--target") + 1], "provider-pack-export");
    assert.ok(call.args.includes(`PAPERCLIP_RUNNER_SOURCE_REVISION=${revision}`));
    assert.equal(call.options.timeout, 720_000);
  }
  assert.equal(readFileSync(join(f.outputRoot, "pnpm-lock.yaml"), "utf8"), "the dedicated immutable resolution\n");
  assert.deepEqual(readdirSync(f.parent).sort(), ["output", "source"]);
}));
test("tampered dedicated lock fails before invoking Docker", () => fixture((f) => {
  writeFileSync(join(f.workspaceRoot, "docker/daytona-runner/provider-dependencies.lock.yaml"), "changed");
  assert.throws(() => buildProviderPack({ ...f, revision }), /lock integrity mismatch/);
  assert.equal(f.calls.length, 0);
}));
test("failed canonical build preserves prior pack and cleans only temporary output", () => fixture((f) => {
  mkdirSync(f.outputRoot); writeFileSync(join(f.outputRoot, "old"), "retain");
  assert.throws(() => buildProviderPack({ ...f, revision, run: () => ({ status: 1 }) }), /build failed/);
  assert.equal(readFileSync(join(f.outputRoot, "old"), "utf8"), "retain");
  assert.deepEqual(readdirSync(f.parent).sort(), ["output", "source"]);
}));
test("exported executable tampering is rejected without replacing the prior pack", () => fixture((f) => {
  mkdirSync(f.outputRoot); writeFileSync(join(f.outputRoot, "old"), "retain");
  const run = (_command, args) => { f.exported(args, (root) => writeFileSync(join(root, "node_modules/node/bin/node"), "tampered")); return { status: 0 }; };
  assert.throws(() => buildProviderPack({ ...f, revision, run }), /artifact integrity mismatch/);
  assert.equal(readFileSync(join(f.outputRoot, "old"), "utf8"), "retain");
}));
test("arbitrary source-tree output and invalid revision are rejected before building", () => fixture((f) => {
  for (const outputRoot of [f.workspaceRoot, join(f.workspaceRoot, "packages"), join(f.workspaceRoot, "..hidden"), dirname(f.workspaceRoot)]) {
    assert.throws(() => buildProviderPack({ ...f, outputRoot, revision }), /unsafe/);
  }
  assert.throws(() => buildProviderPack({ ...f, revision: "not-a-sha" }), /full Git SHA/);
  assert.equal(f.calls.length, 0);
}));

test("implicit HEAD rejects dirty canonical inputs while explicit trusted revisions tolerate CI root-lock drift", () => fixture((f) => {
  const previous = process.env.PAPERCLIP_RUNNER_SOURCE_REVISION;
  delete process.env.PAPERCLIP_RUNNER_SOURCE_REVISION;
  try {
    execFileSync("git", ["init", f.workspaceRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", f.workspaceRoot, "add", "."]);
    execFileSync("git", ["-C", f.workspaceRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { stdio: "ignore" });
    writeFileSync(join(f.workspaceRoot, "pnpm-lock.yaml"), "CI-owned changed root lock");
    buildProviderPack({ ...f });
    assert.equal(f.calls.length, 1);
    mkdirSync(join(f.workspaceRoot, "packages/paperclip-runner/scripts"), { recursive: true });
    writeFileSync(join(f.workspaceRoot, "packages/paperclip-runner/scripts/new-source.mjs"), "changed source");
    assert.throws(() => buildProviderPack({ ...f }), /inputs are dirty/);
    assert.equal(f.calls.length, 1);
    buildProviderPack({ ...f, revision });
    assert.equal(f.calls.length, 2);
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_SOURCE_REVISION;
    else process.env.PAPERCLIP_RUNNER_SOURCE_REVISION = previous;
  }
}));

for (const [name, tamper] of [
  ["ACP dependency", root => writeFileSync(join(root, "node_modules/@agentclientprotocol/codex-acp/dist/index.js"), "changed")],
  ["Pi binary", root => writeFileSync(join(root, "node_modules/pi/vendor/pi"), "changed")],
  ["additional binary shim", root => writeFileSync(join(root, "node_modules/.bin/pi"), "changed")],
  ["missing dependency", root => rmSync(join(root, "node_modules/@agentclientprotocol/codex-acp/dist/index.js"))],
  ["extra dependency", root => writeFileSync(join(root, "node_modules/unexpected"), "extra")],
  ["lost executable mode", root => chmodSync(join(root, "node_modules/pi/vendor/pi"), 0o644)],
  ["directory mode", root => chmodSync(join(root, "node_modules/pi/vendor"), 0o700)],
  ["pack root mode", root => chmodSync(root, 0o700)],
  ["changed internal symlink", root => { unlinkSync(join(root, "node_modules/pi-link")); symlinkSync(".bin/pi", join(root, "node_modules/pi-link")); }],
  ["escaping symlink", root => { unlinkSync(join(root, "node_modules/pi-link")); symlinkSync("../../", join(root, "node_modules/pi-link")); }],
  ["absolute symlink", root => { unlinkSync(join(root, "node_modules/pi-link")); symlinkSync(join(root, "node_modules/pi/vendor/pi"), join(root, "node_modules/pi-link")); }],
  ["missing sidecar", root => rmSync(join(root, "provider-pack-integrity.json"))],
  ["sidecar mode", root => chmodSync(join(root, "provider-pack-integrity.json"), 0o755)],
]) test("complete inventory rejects " + name + " and retains prior published pack", () => fixture(f => {
  mkdirSync(f.outputRoot); writeFileSync(join(f.outputRoot, "old"), "retain");
  const run = (_command, args) => { f.exported(args, tamper); return { status: 0 }; };
  assert.throws(() => buildProviderPack({ ...f, revision, run }));
  assert.equal(readFileSync(join(f.outputRoot, "old"), "utf8"), "retain");
  assert.deepEqual(readdirSync(f.parent).sort(), ["output", "source"]);
}));
test("inventory digest is bound in the manifest and cannot be replaced independently", () => fixture(f => {
  const run = (_command, args) => { f.exported(args, root => {
    const p = join(root, "provider-pack-integrity.json"), sidecar = JSON.parse(readFileSync(p, "utf8"));
    sidecar.entries = sidecar.entries.filter(e => e.path !== "node_modules/pi/vendor/pi");
    sidecar.digest = "sha256:" + createHash("sha256").update(canonicalJson(sidecar.entries)).digest("hex");
    writeFileSync(p, JSON.stringify(sidecar));
  }); return { status: 0 }; };
  assert.throws(() => buildProviderPack({ ...f, revision, run }), /inventory digest mismatch/);
}));
test("sidecar covers final manifest and excludes only its own bytes", () => fixture(f => {
  buildProviderPack({ ...f, revision });
  const manifest = JSON.parse(readFileSync(join(f.outputRoot, "provider-pack.json"), "utf8"));
  const sidecar = JSON.parse(readFileSync(join(f.outputRoot, "provider-pack-integrity.json"), "utf8"));
  assert(sidecar.entries.some(e => e.path === "provider-pack.json"));
  assert(!sidecar.entries.some(e => e.path === "provider-pack-integrity.json"));
  assert(sidecar.entries.some(e => e.path === "node_modules/pi-link" && e.target === "pi/vendor/pi"));
  assert.doesNotThrow(() => verifyProviderTree(f.outputRoot, manifest.payload.exportTreeDigest));
  writeFileSync(join(f.outputRoot, "provider-pack.json"), "different manifest");
  assert.throws(() => verifyProviderTree(f.outputRoot, manifest.payload.exportTreeDigest), /contents/);
}));
test("large binary hashing matches byte digest and inventory normalizes existing a+rX contract", () => fixture(f => {
  const file = join(f.parent, "large"), data = Buffer.alloc(8 * 1024 * 1024 + 31, 0x7d);
  writeFileSync(file, data);
  assert.equal(sha256File(file), "sha256:" + createHash("sha256").update(data).digest("hex"));
  const dir = join(f.parent, "tree");mkdirSync(dir, { mode: 0o700 });writeFileSync(join(dir, "tool"), "tool", { mode: 0o700 });
  const prepared = prepareProviderTree(dir);
  assert.equal(prepared.entries.find(e => e.path === "").mode, 0o755);
  assert.equal(prepared.entries.find(e => e.path === "tool").mode, 0o755);
}));

test("source-revision-only changes preserve content tree identity", () => fixture(f => {
  const first = buildProviderPack({ ...f, revision });
  const second = buildProviderPack({ ...f, revision: "b".repeat(40) });
  assert.equal(first.manifest.payload.exportTreeDigest, second.manifest.payload.exportTreeDigest);
  assert.notEqual(first.manifest.digest, second.manifest.digest);
}));
test("both canonical stages exercise pinned CLI versions and verify full tree after launch smoke", () => {
  for (const [file, stageName] of [["../../../Dockerfile", "cloud-provider-pack"], ["../../../docker/daytona-runner/Dockerfile", "provider-pack-build"]]) {
    const body = readFileSync(new URL(file, import.meta.url), "utf8").split(/^FROM /m).find(s => s.split("\n", 1)[0].endsWith(" AS " + stageName));
    assert(body);
    const pi = body.indexOf("verify-pi-provider-launch.mjs /provider-pack"), versions = body.indexOf('test "$(acpx --version)" = "0.13.1"'), verification = body.indexOf("verifyProviderPack('/provider-pack'");
    assert(pi >= 0 && versions > pi && verification > versions);
    assert(body.includes('test "$(claude-agent-acp --version)" = "0.73.0"'));
    assert(body.includes('test "$(codex-acp --version)" = "@agentclientprotocol/codex-acp 1.6.2"'));
    assert(!body.includes("chmod -R a+rX /provider-pack"), "Modes must be normalized before binding the inventory");
  }
});
