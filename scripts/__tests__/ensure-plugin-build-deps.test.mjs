import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-build-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `
const fs = require("node:fs");
const path = require("node:path");
const target = path.dirname(process.argv[3]);
const active = path.resolve("compiler-active");
try { fs.mkdirSync(active); } catch { process.exit(42); }
process.on("exit", () => fs.rmSync(active, { recursive: true, force: true }));
process.on("SIGTERM", () => process.exit(143));
process.on("SIGINT", () => process.exit(130));
fs.appendFileSync("builds", target + "\\n");
fs.mkdirSync(path.join(target, "dist"), { recursive: true });
// Deliberately write index.js before the compiler finishes emitting the rest.
fs.writeFileSync(path.join(target, "dist/index.js"), "export {};\\n");
setTimeout(() => {
  if (fs.existsSync("fail")) process.exit(2);
  fs.writeFileSync(path.join(target, "dist/complete"), "done");
}, Number(process.env.BUILD_DELAY ?? 20));
`);
  for (const target of ["packages/shared", "packages/plugins/sdk"]) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  const lock = path.join(root, "node_modules/.cache/paperclip-plugin-build-deps.lock");
  const launch = (env = {}) => {
    const child = spawn(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], {
      cwd: root, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    const done = once(child, "close").then(([code]) => ({ code, output }));
    t.after(() => { if (child.exitCode === null) child.kill("SIGTERM"); });
    return { child, done };
  };
  return { root, lock, launch };
}

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await sleep(10);
  }
}

test("recovers the old empty lock left by interrupted startup", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.lock, { recursive: true });
  const old = new Date(Date.now() - 180_000);
  fs.utimesSync(f.lock, old, old);
  const result = await f.launch().done;
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Recovered abandoned/);
  assert.match(result.output, /Building @paperclipai\/shared/);
  assert.equal(fs.existsSync(f.lock), false);
});

test("concurrent startups recover a dead owner and build only once", async (t) => {
  const f = fixture(t);
  const dead = spawnSync(process.execPath, ["-e", "" ]).pid;
  fs.mkdirSync(f.lock, { recursive: true });
  fs.writeFileSync(path.join(f.lock, `owner-${dead}-old.json`), JSON.stringify({ pid: dead }));
  const results = await Promise.all(Array.from({ length: 4 }, () => f.launch({ BUILD_DELAY: "150" }).done));
  for (const result of results) assert.equal(result.code, 0, result.output);
  assert.equal(fs.readFileSync(path.join(f.root, "builds"), "utf8").trim().split("\n").length, 2);
});

test("does not accept partially emitted output while another compiler holds the lock", async (t) => {
  const f = fixture(t);
  const first = f.launch({ BUILD_DELAY: "200" });
  await until(() => fs.existsSync(path.join(f.root, "packages/plugins/sdk/dist/index.js")));
  const second = await f.launch().done;
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /Waiting for another workspace build/);
  assert.equal(fs.existsSync(path.join(f.root, "packages/plugins/sdk/dist/complete")), true);
  assert.equal((await first.done).code, 0);
});

test("preserves a live compiler's lock even when its parent has exited", async (t) => {
  const f = fixture(t);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.mkdirSync(f.lock, { recursive: true });
  fs.writeFileSync(path.join(f.lock, `owner-${dead}-old.json`), JSON.stringify({ pid: dead, childPid: process.pid }));
  const run = f.launch();
  await sleep(200);
  assert.equal(fs.existsSync(path.join(f.root, "builds")), false);
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 143);
  assert.equal(fs.existsSync(f.lock), true);
});

test("termination stops the compiler and releases the lock for the next startup", async (t) => {
  const f = fixture(t);
  const run = f.launch({ BUILD_DELAY: "10000" });
  await until(() => fs.existsSync(path.join(f.root, "compiler-active")));
  run.child.kill("SIGTERM");
  assert.equal((await run.done).code, 143);
  assert.equal(fs.existsSync(f.lock), false);
  assert.equal(fs.existsSync(path.join(f.root, "compiler-active")), false);
  const retry = await f.launch().done;
  assert.equal(retry.code, 0, retry.output);
  assert.equal(fs.existsSync(path.join(f.root, "packages/shared/dist/complete")), true);
});

test("failed compilation releases the lock and is rebuilt on retry", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "fail"), "");
  assert.equal((await f.launch().done).code, 2);
  assert.equal(fs.existsSync(f.lock), false);
  fs.unlinkSync(path.join(f.root, "fail"));
  const retry = await f.launch().done;
  assert.equal(retry.code, 0, retry.output);
  assert.equal(fs.existsSync(path.join(f.root, "packages/shared/dist/complete")), true);
});
