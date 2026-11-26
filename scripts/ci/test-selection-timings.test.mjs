import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileTiming, timingPrefix } from "./test-timing-reporter.mjs";
import { parseTimings, updatedDurations, validateRun } from "./refresh-test-durations.mjs";

const file = "server/src/slow.test.ts", second = "server/src/fast.test.ts";
test("file costs include loading and setup, and failed files cannot become samples", () => {
  const module = { project: { name: "@paperclipai/server" }, moduleId: `${process.cwd()}/${file}`,
    state: () => "passed", diagnostic: () => ({ duration: 100, collectDuration: 200, setupDuration: 30,
      prepareDuration: 20, environmentSetupDuration: 10 }) };
  assert.deepEqual(fileTiming(module), { version: 1, file, durationMs: 360 });
  assert.equal(fileTiming({ ...module, state: () => "failed" }), null);
  assert.equal(fileTiming({ ...module, diagnostic: () => ({ duration: NaN }) }), null);
});

test("structured measurements replace bootstrap logs without allowing arbitrary paths", () => {
  const inventory = new Set([file]);
  const log = `2026-10-31T00:00:00Z ✓ @paperclipai/server src/slow.test.ts (2 tests) 100ms\n`;
  assert.deepEqual(parseTimings(log, inventory).get(file), { ms: 100, complete: false });
  const record = { version: 1, file, durationMs: 360 };
  assert.deepEqual(parseTimings(log + timingPrefix + JSON.stringify(record), inventory).get(file), { ms: 360, complete: true });
  assert.equal(parseTimings(timingPrefix + JSON.stringify({ ...record, file: "server/src/deleted.test.ts" }), inventory).size, 0);
  for (const invalid of [{ ...record, file: "../../package.json" }, { ...record, durationMs: -1 },
    { ...record, file: "server/src/../outside.test.ts" },
    { ...record, durationMs: "360" }, { ...record, version: 2 }]) {
    assert.throws(() => parseTimings(timingPrefix + JSON.stringify(invalid), inventory));
  }
});

test("refresh uses medians, removes obsolete paths and refuses partial lane coverage", () => {
  const previous = { durations: { [file]: 2, "server/src/removed.test.ts": 42 } };
  const samples = [new Map([[file, { ms: 2500, complete: false }], [second, { ms: 1, complete: false }]]),
    new Map([[file, { ms: 3000, complete: true }], [second, { ms: 200, complete: false }]]),
    new Map([[file, { ms: 4000, complete: true }]])];
  const result = updatedDurations(previous, new Set([file, second]), samples, []);
  assert.deepEqual(result.durations, { [second]: 101, [file]: 3500 });
  assert.throws(() => updatedDurations(previous, new Set([file, second]), [new Map()], []), /Incomplete timing/);
});

test("only successful same-repository master push verification can supply weights", () => {
  const run = { repository: { id: 1170821064, full_name: "paperclipai/paperclip" }, head_repository: { id: 1170821064 },
    head_branch: "master", event: "push", path: ".github/workflows/cloud-readiness.yml", status: "completed",
    conclusion: "success", head_sha: "a".repeat(40), id: 1, run_attempt: 1 };
  validateRun(run);
  for (const override of [{ head_repository: { id: 123 } }, { head_branch: "feature" }, { event: "pull_request" },
    { conclusion: "failure" }, { status: "in_progress" }, { path: ".github/workflows/pr.yml" }, { run_attempt: 0 }]) {
    assert.throws(() => validateRun({ ...run, ...override }));
  }
  const workflow = readFileSync(".github/workflows/ci-test-durations.yml", "utf8");
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /github.ref == 'refs\/heads\/master'/);
  assert.doesNotMatch(workflow, /pull_request_target|runs-on\/fleet|--force/);
});
