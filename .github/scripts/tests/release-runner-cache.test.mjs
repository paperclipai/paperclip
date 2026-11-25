import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../workflows/release-verify.yml", import.meta.url), "utf8");
const runner = workflow.split("  verify_paperclip_runner:")[1].split("  build:")[0];

test("Runner dependency caching selects the package's pinned compiler before computing its key", () => {
  const select = runner.indexOf("      - name: Select the pinned Runner Rust toolchain");
  const cache = runner.indexOf("      - name: Cache Runner Rust dependencies");
  assert.ok(select >= 0 && cache > select);
  const setup = runner.slice(select, cache);
  assert.match(setup, /working-directory: packages\/paperclip-runner/);
  assert.match(setup, /rustup show active-toolchain/);
  assert.match(setup, /echo "RUSTUP_TOOLCHAIN=\$toolchain" >> "\$GITHUB_ENV"/);
  assert.match(runner, /uses: Swatinem\/rust-cache@[0-9a-f]{40} # v[0-9.]+/);
  // The target path feeds the entry's version hash, so it must not resolve
  // under the checkout, whose root differs between the fleet and GitHub-hosted
  // runners. The pin step publishes a $HOME-anchored path to the same directory.
  const pin = runner.indexOf("      - name: Pin the Runner Rust workspace path");
  assert.ok(pin >= 0 && cache > pin, "the workspace path must be pinned before the cache step");
  assert.match(runner, /workspaces: \$\{\{ steps\.runner_rust_workspace\.outputs\.path \}\} -> target/);
  assert.match(runner, /shared-key: release-runner-v2/);
});

test("the shared cache excludes workspace artifacts and only restores or saves the exact master-push source", () => {
  assert.match(runner, /cache-workspace-crates: false/);
  assert.match(runner, /cache-bin: false/);
  const saveIf = runner.match(/^\s*save-if: (.+)$/m)?.[1];
  assert.equal(saveIf, "${{ matrix.lane == 'rust' && github.repository == 'paperclipai/paperclip' && github.event_name == 'push' && github.ref == 'refs/heads/master' && inputs.ref == github.sha }}");
  const cacheStep = runner.split("      - name: Cache Runner Rust dependencies")[1].split("      - name: Install dependencies")[0];
  assert.equal(cacheStep.match(/^\s*if: (.+)$/m)?.[1], saveIf.replace("matrix.lane == 'rust' && ", ""));
  assert.doesNotMatch(runner, /cache-on-failure: true|cache-all-crates: true/);
});

test("parallel lanes cover check:all exactly once and never bypass verification", () => {
  const scripts = JSON.parse(readFileSync(new URL("../../../packages/paperclip-runner/package.json", import.meta.url))).scripts;
  const matrixBlock = runner.split("      matrix:\n        include:\n")[1].split("\n    steps:")[0];
  const matrixEntries = matrixBlock.split(/^          - /m).slice(1).map((entry) => {
    const row = { lane: "", checks: "", vitest_lane: "" };
    for (const line of entry.trim().split("\n")) {
      const match = /^\s*(lane|checks|vitest_lane):\s*(.+?)\s*$/.exec(line);
      assert.ok(match, `unexpected matrix field line: ${line}`);
      row[match[1]] = match[2];
    }
    return row;
  });
  const checks = matrixEntries.filter((row) => row.checks).flatMap((row) => row.checks.split(" "));
  assert.deepEqual(checks, scripts["check:all-without-vitest"].split(" && ").map((command) => command.replace(/^pnpm run /, "")));
  assert.deepEqual(matrixEntries.map((row) => row.lane), ["protocol-static", "protocol (1/4)", "protocol (2/4)", "protocol (3/4)", "protocol (4/4)", "rust", "api-authority", "server-integration"]);
  assert.deepEqual(matrixEntries.filter((row) => row.vitest_lane).map((row) => row.vitest_lane), ["1/4", "2/4", "3/4", "4/4"]);
  assert.match(runner, /fail-fast: false/);
  assert.doesNotMatch(runner, /max-parallel: 1|^    needs:|continue-on-error:/m);
  const verify = runner.split("      - name: Verify Paperclip Runner\n")[1].split("      - name:")[0];
  assert.match(verify, /RUNNER_CHECKS: \$\{\{ matrix.checks \}\}/);
  assert.match(verify, /set -euo pipefail/);
  assert.match(verify, /for check in \$RUNNER_CHECKS; do\s+pnpm --filter @paperclipai\/paperclip-runner "\$check"\s+done/);
  const verifyIf = verify.match(/^\s*if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.equal(verifyIf, "matrix.lane != 'server-integration' && matrix.vitest_lane == ''");
  const vitestStep = runner.split("      - name: Run Paperclip Runner package Vitest lane\n")[1].split("      - name:")[0];
  assert.match(vitestStep, /RUNNER_VITEST_LANE: \$\{\{ matrix.vitest_lane \}\}/);
  assert.match(vitestStep, /pnpm --filter @paperclipai\/paperclip-runner test:typescript:vitest "--package-lane=\$RUNNER_VITEST_LANE"/);
  const vitestIf = vitestStep.match(/^\s*if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.equal(vitestIf, "matrix.vitest_lane != ''");
  const serverStep = runner.split("      - name: Run native server integration suites\n")[1].split("      - name:")[0];
  const serverIf = serverStep.match(/^\s*if: \$\{\{ (.+) \}\}$/m)?.[1];
  for (const matrix of matrixEntries) {
    const runsVerify = runInNewContext(verifyIf, { matrix });
    const runsVitest = runInNewContext(vitestIf, { matrix });
    const runsServer = runInNewContext(serverIf, { matrix });
    assert.equal([runsVerify, runsVitest, runsServer].filter(Boolean).length, 1, `lane ${matrix.lane} must match exactly one verification step`);
    assert.equal(Boolean(matrix.checks), runsVerify, `lane ${matrix.lane} checks field must match Verify Paperclip Runner condition`);
    assert.equal(Boolean(matrix.vitest_lane), runsVitest, `lane ${matrix.lane} vitest_lane field must match Vitest lane condition`);
  }
  assert.doesNotMatch(verify, /cache-hit/);
  assert.doesNotMatch(vitestStep, /cache-hit/);
  assert.doesNotMatch(runner, /id-token: write|packages: write|secrets: inherit/);
});

test("only the trusted Rust lane writes, and warms both build profiles before saving", () => {
  const cache = runner.split("      - name: Cache Runner Rust dependencies")[1].split("      - name: Install dependencies")[0];
  const warm = runner.split("      - name: Warm debug dependencies for the shared Runner cache")[1];
  const expr = (body, field) => body.match(new RegExp(`^ +${field}: \\$\\{\\{ (.+) \\}\\}$`, "m"))[1];
  assert.equal(expr(cache, "save-if"), expr(warm, "if"));
  assert.match(warm, /run: pnpm --filter @paperclipai\/paperclip-runner build:rust/);
  const sha = "a".repeat(40);
  const base = { repository: "paperclipai/paperclip", event_name: "push", ref: "refs/heads/master", sha };
  for (const lane of ["protocol-static", "protocol (1/4)", "protocol (2/4)", "protocol (3/4)", "protocol (4/4)", "rust", "api-authority", "server-integration"]) {
    for (const [overrides, ref, trusted] of [
      [{}, sha, true],
      [{ event_name: "pull_request", ref: "refs/pull/1/merge" }, sha, false],
      [{ event_name: "pull_request_target" }, sha, false],
      [{ event_name: "workflow_dispatch" }, sha, false],
      [{ repository: "someone/paperclip" }, sha, false],
      [{ ref: "refs/heads/feature" }, sha, false],
      [{}, "b".repeat(40), false],
    ]) {
      const context = { matrix: { lane }, github: { ...base, ...overrides }, inputs: { ref } };
      assert.equal(runInNewContext(expr(cache, "if"), context), trusted);
      assert.equal(runInNewContext(expr(cache, "save-if"), context), trusted && lane === "rust");
    }
  }
});
