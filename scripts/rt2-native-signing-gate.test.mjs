import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  evaluateNativeSigningManifest,
  runNativeSigningGate,
} from "./rt2-native-signing-gate.mjs";

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

function completeFixture(root) {
  const files = {
    macArtifact: write(root, "dist/RealTycoon2.dmg"),
    macHardened: write(root, "evidence/macos-hardened-runtime.txt"),
    macCodesign: write(root, "evidence/macos-codesign.txt"),
    macNotarization: write(root, "evidence/macos-notarization.json"),
    macStapling: write(root, "evidence/macos-stapling.txt"),
    macGatekeeper: write(root, "evidence/macos-gatekeeper.txt"),
    winArtifact: write(root, "dist/RealTycoon2.msix"),
    winSigning: write(root, "evidence/windows-signing.txt"),
    winTimestamp: write(root, "evidence/windows-timestamp.txt"),
    winVerify: write(root, "evidence/windows-verify.txt"),
    winInstall: write(root, "evidence/windows-install-trust.txt"),
  };

  return {
    platforms: {
      macos: {
        owner: "release-ops",
        artifact: files.macArtifact,
        developerIdApplication: "Developer ID Application: iSens Corp. (TEAMID1234)",
        appleTeamId: "TEAMID1234",
        hardenedRuntime: { status: "passed", evidence: files.macHardened },
        codesign: { status: "passed", evidence: files.macCodesign },
        notarization: { status: "passed", submissionId: "notary-submission-123", evidence: files.macNotarization },
        stapling: { status: "passed", evidence: files.macStapling },
        gatekeeper: { status: "passed", evidence: files.macGatekeeper },
      },
      windows: {
        owner: "release-ops",
        artifact: files.winArtifact,
        installerFormat: "msix",
        trustPath: "azure_artifact_signing",
        certificateSource: "secret-ref:WINDOWS_SIGNING_CERTIFICATE",
        signing: { status: "passed", evidence: files.winSigning },
        timestamping: { status: "passed", tsa: "https://timestamp.example.test", evidence: files.winTimestamp },
        signatureVerification: { status: "passed", evidence: files.winVerify },
        installTrust: { status: "passed", evidence: files.winInstall },
      },
    },
  };
}

{
  const root = makeRoot("rt2-native-signing-pass");
  const manifest = completeFixture(root);
  const manifestPath = writeJson(root, "fixtures/native-signing.json", manifest);
  const summary = runNativeSigningGate({
    root,
    manifestPath: path.join(root, manifestPath),
    outputDir: ".planning/native-signing-runs",
    now: new Date("2026-04-30T00:00:00.000Z"),
  });

  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.blockers, 0);
  assert.ok(summary.counts.passed >= 9);
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "summary.json")));
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "report.md")));
  assert.match(buildReport(summary), /RT2 Native Signing Gate/);
}

{
  const root = makeRoot("rt2-native-signing-blockers");
  const manifest = completeFixture(root);
  delete manifest.platforms.macos.notarization;
  manifest.platforms.windows.timestamping = { status: "missing", evidence: "evidence/windows-timestamp.txt" };
  const result = evaluateNativeSigningManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("MACOS_NOTARIZATION_MISSING"));
  assert.ok(codes.includes("WINDOWS_TIMESTAMP_NOT_PASSED"));
}

{
  const root = makeRoot("rt2-native-signing-missing-file");
  const manifest = completeFixture(root);
  manifest.platforms.macos.gatekeeper.evidence = "evidence/missing-gatekeeper.txt";
  manifest.platforms.windows.artifact = "dist/missing.msix";
  const result = evaluateNativeSigningManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("MACOS_GATEKEEPER_EVIDENCE_FILE_MISSING"));
  assert.ok(codes.includes("WINDOWS_ARTIFACT_FILE_MISSING"));
}

{
  const root = makeRoot("rt2-native-signing-secret");
  const manifest = completeFixture(root);
  manifest.platforms.macos.applePassword = "not-a-secret-ref";
  manifest.platforms.windows.signing.evidence = {
    text: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  };
  const result = evaluateNativeSigningManifest({ root, manifest });
  const codes = result.blockers.map((blocker) => blocker.code);

  assert.ok(codes.includes("SECRET_REFERENCE_REQUIRED"));
  assert.ok(codes.includes("SECRET_PRIVATE_KEY_DETECTED"));
}

{
  const root = makeRoot("rt2-native-signing-cli");
  const manifest = completeFixture(root);
  const manifestPath = path.join(root, writeJson(root, "fixtures/native-signing.json", manifest));
  const result = spawnSync(process.execPath, [
    "scripts/rt2-native-signing-gate.mjs",
    "--root",
    root,
    "--manifest",
    manifestPath,
    "--output-dir",
    ".planning/native-signing-runs",
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
}

console.log("rt2-native-signing-gate tests passed");
