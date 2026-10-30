import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { grokProfileIdentity, GROK_PROFILE_SOURCE_FILES, GROK_PROFILE_VERSION } from "./grok-profile-identity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
test("the active Grok profile attests its exact admission source", () => {
  const identity = grokProfileIdentity(root);
  const manifest = JSON.parse(readFileSync(join(root, "packages/paperclip-runner/acpx-profiles.json"), "utf8"));
  const fixture = JSON.parse(readFileSync(join(root, `packages/paperclip-runner/test/fixtures/grok-profile-v${GROK_PROFILE_VERSION}-identity.json`), "utf8"));
  assert.deepEqual(identity, fixture);
  assert.equal(manifest.profiles.grok.commandDigest, identity.commandDigest);
  assert.equal(manifest.profiles.grok.agentProfileVersion, GROK_PROFILE_VERSION);
});

for (const contract of [
  "src/drivers/acpx/generated-sidecar-contract.ts",
  "runner/crates/runner-core/src/acpx_provider_backend.rs",
]) test(`changing the Grok field in ${contract} invalidates the identity`, () => {
  const copy = mkdtempSync(join(tmpdir(), "grok-profile-source-"));
  try {
    for (const path of ["packages/paperclip-runner/acpx-profiles.json", ...GROK_PROFILE_SOURCE_FILES,
      `packages/paperclip-runner/${contract}`]) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      copyFileSync(join(root, path), join(copy, path));
    }
    const before = grokProfileIdentity(copy);
    const contractPath = join(copy, "packages/paperclip-runner", contract);
    const source = readFileSync(contractPath, "utf8");
    assert.ok(source.includes('"grokEffort"'));
    writeFileSync(contractPath, source.replace('"grokEffort"', '"obsoleteGrokEffort"'));
    assert.notEqual(grokProfileIdentity(copy).commandDigest, before.commandDigest);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("the generator cannot overwrite a versioned identity after source changes", () => {
  const copy = mkdtempSync(join(tmpdir(), "grok-profile-immutable-"));
  const prefix = "packages/paperclip-runner/";
  const manifest = JSON.parse(readFileSync(join(root, prefix, "acpx-profiles.json"), "utf8"));
  const fixture = `${prefix}test/fixtures/grok-profile-v${GROK_PROFILE_VERSION}-identity.json`;
  const launcher = `${prefix}src/providers/grok/launcher.cjs`;
  const kimiFixture = `${prefix}test/fixtures/kimi-profile-v${manifest.profiles.kimi.agentProfileVersion}-identity.json`;
  const kimiIdentity = JSON.parse(readFileSync(join(root, kimiFixture), "utf8"));
  try {
    for (const path of new Set([...GROK_PROFILE_SOURCE_FILES, ...Object.keys(kimiIdentity.declaration.sources).map(path => prefix + path), kimiFixture, ...[
      "acpx-profiles.json", "cursor-distributions.json", "cursor-contract.json", "antigravity-distributions.json", "package.json",
      "scripts/grok-profile-identity.mjs", "scripts/kimi-profile-identity.mjs", "scripts/generate-acpx-profiles.mjs",
      `test/fixtures/copilot-profile-v${manifest.profiles.copilot.agentProfileVersion}-identity.json`,
      `test-fixtures/pi-acp/profile-v${manifest.profiles.pi.agentProfileVersion}-identity.json`,
    ].map(path => prefix + path), fixture])) {
      mkdirSync(dirname(join(copy, path)), { recursive: true });
      copyFileSync(join(root, path), join(copy, path));
    }
    const protectedFiles = [fixture, launcher, `${prefix}acpx-profiles.json`];
    const before = protectedFiles.map(path => readFileSync(join(copy, path), "utf8"));
    const generate = () => spawnSync(process.execPath, [join(copy, prefix, "scripts/grok-profile-identity.mjs")],
      { cwd: copy, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
    const unchanged = generate();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.deepEqual(protectedFiles.map(path => readFileSync(join(copy, path), "utf8")), before);
    const sidecar = join(copy, prefix, "src/drivers/acpx/generated-sidecar-contract.ts");
    writeFileSync(sidecar, readFileSync(sidecar, "utf8").replace('"grokEffort"', '"obsoleteGrokEffort"'));
    const result = generate();
    assert.deepEqual(protectedFiles.map(path => readFileSync(join(copy, path), "utf8")), before, "a changed identity must be refused before any write");
    assert.notEqual(result.status, 0, "source changes must require a new profile version");
    assert.match(result.stderr, /identity is immutable/);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("profile 14 preserves published 12 and retained 13 while binding the reconciled backend", () => {
  const published = readFileSync(join(root, "packages/paperclip-runner/test/fixtures/grok-profile-v12-identity.json"));
  assert.equal(createHash("sha256").update(published).digest("hex"), "f43ac83f80fde04d8f184529502d3efc0df1b870d0ac8f863a183ae48eb6b004");
  const bytes = readFileSync(join(root, "packages/paperclip-runner/test/fixtures/grok-profile-v13-kimi-historical-identity.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "ce76000eddf14e0c6caca659f40536c986e3101a72babc25c136bfbb0eee6ed5");
  const prior = JSON.parse(bytes.toString("utf8"));
  const current = JSON.parse(readFileSync(join(root, "packages/paperclip-runner/test/fixtures/grok-profile-v14-kimi-historical-identity.json"), "utf8"));
  assert.equal(current.declaration.agentProfileVersion, 14);
  assert.notEqual(current.commandDigest, prior.commandDigest);
  assert.deepEqual(Object.keys(current.declaration.sources).filter(path => current.declaration.sources[path] !== prior.declaration.sources[path]), [
    "packages/paperclip-runner/runner/crates/runner-core/src/acpx_provider_backend.rs",
  ]);
});
