import assert from "node:assert/strict";
import test from "node:test";
import { findMacRuntimeArtifact, isTrustedMacRuntimeProducer } from "./macos-runner-runtime-cache.mjs";

const repository = "paperclipai/paperclip", digest = `sha256:${"a".repeat(64)}`;
const good = { id: 123, repository: { full_name: repository }, path: ".github/workflows/docker.yml", event: "push", head_branch: "master", conclusion: "success", head_sha: "b".repeat(40) };

test("reuses only successful master image builds from the protected repository", () => {
  assert.equal(isTrustedMacRuntimeProducer(good, repository), true);
  for (const change of [{ repository: { full_name: "fork/project" } }, { event: "pull_request" }, { head_branch: "feature" }, { conclusion: "failure" }, { path: ".github/workflows/macos-runner-runtime.yml" }]) {
    assert.equal(isTrustedMacRuntimeProducer({ ...good, ...change }, repository), false);
  }
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
