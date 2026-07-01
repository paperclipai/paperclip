import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/docker.yml", import.meta.url), "utf8");

function getDeployJobBlock() {
  const marker = "\n  deploy:\n";
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, "docker.yml must define a deploy job");
  return workflow.slice(start + marker.length);
}

test("Docker deploy job timeout exceeds Helm wait timeout", () => {
  const deployJob = getDeployJobBlock();
  const jobTimeoutMatch = deployJob.match(/^    timeout-minutes:\s*(\d+)\s*$/m);
  const helmTimeoutMatch = deployJob.match(/--wait --timeout\s+(\d+)m\b/);

  assert.ok(jobTimeoutMatch, "deploy job must declare timeout-minutes");
  assert.ok(helmTimeoutMatch, "deploy job must set helm upgrade --wait --timeout");

  const jobTimeoutMinutes = Number(jobTimeoutMatch[1]);
  const helmTimeoutMinutes = Number(helmTimeoutMatch[1]);

  assert.ok(
    jobTimeoutMinutes >= helmTimeoutMinutes + 5,
    `job timeout (${jobTimeoutMinutes}m) must leave cleanup margin after Helm timeout (${helmTimeoutMinutes}m)`,
  );
});
