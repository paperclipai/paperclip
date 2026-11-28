import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { fixture, repository } from "./local-verify-fixture.mjs";

test("explicit full execution cannot reuse a passing subset; opaque checks stay fresh", { timeout: 180_000 }, async t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const full = f.run(["--full"]);
  assert.equal(full.status, 1, full.text);
  assert.match(full.text, /unrelated full-suite control/);
  f.write("ui/src/consumer.test.ts", 'import {test,expect} from "vitest"; import {readFileSync} from "node:fs"; import {value} from "./leaf"; test("opaque fresh check",()=>expect(readFileSync(process.env.LOCAL_VERIFY_INPUT,"utf8")).toBe(String(value)));');
  f.git("add", "ui/src/consumer.test.ts");
  f.write(".turbo/external-input", "2");
  const input = { LOCAL_VERIFY_INPUT: path.join(f.root, ".turbo/external-input") };
  const opaque = f.run([], input);
  assert.equal(opaque.status, 0, opaque.text);
  assert.match(opaque.text, /Test Files\s+1 passed/);
  const fresh = f.run([], input);
  assert.equal(fresh.status, 0, fresh.text);
  assert.match(fresh.text, /Test Files\s+1 passed/);
  f.write(".turbo/external-input", "changed externally");
  const external = f.run([], input);
  assert.equal(external.status, 1, external.text);
  assert.match(external.text, /opaque fresh check/);
});

test("source mutation and interruption do not publish reusable passes", { timeout: 120_000 }, async t => {
  const f = fixture(t);
  const runControlled = action => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(f.root, "scripts/local-verify.mjs"), "--base", f.base, "--no-cache"], {
      cwd: f.root, env: f.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "", acted = false;
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Controlled verification did not finish")); }, 60_000);
    const collect = bytes => {
      text += bytes;
      if (!acted && text.includes("[verify] Running")) { acted = true; action(child); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, text, acted }); });
  });
  const changed = await runControlled(() => f.write("ui/src/leaf.ts", "export const value = 4;\n"));
  assert.equal(changed.acted, true);
  assert.equal(changed.code, 1, changed.text);
  assert.match(changed.text, /Inputs changed during verification/);
  const beforeInterrupt = f.run();
  assert.equal(beforeInterrupt.status, 0, beforeInterrupt.text);
  const interrupted = await runControlled(child => child.kill("SIGTERM"));
  assert.equal(interrupted.acted, true);
  assert.equal(interrupted.code, 143, interrupted.text);
  const result = f.run();
  assert.equal(result.status, 0, result.text);
  assert.match(result.text, /Test Files\s+1 passed/);
  assert.doesNotMatch(result.text, /reusing a passing local result/);
});

test("stale SDK public input pins stop verification before selection; fresh pins and unrelated changes continue", async t => {
  const f = fixture(t);
  const sdkInputs = "tests/runner-e2e/source-sdk-public-inputs.mjs", registry = "tests/runner-e2e/source-sdk-public-inputs.json";
  const blob = text => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  const outputSha256 = "a".repeat(64);
  f.write(sdkInputs, readFileSync(path.join(repository, sdkInputs), "utf8"));
  f.write("tests/runner-e2e/report-lock.json", `${JSON.stringify({ inputSha256: "b".repeat(64), outputSha256 })}\n`);
  f.write("packages/shared/src/schema.ts", "export const schema = 1;\n");
  const writeRegistry = schema => f.write(registry, `${JSON.stringify({ lockSha256: outputSha256, inputs: {
    "package.json": blob(readFileSync(path.join(f.root, "package.json"), "utf8")), "packages/shared/src/schema.ts": blob(schema) } }, null, 2)}\n`);
  writeRegistry("export const schema = 1;\n");
  f.git("add", "."); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "sdk pin baseline");
  const base = f.git("rev-parse", "HEAD");
  const run = args => {
    const result = spawnSync(process.execPath, [path.join(f.root, "scripts/local-verify.mjs"), "--base", base, ...args], {
      cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    return { ...result, text: stripVTControlCharacters(result.stdout + result.stderr) };
  };
  // Unrelated change: the pin check does not run, even with a stale registry in the tree.
  f.write("ui/src/leaf.ts", "export const value = 3;\n");
  f.write("packages/shared/src/schema.ts", "export const schema = 2;\n");
  f.git("add", "packages/shared/src/schema.ts"); f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "untracked drift");
  const unrelatedBase = f.git("rev-parse", "HEAD");
  const unrelated = spawnSync(process.execPath, [path.join(f.root, "scripts/local-verify.mjs"), "--base", unrelatedBase, "--explain"], {
    cwd: f.root, env: f.env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  assert.doesNotMatch(unrelated.stdout + unrelated.stderr, /is stale/);
  // Pinned input changed without a registry refresh: exit 1, name the input and the command, write nothing.
  const before = readFileSync(path.join(f.root, registry));
  const stale = run(["--explain"]);
  assert.equal(stale.status, 1, stale.text);
  assert.match(stale.text, /source-sdk-public-inputs\.json is stale for 1 pinned input\(s\): packages\/shared\/src\/schema\.ts \(changed\)/);
  assert.match(stale.text, /source-sdk-public-inputs\.mjs \$\(git rev-parse HEAD\) --write/);
  assert.doesNotMatch(stale.text, /Vitest test files selected|Broader verification required/);
  assert.deepEqual(readFileSync(path.join(f.root, registry)), before);
  // Refreshed pins: verification continues to selection.
  writeRegistry("export const schema = 2;\n");
  const fresh = run(["--explain"]);
  assert.doesNotMatch(fresh.text, /is stale/);
  assert.match(fresh.text, /Vitest test files selected|Broader verification required/);
  assert.notEqual(fresh.status, 1, fresh.text);
});

test("an edit between diff discovery and fingerprinting cannot certify a partial selection", { skip: process.platform === "win32" }, t => {
  const f = fixture(t);
  const executable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  f.write(".turbo/bin/package.json", '{"type":"commonjs"}');
  f.write(".turbo/bin/git", `#!${process.execPath}
const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const args=process.argv.slice(2);
const result=execFileSync(${JSON.stringify(executable)},args,{stdio:['ignore','pipe','pipe']});
if(args[0]==='diff'&&!args.includes('--cached')&&!fs.existsSync('.turbo/diff-edited')){
  fs.writeFileSync('ui/src/other.ts','export const other = 2;\\n');
  fs.writeFileSync('.turbo/diff-edited','done');
}
process.stdout.write(result);
`);
  chmodSync(path.join(f.root, ".turbo/bin/git"), 0o755);
  const result = f.run([], { PATH: `${path.join(f.root, ".turbo/bin")}${path.delimiter}${f.env.PATH}` });
  assert.equal(result.status, 1, result.text);
  assert.match(result.text, /Inputs changed/);
  assert.doesNotMatch(result.text, /Local Vitest verification passed/);
});
