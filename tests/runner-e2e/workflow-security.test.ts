import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const ordinaryPrTrustedWorkflowRevision =
  "03609aa6ecc9a047ed53d6b6469d8be554fbc46d";
const fullStackTestNeeds =
  /needs:\s*\[\s*authorize,\s*target_lock,\s*catalog,\s*daytona_image,\s*build_runner_artifacts,\s*build_remote_provider_pack,?\s*\]/u;
const buildRunnerNeeds =
  /needs:\s*\[\s*authorize,\s*target_lock,\s*catalog,?\s*\]/u;
const buildRemoteProviderPackNeeds =
  /needs:\s*\[\s*authorize,\s*target_lock,\s*catalog,\s*daytona_image,\s*build_runner_artifacts,?\s*\]/u;

describe("public repository paid workflow security", () => {
  it("pins ordinary PR CI to the trusted Node-before-pnpm workflow", async () => {
    const ordinaryPrWorkflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/pr.yml"),
      "utf8",
    );
    const trustedWorkflowCalls = [
      ...ordinaryPrWorkflow.matchAll(
        /^\s+uses:\s+(paperclipai\/paperclip\/\.github\/workflows\/pr-trusted\.yml)@([0-9a-f]{40})$/gmu,
      ),
    ];

    expect(trustedWorkflowCalls).toHaveLength(1);
    expect(trustedWorkflowCalls[0]?.[1]).toBe(
      "paperclipai/paperclip/.github/workflows/pr-trusted.yml",
    );
    expect(trustedWorkflowCalls[0]?.[2]).toBe(
      ordinaryPrTrustedWorkflowRevision,
    );
  });

  it("keeps pnpm bootstrap registry telemetry out of trusted workflow setup", async () => {
    for (const workflowName of [
      "runner-full-stack-e2e.yml",
      "pr-trusted.yml",
    ]) {
      const workflow = await readFile(
        path.join(repositoryRoot, ".github/workflows", workflowName),
        "utf8",
      );
      const pnpmSetupSteps = workflow
        .split(/\n(?= {6}- )/u)
        .filter((step) => step.includes("uses: pnpm/action-setup@"));

      expect(pnpmSetupSteps, workflowName).toHaveLength(7);
      for (const step of pnpmSetupSteps) {
        expect(step, workflowName).toContain('NPM_CONFIG_AUDIT: "false"');
        expect(step, workflowName).toContain('NPM_CONFIG_FUND: "false"');
        expect(step, workflowName).toContain(
          'NPM_CONFIG_UPDATE_NOTIFIER: "false"',
        );
      }
      for (const variable of [
        "NPM_CONFIG_AUDIT",
        "NPM_CONFIG_FUND",
        "NPM_CONFIG_UPDATE_NOTIFIER",
      ]) {
        expect(
          workflow.match(new RegExp(`${variable}:`, "gu")),
          workflowName,
        ).toHaveLength(pnpmSetupSteps.length);
      }
    }
  });

  it("installs a modern Node runtime before every trusted pnpm bootstrap", async () => {
    const workflows = [
      {
        name: "runner-full-stack-e2e.yml",
        expectedCachedSetupNodeSteps: 4,
      },
      {
        name: "pr-trusted.yml",
        expectedCachedSetupNodeSteps: 7,
      },
    ];

    for (const { name, expectedCachedSetupNodeSteps } of workflows) {
      const workflow = await readFile(
        path.join(repositoryRoot, ".github/workflows", name),
        "utf8",
      );
      const steps = workflow.split(/\n(?= {6}- )/u);
      const pnpmSetupStepIndexes = steps.flatMap((step, index) =>
        step.includes("uses: pnpm/action-setup@") ? [index] : [],
      );

      expect(pnpmSetupStepIndexes, name).toHaveLength(7);
      for (const pnpmSetupStepIndex of pnpmSetupStepIndexes) {
        const pnpmSetupStep = steps[pnpmSetupStepIndex]!;
        const nodeBootstrapStep = steps[pnpmSetupStepIndex - 1]!;
        expect(nodeBootstrapStep, name).toContain("uses: actions/setup-node@");
        expect(nodeBootstrapStep, name).not.toContain("cache: pnpm");

        const nodeVersionMatch = nodeBootstrapStep.match(
          /^\s*node-version:\s*["']?(\d+)(?:\.(\d+))?/mu,
        );
        expect(nodeVersionMatch, name).not.toBeNull();
        const nodeMajor = Number(nodeVersionMatch![1]);
        const nodeMinor = Number(nodeVersionMatch![2] ?? 0);
        expect(
          nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13),
          `${name} must install Node >=22.13 before pnpm/action-setup`,
        ).toBe(true);

        const conditionPattern = /^ {6}- if:\s*(.+)$/mu;
        expect(nodeBootstrapStep.match(conditionPattern)?.[1] ?? null).toBe(
          pnpmSetupStep.match(conditionPattern)?.[1] ?? null,
        );
      }

      expect(workflow.match(/^\s+cache: pnpm$/gmu), name).toHaveLength(
        expectedCachedSetupNodeSteps,
      );
    }
  });

  it("gates every provider-secret job with stable actor IDs", async () => {
    const workflows = await Promise.all(
      [
        "runner-full-stack-e2e.yml",
        "runner-live-evals.yml",
        "runner-protocol-live-evals.yml",
        "e2e.yml",
      ].map(async (name) => ({
        name,
        contents: await readFile(
          path.join(repositoryRoot, ".github/workflows", name),
          "utf8",
        ),
      })),
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
    const daytonaImageJob = fullStack.slice(
      fullStack.indexOf("  daytona_image:"),
      fullStack.indexOf("  build_runner_artifacts:"),
    );
    expect(authorizeJob).toContain(
      "aws_runner='runs-on/fleet=paperclip-public-pr-x64/env=public-ci'",
    );
    expect(authorizeJob).toContain("github_runner='ubuntu-latest'");
    expect(authorizeJob).toContain(
      "AWS_PAID_RUNNER_ENABLED: ${{ vars.RUNNER_E2E_AWS_ENABLED }}",
    );
    expect(authorizeJob).toContain(
      "playwright_channel: ${{ steps.runner.outputs.playwright_channel }}",
    );
    expect(authorizeJob).toContain('echo "playwright_channel=chrome"');
    expect(authorizeJob).toContain('echo "playwright_channel="');
    expect(authorizeJob).toContain(
      "Resolve requested repository branch to an immutable commit",
    );
    expect(authorizeJob).toContain(
      "repos/$REPOSITORY/branches/$encoded_branch",
    );
    expect(authorizeJob).toContain('echo "sha=$target_sha"');
    expect(authorizeJob).toContain(
      "target_ref: ${{ steps.target.outputs.ref }}",
    );
    expect(authorizeJob).toContain('echo "ref=refs/heads/$TARGET_BRANCH"');
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
    expect(paidJob).toContain(
      "pnpm exec playwright install --with-deps --only-shell chromium",
    );
    expect(paidJob).toContain("name: Qualify preinstalled Chrome");
    expect(paidJob).toContain(
      "if: needs.authorize.outputs.playwright_channel == 'chrome'",
    );
    expect(paidJob).toContain("google-chrome --version");
    expect(paidJob).toContain(
      "if: needs.authorize.outputs.playwright_channel != 'chrome'",
    );
    expect(paidJob).toContain(
      "PAPERCLIP_PLAYWRIGHT_CHANNEL: ${{ needs.authorize.outputs.playwright_channel }}",
    );
    expect(paidJob).not.toContain(
      "pnpm exec playwright install --with-deps chromium",
    );
    const paidInstall = paidJob.indexOf(
      "pnpm install --frozen-lockfile --ignore-scripts",
    );
    const daytonaPluginPreparation = paidJob.indexOf(
      "Prepare bundled Daytona plugin without dependency lifecycle scripts",
    );
    const awsFfmpegInstall = paidJob.indexOf(
      "- name: Install Playwright FFmpeg on AWS runner",
    );
    const hostedChromiumInstall = paidJob.indexOf(
      "- name: Install Chromium headless shell on GitHub-hosted fallback",
    );
    const paidExecution = paidJob.indexOf("- name: Run paid cell");
    expect(paidInstall).toBeGreaterThan(0);
    expect(daytonaPluginPreparation).toBeGreaterThan(paidInstall);
    expect(awsFfmpegInstall).toBeGreaterThan(daytonaPluginPreparation);
    expect(hostedChromiumInstall).toBeGreaterThan(awsFfmpegInstall);
    expect(paidExecution).toBeGreaterThan(awsFfmpegInstall);
    expect(paidExecution).toBeGreaterThan(daytonaPluginPreparation);
    const awsFfmpegStep = paidJob.slice(
      awsFfmpegInstall,
      hostedChromiumInstall,
    );
    expect(awsFfmpegStep).toContain(
      "if: needs.authorize.outputs.playwright_channel == 'chrome'",
    );
    expect(awsFfmpegStep).toContain("pnpm exec playwright install ffmpeg");
    expect(awsFfmpegStep).not.toMatch(
      /(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA)_API_KEY/,
    );
    const preparedBeforeProviderAccess = paidJob.slice(
      daytonaPluginPreparation,
      paidExecution,
    );
    expect(preparedBeforeProviderAccess).toContain(
      "if: matrix.environmentId == 'daytona'",
    );
    expect(preparedBeforeProviderAccess).toContain(
      'test -f "$daytona_root/pnpm-lock.yaml"',
    );
    expect(preparedBeforeProviderAccess).toContain(
      "pnpm install --ignore-workspace --frozen-lockfile --ignore-scripts",
    );
    expect(preparedBeforeProviderAccess).not.toContain("--no-lockfile");
    expect(preparedBeforeProviderAccess).toContain(
      "node scripts/link-plugin-dev-sdk.mjs",
    );
    expect(preparedBeforeProviderAccess).toContain(
      '"@paperclipai/plugin-daytona"',
    );
    expect(preparedBeforeProviderAccess).toContain('"@paperclipai/plugin-sdk"');
    expect(preparedBeforeProviderAccess).toContain(
      'realpath "$daytona_root/node_modules/@paperclipai/plugin-sdk"',
    );
    expect(preparedBeforeProviderAccess).toContain(
      'pnpm --dir "$daytona_root" build',
    );
    expect(preparedBeforeProviderAccess).not.toContain("secrets.");
    expect(preparedBeforeProviderAccess).not.toContain("pnpm rebuild");
    expect(paidJob.slice(0, paidExecution)).not.toMatch(
      /secrets\.(?:OPENAI|ANTHROPIC|OPENROUTER|DAYTONA)_API_KEY/,
    );
    expect(authorizeJob).toContain('echo "max_parallel_limit=100"');
    expect(fullStack).toContain('[ "$MAX_PARALLEL_LIMIT" -gt 100 ]');
    expect(fullStack).toContain(
      '[ "$MAX_PARALLEL" -gt "$MAX_PARALLEL_LIMIT" ]',
    );
    expect(fullStack).toContain(
      "group: runner-full-stack-e2e-${{ github.event_name == 'workflow_dispatch' && inputs.target_branch != '' && inputs.target_branch != github.event.repository.default_branch && format('development-{0}', inputs.target_branch) || format('protected-{0}', github.run_id) }}",
    );
    expect(fullStack).toContain(
      "cancel-in-progress: ${{ github.event_name == 'workflow_dispatch' && inputs.target_branch != '' && inputs.target_branch != github.event.repository.default_branch }}",
    );
    expect(daytonaImageJob).toMatch(
      /- if: needs\.catalog\.outputs\.needs_daytona == 'true'\n\s+uses: actions\/checkout@[0-9a-f]{40}/u,
    );
    for (const stepName of [
      "Download resolved target lockfile",
      "Restore resolved target lockfile",
    ]) {
      expect(daytonaImageJob).toMatch(
        new RegExp(
          `- name: ${stepName}\\n\\s+if: needs\\.catalog\\.outputs\\.needs_daytona == 'true'`,
          "u",
        ),
      );
    }
    expect(daytonaImageJob).toMatch(
      /- name: No Daytona image needed\n\s+id: local_only\n\s+if: needs\.catalog\.outputs\.needs_daytona != 'true'/u,
    );
    expect(daytonaImageJob).toContain('echo "source_revision="');
    expect(daytonaImageJob).toContain('echo "content_id="');
    expect(daytonaImageJob).toContain(
      "IMAGE_CACHE: ghcr.io/paperclipai/paperclip-daytona-runner:e2e-buildcache-amd64",
    );
    expect(daytonaImageJob).toContain(
      "TARGET_REF: ${{ needs.authorize.outputs.target_ref }}",
    );
    expect(daytonaImageJob).toContain(
      "DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}",
    );
    const cacheRead = daytonaImageJob.indexOf(
      '--cache-from "type=registry,ref=${IMAGE_CACHE}"',
    );
    const trustedTargetCheck = daytonaImageJob.indexOf(
      'if [ "$TARGET_REF" = "refs/heads/$DEFAULT_BRANCH" ]; then',
    );
    const cacheWrite = daytonaImageJob.indexOf(
      '--cache-to "type=registry,ref=${IMAGE_CACHE},mode=max"',
    );
    expect(cacheRead).toBeGreaterThan(0);
    expect(trustedTargetCheck).toBeGreaterThan(cacheRead);
    expect(cacheWrite).toBeGreaterThan(trustedTargetCheck);
    expect(daytonaImageJob.slice(trustedTargetCheck, cacheWrite)).not.toContain(
      "secrets.",
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
    expect(fullStack).toContain(
      "if: always() && !cancelled() && needs.catalog.result == 'success'",
    );
    for (const targetProvenanceJob of [paidJob, reportJob]) {
      expect(targetProvenanceJob).toContain(
        "PAPERCLIP_RUNNER_E2E_SOURCE_SHA: ${{ needs.authorize.outputs.target_sha }}",
      );
      expect(targetProvenanceJob).toContain(
        "PAPERCLIP_RUNNER_E2E_SOURCE_REF: ${{ needs.authorize.outputs.target_ref }}",
      );
    }
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
      "runner-protocol-live-evals.yml",
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
      [
        "runner-full-stack-e2e.yml",
        "runner-live-evals.yml",
        "runner-protocol-live-evals.yml",
      ].map((name) =>
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
    expect(buildJob).toContain(
      "runner-e2e-build-${TARGET_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(buildJob).toContain(
      "runner-e2e-provider-pack-${TARGET_SHA}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(buildJob).not.toContain("runner-e2e-build-${GITHUB_SHA}");
    expect(buildJob).not.toContain("runner-e2e-provider-pack-${GITHUB_SHA}");
    expect(workflow).toContain("needs_runner_typescript=");
    expect(workflow).toContain("needs_native_binaries=");
    expect(workflow).toContain("needs_remote_provider_pack=");

    expect(testJob).toMatch(fullStackTestNeeds);
    expect(testJob).toContain("Download immutable campaign outputs");
    expect(
      testJob.match(
        /if: startsWith\(matrix\.profileId, 'runner-'\) \|\| matrix\.suiteId == 'openrouter-model-breadth'/gu,
      ),
    ).toHaveLength(2);
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

  it("uses the reviewed AWS Chrome channel without weakening the local executable override", async () => {
    const config = await readFile(
      path.join(repositoryRoot, "tests/runner-e2e/playwright.config.ts"),
      "utf8",
    );

    expect(config).toContain(
      "process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL?.trim()",
    );
    expect(config).toContain("{ channel: playwrightChannel }");
    expect(config).toContain(
      "process.env.PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE?.trim()",
    );
    expect(config).toContain(
      "PAPERCLIP_PLAYWRIGHT_CHANNEL and PAPERCLIP_RUNNER_E2E_CHROMIUM_EXECUTABLE are mutually exclusive",
    );
  });

  it("binds rerun evidence and Pages artifacts to the exact workflow attempt", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/runner-full-stack-e2e.yml"),
      "utf8",
    );
    const reportStart = workflow.indexOf("  report:");
    const publisherStart = workflow.indexOf("  publish_history:", reportStart);
    const report = workflow.slice(reportStart, publisherStart);
    const publisher = workflow.slice(publisherStart);

    expect(report).toContain("actions: read");
    expect(report).toContain(
      '"repos/$REPOSITORY/actions/runs/$RUN_ID/jobs?filter=all&per_page=100"',
    );
    expect(report).toContain("gh api --paginate --slurp");
    expect(report).toContain(
      '"repos/$REPOSITORY/actions/runs/$RUN_ID/attempts/$attempt"',
    );
    expect(report).toContain("--jq '{run_attempt, run_started_at}'");
    expect(report).toContain("pattern: runner-e2e-${{ github.run_id }}-*-*");
    expect(report).not.toContain(
      "pattern: runner-e2e-${{ github.run_id }}-${{ github.run_attempt }}-*",
    );
    expect(report.match(/merge-multiple: false/g)).toHaveLength(2);
    expect(report).toContain("Select latest workflow attempt per cell");
    expect(report).toContain("tests/runner-e2e/select-rerun-artifacts.ts");
    expect(report).toContain(
      "PAPERCLIP_RUNNER_E2E_REPORT_ROOT: ${{ github.workspace }}/selected-runner-e2e",
    );
    expect(report).toContain(
      "PAPERCLIP_RUNNER_E2E_HISTORY_PUBLIC_BASE_URL: ${{ vars.RUNNER_E2E_HISTORY_PUBLIC_BASE_URL }}",
    );
    expect(report).toContain(
      "PAPERCLIP_RUNNER_E2E_HISTORY_PREFIX: ${{ vars.RUNNER_E2E_HISTORY_PREFIX || 'runner-e2e' }}",
    );
    expect(
      report.indexOf("Select latest workflow attempt per cell"),
    ).toBeLessThan(report.indexOf("Collect blob reports"));
    expect(publisher).toContain(
      'echo "name=github-pages-${{ github.run_id }}-${{ github.run_attempt }}"',
    );
    expect(publisher).toContain(
      "pages_artifact_name: ${{ steps.pages_artifact_name.outputs.name }}",
    );
    expect(publisher).toContain(
      "name: ${{ steps.pages_artifact_name.outputs.name }}",
    );
    expect(publisher).toContain(
      "artifact_name: ${{ needs.publish_history.outputs.pages_artifact_name }}",
    );
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
    expect(workflow).toContain("Verify normalized history source report");
    expect(workflow).not.toContain("sanitized_screenshot=");
    expect(workflow).toContain(
      "Publish S3 history and Pages bundle with declared screenshots",
    );
    expect(workflow).toContain(
      "Publish trusted summary and declared screenshots to public bundles",
    );
    expect(publisher).toContain(
      "pnpm exec playwright install --with-deps --only-shell chromium",
    );
    expect(workflow).toContain(
      "Package pruned dashboard with declared screenshots for GitHub Pages",
    );
    expect(workflow).toContain("path: runner-e2e-merged-report/pages");
    expect(workflow).toContain(
      "Publish latest dashboard with declared screenshots",
    );
    expect(workflow).not.toContain("dashboard_ready");
    expect(workflow).not.toContain("Publish latest screenshot dashboard");
    expect(
      workflow.indexOf("pnpm test:e2e:runner:history:publish"),
    ).toBeLessThan(workflow.indexOf("actions/upload-pages-artifact@"));
  });
});
