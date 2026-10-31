import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ACPX_RELEASE_ATTESTATIONS, acpxReleaseAttestation } from "./acpx-release-attestations.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageRoot, "acpx-profiles.json"), "utf8"));
// Providers whose digest the generator computes; installation verifies the rest.
const COMPUTED = Object.keys(manifest.profiles).filter(agent => ACPX_RELEASE_ATTESTATIONS[agent]?.kind !== "installed-command");
const packageFiles = [
  "acpx-profiles.json", "package.json", "cursor-distributions.json", "cursor-contract.json", "antigravity-distributions.json",
  "scripts/acpx-release-attestations.mjs", "scripts/generate-acpx-profiles.mjs",
  "src/providers/grok/launcher.cjs", "src/drivers/acpx/copilot-closure-pins.ts",
  "src/drivers/acpx/pi-closure-pins.ts", "src/drivers/acpx/pi-node-pins.ts",
  "src/drivers/acpx/kimi-closure-pins.ts",
  "src/drivers/acpx/generated-profiles.ts", "runner/crates/runner-core/src/generated_acpx_profiles.rs",
];

/** A relocated runner package containing only the attestation and generator
 * inputs. It has no repository patches: the shared ACPX layer is bound by the
 * profile's acpxVersion and the pack contract digest, never by one provider. */
function relocatedPackage(t) {
  const repository = mkdtempSync(join(tmpdir(), "acpx-attestation-relocated-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const relocated = join(repository, "nested/elsewhere/packages/paperclip-runner");
  for (const path of packageFiles) {
    mkdirSync(dirname(join(relocated, path)), { recursive: true });
    copyFileSync(join(packageRoot, path), join(relocated, path));
  }
  return relocated;
}
const generate = (root, ...args) => spawnSync(process.execPath, [join(root, "scripts/generate-acpx-profiles.mjs"), ...args],
  { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 20_000 });

test("every profile declares how its digest attests the upstream release", async () => {
  assert.deepEqual(Object.keys(ACPX_RELEASE_ATTESTATIONS).sort(), Object.keys(manifest.profiles).sort());
  assert.deepEqual(COMPUTED.sort(), ["antigravity", "copilot", "cursor", "grok", "kimi", "pi"]);
  for (const agent of COMPUTED) {
    assert.equal(manifest.profiles[agent].commandDigest, (await acpxReleaseAttestation(agent, packageRoot)).commandDigest, agent);
  }
});

test("a new provider is told to declare its release attestation", async t => {
  const relocated = relocatedPackage(t);
  const path = join(relocated, "acpx-profiles.json"); const value = JSON.parse(readFileSync(path, "utf8"));
  value.profiles.newagent = { ...value.profiles.codex };
  writeFileSync(path, JSON.stringify(value));
  const result = generate(relocated, "--check");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /newagent needs a release attestation: declare how its commandDigest attests the upstream release/u);
});

test("a relocated copy of the provider inputs computes the same attestations", async t => {
  const relocated = relocatedPackage(t);
  for (const agent of COMPUTED) {
    const here = await acpxReleaseAttestation(agent, packageRoot);
    const there = await acpxReleaseAttestation(agent, relocated);
    assert.equal(there.commandDigest, here.commandDigest, agent);
    assert.doesNotMatch(JSON.stringify(there), new RegExp(`${packageRoot}|${relocated}|tmp`), `${agent} must not bind a location`);
  }
  const checked = generate(relocated, "--check");
  assert.equal(checked.status, 0, checked.stderr);
});

test("the attestations bind no Paperclip source beyond the Grok launcher", async () => {
  for (const agent of ["copilot", "pi", "kimi"]) {
    const { declaration } = await acpxReleaseAttestation(agent, packageRoot);
    assert.deepEqual(Object.keys(declaration).filter(key => /source/iu.test(key)), [], agent);
    assert.deepEqual(Object.keys(declaration.closure).sort(), agent === "kimi"
      ? ["darwin-arm64", "linux-x64"] : ["darwin-arm64", "darwin-x64", "linux-x64"]);
  }
});

for (const [name, agents, edit] of [
  ["an upstream server version", ["copilot"], root => {
    const path = join(root, "acpx-profiles.json"); const value = JSON.parse(readFileSync(path, "utf8"));
    value.profiles.copilot.agentServerVersion = "9.9.9"; writeFileSync(path, JSON.stringify(value));
  }],
  ["a Copilot platform closure", ["copilot"], root => {
    const path = join(root, "src/drivers/acpx/copilot-closure-pins.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace(/"linux-x64": "[a-f0-9]{64}"/u, `"linux-x64": "${"0".repeat(64)}"`));
  }],
  ["a Pi platform closure", ["pi"], root => {
    const path = join(root, "src/drivers/acpx/pi-closure-pins.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace(/"linux-x64": "[a-f0-9]{64}"/u, `"linux-x64": "${"0".repeat(64)}"`));
  }],
  ["a Kimi platform closure", ["kimi"], root => {
    const path = join(root, "src/drivers/acpx/kimi-closure-pins.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace(/"linux-x64": "[a-f0-9]{64}"/u, `"linux-x64": "${"0".repeat(64)}"`));
  }],
  ["the Grok launcher bytes", ["grok"], root => {
    const path = join(root, "src/providers/grok/launcher.cjs");
    writeFileSync(path, `${readFileSync(path, "utf8")}\n// changed\n`);
  }],
  ["the Cursor release declaration", ["cursor"], root => {
    const path = join(root, "cursor-contract.json"); const value = JSON.parse(readFileSync(path, "utf8"));
    value.nativePatch = "changed"; writeFileSync(path, JSON.stringify(value));
  }],
  ["the Antigravity distribution declaration", ["antigravity"], root => {
    const path = join(root, "antigravity-distributions.json"); const value = JSON.parse(readFileSync(path, "utf8"));
    value.version = "9.9.9"; writeFileSync(path, JSON.stringify(value));
  }],
]) test(`changing ${name} changes only the affected attestations`, async t => {
  const relocated = relocatedPackage(t);
  const before = Object.fromEntries(await Promise.all(COMPUTED.map(async agent => [agent, (await acpxReleaseAttestation(agent, relocated)).commandDigest])));
  edit(relocated);
  for (const agent of COMPUTED) {
    const after = (await acpxReleaseAttestation(agent, relocated)).commandDigest;
    if (agents.includes(agent)) assert.notEqual(after, before[agent], agent);
    else assert.equal(after, before[agent], agent);
  }
});

test("the generator refreshes a release declaration's own digest with the profile", async t => {
  const relocated = relocatedPackage(t);
  const path = join(relocated, "cursor-contract.json"); const contract = JSON.parse(readFileSync(path, "utf8"));
  contract.modes = [...contract.modes, "review"];
  writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
  const stale = generate(relocated, "--check");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /cursor commandDigest no longer matches its upstream release attestation/u);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), contract, "check mode writes nothing");
  const refreshed = generate(relocated);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const { commandDigest } = await acpxReleaseAttestation("cursor", relocated);
  assert.notEqual(commandDigest, manifest.profiles.cursor.commandDigest);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).commandDigest, commandDigest);
  assert.equal(JSON.parse(readFileSync(join(relocated, "acpx-profiles.json"), "utf8")).profiles.cursor.commandDigest, commandDigest);
  assert.match(readFileSync(join(relocated, "src/drivers/acpx/generated-profiles.ts"), "utf8"), new RegExp(commandDigest));
  assert.match(readFileSync(join(relocated, "runner/crates/runner-core/src/generated_acpx_profiles.rs"), "utf8"), new RegExp(commandDigest));
  assert.equal(generate(relocated, "--check").status, 0);
});

test("the generator refuses a stale attestation in check mode and refreshes it otherwise", async t => {
  const relocated = relocatedPackage(t);
  const launcher = join(relocated, "src/providers/grok/launcher.cjs");
  writeFileSync(launcher, `${readFileSync(launcher, "utf8")}\n// changed\n`);
  const stale = generate(relocated, "--check");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /grok commandDigest no longer matches its upstream release attestation/u);
  const refreshed = generate(relocated);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  const written = JSON.parse(readFileSync(join(relocated, "acpx-profiles.json"), "utf8"));
  assert.equal(written.profiles.grok.commandDigest, (await acpxReleaseAttestation("grok", relocated)).commandDigest);
  assert.equal(written.profiles.grok.agentProfileVersion, manifest.profiles.grok.agentProfileVersion);
  assert.equal(generate(relocated, "--check").status, 0);
});
