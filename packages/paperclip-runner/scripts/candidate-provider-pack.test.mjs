import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderPackArguments, materializeCandidateProviderPack, providerPackProviders, providerPackManifestFields } from "./candidate-provider-pack.mjs";

test("candidate options stay explicit and supported native assets are included by default", () => {
  assert.deepEqual(parseProviderPackArguments(["--", "/pack"]), { output: "/pack", candidates: [] });
  assert.deepEqual(parseProviderPackArguments(["/pack", "--candidate-providers=pi,cursor"]), { output: "/pack", candidates: ["pi", "cursor"] });
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
    assert.deepEqual(providerPackProviders(platform, architecture, []), ["pi", "cursor"]);
    assert.deepEqual(providerPackProviders(platform, architecture, ["cursor", "pi", "copilot"]), ["pi", "cursor", "copilot"]);
  }
  assert.deepEqual(providerPackProviders("linux", "arm64", []), []);
  assert.deepEqual(providerPackProviders("win32", "x64", []), []);
  assert.deepEqual(providerPackProviders("linux", "arm64", ["cursor"]), ["cursor"]);
});
test("serialized manifests include every materialized qualified provider", () => {
  const pi = { qualification: "qualified", profileDigest: "pi-digest" };
  const cursor = { qualification: "qualified", profileDigest: "cursor-digest" };
  const copilot = { qualification: "pending", profileDigest: "copilot-digest" };
  assert.deepEqual(providerPackManifestFields({ pi }, []), { providers: { pi }, candidateProviders: { pi } });
  assert.deepEqual(providerPackManifestFields({ pi, cursor, copilot }, ["copilot"]), {
    providers: { pi, cursor }, candidateProviders: { pi, copilot },
  });
  assert.deepEqual(providerPackManifestFields({}, []), {});
});
test("candidate builder cannot admit unknown providers, options or duplicate assets", async () => {
  for (const args of [["--candidate-providers=cursor,cursor"], ["--candidate-providers=other"], ["--executable=/tmp/x"], ["/one", "/two"]]) {
    assert.throws(() => parseProviderPackArguments(args));
  }
  await assert.rejects(materializeCandidateProviderPack({ provider: "arbitrary", outputRoot: "/tmp/unused" }), /Unknown candidate/);
});

test("Copilot pack selection reaches only the pinned native archive builder", async t => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, redirect: options.redirect, credentials: options.credentials });
    return new Response("corrupt archive");
  });
  await assert.rejects(materializeCandidateProviderPack({ provider: "copilot", outputRoot: "/unused-copilot-build" }), /integrity mismatch/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/registry\.npmjs\.org\/@github\/copilot-(darwin-(arm64|x64)|linux-x64)\/-\/copilot-.*-1\.0\.88\.tgz$/);
  assert.deepEqual({ redirect: requests[0].redirect, credentials: requests[0].credentials }, { redirect: "error", credentials: "omit" });
});

test("Pi pack selection reaches its pinned builder and rejects unsafe output before downloading", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("Unexpected download for invalid Pi output");
  });
  await assert.rejects(materializeCandidateProviderPack({ provider: "pi", outputRoot: "relative-pi-output" }), /Pi distribution output must be absolute/);
  assert.equal(requests, 0);
});
