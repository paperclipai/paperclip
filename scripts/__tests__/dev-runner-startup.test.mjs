import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const source = fs.readFileSync(new URL("../dev-runner.ts", import.meta.url), "utf8");
function functionSource(name, next) {
  const start = source.indexOf(`async function ${name}(`);
  const end = source.indexOf(`async function ${next}(`, start);
  assert.ok(start >= 0 && end > start, `Could not locate ${name}`);
  return source.slice(start, end);
}
const startupSource = functionSource("buildPluginSdk", "getNativeRunnerRequired")
  + functionSource("startServerChild", "maybeAutoRestartChild");

function startup({ platform = "win32", mode = "watch", build, probe }) {
  const calls = [];
  const context = {
    console: { log() {}, error() {} },
    process: { platform, exit: code => { throw new Error(`exit:${code}`); } },
    exitForSignal: signal => { throw new Error(`signal:${signal}`); },
    runPnpm: async args => { calls.push("sdk"); return build(Array.from(args)); },
    buildPaperclipRunner: async () => { calls.push("probe"); await probe(); },
    spawn: (_command, args, options) => {
      calls.push("server");
      assert.deepEqual(Array.from(args), ["--filter", "@paperclipai/server", mode === "watch" ? "dev:watch" : "dev"]);
      assert.equal(options.shell, platform === "win32");
      return { on() {} };
    },
    markChildAsCurrent: async () => {},
    mode, pnpmBin: "pnpm", forwardedArgs: [], env: {}, child: null, childExitPromise: null,
  };
  const start = runInNewContext(`${startupSource}\nstartServerChild`, context);
  return { start, calls };
}

function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-startup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(new URL("../ensure-plugin-build-deps.mjs", import.meta.url), path.join(root, "scripts/ensure-plugin-build-deps.mjs"));
  const compiler = path.join(root, "node_modules/typescript/bin/tsc");
  fs.mkdirSync(path.dirname(compiler), { recursive: true });
  fs.writeFileSync(compiler, `
const fs = require("node:fs");
const path = require("node:path");
const target = path.dirname(process.argv[3]);
if (target.endsWith("sdk") && !fs.existsSync("packages/shared/dist/index.js")) process.exit(42);
fs.appendFileSync("builds", target + "\\n");
fs.mkdirSync(path.join(target, "dist"), { recursive: true });
fs.writeFileSync(path.join(target, "dist/index.js"), "exports.ready = true;\\n");
`);
  for (const target of ["packages/shared", "packages/plugins/sdk"]) {
    fs.mkdirSync(path.join(root, target, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, target, "src/index.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, target, "tsconfig.json"), "{}");
  }
  fs.mkdirSync(path.join(root, "packages/shared/src/cliplab"));
  for (const asset of ["LICENSE", "PROVENANCE.md"]) {
    fs.writeFileSync(path.join(root, "packages/shared/src/cliplab", asset), `original ${asset}\n`);
  }
  return root;
}

for (const [platform, mode] of [["win32", "watch"], ["linux", "dev"], ["darwin", "watch"]]) {
  test(`prepares missing SDK before runner imports and reuses builds (${platform}/${mode})`, async t => {
    const root = checkout(t);
    const sdk = path.join(root, "packages/plugins/sdk/dist/index.js");
    assert.equal(fs.existsSync(sdk), false);
    const { start, calls } = startup({ platform, mode,
      build: async args => {
        assert.deepEqual(args, ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]);
        const child = spawn(process.execPath, ["scripts/ensure-plugin-build-deps.mjs"], { cwd: root, stdio: "pipe" });
        let output = "";
        child.stderr.on("data", chunk => { output += chunk; });
        const [code, signal] = await once(child, "close");
        assert.equal(code, 0, output);
        return { code, signal };
      },
      probe: async () => { assert.equal((await import(pathToFileURL(sdk).href)).default.ready, true); },
    });
    await start();
    await start();
    assert.deepEqual(calls, ["sdk", "probe", "server", "sdk", "probe", "server"]);
    assert.equal(fs.readFileSync(path.join(root, "builds"), "utf8").trim().split("\n").length, 2);
  });
}

test("SDK build failure stops before probing or spawning the server", async () => {
  const { start, calls } = startup({ build: async () => ({ code: 2, signal: null }), probe: async () => {} });
  await assert.rejects(start(), /exit:2/);
  assert.deepEqual(calls, ["sdk"]);
});

test("SDK build interruption stops before probing or spawning the server", async () => {
  const { start, calls } = startup({ build: async () => ({ code: 0, signal: "SIGINT" }), probe: async () => {} });
  await assert.rejects(start(), /signal:SIGINT/);
  assert.deepEqual(calls, ["sdk"]);
});

test("runner preparation failure stops before spawning the server", async () => {
  const { start, calls } = startup({ build: async () => ({ code: 0, signal: null }),
    probe: async () => { throw new Error("runner failed"); } });
  await assert.rejects(start(), /runner failed/);
  assert.deepEqual(calls, ["sdk", "probe"]);
});
