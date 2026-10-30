import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { planTasks } from "../../.github/scripts/ci-plan.mjs";

const workflow = readFileSync(".github/workflows/pr-trusted.yml", "utf8");
const block = (job) => workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
const plan = planTasks({ config: JSON.parse(readFileSync("turbo.json", "utf8")),
  lanes: JSON.parse(readFileSync(".github/ci-task-matrix.json", "utf8")), paths: ["ui/src/pages/Inbox.tsx"] });
const evaluate = (expression, needs, cancelled = false) => vm.runInNewContext(expression, {
  needs, fromJSON: JSON.parse, toJSON: JSON.stringify, always: () => true, cancelled: () => cancelled,
});

test("failed, timed-out, skipped and unavailable selectors leave the original matrix runnable", () => {
  for (const result of ["failure", "cancelled", "skipped", "success"]) {
    const needs = { gate: { result: "success", outputs: { full_ci: "true", plan: JSON.stringify(plan) } },
      test_selection: { result, outputs: { plan: "" } } };
    const job = block("general_tests");
    const condition = job.match(/if: \$\{\{ (.*) \}\}/)[1];
    const matrix = job.match(/matrix: \$\{\{ (.*) \}\}/)[1];
    assert.equal(evaluate(condition, needs), true, result);
    assert.deepEqual(JSON.parse(JSON.stringify(evaluate(matrix, needs))), plan.jobs.general_tests.matrix);
    assert.equal(evaluate(condition, needs, true), false, "cancellation must not start more runners");
  }
});

test("a published selection controls the matrix and the required aggregate", () => {
  const selected = structuredClone(plan);
  selected.testSelection = { version: 1, hash: "test" };
  selected.jobs.general_tests.matrix.include = [selected.jobs.general_tests.matrix.include[0]];
  selected.jobs.general_tests.selected = 1;
  const needs = { gate: { result: "success", outputs: { full_ci: "true", plan: JSON.stringify(plan) } },
    test_selection: { result: "success", outputs: { plan: JSON.stringify(selected) } } };
  const matrix = block("general_tests").match(/matrix: \$\{\{ (.*) \}\}/)[1];
  assert.equal(evaluate(matrix, needs).include.length, 1);
  const aggregate = block("verify");
  const names = aggregate.match(/needs: \[([^\]]+)\]/)[1].split(", ");
  const code = aggregate.split("          node --input-type=module <<'NODE'\n")[1].split("\n          NODE")[0]
    .split("\n").map((line) => line.slice(10)).join("\n");
  const results = Object.fromEntries(names.map((name) => [name, { result:
    ["gate", "policy", "test_selection"].includes(name) || selected.jobs[name]?.run ? "success" : "skipped" }]));
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8",
    env: { ...process.env, FULL_CI: "true", CI_PLAN: JSON.stringify(selected), CI_RESULTS: JSON.stringify(results) } });
  assert.equal(run().status, 0);
  for (const job of ["general_tests", "test_selection"]) {
    for (const result of ["failure", "cancelled", "skipped"]) {
      results[job].result = result;
      assert.notEqual(run().status, 0, `${job}: ${result}`);
    }
    results[job].result = "success";
  }
  selected.jobs.general_tests.run = false;
  results.general_tests.result = "skipped";
  assert.equal(run().status, 0, "an explicitly empty selected lane may be skipped");
  assert.ok(aggregate.includes("needs.test_selection.outputs.plan || needs.gate.outputs.plan"));
});

test("publication follows successful upload and manifests are downloaded without ignoring failures", () => {
  const selection = block("test_selection");
  assert.ok(selection.indexOf("Upload validated selection") < selection.indexOf("Publish the executable plan"));
  assert.match(selection, /timeout-minutes: 5/);
  assert.match(selection, /vars.CI_VITEST_SELECTION == '' \|\| vars.CI_VITEST_SELECTION == 'enabled'/);
  for (const job of ["general_tests", "verify_serialized_server"]) {
    assert.match(block(job), /PAPERCLIP_CI_SELECTION_HASH:.*testSelection.hash/);
    assert.match(block(job), /Download selected test files\n        if: matrix.selection\n        uses: actions\/download-artifact@/);
    assert.doesNotMatch(block(job), /continue-on-error: true\n.*download-artifact/);
  }
});

test("failed-job retries use the original selector artifact, not the retry attempt", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-retry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(path.join(directory, ".ci-test-selection"));
  const output = path.join(directory, "output");
  const publication = block("test_selection").split("      - name: Publish the executable plan")[1];
  assert.match(publication, /ARTIFACT_ID: \$\{\{ steps.upload_selection.outputs.artifact-id \}\}/);
  const code = publication.split("          node --input-type=module <<'NODE'\n")[1].split("\n          NODE")[0]
    .split("\n").map((line) => line.slice(10)).join("\n");
  const selected = { ...plan, testSelection: { version: 1, hash: "test" } };
  const run = (value, artifactId) => {
    writeFileSync(path.join(directory, ".ci-test-selection/plan.json"), JSON.stringify(value));
    writeFileSync(output, "");
    return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      cwd: directory, encoding: "utf8", env: { ...process.env, ARTIFACT_ID: artifactId, GITHUB_OUTPUT: output },
    });
  };
  assert.equal(run(selected, "12345").status, 0);
  const savedPlan = readFileSync(output, "utf8").trim().slice("plan=".length);
  for (const job of ["general_tests", "verify_serialized_server"]) {
    const expression = block(job).match(/artifact-ids: \$\{\{ (.*) \}\}/)[1];
    assert.equal(vm.runInNewContext(expression, { fromJSON: JSON.parse, github: { run_attempt: 2 },
      needs: { test_selection: { outputs: { plan: savedPlan } } } }), "12345");
  }
  assert.notEqual(run(selected, "").status, 0, "a selection cannot be published without its uploaded artifact");
  assert.equal(run(plan, "").status, 0, "fallback plans need no selection artifact");
});
