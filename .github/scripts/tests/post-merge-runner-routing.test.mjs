import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const fleet = "runs-on/fleet=paperclip-post-merge-x64/env=public-ci";
const sha = "a".repeat(40);
const base = {
  repository: "paperclipai/paperclip", repository_id: "1170821064",
  ref: "refs/heads/master", event_name: "push", sha,
};
const expectedJobs = {
  "cloud-readiness.yml": [],
  "cloud-artifacts.yml": ["dispatch_migrator"],
  "release-verify.yml": ["typecheck", "general_tests", "serialized_tests", "runner_workflow_evals", "verify_paperclip_runner", "build"],
  "runner-chaos-evals.yml": ["chaos_and_recovery"],
  "release.yml": ["plan_preview", "package_preview"],
};
for (const [file, expectedNames] of Object.entries(expectedJobs)) {
  const workflow = readFileSync(new URL(`../../workflows/${file}`, import.meta.url), "utf8");
  const jobs = [...workflow.matchAll(/^  ([a-z_]+):\n([\s\S]*?)(?=^  [a-z_]+:\n|(?![\s\S]))/gm)];
  const routed = jobs.filter(([, , body]) => body.includes(fleet));
  test(`${file}: all intended jobs carry the post-merge guard`, () => {
    assert.deepEqual(routed.map(([, name]) => name).sort(), [...expectedNames].sort());
  });
  for (const [, job, body] of routed) {
    const expression = body.match(/^    runs-on: \$\{\{ (.+) \}\}$/m)?.[1];
    assert.ok(expression, `${file}/${job} must use an explicit runner expression`);
    const release = file === "release.yml";
    const checkRef = release || file === "release-verify.yml" || file === "runner-chaos-evals.yml";
    const inputs = { ref: sha, source_ref: sha, channel: "cloud-migrator" };
    const defaultContext = { ...base, event_name: release ? "workflow_dispatch" : "push" };
    const cases = [
      { name: "exact master source", expected: fleet },
      { name: "manual exact master source", github: { event_name: "workflow_dispatch" }, expected: fleet },
      { name: "switch disabled", enabled: "false" },
      { name: "switch absent", enabled: "" },
      { name: "malformed switch", enabled: "yes" },
      { name: "fork", github: { repository: "someone/paperclip", repository_id: "123" } },
      { name: "repository renamed or transferred", github: { repository_id: "123" } },
      { name: "unapproved PR", github: { event_name: "pull_request", ref: "refs/pull/1/merge" } },
      { name: "PR event even with master ref", github: { event_name: "pull_request" } },
      { name: "privileged PR event", github: { event_name: "pull_request_target" } },
      { name: "workflow completion event", github: { event_name: "workflow_run" } },
      { name: "repository dispatch", github: { event_name: "repository_dispatch" } },
      { name: "scheduled caller", github: { event_name: "schedule" } },
      { name: "branch workflow", github: { ref: "refs/heads/feature" } },
      { name: "release tag", github: { ref: "refs/tags/v2026.911.0" } },
    ];
    if (checkRef) {
      const key = release ? "source_ref" : "ref";
      for (const value of ["b".repeat(40), "refs/pull/1/head", "master", "feature", "v1.0.0", ""]) {
        cases.push({ name: `unverified source ${value || "(empty)"}`, inputs: { [key]: value } });
      }
      cases.push({ name: "missing source identity", github: { sha: "" }, inputs: { [key]: "" } });
    }
    if (release) {
      cases.push({ name: "preview of master", inputs: { channel: "preview" } });
      cases.push({ name: "stable release", inputs: { channel: "stable" } });
    }
    for (const { name, github = {}, inputs: overrides = {}, enabled = "true", expected = "ubuntu-latest" } of cases) {
      test(`${file}/${job}: ${name}`, () => {
        const context = { github: { ...defaultContext, ...github }, inputs: { ...inputs, ...overrides }, vars: { AWS_POST_MERGE_CI_ENABLED: enabled } };
        // These canonical contexts use boolean operators and string comparisons
        // whose results match GitHub's expression evaluation.
        assert.equal(runInNewContext(expression, context), expected);
        const timeout = body.match(/^    timeout-minutes: (.+)$/m)?.[1];
        assert.ok(timeout, "AWS jobs need a timeout below the 45-minute instance lifetime");
        const minutes = timeout.startsWith("${{") ? runInNewContext(timeout.slice(3, -2), context) : Number(timeout);
        if (expected === fleet) assert.ok(minutes > 0 && minutes < 45);
        if (release && job === "plan_preview") assert.equal(minutes, expected === fleet ? 10 : 360);
      });
    }
  }
  if (file === "release.yml") {
    test("npm publisher always uses a GitHub-hosted runner", () => {
      const publisher = jobs.find(([ , job]) => job === "publish_preview")?.[2];
      assert.match(publisher, /^    runs-on: ubuntu-latest$/m);
      assert.match(publisher, /^    environment: npm-canary$/m);
      assert.match(publisher, /^      id-token: write$/m);
    });
  }
}


test("Cloud readiness bookkeeping never waits for the AWS verification fleet", () => {
  const workflow = readFileSync(new URL("../../workflows/cloud-readiness.yml", import.meta.url), "utf8");
  const bodies = new Map();
  for (const [name, needs] of [
    ["artifacts", null],
    ["source_verified", "[verify]"],
    ["ready", "[verify, image, artifacts]"],
  ]) {
    const body = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|(?![\\s\\S]))`, "m"))?.[1];
    assert.ok(body, `missing ${name} job`);
    bodies.set(name, body);
    assert.match(body, /^    runs-on: ubuntu-latest$/m);
    assert.doesNotMatch(body, /^ +continue-on-error:|^ +if:.*always\(\)/m);
    assert.match(body, /^    if: github.repository == 'paperclipai\/paperclip' && github.ref == 'refs\/heads\/master'$/m);
    assert.match(body, /^ +SOURCE_SHA: \$\{\{ github.sha \}\}$/m);
    assert.equal(body.match(/^    needs: (.+)$/m)?.[1] ?? null, needs, `${name} prerequisites`);
  }
  assert.match(bodies.get("artifacts"), /^        run: node scripts\/cloud-readiness.mjs "\$SOURCE_SHA"$/m);
  assert.match(bodies.get("source_verified"), /^        run: node --test scripts\/cloud-source-verification.test.mjs$/m);
  assert.match(bodies.get("source_verified"), /echo "Cloud source verified v1: \$SOURCE_SHA"/);
  assert.match(bodies.get("ready"), /echo "Cloud deployable v1: \$SOURCE_SHA"/);
});
