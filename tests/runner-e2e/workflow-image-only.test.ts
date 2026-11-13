import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("runner full-stack image_only dispatch", () => {
  it("lets image_only dispatches build the Daytona image without reaching any campaign job", async () => {
    const workflowText = await readFile(
      path.join(repositoryRoot, ".github/workflows/runner-full-stack-e2e.yml"),
      "utf8",
    );
    const workflow = parseYaml(workflowText) as {
      on: { workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
      jobs: Record<string, { if?: string; environment?: unknown; steps?: Array<{ name?: string; env?: Record<string, string>; run?: string }> }>;
    };
    expect(workflow.on.workflow_dispatch.inputs.image_only).toMatchObject({ type: "boolean", default: false });

    // Authorization, target resolution, catalog validation and the signed,
    // verified image publication run exactly as in a campaign.
    const imageJobs = ["authorize", "target_lock", "catalog", "daytona_image"];
    // TestOps binding is reachable only through inputs that authorize rejects
    // for image_only dispatches.
    const rejectedByAuthorize = ["testops_selection"];
    const campaignJobs = [
      "build_runner_artifacts",
      "build_remote_provider_pack",
      "test",
      "test_recurring",
      "test_manual_private",
      "report",
      "publish_testops",
      "publish_history",
      "pages",
    ];
    // A new job must be classified here before it can run in an image-only dispatch.
    expect(Object.keys(workflow.jobs).sort()).toEqual(
      [...imageJobs, ...rejectedByAuthorize, ...campaignJobs].sort(),
    );
    for (const name of [...imageJobs, ...rejectedByAuthorize]) {
      expect(String(workflow.jobs[name]!.if ?? ""), name).not.toContain("image_only");
    }
    for (const name of campaignJobs) {
      const condition = String(workflow.jobs[name]!.if ?? "");
      expect(condition, `${name} must skip image_only dispatches`).toMatch(/&& inputs\.image_only != true(?:\s|$)/u);
      // The guard must be a top-level conjunct: no unparenthesized || may bypass it.
      let topLevel = condition;
      while (/\([^()]*\)/u.test(topLevel)) topLevel = topLevel.replace(/\([^()]*\)/gu, "_");
      expect(topLevel, name).not.toContain("||");
    }
    // Every protected paid environment is below the image-only guard.
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (job.environment !== undefined && name !== "testops_selection") {
        expect(campaignJobs, `${name} has a protected environment`).toContain(name);
      }
    }

    const targetStep = workflow.jobs.authorize!.steps!.find(
      step => step.name === "Resolve requested repository branch to an immutable commit",
    )!;
    expect(targetStep.env).toMatchObject({
      IMAGE_ONLY: "${{ inputs.image_only == true }}",
      TESTOPS_REQUESTED: "${{ inputs.ALLURE_JOB_RUN_ID != '' || inputs.testops_case != '' }}",
    });
    expect(targetStep.run).toContain('if [ "$IMAGE_ONLY" = true ] && [ "$TESTOPS_REQUESTED" = true ]; then');
  });
});
