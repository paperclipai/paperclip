import test from "node:test";
import assert from "node:assert/strict";
import { parseProviderPackArguments, materializeCandidateProviderPack, materializeAntigravityProviderPack, providerPackProviders, providerPackManifestFields, providerPackQualification } from "./candidate-provider-pack.mjs";
import profiles from "../acpx-profiles.json" with { type: "json" };
import { createHash } from "node:crypto";

async function withCopilotTestPlatform(run) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDescriptor || !archDescriptor) throw new Error("Missing process platform descriptors");
  try {
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
    Object.defineProperty(process, "arch", { ...archDescriptor, value: "x64" });
    return await run();
  } finally {
    try { Object.defineProperty(process, "platform", platformDescriptor); }
    finally { Object.defineProperty(process, "arch", archDescriptor); }
  }
}

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

test("candidate options stay explicit and supported native assets are included by default", () => {
  assert.deepEqual(parseProviderPackArguments(["--", "/pack"]), { output: "/pack", candidates: [] });
  assert.deepEqual(parseProviderPackArguments(["/pack", "--candidate-providers=pi,cursor"]), { output: "/pack", candidates: ["pi", "cursor"] });
  assert.deepEqual(parseProviderPackArguments(["/pack", "--candidate-providers=kimi"]), { output: "/pack", candidates: ["kimi"] });
});

test("released Kimi enters ordinary inventory on only its two supported targets", () => {
  const kimi = { version: "2.3.3", qualification: "qualified", profileDigest: "sha256:profile", closureDigest: "sha256:closure" };
  for (const [platform, architecture] of [["darwin", "arm64"], ["linux", "x64"]]) {
    assert.equal(providerPackProviders(platform, architecture, []).filter(provider => provider === "kimi").length, 1);
    assert.equal(providerPackProviders(platform, architecture, ["kimi"]).filter(provider => provider === "kimi").length, 1);
  }
  for (const [platform, architecture] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.equal(providerPackProviders(platform, architecture, []).includes("kimi"), false);
  }
  for (const candidates of [[], ["kimi"]]) {
    const fields = providerPackManifestFields({ kimi }, candidates);
    assert.equal(fields.providers.kimi, kimi);
    assert.equal(fields.candidateProviders?.kimi, undefined);
    assert.equal(digest(JSON.parse(JSON.stringify(fields))), digest(fields));
  }
});

test("Kimi's candidate builder rejects invalid paths before any public download", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("Unexpected Kimi download"); });
  await assert.rejects(materializeCandidateProviderPack({ provider: "kimi", outputRoot: "relative-kimi-output" }), /Kimi distribution output must be absolute/);
  assert.equal(requests, 0);
});
test("normal packs include Cursor and Copilot on their three pinned targets without breaking other hosts", () => {
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) {
    assert.deepEqual(providerPackProviders(platform, architecture, []), ["pi", "cursor", "copilot", ...((platform === "darwin" && architecture === "arm64") || platform === "linux" ? ["kimi"] : [])]);
    assert.deepEqual(providerPackProviders(platform, architecture, ["cursor"]), providerPackProviders(platform, architecture, []));
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
test("Copilot pack selection reaches only the pinned native archive builder", t => withCopilotTestPlatform(async () => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, redirect: options.redirect, credentials: options.credentials });
    return new Response("corrupt archive");
  });
  await assert.rejects(materializeCandidateProviderPack({ provider: "copilot", outputRoot: "/unused-copilot-build" }), /integrity mismatch/);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^https:\/\/registry\.npmjs\.org\/@github\/copilot-(darwin-(arm64|x64)|linux-x64)\/-\/copilot-.*-1\.0\.88\.tgz$/);
  assert.deepEqual({ redirect: requests[0].redirect, credentials: requests[0].credentials }, { redirect: "error", credentials: "omit" });
}));

test("Pi pack selection reaches its pinned builder and rejects unsafe output before downloading", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests += 1;
    throw new Error("Unexpected download for invalid Pi output");
  });
  await assert.rejects(materializeCandidateProviderPack({ provider: "pi", outputRoot: "relative-pi-output" }), /Pi distribution output must be absolute/);
  assert.equal(requests, 0);
});

test("pending Antigravity is an explicit linux-x64 candidate and never an ordinary provider", () => {
  const antigravity = { version: "1.5.2", qualification: "pending", profileDigest: "sha256:profile", closureDigest: "sha256:closure" };
  assert.equal(profiles.profiles.antigravity.qualificationStatus, "pending");
  assert.deepEqual(parseProviderPackArguments(["/pack", "--candidate-providers=antigravity"]), { output: "/pack", candidates: ["antigravity"] });
  assert.equal(providerPackProviders("linux", "x64", []).includes("antigravity"), false);
  assert.equal(providerPackProviders("linux", "x64", ["antigravity"]).filter(provider => provider === "antigravity").length, 1);
  for (const [platform, architecture] of [["darwin", "arm64"], ["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.equal(providerPackProviders(platform, architecture, []).includes("antigravity"), false);
    assert.throws(() => providerPackProviders(platform, architecture, ["antigravity"]), /only for linux-x64/);
  }
  assert.equal(providerPackQualification("antigravity"), "pending");
  const fields = providerPackManifestFields({ antigravity }, ["antigravity"]);
  assert.deepEqual(fields.candidateProviders, { antigravity });
  assert.equal(fields.providers?.antigravity, undefined);
  assert.equal(providerPackManifestFields({ antigravity }, []).candidateProviders?.antigravity, undefined);
  assert.equal(digest(JSON.parse(JSON.stringify(fields))), digest(fields));
});

test("released Antigravity flips to ordinary linux-x64 inventory with its profile status alone", () => {
  const antigravity = { version: "1.5.2", qualification: "qualified", profileDigest: "sha256:profile", closureDigest: "sha256:closure" };
  const original = profiles.profiles.antigravity.qualificationStatus;
  try {
    delete profiles.profiles.antigravity.qualificationStatus;
    assert.equal(providerPackProviders("linux", "x64", []).filter(provider => provider === "antigravity").length, 1);
    assert.equal(providerPackProviders("linux", "x64", ["antigravity"]).filter(provider => provider === "antigravity").length, 1);
    for (const [platform, architecture] of [["darwin", "arm64"], ["linux", "arm64"]]) {
      assert.equal(providerPackProviders(platform, architecture, []).includes("antigravity"), false);
    }
    assert.equal(providerPackQualification("antigravity"), "qualified");
    for (const candidates of [[], ["antigravity"]]) {
      const fields = providerPackManifestFields({ antigravity }, candidates);
      assert.equal(fields.providers.antigravity, antigravity);
      assert.equal(fields.candidateProviders?.antigravity, undefined);
    }
  } finally { profiles.profiles.antigravity.qualificationStatus = original; }
});

test("Antigravity pack builder keeps only this release's patched closure", async () => {
  const distribution = { version: "1.5.2", closureSha256: "a".repeat(64), vendorClosureSha256: "b".repeat(64), patchVersion: "1.5.2-paperclip.2" };
  const calls = [];
  const build = result => async options => { calls.push(options); return result; };
  const accepted = await materializeAntigravityProviderPack({ outputRoot: "/pack/provider-assets/antigravity/linux-x64", platform: "linux", architecture: "x64", materialize: build(distribution) });
  assert.deepEqual(accepted, { version: "1.5.2", profileDigest: profiles.profiles.antigravity.commandDigest, closureDigest: `sha256:${"a".repeat(64)}` });
  assert.deepEqual(calls[0], { destination: "/pack/provider-assets/antigravity/linux-x64", platform: "linux", architecture: "x64" });
  for (const wrong of [{ closureSha256: "b".repeat(64) }, { patchVersion: undefined }, { version: "1.4.3" }, { closureSha256: "short" }]) {
    await assert.rejects(materializeAntigravityProviderPack({ outputRoot: "/pack", platform: "linux", architecture: "x64", materialize: build({ ...distribution, ...wrong }) }),
      /patched runtime closure/);
  }
  calls.length = 0;
  await assert.rejects(materializeAntigravityProviderPack({ outputRoot: "/pack", platform: "darwin", architecture: "arm64", materialize: build(distribution) }), /only for linux-x64/);
  assert.equal(calls.length, 0);
});

test("Antigravity pack builder repeats only a failed download", async t => {
  t.mock.method(process.stderr, "write", () => true);
  const distribution = { version: "1.5.2", closureSha256: "a".repeat(64), vendorClosureSha256: "b".repeat(64), patchVersion: "1.5.2-paperclip.2" };
  let attempts = 0;
  const flaky = async () => { if (++attempts < 3) throw new Error("Antigravity archive download failed: 503"); return distribution; };
  const result = await materializeAntigravityProviderPack({ outputRoot: "/pack", platform: "linux", architecture: "x64", materialize: flaky, retryDelayMs: 1 });
  assert.equal(result.closureDigest, `sha256:${"a".repeat(64)}`);
  assert.equal(attempts, 3);
  attempts = 0;
  const tampered = async () => { attempts++; throw new Error("Antigravity archive digest mismatch"); };
  await assert.rejects(materializeAntigravityProviderPack({ outputRoot: "/pack", platform: "linux", architecture: "x64", materialize: tampered, retryDelayMs: 1 }), /digest mismatch/);
  assert.equal(attempts, 1);
  attempts = 0;
  const down = async () => { attempts++; throw new TypeError("fetch failed"); };
  await assert.rejects(materializeAntigravityProviderPack({ outputRoot: "/pack", platform: "linux", architecture: "x64", materialize: down, retryDelayMs: 1 }), /fetch failed/);
  assert.equal(attempts, 3);
});
