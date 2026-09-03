import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

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
      fullStack.indexOf("  catalog:"),
    );
    expect(authorizeJob).toContain(
      "aws_runner='runs-on/fleet=paperclip-public-pr-x64/env=public-ci'",
    );
    expect(authorizeJob).toContain("github_runner='ubuntu-latest-m'");
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
    expect(paidJob).toContain(
      "runs-on: ${{ needs.authorize.outputs.test_runner }}",
    );
    expect(paidJob).toContain("needs: [authorize, catalog, daytona_image]");
    expect(paidJob).toContain("name: runner-e2e-paid");
    expect(paidJob).toMatch(
      /Reauthorize paid execution before provider access[\s\S]*actions\/checkout@[0-9a-f]{40}[\s\S]*persist-credentials: false/,
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
    expect(
      fullStack.match(
        /ref: \$\{\{ needs\.authorize\.outputs\.target_sha \}\}/g,
      ),
    ).toHaveLength(3);
    expect(fullStack.match(/ref: \$\{\{ github\.sha \}\}/g)).toHaveLength(2);
    expect(fullStack.match(/persist-credentials: false/g)).toHaveLength(5);
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
    expect(historyJob).toContain("ref: ${{ github.sha }}");
    expect(historyJob).not.toContain(
      "ref: ${{ needs.authorize.outputs.target_sha }}",
    );
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
