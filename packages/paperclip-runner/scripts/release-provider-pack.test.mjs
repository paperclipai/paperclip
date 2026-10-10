import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import profiles from "../acpx-profiles.json" with { type: "json" };
import distributions from "../cursor-distributions.json" with { type: "json" };
import { verifyReleaseProviderPack } from "./release-provider-pack.mjs";

const revision = "a".repeat(40);
const digest = "sha256:" + "b".repeat(64);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);
function fixture() {
  const payload = { target: { platform: "linux", architecture: "x64" }, runnerSourceRevision: revision,
    pins: { acpx: profiles.acpxVersion },
    acpxProfileDigests: Object.fromEntries(["grok", "claude", "codex"].map(agent => [agent, profiles.profiles[agent].commandDigest])),
    providers: { cursor: { version: profiles.profiles.cursor.agentServerVersion, profileDigest: profiles.profiles.cursor.commandDigest,
      closureDigest: `sha256:${distributions.platforms["linux-x64"].closureSha256}`, qualification: "qualified",
      path: "provider-assets/cursor/linux-x64", sha256: digest } } };
  return payload;
}
function seal(payload) { return { schema: "paperclip-runner/remote-provider-pack/v1", payload,
  digest: `sha256:${createHash("sha256").update(canonical(payload)).digest("hex")}` }; }

test("accepts a pack whose source and profiles match the assembled release", () => {
  const manifest = seal(fixture()); assert.equal(verifyReleaseProviderPack(manifest, revision), manifest);
});
for (const field of ["version", "profileDigest", "closureDigest", "qualification", "path"]) {
  test(`rejects an independently rehashed stale Cursor ${field}`, () => {
    const payload = fixture(); payload.providers.cursor[field] = field.endsWith("Digest") ? digest : "stale";
    assert.throws(() => verifyReleaseProviderPack(seal(payload), revision), /Cursor identity/);
  });
}
test("rejects omitted Cursor, conflicting legacy inventory, stale sources and forged payload digests", () => {
  const missing = fixture(); delete missing.providers.cursor;
  assert.throws(() => verifyReleaseProviderPack(seal(missing), revision), /Cursor identity/);
  const mixed = fixture(); mixed.candidateProviders = { cursor: { ...mixed.providers.cursor, profileDigest: digest } };
  assert.throws(() => verifyReleaseProviderPack(seal(mixed), revision), /Cursor identity/);
  const old = fixture(); old.runnerSourceRevision = "c".repeat(40);
  assert.throws(() => verifyReleaseProviderPack(seal(old), revision), /release source/);
  const forged = seal(fixture()); forged.digest = digest;
  assert.throws(() => verifyReleaseProviderPack(forged, revision), /payload digest/);
});

test("release assembly rejects rehashed stale or missing packs before staging any files", () => {
  const root = mkdtempSync(join(tmpdir(), "release-provider-pack-"));
  const source = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    // Run the actual assembler in an isolated layout so it cannot overwrite built artifacts.
    for (const file of ["scripts/stage-release-runner-binaries.mjs", "scripts/release-provider-pack.mjs", "src/live/runner-binary.ts", "acpx-profiles.json", "cursor-distributions.json"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(source, file), join(root, file));
    }
    const platforms = {};
    for (const target of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      const bytes = Buffer.alloc(64);
      if (target === "linux-x64") {
        bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); bytes.writeUInt16LE(62, 18);
      } else {
        bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target === "darwin-arm64" ? 0x0100000c : 0x01000007, 4);
      }
      const path = join(root, target); writeFileSync(path, bytes);
      platforms[target] = { path, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    }
    const payload = fixture(); payload.providers.cursor.profileDigest = digest;
    const bytes = JSON.stringify(seal(payload)), path = join(root, "provider-pack.json"); writeFileSync(path, bytes);
    const manifest = { sourceRevision: revision, platforms, remoteProviderPack: { path, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` } };
    for (const error of [/Cursor identity/, /requires the matching Linux remote provider pack/]) {
      writeFileSync(join(root, "release.json"), JSON.stringify(manifest));
      const result = spawnSync(process.execPath, [join(root, "scripts/stage-release-runner-binaries.mjs"), join(root, "release.json")], { encoding: "utf8" });
      assert.equal(result.status, 1); assert.match(result.stderr, error);
      assert.equal(existsSync(join(root, "dist")), false);
      delete manifest.remoteProviderPack;
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
