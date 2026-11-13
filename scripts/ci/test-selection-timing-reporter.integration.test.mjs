import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseTimings } from "./refresh-test-durations.mjs";

test("the real Vitest reporter includes import/setup cost and preserves failures", t => {
  const repo = process.cwd(), root = realpathSync(mkdtempSync(path.join(tmpdir(), "file-cost-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "server/src"), { recursive: true });
  symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
  writeFileSync(path.join(root, "vitest.config.mjs"), `export default {test:{name:"@paperclipai/server",include:["server/src/*.test.mjs"],setupFiles:["./setup.mjs"],reporters:["default",${JSON.stringify(path.join(repo, "scripts/ci/test-timing-reporter.mjs"))}]}}`);
  writeFileSync(path.join(root, "setup.mjs"), 'await new Promise(resolve=>setTimeout(resolve,60));');
  writeFileSync(path.join(root, "server/src/probe.test.mjs"), 'import {test} from "vitest"; await new Promise(resolve=>setTimeout(resolve,60)); test("pass",()=>{});');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [path.join(repo, "node_modules/vitest/vitest.mjs"), "run"], {
    cwd: root, env, encoding: "utf8", timeout: 30_000,
  });
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const file = "server/src/probe.test.mjs";
  const measurement = parseTimings(result.stdout, new Set([file])).get(file);
  assert.equal(measurement.complete, true);
  assert.ok(measurement.ms >= 110, JSON.stringify(measurement));
  writeFileSync(path.join(root, "server/src/probe.test.mjs"), 'import {test} from "vitest"; test("fail",()=>{throw new Error("expected failure")});');
  const failed = run();
  assert.equal(failed.status, 1);
  assert.equal(parseTimings(failed.stdout, new Set([file])).size, 0);
});
