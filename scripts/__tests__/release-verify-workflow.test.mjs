import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readWorkflow(name) {
  return readFileSync(path.join(repoRoot, ".github/workflows", name), "utf8");
}

test("release workflow delegates stable and canary verification to the reusable workflow", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /verify_canary:\n\s+if: github\.event_name == 'push'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/,
  );
  // The stable lane is gated on the stable channel since the nightly lane
  // was added; a `needs:` line (for example a preflight job) may sit between
  // the gate and the delegation.
  // The stable preflight resolves source_ref to an immutable SHA exactly
  // once; verification must consume that pin, not re-resolve the ref.
  assert.match(
    releaseWorkflow,
    /verify_stable:\n\s+if: github\.event_name == 'workflow_dispatch' && inputs\.channel == 'stable'\n(?:\s+needs: [^\n]+\n)?\s+uses: \.\/\.github\/workflows\/release-verify\.yml\n\s+with:\n\s+ref: \$\{\{ needs\.preflight_stable\.outputs\.sha \}\}/,
  );
  assert.doesNotMatch(releaseWorkflow, /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/);
});

test("onboard smoke container binds beyond loopback so the mapped port is reachable", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "docker/Dockerfile.onboard-smoke"), "utf8");

  // `onboard --yes` without an explicit --bind prefers trusted-local
  // defaults and writes a loopback bind, which Docker port mapping cannot
  // reach. The smoke container must pin a non-loopback preset.
  assert.match(dockerfile, /onboard --yes --bind lan/);
});

test("promotion selection guards against sources that predate their channel tooling", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Promotions run the source commit's release.sh, so selection must reject
  // sources whose tooling does not know the target channel yet.
  assert.match(releaseWorkflow, /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly'/);
  assert.match(releaseWorkflow, /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly\|beta\|stable\)'/);
});

test("candidate-branch betas are validated and fully verified before publish", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Candidate heads are new commits: selection must pin the naming
  // convention and publication must be gated on full verification.
  assert.match(releaseWorkflow, /candidate\/beta-\*\)/);
  assert.match(
    releaseWorkflow,
    /verify_beta_candidate:\n\s+needs: select_beta\n\s+if: needs\.select_beta\.outputs\.mode == 'candidate'\n\s+uses: \.\/\.github\/workflows\/release-verify\.yml/,
  );
  assert.match(releaseWorkflow, /needs\.verify_beta_candidate\.result == 'success'/);
});

test("post-publish beta smoke survives the skipped candidate-verification ancestor", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // publish_beta's needs chain contains verify_beta_candidate, which is
  // skipped on promote-mode betas. An `if:` without a status-check function
  // gets an implicit success() that evaluates that chain transitively and
  // silently skips the smoke. The condition must stay explicit.
  assert.match(
    releaseWorkflow,
    /smoke_beta:\n\s+needs: publish_beta\n\s+if: \$\{\{ !cancelled\(\) && needs\.publish_beta\.result == 'success' && !inputs\.dry_run \}\}/,
  );
});

test("every lane's tag push degrades to recovery instructions when rejected", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // GITHUB_TOKEN may not create refs pointing at workflow-modifying commits
  // from dispatch or scheduled runs; a rejected tag push after a successful
  // npm publish must surface runbook recovery commands, not a bare error.
  const occurrences = releaseWorkflow.match(/## Tag push rejected/g) ?? [];
  assert.equal(occurrences.length, 3, "nightly, beta, and stable each carry the recovery summary");
});

test("release smoke workflow extends the container readiness budget for CI", () => {
  const smokeWorkflow = readWorkflow("release-smoke.yml");
  const harness = readFileSync(path.join(repoRoot, "scripts/docker-onboard-smoke.sh"), "utf8");

  // CI containers cold-install paperclipai and embedded postgres, so the
  // workflow must extend the harness's local-default readiness budget.
  assert.match(smokeWorkflow, /SMOKE_READY_TIMEOUT_SECONDS=\d+/);
  const ciBudget = Number(smokeWorkflow.match(/SMOKE_READY_TIMEOUT_SECONDS=(\d+)/)[1]);
  assert.ok(ciBudget >= 300, `CI readiness budget ${ciBudget}s should be at least 300s`);

  assert.match(harness, /SMOKE_READY_TIMEOUT_SECONDS="\$\{SMOKE_READY_TIMEOUT_SECONDS:-\d+\}"/);
  assert.match(harness, /wait_for_http "\$PAPERCLIP_PUBLIC_URL\/api\/health" "\$SMOKE_READY_TIMEOUT_SECONDS" 1/);
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(verifyWorkflow, /node \.\/scripts\/release-package-map\.mjs check/);
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);
  assert.match(verifyWorkflow, /pnpm --filter @paperclipai\/paperclip-runner check:all/);

  for (const group of ["general-server", "general-workspaces-a", "general-workspaces-b"]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }

  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-server[\\s\\S]*?shard_index: ${shardIndex}[\\s\\S]*?shard_count: 3`),
    );
  }

  for (const shardIndex of [0, 1, 2, 3, 4]) {
    assert.match(verifyWorkflow, new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 5`));
  }

  // workspaces-a splits with Vitest native --shard in pr.yml; release
  // verification must keep the same two-shard coverage.
  for (const shardIndex of [0, 1]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`group: general-workspaces-a[\\s\\S]*?shard_index: ${shardIndex}\\n\\s+shard_count: 2`),
    );
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});
