import assert from "node:assert/strict";
import test from "node:test";
import { findMacRuntimeArtifact, hasVerifiedMacRuntimeJobs, isTrustedMacRuntimeProducer, isTrustedMacRuntimeWorkflowRun } from "./macos-runner-runtime-cache.mjs";

const repository = "paperclipai/paperclip", digest = `sha256:${"a".repeat(64)}`;
const good = { id: 123, repository: { full_name: repository }, path: ".github/workflows/docker.yml", event: "push", head_branch: "master", conclusion: "success", head_sha: "b".repeat(40) };
const verifiedJobs = [
  { name: "macos_runner_runtime / build", status: "completed", conclusion: "success" },
  { name: "macos_runner_runtime / verify_linux_controller", status: "completed", conclusion: "success" },
];

test("reuses only trusted master image builds from the protected repository", () => {
  assert.equal(isTrustedMacRuntimeProducer(good, repository), true);
  assert.equal(isTrustedMacRuntimeWorkflowRun({ ...good, conclusion: "cancelled" }, repository), true);
  for (const change of [{ repository: { full_name: "fork/project" } }, { event: "pull_request" }, { head_branch: "feature" }, { conclusion: "failure" }, { path: ".github/workflows/macos-runner-runtime.yml" }]) {
    assert.equal(isTrustedMacRuntimeProducer({ ...good, ...change }, repository), false);
  }
  assert.equal(hasVerifiedMacRuntimeJobs(verifiedJobs), true);
  assert.equal(hasVerifiedMacRuntimeJobs([verifiedJobs[0]]), false);
  assert.equal(hasVerifiedMacRuntimeJobs([verifiedJobs[0], { ...verifiedJobs[1], conclusion: "cancelled" }]), false);
  assert.equal(hasVerifiedMacRuntimeJobs([verifiedJobs[0], { ...verifiedJobs[1], status: "in_progress", conclusion: null }]), false);
});

test("reuses a verified artifact from a master docker.yml run cancelled downstream, but rejects unverified jobs", async () => {
  const name = `macos-runner-runtime-${digest.slice(7)}`;
  const records = [201, 202].map(id => ({ name, workflow_run: { id }, digest: `sha256:${"c".repeat(64)}` }));
  const fetchImpl = async url => ({
    ok: true,
    json: async () => {
      if (url.includes("actions/artifacts")) return { artifacts: records };
      if (url.endsWith("/actions/runs/201")) return { ...good, id: 201, conclusion: "cancelled" };
      if (url.includes("/actions/runs/201/jobs")) return { jobs: [verifiedJobs[0], { ...verifiedJobs[1], conclusion: "cancelled" }] };
      if (url.endsWith("/actions/runs/202")) return { ...good, id: 202, conclusion: "cancelled" };
      if (url.includes("/actions/runs/202/jobs")) return { jobs: [...verifiedJobs, { name: "Watch exact-source verification", status: "completed", conclusion: "cancelled" }] };
      throw Error(`unexpected url: ${url}`);
    },
  });
  assert.deepEqual(await findMacRuntimeArtifact({ digest, repository, token: "fixture", fetchImpl }), { runId: 202, name });
});

test("a matching artifact from a pull request cannot replace the master runtime", async () => {
  const name = `macos-runner-runtime-${digest.slice(7)}`;
  const records = [12, 123].map(id => ({ name, workflow_run: { id }, digest: `sha256:${"c".repeat(64)}` }));
  const fetchImpl = async url => ({ ok: true, json: async () => url.includes("actions/artifacts")
    ? { artifacts: records } : url.endsWith("/12") ? { ...good, id: 12, event: "pull_request" } : good });
  assert.deepEqual(await findMacRuntimeArtifact({ digest, repository, token: "fixture", fetchImpl }), { runId: 123, name });
});

test("fork builds do not look up or trust another repository's artifacts", async () => {
  assert.equal(await findMacRuntimeArtifact({ digest, repository: "fork/project", token: "fixture", fetchImpl: () => { throw Error("network forbidden"); } }), null);
});
