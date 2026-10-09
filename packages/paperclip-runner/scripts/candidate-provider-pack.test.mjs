import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderPackArguments, materializeCandidateProviderPack, providerPackProviders, providerPackManifestFields } from "./candidate-provider-pack.mjs";
import { createHash } from "node:crypto";

// Matches the canonical manifest hashing used by the builder and admission.
function digest(value) {
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
  return createHash("sha256").update(canonical(value)).digest("hex");
}

test("provider manifest digest survives disk JSON on supported and unsupported targets", () => {
  const cursor = { version: "pinned", profileDigest: "sha256:profile", closureDigest: "sha256:closure" };
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    const selected = providerPackProviders(platform, architecture, []);
    const payload = { target: { platform, architecture }, ...providerPackManifestFields(selected.includes("cursor") ? { cursor } : {}, []) };
    const diskPayload = JSON.parse(JSON.stringify(payload));
    assert.deepEqual(diskPayload, payload);
    assert.equal(digest(diskPayload), digest(payload));
    assert.equal(diskPayload.providers?.cursor?.version, selected.includes("cursor") ? "pinned" : undefined);
  }
  const candidate = providerPackManifestFields({ cursor }, ["cursor"]);
  assert.deepEqual(candidate.candidateProviders, { cursor });
  assert.equal(digest(JSON.parse(JSON.stringify(candidate))), digest(candidate));
});

test("candidate selection is explicit", () => {
  assert.deepEqual(parseProviderPackArguments(["--", "/pack"]), { output: "/pack", candidates: [] });
  assert.deepEqual(parseProviderPackArguments(["/pack", "--candidate-providers=pi,cursor"]), { output: "/pack", candidates: ["pi", "cursor"] });
});
test("normal packs include Cursor and Copilot on their three pinned targets without breaking other hosts", () => {
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
    assert.deepEqual(providerPackProviders(platform, architecture, []), ["cursor", "copilot"]);
    assert.deepEqual(providerPackProviders(platform, architecture, ["cursor"]), ["cursor", "copilot"]);
  }
  assert.deepEqual(providerPackProviders("linux", "arm64", []), []);
  assert.deepEqual(providerPackProviders("win32", "x64", []), []);
  assert.deepEqual(providerPackProviders("linux", "arm64", ["cursor"]), ["cursor"]);
});
test("candidate builder cannot admit unknown providers, options or duplicate assets", async () => {
  for (const args of [["--candidate-providers=cursor,cursor"], ["--candidate-providers=other"], ["--executable=/tmp/x"], ["/one", "/two"]]) {
    assert.throws(() => parseProviderPackArguments(args));
  }
  await assert.rejects(materializeCandidateProviderPack({ provider: "arbitrary", outputRoot: "/tmp/unused" }), /Unknown candidate/);
});

test("normal Copilot inventory needs no candidate override and has no duplicate candidate", () => {
  const copilot = { qualification: "qualified", version: "1.0.88" };
  for (const candidates of [[], ["copilot"]]) {
    const fields = providerPackManifestFields({ copilot }, candidates);
    assert.equal(fields.providers.copilot, copilot);
    assert.equal(fields.candidateProviders?.copilot, undefined);
    assert.equal(digest(JSON.parse(JSON.stringify(fields))), digest(fields));
  }
});
