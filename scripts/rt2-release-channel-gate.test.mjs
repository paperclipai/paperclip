import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  evaluateReleaseChannelManifest,
  runReleaseChannelGate,
} from "./rt2-release-channel-gate.mjs";

function makeRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function write(root, rel, content = "evidence") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel.split(path.sep).join("/");
}

function writeJson(root, rel, value) {
  return write(root, rel, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(root, rel) {
  return createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex");
}

function channelTemplate(root, files, channel, version, buildId) {
  return {
    version,
    buildId,
    notes: `${channel} update notes`,
    pubDate: "2026-04-30T00:00:00.000Z",
    rollout: { strategy: channel === "stable" ? "percentage" : "all", percentage: channel === "stable" ? 50 : 100 },
    rollback: {
      version: "2026.429.0",
      buildId: `${channel}-2026.429.0-rollback`,
      reason: "last known good build",
    },
    platforms: {
      "darwin-x86_64": {
        url: `https://releases.example.test/${channel}/RealTycoon2.app.tar.gz`,
        artifact: files.macArtifact,
        checksum: sha256(root, files.macArtifact),
        signature: `trusted-${channel}-macos-signature-content`,
        signingSummary: files.signingSummary,
        signingPlatform: "macos",
      },
      "windows-x86_64": {
        url: `https://releases.example.test/${channel}/RealTycoon2.msi.zip`,
        artifact: files.winArtifact,
        checksum: sha256(root, files.winArtifact),
        signature: `trusted-${channel}-windows-signature-content`,
        signingSummary: files.signingSummary,
        signingPlatform: "windows",
      },
    },
  };
}

function completeFixture(root) {
  const files = {
    macArtifact: write(root, "dist/RealTycoon2.app.tar.gz", "mac artifact bytes"),
    winArtifact: write(root, "dist/RealTycoon2.msi.zip", "windows artifact bytes"),
    signingSummary: writeJson(root, "signing/summary.json", {
      version: 1,
      status: "passed",
      platforms: { macos: true, windows: true },
      counts: { blockers: 0, passed: 9 },
      blockers: [],
      passed: [],
    }),
  };

  return {
    schemaVersion: 1,
    generatedAt: "2026-04-30T00:00:00.000Z",
    installed: {
      channel: "beta",
      version: "2026.430.0",
      buildId: "beta-2026.430.0-current",
    },
    updateState: {
      state: "available",
      checkedAt: "2026-04-30T00:00:00.000Z",
      latestChannel: "beta",
      latestVersion: "2026.430.0",
      failureReason: null,
    },
    channels: {
      internal: channelTemplate(root, files, "internal", "2026.430.0", "internal-2026.430.0-build"),
      beta: channelTemplate(root, files, "beta", "2026.430.0", "beta-2026.430.0-build"),
      stable: channelTemplate(root, files, "stable", "2026.429.0", "stable-2026.429.0-build"),
    },
  };
}

{
  const root = makeRoot("rt2-release-channel-pass");
  const manifest = completeFixture(root);
  const manifestPath = writeJson(root, "fixtures/release-channels.json", manifest);
  const summary = runReleaseChannelGate({
    root,
    manifestPath: path.join(root, manifestPath),
    outputDir: ".planning/native-updater-runs",
    now: new Date("2026-04-30T00:00:00.000Z"),
  });

  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.blockers, 0);
  assert.ok(summary.counts.passed >= 12);
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "summary.json")));
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "report.md")));
  assert.match(buildReport(summary), /RT2 Release Channel Gate/);
}

{
  const root = makeRoot("rt2-release-channel-required");
  const manifest = completeFixture(root);
  delete manifest.channels.stable;
  delete manifest.channels.beta.rollback;
  const result = evaluateReleaseChannelManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("CHANNEL_STABLE_MISSING"));
  assert.ok(codes.includes("ROLLBACK_CANDIDATE_MISSING"));
}

{
  const root = makeRoot("rt2-release-channel-signature");
  const manifest = completeFixture(root);
  manifest.channels.internal.platforms["darwin-x86_64"].signature = "signatures/internal-macos.sig";
  manifest.channels.internal.platforms["windows-x86_64"].signature = "https://releases.example.test/internal.sig";
  const result = evaluateReleaseChannelManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.equal(codes.filter((code) => code === "UPDATER_SIGNATURE_INVALID").length, 2);
}

{
  const root = makeRoot("rt2-release-channel-checksum");
  const manifest = completeFixture(root);
  manifest.channels.beta.platforms["darwin-x86_64"].checksum = "0".repeat(64);
  const result = evaluateReleaseChannelManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("CHANNEL_CHECKSUM_MISMATCH"));
}

{
  const root = makeRoot("rt2-release-channel-signing-blocked");
  const manifest = completeFixture(root);
  const blockedSummary = writeJson(root, "signing/blocked-summary.json", {
    status: "blocker",
    platforms: { macos: true, windows: true },
    blockers: [{ code: "MACOS_NOTARIZATION_MISSING" }],
  });
  manifest.channels.stable.platforms["darwin-x86_64"].signingSummary = blockedSummary;
  const result = evaluateReleaseChannelManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("SIGNING_GATE_BLOCKED"));
}

{
  const root = makeRoot("rt2-release-channel-secret");
  const manifest = completeFixture(root);
  manifest.updaterPrivateKey = "not-a-secret-ref";
  manifest.channels.beta.platforms["windows-x86_64"].signature = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
  const result = evaluateReleaseChannelManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("SECRET_REFERENCE_REQUIRED"));
  assert.ok(codes.includes("SECRET_PRIVATE_KEY_DETECTED"));
}

{
  const root = makeRoot("rt2-release-channel-cli");
  const manifest = completeFixture(root);
  const manifestPath = path.join(root, writeJson(root, "fixtures/release-channels.json", manifest));
  const result = spawnSync(process.execPath, [
    "scripts/rt2-release-channel-gate.mjs",
    "--root",
    root,
    "--manifest",
    manifestPath,
    "--output-dir",
    ".planning/native-updater-runs",
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
}

console.log("rt2-release-channel-gate tests passed");
