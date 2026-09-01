import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

describe("public repository paid workflow security", () => {
  it("gates checkout and secret-bearing jobs with stable actor IDs", async () => {
    const workflow = await readFile(
      path.join(repositoryRoot, ".github/workflows/runner-full-stack-e2e.yml"),
      "utf8",
    );
    const authorize = workflow.indexOf("  authorize:");
    const firstCheckout = workflow.indexOf("actions/checkout@");
    expect(authorize).toBeGreaterThan(0);
    expect(firstCheckout).toBeGreaterThan(authorize);
    expect(workflow).toContain("RUNNER_E2E_ALLOWED_ACTOR_IDS");
    expect(workflow).toContain("github.actor_id");
    expect(workflow).toContain("github.triggering_actor");
    expect(workflow).toContain("needs: authorize");
    expect(workflow).toContain("name: runner-e2e-paid");
    expect(workflow).not.toMatch(/^\s*(?:pull_request|push):/m);
    expect(workflow.indexOf("if ! jq -e")).toBeLessThan(
      workflow.indexOf('if [ "$EVENT_NAME" = schedule ]'),
    );
    const actionReferences = [
      ...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm),
    ].map((match) => match[1]!);
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(actionReferences).toEqual(
      expect.arrayContaining(
        actionReferences.map((reference) =>
          expect.stringMatching(/^[^@]+@[0-9a-f]{40}$/),
        ),
      ),
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
    expect(publisher).not.toMatch(/AWS_(?:ACCESS|SECRET)_KEY/);
    expect(publisher).not.toMatch(/aws s3 (?:rm|sync .*--delete)/);
  });
});
