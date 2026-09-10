import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import authorize from "../../.github/scripts/authorize-storybook-pages.cjs";

const ownerFile = ".github/** @cryppadotta @devinfoley @nickyleach @forgottendev\n";
function fixture(overrides = {}) {
  const calls = [];
  const context = {
    repo: { owner: "paperclipai", repo: "paperclip" },
    eventName: "workflow_dispatch",
    ref: "refs/heads/codex/example",
    actor: "cryppadotta",
    ...overrides.context,
  };
  const environment = {
    can_admins_bypass: false,
    protection_rules: [{
      type: "required_reviewers",
      reviewers: [{ type: "User", reviewer: { login: "cryppadotta" } }],
    }],
    ...overrides.environment,
  };
  const github = { rest: { repos: {
    get: async () => ({ data: { default_branch: "master" } }),
    getContent: async (params) => {
      calls.push(params);
      if (overrides.apiError) throw new Error("GitHub unavailable");
      return { data: { encoding: "base64", content: Buffer.from(overrides.codeowners ?? ownerFile).toString("base64") } };
    },
    getEnvironment: async () => ({ data: environment }),
  } } };
  return { github, context, calls };
}

// Tests are serial because the Actions rerunner is an environment variable.
process.env.GITHUB_TRIGGERING_ACTOR = "cryppadotta";
test("allows each current CODEOWNER on a feature branch; reads policy from master", async () => {
  for (const actor of ["cryppadotta", "devinfoley", "nickyleach", "forgottendev"]) {
    const f = fixture({ context: { actor } });
    await authorize(f);
    assert.equal(f.calls[0].ref, "master");
    assert.equal(f.calls[0].path, ".github/CODEOWNERS");
  }
});
test("rejects non-owner initiators", async () => {
  await assert.rejects(authorize(fixture({ context: { actor: "contributor" } })), /Only default-branch CODEOWNERS/);
});
test("rejects non-owner and missing rerunners, including deployment-only reruns", async () => {
  for (const actor of ["contributor", ""]) {
    process.env.GITHUB_TRIGGERING_ACTOR = actor;
    await assert.rejects(authorize(fixture()), /Only default-branch CODEOWNERS/);
  }
  process.env.GITHUB_TRIGGERING_ACTOR = "cryppadotta";
});
test("comments, teams, emails and partial account matches do not grant access", async () => {
  for (const codeowners of [
    "# @cryppadotta\n.github/** @other",
    ".github/** @other # @cryppadotta",
    ".github/** @paperclipai/cryppadotta",
    ".github/** cryppadotta@example.com",
    ".github/** @cryppadotta-extra",
    "",
  ]) await assert.rejects(authorize(fixture({ codeowners })), /CODEOWNERS/);
});
test("case-insensitive GitHub login matching", async () => {
  await authorize(fixture({ context: { actor: "CryppaDotta" } }));
});
test("rejects forks, PR events, automatic events and tags", async () => {
  for (const context of [
    { repo: { owner: "outsider", repo: "paperclip" } },
    { eventName: "pull_request" }, { eventName: "push" },
    { eventName: "workflow_call" }, { ref: "refs/tags/release" },
  ]) await assert.rejects(authorize(fixture({ context })));
});
test("fails closed when GitHub cannot return authoritative CODEOWNERS", async () => {
  await assert.rejects(authorize(fixture({ apiError: true })), /GitHub unavailable/);
});
test("requires CODEOWNER environment reviewers with administrator bypass disabled", async () => {
  for (const environment of [
    { can_admins_bypass: true },
    { protection_rules: [] },
    { protection_rules: [{ type: "required_reviewers", reviewers: [] }] },
    { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "contributor" } }] }] },
    { protection_rules: [{ type: "required_reviewers", reviewers: [{ type: "Team", reviewer: { login: "cryppadotta" } }] }] },
  ]) await assert.rejects(authorize(fixture({ environment })), /must require CODEOWNER reviewers/);
});
test("workflow keeps branch build read-only and reauthorizes the protected deploy", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/storybook-pages.yml", import.meta.url), "utf8");
  const [build, deploy] = workflow.split("  build:")[1].split("  deploy:");
  assert.doesNotMatch(build, /pages: write|id-token: write|secrets\./);
  assert.match(build, /persist-credentials: false/);
  assert.match(deploy, /name: storybook-pages/);
  assert.match(deploy, /authorize-storybook-pages.cjs/);
  assert.match(deploy, /artifact_name: \$\{\{ needs.build.outputs.artifact_name \}\}/);
  assert.doesNotMatch(workflow.split("permissions:")[0], /push:|pull_request:/);
});
