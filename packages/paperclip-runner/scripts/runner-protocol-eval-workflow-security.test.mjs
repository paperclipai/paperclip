import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(
  repositoryRoot,
  ".github/workflows/runner-protocol-live-evals.yml",
);
const trustedPrWorkflowPath = resolve(
  repositoryRoot,
  ".github/workflows/pr-trusted.yml",
);

test("direct live eval workflow keeps paid execution behind stable actor authorization", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  assert.match(workflow, /^\s{2}authorize:/mu);
  assert.match(workflow, /RUNNER_E2E_ALLOWED_ACTOR_IDS/u);
  assert.match(workflow, /github\.actor_id/u);
  assert.match(workflow, /github\.triggering_actor/u);
  assert.match(workflow, /refs\/heads\/\$DEFAULT_BRANCH/u);
  assert.match(workflow, /Reauthorize paid execution before provider access/u);
  assert.match(
    workflow,
    /Reauthorize paid execution before provider access[\s\S]*actions\/checkout@[0-9a-f]{40}[\s\S]*Run one immutable direct protocol cell/u,
  );
  assert.doesNotMatch(
    workflow,
    /^\s{2}(?:pull_request|pull_request_target|push|workflow_call|workflow_run):/mu,
  );
  const actions = [
    ...workflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu),
  ].map((match) => match[1]);
  assert.ok(actions.length > 0);
  for (const action of actions) assert.match(action, /^[^@]+@[0-9a-f]{40}$/u);
});

test("pull request CI builds the canonical Evalbook viewer", async () => {
  const workflow = await readFile(trustedPrWorkflowPath, "utf8");
  const buildJob = workflow.slice(
    workflow.indexOf("  build:"),
    workflow.indexOf("  verify_serialized_server:"),
  );

  assert.match(
    buildJob,
    /name: Build Runner Evalbook viewer[\s\S]*pnpm --filter @paperclipai\/paperclip-runner build:issue-thread/u,
  );
});

test("resolves both repositories immutably and bounds total matrix concurrency", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const targetLock = workflow.slice(
    workflow.indexOf("  target_lock:"),
    workflow.indexOf("  catalog:"),
  );
  assert.match(targetLock, /ref: \$\{\{ needs\.authorize\.outputs\.target_sha \}\}/u);
  assert.match(targetLock, /pnpm install --ignore-scripts --no-frozen-lockfile --lockfile-only/u);
  assert.match(targetLock, /Upload resolved target lockfile/u);
  const build = workflow.slice(
    workflow.indexOf("  build_runner:"),
    workflow.indexOf("  eval_shard_0:"),
  );
  assert.match(build, /Download resolved target lockfile/u);
  assert.match(build, /Restore resolved target lockfile/u);
  const authorize = workflow.slice(
    workflow.indexOf("  authorize:"),
    workflow.indexOf("  catalog:"),
  );
  assert.match(authorize, /repos\/\$REPOSITORY\/branches\/\$encoded_branch/u);
  assert.match(authorize, /\^\[0-9a-f\]\{40\}\$/u);
  assert.match(
    authorize,
    /repos\/paperclipai\/paperclip-evals\/commits\/\$EVALS_SHA/u,
  );
  assert.match(authorize, /COMMITPERCLIP_KEY/u);
  assert.match(authorize, /GH_REPO: paperclipai\/paperclip-evals/u);
  assert.match(
    authorize,
    /GH_TOKEN: \$\{\{ steps\.evals_token\.outputs\.value \}\}/u,
  );
  assert.match(authorize, /test "\$resolved" = "\$EVALS_SHA"/u);
  const catalog = workflow.slice(
    workflow.indexOf("  catalog:"),
    workflow.indexOf("  build_runner:"),
  );
  assert.match(
    catalog,
    /ref: \$\{\{ needs\.authorize\.outputs\.evals_sha \}\}/u,
  );
  assert.match(catalog, /RUNNER_E2E_MAX_PARALLEL/u);
  assert.match(catalog, /max_parallel_per_shard/u);
  const privateCheckouts = [
    ...workflow.matchAll(
      /repository: paperclipai\/paperclip-evals[\s\S]*?persist-credentials: false/gmu,
    ),
  ];
  assert.equal(privateCheckouts.length, 3);
  const privateTokenSteps = [
    ...workflow.matchAll(
      /^      - name: Generate private eval-repository token\n(?<body>(?:^ {8,}.*\n?)*)/gmu,
    ),
  ];
  assert.equal(privateTokenSteps.length, 4);
  for (const tokenStep of privateTokenSteps) {
    assert.match(
      tokenStep.groups.body,
      /^ {10}GH_REPO: paperclipai\/paperclip-evals$/mu,
      "every private-eval token must be minted from the eval repository installation",
    );
  }
  for (const checkout of privateCheckouts) {
    assert.match(
      checkout[0],
      /token: \$\{\{ steps\.evals_token\.outputs\.value \}\}/u,
    );
  }
  assert.match(workflow, /matrix_0/u);
  assert.match(workflow, /matrix_1/u);
  assert.match(
    workflow,
    /pnpm --filter @paperclipai\/paperclip-runner deploy --prod/u,
  );
  assert.match(
    workflow,
    /--runner-cli runner-protocol-build\/extracted\/portable\/dist\/cli\/eval-session\.js/u,
  );
  assert.doesNotMatch(workflow, /npm install --prefix/u);
});

test("publishes only the separately sanitized Evalbook through trusted OIDC code", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const report = workflow.slice(
    workflow.indexOf("  report:"),
    workflow.indexOf("  publish_history:"),
  );
  assert.match(
    report,
    /Render the access-controlled canonical Evalbook report/u,
  );
  assert.match(
    report,
    /--viewer-root runner-protocol-build\/extracted\/dist-issue-thread/u,
  );
  assert.match(report, /runner-protocol-eval-campaign\.mjs sanitize/u);
  assert.match(
    report,
    /Upload access-controlled canonical Evalbook and raw attempts/u,
  );
  assert.match(report, /Upload publisher-only sanitized Evalbook/u);
  assert.match(
    report,
    /verify-runner-evalbook-viewer\.mjs --report-root runner-protocol-merged\/public-report/u,
  );
  assert.match(
    report,
    /verify-runner-evalbook-viewer\.mjs --report-root runner-protocol-merged\/report/u,
  );
  assert.match(
    report,
    /--viewer-root runner-protocol-build\/extracted\/dist-issue-thread\s*\\\n\s*--public-viewer/u,
  );
  assert.equal([...report.matchAll(/--viewer-root /gu)].length, 2);

  const publisher = workflow.slice(workflow.indexOf("  publish_history:"));
  assert.match(publisher, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(publisher, /id-token: write/u);
  assert.match(publisher, /runner-protocol-eval-public-/u);
  assert.match(publisher, /publish-runner-protocol-eval-history\.mjs/u);
  assert.match(publisher, /runner-protocol-evals/u);
  assert.match(publisher, /runner-protocol-viewer-/u);
  assert.match(publisher, /PAPERCLIP_RUNNER_PROTOCOL_EVAL_VIEWER_DIR/u);
  assert.match(publisher, /url: \$\{\{ steps\.publish\.outputs\.report_url \}\}/u);
  assert.match(publisher, /Publish versioned report and refresh the root index\n\s+id: publish/u);
  assert.doesNotMatch(publisher, /(?:OPENAI|ANTHROPIC|OPENROUTER)_API_KEY/u);
  assert.doesNotMatch(publisher, /paperclipai\/paperclip-evals/u);
  assert.doesNotMatch(publisher, /downloaded-runner-protocol-evals/u);
});

test("provisions the Codex userns profile before any provider credentials", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const direct = workflow.slice(
    workflow.indexOf("    steps: &direct_eval_steps"),
    workflow.indexOf("  eval_shard_1:"),
  );
  const profile = direct.indexOf("Provision Codex sandbox on the disposable trusted runner");
  const credentials = direct.indexOf("Prepare short-lived AgentCore web identity");
  assert.ok(profile >= 0 && credentials >= 0 && profile < credentials);
  assert.match(direct, /apparmor_restrict_unprivileged_userns/u);
  assert.match(direct, /apparmor_parser/u);
  assert.match(direct, /userns,/u);
  assert.match(direct, /runner-protocol-build\/extracted\/portable/u);
  assert.match(direct, /matrix\.provider == 'codex'/u);
  assert.match(direct, /matrix\.rosterId == 'protocol-live-acpx-codex-control'/u);
  assert.doesNotMatch(direct, /matrix\.profileId/u);
  const build = workflow.slice(
    workflow.indexOf("  build_runner:"),
    workflow.indexOf("  eval_shard_0:"),
  );
  assert.match(build, /Materialize the pinned OpenCode executable before packaging/u);
  assert.match(build, /materialize-opencode-binary\.mjs/u);
});

test("report preparation stays on the trusted lock and install mode", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const report = workflow.slice(
    workflow.indexOf("  report:"),
    workflow.indexOf("  publish_history:"),
  );
  assert.match(report, /ref: \$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(report, /Download resolved target lockfile/u);
  assert.doesNotMatch(report, /Restore resolved target lockfile/u);
  assert.match(report, /Resolve trusted report lockfile without lifecycle scripts/u);
  assert.match(report, /pnpm install --ignore-scripts --no-frozen-lockfile --lockfile-only/u);
  assert.match(report, /pnpm install --frozen-lockfile --ignore-scripts\n/u);
});

test("trusted catalog, direct eval, and report orchestration stay on workflow revision", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  for (const [job, next] of [
    ["  catalog:", "  build_runner:"],
    ["  eval_shard_0:", "  eval_shard_1:"],
    ["  report:", "  publish_history:"],
  ]) {
    const section = workflow.slice(workflow.indexOf(job), workflow.indexOf(next));
    assert.match(section, /ref: \$\{\{ github\.sha \}\}/u, `${job} must use the trusted workflow revision`);
    assert.doesNotMatch(section, /ref: \$\{\{ needs\.authorize\.outputs\.target_sha \}\}/u, `${job} must not execute target orchestration code`);
  }
});
