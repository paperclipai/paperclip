import assert from "node:assert/strict";
import test from "node:test";
import { buildRunnerBuildPlan } from "./run-build.mjs";
import { RELEASE_ARTIFACTS_VARIABLE } from "./build-runner-binary.mjs";

test("buildRunnerBuildPlan brackets with record-build-inputs and preserves every build check", () => {
  const phases = buildRunnerBuildPlan({ env: {} });
  assert.deepEqual(
    phases.map((phase) => phase.name),
    [
      "record-begin",
      "compile-dist-binary-and-pre-checks",
      "stage-dist-assets",
      "post-dist-checks",
      "record-finish",
    ],
  );
  assert.deepEqual(phases[0].steps[0].args, ["scripts/record-build-inputs.mjs", "--begin"]);
  assert.deepEqual(phases[4].steps[0].args, ["scripts/record-build-inputs.mjs", "--finish"]);

  const allLabels = phases.flatMap((phase) =>
    (phase.steps ?? phase.chains.flatMap((chain) => chain.steps)).map((step) => step.label),
  );
  for (const required of [
    "record-build-inputs:begin",
    "build:eval-kernel",
    "tsc:tsconfig",
    "tsc:surfaces",
    "cargo:release-runnerd",
    "check:protocol-manifest",
    "check:acpx-profiles",
    "check:antigravity-models",
    "check:protocol-schema-module",
    "check:acpx-sidecar-contract",
    "check:runtime-context-contract",
    "check:provider-failure-contract",
    "check:capability-contract",
    "check:capability-inventory",
    "build:verified-entrypoints",
    "install:copilot-assets",
    "build:runner-binary",
    "check:protocol-coverage",
    "check:semantic-contracts",
    "check:replay-goldens",
    "check:semantic-action-catalog",
    "check:runner-workflow-traceability",
    "record-build-inputs:finish",
  ]) {
    assert.ok(allLabels.includes(required), `missing build step: ${required}`);
  }

  const postDistLabels = phases
    .find((phase) => phase.name === "post-dist-checks")
    .steps.map((step) => step.label);
  for (const distCheck of [
    "check:protocol-coverage",
    "check:semantic-contracts",
    "check:replay-goldens",
    "check:semantic-action-catalog",
    "check:runner-workflow-traceability",
  ]) {
    assert.ok(postDistLabels.includes(distCheck), `expected ${distCheck} in post-dist-checks`);
  }
});

test("buildRunnerBuildPlan skips redundant cargo build when prebuilt release daemon directory is provided", () => {
  const phases = buildRunnerBuildPlan({
    env: { [RELEASE_ARTIFACTS_VARIABLE]: "/tmp/prebuilt-daemons" },
  });
  const compilePhase = phases.find((phase) => phase.name === "compile-dist-binary-and-pre-checks");
  assert.ok(!compilePhase.chains.some((chain) => chain.name === "cargo-release-runnerd"));
  const stagePhase = phases.find((phase) => phase.name === "stage-dist-assets");
  assert.ok(stagePhase.steps.some((step) => step.label === "build:runner-binary"));
});
