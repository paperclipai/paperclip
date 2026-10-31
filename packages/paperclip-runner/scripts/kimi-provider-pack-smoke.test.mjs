import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { assertKimiProviderPackInventory } from "./kimi-provider-pack-smoke.mjs";
import profiles from "../acpx-profiles.json" with { type: "json" };
import historical from "../test/fixtures/kimi-profile-v14-identity.json" with { type: "json" };
import { KIMI_DISTRIBUTION_CLOSURE_SHA256 as closures } from "../src/drivers/acpx/kimi-closure-pins.ts";

function fixture(profile, target) {
  const [platform, architecture] = target.split("-");
  const pending = profile.qualificationStatus === "pending";
  return { schema: "paperclip-runner/remote-provider-pack/v1", payload: { target: { platform, architecture },
    [pending ? "candidateProviders" : "providers"]: { kimi: { version: profile.agentServerVersion,
      qualification: pending ? "pending" : "qualified", profileDigest: profile.commandDigest,
      closureDigest: `sha256:${closures[target]}`, path: `provider-assets/kimi/${target}`, sha256: `sha256:${"a".repeat(64)}` } } } };
}
for (const target of ["darwin-arm64", "linux-x64"]) {
  test(`ordinary ${target} smoke needs released current17 and no candidate entry`, () => {
    const profile = profiles.profiles.kimi;
    assert.equal(profile.agentProfileVersion, 17);
    assert.notEqual(profile.qualificationStatus, "pending");
    const manifest = fixture(profile, target), [platform, architecture] = target.split("-");
    assert.equal(assertKimiProviderPackInventory(manifest, profile, closures, platform, architecture), manifest.payload.providers.kimi);
    for (const change of [{ profileDigest: historical.commandDigest }, { closureDigest: "sha256:" + "b".repeat(64) },
      { qualification: "pending" }, { path: "provider-assets/kimi/foreign" }]) {
      const invalid = structuredClone(manifest); Object.assign(invalid.payload.providers.kimi, change);
      assert.throws(() => assertKimiProviderPackInventory(invalid, profile, closures, platform, architecture));
    }
    const duplicate = structuredClone(manifest); duplicate.payload.candidateProviders = { kimi: duplicate.payload.providers.kimi };
    assert.throws(() => assertKimiProviderPackInventory(duplicate, profile, closures, platform, architecture));
    assert.throws(() => assertKimiProviderPackInventory(manifest, profile, closures, "linux", "arm64"));
  });
  test(`historical pending14 ${target} remains a distinct inventory contract`, () => {
    const profile = { ...historical.declaration, commandDigest: historical.commandDigest };
    const manifest = fixture(profile, target), [platform, architecture] = target.split("-");
    assert.equal(profile.qualificationStatus, "pending");
    assert.equal(assertKimiProviderPackInventory(manifest, profile, closures, platform, architecture), manifest.payload.candidateProviders.kimi);
    assert.throws(() => assertKimiProviderPackInventory(manifest, profiles.profiles.kimi, closures, platform, architecture));
  });
}

test("the actual builder verifies ordinary Kimi before replacing the retained pack", async () => {
  const source = readFileSync(new URL("./build-provider-pack.mjs", import.meta.url), "utf8");
  const begin = source.indexOf('  if (payload.providers?.kimi && profiles.profiles.kimi.qualificationStatus !== "pending") {');
  const end = source.indexOf('\n} finally {', begin);
  assert.ok(begin > 0 && end > begin);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction("payload", "profiles", "smokeKimiProviderPack", "temporaryRoot", "outputRoot", "process", "rmSync", "renameSync", source.slice(begin, end));
  for (const failed of [false, true]) {
    const order = [], smoke = async root => { assert.equal(root, "/owned/temporary"); order.push("smoke"); if (failed) throw Error("smoke failed"); return { providerPrompts: 0 }; };
    const work = run({ providers: { kimi: {} } }, profiles, smoke, "/owned/temporary", "/owned/output",
      { stdout: { write() {} } }, () => order.push("remove-old"), () => order.push("publish"));
    if (failed) { await assert.rejects(work, /smoke failed/); assert.deepEqual(order, ["smoke"]); }
    else { await work; assert.deepEqual(order, ["smoke", "remove-old", "publish"]); }
  }
  for (const [payload, status] of [[{ candidateProviders: { kimi: {} } }, "pending"], [{ providers: {} }, undefined]]) {
    let calls = 0;
    await run(payload, { profiles: { kimi: { qualificationStatus: status } } }, () => { calls++; }, "/owned/temporary", "/owned/output",
      { stdout: { write() {} } }, () => {}, () => {});
    assert.equal(calls, 0);
  }
});
