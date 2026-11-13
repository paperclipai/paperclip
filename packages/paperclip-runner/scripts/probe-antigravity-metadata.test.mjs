import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { antigravityMetadataEnvironment, createAntigravityMetadataRpc } from "./probe-antigravity-metadata.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const response = {
  protocolVersion: 1, agentInfo: { name: "antigravity-acp", title: "private-provider-text 🛰", version: "1.4.3" },
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { list: {} }, auth: { logout: {} }, _meta: { antigravity: { tier: true, systemPrompt: { append: true }, paperclipAdmission: 1 } } },
  authMethods: [{ id: "oauth-personal", name: "private-provider-text" }, { id: "untrusted-auth-method", name: "private-provider-text" }],
};

async function fixture(t, behavior = "success") {
  const root = await mkdtemp(join(tmpdir(), "paperclip-antigravity-probe-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = join(root, "scripts");
  await mkdir(scripts);
  for (const name of ["materialize-antigravity-distribution.mjs", "antigravity-provisioner-layout.mjs", "probe-antigravity-metadata.mjs"]) await copyFile(new URL(name, import.meta.url), join(scripts, name));
  const admissionSource = "# trusted test admission source\n";
  const admissionSourceSha256 = hash(admissionSource);
  await writeFile(join(scripts, "patch-antigravity-runtime.admission.py"), admissionSource);
  await writeFile(join(scripts, "patch-antigravity-runtime.mjs"), "export const ANTIGRAVITY_PATCH_VERSION='1.4.3-paperclip.1'; export function patchAntigravityRuntime(){throw new Error('Metadata must never patch or install');}");
  const auditPath = join(root, "audit.json");
  const script = `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const behavior=${JSON.stringify(behavior)};
const result=${JSON.stringify(response)};
let buffer='';let descendant;
if(behavior==='ignore-stop') { process.on('SIGTERM',()=>{});setInterval(()=>{},1000); }
process.stdin.on('data',chunk=>{
 buffer+=chunk;
 if(!buffer.includes('\\n'))return;
 const requests=buffer.trim().split('\\n').map(line=>JSON.parse(line));
 writeFileSync(${JSON.stringify(auditPath)},JSON.stringify({pid:process.pid,home:process.env.HOME,geminiHome:process.env.GEMINI_HOME,cwd:process.cwd(),env:process.env,requests}));
 if(requests.length!==1||requests[0].method!=='initialize')process.exit(41);
 if(behavior==='timeout')return;
 if(behavior==='malformed')return process.stdout.write('not-json\\n');
 if(behavior==='oversized')return process.stdout.write('x'.repeat(8192));
 if(behavior==='stderr-limit')return process.stderr.write('sensitive'.repeat(8192));
 if(behavior==='unexpected-method')return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:99,method:'authenticate',params:{token:'sensitive'}})+'\\n');
 if(behavior==='wrong-version')result.agentInfo.version='1.4.2';
 if(behavior==='wrong-identity')result.agentInfo.name='another-harness';
 if(behavior==='wrong-protocol')result.protocolVersion=2;
 if(behavior==='bad-capabilities')result.agentCapabilities=[];
 if(behavior==='missing-patch')delete result.agentCapabilities._meta.antigravity.paperclipAdmission;
 if(behavior==='orphan-child') {
  descendant=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'ignore'});
  writeFileSync(${JSON.stringify(join(root, "descendant.json"))},JSON.stringify({pid:descendant.pid}));
 }
 const payload=JSON.stringify({jsonrpc:'2.0',id:1,result});
 process.stderr.write('private-provider-text sensitive-secret\\n');
 if(behavior==='truncated') { process.stdout.write(payload);process.exit(0); }
 process.stdout.write(payload+'\\n'+(behavior==='extra-message'?'{}\\n':''));
});
process.stdin.on('end',()=>{if(behavior!=='ignore-stop')process.exit(0)});
`;
  const nativeFiles = [
    { path: "agy_acp_server.par", content: Buffer.from(script) },
    { path: "localharness_external", content: Buffer.from("#!/bin/sh\nexit 0\n") },
  ];
  const entries = nativeFiles.map(file => ({ path: file.path, sha256: hash(file.content), size: file.content.length, executable: true }));
  const closureSha256 = hash(JSON.stringify(entries));
  const item = { url: "https://dl.google.com/agy-extensions/releases/macos/fixture.zip", archiveSha256: "a".repeat(64), closureSha256, vendorClosureSha256: closureSha256, vendorEntries: entries, patchVersion: "1.4.3-paperclip.1", admissionSourceSha256, provisioning: "verified-closure", executable: "agy_acp_server.par", args: [], entries };
  await writeFile(join(root, "antigravity-distributions.json"), JSON.stringify({ schema: "paperclip.antigravity_distribution.v1", version: "1.4.3", platforms: { "darwin-arm64": item } }));
  const home = join(root, "operator-home");
  const runtime = join(home, ".paperclip/runtimes/antigravity/darwin-arm64", closureSha256);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  for (const file of nativeFiles) await writeFile(join(runtime, file.path), file.content, { mode: 0o500 });
  await writeFile(join(runtime, ".paperclip-antigravity-closure.json"), JSON.stringify({ schema: "paperclip.antigravity_closure.v1", version: "1.4.3", patchVersion: item.patchVersion, admissionSourceSha256, archiveSha256: item.archiveSha256, vendorClosureSha256: closureSha256, closureSha256, entries }), { mode: 0o400 });
  const api = await import(pathToFileURL(join(scripts, "probe-antigravity-metadata.mjs")));
  return {
    root, runtime, auditPath,
    probe: options => api.probeAntigravityMetadata({ home, platform: "darwin", architecture: "arm64", startupTimeoutMs: 2_000, eofTimeoutMs: 60, terminateTimeoutMs: 60, killTimeoutMs: 250, ...options }),
  };
}

test("probe environment has only explicit sterile settings and cannot inherit credentials", () => {
  const env = antigravityMetadataEnvironment("/isolated", "/verified/runtime");
  assert.equal(env.HOME, "/isolated/home");
  assert.equal(env.GEMINI_HOME, "/isolated/gemini");
  assert.equal(env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  assert.equal(env.ANTIGRAVITY_HARNESS_PATH, "/verified/runtime/localharness_external");
  assert.deepEqual(Object.keys(env).sort(), ["AGY_ACP_FORCE_FILE_STORAGE", "ANTIGRAVITY_HARNESS_PATH", "GEMINI_HOME", "HOME", "LANG", "NO_COLOR", "PATH", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME"]);
});

test("initialize uses Paperclip identity, preserves split UTF-8 and cannot send another method", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  let request = "";
  child.stdin.on("data", chunk => { request += chunk; });
  const rpc = createAntigravityMetadataRpc(child);
  const pending = rpc.initialize();
  const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: response })}\n`);
  const split = payload.indexOf(Buffer.from("🛰")) + 1;
  child.stdout.write(payload.subarray(0, split));
  child.stdout.write(payload.subarray(split));
  assert.equal((await pending).agentInfo.title, response.agentInfo.title);
  assert.deepEqual(JSON.parse(request).params.clientInfo, { name: "paperclip-runner", title: "Paperclip Runner", version: "1" });
  assert.throws(() => rpc.initialize(), /only be sent once/);
  rpc.close();
});

test("invalid UTF-8 is rejected instead of silently replacing wire bytes", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  const rpc = createAntigravityMetadataRpc(child);
  const pending = rpc.initialize();
  child.stdout.write(Buffer.from([0xff, 0x0a]));
  await assert.rejects(pending, /malformed_utf8/);
  rpc.close();
});

test("real stdio probe sends initialize only, sanitizes metadata and removes its isolated profile", async t => {
  const current = await fixture(t);
  const output = await current.probe();
  const audit = JSON.parse(await readFile(current.auditPath, "utf8"));
  assert.deepEqual(audit.requests.map(request => request.method), ["initialize"]);
  assert.equal(audit.env.AGY_ACP_FORCE_FILE_STORAGE, "1");
  assert.equal(audit.env.GEMINI_API_KEY, undefined);
  assert.equal(audit.env.GOOGLE_APPLICATION_CREDENTIALS, undefined);
  assert.equal(audit.env.NODE_OPTIONS, undefined);
  assert.notEqual(audit.home, process.env.HOME);
  assert.notEqual(audit.geminiHome, process.env.GEMINI_HOME);
  await assert.rejects(readFile(join(audit.home, "anything")), { code: "ENOENT" });
  await assert.rejects(readFile(audit.cwd), { code: "ENOENT" });
  assert.deepEqual(output.authMethodIds, ["oauth-personal"]);
  assert.equal(output.agentInfo.version, "1.4.3");
  assert.equal(output.promptRequestsSent, 0);
  assert.equal(output.shutdown.exitCode, 0);
  assert.equal(output.shutdown.method, "eof");
  assert.doesNotMatch(JSON.stringify(output), /sensitive|private-provider-text|paperclip-antigravity-metadata-/);
});

test("identity, version and protocol mismatches are rejected with sanitized diagnostics", async t => {
  for (const [behavior, error] of [["wrong-version", /version_mismatch/], ["wrong-identity", /identity_mismatch/], ["wrong-protocol", /identity_mismatch/], ["bad-capabilities", /malformed_initialize_capabilities/], ["missing-patch", /native_admission_patch_not_advertised/]]) {
    const current = await fixture(t, behavior);
    await assert.rejects(current.probe(), error);
  }
});

test("malformed, oversized, truncated and unexpected protocol streams fail closed", async t => {
  for (const [behavior, error] of [["malformed", /malformed_json/], ["oversized", /stdout_limit/], ["stderr-limit", /stderr_limit/], ["unexpected-method", /unexpected_message/], ["truncated", /truncated_stream/], ["extra-message", /unexpected_message/]]) {
    const current = await fixture(t, behavior);
    await assert.rejects(current.probe({ maxBytes: 4096 }), error);
  }
});

test("startup deadline retires the native process and isolated profile", async t => {
  const current = await fixture(t, "timeout");
  await assert.rejects(current.probe({ startupTimeoutMs: 600 }), /initialize_timeout/);
  const audit = JSON.parse(await readFile(current.auditPath, "utf8"));
  assert.throws(() => process.kill(audit.pid, 0), { code: "ESRCH" });
  await assert.rejects(readFile(audit.cwd), { code: "ENOENT" });
});

test("SIGKILL bounds shutdown when native work ignores EOF and SIGTERM", async t => {
  const current = await fixture(t, "ignore-stop");
  const output = await current.probe();
  const audit = JSON.parse(await readFile(current.auditPath, "utf8"));
  assert.equal(output.shutdown.method, "sigkill");
  assert.equal(output.shutdown.signal, "SIGKILL");
  assert.throws(() => process.kill(audit.pid, 0), { code: "ESRCH" });
});

test("shutdown retires an owned child after its native parent exits", async t => {
  const current = await fixture(t, "orphan-child");
  try { await current.probe(); }
  catch (error) {
    // macOS sandboxing can deny probing an already-extinct process group.
    // Preserve that fail-closed result and independently check the actual child.
    assert.equal(process.platform, "darwin");
    assert.match(error.message, /^antigravity_process_group_check_failed:EPERM$/);
  }
  const descendant = JSON.parse(await readFile(join(current.root, "descendant.json"), "utf8"));
  assert.throws(() => process.kill(descendant.pid, 0), { code: "ESRCH" });
});

test("tampered cache fails verification before any native process starts", async t => {
  const current = await fixture(t);
  const child = join(current.runtime, "localharness_external");
  await chmod(child, 0o700);
  await writeFile(child, "corrupt");
  await assert.rejects(current.probe(), /full execution closure digest mismatch/);
  await assert.rejects(readFile(current.auditPath), { code: "ENOENT" });
});

test("invalid startup or shutdown limits fail before any native process starts", async t => {
  const current = await fixture(t);
  for (const options of [{ startupTimeoutMs: 0 }, { startupTimeoutMs: 30_001 }, { maxBytes: 1024 * 1024 + 1 }, { eofTimeoutMs: -1 }, { killTimeoutMs: 5_001 }]) await assert.rejects(current.probe(options), /Invalid Antigravity metadata probe limits/);
  await assert.rejects(readFile(current.auditPath), { code: "ENOENT" });
});
