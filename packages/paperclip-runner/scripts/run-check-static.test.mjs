import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { API_AUTHORITY_VITEST_ARGS, planApiAuthority } from "./check-api-authority.mjs";
import { buildStaticCheckPlan, runCommand, stopActiveChildren } from "./run-check-static.mjs";
import { planPrepCommands, PREP_TEST_FILES } from "./run-prep-tests.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("PREP_TEST_FILES contains unique existing test files including Copilot suites", () => {
  assert.equal(new Set(PREP_TEST_FILES).size, PREP_TEST_FILES.length, "PREP_TEST_FILES must not duplicate entries");
  for (const file of PREP_TEST_FILES) {
    assert.ok(existsSync(resolve(packageRoot, file)), `missing prep test file: ${file}`);
  }
  assert.ok(PREP_TEST_FILES.includes("test/protocol-contract.test.mjs"));
  assert.ok(PREP_TEST_FILES.includes("scripts/qualify-copilot-acp.test.mjs"));
  assert.ok(PREP_TEST_FILES.includes("scripts/contracts/contract-fingerprints.test.mjs"));
  assert.ok(PREP_TEST_FILES.includes("scripts/run-check-static.test.mjs"));
});

test("planPrepCommands runs one parallel node-test invocation and honors --skip-build", () => {
  const full = planPrepCommands({ skipBuild: false });
  assert.equal(full.length, 3);
  assert.deepEqual(full[0].args, ["run", "ensure:eval-build-deps"]);
  assert.deepEqual(full[1].args, ["run", "build:rust"]);
  assert.equal(full[2].args[0], "../../scripts/ci-profile/node-test.mjs");
  assert.equal(full[2].args.length, 1 + PREP_TEST_FILES.length);

  const skipped = planPrepCommands({ skipBuild: true });
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].args[0], "../../scripts/ci-profile/node-test.mjs");
});

test("planApiAuthority targets the server Vitest project and enforces integration flag", () => {
  const full = planApiAuthority({ skipBuild: false });
  assert.equal(full.buildCommands.length, 2);
  assert.deepEqual(full.vitestCommand.args, API_AUTHORITY_VITEST_ARGS);
  assert.ok(full.vitestCommand.args.includes("--project"));
  assert.ok(full.vitestCommand.args.includes("@paperclipai/server"));
  assert.ok(full.vitestCommand.args.includes("server/src/services/native-runtime/runner-api.integration.test.ts"));
  assert.equal(full.vitestCommand.env.PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION, "1");

  const skipped = planApiAuthority({ skipBuild: true });
  assert.equal(skipped.buildCommands.length, 0);
});

test("buildStaticCheckPlan preserves every static check with race-free parallel phases", () => {
  const phases = buildStaticCheckPlan();
  assert.deepEqual(
    phases.map((phase) => phase.name),
    ["eval-kernel", "read-only-checks", "disjoint-builds", "stage-runner-binary", "heavy-test-suites"],
  );

  const allSteps = phases.flatMap((phase) =>
    phase.steps ?? phase.chains.flatMap((chain) => chain.steps),
  );
  const evalKernelSteps = allSteps.filter((step) => step.args.includes("@paperclipai/paperclip-eval-kernel"));
  assert.equal(evalKernelSteps.length, 1);

  const buildPhase = phases.find((phase) => phase.name === "disjoint-builds");
  assert.equal(buildPhase.mode, "parallel-chains");
  const rustChain = buildPhase.chains.find((chain) => chain.name === "rust-binaries");
  assert.equal(rustChain.steps.length, 2);
  assert.equal(rustChain.steps[0].label, "cargo:debug-bins");
  assert.equal(rustChain.steps[1].label, "cargo:release-runnerd");

  const tsChain = buildPhase.chains.find((chain) => chain.name === "typescript-and-replay-goldens");
  const tsLabels = tsChain.steps.map((step) => step.label);
  assert.ok(tsLabels.includes("tsc:tsconfig"));
  assert.ok(tsLabels.includes("tsc:surfaces"));
  assert.ok(tsLabels.includes("build:verified-entrypoints"));
  assert.ok(tsLabels.includes("install:copilot-assets"));
  assert.ok(tsLabels.includes("check:replay-goldens"));

  const testPhase = phases.find((phase) => phase.name === "heavy-test-suites");
  assert.equal(testPhase.mode, "parallel");
  assert.deepEqual(
    testPhase.steps.map((step) => step.args),
    [
      ["scripts/run-prep-tests.mjs", "--skip-build"],
      ["scripts/check-api-authority.mjs", "--skip-build"],
    ],
  );
});

test("stopActiveChildren terminates nested child process trees and settles buffered runCommand within graceMs", async (t) => {
  if (process.platform === "win32") return;
  const dir = mkdtempSync(join(tmpdir(), "run-check-static-tree-"));
  const pidFile = join(dir, "grandchild.pid");
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const script = `
    const { spawnSync } = require("node:child_process");
    const { writeFileSync } = require("node:fs");
    const inner = 'require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    spawnSync(process.execPath, ["-e", inner], { stdio: "inherit" });
  `;

  const commandPromise = runCommand(
    { label: "nested-tree", command: process.execPath, args: ["-e", script], cwd: packageRoot },
    { bufferOutput: true },
  );

  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(existsSync(pidFile), "grandchild process should start and write its pid");
  const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);

  const stopStart = Date.now();
  await stopActiveChildren("SIGTERM", { graceMs: 250, forceGraceMs: 500 });
  const result = await commandPromise;
  const elapsedMs = Date.now() - stopStart;

  assert.notEqual(result.code, 0);
  assert.ok(elapsedMs < 3_000, `expected bounded shutdown, took ${elapsedMs}ms`);

  let alive = true;
  for (let i = 0; i < 20; i += 1) {
    try {
      process.kill(grandchildPid, 0);
      await new Promise((r) => setTimeout(r, 25));
    } catch (error) {
      if (error?.code === "ESRCH") {
        alive = false;
        break;
      }
    }
  }
  assert.equal(alive, false, `grandchild process ${grandchildPid} should be terminated`);
});
