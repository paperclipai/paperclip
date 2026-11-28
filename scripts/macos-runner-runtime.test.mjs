import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpenCodeRuntimePack, installMacRuntime, verifyMacRuntime } from "./macos-runner-runtime.mjs";

const sourceRevision = "a".repeat(40), target = "darwin-arm64";
const sha = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mac-runtime-build-"))); t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, target), input = join(root, "input"), output = join(root, "output");
  mkdirSync(join(runtime, "bin"), { recursive: true }); mkdirSync(join(runtime, "provider-pack")); mkdirSync(input);
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf, 0); binary.writeUInt32LE(0x100000c, 4);
  writeFileSync(join(runtime, "bin/paperclip-runnerd"), binary, { mode: 0o755 });
  const payload = { runnerSourceRevision: sourceRevision, target: { platform: "darwin", architecture: "arm64" }, pins: { opencode: "1.18.34" } };
  const pack = { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: sha(canonical(payload)) };
  writeFileSync(join(runtime, "provider-pack/provider-pack.json"), JSON.stringify(pack));
  const metadata = { schema: "paperclip.runner.remote-runtime.v1", sourceRevision, target, runtimeInputsDigest: `sha256:${"b".repeat(64)}`, providerPackDigest: pack.digest, runnerSha256: sha(binary) };
  writeFileSync(join(runtime, "runtime.json"), JSON.stringify(metadata));
  execFileSync("tar", ["-czf", join(input, `${target}.tar.gz`), "-C", root, target], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  writeFileSync(join(input, `${target}.json`), JSON.stringify({ ...metadata, archiveSha256: sha(readFileSync(join(input, `${target}.tar.gz`))) }));
  return { runtime, input, output, metadata };
}

test("installs the native runtime into a Linux controller layout without executing a Mac binary", t => {
  const f = fixture(t);
  assert.equal(installMacRuntime({ ...f, sourceRevision }), true);
  assert.deepEqual(verifyMacRuntime(join(f.output, target), sourceRevision), f.metadata);
});

test("rejects a runtime archive from another Core source", t => {
  const f = fixture(t);
  assert.throws(() => installMacRuntime({ ...f, sourceRevision: "b".repeat(40) }), /source or digest/);
});

test("rejects corrupted archive bytes before extraction", t => {
  const f = fixture(t); writeFileSync(join(f.input, `${target}.tar.gz`), "corrupt");
  assert.throws(() => installMacRuntime({ ...f, sourceRevision }), /source or digest/);
});

test("keeps an ordinary local Docker build usable without optional runtime inputs", t => {
  const f = fixture(t); rmSync(join(f.input, `${target}.json`)); rmSync(join(f.input, `${target}.tar.gz`));
  assert.equal(installMacRuntime({ ...f, sourceRevision }), false);
});

test("does not silently drop an incomplete runtime input", t => {
  const f = fixture(t); rmSync(join(f.input, `${target}.json`));
  assert.throws(() => installMacRuntime({ ...f, sourceRevision }), /Unexpected remote runtime input/);
});

test("reuses a previous source only when its immutable runtime inputs match", t => {
  const f = fixture(t);
  assert.equal(installMacRuntime({ ...f, sourceRevision: "c".repeat(40), inputsDigest: f.metadata.runtimeInputsDigest }), true);
});

test("rejects a cached runtime built from other inputs", t => {
  const f = fixture(t);
  assert.throws(() => installMacRuntime({ ...f, sourceRevision, inputsDigest: `sha256:${"d".repeat(64)}` }), /source or digest/);
});

test("the OpenCode runtime keeps its sealed artifacts and excludes unrelated harness distributions", t => {
  const f = fixture(t), source = join(f.runtime, "provider-pack"), destination = join(f.runtime, "minimal-pack");
  mkdirSync(join(source, "dist")); mkdirSync(join(source, "node_modules/unrelated"), { recursive: true });
  writeFileSync(join(source, "dist/proxy.cjs"), "qualified proxy");
  writeFileSync(join(source, "node_modules/unrelated/runtime"), "unrelated harness");
  const file = join(source, "provider-pack.json"), pack = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, pin] of Object.entries({ acpx: "acpx", "@agentclientprotocol/claude-agent-acp": "claudeAcp",
    "@agentclientprotocol/codex-acp": "codexAcp", "opencode-ai": "opencode" })) {
    const directory = join(source, "node_modules", name);
    mkdirSync(directory, { recursive: true });
    pack.payload.pins[pin] ??= "1.0.0";
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version: pack.payload.pins[pin] }));
  }
  pack.payload.artifacts = { opencodeProxy: { path: "dist/proxy.cjs", sha256: sha("qualified proxy") } };
  pack.payload.providers = { kimi: { path: "provider-assets/kimi/darwin-arm64" } };
  pack.digest = sha(canonical(pack.payload)); writeFileSync(file, JSON.stringify(pack));
  const result = createOpenCodeRuntimePack(source, destination);
  assert.equal(readFileSync(join(destination, "dist/proxy.cjs"), "utf8"), "qualified proxy");
  assert.equal(existsSync(join(destination, "node_modules/unrelated")), false);
  assert.equal(result.payload.providers, undefined);
  assert.equal(result.digest, sha(canonical(result.payload)));
  for (const name of ["acpx", "@agentclientprotocol/claude-agent-acp", "@agentclientprotocol/codex-acp", "opencode-ai"]) {
    assert.deepEqual(JSON.parse(readFileSync(join(destination, "node_modules", name, "package.json"), "utf8")),
      JSON.parse(readFileSync(join(source, "node_modules", name, "package.json"), "utf8")));
  }
});
