#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docPath = path.join(root, "doc", "NATIVE-DISTRIBUTION-FOUNDATION.md");

function readDoc() {
  assert.ok(fs.existsSync(docPath), "doc/NATIVE-DISTRIBUTION-FOUNDATION.md must exist");
  return fs.readFileSync(docPath, "utf8");
}

function assertIncludes(text, expected) {
  assert.ok(
    text.includes(expected),
    `Expected native distribution foundation doc to include: ${expected}`,
  );
}

function assertHeading(text, heading) {
  assertIncludes(text, `## ${heading}`);
}

const text = readDoc();

for (const heading of [
  "Scope",
  "Native Shell Baseline",
  "Future Package Layout",
  "Runtime Boundary",
  "Platform Capability Boundary",
  "macOS Signing Inventory",
  "Windows Signing Inventory",
  "Updater Key Material",
  "Release Channels",
  "v2.9 Regression Gates",
  "Secret Hygiene",
  "Phase 60-64 Handoff",
]) {
  assertHeading(text, heading);
}

for (const term of [
  "Tauri v2",
  "Electron/electron-builder",
  "apps/desktop",
  "src-tauri",
  "ui/dist",
  "pnpm-lock.yaml",
  "Developer ID Application",
  "hardened runtime",
  "notarization",
  "Gatekeeper",
  "MSIX",
  "timestamping",
  "SmartScreen",
  "updater private key",
  "internal",
  "beta",
  "stable",
  "DRAFT/NATIVE/MSG/REVIEW",
  "persistent draft revision",
  "board review",
  "Phase 60",
  "Phase 61",
  "Phase 62",
  "Phase 63",
  "Phase 64",
]) {
  assertIncludes(text, term);
}

for (const command of [
  "packages/shared/src/rt2-task.test.ts",
  "server/src/__tests__/rt2-task-routes.test.ts",
  "ui/src/lib/rt2-quick-capture-queue.test.ts",
  "ui/src/pages/rt2/QuickCapturePage.test.tsx",
  "ui/src/components/Rt2DailyBoard.test.tsx",
  "pnpm run test:identity-gate",
  "pnpm run rt2:identity-gate",
  "pnpm typecheck",
]) {
  assertIncludes(text, command);
}

const forbiddenSecretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9_]{20,}\b/,
  /\bAPPLE_APP_SPECIFIC_PASSWORD\s*=\s*(?!<secret-ref>)[^\s`]+/,
  /\bTAURI_SIGNING_PRIVATE_KEY\s*=\s*(?!<secret-ref>)[^\s`]+/,
  /\bWINDOWS_SIGNING_CERTIFICATE\s*=\s*(?!<secret-ref>)[^\s`]+/,
];

for (const pattern of forbiddenSecretPatterns) {
  assert.equal(pattern.test(text), false, `Document appears to contain forbidden secret pattern: ${pattern}`);
}

console.log("native distribution foundation document checks passed");
