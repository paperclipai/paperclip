import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const trustedPrWorkflow = path.join(repoRoot, ".github", "workflows", "pr-trusted.yml");

const FULL_CI_SUCCESS_ENV = {
  FULL_CI: "true",
  POLICY_RESULT: "success",
  TYPECHECK_RELEASE_REGISTRY_RESULT: "success",
  GENERAL_TESTS_RESULT: "success",
  RUNNER_VERIFICATION_RESULT: "success",
  BUILD_RESULT: "success",
  DOCKER_CONTEXT_INTEGRITY_RESULT: "success",
  SERIALIZED_SERVER_RESULT: "success",
};

const FULL_CI_SKIPPED_ENV = {
  FULL_CI: "false",
  POLICY_RESULT: "success",
  TYPECHECK_RELEASE_REGISTRY_RESULT: "skipped",
  GENERAL_TESTS_RESULT: "skipped",
  RUNNER_VERIFICATION_RESULT: "skipped",
  BUILD_RESULT: "skipped",
  DOCKER_CONTEXT_INTEGRITY_RESULT: "skipped",
  SERIALIZED_SERVER_RESULT: "skipped",
};

function readWorkflowJobs(workflow) {
  const jobs = new Map();
  let current = null;
  for (const line of workflow.split("\n")) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = header[1];
      jobs.set(current, []);
      continue;
    }
    if (current && /^\S/.test(line)) current = null;
    if (current) jobs.get(current).push(line);
  }
  for (const [id, lines] of jobs) jobs.set(id, lines.join("\n"));
  return jobs;
}

function extractVerifyAggregator(verifyJob) {
  const match = verifyJob.match(/        run: \|\n([\s\S]*)$/);
  assert.ok(match, "verify aggregator must define a bash run script");
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function runAggregator(script, env) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("verify.needs includes verify_serialized_server", () => {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const verify = readWorkflowJobs(workflow).get("verify");
  assert.ok(verify, "pr-trusted.yml must define a verify job");
  assert.match(
    verify,
    /^ {4}needs: \[gate, policy, typecheck_release_registry, general_tests, verify_paperclip_runner, build, docker_context_integrity, verify_serialized_server\]$/m,
  );
  assert.match(verify, /SERIALIZED_SERVER_RESULT: \$\{\{ needs\.verify_serialized_server\.result \}\}/);
});

test("the verify aggregator rejects non-success serialized results under FULL_CI=true", () => {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const script = extractVerifyAggregator(readWorkflowJobs(workflow).get("verify"));

  for (const result of ["failure", "cancelled", "skipped", "unknown", ""]) {
    const run = runAggregator(script, {
      ...FULL_CI_SUCCESS_ENV,
      SERIALIZED_SERVER_RESULT: result,
    });
    assert.notEqual(
      run.status,
      0,
      `aggregator must reject serialized result ${JSON.stringify(result)} under FULL_CI=true`,
    );
  }

  const missing = { ...FULL_CI_SUCCESS_ENV };
  delete missing.SERIALIZED_SERVER_RESULT;
  const missingRun = runAggregator(script, missing);
  assert.notEqual(
    missingRun.status,
    0,
    "aggregator must reject a missing serialized result under FULL_CI=true",
  );
});

test("the verify aggregator accepts all-success FULL_CI=true and skipped FULL_CI=false", () => {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const script = extractVerifyAggregator(readWorkflowJobs(workflow).get("verify"));

  const success = runAggregator(script, FULL_CI_SUCCESS_ENV);
  assert.equal(success.status, 0, success.stderr || success.stdout);

  const skipped = runAggregator(script, FULL_CI_SKIPPED_ENV);
  assert.equal(skipped.status, 0, skipped.stderr || skipped.stdout);
});
