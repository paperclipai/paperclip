import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { compactHostedEntries, comparisonPaths, HOSTED_SHARD_COUNTS, planSummary, planTasks } from "../ci-plan.mjs";
import { mergeDiff } from "../ci-diff.mjs";
import { planLane } from "../../../scripts/ci-typecheck-lane.mjs";

const root = new URL("../../../", import.meta.url);
const config = JSON.parse(readFileSync(new URL("turbo.json", root), "utf8"));
const lanes = JSON.parse(readFileSync(new URL(".github/ci-task-matrix.json", root), "utf8"));
const plan = (paths, options = {}) => planTasks({ config, lanes, paths, ...options });
const selected = (result, job) => result.jobs[job].run;
const selectedTasks = (result) => new Set(Object.values(result.jobs).filter((job) => job.run)
  .flatMap((job) => job.matrix.include.map((entry) => entry.task)));

test("trusted workflow fallbacks preserve every declared partition and command for both AWS and hosted runners", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  const fullPlan = plan(["package.json"], { forceReason: "Full suite requested by label" });
  const legacyPlan = structuredClone(fullPlan);
  for (const lane of Object.values(legacyPlan.jobs)) delete lane.hosted_matrix;
  const awsRunner = "runs-on/fleet=paperclip-public-pr-x64/env=public-ci";
  const evalMatrix = (expression, { runner, planJson }) => vm.runInNewContext(expression, {
    fromJSON: JSON.parse,
    toJSON: JSON.stringify,
    needs: { gate: { outputs: { runner, plan: planJson } }, test_selection: { outputs: { plan: "" } } },
  });
  for (const [job, entries] of Object.entries(lanes)) {
    const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    const normalized = block.replaceAll("(needs.test_selection.outputs.plan || needs.gate.outputs.plan)", "needs.gate.outputs.plan");
    assert.ok(normalized.includes(`fromJSON(needs.gate.outputs.plan).jobs.${job}.run`), job);
    if (!block.includes("      matrix:")) { assert.equal(entries.length, 1); continue; }
    const expression = block.match(/      matrix: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.ok(expression, `${job}: missing matrix expression`);
    const expectedAws = { include: entries };
    const expectedHosted = { include: compactHostedEntries(entries) };
    assert.deepEqual(evalMatrix(expression, { runner: awsRunner, planJson: "" }), expectedAws, `${job} aws fallback`);
    assert.deepEqual(evalMatrix(expression, { runner: "ubuntu-latest", planJson: "" }), expectedHosted, `${job} hosted fallback`);
    assert.deepEqual(evalMatrix(expression, { runner: awsRunner, planJson: JSON.stringify(fullPlan) }), fullPlan.jobs[job].matrix, `${job} aws plan`);
    assert.deepEqual(evalMatrix(expression, { runner: "ubuntu-latest", planJson: JSON.stringify(fullPlan) }), fullPlan.jobs[job].hosted_matrix, `${job} hosted plan`);
    assert.deepEqual(evalMatrix(expression, { runner: "ubuntu-latest", planJson: JSON.stringify(legacyPlan) }), legacyPlan.jobs[job].matrix, `${job} legacy plan compat`);
  }
});

test("compactHostedEntries halves ubuntu-latest fan-out while preserving 100% of tasks, groups, and contiguous shard coverage", () => {
  const full = plan(["package.json"], { forceReason: "Full suite requested by label" });
  const awsJobs = Object.values(full.jobs).reduce((sum, lane) => sum + lane.total, 0);
  const hostedJobs = Object.values(full.jobs).reduce((sum, lane) => sum + (lane.hosted_total ?? lane.total), 0);
  assert.equal(awsJobs, 72);
  assert.equal(hostedJobs, 33);
  assert.ok(Buffer.byteLength(JSON.stringify(full)) < 32_768, "dual-profile plan stays compact for GITHUB_OUTPUT/env");

  for (const [job, lane] of Object.entries(full.jobs)) {
    if (!lane.hosted_matrix) continue;
    const awsEntries = lane.matrix.include;
    const hostedEntries = lane.hosted_matrix.include;
    assert.ok(hostedEntries.length < awsEntries.length, `${job} should compact on hosted`);
    const partitionKey = (entry) => `${entry.task}::${entry.group ?? ""}`;
    assert.deepEqual(
      [...new Set(hostedEntries.map(partitionKey))],
      [...new Set(awsEntries.map(partitionKey))],
      `${job} must preserve every task and group`,
    );
    const byPartition = new Map();
    for (const entry of hostedEntries) {
      const key = partitionKey(entry);
      if (!byPartition.has(key)) byPartition.set(key, []);
      byPartition.get(key).push(entry);
    }
    for (const [key, groupEntries] of byPartition) {
      if (groupEntries[0].shard_count !== undefined) {
        assert.deepEqual(
          groupEntries.map((e) => [e.shard_index, e.shard_count]),
          groupEntries.map((_, i) => [i, groupEntries.length]),
          `${job}/${key} must have contiguous shard indices`,
        );
      } else if (typeof groupEntries[0].command === "string" && groupEntries[0].command.includes("--package-lane=")) {
        assert.deepEqual(
          groupEntries.map((e) => e.command.match(/--package-lane=(\d+\/\d+)/)?.[1]),
          groupEntries.map((_, i) => `${i + 1}/${groupEntries.length}`),
          `${job}/${key} must have contiguous package lanes`,
        );
      }
    }
  }

  const uiPr = plan(["ui/src/components/Sidebar.tsx"]);
  assert.equal(uiPr.jobs.general_tests.selected, 2);
  assert.equal(uiPr.jobs.general_tests.hosted_selected, 1);
  assert.deepEqual(uiPr.jobs.general_tests.hosted_matrix.include, [
    { group: "general-workspaces-a", group_label: "workspaces-a (1/1)", shard_index: 0, shard_count: 1, task: "ci:workspaces-a" },
  ]);
  assert.equal(uiPr.jobs.e2e_shards.selected, 16);
  assert.equal(uiPr.jobs.e2e_shards.hosted_selected, 4);

  const futureEntries = Array.from({ length: 10 }, (_, shard_index) => ({
    task: "ci:future", shard_index, shard_count: 10, shard_label: `${shard_index + 1}/10`,
  }));
  const futureCompact = compactHostedEntries(futureEntries, HOSTED_SHARD_COUNTS);
  assert.equal(futureCompact.length, 5);
  assert.equal(futureCompact[4].shard_label, "5/5");

  const summary = planSummary(full);
  assert.match(summary, /28\/28 \(hosted: 12\/12\)/);
  assert.match(summary, /16\/16 \(hosted: 4\/4\)/);
});

test("a UI component retains browser and build coverage without unrelated server/Rust jobs", () => {
  const result = plan(["ui/src/components/Sidebar.tsx"]);
  assert.equal(selected(result, "build"), true);
  assert.equal(selected(result, "e2e_shards"), true);
  assert.equal(selected(result, "verify_serialized_server"), false);
  assert.equal(selected(result, "canary_dry_run"), false);
  assert.equal(selected(result, "verify_runner_e2e_support"), false);
  assert.equal(selected(result, "docker_context_integrity"), false);
  assert.deepEqual([...selectedTasks(result)].filter((task) => /server|chat|runner/.test(task)), []);
  assert.equal(result.jobs.general_tests.selected, 2);
});

test("ordinary app PRs skip canary dry run, runner support, docker context and runner package lanes", () => {
  const serverRoute = plan(["server/src/routes/issues.ts"]);
  const tasks = selectedTasks(serverRoute);
  for (const required of ["ci:server", "ci:chat", "ci:serialized", "ci:build", "ci:typecheck", "ci:e2e", "ci:workspaces-b", "ci:runner-static", "ci:runner-vitest"]) {
    assert.ok(tasks.has(required), `expected ${required}`);
  }
  for (const skipped of ["ci:canary", "ci:runner-e2e-support", "ci:docker", "ci:workspaces-a", "ci:db", "ci:runner-package", "ci:runner-rust", "ci:sandbox-providers"]) {
    assert.ok(!tasks.has(skipped), `unexpected ${skipped}`);
  }
  // Feature PR adding a table, route, and UI page still skips non-PR release/runner bloat.
  const featurePr = plan(["packages/db/src/schema/issues.ts", "server/src/routes/issues.ts", "ui/src/pages/Issues.tsx"]);
  assert.equal(selected(featurePr, "canary_dry_run"), false);
  assert.equal(selected(featurePr, "verify_runner_e2e_support"), false);
  assert.equal(selected(featurePr, "docker_context_integrity"), false);
  assert.equal(selectedTasks(featurePr).has("ci:chat"), true);
  assert.equal(selectedTasks(featurePr).has("ci:runner-package"), false);
  assert.equal(selectedTasks(featurePr).has("ci:db"), true);
  assert.equal(selectedTasks(featurePr).has("ci:workspaces-a"), true);
});

test("canary dry run, runner support, chat, docker and test-only edits select their exact owners", () => {
  for (const file of ["scripts/release.sh", "scripts/release-lib.sh", "scripts/release-package-manifest.json",
    "scripts/release-package-map.mjs", "scripts/build-npm.sh", "scripts/build-standalone-public-packages.mjs",
    "scripts/cli-bundled-npm-dependencies.mjs", "scripts/link-plugin-dev-sdk.mjs", "scripts/prefetch-child.mjs",
    "scripts/stage-bundled-packages.mjs", "scripts/pack-staged-packages.mjs",
    "scripts/prepare-bundled-package.mjs", "scripts/prepare-server-ui-dist.sh",
    "scripts/generate-npm-package-json.mjs", "scripts/prepare-npm-readme.mjs"]) {
    assert.equal(selected(plan([file]), "canary_dry_run"), true, `canary: ${file}`);
  }
  const canaryQueue = ["scripts/release.sh", "scripts/build-npm.sh"];
  const canarySeen = new Set(canaryQueue);
  while (canaryQueue.length) {
    const entry = canaryQueue.shift();
    const content = readFileSync(new URL(entry, root), "utf8");
    for (const [, rawTarget] of content.matchAll(/(?:^|[^a-zA-Z0-9._/-])((?:\.\.?\/|scripts\/)[a-zA-Z0-9._/-]+\.(?:sh|mjs|js|json))/g)) {
      const target = rawTarget.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(entry), rawTarget)) : rawTarget;
      if (!target.startsWith("scripts/") || target === "scripts/stage-release-runner-binaries.mjs") continue;
      if (canarySeen.has(target)) continue;
      let exists = false;
      try { readFileSync(new URL(target, root)); exists = true; } catch {}
      if (!exists) continue;
      canarySeen.add(target);
      canaryQueue.push(target);
      assert.equal(selected(plan([target]), "canary_dry_run"), true, `${entry} transitively depends on ${target}`);
    }
  }
  for (const file of ["package.json", "server/package.json", "packages/shared/package.json",
    "packages/shared/src/constants.ts", "pnpm-lock.yaml", "README.md", "scripts/run-vitest-stable.mjs",
    "cli/esbuild.config.mjs", "server/scripts/bundle-runtime.mjs",
    "packages/paperclip-runner/scripts/stage-release-runner-binaries.mjs",
    "packages/paperclip-runner/release-runner-targets.json", ".github/workflows/pr-trusted.yml"]) {
    assert.equal(selected(plan([file]), "canary_dry_run"), false, `non-canary: ${file}`);
  }
  assert.equal(selected(plan(["package.json"], { forceReason: "Full suite requested by label" }), "canary_dry_run"), true);
  assert.equal(selected(plan(["packages/shared/src/constants.ts"], { mode: "full" }), "canary_dry_run"), true);
  for (const file of ["tests/runner-e2e/catalog.test.ts", "packages/paperclip-runner/src/index.ts",
    "packages/plugins/sdk/src/index.ts", "packages/adapters/codex-local/src/index.ts",
    "packages/shared/src/constants.ts", "server/src/services/native-runtime/canonical.ts",
    "server/src/services/ai-api-key-failures.ts", "server/src/services/activity.ts",
    "ui/src/features/connections/ConnectionSetupFlow.tsx", ".github/workflows/pr-trusted.yml"]) {
    assert.equal(selected(plan([file]), "verify_runner_e2e_support"), true, `runner-e2e-support: ${file}`);
  }
  for (const file of ["server/src/services/chat-channels/github/retry.ts", "server/src/services/connectors/slack-access.ts",
    "packages/db/src/schema/chat_channels.ts", "server/src/routes/board-chat.ts", "server/src/services/heartbeat.ts"]) {
    assert.equal(selectedTasks(plan([file])).has("ci:chat"), true, `chat: ${file}`);
  }
  for (const file of ["Dockerfile", ".dockerignore", "packages/paperclip-runner/src/index.ts"]) {
    assert.equal(selected(plan([file]), "docker_context_integrity"), true, `docker: ${file}`);
  }
  assert.deepEqual([...selectedTasks(plan(["tests/e2e/smoke.spec.ts"]))].sort(), ["ci:e2e", "ci:typecheck"]);
  assert.deepEqual([...selectedTasks(plan(["tests/runner-e2e/catalog.test.ts"]))].sort(), ["ci:runner-e2e-support", "ci:runner-package", "ci:runner-static", "ci:typecheck"]);
  assert.equal(selectedTasks(plan(["packages/paperclip-runner/src/index.ts"])).has("ci:runner-package"), true);
  assert.equal(selectedTasks(plan(["packages/adapter-utils/src/github-launcher.ts"])).has("ci:runner-package"), true);
  assert.equal(selectedTasks(plan(["cli/src/commands/onboard.ts"])).has("ci:workspaces-a"), true);
  assert.equal(selected(plan(["cli/src/commands/onboard.ts"]), "verify_paperclip_runner"), false);
  assert.equal(selectedTasks(plan(["packages/db/src/schema/issues.ts"])).has("ci:workspaces-a"), true);
  assert.equal(selectedTasks(plan(["packages/paperclip-runner/src/drivers/acpx/pi-extension-adapter.ts"])).has("ci:workspaces-a"), true);
  assert.equal(selectedTasks(plan(["server/src/services/agent-conversations.ts"])).has("ci:workspaces-a"), true);
  assert.equal(selectedTasks(plan(["packages/plugins/create-paperclip-plugin/src/index.ts"])).has("ci:workspaces-a"), true);
  assert.equal(selectedTasks(plan(["announcements/examples/animated/assets/demo.html"])).has("ci:workspaces-a"), true);
});

test("PR workflow keeps Build fast and passes PR-mode context to typecheck and Vitest lanes", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  const build = workflow.split("\n  build:\n")[1].split("\n  verify_serialized_server:\n")[0];
  assert.ok(!build.includes("node scripts/verify-grok-npm-install.mjs"), "PR Build must not run the 4-min public npm install verifier");
  assert.ok(!build.includes("warm-public-install-npm-cache.mjs"), "PR Build must not warm the unused public npm install cache");
  assert.ok(build.includes("pnpm --filter @paperclipai/server build:runtime"), "PR Build still verifies production runtime bundle");
  assert.match(build, /PAPERCLIP_TSC_EMIT_ONLY: \$\{\{ !\(contains\(github\.event\.pull_request\.labels\.\*\.name, 'full-ci'\) \|\| vars\.CI_INCREMENTAL_MODE == 'full'\) && '1' \|\| '' \}\}\n\s+run: pnpm build/, "ordinary PR Build should use emit-only server compile while full-ci and CI_INCREMENTAL_MODE=full clear PAPERCLIP_TSC_EMIT_ONLY");
  assert.match(build, /if \[ "\$\{PAPERCLIP_CI_FULL:-\}" = "1" \]; then\n\s+scripts\/server-boot-smoke\.sh/);
  const runnerSupport = workflow.split("\n  verify_runner_e2e_support:\n")[1].split("\n  verify:\n")[0];
  assert.match(runnerSupport, /--shard-index \$\{\{ matrix\.shard_index \}\} --shard-count \$\{\{ matrix\.shard_count \}\}/);
  assert.equal(lanes.verify_runner_e2e_support.length, 4, "Runner support suite should be 4-way sharded");
  assert.equal(lanes.e2e_shards.length, 16, "E2E should be 16-way sharded");
  const typecheck = workflow.split("\n  typecheck_release_registry:\n")[1].split("\n  general_tests:\n")[0];
  assert.match(typecheck, /fetch-depth: 2/);
  assert.match(typecheck, /CI_PLAN: \$\{\{ needs\.gate\.outputs\.plan \}\}/);
  assert.match(typecheck, /PAPERCLIP_CI_BASE_SHA:/);
  for (const job of ["typecheck_release_registry", "general_tests", "verify_paperclip_runner", "build", "verify_serialized_server"]) {
    const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    const line = block.match(/PAPERCLIP_CI_FULL:.*/)?.[0];
    assert.ok(line, `${job} must forward PAPERCLIP_CI_FULL`);
    assert.doesNotMatch(line, /profile_ci/, `${job} must keep profile-ci in PR mode rather than forcing PAPERCLIP_CI_FULL`);
  }
  const e2e = workflow.split("\n  e2e_shards:\n")[1].split("\n  e2e:\n")[0];
  const releaseVerify = readFileSync(new URL(".github/workflows/release-verify.yml", root), "utf8");
  const releaseBuild = releaseVerify.split("\n  build:\n")[1].split("\n  runner_binary_targets:\n")[0];
  const prKey = e2e.match(/key: (e2e-ui-dist-v2-.+)/)?.[1];
  const releaseKey = releaseBuild.match(/key: (e2e-ui-dist-v2-.+)/)?.[1];
  assert.ok(prKey && releaseKey, "both pr-trusted.yml and release-verify.yml must define the E2E UI dist cache key");
  assert.equal(prKey, releaseKey, "E2E UI dist reader and writer keys must match exactly");
  assert.doesNotMatch(e2e.split("Restore prebuilt UI assets")[1].split("Run e2e tests")[0], /restore-keys:/);
  assert.match(e2e, /PAPERCLIP_E2E_SKIP_UI_BUILD: \$\{\{ steps\.e2e_ui_dist\.outputs\.cache-hit == 'true' && '1' \|\| '' \}\}/);

  // Exact reader/writer key parity for prebuilt Runner dist and incremental typecheck caches.
  const prRunnerDistKey = typecheck.match(/key: (runner-dist-v1-.+)/)?.[1];
  const releaseRunnerDistKey = releaseBuild.match(/key: (runner-dist-v1-.+)/)?.[1];
  assert.ok(prRunnerDistKey && releaseRunnerDistKey, "both pr-trusted.yml and release-verify.yml must define runner-dist-v1 cache key");
  assert.equal(prRunnerDistKey, releaseRunnerDistKey, "runner-dist-v1 reader and writer keys must match exactly");
  assert.doesNotMatch(typecheck.split("Restore prebuilt Runner dist")[1].split("Restore incremental typecheck")[0], /restore-keys:/);

  const prIncPrefix = typecheck.match(/key: (typecheck-incremental-v1-.+)-\$\{\{ github\.event\.pull_request\.base\.sha \}\}/)?.[1];
  const releaseIncPrefix = releaseBuild.match(/key: (typecheck-incremental-v1-.+)-\$\{\{ github\.sha \}\}/)?.[1];
  assert.ok(prIncPrefix && releaseIncPrefix, "both pr-trusted.yml and release-verify.yml must define typecheck-incremental-v1 prefix");
  assert.equal(prIncPrefix, releaseIncPrefix, "typecheck-incremental-v1 reader and writer prefixes must match exactly");
  assert.doesNotMatch(workflow, /actions\/cache\/save@/, "pr-trusted.yml must never save caches");
});

test("source inspected across package boundaries selects its consumers", () => {
  for (const file of ["ui/src/lib/issue-execution-policy.ts", "ui/src/index.css", "ui/src/pages/CompanyExport.tsx",
    "ui/src/components/MarkdownBody.tsx"]) {
    const tasks = selectedTasks(plan([file]));
    assert.ok(tasks.has("ci:server"), file);
    assert.ok(tasks.has("ci:runner-vitest"), file);
  }
  assert.ok(selectedTasks(plan(["ui/public/app-logos/example.svg"])).has("ci:workspaces-b"));
});

test("repository-wide guidance guards run uncached for every scanned UI file type", () => {
  const source = readFileSync(new URL("server/src/__tests__/cli-invocation-safety.test.ts", root), "utf8");
  const extensions = [...source.split("const SCAN_EXTENSIONS = new Set([")[1].split("]);")[0].matchAll(/"(\.[a-z]+)"/g)]
    .map((match) => match[1]);
  assert.ok(extensions.length > 0);
  for (const extension of extensions) {
    for (const folder of ["ui/src/components", "ui/src/pages", "ui/src/hooks", "ui/public"]) {
      assert.ok(plan([`${folder}/guidance${extension}`]).jobs.typecheck_release_registry.run);
    }
  }
  assert.equal(config.tasks["//#ci:typecheck"].cache, false);
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  const job = workflow.split("\n  typecheck_release_registry:\n")[1].split("\n  general_tests:\n")[0];
  assert.match(job, /\n        run: node scripts\/ci-typecheck-lane\.mjs\n/);
  assert.match(job, /\n        if: \$\{\{ hashFiles\('scripts\/ci-typecheck-lane\.mjs'\) != '' \}\}\n        run: node scripts\/ci-typecheck-lane\.mjs\n/);
  const fallback = job.split("\n        if: ${{ hashFiles('scripts/ci-typecheck-lane.mjs') == '' }}\n")[1].split("\n\n")[0];
  for (const command of [
    "pnpm run typecheck:build-gaps",
    "node scripts/typecheck-test-programs.mjs --low-memory",
    "pnpm --filter @paperclipai/server typecheck",
    "node scripts/typecheck-test-projects.mjs --low-memory --reuse-declarations",
    "server/src/__tests__/cli-invocation-safety.test.ts",
    "pnpm run test:release-registry",
  ]) assert.ok(fallback.includes(command), command);
  const guidance = planLane({ buildGapPackages: [], testLayers: [] }).tasks.find((task) => task.name === "CLI guidance safety");
  assert.deepEqual(guidance.args, ["exec", "vitest", "run", "--project", "@paperclipai/server", "server/src/__tests__/cli-invocation-safety.test.ts"]);
  assert.ok(!job.includes("uses: ./.github/actions/run-ci-task"));
});

test("shared contracts, runtime prompts, protocol inputs and fixtures reach consumers", () => {
  const shared = selectedTasks(plan(["packages/shared/src/types/issue.ts"]));
  for (const task of ["ci:server", "ci:db", "ci:workspaces-a", "ci:workspaces-b", "ci:serialized", "ci:e2e"]) {
    assert.ok(shared.has(task), task);
  }
  assert.ok(selectedTasks(plan(["server/src/onboarding-assets/default/AGENTS.md"])).has("ci:runner-vitest"));
  assert.ok(selectedTasks(plan(["packages/paperclip-runner/protocol/schema.json"])).has("ci:runner-rust"));
  for (const file of ["tests/runner-e2e/fixtures/prompt.md", "scripts/run-vitest-stable.mjs", "pnpm-lock.yaml"]) {
    const result = plan([file]);
    assert.equal(selected(result, "canary_dry_run"), false, `${file} must not trigger canary_dry_run`);
    assert.ok(Object.entries(result.jobs).filter(([name]) => name !== "canary_dry_run")
      .every(([, job]) => job.selected === job.total), file);
  }
});

test("sandbox provider tests run only for the providers, the plugin SDK, and what the SDK imports", () => {
  for (const file of ["packages/plugins/sandbox-providers/daytona/src/plugin.ts",
    "packages/plugins/sandbox-providers/cloudflare/bridge-template/src/index.ts",
    "packages/plugins/sdk/src/index.ts", "packages/shared/src/types/issue.ts"]) {
    assert.equal(selected(plan([file]), "sandbox_provider_tests"), true, file);
  }
  for (const file of ["server/src/index.ts", "ui/src/components/Sidebar.tsx", "cli/src/index.ts",
    "packages/paperclip-runner/src/index.ts", "packages/plugins/plugin-workspace-diff/src/worker.ts"]) {
    assert.equal(selected(plan([file]), "sandbox_provider_tests"), false, file);
  }
  // The provider lockfiles, the shared install workspace and the runner script are global inputs.
  for (const file of ["scripts/typecheck-sandbox-providers/pnpm-lock.yaml", "scripts/test-sandbox-providers.mjs",
    "packages/plugins/sandbox-providers/daytona/package.json"]) {
    assert.equal(selected(plan([file]), "sandbox_provider_tests"), true, file);
  }
  // The SDK depends on shared and nothing else in the workspace. A new dependency must join the inputs.
  const sdk = JSON.parse(readFileSync(new URL("packages/plugins/sdk/package.json", root), "utf8"));
  const workspace = Object.entries({ ...sdk.dependencies, ...sdk.peerDependencies })
    .filter(([, version]) => String(version).startsWith("workspace:")).map(([name]) => name);
  assert.deepEqual(workspace, ["@paperclipai/shared"]);
  const shared = JSON.parse(readFileSync(new URL("packages/shared/package.json", root), "utf8"));
  assert.deepEqual(Object.values({ ...shared.dependencies, ...shared.peerDependencies })
    .filter((version) => String(version).startsWith("workspace:")), []);
});

test("renames out of source and deletions cannot masquerade as release notes", () => {
  const paths = comparisonPaths({ files: [
    { filename: "releases/v2026.1029.0.md", previous_filename: "packages/shared/src/constants.ts", status: "renamed" },
    { filename: "server/src/deleted.ts", status: "removed" },
  ] });
  assert.ok(selectedTasks(plan(paths)).has("ci:server"));
  assert.ok(selectedTasks(plan(paths)).has("ci:db"));
});

test("unclassified paths and uncertain comparisons select full verification", () => {
  for (const paths of [[], ["new-root/file.ts"], ["../escaped"]]) {
    const result = plan(paths);
    assert.ok(result.forceReason);
    assert.ok(Object.values(result.jobs).every((job) => job.selected === job.total));
  }
  for (const files of [null, [], [{ status: "modified" }], [{ filename: "a", status: "renamed" }],
    Array.from({ length: 300 }, () => ({ filename: "ui/src/test.ts" }))]) {
    assert.throws(() => comparisonPaths({ files }));
  }
});

test("shadow mode explains savings but runs every task; force overrides selection", () => {
  const shadow = plan(["ui/src/components/Sidebar.tsx"], { mode: "shadow" });
  assert.equal(shadow.jobs.verify_serialized_server.proposed, 0);
  assert.equal(shadow.jobs.verify_serialized_server.selected, 9);
  for (const options of [{ mode: "full" }, { forceReason: "Stack" }]) {
    assert.ok(Object.values(plan(["ui/src/components/Sidebar.tsx"], options).jobs)
      .every((job) => job.selected === job.total));
  }
});

test("cache-affecting definition changes force execution across successive PR pushes", () => {
  for (const file of ["turbo.json", "package.json", "packages/db/package.json", "scripts/ci/run-task.mjs",
    ".github/actions/run-ci-task/action.yml"]) {
    for (const paths of [[file], [file, "packages/db/src/schema/issues.ts"]]) {
      const result = plan(paths);
      assert.match(result.forceReason, /Global CI input changed/);
      assert.equal(selected(result, "canary_dry_run"), false, `${file} must not trigger canary_dry_run`);
      assert.ok(Object.entries(result.jobs).filter(([name]) => name !== "canary_dry_run")
        .every(([, job]) => job.selected === job.total));
    }
  }
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  assert.equal((workflow.match(/force:.*\.forceReason != null/g) ?? []).length, 3);
  const action = readFileSync(new URL(".github/actions/run-ci-task/action.yml", root), "utf8");
  assert.match(action, /CI_FORCE_TASKS: \$\{\{ inputs.force \}\}/);
  assert.equal((action.match(/if:.*inputs.force != 'true'/g) ?? []).length, 2);
});

test("task dependencies propagate input changes and unsupported graph syntax fails closed", () => {
  const fixture = { globalDependencies: [], tasks: {
    "//#build": { inputs: ["lib/**"] }, "//#test": { inputs: ["app/**"], dependsOn: ["//#build"] },
  } };
  assert.equal(planTasks({ config: fixture, lanes: { tests: [{ task: "test" }] }, paths: ["lib/index.ts"] }).jobs.tests.run, true);
  fixture.tasks["//#build"].dependsOn = ["//#test"];
  assert.throws(() => planTasks({ config: fixture, lanes: { tests: [{ task: "test" }] }, paths: ["app/index.ts"] }), /Cyclic/);
  assert.throws(() => plan(["ui/src/a.ts"], { mode: "typo" }), /Invalid CI mode/);
});

test("local planner reads a real Git rename and handles a missing revision conservatively", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-plan-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q"); git("config", "user.name", "CI Test"); git("config", "user.email", "ci@example.invalid");
    mkdirSync(path.join(directory, "packages/shared/src"), { recursive: true });
    writeFileSync(path.join(directory, "packages/shared/src/input.ts"), "original\n");
    git("add", "."); git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD").trim();
    mkdirSync(path.join(directory, "releases"));
    git("mv", "packages/shared/src/input.ts", "releases/v1.md"); git("commit", "-qm", "rename");
    for (const revision of [base, "missing-revision"]) {
      const result = spawnSync(process.execPath, [new URL("../ci-plan.mjs", import.meta.url).pathname, revision], {
        cwd: directory, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "",
          CI_TASK_CONFIG: new URL("turbo.json", root).pathname, CI_TASK_MATRIX: new URL(".github/ci-task-matrix.json", root).pathname },
      });
      assert.equal(result.status, 0, result.stderr);
      const resultPlan = JSON.parse(result.stdout);
      assert.ok(selectedTasks(resultPlan).has("ci:server"));
      if (revision !== base) assert.match(resultPlan.forceReason, /Diff unavailable/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("required aggregates reject omitted, failed and cancelled selected work", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  for (const id of ["verify", "e2e"]) {
    const block = workflow.split(`\n  ${id}:\n`)[1].split(/\n  [a-z0-9_]+:\n/)[0];
    const code = block.split("          node --input-type=module <<'NODE'\n")[1].split("\n          NODE")[0]
      .split("\n").map((line) => line.slice(10)).join("\n");
    const names = /needs: \[([^\]]+)\]/.exec(block)[1].split(", ");
    const resultPlan = plan(["ui/src/components/Sidebar.tsx"]);
    const results = Object.fromEntries(names.map((name) => [name, { result:
      name === "gate" || name === "policy" || resultPlan.jobs[name]?.run ? "success" : "skipped" }]));
    const run = (env = {}) => spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8",
      env: { ...process.env, FULL_CI: "true", CI_PLAN: JSON.stringify(resultPlan), CI_RESULTS: JSON.stringify(results), ...env } });
    assert.equal(run().status, 0);
    for (const name of names) {
      // Optional analysis can fail or be skipped; the unchanged task plan
      // still has to pass. Selected-plan cases are exercised separately.
      if (name === "test_selection") continue;
      const previous = results[name].result;
      for (const bad of previous === "success" ? ["failure", "cancelled", "skipped"] : ["success"]) {
        results[name].result = bad;
        assert.notEqual(run().status, 0, `${id}: ${name} must reject ${bad}`);
      }
      results[name].result = previous;
    }
    for (const result of ["failure", "cancelled", "skipped"]) {
      results.gate.result = result;
      const failedGate = run({ FULL_CI: "", CI_PLAN: "" });
      assert.notEqual(failedGate.status, 0, `${id}: an absent routing output must not pass`);
      assert.match(failedGate.stderr, /CI routing must succeed/);
    }
    assert.match(block, /^ {4}runs-on: ubuntu-slim$/m,
      `${id}: the always-run summary runs on ubuntu-slim without booting a PR VM`);
  }
});

test("pr-trusted skips pnpm/action-setup only when pre-baked pnpm matches package.json packageManager", () => {
  const workflow = readFileSync(new URL(".github/workflows/pr-trusted.yml", root), "utf8");
  const checkBlocks = [...workflow.matchAll(/      - name: Check preinstalled pnpm\n        id: pnpm_preinstalled\n(?:        if: [^\n]+\n)?        run: \|\n((?:          [^\n]+\n)+)/g)];
  const setupMatches = workflow.match(/      - name: Setup pnpm\n        if: [^\n]*steps\.pnpm_preinstalled\.outputs\.hit != 'true'\n        uses: pnpm\/action-setup@/g) ?? [];
  const allPnpmActions = workflow.match(/uses: pnpm\/action-setup@/g) ?? [];
  assert.equal(allPnpmActions.length, 11);
  assert.equal(checkBlocks.length, allPnpmActions.length);
  assert.equal(setupMatches.length, allPnpmActions.length);
  const script = checkBlocks[0][1].split("\n").map((line) => line.slice(10)).join("\n");
  for (const [, body] of checkBlocks) {
    assert.equal(body, checkBlocks[0][1], "all preinstalled pnpm checks must stay identical");
    assert.doesNotMatch(body, /"9\.15\.4"/, "must compare against package.json packageManager, not a hardcoded version");
  }
  const dir = mkdtempSync(path.join(tmpdir(), "ci-pnpm-check-"));
  try {
    const binDir = path.join(dir, "home/setup-pnpm/node_modules/.bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "pnpm"), "#!/bin/sh\necho 9.15.4\n", { mode: 0o755 });
    const run = (pkg, home) => {
      const work = mkdtempSync(path.join(dir, "work-"));
      writeFileSync(path.join(work, "package.json"), JSON.stringify(pkg));
      const envFile = path.join(work, "env");
      const pathFile = path.join(work, "path");
      const outFile = path.join(work, "out");
      writeFileSync(envFile, ""); writeFileSync(pathFile, ""); writeFileSync(outFile, "");
      const res = spawnSync("bash", ["-e", "-c", script], {
        cwd: work, encoding: "utf8",
        env: { ...process.env, HOME: home, GITHUB_ENV: envFile, GITHUB_PATH: pathFile, GITHUB_OUTPUT: outFile },
      });
      assert.equal(res.status, 0, res.stderr);
      return { env: readFileSync(envFile, "utf8"), path: readFileSync(pathFile, "utf8"), out: readFileSync(outFile, "utf8").trim() };
    };
    const home = path.join(dir, "home");
    const hit = run({ packageManager: "pnpm@9.15.4" }, home);
    assert.equal(hit.out, "hit=true");
    assert.equal(hit.env.trim(), `PNPM_HOME=${binDir}`);
    assert.equal(hit.path.trim(), binDir);
    assert.equal(run({ packageManager: "pnpm@9.15.4+sha512.abc" }, home).out, "hit=true");
    const bumped = run({ packageManager: "pnpm@9.15.5" }, home);
    assert.equal(bumped.out, "hit=false");
    assert.equal(bumped.env, "");
    assert.equal(run({}, home).out, "hit=false");
    assert.equal(run({ packageManager: "pnpm@9.15.4" }, path.join(dir, "empty-home")).out, "hit=false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real routing step uses pinned trusted definitions and defaults to full on fetch failure", () => {
  const workflow = readFileSync(new URL(".github/workflows/ci-routing.yml", root), "utf8");
  const block = workflow.split("      - name: Plan affected CI tasks from trusted definitions\n")[1];
  const shell = block.split("        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const directory = mkdtempSync(path.join(tmpdir(), "ci-routing-plan-"));
  try {
    const repository = path.join(directory, "source");
    mkdirSync(repository);
    const gitBin = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const git = (...args) => execFileSync(gitBin, args, { cwd: repository, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main"); git("config", "user.name", "CI"); git("config", "user.email", "ci@example.invalid");
    writeFileSync(path.join(repository, "base"), "base"); git("add", "."); git("commit", "-qm", "base");
    git("checkout", "-qb", "pr");
    mkdirSync(path.join(repository, "ui/src/components"), { recursive: true });
    writeFileSync(path.join(repository, "ui/src/components/Sidebar.tsx"), "change");
    git("add", "."); git("commit", "-qm", "PR");
    const prHead = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    writeFileSync(path.join(repository, "unrelated-master"), "already merged");
    git("add", "."); git("commit", "-qm", "advance base");
    const base = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "pr", "-m", "tested merge");
    const merge = git("rev-parse", "HEAD");
    writeFileSync(path.join(directory, "git"), `#!/usr/bin/env node
const {spawnSync}=require('node:child_process');
if(process.env.TEST_GIT_FAILURE==='true')process.exit(1);
const args=process.argv.slice(2).map(a=>a==='https://github.com/paperclipai/paperclip.git'?process.env.TEST_GIT_REPOSITORY:a);
const r=spawnSync(${JSON.stringify(gitBin)},args,{stdio:'inherit'});process.exit(r.status??1);
`);
    chmodSync(path.join(directory, "git"), 0o755);
    const gh = path.join(directory, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const endpoint = process.argv.find(arg => arg.startsWith('/repos/'));
if (endpoint?.endsWith('/git/ref/heads/master')) console.log('a'.repeat(40));
else if (endpoint?.includes('/contents/')) {
  if (process.env.TEST_FETCH_FAILURE === 'true') process.exit(1);
  const [file, query] = endpoint.split('/contents/')[1].split('?');
  if (query !== 'ref=' + 'a'.repeat(40)) process.exit(2);
  process.stdout.write(fs.readFileSync(path.join(process.env.TEST_TRUSTED_ROOT, file)));
}
else process.exit(3);
`);
    chmodSync(gh, 0o755);
    for (const overrides of [{}, { TEST_FETCH_FAILURE: "true" }, { TEST_GIT_FAILURE: "true" }, { PROFILE_CI: "true" }, { STACK_JSON: "{}" }, { FULL_CI: "false" }]) {
      const output = path.join(directory, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-c", shell], { encoding: "utf8", env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_TRUSTED_ROOT: root.pathname,
        RUNNER_TEMP: directory, FULL_CI: "true", PROFILE_CI: "false", FORCE_FULL_CI: "false",
        CI_INCREMENTAL_MODE: "enabled", STACK_JSON: "null", EVENT_BASE_SHA: "b".repeat(40), EVENT_HEAD_SHA: prHead, EVENT_MERGE_SHA: merge,
        TEST_GIT_REPOSITORY: repository,
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: "", ...overrides,
      } });
      assert.equal(result.status, 0, result.stderr);
      const value = readFileSync(output, "utf8").trim();
      if (overrides.TEST_FETCH_FAILURE || overrides.TEST_GIT_FAILURE || overrides.FULL_CI === "false") assert.equal(value, "plan=");
      else {
        assert.notEqual(value, "plan=", `${JSON.stringify(overrides)}: ${result.stderr}`);
        const resultPlan = JSON.parse(value.slice("plan=".length));
        assert.equal(resultPlan.jobs.general_tests.selected, overrides.PROFILE_CI || overrides.STACK_JSON ? 28 : 2);
        assert.equal(resultPlan.diff.base, base);
        assert.deepEqual(resultPlan.changed, ["ui/src/components/Sidebar.tsx"]);
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("audited prose does not widen source selection, but guidance still runs its uncached guard", () => {
  const source = "ui/src/components/Sidebar.tsx";
  const sourcePlan = plan([source]);
  for (const doc of [
    "doc/DEVELOPING.md",
    "doc/DATABASE.md",
    "doc/connections/GOOGLE-WORKSPACE.md",
    "docs/guides/board-operator/importing-and-exporting.md",
    "doc/plans/2026-10-30-example.md",
    "doc/logs/2026-11-01-verify.md",
  ]) {
    const mixed = plan([source, doc]);
    assert.equal(mixed.forceReason, null, doc);
    assert.deepEqual(mixed.jobs, sourcePlan.jobs, doc);
    assert.deepEqual(mixed.documentation, [doc], doc);
  }
  const guidance = plan(["doc/DEVELOPING.md"]);
  assert.deepEqual([...selectedTasks(guidance)], ["ci:typecheck"]);
  assert.equal(config.tasks["//#ci:typecheck"].cache, false);
  assert.deepEqual([...selectedTasks(plan(["doc/connections/GOOGLE-WORKSPACE.md"]))], ["ci:typecheck"]);
  assert.equal(selected(plan(["doc/connections/GOOGLE-WORKSPACE.md"]), "canary_dry_run"), false);
  assert.equal(selected(plan(["doc/connections/GOOGLE-WORKSPACE.md"]), "verify_paperclip_runner"), false);
  assert.deepEqual([...selectedTasks(plan(["doc/plans/2026-10-30-example.md"]))], []);
  assert.deepEqual([...selectedTasks(plan(["doc/logs/2026-11-01-verify.md"]))], []);
  for (const file of [
    "docs/api/issues.md",
    "doc/connections/tool-method-permission-reviews.json",
    "doc/unknown.md",
    "doc/plans/tool.sh",
    "skills/paperclip/SKILL.md",
    "server/src/onboarding-assets/default/AGENTS.md",
    "tests/fixtures/example.md",
  ]) {
    assert.ok(selectedTasks(plan([source, file])).has("ci:server"), file);
  }
});

test("complete merge trees handle more than 300 files, base advancement, renames and deletions", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ci-merge-diff-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  const write = (file, value) => { mkdirSync(path.dirname(path.join(directory, file)), { recursive: true }); writeFileSync(path.join(directory, file), value); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "CI"); git("config", "user.email", "ci@example.invalid");
  write("ui/src/deleted.ts", "old"); write("ui/src/renamed.ts", "rename"); const staleBase = commit();
  git("checkout", "-qb", "pr");
  for (let index = 0; index < 350; index++) write(`ui/src/component-${index}.ts`, "new");
  git("rm", "ui/src/deleted.ts");
  mkdirSync(path.join(directory, "doc/plans"), { recursive: true });
  git("mv", "ui/src/renamed.ts", "doc/plans/2026-10-30-moved.md");
  const prHead = commit();
  git("checkout", "-q", "main"); write(".github/workflows/unrelated.yml", "already merged CI change"); const base = commit();
  git("merge", "--no-ff", "pr", "-m", "tested merge"); const head = git("rev-parse", "HEAD");
  const result = mergeDiff(head, prHead, directory);
  assert.equal(result.diff.base, base); assert.notEqual(result.diff.base, staleBase);
  assert.equal(result.changed.length, 353);
  assert.ok(result.changed.includes("ui/src/deleted.ts")); assert.ok(result.changed.includes("ui/src/renamed.ts"));
  assert.ok(!result.changed.includes(".github/workflows/unrelated.yml"));
  assert.equal(plan(result.changed).forceReason, null);
  const shallow = path.join(directory, "shallow");
  git("clone", "--quiet", "--depth", "2", `file://${directory}`, shallow);
  assert.equal(execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: shallow, encoding: "utf8" }).trim(), "true");
  assert.deepEqual(mergeDiff(head, prHead, shallow), result);
  assert.throws(() => mergeDiff(head, base, directory), /expected PR head/);
  assert.throws(() => mergeDiff(prHead, prHead, directory), /merge commit/);
  assert.throws(() => mergeDiff("f".repeat(40), prHead, directory));
});
