import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ghApi, resetGhApiForTests } from "./gh-api.mjs";
import OversizedSpecReporter from "./oversized-test-files-playwright.mjs";
import OversizedTestFileReporter, { oversizedAnnotation, oversizedThresholdMs } from "./oversized-test-files.mjs";
import { attributeSpec, collectMergedPrSamples, completeShardSet, e2eShardJob, parseE2eLog, parseRunnerLog,
  runnerInventory, runnerPackageJob, validatePrRun, validatePull } from "./pr-run-durations.mjs";
import { oversizedFiles, oversizedPlaceholder, parseArgs, parseTimings, renderPrBody, serverLane, updatedDurations } from "./refresh-test-durations.mjs";
import { timingPrefix } from "./test-timing-reporter.mjs";

const esc = "\u001b";
const sha = character => character.repeat(40);
const stamp = seconds => new Date(Date.UTC(2026, 10, 6, 21, 0, 0) + seconds * 1000).toISOString().replace("Z", "0000Z");
const logLines = lines => lines.map(([seconds, text]) => `${stamp(seconds)} ${text}`).join("\n");

test("gh api opts into escape sequences, falls back for older gh, and strips colour from logs", async () => {
  resetGhApiForTests();
  const calls = [];
  const modern = async (command, args) => {
    calls.push(args);
    return { stdout: `${esc}[32m ✓${esc}[39m src/a.test.ts (1 test) 5ms` };
  };
  assert.equal(await ghApi("/repos/x/actions/jobs/1/logs", { json: false, run: modern }), " ✓ src/a.test.ts (1 test) 5ms");
  assert.deepEqual(calls[0], ["api", "--allow-escape-sequences", "/repos/x/actions/jobs/1/logs"]);

  resetGhApiForTests();
  calls.length = 0;
  const legacy = async (command, args) => {
    calls.push(args);
    if (args.includes("--allow-escape-sequences")) {
      throw Object.assign(new Error("Command failed"), { stderr: "unknown flag: --allow-escape-sequences\n\nUsage:  gh api <endpoint> [flags]" });
    }
    return { stdout: "{\"ok\":true}" };
  };
  assert.deepEqual(await ghApi("/a", { run: legacy }), { ok: true });
  assert.deepEqual(await ghApi("/b", { run: legacy }), { ok: true });
  // The unsupported flag is tried once, then dropped for the process.
  assert.deepEqual(calls, [["api", "--allow-escape-sequences", "/a"], ["api", "/a"], ["api", "/b"]]);

  resetGhApiForTests();
  const failing = async () => { throw Object.assign(new Error("HTTP 404"), { stderr: "gh: Not Found (HTTP 404)" }); };
  await assert.rejects(ghApi("/missing", { run: failing }), /HTTP 404/);
  resetGhApiForTests();
});

test("server timing parsing tolerates colour codes in fetched logs", () => {
  const file = "server/src/slow.test.ts";
  const log = `${esc}[2m${stamp(0)}${esc}[22m ${timingPrefix}${JSON.stringify({ version: 1, file, durationMs: 360 })}`;
  assert.deepEqual(parseTimings(log, new Set([file])).get(file), { ms: 360, complete: true });
});

const shardLine = "shard 2/4 specs: tests/e2e/alpha.spec.ts tests/e2e/smoke-lab-p1-p4.spec.ts tests/e2e/smoke-lab-p5-p7.spec.ts tests/e2e/gone.spec.ts";
const e2eLog = logLines([
  [0, `${esc}[36;1mecho "shard 2/4 specs: $specs"${esc}[0m`],
  [1, shardLine],
  [2, "[WebServer] > vite build"],
  [30, "Running 4 tests using 1 worker"],
  [31, "[WebServer] ✓ 4 tests/e2e/alpha.spec.ts noise"],
  [40, `  ${esc}[32m✓${esc}[39m   1 [chromium] › tests/e2e/alpha.spec.ts:9:1 › first (7.6s)`],
  [45, "  -   2 [chromium] › tests/e2e/alpha.spec.ts:20:1 › skipped test"],
  [70, "  ✓   3 [chromium] › tests/e2e/smoke-lab.shared.ts:316:3 › Smoke Lab scenario catalog mirror (P5-P7) › records the P5-P7 lifecycle @smoke-lab (24.0s)"],
  [75, "  ✓   4 [chromium] › tests/e2e/gone.spec.ts:1:1 › removed later (4.0s)"],
  [76, "  1 skipped"],
  [76, "  3 passed (46.0s)"],
]);

test("e2e weights are gaps between Playwright results, attributed to the running spec", () => {
  const inventory = new Set(["tests/e2e/alpha.spec.ts", "tests/e2e/smoke-lab-p1-p4.spec.ts", "tests/e2e/smoke-lab-p5-p7.spec.ts"]);
  const parsed = parseE2eLog(e2eLog, inventory);
  assert.deepEqual(Object.fromEntries(parsed), {
    "tests/e2e/alpha.spec.ts": { ms: 15_000, complete: true },
    "tests/e2e/smoke-lab-p5-p7.spec.ts": { ms: 25_000, complete: true },
  });
  assert.throws(() => parseE2eLog(e2eLog.replace("Running 4 tests", "Running 5 tests"), inventory), /Parsed 4 of 5/);
  assert.throws(() => parseE2eLog(e2eLog.replace("using 1 worker", "using 2 workers"), inventory), /single Playwright worker/);
  assert.throws(() => parseE2eLog(logLines([[0, shardLine]]), inventory), /No Playwright run/);
  assert.throws(() => parseE2eLog(e2eLog.replace("tests/e2e/gone.spec.ts:1:1", "tests/e2e/elsewhere.spec.ts:1:1"), inventory),
    /not in this shard/);
});

test("shared-file tests map to exactly one shard spec", () => {
  const specs = ["tests/e2e/smoke-lab-p1-p4.spec.ts", "tests/e2e/smoke-lab-p5-p7.spec.ts", "tests/e2e/agent-chat-projects.spec.ts"];
  assert.equal(attributeSpec("tests/e2e/smoke-lab.shared.ts", "Smoke Lab (P1-P4) › records", specs), specs[0]);
  assert.equal(attributeSpec("tests/e2e/agent-chat.shared.ts", "anything", specs), specs[2]);
  assert.throws(() => attributeSpec("tests/e2e/smoke-lab.shared.ts", "no label", specs), /Cannot attribute/);
  assert.throws(() => attributeSpec("tests/e2e/helpers/x.ts", "t", specs), /Cannot attribute/);
  assert.throws(() => attributeSpec("tests/e2e/smoke-lab.shared.ts", "(P1-P4)", null), /No shard spec list/);
});

const runnerLog = logLines([
  [0, " RUN  v5.0.0 /home/runner/_work/paperclip/paperclip/packages/paperclip-runner"],
  [10, ` ${esc}[32m✓${esc}[39m src/live/runnerd-codex-transport.test.ts ${esc}[2m(257 tests)${esc}[22m 126679ms`],
  [11, " ✓ src/control-plane/acpx-controller-recovery.test.ts (11 tests | 1 skipped) 78087ms"],
  [12, " ✓ scripts/vitest-sequencer.test.mjs (3 tests) 12ms"],
  [12, "     ✓ a slow test inside a file 5000ms"],
  [13, " ✓ src/deleted.test.ts (1 test) 9ms"],
  [20, " Test Files  4 passed | 1 skipped (5)"],
  [20, "      Tests  272 passed | 1 skipped (273)"],
]);

test("Runner weights come from Vitest per-file lines and must account for every passed file", () => {
  const inventory = new Set(["packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts",
    "packages/paperclip-runner/src/control-plane/acpx-controller-recovery.test.ts",
    "packages/paperclip-runner/scripts/vitest-sequencer.test.mjs"]);
  assert.deepEqual(Object.fromEntries(parseRunnerLog(runnerLog, inventory)), {
    "packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts": { ms: 126_679, complete: false },
    "packages/paperclip-runner/src/control-plane/acpx-controller-recovery.test.ts": { ms: 78_087, complete: false },
    "packages/paperclip-runner/scripts/vitest-sequencer.test.mjs": { ms: 12, complete: false },
  });
  assert.throws(() => parseRunnerLog(runnerLog.replace("4 passed", "5 passed"), inventory), /Parsed 4 of 5/);
  assert.throws(() => parseRunnerLog(runnerLog.replace(/ Test Files.*\n/, ""), inventory), /No Vitest summary/);
  assert.throws(() => parseRunnerLog(runnerLog.replace("src/deleted.test.ts", "src/../../x.test.ts"), inventory));
});

test("the Runner inventory follows the package's Vitest include list", () => {
  const inventory = runnerInventory();
  assert.ok(inventory.size > 100, `unexpectedly small Runner inventory: ${inventory.size}`);
  assert.ok(inventory.has("packages/paperclip-runner/src/live/runnerd-codex-transport.test.ts"));
  assert.ok(inventory.has("packages/paperclip-runner/scripts/vitest-sequencer.test.mjs"));
  // node --test files in the same package are not Vitest weights.
  assert.ok(!inventory.has("packages/paperclip-runner/scripts/vitest-sequencer.mjs"));
  assert.ok(![...inventory].some(file => file.startsWith("packages/paperclip-runner/test/")));
});

test("job names select complete, successful shard sets only", () => {
  assert.deepEqual(e2eShardJob("ci / e2e shard (3/8)"), { index: 3, count: 8 });
  assert.equal(e2eShardJob("ci / e2e"), null);
  assert.deepEqual(runnerPackageJob("ci / Verify Paperclip Runner (vitest package)"), { index: 1, count: 1 });
  assert.deepEqual(runnerPackageJob("ci / Verify Paperclip Runner (package (2/3))"), { index: 2, count: 3 });
  assert.equal(runnerPackageJob("ci / Verify Paperclip Runner (vitest native server)"), null);
  const job = (name, conclusion = "success") => ({ name, conclusion });
  const shards = [job("ci / e2e shard (1/2)"), job("ci / e2e shard (2/2)"), job("ci / build")];
  assert.equal(completeShardSet(shards, e2eShardJob).length, 2);
  assert.equal(completeShardSet(shards.slice(1), e2eShardJob), null);
  assert.equal(completeShardSet([shards[0], job("ci / e2e shard (2/2)", "skipped")], e2eShardJob), null);
  assert.equal(completeShardSet([shards[0], shards[1], shards[1]], e2eShardJob), null);
  assert.equal(completeShardSet([job("ci / build")], e2eShardJob), null);
});

const pull = (number, head, merge, extra = {}) => ({ number, merged_at: `2026-11-0${number % 9 + 1}T00:00:00Z`,
  base: { ref: "master", repo: { id: 1170821064 } }, head: { sha: head }, merge_commit_sha: merge, ...extra });
const prRun = (id, head, extra = {}) => ({ id, run_attempt: 1, head_sha: head, event: "pull_request", path: ".github/workflows/pr.yml",
  status: "completed", conclusion: "success", html_url: `https://example.test/${id}`,
  repository: { id: 1170821064, full_name: "paperclipai/paperclip" }, ...extra });

test("merged-PR runs must be successful pull_request runs of pr.yml at the PR's final head", () => {
  const merged = pull(1, sha("a"), sha("b"));
  validatePull(merged);
  validatePrRun(prRun(5, sha("a")), merged);
  for (const override of [{ merged_at: null }, { base: { ref: "release", repo: { id: 1170821064 } } },
    { base: { ref: "master", repo: { id: 7 } } }, { merge_commit_sha: null }]) {
    assert.throws(() => validatePull({ ...merged, ...override }));
  }
  for (const override of [{ head_sha: sha("c") }, { event: "push" }, { path: ".github/workflows/pr-trusted.yml" },
    { conclusion: "failure" }, { status: "in_progress" }, { repository: { id: 7, full_name: "fork/paperclip" } }, { run_attempt: 0 }]) {
    assert.throws(() => validatePrRun(prRun(5, sha("a"), override), merged));
  }
});

test("collection skips unmerged, absent, stale-head and incomplete runs, and samples each lane per run", async () => {
  const api = "/repos/paperclipai/paperclip";
  const pulls = [pull(1, sha("1"), sha("a")), pull(2, sha("2"), sha("b")), pull(3, sha("3"), sha("c")),
    { ...pull(4, sha("4"), sha("d")), merged_at: null }, pull(5, sha("5"), sha("e"))];
  const e2eJobs = [{ id: 101, name: "ci / e2e shard (1/1)" }, { id: 102, name: "ci / Verify Paperclip Runner (vitest package)" }];
  const responses = {
    [`${api}/pulls?state=closed&base=master&sort=updated&direction=desc&per_page=40`]: pulls,
    // PR 1 has only a run of an earlier push; PR 2 is newest-first; PR 5 lacks a Runner job.
    [`${api}/actions/workflows/pr.yml/runs?head_sha=${sha("1")}&event=pull_request&status=success&per_page=20`]: { workflow_runs: [prRun(11, sha("9"))] },
    [`${api}/actions/workflows/pr.yml/runs?head_sha=${sha("2")}&event=pull_request&status=success&per_page=20`]: { workflow_runs: [prRun(20, sha("2")), prRun(21, sha("2"))] },
    [`${api}/actions/workflows/pr.yml/runs?head_sha=${sha("5")}&event=pull_request&status=success&per_page=20`]: { workflow_runs: [prRun(50, sha("5"))] },
    [`${api}/actions/runs/21/jobs?filter=latest&per_page=100&page=1`]: { jobs: e2eJobs.map(job => ({ ...job, run_id: 21, conclusion: "success" })) },
    [`${api}/actions/runs/50/jobs?filter=latest&per_page=100&page=1`]: { jobs: [{ id: 501, name: "ci / e2e shard (1/1)", run_id: 50, conclusion: "success" }] },
    [`${api}/actions/jobs/101/logs`]: e2eLog,
    [`${api}/actions/jobs/102/logs`]: runnerLog,
    [`${api}/actions/jobs/501/logs`]: e2eLog.replace("Running 4 tests", "Running 9 tests"),
  };
  const requested = [];
  const gh = async endpoint => {
    requested.push(endpoint);
    assert.ok(endpoint in responses, `unexpected request ${endpoint}`);
    return responses[endpoint];
  };
  const warnings = [];
  const lanes = [
    { name: "e2e", classify: e2eShardJob, parse: parseE2eLog, inventory: new Set(["tests/e2e/alpha.spec.ts"]) },
    { name: "runner", classify: runnerPackageJob, parse: parseRunnerLog,
      inventory: new Set(["packages/paperclip-runner/scripts/vitest-sequencer.test.mjs"]) },
  ];
  const result = await collectMergedPrSamples({ gh, lanes, isMerged: merge => merge !== sha("c"), log: line => warnings.push(line) });
  assert.deepEqual(result.e2e.sources.map(source => source.run), [21]);
  assert.deepEqual(result.runner.sources, [{ pull: 2, run: 21, attempt: 1, sha: sha("2"), url: "https://example.test/21" }]);
  assert.deepEqual(Object.fromEntries(result.e2e.samples[0]), { "tests/e2e/alpha.spec.ts": { ms: 15_000, complete: true } });
  assert.match(warnings.join("\n"), /e2e: skipped run 50 for PR #5: Parsed 4 of 9/);
  // PR 3 is not in this checkout and PR 4 never merged: neither is queried.
  assert.ok(!requested.some(endpoint => endpoint.includes(sha("3")) || endpoint.includes(sha("4"))));
});

test("merged-PR manifests use the shared schema and only reorder placement", () => {
  const inventory = new Set(["tests/e2e/a.spec.ts", "tests/e2e/b.spec.ts"]);
  const samples = [new Map([["tests/e2e/a.spec.ts", { ms: 1000, complete: true }], ["tests/e2e/b.spec.ts", { ms: 50, complete: true }]]),
    new Map([["tests/e2e/a.spec.ts", { ms: 3000, complete: true }]])];
  const result = updatedDurations({ durations: {} }, inventory, samples, [{ pull: 1, run: 2 }], { comment: "c" });
  assert.deepEqual(result, { $comment: "c", unit: "ms", sources: [{ pull: 1, run: 2 }],
    coverage: { measured: 2, withSetup: 2, inventory: 2 }, durations: { "tests/e2e/a.spec.ts": 2000, "tests/e2e/b.spec.ts": 100 } });
  const manifest = JSON.parse(readFileSync("scripts/e2e-shard-durations.json", "utf8"));
  assert.match(manifest.$comment, /never change which specs run/);
  assert.equal(manifest.unit, "ms");
  assert.ok(manifest.sources.length >= 2 && manifest.sources.every(source => Number.isSafeInteger(source.pull)));
});

test("oversized files are listed in the refresh PR body", () => {
  const template = readFileSync(".github/ci-duration-pr.md", "utf8");
  assert.ok(template.includes(oversizedPlaceholder));
  const manifests = [{ data: { durations: { "server/src/a.test.ts": 200_000, "server/src/b.test.ts": 1000 } } },
    { data: { durations: { "tests/e2e/c.spec.ts": 400_000 } } }];
  const oversized = oversizedFiles(manifests, 180_000);
  assert.deepEqual(oversized, [["tests/e2e/c.spec.ts", 400_000], ["server/src/a.test.ts", 200_000]]);
  const body = renderPrBody(template, oversized, 180_000);
  assert.ok(!body.includes(oversizedPlaceholder));
  assert.match(body, /2 test file\(s\) exceed the 180s per-file budget/);
  assert.match(body, /  - `tests\/e2e\/c\.spec\.ts`: 400s\n  - `server\/src\/a\.test\.ts`: 200s/);
  assert.match(renderPrBody(template, [], 180_000), /No measured test file exceeds the 180s/);
  assert.throws(() => renderPrBody("no placeholder", [], 180_000), /placeholder/);
});

test("master sampling recognizes only server timing jobs", () => {
  assert.equal(serverLane("ci / General tests (server (3/12))"), "general");
  assert.equal(serverLane("verify / Serialized tests (2/4)"), "serialized");
  // Admission-only master runs have no server jobs and are passed over.
  for (const name of ["Cloud candidate admission v1", "verify", "ci / General tests (ui (1/2))"]) assert.equal(serverLane(name), null);
});

test("refresh arguments keep explicit master run IDs and add dry-run, PR body and lane selection", () => {
  const options = parseArgs(["123", "--dry-run", "--pr-body=/tmp/body.md", "--lanes=e2e,runner"]);
  assert.deepEqual(options.runIds, ["123"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.prBody, "/tmp/body.md");
  assert.deepEqual([...options.lanes], ["e2e", "runner"]);
  assert.throws(() => parseArgs(["--lanes=ui"]), /Unknown lane/);
  assert.throws(() => parseArgs(["--force"]), /Unexpected argument/);
});

test("the refresh workflow may only commit the four timing manifests and uses the rendered PR body", () => {
  const workflow = readFileSync(".github/workflows/ci-test-durations.yml", "utf8");
  for (const file of ["scripts/general-server-shard-durations.json", "scripts/serialized-shard-durations.json",
    "scripts/e2e-shard-durations.json", "packages/paperclip-runner/scripts/vitest-lane-durations.json"]) {
    assert.ok(workflow.split(file).length >= 3, `${file} must be both allowed and staged`);
  }
  assert.match(workflow, /refresh-test-durations\.mjs "--pr-body=\$RUNNER_TEMP\/ci-duration-pr\.md"/);
  assert.match(workflow, /--body-file "\$RUNNER_TEMP\/ci-duration-pr\.md"/);
});

test("oversized-file reporters warn above the configurable budget and never throw", () => {
  assert.equal(oversizedThresholdMs({}), 180_000);
  assert.equal(oversizedThresholdMs({ PAPERCLIP_CI_OVERSIZED_TEST_FILE_SECONDS: "90" }), 90_000);
  for (const invalid of ["", "0", "-5", "soon"]) {
    assert.equal(oversizedThresholdMs({ PAPERCLIP_CI_OVERSIZED_TEST_FILE_SECONDS: invalid }), 180_000);
  }
  assert.match(oversizedAnnotation("a,b:c.test.ts", 200_000, 180_000),
    /^::warning file=a%2Cb%3Ac\.test\.ts,title=Oversized test file::a,b:c\.test\.ts took 200s, over the 180s per-file budget/);

  const lines = [];
  const reporter = new OversizedTestFileReporter({ environment: {}, write: line => lines.push(line), root: "/repo" });
  const module = (file, total, state = "passed") => ({ moduleId: `/repo/${file}`, state: () => state,
    diagnostic: () => ({ duration: total - 3, collectDuration: 1, setupDuration: 1, prepareDuration: 1, environmentSetupDuration: 0 }) });
  reporter.onTestModuleEnd(module("server/src/slow.test.ts", 180_001));
  reporter.onTestModuleEnd(module("server/src/failed-slow.test.ts", 200_000, "failed"));
  reporter.onTestModuleEnd(module("server/src/fast.test.ts", 180_000));
  reporter.onTestModuleEnd(module("server/src/skipped.test.ts", 900_000, "skipped"));
  reporter.onTestModuleEnd({ moduleId: "/repo/x", state: () => { throw new Error("broken"); } });
  assert.deepEqual(lines.map(line => /file=([^,]+)/.exec(line)[1]), ["server/src/slow.test.ts", "server/src/failed-slow.test.ts"]);

  lines.length = 0;
  const custom = new OversizedTestFileReporter({ environment: { PAPERCLIP_CI_OVERSIZED_TEST_FILE_SECONDS: "60" },
    write: line => lines.push(line), root: "/repo" });
  custom.onTestModuleEnd(module("server/src/medium.test.ts", 61_000));
  assert.equal(lines.length, 1);

  lines.length = 0;
  const playwright = new OversizedSpecReporter({ environment: {}, write: line => lines.push(line), root: "/repo" });
  assert.equal(playwright.printsToStdio(), false);
  const spec = file => ({ location: { file: `/repo/${file}` } });
  playwright.onTestEnd(spec("tests/e2e/long.spec.ts"), { status: "passed", duration: 100_000 });
  playwright.onTestEnd(spec("tests/e2e/long.spec.ts"), { status: "passed", duration: 90_000 });
  playwright.onTestEnd(spec("tests/e2e/long.spec.ts"), { status: "skipped", duration: 500_000 });
  playwright.onTestEnd(spec("tests/e2e/short.spec.ts"), { status: "passed", duration: 170_000 });
  playwright.onEnd();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^::warning file=tests\/e2e\/long\.spec\.ts,.*took 190s/);
});

test("CI test configs wire the oversized-file reporters for GitHub Actions", () => {
  assert.match(readFileSync("vitest.config.ts", "utf8"), /GITHUB_ACTIONS === "true"[\s\S]{0,120}oversized-test-files\.mjs/);
  assert.match(readFileSync("packages/paperclip-runner/vitest.config.ts", "utf8"), /GITHUB_ACTIONS === "true"[^\n]*oversized-test-files\.mjs/);
  assert.match(readFileSync("tests/e2e/playwright.config.ts", "utf8"), /GITHUB_ACTIONS === "true"[\s\S]{0,120}oversized-test-files-playwright\.mjs/);
});
