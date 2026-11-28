import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/pr-trusted.yml", import.meta.url), "utf8");
const jobsSection = workflow.slice(workflow.indexOf("\njobs:\n"));
const jobs = [...jobsSection.matchAll(/^  ([a-z_][a-z0-9_-]*):\n([\s\S]*?)(?=^  [a-z_][a-z0-9_-]*:\n|$(?![\s\S]))/gm)];
const pnpmJobs = jobs.filter(([, , body]) => body.includes("uses: pnpm/action-setup@"));
const totalPnpmSteps = workflow.match(/uses: pnpm\/action-setup@/g)?.length ?? 0;

test("every pnpm/action-setup step in pr-trusted.yml has no version input and runs after actions/checkout", () => {
  assert.ok(pnpmJobs.length > 0, "expected jobs configuring pnpm");
  assert.equal(totalPnpmSteps, pnpmJobs.length, "every pnpm/action-setup step must belong to an inspected job");

  for (const [, jobName, body] of pnpmJobs) {
    const checkoutIndex = body.indexOf("uses: actions/checkout@");
    const pnpmIndex = body.indexOf("uses: pnpm/action-setup@");
    assert.ok(
      checkoutIndex >= 0 && checkoutIndex < pnpmIndex,
      `${jobName}: pnpm/action-setup must run after actions/checkout so package.json is available`,
    );

    const steps = body.split(/\n {6}- /);
    const pnpmStep = steps.find((step) => step.includes("uses: pnpm/action-setup@"));
    assert.ok(pnpmStep, `${jobName}: must contain a pnpm/action-setup step`);
    assert.doesNotMatch(
      pnpmStep,
      /^\s*version:/m,
      `${jobName}: pnpm/action-setup must not specify a version input, letting packageManager in package.json govern`,
    );
  }
});
