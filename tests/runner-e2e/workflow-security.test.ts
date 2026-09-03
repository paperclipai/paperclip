import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const fullStackTestNeeds =
  /needs:\s*\[\s*authorize,\s*target_lock,\s*catalog,\s*daytona_image,\s*build_runner_artifacts,\s*build_remote_provider_pack,?\s*\]/u;
const buildRunnerNeeds =
  /needs:\s*\[\s*authorize,\s*target_lock,\s*catalog,?\s*\]/u;
const buildRemoteProviderPackNeeds =
  /needs:\s*\[\s*authorize,\s*target_lock,\s*catalog,\s*daytona_image,\s*build_runner_artifacts,?\s*\]/u;

describe("public repository paid workflow security", () => {
  it("gates every provider-secret job with stable actor IDs", async () => {
    const workflows = await Promise.all(
      ["runner-full-stack-e2e.yml", "runner-live-evals.yml", "e2e.yml"].map(
        async (name) => ({
          name,
          contents: await readFile(
            path.join(repositoryRoot, ".github/workflows", name),
            "utf8",
          ),
        }),
      ),
    );

    for (const { name, contents } of workflows) {
      const authorize = contents.indexOf("  authorize:");
      const reauthorize = contents.indexOf("Reauthorize");
      const paidCheckout = contents.indexOf("actions/checkout@", reauthorize);
      const providerAccess = contents.search(
        /(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA)_API_KEY:\s*\$\{\{\s*[^}]*secrets\./,
      );
      expect(
        authorize,
        `${name} must have an authorization job`,
      ).toBeGreaterThan(0);
      expect(
        reauthorize,
        `${name} must reauthorize partial job reruns`,
      ).toBeGreaterThan(authorize);
      expect(
        paidCheckout,
        `${name} must authorize before checkout`,
      ).toBeGreaterThan(reauthorize);
      expect(
        providerAccess,
        `${name} must authorize before provider access`,
      ).toBeGreaterThan(reauthorize);
      expect(contents).toContain("RUNNER_E2E_ALLOWED_ACTOR_IDS");
      expect(contents).toContain("github.actor_id");
      expect(contents).toContain("github.triggering_actor");
      expect(contents).toContain("refs/heads/$DEFAULT_BRANCH");
      expect(contents).toContain("needs: authorize");
      expect(contents).toContain("name: runner-e2e-paid");
      expect(contents).not.toMatch(
        /^\s*(?:pull_request|pull_request_target|push|workflow_call|workflow_run):/m,
      );
      const actionReferences = [
        ...contents.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm),
      ].map((match) => match[1]!);
      expect(actionReferences.length).toBeGreaterThan(0);
      for (const reference of actionReferences) {
        expect(reference).toMatch(/^[^@]+@[0-9a-f]{40}$/);
      }
    }

    const fullStack = workflows[0]!.contents;
    const paidJob = fullStack.slice(
      fullStack.indexOf("  test:"),
      fullStack.indexOf("  report:"),
    );
    const authorizeJob = fullStack.slice(
      fullStack.indexOf("  authorize:"),
      fullStack.indexOf("  target_lock:"),
    );
    const targetLockJob = fullStack.slice(
      fullStack.indexOf("  target_lock:"),
      fullStack.indexOf("  catalog:"),
    );
    expect(authorizeJob).toContain(
      "aws_runner='runs-on/fleet=paperclip-public-pr-x64/env=public-ci'",
    );
    expect(authorizeJob).toContain("github_runner='ubuntu-latest'");
    expect(authorizeJob).toContain(
      "AWS_PAID_RUNNER_ENABLED: ${{ vars.RUNNER_E2E_AWS_ENABLED }}",
    );
    expect(authorizeJob).toContain(
      "Resolve requested repository branch to an immutable commit",
    );
    expect(authorizeJob).toContain(
      "repos/$REPOSITORY/branches/$encoded_branch",
    );
    expect(authorizeJob).toContain('echo "sha=$target_sha"');
    expect(authorizeJob).not.toContain("actions/checkout@");
    expect(authorizeJob).not.toContain("pnpm install");
    expect(targetLockJob).toContain("name: Resolve target pnpm lockfile");
    expect(targetLockJob).toContain("needs: authorize");
    expect(targetLockJob).toContain(
      "ref: ${{ needs.authorize.outputs.target_sha }}",
    );
    expect(targetLockJob).toContain("persist-credentials: false");
    expect(targetLockJob).toContain(
      "pnpm install --ignore-scripts --no-frozen-lockfile --lockfile-only",
    );
    expect(targetLockJob).toContain(
      "artifact_id: ${{ steps.upload.outputs.artifact-id }}",
    );
    expect(targetLockJob).toContain("lock_sha256:");
    expect(targetLockJob).toContain(
      "runner-e2e-target-pnpm-lock-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(targetLockJob).not.toContain("name: runner-e2e-paid");
    expect(targetLockJob).not.toMatch(
      /(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA)_API_KEY/,
    );
    expect(paidJob).toContain(
      "runs-on: ${{ needs.authorize.outputs.test_runner }}",
    );
    expect(paidJob).toMatch(fullStackTestNeeds);
    expect(paidJob).toContain("name: runner-e2e-paid");
    expect(paidJob).toMatch(
      /Reauthorize paid execution before provider access[\s\S]*actions\/checkout@[0-9a-f]{40}[\s\S]*persist-credentials: false[\s\S]*Download resolved target lockfile/,
    );
    const paidInstall = paidJob.indexOf(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    const paidExecution = paidJob.indexOf("- name: Run paid cell");
    expect(paidInstall).toBeGreaterThan(0);
    expect(paidExecution).toBeGreaterThan(paidInstall);
    expect(paidJob.slice(0, paidExecution)).not.toMatch(
      /secrets\.(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA)_API_KEY/,
    );
    expect(authorizeJob).toContain('echo "max_parallel_limit=100"');
    expect(fullStack).toContain('[ "$MAX_PARALLEL_LIMIT" -gt 100 ]');
    expect(fullStack).toContain(
      '[ "$MAX_PARALLEL" -gt "$MAX_PARALLEL_LIMIT" ]',
    );
    expect(fullStack).toContain(
      "group: runner-full-stack-e2e-${{ inputs.target_branch || github.event.repository.default_branch }}",
    );
    expect(fullStack).toContain(
      "cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' && inputs.target_branch != '' && inputs.target_branch != github.event.repository.default_branch }}",
    );
    const targetCodeJobs = [
      fullStack.slice(
        fullStack.indexOf("  catalog:"),
        fullStack.indexOf("  daytona_image:"),
      ),
      fullStack.slice(
        fullStack.indexOf("  daytona_image:"),
        fullStack.indexOf("  build_runner_artifacts:"),
      ),
      fullStack.slice(
        fullStack.indexOf("  build_runner_artifacts:"),
        fullStack.indexOf("  build_remote_provider_pack:"),
      ),
      fullStack.slice(
        fullStack.indexOf("  build_remote_provider_pack:"),
        fullStack.indexOf("  test:"),
      ),
      paidJob,
    ];
    for (const targetCodeJob of targetCodeJobs) {
      const checkout = targetCodeJob.indexOf("actions/checkout@");
      const downloadLock = targetCodeJob.indexOf(
        "Download resolved target lockfile",
      );
      const restoreLock = targetCodeJob.indexOf(
        "Restore resolved target lockfile",
      );
      const setupNode = targetCodeJob.indexOf("actions/setup-node@");
      const install = targetCodeJob.indexOf("pnpm install --frozen-lockfile");
      expect(checkout).toBeGreaterThan(0);
      expect(downloadLock).toBeGreaterThan(checkout);
      expect(restoreLock).toBeGreaterThan(downloadLock);
      if (setupNode >= 0) {
        expect(setupNode).toBeGreaterThan(restoreLock);
      }
      if (install >= 0) {
        expect(install).toBeGreaterThan(restoreLock);
      }
      expect(targetCodeJob).toContain(
        "artifact-ids: ${{ needs.target_lock.outputs.artifact_id }}",
      );
      expect(targetCodeJob).toContain(
        "EXPECTED_LOCK_SHA256: ${{ needs.target_lock.outputs.lock_sha256 }}",
      );
    }
    expect(fullStack.match(/Download resolved target lockfile/g)).toHaveLength(
      5,
    );
    expect(fullStack.match(/Restore resolved target lockfile/g)).toHaveLength(
      5,
    );
    expect(
      fullStack.match(
        /ref: \$\{\{ needs\.authorize\.outputs\.target_sha \}\}/g,
      ),
    ).toHaveLength(6);
    expect(fullStack.match(/ref: \$\{\{ github\.sha \}\}/g)).toHaveLength(2);
    expect(fullStack.match(/persist-credentials: false/g)).toHaveLength(8);
    expect(fullStack).not.toContain("ref: ${{ inputs.target_branch }}");
    expect(fullStack).toContain(
      "PAPERCLIP_RUNNER_SOURCE_REVISION=${TARGET_SHA}",
    );
    const reportJob = fullStack.slice(
      fullStack.indexOf("  report:"),
      fullStack.indexOf("  publish_history:"),
    );
    const historyJob = fullStack.slice(fullStack.indexOf("  publish_history:"));
    expect(reportJob).toContain("ref: ${{ github.sha }}");
    expect(reportJob).not.toContain(
      "ref: ${{ needs.authorize.outputs.target_sha }}",
    );
    expect(reportJob).not.toContain("Download resolved target lockfile");
    expect(historyJob).toContain("ref: ${{ github.sha }}");
    expect(historyJob).not.toContain(
      "ref: ${{ needs.authorize.outputs.target_sha }}",
    );
    expect(historyJob).not.toContain("Download resolved target lockfile");
    for (const [secret, condition] of Object.entries({
      OPENAI_API_KEY: "matrix.credentialName == 'OPENAI_API_KEY'",
      ANTHROPIC_API_KEY: "matrix.credentialName == 'ANTHROPIC_API_KEY'",
      OPENROUTER_API_KEY: "matrix.credentialName == 'OPENROUTER_API_KEY'",
      DAYTONA_API_KEY: "matrix.environmentId == 'daytona'",
    })) {
      expect(fullStack).toContain(
        `${secret}: \${{ ${condition} && secrets.${secret} || '' }}`,
      );
    }
  });

  it("keeps provider credentials inside explicitly gated paid workflows", async () => {
    const workflowDirectory = path.join(repositoryRoot, ".github/workflows");
    const allowedProviderWorkflows = new Set([
      "e2e.yml",
      "runner-full-stack-e2e.yml",
      "runner-live-evals.yml",
    ]);
    const names = (await readdir(workflowDirectory)).filter((name) =>
      /\.ya?ml$/.test(name),
    );

    for (const name of names) {
      const contents = await readFile(
        path.join(workflowDirectory, name),
        "utf8",
      );
      const providerSecretReferences = [
        ...contents.matchAll(
          /secrets(?:\.(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DAYTONA_API_KEY)\b|\[['"](?:OPENAI_API_KEY|ANTHROPIC_API_KEY|OPENROUTER_API_KEY|DAYTONA_API_KEY)['"]\])/g,
        ),
      ];
      if (providerSecretReferences.length > 0) {
        expect(
          allowedProviderWorkflows.has(name),
          `${name} must not receive provider credentials`,
        ).toBe(true);
      }
    }
  });

  it("runs paid scheduled campaigns only on Sundays", async () => {
    const workflows = await Promise.all(
      ["runner-full-stack-e2e.yml", "runner-live-evals.yml"].map((name) =>
        readFile(path.join(repositoryRoot, ".github/workflows", name), "utf8"),
      ),
    );
    for (const workflow of workflows) {
      const crons = [...workflow.matchAll(/cron:\s*"([^"]+)"/g)].map(
        (match) => match[1]!,
      );
      expect(crons).toHaveLength(1);
      expect(crons[0]).toMatch(/^\d{1,2} \d{1,2} \* \* 0$/);
      expect(workflow).toContain("workflow_dispatch:");
    }
  });

  it("builds runner outputs once without provider credentials and verifies them in every paid cell", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/runner-full-stack-e2e.yml"),
      "utf8",
    );
    const buildJobStart = workflow.indexOf("  build_runner_artifacts:");
    const testJobStart = workflow.indexOf("  test:", buildJobStart);
    const reportJobStart = workflow.indexOf("  report:", testJobStart);
    const buildJob = workflow.slice(buildJobStart, testJobStart);
    const testJob = workflow.slice(testJobStart, reportJobStart);

    expect(buildJobStart).toBeGreaterThan(0);
    expect(testJobStart).toBeGreaterThan(buildJobStart);
    expect(buildJob).toMatch(buildRunnerNeeds);
    expect(buildJob).toMatch(buildRemoteProviderPackNeeds);
    expect(buildJob).not.toContain("environment:");
    expect(buildJob).not.toContain("secrets.");
    expect(
      buildJob.match(/pnpm install --frozen-lockfile --ignore-scripts/g),
    ).toHaveLength(2);
    expect(buildJob).toContain(
      "pnpm --filter @paperclipai/paperclip-runner build:typescript",
    );
    expect(buildJob).toContain(
      "pnpm --filter @paperclipai/paperclip-runner build:runner-binaries",
    );
    expect(buildJob).toContain(
      "node packages/paperclip-runner/scripts/build-provider-pack.mjs",
    );
    expect(buildJob).toContain(
      "node packages/paperclip-runner/scripts/materialize-opencode-binary.mjs",
    );
    expect(buildJob).toContain("runner-e2e-build-bundle.tar.gz.sha256");
    expect(buildJob).toContain("runner-e2e-provider-pack.tar.gz.sha256");
    expect(buildJob).toContain(
      "build_artifact_name: ${{ steps.build_artifact_name.outputs.name }}",
    );
    expect(buildJob).toContain(
      "needs.build_runner_artifacts.outputs.build_artifact_name",
    );
    expect(buildJob).toContain(
      "provider_pack_artifact_name: ${{ steps.provider_pack_artifact_name.outputs.name }}",
    );
    expect(workflow).toContain("needs_runner_typescript=");
    expect(workflow).toContain("needs_native_binaries=");
    expect(workflow).toContain("needs_remote_provider_pack=");

    expect(testJob).toMatch(fullStackTestNeeds);
    expect(testJob).toContain("Download immutable campaign outputs");
    expect(testJob).toContain("Download immutable remote provider pack");
    expect(testJob).toContain(
      "needs.build_runner_artifacts.outputs.build_artifact_name",
    );
    expect(testJob).toContain(
      "needs.build_remote_provider_pack.outputs.provider_pack_artifact_name",
    );
    expect(testJob).toContain("sha256sum --check");
    expect(testJob.indexOf("sha256sum --check")).toBeLessThan(
      testJob.indexOf("tar --extract"),
    );
    expect(testJob).toContain(
      "test -x packages/paperclip-runner/runner/target/debug/paperclip-runnerd",
    );
    expect(testJob).toContain(".payload.runnerSourceRevision == $revision");
    expect(workflow).toContain("Qualify local provider Node interpreter");
    expect(testJob).toContain(
      "Materialize verified pinned OpenCode executable",
    );
    expect(testJob).toContain(
      "matrix.profileId == 'legacy-opencode' || matrix.profileId == 'runner-opencode' || matrix.suiteId == 'openrouter-model-breadth'",
    );
    expect(testJob).toContain(
      "node packages/paperclip-runner/scripts/materialize-opencode-binary.mjs",
    );
    expect(testJob).not.toContain("postinstall.mjs");
    expect(testJob).not.toContain("pnpm rebuild");
    expect(testJob).not.toContain("build:typescript");
    expect(testJob).not.toContain("build:runner-binaries");
    expect(testJob).not.toContain("build-provider-pack.mjs");
  });

  it("uses environment-scoped OIDC for a no-delete history publisher", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/runner-full-stack-e2e.yml"),
      "utf8",
    );
    const publisher = workflow.slice(workflow.indexOf("  publish_history:"));
    expect(publisher).toContain("id-token: write");
    expect(publisher).toContain("name: runner-e2e-history");
    expect(publisher).toContain("aws-actions/configure-aws-credentials@");
    expect(publisher).toContain("RUNNER_E2E_HISTORY_AWS_ROLE_ARN");
    expect(publisher).not.toContain("cache: pnpm");
    expect(publisher).not.toMatch(/AWS_(?:ACCESS|SECRET)_KEY/);
    expect(publisher).not.toMatch(/aws s3 (?:rm|sync .*--delete)/);
    expect(workflow).toContain("history_source_ready");
    expect(workflow).toContain(
      "Verify history source report and private screenshot evidence",
    );
    expect(workflow).toContain("private_screenshot=");
    expect(workflow).toContain("Publish pruned immutable history");
    expect(workflow).toContain("Publish latest structured dashboard");
    expect(workflow).not.toContain("dashboard_ready");
    expect(workflow).not.toContain("Publish latest screenshot dashboard");
    expect(
      workflow.indexOf("pnpm test:e2e:runner:history:publish"),
    ).toBeLessThan(workflow.indexOf("actions/upload-pages-artifact@"));
  });
});
