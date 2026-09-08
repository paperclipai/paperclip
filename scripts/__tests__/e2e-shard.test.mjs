import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadShardDurations } from "../general-server-shard.mjs";
import { IGNORED_SPECS, listE2eSpecs, selectE2eShard } from "../e2e-shard.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = path.join(repoRoot, "scripts", "e2e-shard.mjs");
const durationsManifest = path.join(repoRoot, "scripts", "e2e-shard-durations.json");
const playwrightConfig = path.join(repoRoot, "tests", "e2e", "playwright.config.ts");
const prCallerWorkflow = path.join(repoRoot, ".github", "workflows", "pr.yml");
const trustedPrWorkflowPath = ".github/workflows/pr-trusted.yml";
const trustedPrWorkflow = path.join(repoRoot, trustedPrWorkflowPath);

const SHARD_COUNT = 3;

function runShard(args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `expected success for ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}

function readPinnedTrustedPrWorkflow() {
  const caller = readFileSync(prCallerWorkflow, "utf8");
  const pin = caller.match(
    /uses: paperclipai\/paperclip\/\.github\/workflows\/pr-trusted\.yml@([0-9a-f]{40})/,
  );
  assert.ok(pin, "pr.yml must call the trusted workflow at a full commit SHA");

  const result = spawnSync("git", ["show", `${pin[1]}:${trustedPrWorkflowPath}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `cannot read the pinned trusted workflow: ${result.stderr}`);
  return result.stdout;
}

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

function runStackScope(stack, prBaseRef) {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const match = workflow.match(
    /      - name: Select stacked PR CI scope[\s\S]*?        run: \|\n([\s\S]*?)\n\n  policy:/,
  );
  assert.ok(match, "trusted workflow must define the stacked PR scope script");
  const script = match[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
  const scratch = mkdtempSync(path.join(tmpdir(), "paperclip-stack-scope-"));
  const output = path.join(scratch, "github-output");

  try {
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        PR_BASE_REF: prBaseRef,
        STACK_JSON: JSON.stringify(stack),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(
      readFileSync(output, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test("the e2e shards form a complete, non-overlapping partition", () => {
  const specs = listE2eSpecs();
  assert.ok(specs.length > 0, "expected a non-empty e2e spec set");

  const shards = Array.from({ length: SHARD_COUNT }, (_, index) =>
    runShard(["--shard-index", String(index), "--shard-count", String(SHARD_COUNT)]),
  );

  const combined = shards.flat();
  assert.equal(combined.length, specs.length, "every spec must land on exactly one shard");
  assert.deepEqual([...combined].sort(), [...specs].sort());
  for (const shard of shards) {
    assert.ok(shard.length > 0, "no shard may be empty — Playwright fails a run with no matching specs");
  }
});

test("the ignored spec list matches playwright.config.ts testIgnore", () => {
  const config = readFileSync(playwrightConfig, "utf8");
  const match = config.match(/testIgnore:\s*\[([^\]]*)\]/);
  assert.ok(match, "expected a testIgnore array in playwright.config.ts");
  const configured = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...configured].sort(), [...IGNORED_SPECS].sort());
});

test("the duration manifest only names specs that still exist", () => {
  const durations = loadShardDurations(durationsManifest);
  assert.ok(Object.keys(durations).length > 0, "expected a populated duration manifest");
  const specs = new Set(listE2eSpecs());
  for (const file of Object.keys(durations)) {
    assert.ok(specs.has(file), `duration manifest names a spec that no longer runs: ${file}`);
  }
});

test("the weighted partition keeps the shards close to balanced", () => {
  const durations = loadShardDurations(durationsManifest);
  const specs = listE2eSpecs();
  const weights = Array.from({ length: SHARD_COUNT }, (_, index) =>
    selectE2eShard(specs, index, SHARD_COUNT, durations).reduce((sum, file) => sum + (durations[file] ?? 0), 0),
  );

  const heaviest = Math.max(...weights);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Round-robin/count-based sharding would strand the ~168s smoke-lab spec on
  // one runner alongside other specs. Assert the weighted split stays within
  // 15% of an even cut so a future spec-time regression surfaces here instead
  // of on the PR critical path. A single indivisible spec (smoke-lab) can
  // legitimately exceed the even cut on its own, so the bound is floored at
  // the largest per-spec weight — the best any file-level partition can do.
  const largestSpec = Math.max(...specs.map((file) => durations[file] ?? 0));
  const bound = Math.max((total / SHARD_COUNT) * 1.15, largestSpec);
  assert.ok(
    heaviest <= bound,
    `heaviest shard ${heaviest}ms exceeds the balance bound (${bound}ms)`,
  );
});

test("shard arguments are validated", () => {
  for (const args of [
    ["--shard-index", "2", "--shard-count", "2"],
    ["--shard-index", "-1", "--shard-count", "2"],
    ["--shard-index", "0", "--shard-count", "0"],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, encoding: "utf8" });
    assert.notEqual(result.status, 0, `expected failure for ${args.join(" ")}`);
  }
});

test("pr.yml calls the trusted PR workflow at an immutable SHA", () => {
  assert.ok(readPinnedTrustedPrWorkflow().length > 0);
});

test("the trusted PR workflow keeps a stable aggregate check named e2e over the shard matrix", () => {
  // Branch protection requires a check literally named `e2e`. The shards run
  // as `e2e shard (n/3)`, so the aggregate job below is what keeps the
  // required-check contract intact — same pattern as the `verify` aggregate.
  const workflow = readPinnedTrustedPrWorkflow();
  const jobs = readWorkflowJobs(workflow);

  const aggregate = jobs.get("e2e");
  assert.ok(aggregate, "pr-trusted.yml must define an `e2e` job to satisfy branch protection");
  assert.match(aggregate, /^ {4}name: e2e$/m, "the aggregate job must be named exactly `e2e`");
  assert.match(aggregate, /^ {4}if: \$\{\{ always\(\) \}\}$/m, "the aggregate must run even when a shard fails");
  assert.match(
    aggregate,
    /^ {4}needs: \[gate, (?:policy, )?e2e_shards\]$/m,
    "the aggregate must depend on the runner gate, optional policy gate, and shard matrix",
  );
  assert.match(
    aggregate,
    /test "\$E2E_SHARDS_RESULT" = "success"/,
    "the aggregate must fail unless every shard succeeded",
  );

  const shards = jobs.get("e2e_shards");
  assert.ok(shards, "pr-trusted.yml must define the `e2e_shards` matrix job");
  const matrixEntries = [
    ...shards.matchAll(
      /^ {10}- shard_index: (?<shardIndex>\d+)\n {12}shard_count: (?<shardCount>\d+)\n {12}shard_label: (?<shardLabel>\d+\/\d+)$/gm,
    ),
  ].map((match) => ({
    shardIndex: Number(match.groups.shardIndex),
    shardCount: Number(match.groups.shardCount),
    shardLabel: match.groups.shardLabel,
  }));

  assert.equal(matrixEntries.length, SHARD_COUNT, "the shard matrix must define exactly SHARD_COUNT entries");
  assert.deepEqual(
    matrixEntries.map((entry) => entry.shardIndex).sort((a, b) => a - b),
    Array.from({ length: SHARD_COUNT }, (_, index) => index),
    "the shard matrix must define each shard index exactly once",
  );
  for (const entry of matrixEntries) {
    assert.equal(entry.shardCount, SHARD_COUNT, "each shard matrix entry must use the same SHARD_COUNT");
    assert.equal(entry.shardLabel, `${entry.shardIndex + 1}/${SHARD_COUNT}`, "each shard label must match its index");
  }
});

test("the trusted PR workflow limits full CI to merge-relevant stack layers", () => {
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  const jobs = readWorkflowJobs(workflow);
  const gate = jobs.get("gate");

  assert.match(gate, /^ {6}full_ci: \$\{\{ steps\.scope\.outputs\.full_ci \}\}$/m);
  assert.match(gate, /STACK_JSON: \$\{\{ toJSON\(github\.event\.pull_request\.stack\) \}\}/);
  assert.match(gate, /stack_position == stack_size/);
  assert.match(gate, /"\$stack_base_ref" == "\$PR_BASE_REF"/);

  for (const jobId of [
    "typecheck_release_registry",
    "general_tests",
    "build",
    "verify_serialized_server",
    "canary_dry_run",
    "e2e_shards",
  ]) {
    assert.match(
      jobs.get(jobId),
      /^ {4}if: \$\{\{ needs\.gate\.outputs\.full_ci == 'true' \}\}$/m,
      `${jobId} must run only when the gate selects full CI`,
    );
  }

  assert.doesNotMatch(
    jobs.get("policy"),
    /needs\.gate\.outputs\.full_ci/,
    "the policy job must run on every PR layer",
  );

  const verify = jobs.get("verify");
  assert.match(
    verify,
    /^ {4}needs: \[gate, policy, typecheck_release_registry, general_tests, build, docker_context_integrity\]$/m,
  );
  assert.match(verify, /POLICY_RESULT: \$\{\{ needs\.policy\.result \}\}/);
  assert.match(verify, /test "\$TYPECHECK_RELEASE_REGISTRY_RESULT" = "skipped"/);
  assert.match(verify, /test "\$GENERAL_TESTS_RESULT" = "skipped"/);
  assert.match(verify, /test "\$BUILD_RESULT" = "skipped"/);
  // Both halves of the docker-context lane's gating: the result must be
  // wired into the aggregate's env AND asserted successful on full CI —
  // dropping either would let `verify` pass after the lane fails.
  assert.match(verify, /DOCKER_CONTEXT_INTEGRITY_RESULT: \$\{\{ needs\.docker_context_integrity\.result \}\}/);
  assert.match(verify, /test "\$DOCKER_CONTEXT_INTEGRITY_RESULT" = "success"/);
  assert.match(verify, /test "\$DOCKER_CONTEXT_INTEGRITY_RESULT" = "skipped"/);

  const e2e = jobs.get("e2e");
  assert.match(e2e, /^ {4}needs: \[gate, policy, e2e_shards\]$/m);
  assert.match(e2e, /POLICY_RESULT: \$\{\{ needs\.policy\.result \}\}/);
  assert.match(e2e, /false\) test "\$E2E_SHARDS_RESULT" = "skipped"/);
});

test("the stacked PR scope selector runs full CI only where intended", () => {
  assert.equal(runStackScope(null, "master").full_ci, "true");
  assert.equal(
    runStackScope({ position: 11, size: 11, base: { ref: "master" } }, "stack-10").full_ci,
    "true",
  );
  assert.equal(
    runStackScope({ position: 1, size: 11, base: { ref: "master" } }, "master").full_ci,
    "true",
  );
  assert.equal(
    runStackScope({ position: 6, size: 11, base: { ref: "master" } }, "stack-5").full_ci,
    "false",
  );
  assert.equal(
    runStackScope({ position: "invalid", size: 11, base: { ref: "master" } }, "stack-5").full_ci,
    "true",
  );
});

test("the trusted PR workflow passes the shard's spec filter to Playwright without a literal --", () => {
  // `pnpm run test:e2e -- $specs` forwards the literal separator to Playwright,
  // so the specs after it are not applied as file filters.
  const workflow = readPinnedTrustedPrWorkflow();
  assert.ok(
    !/pnpm run test:e2e --\s/.test(workflow),
    "pr-trusted.yml must not insert a literal `--` between `pnpm run test:e2e` and the spec filter",
  );
  assert.match(
    workflow,
    /pnpm run test:e2e \$specs/,
    "pr-trusted.yml e2e_shards must invoke `pnpm run test:e2e $specs`",
  );
});

test("the trusted PR workflow regenerates stale stacked lockfiles", () => {
  // Implementation PRs validate the workflow under development here. The
  // caller remains pinned to the last merged trusted SHA until a separate
  // activation PR advances it, so unmerged PR code never runs on trusted
  // infrastructure.
  const workflow = readFileSync(trustedPrWorkflow, "utf8");
  assert.match(
    workflow,
    /policy:\n    needs: \[gate\][\s\S]{0,160}timeout-minutes: 10/,
    "the unconditional resolution step needs the same timeout headroom as the lockfile refresh workflow",
  );
  assert.match(
    workflow,
    /- name: Setup Node\.js\n        uses: actions\/setup-node@[0-9a-f]+[^\n]*\n        with:\n          node-version: 24\n          cache: pnpm/,
    "the policy job must restore the pnpm cache before dependency resolution",
  );
  assert.match(
    workflow,
    /pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile/,
    "the policy job must resolve the complete merge tree without rewriting platform metadata",
  );
  assert.match(
    workflow,
    /cmp -s "\$RUNNER_TEMP\/pnpm-lock\.before\.yaml" pnpm-lock\.yaml/,
    "the policy job must upload a lockfile only when regeneration changed it",
  );

  const restoreSteps = workflow.match(
    /- name: Restore regenerated PR lockfile \(if policy uploaded one\)\n        if: needs\.policy\.outputs\.lockfile_regenerated == '1'/g,
  ) ?? [];
  assert.equal(restoreSteps.length, 6, "every downstream install job must restore a required regenerated artifact");
  assert.doesNotMatch(
    workflow,
    /- name: Restore regenerated PR lockfile \(if policy uploaded one\)[\s\S]{0,220}continue-on-error:/,
    "a missing artifact must fail after the policy job says it uploaded one",
  );
});
