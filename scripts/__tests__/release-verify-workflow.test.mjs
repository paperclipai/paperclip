import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

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
  assert.doesNotMatch(
    releaseWorkflow,
    /verify_(?:canary|stable):[\s\S]*?pnpm test:run(?:\n|$)/,
  );
});

test("onboard smoke container binds beyond loopback so the mapped port is reachable", () => {
  const dockerfile = readFileSync(
    path.join(repoRoot, "docker/Dockerfile.onboard-smoke"),
    "utf8",
  );

  // `onboard --yes` without an explicit --bind prefers trusted-local
  // defaults and writes a loopback bind, which Docker port mapping cannot
  // reach. The smoke container must pin a non-loopback preset.
  assert.match(dockerfile, /onboard --yes --bind lan/);
});

test("promotion selection guards against sources that predate their channel tooling", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // Promotions run the source commit's release.sh, so selection must reject
  // sources whose tooling does not know the target channel yet.
  assert.match(
    releaseWorkflow,
    /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly'/,
  );
  assert.match(
    releaseWorkflow,
    /git show "\$\{sha\}:scripts\/release\.sh" \| grep -qF 'canary\|nightly\|beta\|stable\)'/,
  );
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
  assert.match(
    releaseWorkflow,
    /needs\.verify_beta_candidate\.result == 'success'/,
  );
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

test("published canaries are gated by the exact-version onboarding browser smoke", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  assert.match(
    releaseWorkflow,
    /publish_canary:[\s\S]*?outputs:\n\s+canary_version: \$\{\{ steps\.canary_tag\.outputs\.version \}\}/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:\n\s+needs: publish_canary\n\s+if: needs\.publish_canary\.result == 'success'/,
  );
  assert.match(
    releaseWorkflow,
    /PAPERCLIPAI_VERSION: \$\{\{ needs\.publish_canary\.outputs\.canary_version \}\}/,
  );
  assert.match(releaseWorkflow, /test:canary-onboarding-smoke/);
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?uses: actions\/checkout@[0-9a-f]{40} # v7[\s\S]*?uses: pnpm\/action-setup@[0-9a-f]{40} # v6[\s\S]*?uses: actions\/setup-node@[0-9a-f]{40} # v7/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?Install test dependencies\n\s+run: pnpm install --frozen-lockfile/,
  );
  assert.doesNotMatch(
    releaseWorkflow.match(
      /smoke_canary_onboarding:[\s\S]*?(?=\n  # ----- Nightly lane)/,
    )?.[0] ?? "",
    /cache: pnpm/,
  );
  assert.match(
    releaseWorkflow,
    /name: Smoke exact published canary through onboarding\n\s+env:\n\s+PAPERCLIP_CANARY_SMOKE_SERVER_LOG: \$\{\{ runner\.temp \}\}\/canary-onboarding-server\.log/,
  );
  assert.match(
    releaseWorkflow,
    /smoke_canary_onboarding:[\s\S]*?uses: actions\/upload-artifact@[0-9a-f]{40} # v7/,
  );
  assert.match(releaseWorkflow, /canary-onboarding-server\.log/);
  assert.match(releaseWorkflow, /tests\/canary-onboarding\/playwright-report/);
});

test("every lane's tag push degrades to recovery instructions when rejected", () => {
  const releaseWorkflow = readWorkflow("release.yml");

  // GITHUB_TOKEN may not create refs pointing at workflow-modifying commits
  // from dispatch or scheduled runs; a rejected tag push after a successful
  // npm publish must surface runbook recovery commands, not a bare error.
  const occurrences = releaseWorkflow.match(/## Tag push rejected/g) ?? [];
  assert.equal(
    occurrences.length,
    3,
    "nightly, beta, and stable each carry the recovery summary",
  );
});

test("release smoke workflow extends the container readiness budget for CI", () => {
  const smokeWorkflow = readWorkflow("release-smoke.yml");
  const harness = readFileSync(
    path.join(repoRoot, "scripts/docker-onboard-smoke.sh"),
    "utf8",
  );

  // CI containers cold-install paperclipai and embedded postgres, so the
  // workflow must extend the harness's local-default readiness budget.
  assert.match(smokeWorkflow, /SMOKE_READY_TIMEOUT_SECONDS=\d+/);
  const ciBudget = Number(
    smokeWorkflow.match(/SMOKE_READY_TIMEOUT_SECONDS=(\d+)/)[1],
  );
  assert.ok(
    ciBudget >= 300,
    `CI readiness budget ${ciBudget}s should be at least 300s`,
  );

  assert.match(
    harness,
    /SMOKE_READY_TIMEOUT_SECONDS="\$\{SMOKE_READY_TIMEOUT_SECONDS:-\d+\}"/,
  );
  assert.match(
    harness,
    /wait_for_http "\$PAPERCLIP_PUBLIC_URL\/api\/health" "\$SMOKE_READY_TIMEOUT_SECONDS" 1/,
  );
});

test("release verify workflow covers the same split test surface as stable PR verification", () => {
  const verifyWorkflow = readWorkflow("release-verify.yml");

  assert.match(verifyWorkflow, /workflow_call:/);
  assert.match(
    verifyWorkflow,
    /node \.\/scripts\/release-package-map\.mjs check/,
  );
  assert.match(verifyWorkflow, /pnpm -r typecheck/);
  assert.match(verifyWorkflow, /pnpm build/);
  assert.match(
    verifyWorkflow,
    /pnpm --filter @paperclipai\/paperclip-runner check:all/,
  );
  assert.match(verifyWorkflow, /runner_workflow_evals:/);
  assert.match(verifyWorkflow, /runner_chaos_evals:/);
  assert.match(
    verifyWorkflow,
    /uses: \.\/\.github\/workflows\/runner-chaos-evals\.yml/,
  );
  assert.match(
    verifyWorkflow,
    /runner_workflow_evals:[\s\S]*?Install dependencies\n\s+run: pnpm install --frozen-lockfile[\s\S]*?Run deterministic Runner workflow scorer tests/,
  );
  assert.match(verifyWorkflow, /pnpm test:runner-workflow-evals/);

  for (const group of [
    "general-server",
    "general-workspaces-a",
    "general-workspaces-b",
  ]) {
    assert.match(verifyWorkflow, new RegExp(`group: ${group}`));
  }

  for (const shardIndex of [0, 1, 2]) {
    assert.match(
      verifyWorkflow,
      new RegExp(
        `group: general-server[\\s\\S]*?shard_index: ${shardIndex}[\\s\\S]*?shard_count: 3`,
      ),
    );
  }

  for (const shardIndex of [0, 1, 2, 3, 4]) {
    assert.match(
      verifyWorkflow,
      new RegExp(`shard_index: ${shardIndex}[\\s\\S]*?shard_count: 5`),
    );
  }

  // workspaces-a splits with Vitest native --shard in pr.yml; release
  // verification must keep the same two-shard coverage.
  for (const shardIndex of [0, 1]) {
    assert.match(
      verifyWorkflow,
      new RegExp(
        `group: general-workspaces-a[\\s\\S]*?shard_index: ${shardIndex}\\n\\s+shard_count: 2`,
      ),
    );
  }

  assert.match(verifyWorkflow, /pnpm test:run:general -- --group/);
  assert.match(verifyWorkflow, /pnpm test:run:serialized -- --shard-index/);
});

test("Runner eval workflows pin actions and gate paid live execution", () => {
  const actionPinWorkflows = [
    readWorkflow("release-verify.yml"),
    readWorkflow("runner-live-evals.yml"),
    readWorkflow("runner-chaos-evals.yml"),
    readWorkflow("runner-full-stack-e2e.yml"),
    readWorkflow("e2e.yml"),
  ];

  for (const workflow of actionPinWorkflows) {
    const remoteUses = workflow
      .split("\n")
      .filter(
        (line) =>
          /^\s*(?:-\s*)?uses: /.test(line) && !line.includes("uses: ./"),
      );
    assert.ok(
      remoteUses.length > 0,
      "expected at least one remote action reference",
    );
    for (const line of remoteUses) {
      assert.match(line, /uses: [^@\s]+@[0-9a-f]{40}(?:\s+# .+)?$/);
    }
  }

  const liveWorkflow = actionPinWorkflows[1];
  assert.match(liveWorkflow, /RUNNER_LIVE_EVALS_NIGHTLY_ENABLED == 'true'/);
  assert.match(liveWorkflow, /REF: \$\{\{ github\.ref \}\}/);
  assert.match(liveWorkflow, /refs\/heads\/\$DEFAULT_BRANCH/);
  assert.match(
    liveWorkflow,
    /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/,
  );
  assert.match(liveWorkflow, /RUNNER_E2E_ALLOWED_ACTOR_IDS/);
  assert.match(liveWorkflow, /needs: authorize/);
  assert.match(liveWorkflow, /environment:\n\s+name: runner-e2e-paid/);
  assert.match(
    liveWorkflow,
    /OPENAI_API_KEY: \$\{\{ secrets\.OPENAI_API_KEY \}\}/,
  );

  const paidWorkflowNames = [
    "e2e.yml",
    "runner-full-stack-e2e.yml",
    "runner-live-evals.yml",
  ];
  const paidWorkflowNameSet = new Set(paidWorkflowNames);
  const providerSecretReference =
    /secrets(?:\.(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DAYTONA_API_KEY)\b|\[['"](?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DAYTONA_API_KEY)['"]\])/g;
  for (const name of readdirSync(path.join(repoRoot, ".github/workflows"))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = readWorkflow(name);
    if ([...workflow.matchAll(providerSecretReference)].length > 0) {
      assert.ok(
        paidWorkflowNameSet.has(name),
        `${name} must not receive provider credentials`,
      );
    }
  }

  for (const name of paidWorkflowNames) {
    const workflow = readWorkflow(name);
    const triggerHeader = workflow.slice(0, workflow.indexOf("\njobs:\n"));
    assert.doesNotMatch(
      triggerHeader,
      /^\s{2}(?:pull_request|pull_request_target|push|workflow_call|workflow_run):/m,
    );
    assert.match(triggerHeader, /^\s{2}workflow_dispatch:/m);
    assert.match(workflow, /^  authorize:/m);

    const jobBlocks = workflow
      .slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length)
      .split(/\n(?=  [A-Za-z0-9_-]+:\n)/);
    const providerJobs = jobBlocks.filter(
      (block) => [...block.matchAll(providerSecretReference)].length > 0,
    );
    assert.ok(providerJobs.length > 0, `${name} needs a provider-secret job`);
    for (const block of providerJobs) {
      assert.match(block, /\n    environment:\n      name: runner-e2e-paid\n/);
      assert.match(
        block,
        /\n    steps:\n(?:\s*\n)*      - name: Reauthorize[^\n]*\n/,
        `${name} must reauthorize as the first provider-job step`,
      );
      const reauthorize = block.indexOf("      - name: Reauthorize");
      assert.ok(reauthorize > 0);
      assert.ok(block.indexOf("actions/checkout@") > reauthorize);
      assert.ok(block.search(providerSecretReference) > reauthorize);
      assert.match(block, /github\.actor_id/);
      assert.match(block, /github\.triggering_actor/);
      assert.match(block, /RUNNER_E2E_ALLOWED_ACTOR_IDS/);
      assert.match(block, /refs\/heads\/\$DEFAULT_BRANCH/);
      assert.doesNotMatch(block, /^\s+cache: pnpm$/m);
    }
  }

  const fullStackWorkflow = readWorkflow("runner-full-stack-e2e.yml");
  for (const [secret, condition] of Object.entries({
    OPENAI_API_KEY: "matrix.credentialName == 'OPENAI_API_KEY'",
    ANTHROPIC_API_KEY: "matrix.credentialName == 'ANTHROPIC_API_KEY'",
    OPENROUTER_API_KEY: "matrix.credentialName == 'OPENROUTER_API_KEY'",
    DAYTONA_API_KEY: "matrix.environmentId == 'daytona'",
  })) {
    assert.ok(
      fullStackWorkflow.includes(
        `${secret}: \${{ ${condition} && secrets.${secret} || '' }}`,
      ),
      `${secret} must be scoped to only the matrix cells that require it`,
    );
  }
  const historyPublisher = fullStackWorkflow.slice(
    fullStackWorkflow.indexOf("  publish_history:"),
    fullStackWorkflow.indexOf("  pages:"),
  );
  assert.doesNotMatch(historyPublisher, /^\s+cache: pnpm$/m);

  for (const name of ["runner-full-stack-e2e.yml", "runner-live-evals.yml"]) {
    const workflow = readWorkflow(name);
    const crons = [...workflow.matchAll(/cron:\s*"([^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.equal(crons.length, 1, `${name} must have one schedule`);
    assert.match(crons[0], /^\d{1,2} \d{1,2} \* \* 0$/);
  }

  const chaosWorkflow = actionPinWorkflows[2];
  const runnerBlock = chaosWorkflow.match(
    /- name: Run Runner fault and replay suites[\s\S]*?run: \|([\s\S]*?)(?=\n\s+- name: Build server test dependencies)/,
  )?.[1];
  const serverBlock = chaosWorkflow.match(
    /- name: Run server finalization and recovery suites[\s\S]*?run: \|([\s\S]*?)(?=\n\s+- name: Upload chaos eval bundle)/,
  )?.[1];
  assert.ok(runnerBlock, "expected Runner chaos test command");
  assert.ok(serverBlock, "expected server chaos test command");
  for (const [base, block] of [
    [path.join(repoRoot, "packages/paperclip-runner"), runnerBlock],
    [path.join(repoRoot, "server"), serverBlock],
  ]) {
    const listedTestPaths =
      block.match(/src\/[A-Za-z0-9_./-]+\.test\.ts/g) ?? [];
    assert.ok(listedTestPaths.length > 0, "expected chaos workflow test paths");
    assert.equal(
      new Set(listedTestPaths).size,
      listedTestPaths.length,
      "chaos workflow test paths must be unique",
    );
    for (const testPath of listedTestPaths) {
      assert.ok(
        existsSync(path.join(base, testPath)),
        `chaos workflow test path does not exist: ${testPath}`,
      );
    }
  }
});
