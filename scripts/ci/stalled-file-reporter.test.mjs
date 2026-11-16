import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import StalledFileReporter, { defaultStallMs, stallAnnotation, stalledFileReporterEnabled, stallLimitMs }
  from "./stalled-file-reporter.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const reporterPath = fileURLToPath(new URL("./stalled-file-reporter.mjs", import.meta.url));

test("the stall limit defaults to eight minutes and accepts a positive override", () => {
  assert.equal(stallLimitMs({}), defaultStallMs);
  assert.equal(defaultStallMs, 8 * 60_000);
  assert.equal(stallLimitMs({ PAPERCLIP_VITEST_FILE_STALL_MS: " 1500 " }), 1500);
  assert.equal(stallLimitMs({ PAPERCLIP_VITEST_FILE_STALL_MS: "" }), defaultStallMs);
  for (const value of ["0", "-5", "1.5", "soon"]) {
    assert.throws(() => stallLimitMs({ PAPERCLIP_VITEST_FILE_STALL_MS: value }), /positive integer/, value);
  }
});

test("the reporter watches in GitHub Actions, or wherever the limit is set", () => {
  assert.equal(stalledFileReporterEnabled({}), false);
  assert.equal(stalledFileReporterEnabled({ GITHUB_ACTIONS: "true" }), true);
  assert.equal(stalledFileReporterEnabled({ PAPERCLIP_VITEST_FILE_STALL_MS: "1000" }), true);
});

test("a file stops the run only once it makes no progress for the whole limit", () => {
  let now = 0;
  const lines = [], exits = [];
  const cancels = [];
  const reporter = new StalledFileReporter({ limitMs: 1000, now: () => now, write: line => lines.push(line),
    exit: code => exits.push(code), root: "/repo", graceMs: 0 });
  reporter.onInit({ cancelCurrentRun: reason => { cancels.push(reason); return Promise.resolve(); } });
  const moduleId = "/repo/server/src/stuck.test.ts";
  const testCase = { fullName: "suite > waits forever", module: { moduleId } };
  reporter.onTestModuleStart({ moduleId });
  reporter.onTestModuleStart({ moduleId: "/repo/server/src/healthy.test.ts" });
  now = 900; reporter.onTestCaseReady(testCase);
  now = 1800; reporter.onTestCaseResult({ fullName: "ok", module: { moduleId: "/repo/server/src/healthy.test.ts" } });
  reporter.check();
  assert.deepEqual(lines, [], "progress 900 ms ago is not a stall");
  now = 1900; reporter.check();
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^::error file=server\/src\/stuck\.test\.ts,title=Test file stopped making progress::/);
  assert.match(lines[0], /while in: test "suite > waits forever"/);
  assert.equal(lines[1], "[stalled-file-reporter] stopping the run; files still running: server/src/healthy.test.ts, server/src/stuck.test.ts");
  assert.deepEqual(cancels, ["stalled-file"]);
  reporter.check();
  assert.equal(lines.length, 2, "a stopped run reports once");
  process.exitCode = 0;
});

test("finished files and hooks count as progress", () => {
  let now = 0;
  const lines = [];
  const reporter = new StalledFileReporter({ limitMs: 1000, now: () => now, write: line => lines.push(line), exit: () => {}, root: "/repo" });
  const moduleId = "/repo/a.test.ts";
  reporter.onTestModuleStart({ moduleId });
  now = 800; reporter.onHookStart({ name: "beforeAll", entity: { moduleId } });
  now = 1600; reporter.check();
  assert.deepEqual(lines, []);
  reporter.onTestModuleEnd({ moduleId });
  now = 10_000; reporter.check();
  assert.deepEqual(lines, []);
  assert.equal(stallAnnotation({ file: "a,b:c.test.ts", progressAt: 0, step: "x\ny" }, 90_000),
    "::error file=a%2Cb%3Ac.test.ts,title=Test file stopped making progress::a,b:c.test.ts made no progress for 1.5 min while in: x%0Ay."
      + " The run was stopped so this job fails with the file's name instead of reaching its time limit.");
});

test("a file that never finishes loading is named from the moment it is queued", () => {
  let now = 0;
  const lines = [];
  const reporter = new StalledFileReporter({ limitMs: 1000, now: () => now, write: line => lines.push(line), exit: () => {}, root: "/repo" });
  reporter.onTestModuleQueued({ moduleId: "/repo/server/src/top-level-await.test.ts" });
  now = 1000; reporter.check();
  assert.match(lines[0] ?? "", /^::error file=server\/src\/top-level-await\.test\.ts,.*while in: loading the file\./);
  process.exitCode = 0;
});

// The failure this guards: a test awaiting a promise that never settles, with
// a test timeout longer than the CI job, holds Vitest until the job is
// cancelled and never prints the file's name.
for (const [label, body, step] of [
  ["a test that never settles", 'import { test } from "vitest";\ntest("waits forever", () => new Promise(() => {}), 600_000);\n', 'test "waits forever"'],
  ["a top-level await that never settles", 'import { test } from "vitest";\nawait new Promise(() => {});\ntest("never collected", () => {});\n', "loading the file"],
]) test(`a real Vitest run with ${label} fails fast and names the file`, () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "stalled-file-reporter-")));
  try {
    writeFileSync(path.join(directory, "stuck.test.mjs"), body);
    writeFileSync(path.join(directory, "quick.test.mjs"), `import { test } from "vitest";
test("passes", () => {});
`);
    const configFile = path.join(directory, "vitest.config.mjs");
    writeFileSync(configFile, `export default ${JSON.stringify({ test: { include: ["*.test.mjs"],
      reporters: ["default", [reporterPath, { limitMs: 1500, graceMs: 5000, root: directory }]] } })};`);
    const started = Date.now();
    const result = spawnSync(process.execPath, [path.join(root, "node_modules/vitest/vitest.mjs"), "run",
      "--config", configFile, "--root", directory], {
      cwd: directory, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, GITHUB_ACTIONS: "", PAPERCLIP_VITEST_FILE_STALL_MS: "" },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.signal, null, `Vitest was still running after 60 s:\n${output}`);
    assert.notEqual(result.status, 0, output);
    assert.ok(Date.now() - started < 30_000, `took ${Date.now() - started} ms:\n${output}`);
    assert.match(output, /::error file=stuck\.test\.mjs,title=Test file stopped making progress::stuck\.test\.mjs made no progress/);
    assert.ok(output.includes(`while in: ${step}.`), output);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
