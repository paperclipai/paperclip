import assert from "node:assert/strict";
import test from "node:test";
import { provenanceProblems, verifyCanaryProvenance } from "./verify-canary-provenance.mjs";

const sha = "b".repeat(40);
const version = "2026.1116.0-canary.21800";

function attestation({ name = "%40paperclipai/shared", commit = sha, path = ".github/workflows/release.yml", ref = "refs/heads/master",
  repository = "https://github.com/paperclipai/paperclip", predicateType = "https://slsa.dev/provenance/v1" } = {}) {
  const statement = { subject: [{ name: `pkg:npm/${name}@${version}` }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository, path, ref } }, resolvedDependencies: [{ digest: { gitCommit: commit } }] } } };
  return { attestations: [{ predicateType, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
}

const check = (doc, packageName = "@paperclipai/shared") => provenanceProblems(doc, { packageName, version, sourceSha: sha });

test("provenance from master's release workflow at the source commit is accepted, scoped or not", () => {
  assert.deepEqual(check(attestation()), []);
  assert.deepEqual(check(attestation({ name: "paperclipai" }), "paperclipai"), []);
});

test("provenance from another commit, workflow, branch, repository or package is rejected", () => {
  for (const overrides of [{ commit: "c".repeat(40) }, { path: ".github/workflows/pr.yml" }, { ref: "refs/heads/feature" },
    { repository: "https://github.com/someone/paperclip" }, { name: "%40paperclipai/server" }]) {
    assert.equal(check(attestation(overrides)).length, 1, JSON.stringify(overrides));
  }
});

test("a package without SLSA provenance is rejected", () => {
  assert.match(check({ attestations: [] })[0], /no SLSA provenance/);
  assert.match(check(attestation({ predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" }))[0], /no SLSA provenance/);
});

test("inputs are validated before any request, and a missing attestation is a problem", async () => {
  const fetcher = async () => { throw new Error("must not fetch"); };
  await assert.rejects(verifyCanaryProvenance({ packages: ["paperclipai"], version: "2026.1116.0-nightly.1", sourceSha: sha, fetcher }), /not a canary version/);
  await assert.rejects(verifyCanaryProvenance({ packages: ["paperclipai"], version, sourceSha: "abc", fetcher }), /not a full commit SHA/);
  const requested = [];
  const problems = await verifyCanaryProvenance({ packages: ["@paperclipai/shared"], version, sourceSha: sha,
    fetcher: async (url) => { requested.push(url); return new Response("missing", { status: 404 }); } });
  assert.deepEqual(requested, [`https://registry.npmjs.org/-/npm/v1/attestations/@paperclipai%2Fshared@${version}`]);
  assert.match(problems[0], /attestations unavailable \(HTTP 404\)/);
});
