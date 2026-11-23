import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertAntigravityProviderPackInventory } from "./antigravity-provider-pack-smoke.mjs";
import profiles from "../acpx-profiles.json" with { type: "json" };
import distributions from "../antigravity-distributions.json" with { type: "json" };

const pins = Object.fromEntries(Object.entries(distributions.platforms).filter(([, platform]) => platform.provisioning === "verified-closure")
  .map(([target, platform]) => [target, { closureSha256: platform.closureSha256 }]));
const released = () => { const { qualificationStatus: _pending, ...profile } = profiles.profiles.antigravity; return profile; };

function fixture(profile, target = "linux-x64") {
  const [platform, architecture] = target.split("-");
  const pending = profile.qualificationStatus === "pending";
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload: { target: { platform, architecture },
    [pending ? "candidateProviders" : "providers"]: { antigravity: { version: profile.agentServerVersion,
      qualification: pending ? "pending" : "qualified", profileDigest: profile.commandDigest,
      closureDigest: `sha256:${pins[target].closureSha256}`, path: `provider-assets/antigravity/${target}`, sha256: `sha256:${"a".repeat(64)}` } } } };
}

for (const [name, profile, inventory, other] of [
  ["pending", profiles.profiles.antigravity, "candidateProviders", "providers"],
  ["released", released(), "providers", "candidateProviders"],
]) {
  test(`${name} smoke accepts only the ${inventory} entry with the patched linux-x64 closure`, () => {
    const manifest = fixture(profile);
    assert.equal(assertAntigravityProviderPackInventory(manifest, profile, pins, "linux", "x64"), manifest.payload[inventory].antigravity);
    for (const change of [{ closureDigest: `sha256:${distributions.platforms["linux-x64"].vendorClosureSha256}` },
      { closureDigest: `sha256:${pins["darwin-arm64"].closureSha256}` }, { profileDigest: `sha256:${"b".repeat(64)}` },
      { version: "1.4.3" }, { qualification: inventory === "providers" ? "pending" : "qualified" },
      { path: "provider-assets/antigravity/linux-arm64" }, { sha256: "stale" }, { executable: "agy_acp_server.par" }]) {
      const invalid = structuredClone(manifest); Object.assign(invalid.payload[inventory].antigravity, change);
      assert.throws(() => assertAntigravityProviderPackInventory(invalid, profile, pins, "linux", "x64"));
    }
    const both = structuredClone(manifest); both.payload[other] = { antigravity: both.payload[inventory].antigravity };
    assert.throws(() => assertAntigravityProviderPackInventory(both, profile, pins, "linux", "x64"), /both pack inventories/);
    const moved = structuredClone(manifest); moved.payload[other] = moved.payload[inventory]; delete moved.payload[inventory];
    assert.throws(() => assertAntigravityProviderPackInventory(moved, profile, pins, "linux", "x64"));
  });
}

test("smoke refuses every target other than linux-x64", () => {
  for (const target of ["darwin-arm64", "linux-arm64"]) {
    const [platform, architecture] = target.split("-");
    assert.throws(() => assertAntigravityProviderPackInventory(fixture(profiles.profiles.antigravity, target), profiles.profiles.antigravity, pins, platform, architecture), /only linux-x64/);
  }
});

test("the actual builder smokes Antigravity in either inventory before replacing the retained pack", async () => {
  const source = readFileSync(new URL("./build-provider-pack.mjs", import.meta.url), "utf8");
  const begin = source.indexOf("  if (payload.providers?.antigravity || payload.candidateProviders?.antigravity) {");
  const end = source.indexOf("\n} finally {", begin);
  assert.ok(begin > 0 && end > begin);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("payload", "smokeAntigravityProviderPack", "temporaryRoot", "outputRoot", "process", "rmSync", "renameSync", source.slice(begin, end));
  for (const payload of [{ candidateProviders: { antigravity: {} } }, { providers: { antigravity: {} } }]) {
    for (const failed of [false, true]) {
      const order = [];
      const smoke = async (root, options) => {
        assert.equal(root, "/owned/temporary"); assert.equal(options, undefined, "the build smoke is credential-free");
        order.push("smoke"); if (failed) throw Error("smoke failed"); return { providerPrompts: 0 };
      };
      const work = run(payload, smoke, "/owned/temporary", "/owned/output", { stdout: { write() {} } }, () => order.push("remove-old"), () => order.push("publish"));
      if (failed) { await assert.rejects(work, /smoke failed/); assert.deepEqual(order, ["smoke"]); }
      else { await work; assert.deepEqual(order, ["smoke", "remove-old", "publish"]); }
    }
  }
  let calls = 0;
  await run({ providers: {} }, () => { calls++; }, "/owned/temporary", "/owned/output", { stdout: { write() {} } }, () => {}, () => {});
  assert.equal(calls, 0);
});
