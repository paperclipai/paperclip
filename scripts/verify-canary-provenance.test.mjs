import assert from "node:assert/strict";
import test from "node:test";
import { packageProvenance, verifyCanaryProvenance } from "./verify-canary-provenance.mjs";

const sha = "b".repeat(40);
const version = "2026.1116.0-canary.2180000";

function attestation({ name = "%40paperclipai/shared", commit = sha, path = ".github/workflows/release.yml", ref = "refs/heads/master",
  repository = "https://github.com/paperclipai/paperclip", predicateType = "https://slsa.dev/provenance/v1" } = {}) {
  const statement = { subject: [{ name: `pkg:npm/${name}@${version}` }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository, path, ref } }, resolvedDependencies: [{ digest: { gitCommit: commit } }] } } };
  return { attestations: [{ predicateType, bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") } } }] };
}

const check = (doc, packageName = "@paperclipai/shared") => packageProvenance(doc, { packageName, version, sourceSha: sha });
const respond = (body, status = 200) => new Response(JSON.stringify(body), { status });
const noSleep = async () => {};
const registry = (byPackage) => async (url) => {
  const name = decodeURIComponent(new URL(url).pathname.split("/attestations/")[1]).replace(/@[^@]+$/, "");
  const entry = byPackage[name];
  return typeof entry === "function" ? entry() : entry ?? respond({}, 404);
};

test("provenance from master's release workflow at the source commit matches, scoped or not", () => {
  assert.equal(check(attestation()), "match");
  assert.equal(check(attestation({ name: "paperclipai" }), "paperclipai"), "match");
});

test("provenance from another commit, workflow, branch, repository or package is a mismatch", () => {
  for (const overrides of [{ commit: "c".repeat(40) }, { path: ".github/workflows/pr.yml" }, { ref: "refs/heads/feature" },
    { repository: "https://github.com/someone/paperclip" }, { name: "%40paperclipai/server" }]) {
    assert.equal(check(attestation(overrides)), "mismatch", JSON.stringify(overrides));
  }
});

test("a package published through the transparency-log retry has no provenance, which is allowed beside a match", async () => {
  assert.equal(check({ attestations: [] }), "none");
  assert.equal(check(attestation({ predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1" })), "none");
  const result = await verifyCanaryProvenance({ packages: ["@paperclipai/shared", "paperclipai"], version, sourceSha: sha, sleep: noSleep,
    fetcher: registry({ paperclipai: respond(attestation({ name: "paperclipai" })) }) });
  assert.deepEqual(result, { problems: [], matched: 1, withoutProvenance: ["@paperclipai/shared"] });
});

test("packages that all took the retry report no match and no problem, and any mismatch is a problem", async () => {
  const none = await verifyCanaryProvenance({ packages: ["@paperclipai/shared", "paperclipai"], version, sourceSha: sha, sleep: noSleep, fetcher: registry({}) });
  assert.deepEqual(none, { problems: [], matched: 0, withoutProvenance: ["@paperclipai/shared", "paperclipai"] });
  const mixed = await verifyCanaryProvenance({ packages: ["@paperclipai/shared", "paperclipai"], version, sourceSha: sha, sleep: noSleep,
    fetcher: registry({ "@paperclipai/shared": respond(attestation()), paperclipai: respond(attestation({ name: "paperclipai", commit: "c".repeat(40) })) }) });
  assert.equal(mixed.problems.length, 1);
  assert.match(mixed.problems[0], /^paperclipai@.*provenance does not name/);
});

test("a brief npm failure is retried, and a lasting or permanent one is a problem", async () => {
  let calls = 0;
  const flaky = await verifyCanaryProvenance({ packages: ["@paperclipai/shared"], version, sourceSha: sha, sleep: noSleep,
    fetcher: registry({ "@paperclipai/shared": () => (++calls < 3 ? respond({}, 503) : respond(attestation())) }) });
  assert.deepEqual(flaky.problems, []);
  assert.equal(calls, 3);
  const lasting = await verifyCanaryProvenance({ packages: ["@paperclipai/shared"], version, sourceSha: sha, sleep: noSleep, attempts: 3,
    fetcher: async () => { throw new Error("socket hang up"); } });
  assert.match(lasting.problems[0], /attestations unavailable \(socket hang up\)/);
  let forbidden = 0;
  const permanent = await verifyCanaryProvenance({ packages: ["@paperclipai/shared"], version, sourceSha: sha, sleep: noSleep,
    fetcher: async () => { forbidden += 1; return respond({}, 403); } });
  assert.match(permanent.problems[0], /HTTP 403/);
  assert.equal(forbidden, 1);
});

test("inputs are validated before any request", async () => {
  const fetcher = async () => { throw new Error("must not fetch"); };
  await assert.rejects(verifyCanaryProvenance({ packages: ["paperclipai"], version: "2026.1116.0-nightly.1", sourceSha: sha, fetcher }), /not a canary version/);
  await assert.rejects(verifyCanaryProvenance({ packages: ["paperclipai"], version, sourceSha: "abc", fetcher }), /not a full commit SHA/);
});
