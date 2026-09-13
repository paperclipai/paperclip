import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../workflows/docker-cloud.yml", import.meta.url), "utf8");
// Exercise the workflow's actual boolean expression. Its string comparisons and
// boolean operators have the same results in JS for these canonical contexts.
const expression = workflow.match(/^    runs-on: \$\{\{ (.+) \}\}$/m)?.[1];
assert.ok(expression, "cloud routing must remain an explicit job expression");
const timeoutExpression = workflow.match(/^    timeout-minutes: \$\{\{ (.+) \}\}$/m)?.[1];
assert.ok(timeoutExpression, "AWS jobs must finish before the Fleet instance lifetime");
const fleet = "runs-on/fleet=paperclip-cloud-build-x64/env=public-ci";
const base = { repository: "paperclipai/paperclip", repository_id: "1170821064", ref: "refs/heads/master", event_name: "push" };
for (const { name, github = {}, enabled = "true", expected = "ubuntu-latest" } of [
  { name: "canonical master push", expected: fleet },
  { name: "manual master build", github: { event_name: "workflow_dispatch" }, expected: fleet },
  { name: "disabled switch", enabled: "false" },
  { name: "missing switch", enabled: "" },
  { name: "invalid switch", enabled: "yes" },
  { name: "fork", github: { repository: "someone/paperclip", repository_id: "123" } },
  { name: "wrong repository identity", github: { repository_id: "123" } },
  { name: "pull request", github: { event_name: "pull_request", ref: "refs/pull/123/merge" } },
  { name: "privileged PR event", github: { event_name: "pull_request_target" } },
  { name: "release tag", github: { ref: "refs/tags/v2026.911.0" } },
  { name: "branch push", github: { ref: "refs/heads/feature" } },
  { name: "manual branch build", github: { event_name: "workflow_dispatch", ref: "refs/heads/feature" } },
  { name: "workflow completion event", github: { event_name: "workflow_run" } },
]) {
  test(`cloud runner routing: ${name}`, () => {
    const context = { github: { ...base, ...github }, vars: { AWS_CLOUD_BUILDS_ENABLED: enabled } };
    assert.equal(runInNewContext(expression, context), expected);
    assert.equal(runInNewContext(timeoutExpression, context), expected === fleet ? 40 : 60);
  });
}
