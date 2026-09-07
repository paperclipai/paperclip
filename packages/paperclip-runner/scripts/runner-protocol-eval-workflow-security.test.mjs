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

  const publisher = workflow.slice(workflow.indexOf("  publish_history:"));
  assert.match(publisher, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(publisher, /id-token: write/u);
  assert.match(publisher, /runner-protocol-eval-public-/u);
  assert.match(publisher, /publish-runner-protocol-eval-history\.mjs/u);
  assert.match(publisher, /runner-protocol-evals/u);
  assert.doesNotMatch(publisher, /(?:OPENAI|ANTHROPIC|OPENROUTER)_API_KEY/u);
  assert.doesNotMatch(publisher, /paperclipai\/paperclip-evals/u);
  assert.doesNotMatch(publisher, /downloaded-runner-protocol-evals/u);
});
