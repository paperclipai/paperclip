import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { comparisonPaths, planTasks } from "../ci-plan.mjs";

const root = new URL("../../../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"));
const lanes = JSON.parse(readFileSync(new URL(".github/ci-task-matrix.json", root), "utf8"));
const plan = (paths, options = {}) => planTasks({ config, lanes, paths, ...options });
const selected = (result, job) => result.jobs[job].run;
const selectedTasks = (result) => new Set(Object.values(result.jobs).filter((job) => job.run)
  .flatMap((job) => job.matrix.include.map((entry) => entry.task)));

test("trusted workflow fallbacks preserve every declared partition and command", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  for (const [job, entries] of Object.entries(lanes)) {
    const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    assert.ok(block.includes(`fromJSON(needs.gate.outputs.plan).jobs.${job}.run`), job);
    if (!block.includes("      matrix:")) { assert.equal(entries.length, 1); continue; }
    const fallback = block.match(/matrix:.*\|\| '(.*)'\) \}\}/)?.[1];
    assert.ok(fallback, `${job}: missing full fallback`);
    assert.deepEqual(JSON.parse(fallback), { include: entries }, job);
  }
});

test("a UI component retains browser and build coverage without unrelated server/Rust jobs", () => {
  const result = plan(["ui/src/components/Sidebar.tsx"]);
  assert.equal(selected(result, "build"), true);
  assert.equal(selected(result, "e2e_shards"), true);
  assert.equal(selected(result, "verify_serialized_server"), false);
  assert.deepEqual([...selectedTasks(result)].filter((task) => /server|chat|runner/.test(task)), []);
  assert.equal(result.jobs.general_tests.selected, 2);
});

test("source inspected across package boundaries selects its consumers", () => {
  for (const file of ["ui/src/lib/issue-execution-policy.ts", "ui/src/index.css", "ui/src/pages/CompanyExport.tsx",
    "ui/src/components/MarkdownBody.tsx"]) {
    const tasks = selectedTasks(plan([file]));
    assert.ok(tasks.has("ci:server"), file);
    assert.ok(tasks.has("ci:runner-vitest"), file);
  }
  assert.ok(selectedTasks(plan(["ui/public/app-logos/example.svg"])).has("ci:workspaces-b"));
});

test("repository-wide guidance guards run uncached for every scanned UI file type", () => {
  const source = readFileSync(new URL("server/src/__tests__/cli-invocation-safety.test.ts", root), "utf8");
  const extensions = [...source.split("const SCAN_EXTENSIONS = new Set([")[1].split("]);")[0].matchAll(/"(\.[a-z]+)"/g)]
    .map((match) => match[1]);
  assert.ok(extensions.length > 0);
  for (const extension of extensions) {
    for (const folder of ["ui/src/components", "ui/src/pages", "ui/src/hooks", "ui/public"]) {
      assert.ok(plan([`${folder}/guidance${extension}`]).jobs.typecheck_release_registry.run);
    }
  }
  assert.equal(config.tasks["//#ci:typecheck"].cache, false);
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  const job = workflow.split("\n  typecheck_release_registry:\n")[1].split("\n  general_tests:\n")[0];
  assert.match(job, /- name: Verify repository-wide CLI guidance safety\n        run: pnpm exec vitest run --project @paperclipai\/server server\/src\/__tests__\/cli-invocation-safety.test.ts/);
  assert.ok(!job.includes("uses: ./.github/actions/run-ci-task"));
});

test("shared contracts, runtime prompts, protocol inputs and fixtures reach consumers", () => {
  const shared = selectedTasks(plan(["packages/shared/src/types/issue.ts"]));
  for (const task of ["ci:server", "ci:db", "ci:workspaces-a", "ci:workspaces-b", "ci:serialized", "ci:e2e"]) {
    assert.ok(shared.has(task), task);
  }
  assert.ok(selectedTasks(plan(["server/src/onboarding-assets/default/AGENTS.md"])).has("ci:runner-vitest"));
  assert.ok(selectedTasks(plan(["packages/paperclip-runner/protocol/schema.json"])).has("ci:runner-rust"));
  for (const file of ["tests/runner-e2e/fixtures/prompt.md", "scripts/run-vitest-stable.mjs", "pnpm-lock.yaml"]) {
    assert.ok(Object.values(plan([file]).jobs).every((job) => job.selected === job.total), file);
  }
});

test("renames out of source and deletions cannot masquerade as release notes", () => {
  const paths = comparisonPaths({ files: [
    { filename: "releases/v2026.1029.0.md", previous_filename: "packages/shared/src/constants.ts", status: "renamed" },
    { filename: "server/src/deleted.ts", status: "removed" },
  ] });
  assert.ok(selectedTasks(plan(paths)).has("ci:server"));
  assert.ok(selectedTasks(plan(paths)).has("ci:db"));
});

test("unclassified paths and uncertain comparisons select full verification", () => {
  for (const paths of [[], ["new-root/file.ts"], ["../escaped"]]) {
    const result = plan(paths);
    assert.ok(result.forceReason);
    assert.ok(Object.values(result.jobs).every((job) => job.selected === job.total));
  }
  for (const files of [null, [], [{ status: "modified" }], [{ filename: "a", status: "renamed" }],
    Array.from({ length: 300 }, () => ({ filename: "ui/src/test.ts" }))]) {
    assert.throws(() => comparisonPaths({ files }));
  }
});

test("shadow mode explains savings but runs every task; force overrides selection", () => {
  const shadow = plan(["ui/src/components/Sidebar.tsx"], { mode: "shadow" });
  assert.equal(shadow.jobs.verify_serialized_server.proposed, 0);
  assert.equal(shadow.jobs.verify_serialized_server.selected, 9);
  for (const options of [{ mode: "full" }, { forceReason: "Stack" }]) {
    assert.ok(Object.values(plan(["ui/src/components/Sidebar.tsx"], options).jobs)
      .every((job) => job.selected === job.total));
  }
});

test("cache-affecting definition changes force execution across successive PR pushes", () => {
  for (const file of ["turbo.json", "package.json", "packages/db/package.json", "scripts/ci/run-task.mjs",
    ".github/actions/run-ci-task/action.yml"]) {
    for (const paths of [[file], [file, "packages/db/src/schema/issues.ts"]]) {
      const result = plan(paths);
      assert.match(result.forceReason, /Global CI input changed/);
      assert.ok(Object.values(result.jobs).every((job) => job.selected === job.total));
    }
  }
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  assert.equal((workflow.match(/force:.*fromJSON\(needs.gate.outputs.plan\).forceReason != null/g) ?? []).length, 3);
  const action = readFileSync(new URL(".github/actions/run-ci-task/action.yml", root), "utf8");
  assert.match(action, /CI_FORCE_TASKS: \$\{\{ inputs.force \}\}/);
  assert.equal((action.match(/if:.*inputs.force != 'true'/g) ?? []).length, 2);
});

test("task dependencies propagate input changes and unsupported graph syntax fails closed", () => {
  const fixture = { globalDependencies: [], tasks: {
    "//#build": { inputs: ["lib/**"] }, "//#test": { inputs: ["app/**"], dependsOn: ["//#build"] },
  } };
  assert.equal(planTasks({ config: fixture, lanes: { tests: [{ task: "test" }] }, paths: ["lib/index.ts"] }).jobs.tests.run, true);
  fixture.tasks["//#build"].dependsOn = ["//#test"];
  assert.throws(() => planTasks({ config: fixture, lanes: { tests: [{ task: "test" }] }, paths: ["app/index.ts"] }), /Cyclic/);
  assert.throws(() => plan(["ui/src/a.ts"], { mode: "typo" }), /Invalid CI mode/);
});

test("local planner reads a real Git rename and handles a missing revision conservatively", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-plan-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q"); git("config", "user.name", "CI Test"); git("config", "user.email", "ci@example.invalid");
    mkdirSync(path.join(directory, "packages/shared/src"), { recursive: true });
    writeFileSync(path.join(directory, "packages/shared/src/input.ts"), "original\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(path.join(directory, "releases"));
    git("mv", "packages/shared/src/input.ts", "releases/v1.md"); git("commit", "-qm", "rename");
    for (const revision of [base, "missing-revision"]) {
      const result = spawnSync(process.execPath, [new URL("../ci-plan.mjs", import.meta.url).pathname, revision], {
        cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "",
          CI_TASK_CONFIG: new URL("turbo.json", root).pathname, CI_TASK_MATRIX: new URL(".github/ci-task-matrix.json", root).pathname },
      });
      assert.equal(result.status, 0, result.stderr);
      const resultPlan = JSON.parse(result.stdout);
      assert.ok(selectedTasks(resultPlan).has("ci:server"));
      if (revision !== base) assert.match(resultPlan.forceReason, /Diff unavailable/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("required aggregates reject omitted, failed and cancelled selected work", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  for (const id of ["verify", "e2e"]) {
    const block = workflow.split(`\n  ${id}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    const code = block.split("          node --input-type=module <<'NODE'\n")[1].split("\n          NODE")[0]
      .split("\n").map((line) => line.slice(10)).join("\n");
    const names = /needs: \[([^\]]+)\]/.exec(block)[1].split(", ");
    const resultPlan = plan(["ui/src/components/Sidebar.tsx"]);
    const results = Object.fromEntries(names.map((name) => [name, { result:
      name === "gate" || name === "policy" || resultPlan.jobs[name]?.run ? "success" : "skipped" }]));
    const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8",
      env: { ...process.env, FULL_CI: "true", CI_PLAN: JSON.stringify(resultPlan), CI_RESULTS: JSON.stringify(results) } });
    assert.equal(run().status, 0);
    for (const name of names) {
      const previous = results[name].result;
      for (const bad of previous === "success" ? ["failure", "cancelled", "skipped"] : ["success"]) {
        results[name].result = bad;
        assert.notEqual(run().status, 0, `${id}: ${name} must reject ${bad}`);
      }
      results[name].result = previous;
    }
  }
});

test("the real routing step uses pinned trusted definitions and defaults to full on fetch failure", () => {
  const workflow = readFileSync(new URL(".github/workflows/ci-routing.yml", root), "utf8");
  const block = workflow.split("      - name: Plan affected CI tasks from trusted definitions\n")[1];
  const shell = block.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(path.join(tmpdir(), "ci-routing-plan-"));
  try {
    const gh = path.join(directory, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const endpoint = process.argv.find(arg => arg.startsWith('/repos/'));
if (endpoint?.endsWith('/git/ref/heads/master')) console.log('a'.repeat(40));
else if (endpoint?.includes('/contents/')) {
  if (process.env.TEST_FETCH_FAILURE === 'true') process.exit(1);
  const [file, query] = endpoint.split('/contents/')[1].split('?');
  if (query !== 'ref=' + 'a'.repeat(40)) process.exit(2);
  process.stdout.write(fs.readFileSync(path.join(process.env.TEST_TRUSTED_ROOT, file)));
} else if (endpoint?.includes('/compare/')) console.log(JSON.stringify({ files: [{filename:'ui/src/components/Sidebar.tsx'}] }));
else process.exit(3);
`);
    chmodSync(gh, 0o755);
    for (const overrides of [{}, { TEST_FETCH_FAILURE: "true" }, { PROFILE_CI: "true" }, { STACK_JSON: "{}" }, { FULL_CI: "false" }]) {
      const output = path.join(directory, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_TRUSTED_ROOT: root.pathname,
        RUNNER_TEMP: directory, FULL_CI: "true", PROFILE_CI: "false", FORCE_FULL_CI: "false",
        CI_INCREMENTAL_MODE: "enabled", STACK_JSON: "null", EVENT_BASE_SHA: "b".repeat(40), EVENT_MERGE_SHA: "c".repeat(40),
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "", ...overrides,
      } });
      assert.equal(result.status, 0, result.stderr);
      const value = readFileSync(output, "utf8").trim();
      if (overrides.TEST_FETCH_FAILURE || overrides.FULL_CI === "false") assert.equal(value, "plan=");
      else {
        assert.notEqual(value, "plan=", `${JSON.stringify(overrides)}: ${result.stderr}`);
        const resultPlan = JSON.parse(value.slice("plan=".length));
        assert.equal(resultPlan.jobs.general_tests.selected, overrides.PROFILE_CI || overrides.STACK_JSON ? 19 : 2);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
