import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Private archive and TestOps trust boundaries for paid Runner workflows.
// Split from workflow-security.test.ts, which owns the rest of the policy.
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const workflows = path.join(repositoryRoot, ".github/workflows");
const environments = ["runner-e2e-private-paid", "runner-e2e-private-history"];

describe("private archive and TestOps workflow trust", () => {
  it("isolates private archive trust from workflows that execute target-branch code", async () => {
    const source = await readFile(path.join(workflows, "runner-full-stack-e2e.yml"), "utf8");
    const trust = await readFile(path.join(repositoryRoot, ".github/infra/runner-e2e-private-history.yml"), "utf8");
    const subjects = [...trust.matchAll(/!Sub 'repo:\$\{GitHubRepository\}:environment:([^']+)'/gu)].map(match => match[1]);
    expect(subjects).toEqual(environments);
    const recurring = source.split("\n  test_recurring:")[1]!.split("\n  report:")[0]!;
    const report = source.split("\n  report:")[1]!.split("\n  publish_history:")[0]!;
    for (const [index, job] of [recurring, report].entries()) {
      expect(job).toContain(`name: ${environments[index]}`);
      expect(job).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
    }
    expect(recurring).toContain("needs.authorize.outputs.target_sha == github.sha");
    for (const filename of await readdir(workflows)) {
      if (!/\.ya?ml$/u.test(filename) || ["runner-full-stack-e2e.yml", "runner-protocol-live-evals.yml"].includes(filename)) continue;
      const other = await readFile(path.join(workflows, filename), "utf8");
      // Checked against the reviewed #18516 rules below.
      if (filename === "chat-catalog-testops-case.yml") continue;

      for (const environment of environments) expect(other, filename).not.toContain(environment);
    }
    const protocol = await readFile(path.join(workflows, "runner-protocol-live-evals.yml"), "utf8");
    expect(protocol).toContain("'runner-e2e-private-paid' || 'runner-e2e-paid'");
    const admission = protocol.split("      - name: Validate accounting mode and retry envelope")[1]!.split("      - name:")[0]!;
    expect(admission).toContain('test "$TARGET_SHA" = "$GITHUB_SHA"');
    const worker = protocol.split("    steps: &direct_eval_steps")[1]!.split("      - uses:")[0]!;
    expect(worker).toContain("test '${{ needs.authorize.outputs.target_sha }}' = \"$GITHUB_SHA\"");
    expect(worker).toContain('test "$GITHUB_RUN_ATTEMPT" = 1');
  });

  it("admits the chat catalog cell to private trust and provider keys only through the guarded dispatcher", async () => {
    const other = await readFile(path.join(workflows, "chat-catalog-testops-case.yml"), "utf8");
    // The reviewed #18516 pilot rules, carried to the full catalog's
    // reusable cell. Trusted master code admits the dispatch and selection
    // before any key; the pinned candidate never sees the TestOps token.
    expect(other).toContain("  workflow_call:");
    expect(other).not.toMatch(/^\s+(?:workflow_dispatch|push|pull_request(?:_target)?|schedule):/mu);
    expect(other).toContain("\n          node tests/runner-e2e/chat-completion-testops-cli.mjs guard\n");
    expect(other).toContain("ref: ${{ github.sha }}");
    expect(other).toContain("TESTOPS_ALLOWED_ACTOR_IDS: ${{ vars.RUNNER_E2E_ALLOWED_ACTOR_IDS }}");
    const chat = other.split("\n  chat:")[1]!.split("\n  report:")[0]!;
    expect(chat).toContain("environment: runner-e2e-private-paid");
    expect(chat).toContain("      - &guard");
    expect(chat).toContain("verify-selection");
    expect(chat).not.toContain("ALLURE_TOKEN");
    expect(chat.indexOf("chat-completion-testops-cli.mjs guard")).toBeLessThan(chat.indexOf("ref: ${{ inputs.target_sha }}"));
    expect(chat.indexOf("verify-selection")).toBeLessThan(chat.indexOf("secrets.OPENROUTER_API_KEY"));
    expect(chat.indexOf("verify-selection")).toBeLessThan(chat.indexOf("secrets.ANTHROPIC_API_KEY"));
    const report = other.split("\n  report:")[1]!.split("\n  upload:")[0]!;
    expect(report).toContain("environment: runner-e2e-private-history");
    expect(report).toContain("manual-private-transfer.ts report-session");
    expect(report).not.toContain("ALLURE_TOKEN");
    expect(report).not.toContain("ref: ${{ inputs.target_sha }}");
    const upload = other.split("\n  upload:")[1]!;
    for (const environment of environments) expect(upload).not.toContain(environment);
    expect(upload).not.toMatch(/secrets\.(?!ALLURE_TOKEN\b)/u);
    // Only the master-only catalog dispatcher calls this cell, with its own
    // guard's pinned source and admitted jobs.
    const callers = (await Promise.all((await readdir(workflows)).filter(name => /\.ya?ml$/u.test(name))
      .map(async name => [name, await readFile(path.join(workflows, name), "utf8")] as const)))
      .filter(([, contents]) => contents.includes("uses: ./.github/workflows/chat-catalog-testops-case.yml"));
    expect(callers.map(([name]) => name)).toEqual(["chat-catalog-testops.yml"]);
    const dispatcher = callers[0]![1];
    expect(dispatcher).toMatch(/^on:\n {2}workflow_dispatch:/mu);
    expect(dispatcher).toContain("github.workflow_ref == 'paperclipai/paperclip/.github/workflows/chat-catalog-testops.yml@refs/heads/master'");
    expect(dispatcher.split("\n  authorize:")[1]!.split("\n  select:")[0]).toContain("run: node tests/runner-e2e/chat-completion-testops-cli.mjs guard");
    const cellJobs = dispatcher.split(/\n(?= {2}[a-z_]+:\n)/u).filter(job => job.includes("uses: ./.github/workflows/chat-catalog-testops-case.yml"));
    expect(cellJobs).toHaveLength(2);
    for (const job of cellJobs) {
      expect(job).toContain("needs: [authorize, select, build]");
      expect(job).toContain("target_sha: ${{ needs.authorize.outputs.target_sha }}");
    }
    const keyed = dispatcher.split(/\n(?= {2}[a-z_]+:\n)/u).filter(job => /secrets\.(?:OPENROUTER|ANTHROPIC)_API_KEY/u.test(job));
    expect(keyed).toEqual(cellJobs);
  });

  it("keeps the full-stack TestOps selection and publication jobs on reviewed code", async () => {
    const fullStack = await readFile(path.join(workflows, "runner-full-stack-e2e.yml"), "utf8");
    for (const [job, next] of [["testops_selection", "catalog"], ["publish_testops", "publish_history"]]) {
      const trusted = fullStack.split(`\n  ${job}:\n`)[1]!.split(`\n  ${next}:\n`)[0]!;
      expect(trusted, job).toContain("ref: ${{ github.sha }}");
      expect(trusted, job).not.toContain("ref: ${{ needs.authorize.outputs.target_sha }}");
      expect(trusted, job).not.toContain("Download resolved target lockfile");
      expect(trusted, job).not.toMatch(/pnpm install|secrets\.(?!ALLURE_TOKEN\b)/u);
    }
  });
});
