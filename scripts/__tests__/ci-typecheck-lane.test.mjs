import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPriority } from "node:os";
import test from "node:test";
import { BACKGROUND_PRIORITY, createReporter, planLane, runLane, SERIAL_BUILD_GAPS } from "../ci-typecheck-lane.mjs";
import { PROJECTS } from "../typecheck-test-projects.mjs";

const plan = () =>
  planLane({
    buildGapPackages: ["paperclipai", "@paperclipai/paperclip-runner", "@paperclipai/ui"],
    testLayers: ["tests", "test-tree-0"],
  });

const quietReporter = (lines = []) => createReporter({ write: (text) => lines.push(text), github: false });
const node = (name, source, needs) => ({ name, command: process.execPath, args: ["-e", source], needs });

test("the shared outputs are written before the parallel checks start", () => {
  const { prepare, tasks } = plan();
  const names = prepare.map((task) => task.name);
  const build = prepare.find((task) => task.args.includes("@paperclipai/server") && task.args.includes("build"));
  assert.deepEqual(build.env, { PAPERCLIP_TSC_EMIT_ONLY: "1" });
  assert.ok(names.indexOf("check server runtime assets") > names.indexOf(build.name));
  assert.ok(prepare.some((task) => task.args.join(" ") === "scripts/typecheck-test-programs.mjs --prepare-only"));
  for (const name of SERIAL_BUILD_GAPS) {
    assert.ok(prepare.some((task) => task.name === `typecheck ${name}`), name);
    assert.ok(!tasks.some((task) => task.name === `typecheck ${name}`), name);
  }
  const guidance = prepare.find((task) => task.name === "CLI guidance safety");
  assert.ok(guidance.args.includes("server/src/__tests__/cli-invocation-safety.test.ts"));
  assert.equal(guidance.background, undefined);
  const programs = tasks.find((task) => task.name === "typecheck test programs");
  assert.ok(programs.args.includes("--skip-prepare"));
  for (const task of tasks) {
    assert.ok(!(task.args.includes("@paperclipai/server") && task.args.includes("typecheck")), task.name);
  }
});

test("every check of the sequential job is planned, and only declaration readers wait", () => {
  const { tasks } = plan();
  const byName = new Map(tasks.map((task) => [task.name, task]));
  assert.deepEqual(byName.get("server declarations").args, ["server/scripts/typecheck-layers.mjs", "--declarations-only"]);
  for (const layer of ["tests", "test-tree-0"]) {
    const task = byName.get(`server layer ${layer}`);
    assert.deepEqual(task.args, ["server/scripts/typecheck-layers.mjs", "--layer", layer]);
    assert.deepEqual(task.needs, ["server declarations"]);
  }
  for (const project of PROJECTS) {
    const task = byName.get(`test project ${project}`);
    assert.deepEqual(task.args.slice(-2), ["--reuse-declarations", project]);
    assert.deepEqual(task.needs, ["server declarations"]);
  }
  for (const name of ["paperclipai", "@paperclipai/ui"]) assert.ok(byName.has(`typecheck ${name}`), name);
  assert.deepEqual(byName.get("release registry tests").args, ["run", "test:release-registry"]);
  assert.ok(!byName.has("CLI guidance safety"));
  const waiting = tasks.filter((task) => task.needs);
  assert.equal(waiting.length, 2 + PROJECTS.length);
  assert.deepEqual(
    tasks.filter((task) => !task.background).map((task) => task.name),
    ["server declarations", "release registry tests", ...waiting.map((task) => task.name)],
  );
});

test("checks run at most the given number at a time, in priority order", async () => {
  let running = 0;
  let peak = 0;
  const started = [];
  const runTask = async (task) => {
    started.push(task.name);
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return { status: 0, output: "", durationMs: 5 };
  };
  const tasks = ["a", "b", "c", "d", "e"].map((name) => ({ name, command: "x", args: [] }));
  const status = await runLane({ prepare: [], tasks, concurrency: 2, runTask, reporter: quietReporter() });
  assert.equal(status, 0);
  assert.equal(peak, 2);
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
});

test("a failed check fails the lane, skips its dependents and still runs the others", async () => {
  const lines = [];
  const status = await runLane({
    prepare: [],
    tasks: [
      node("declarations", "console.log('src/a.ts(1,1): error TS2322'); process.exit(2)"),
      node("dependent", "console.log('never')", ["declarations"]),
      node("independent", "console.error('independent stderr')"),
    ],
    concurrency: 1,
    reporter: quietReporter(lines),
  });
  const output = lines.join("");
  assert.equal(status, 2);
  assert.match(output, /FAILED in [\d.]+s with exit code 2: declarations[^\n]*\nsrc\/a\.ts\(1,1\): error TS2322\n=== end of declarations/);
  assert.match(output, /skipped: dependent, because declarations did not pass/);
  assert.doesNotMatch(output, /never/);
  assert.match(output, /independent stderr/);
  assert.match(output, /declarations\s+\S+\s+\S+\s+FAILED \(exit 2\)\n/);
  assert.match(output, /dependent\s+skipped\n/);
});

test("a failed preparation step stops the lane before any check", async () => {
  const ran = [];
  const status = await runLane({
    prepare: [{ name: "prepare", command: "x", args: [] }],
    tasks: [{ name: "check", command: "x", args: [] }],
    concurrency: 4,
    runPrepare: async () => ({ status: 7, durationMs: 1 }),
    runTask: async (task) => {
      ran.push(task.name);
      return { status: 0, output: "", durationMs: 1 };
    },
    reporter: quietReporter(),
  });
  assert.equal(status, 7);
  assert.deepEqual(ran, []);
});

test("passing checks are folded into GitHub log groups and failures are annotated", () => {
  const lines = [];
  const reporter = createReporter({ write: (text) => lines.push(text), github: true });
  const task = { name: "check", command: "tsc", args: ["-p", "a.json"] };
  reporter.taskEnd(task, { status: 0, output: "ok", durationMs: 1200 });
  reporter.taskEnd(task, { status: 2, output: "a.ts: error\n", durationMs: 1200 });
  const output = lines.join("");
  assert.match(output, /^::group::passed in 1\.2s: check: tsc -p a\.json\nok\n::endgroup::\n/);
  assert.match(output, /::error title=Typecheck lane::check failed with exit code 2\n\n=== FAILED in 1\.2s with exit code 2: check: tsc -p a\.json\na\.ts: error\n=== end of check\n/);
});

test("background checks run at a lower CPU priority than the critical path", { skip: process.platform === "win32" }, async () => {
  const lines = [];
  const report = "console.log('priority=' + require('node:os').getPriority())";
  await runLane({
    prepare: [],
    tasks: [node("critical", report), { ...node("filler", report), background: true }],
    concurrency: 2,
    reporter: quietReporter(lines),
  });
  const output = lines.join("");
  const own = getPriority();
  assert.match(output, new RegExp(`: critical: [^\\n]*\\npriority=${own}\\n`));
  assert.match(output, new RegExp(`: filler: [^\\n]*\\npriority=${Math.max(own, BACKGROUND_PRIORITY)}\\n`));
});

test("the PR typecheck job runs the lane after the Runner release crate restore", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/pr-trusted.yml", import.meta.url), "utf8");
  const job = workflow.split("\n  typecheck_release_registry:\n")[1].split("\n  general_tests:\n")[0];
  const lane = job.indexOf("run: node scripts/ci-typecheck-lane.mjs");
  assert.ok(lane > job.indexOf("- name: Mark the restored Runner release crate current"));
  const missingScript = "if: ${{ hashFiles('scripts/ci-typecheck-lane.mjs') == '' }}";
  const [beforeFallback, fallback] = job.split(missingScript);
  assert.ok(beforeFallback.includes("if: ${{ hashFiles('scripts/ci-typecheck-lane.mjs') != '' }}\n        run: node scripts/ci-typecheck-lane.mjs"));
  for (const command of ["typecheck:build-gaps", "typecheck-test-programs.mjs", "typecheck-test-projects.mjs", "test:release-registry"]) {
    assert.ok(!beforeFallback.includes(command), command);
    assert.ok(fallback.includes(command), command);
  }
});
