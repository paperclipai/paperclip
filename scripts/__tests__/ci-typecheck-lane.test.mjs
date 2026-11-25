import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { getPriority, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BACKGROUND_PRIORITY,
  BUILD_SERVER_EMIT_ONLY,
  computeResourceProfile,
  createReporter,
  planLane,
  PREPARE_RUNNER_VENDOR,
  resolveScope,
  runLane,
  selectBuildGapPackages,
  SERIAL_BUILD_GAPS,
  shouldRunReleaseRegistryTests,
  shouldRunRunnerRustTypecheck,
  typecheckUiIncremental,
} from "../ci-typecheck-lane.mjs";
import { PROJECTS, orderProjectsLpt, selectTestProjects } from "../typecheck-test-projects.mjs";

const plan = () =>
  planLane({
    buildGapPackages: ["paperclipai", "@paperclipai/paperclip-runner", "@paperclipai/ui"],
    testLayers: ["tests", "test-tree-0"],
  });

const quietReporter = (lines = []) => createReporter({ write: (text) => lines.push(text), github: false });
const node = (name, source, needs) => ({ name, command: process.execPath, args: ["-e", source], needs });

test("the shared outputs are written before dependent checks start, while emit-only server build overlaps", () => {
  const { prepare, tasks } = plan();
  const byName = new Map(tasks.map((task) => [task.name, task]));
  assert.ok(!prepare.some((task) => task.name === BUILD_SERVER_EMIT_ONLY));
  assert.ok(!prepare.some((task) => task.name === "check server runtime assets"));
  const build = byName.get(BUILD_SERVER_EMIT_ONLY);
  assert.deepEqual(build.env, {
    PAPERCLIP_TSC_EMIT_ONLY: "1",
    PAPERCLIP_RUNNER_VENDOR_REQUIRE_CURRENT: "1",
  });
  assert.deepEqual(build.needs, [PREPARE_RUNNER_VENDOR]);
  assert.equal(build.background, true);
  assert.deepEqual(byName.get("check server runtime assets").needs, [BUILD_SERVER_EMIT_ONLY]);
  assert.ok(prepare.some((task) => task.args.join(" ") === "scripts/typecheck-test-programs.mjs --prepare-only"));
  for (const name of SERIAL_BUILD_GAPS) {
    assert.ok(prepare.some((task) => task.name === `typecheck ${name}`), name);
    assert.ok(!tasks.some((task) => task.name === `typecheck ${name}`), name);
  }
  const runnerTypecheck = byName.get("typecheck @paperclipai/paperclip-runner");
  assert.ok(runnerTypecheck);
  assert.deepEqual(runnerTypecheck.needs, [PREPARE_RUNNER_VENDOR]);
  assert.equal(runnerTypecheck.background, true);
  assert.ok(!prepare.some((task) => task.name === "CLI guidance safety"));
  const guidance = byName.get("CLI guidance safety");
  assert.ok(guidance.args.includes("server/src/__tests__/cli-invocation-safety.test.ts"));
  assert.equal(guidance.needs, undefined);
  assert.equal(guidance.background, undefined);
  const programs = byName.get("typecheck test programs");
  assert.ok(programs.args.includes("--skip-prepare"));
  assert.deepEqual(programs.needs, [PREPARE_RUNNER_VENDOR]);
  for (const task of tasks) {
    assert.ok(!(task.args.includes("@paperclipai/server") && task.args.includes("typecheck")), task.name);
  }
});

test("every check of the sequential job is planned with exact DAG dependencies", () => {
  const { tasks } = plan();
  const byName = new Map(tasks.map((task) => [task.name, task]));
  assert.deepEqual(byName.get(PREPARE_RUNNER_VENDOR).args, ["--filter", "@paperclipai/server", "run", "prepare:runner-vendor"]);
  assert.equal(byName.get(PREPARE_RUNNER_VENDOR).needs, undefined);
  assert.deepEqual(byName.get("server declarations").args, [
    "server/scripts/typecheck-layers.mjs",
    "--declarations-only",
    "--checkers",
    "2",
  ]);
  assert.deepEqual(byName.get("server declarations").needs, [PREPARE_RUNNER_VENDOR]);
  for (const layer of ["tests", "test-tree-0"]) {
    const task = byName.get(`server layer ${layer}`);
    assert.deepEqual(task.args, ["server/scripts/typecheck-layers.mjs", "--layer", layer, "--checkers", "1"]);
    assert.deepEqual(task.needs, ["server declarations"]);
  }
  for (const project of PROJECTS) {
    const task = byName.get(`test project ${project}`);
    assert.deepEqual(task.args.slice(-2), ["--reuse-declarations", project]);
    assert.ok(task.args.includes("--checkers"));
    assert.deepEqual(task.needs, ["server declarations"]);
  }
  for (const name of ["paperclipai", "@paperclipai/ui"]) assert.ok(byName.has(`typecheck ${name}`), name);
  assert.deepEqual(byName.get("typecheck paperclipai").needs, [PREPARE_RUNNER_VENDOR]);
  assert.equal(byName.get("typecheck @paperclipai/ui").needs, undefined);
  assert.equal(byName.get("typecheck @paperclipai/ui").command, "node");
  assert.deepEqual(byName.get("typecheck @paperclipai/ui").args, ["scripts/ci-typecheck-lane.mjs", "--typecheck-ui"]);
  assert.deepEqual(byName.get("typecheck @paperclipai/ui").env, { GOMAXPROCS: "2" });
  assert.deepEqual(byName.get("release registry tests").args, ["run", "test:release-registry"]);
  assert.equal(byName.get("release registry tests").needs, undefined);
  assert.ok(byName.has("CLI guidance safety"));
  const declarationReaders = tasks.filter((task) => task.needs?.includes("server declarations"));
  assert.equal(declarationReaders.length, 2 + PROJECTS.length);
  assert.equal(declarationReaders[0].name, "test project tests/runner-e2e");
  assert.equal(declarationReaders[1].name, "server layer tests");
  assert.equal(declarationReaders[2].name, "server layer test-tree-0");
  // UI starts ahead of smaller build-gap packages so it overlaps with prepare runner vendor from t=0.
  assert.ok(
    tasks.findIndex((t) => t.name === "typecheck @paperclipai/ui") <
      tasks.findIndex((t) => t.name === "typecheck paperclipai"),
  );
});

test("computeResourceProfile scales concurrency, checkers, and UI GOMAXPROCS across 2/4/8-core runners", () => {
  const GiB = 1024 ** 3;
  assert.deepEqual(computeResourceProfile({ cpus: 2, totalMemoryBytes: 8 * GiB }), {
    laneConcurrency: 2,
    serverDeclCheckers: 1,
    serverLayerCheckers: 1,
    testProjectCheckers: 1,
    uiGomaxprocs: 1,
    testProgramsConcurrency: 1,
    testProgramsCheckers: 1,
  });
  assert.deepEqual(computeResourceProfile({ cpus: 4, totalMemoryBytes: 16 * GiB }), {
    laneConcurrency: 3,
    serverDeclCheckers: 2,
    serverLayerCheckers: 1,
    testProjectCheckers: 1,
    uiGomaxprocs: 2,
    testProgramsConcurrency: 3,
    testProgramsCheckers: 1,
  });
  // 8-core / 16 GiB (c8i.2xlarge): 4 concurrent tasks so all 4 server layers finish in 1 wave under 16 GiB.
  const c8i = computeResourceProfile({ cpus: 8, totalMemoryBytes: 16 * GiB });
  assert.deepEqual(c8i, {
    laneConcurrency: 4,
    serverDeclCheckers: 3,
    serverLayerCheckers: 1,
    testProjectCheckers: 1,
    uiGomaxprocs: 4,
    testProgramsConcurrency: 4,
    testProgramsCheckers: 1,
  });
  const m8i = computeResourceProfile({ cpus: 8, totalMemoryBytes: 32 * GiB });
  assert.deepEqual(m8i, {
    laneConcurrency: 8,
    serverDeclCheckers: 6,
    serverLayerCheckers: 2,
    testProjectCheckers: 2,
    uiGomaxprocs: 4,
    testProgramsConcurrency: 4,
    testProgramsCheckers: 2,
  });

  const { tasks } = planLane({
    buildGapPackages: ["@paperclipai/ui"],
    testLayers: ["tests"],
    resources: c8i,
  });
  const byName = new Map(tasks.map((t) => [t.name, t]));
  assert.deepEqual(byName.get("server declarations").args.slice(-2), ["--checkers", "3"]);
  assert.deepEqual(byName.get("typecheck @paperclipai/ui").env, { GOMAXPROCS: "4" });
  assert.ok(byName.get("typecheck test programs").args.join(" ").includes("--concurrency 4"));
});

test("resolveScope uses CI_PLAN in PR mode, honors PAPERCLIP_CI_FULL, and fails closed", () => {
  const validPlan = JSON.stringify({ version: 1, mode: "enabled", forceReason: null, changed: ["server/src/a.ts"] });
  assert.deepEqual(resolveScope({ root: "/repo", env: { CI_PLAN: validPlan } }), {
    mode: "pr",
    changedFiles: ["server/src/a.ts"],
    reason: "CI_PLAN",
  });
  assert.equal(
    resolveScope({ root: "/repo", env: { CI_PLAN: validPlan, PAPERCLIP_CI_FULL: "1" } }).mode,
    "full",
  );
  assert.equal(
    resolveScope({
      root: "/repo",
      env: { CI_PLAN: JSON.stringify({ mode: "full", forceReason: "Full CI requested", changed: ["server/src/a.ts"] }) },
    }).mode,
    "full",
  );
  assert.equal(
    resolveScope({
      root: "/repo",
      env: { CI_PLAN: JSON.stringify({ mode: "enabled", forceReason: "Diff unavailable: shallow", changed: [] }) },
    }).mode,
    "full",
  );
  assert.equal(resolveScope({ root: "/repo", env: { CI_PLAN: "{bad json" } }).mode, "full");
  assert.equal(resolveScope({ root: "/repo", env: {} }).mode, "full");

  // Git merge-parent fallback when CI_PLAN is unset
  const gitCalls = [];
  const merged = resolveScope({
    root: "/repo",
    env: { PAPERCLIP_CI_BASE_SHA: "abc123" },
    execGit: (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse") return "head2sha\n";
      return "server/src/x.ts\0ui/src/y.tsx\0";
    },
  });
  assert.deepEqual(merged, {
    mode: "pr",
    changedFiles: ["server/src/x.ts", "ui/src/y.tsx"],
    reason: "git diff HEAD^1 HEAD",
  });
  assert.equal(gitCalls[1].includes("HEAD^1"), true);
});

test("PR mode for a server-only change skips release registry, UI, runner, sandbox providers, and untouched test projects", () => {
  const { prepare, tasks } = planLane({
    buildGapPackages: [
      "paperclipai",
      "@paperclipai/paperclip-runner",
      "@paperclipai/ui",
      "@paperclipai/plugin-llm-wiki",
      "@paperclipai/plugin-authoring-smoke-example",
    ],
    testLayers: ["tests", "test-tree-0"],
    changedFiles: ["server/src/services/isolated-unreferenced-feature.ts", "server/src/__tests__/isolated-unreferenced-feature.test.ts"],
  });
  const prepareNames = prepare.map((task) => task.name);
  const taskNames = tasks.map((task) => task.name);

  assert.ok(!prepareNames.includes("build server without type checks"));
  assert.ok(!prepareNames.includes("CLI guidance safety"));
  assert.ok(taskNames.includes("CLI guidance safety"));
  assert.ok(!prepareNames.includes("install test program dependencies"));
  assert.ok(!prepareNames.includes("typecheck @paperclipai/paperclip-runner"));
  assert.ok(!taskNames.includes("typecheck @paperclipai/paperclip-runner"));

  assert.ok(taskNames.includes(PREPARE_RUNNER_VENDOR));
  assert.ok(taskNames.includes(BUILD_SERVER_EMIT_ONLY));
  assert.ok(taskNames.includes("check server runtime assets"));
  assert.ok(taskNames.includes("server declarations"));
  assert.ok(taskNames.includes("server layer tests"));
  assert.ok(taskNames.includes("typecheck paperclipai"));
  assert.ok(!taskNames.includes("release registry tests"));
  assert.ok(!taskNames.includes("typecheck test programs"));
  assert.ok(!taskNames.includes("typecheck @paperclipai/ui"));
  assert.ok(!taskNames.includes("typecheck @paperclipai/plugin-llm-wiki"));
  assert.ok(!taskNames.includes("typecheck @paperclipai/plugin-authoring-smoke-example"));
  for (const skipped of PROJECTS) {
    assert.ok(!taskNames.includes(`test project ${skipped}`), skipped);
  }
});

test("selectTestProjects follows the import graph so imported UI and server helpers trigger their callers", () => {
  for (const helper of [
    "ui/src/lib/company-routes.ts",
    "ui/src/lib/issue-reference.ts",
    "ui/src/lib/markdown-reply-content.ts",
  ]) {
    assert.deepEqual(selectTestProjects([helper]), ["tests/runner-e2e"], helper);
  }
  assert.deepEqual(selectTestProjects(["ui/src/components/Sidebar.tsx"]), []);
  assert.ok(selectTestProjects(["server/src/services/issues.ts"]).includes("tests/runner-e2e"));
  assert.ok(selectTestProjects(["server/src/services/issues.ts"]).includes("server/src/__tests__/helpers/maintenance"));
  assert.ok(selectTestProjects(["server/src/index.ts"]).includes("tests/e2e"));
  assert.ok(selectTestProjects(["packages/db/src/test-embedded-postgres.ts"]).includes("tests/e2e"));
  assert.ok(selectTestProjects(["tests/unknown-new-project/a.ts"], [...PROJECTS, "tests/unknown-new-project"]).includes("tests/unknown-new-project"));

  const uiHelperPlan = planLane({
    buildGapPackages: ["paperclipai", "@paperclipai/paperclip-runner", "@paperclipai/ui"],
    testLayers: ["tests"],
    changedFiles: ["ui/src/lib/company-routes.ts"],
  });
  assert.ok(uiHelperPlan.tasks.some((t) => t.name === "server declarations"));
  assert.ok(uiHelperPlan.tasks.some((t) => t.name === "test project tests/runner-e2e"));
  assert.ok(uiHelperPlan.tasks.some((t) => t.name === "typecheck @paperclipai/ui"));
});

test("PR mode for a pure UI component change skips server build/declarations, release registry, and sandbox providers", () => {
  const { prepare, tasks } = planLane({
    buildGapPackages: ["paperclipai", "@paperclipai/paperclip-runner", "@paperclipai/ui"],
    testLayers: ["tests", "test-tree-0"],
    changedFiles: ["ui/src/components/Sidebar.tsx", "ui/src/components/Sidebar.test.tsx"],
  });
  const prepareNames = prepare.map((task) => task.name);
  const taskNames = tasks.map((task) => task.name);

  assert.ok(!prepareNames.includes("CLI guidance safety"));
  assert.ok(taskNames.includes("CLI guidance safety"));
  assert.ok(!prepareNames.includes("build server without type checks"));
  assert.ok(!prepareNames.includes("install test program dependencies"));
  assert.ok(!taskNames.includes("server declarations"));
  assert.ok(!taskNames.includes("release registry tests"));
  assert.ok(!taskNames.includes("typecheck paperclipai"));
  assert.ok(taskNames.includes("typecheck @paperclipai/ui"));

  const programs = tasks.find((task) => task.name === "typecheck test programs");
  assert.ok(programs.args.includes("--no-providers"));
  assert.ok(programs.args.includes("--check-file"));
  assert.ok(programs.args.includes("ui/src/components/Sidebar.test.tsx"));
  assert.ok(programs.args.includes("tests/tsconfig.playwright.json"));
});

test("PR mode runs release registry tests for scripts, workflows, manifests, and release files", () => {
  assert.equal(shouldRunReleaseRegistryTests(["server/src/index.ts"]), false);
  assert.equal(shouldRunReleaseRegistryTests(["ui/src/pages/Issues.tsx"]), false);
  for (const trigger of [
    "scripts/release.sh",
    ".github/workflows/pr-trusted.yml",
    "package.json",
    "server/package.json",
    "releases/v2026.11.0.md",
    "Dockerfile",
  ]) {
    assert.equal(shouldRunReleaseRegistryTests([trigger]), true, trigger);
  }
});

test("PR mode fails closed for unknown build-gap packages and global typecheck inputs", () => {
  assert.deepEqual(selectBuildGapPackages(["@paperclipai/ui", "@paperclipai/new-pkg"], ["server/src/a.ts"]), [
    "@paperclipai/new-pkg",
  ]);
  assert.deepEqual(
    selectBuildGapPackages(["@paperclipai/ui"], ["packages/paperclip-runner/src/drivers/acpx/pi-extension-adapter.ts"]),
    ["@paperclipai/ui"],
  );
  const globalPlan = planLane({
    buildGapPackages: ["paperclipai", "@paperclipai/paperclip-runner", "@paperclipai/ui"],
    testLayers: ["tests"],
    changedFiles: ["tsconfig.base.json"],
  });
  assert.ok(globalPlan.prepare.some((t) => t.name === "install test program dependencies"));
  assert.ok(globalPlan.tasks.some((t) => t.name === "typecheck @paperclipai/paperclip-runner"));
  assert.ok(globalPlan.tasks.some((t) => t.name === "typecheck @paperclipai/ui"));
  assert.ok(globalPlan.tasks.some((t) => t.name === "test project tests/runner-e2e"));
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

test("PR mode skips Runner Rust typecheck when only shared TypeScript packages changed", () => {
  assert.equal(shouldRunRunnerRustTypecheck(null), true);
  assert.equal(shouldRunRunnerRustTypecheck(["packages/shared/src/customer-success.ts"]), false);
  assert.equal(shouldRunRunnerRustTypecheck(["packages/adapter-utils/src/types.ts"]), false);
  assert.equal(shouldRunRunnerRustTypecheck(["packages/paperclip-runner/runner/crates/runner-core/src/lib.rs"]), true);
  assert.equal(shouldRunRunnerRustTypecheck(["packages/paperclip-runner/acpx-profiles.json"]), true);
  assert.equal(shouldRunRunnerRustTypecheck(["rust-toolchain.toml"]), true);
  assert.equal(shouldRunRunnerRustTypecheck(["tsconfig.base.json"]), true);

  const sharedPr = planLane({
    buildGapPackages: ["@paperclipai/paperclip-runner"],
    testLayers: ["tests"],
    changedFiles: ["packages/shared/src/customer-success.ts"],
  });
  const runnerTask = sharedPr.tasks.find((t) => t.name === "typecheck @paperclipai/paperclip-runner");
  assert.deepEqual(runnerTask.args, ["--filter", "@paperclipai/paperclip-runner", "run", "typecheck:typescript"]);
  assert.deepEqual(runnerTask.needs, [PREPARE_RUNNER_VENDOR]);

  const runnerPr = planLane({
    buildGapPackages: ["@paperclipai/paperclip-runner"],
    testLayers: ["tests"],
    changedFiles: ["packages/paperclip-runner/protocol/schemas/result.schema.json"],
  });
  const runnerFullTask = runnerPr.tasks.find((t) => t.name === "typecheck @paperclipai/paperclip-runner");
  assert.deepEqual(runnerFullTask.args, ["--filter", "@paperclipai/paperclip-runner", "typecheck"]);
  assert.deepEqual(runnerFullTask.needs, [PREPARE_RUNNER_VENDOR]);
});

test("typecheckUiIncremental runs storybook catalog then incremental tsc with a portable tsBuildInfoFile", () => {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), "ui-typecheck-inc-"));
  try {
    const calls = [];
    const status = typecheckUiIncremental({
      root: tmpRoot,
      env: { GOMAXPROCS: "2" },
      spawnSyncImpl: (cmd, args, opts) => {
        calls.push({ kind: "spawn", cmd, args, cwd: opts.cwd });
        return { status: 0 };
      },
      runTscImpl: (args, opts) => {
        calls.push({ kind: "tsc", args, cwd: opts.cwd, env: opts.env });
        return { status: 0 };
      },
    });
    assert.equal(status, 0);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].kind, "spawn");
    assert.equal(calls[0].args[0], path.join(tmpRoot, "scripts", "storybook-catalog.mjs"));
    assert.equal(calls[0].cwd, path.join(tmpRoot, "ui"));
    assert.deepEqual(calls[1].args, [
      "-p",
      "tsconfig.json",
      "--incremental",
      "--tsBuildInfoFile",
      "node_modules/.cache/paperclip-ui.tsbuildinfo",
    ]);
    assert.equal(calls[1].cwd, path.join(tmpRoot, "ui"));
    assert.deepEqual(calls[1].env, { GOMAXPROCS: "2" });

    // Catalog failure stops before tsc.
    const failedCalls = [];
    const failStatus = typecheckUiIncremental({
      root: tmpRoot,
      spawnSyncImpl: () => ({ status: 3 }),
      runTscImpl: () => {
        failedCalls.push("tsc");
        return { status: 0 };
      },
    });
    assert.equal(failStatus, 3);
    assert.deepEqual(failedCalls, []);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("orderProjectsLpt schedules tests/runner-e2e first among test projects", () => {
  const ordered = orderProjectsLpt(PROJECTS);
  assert.equal(ordered[0], "tests/runner-e2e");
  assert.equal(ordered.length, PROJECTS.length);
});
