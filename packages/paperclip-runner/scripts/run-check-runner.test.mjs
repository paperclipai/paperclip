import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunnerCheckPlan,
  formatCargoCompilerDiagnostics,
  orderTestBinariesLpt,
  parseCargoTestArtifacts,
  REQUIRED_PARITY_TESTS,
  runWithConcurrency,
  verifyRequiredParityTests,
} from "./run-check-runner.mjs";

test("buildRunnerCheckPlan overlaps acpx-profiles, cargo fmt, and cargo test --release --no-run", () => {
  const plan = buildRunnerCheckPlan({ cpus: 8 });
  assert.equal(plan.binaryConcurrency, 6);
  assert.equal(plan.heavyTestThreads, 8);
  assert.equal(plan.defaultTestThreads, 4);
  const labels = plan.compilePhase.map((step) => step.label);
  assert.deepEqual(labels, ["check:acpx-profiles", "cargo:fmt", "cargo:test-no-run"]);
  const cargoStep = plan.compilePhase[2];
  assert.ok(cargoStep.args.includes("--release"));
  assert.ok(cargoStep.args.includes("--no-run"));
  assert.ok(cargoStep.args.includes("--message-format=json-render-diagnostics"));
  assert.ok(plan.docTestCommand.args.includes("--doc"));
  assert.deepEqual(plan.requiredParityTests, REQUIRED_PARITY_TESTS);
});

test("parseCargoTestArtifacts extracts unique test executables, manifest dirs, and CARGO_BIN_EXE_* map", () => {
  const jsonLines = [
    "warning: plain non-json line",
    JSON.stringify({
      reason: "compiler-artifact",
      manifest_path: "/repo/packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
      target: { name: "paperclip-runnerd", kind: ["bin"] },
      profile: { test: false },
      executable: "/repo/target/release/paperclip-runnerd",
    }),
    JSON.stringify({
      reason: "compiler-artifact",
      manifest_path: "/repo/packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
      target: { name: "paperclip_runner_core", kind: ["lib"] },
      profile: { test: true },
      executable: "/repo/target/release/deps/paperclip_runner_core-aaa",
    }),
    JSON.stringify({
      reason: "compiler-artifact",
      manifest_path: "/repo/packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
      target: { name: "codex_provider", kind: ["test"] },
      profile: { test: true },
      executable: "/repo/target/release/deps/codex_provider-bbb",
    }),
    JSON.stringify({
      reason: "compiler-artifact",
      manifest_path: "/repo/packages/paperclip-runner/runner/crates/runner-core/Cargo.toml",
      target: { name: "codex_provider", kind: ["test"] },
      profile: { test: true },
      executable: "/repo/target/release/deps/codex_provider-bbb",
    }),
    JSON.stringify({
      reason: "compiler-artifact",
      manifest_path: "/repo/packages/paperclip-runner/runner/crates/process-table/Cargo.toml",
      target: { name: "paperclip_process_table", kind: ["lib"] },
      profile: { test: true },
      executable: "/repo/target/release/deps/paperclip_process_table-ccc",
    }),
  ].join("\n");

  const { testBinaries, binEnv } = parseCargoTestArtifacts(jsonLines);
  assert.deepEqual(binEnv, {
    "CARGO_BIN_EXE_paperclip-runnerd": "/repo/target/release/paperclip-runnerd",
  });
  assert.equal(testBinaries.length, 3);
  assert.equal(testBinaries[0].label, "paperclip_runner_core (lib)");
  assert.equal(testBinaries[0].manifestDir, "/repo/packages/paperclip-runner/runner/crates/runner-core");
  assert.equal(testBinaries[2].manifestDir, "/repo/packages/paperclip-runner/runner/crates/process-table");
});

test("orderTestBinariesLpt puts slowest Rust test binaries first", () => {
  const ordered = orderTestBinariesLpt([
    { name: "oom_score", label: "oom_score" },
    { name: "acpx_park_preparation", label: "acpx_park_preparation" },
    { name: "codex_provider", label: "codex_provider" },
    { name: "acpx_sidecar_stopped_time", label: "acpx_sidecar_stopped_time" },
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.name),
    ["codex_provider", "acpx_sidecar_stopped_time", "acpx_park_preparation", "oom_score"],
  );
});

test("verifyRequiredParityTests matches exact and prefix-filtered passing tests and fails closed when missing", () => {
  const passing = [
    "test tests::runs_the_mock_core_path_with_stable_output ... ok",
    "test replay::tests::replay_fixture_parity_happy_path ... ok",
    "test replay::tests::replay_fixture_parity_failed_run ... ok",
  ].join("\n");
  assert.deepEqual(verifyRequiredParityTests(passing), []);

  const ignored = [
    "test tests::runs_the_mock_core_path_with_stable_output ... ignored",
    "test replay::tests::replay_fixture_parity_happy_path ... ok",
  ].join("\n");
  assert.deepEqual(verifyRequiredParityTests(ignored), ["runs_the_mock_core_path_with_stable_output"]);
  assert.deepEqual(verifyRequiredParityTests(""), REQUIRED_PARITY_TESTS);
});

test("runWithConcurrency bounds parallelism and preserves result ordering", async () => {
  let active = 0;
  let peak = 0;
  const results = await runWithConcurrency([10, 20, 30, 40, 50], 2, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return item * 2;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [20, 40, 60, 80, 100]);
});

test("formatCargoCompilerDiagnostics extracts rendered compiler messages and falls back to raw stdout", () => {
  const jsonLines = [
    JSON.stringify({ reason: "compiler-artifact", target: { name: "x" } }),
    JSON.stringify({ reason: "compiler-message", message: { rendered: "error[E0425]: cannot find value\n" } }),
  ].join("\n");
  assert.equal(formatCargoCompilerDiagnostics(jsonLines), "error[E0425]: cannot find value\n");
  assert.equal(formatCargoCompilerDiagnostics("plain cargo failure\n"), "plain cargo failure\n");
});
