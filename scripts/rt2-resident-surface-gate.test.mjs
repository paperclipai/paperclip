import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  evaluateResidentSurfaceManifest,
  runResidentSurfaceGate,
} from "./rt2-resident-surface-gate.mjs";

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

function completeFixture() {
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
    tray: {
      quickCapture: {
        state: "available",
        entrypoint: "native:tray",
        evidence: "tray menu opens quick capture without applying content",
      },
      queue: {
        state: "queued",
        pending: 1,
        failed: 0,
        lastSyncAt: null,
      },
      auth: {
        state: "authenticated",
        externalUserId: "operator-1",
      },
      company: {
        state: "connected",
        companyId: "company-1",
        companyName: "iSens Corp",
      },
      releaseChannel: "beta",
      buildIdentity: "beta-2026.430.0-current",
      updateState: "available",
      failureReason: null,
      statusLabel: "RealTycoon2 beta 2026.430.0 - update available",
      platforms: {
        macos: {
          supported: true,
          evidence: "macOS menu bar status includes capture, queue, auth, company, channel, build, and update state",
        },
        windows: {
          supported: true,
          evidence: "Windows tray status includes capture, queue, auth, company, channel, build, and update state",
        },
      },
    },
    shortcut: {
      accelerator: "CommandOrControl+Shift+Space",
      registration: {
        state: "registered",
        reason: null,
      },
      conflict: {
        state: "none",
        reason: null,
      },
      permission: {
        state: "granted",
        reason: null,
      },
      focus: {
        behavior: "open_or_focus_capture",
        target: "quick_capture",
      },
      privacy: {
        explicitInputOnly: true,
        readsClipboard: false,
        readsSelectedText: false,
        readsScreen: false,
        readsWindowTitle: false,
        readsForegroundApp: false,
      },
      unregister: {
        supported: true,
        evidence: "shortcut is unregistered on disable and shutdown",
      },
      change: {
        supported: true,
        evidence: "shortcut can be changed and old accelerator is unregistered first",
      },
      platforms: {
        macos: {
          supported: true,
          evidence: "macOS global shortcut lifecycle captured",
        },
        windows: {
          supported: true,
          evidence: "Windows global shortcut lifecycle captured",
        },
      },
    },
    captureHandoff: {
      source: "native",
      channels: ["native:tray", "native:global-shortcut"],
      route: "/companies/:companyId/rt2/one-liner/inbound-draft",
      createsPersistentDraft: true,
      requiresReview: true,
      autoApply: false,
      autoPromote: false,
      eventFields: ["eventId", "eventTimestamp", "externalUserId"],
    },
  };
}

function codesFor(manifest, root = makeRoot("rt2-resident-surface-codes")) {
  return evaluateResidentSurfaceManifest({ root, manifest }).blockers.map((blocker) => blocker.code);
}

{
  const root = makeRoot("rt2-resident-surface-pass");
  const manifest = completeFixture();
  const manifestPath = writeJson(root, "fixtures/resident-surface.json", manifest);
  const summary = runResidentSurfaceGate({
    root,
    manifestPath: path.join(root, manifestPath),
    outputDir: ".planning/native-resident-runs",
    now: new Date("2026-04-30T00:00:00.000Z"),
  });

  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.blockers, 0);
  assert.ok(summary.counts.passed >= 10);
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "summary.json")));
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "report.md")));
  assert.match(buildReport(summary), /RT2 Resident Surface Gate/);
  assert.match(buildReport(summary), /Tray Status/);
  assert.match(buildReport(summary), /Shortcut State/);
  assert.match(buildReport(summary), /Capture Handoff/);
}

{
  const manifest = completeFixture();
  delete manifest.tray.quickCapture;
  manifest.tray.queue.state = "";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("TRAY_QUICK_CAPTURE_MISSING"));
  assert.ok(codes.includes("TRAY_QUEUE_STATE_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.updateState.state = "mystery";
  manifest.tray.updateState = "mystery";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("UPDATE_STATE_INVALID"));
}

{
  const manifest = completeFixture();
  manifest.updateState.state = "failed";
  manifest.updateState.failureReason = "download failed";
  manifest.tray.updateState = "failed";
  manifest.tray.failureReason = "";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("TRAY_UPDATE_FAILURE_REASON_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.shortcut.registration.state = "conflict";
  manifest.shortcut.registration.reason = "";
  manifest.shortcut.conflict.state = "detected";
  manifest.shortcut.conflict.reason = "";
  manifest.shortcut.permission.state = "denied";
  manifest.shortcut.permission.reason = "";
  delete manifest.shortcut.unregister;
  delete manifest.shortcut.change;
  const codes = codesFor(manifest);

  assert.ok(codes.includes("SHORTCUT_REGISTRATION_BLOCKED"));
  assert.ok(codes.includes("SHORTCUT_REGISTRATION_REASON_MISSING"));
  assert.ok(codes.includes("SHORTCUT_CONFLICT_BLOCKED"));
  assert.ok(codes.includes("SHORTCUT_CONFLICT_REASON_MISSING"));
  assert.ok(codes.includes("SHORTCUT_PERMISSION_BLOCKED"));
  assert.ok(codes.includes("SHORTCUT_PERMISSION_REASON_MISSING"));
  assert.ok(codes.includes("SHORTCUT_UNREGISTER_MISSING"));
  assert.ok(codes.includes("SHORTCUT_CHANGE_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.shortcut.privacy.readsClipboard = true;
  manifest.shortcut.privacy.explicitInputOnly = false;
  const codes = codesFor(manifest);

  assert.ok(codes.includes("SHORTCUT_PRIVACY_UNSAFE"));
  assert.ok(codes.includes("SHORTCUT_PRIVACY_EXPLICIT_INPUT_REQUIRED"));
}

{
  const manifest = completeFixture();
  manifest.captureHandoff.route = "/companies/:companyId/rt2/tasks/promote";
  manifest.captureHandoff.requiresReview = false;
  manifest.captureHandoff.autoPromote = true;
  const codes = codesFor(manifest);

  assert.ok(codes.includes("CAPTURE_HANDOFF_ROUTE_INVALID"));
  assert.ok(codes.includes("CAPTURE_HANDOFF_REVIEW_BYPASS"));
}

{
  const manifest = completeFixture();
  manifest.shortcut.privateKey = "not-a-secret-ref";
  manifest.tray.token = "ghp_123456789012345678901234567890";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("SECRET_REFERENCE_REQUIRED"));
  assert.ok(codes.includes("SECRET_GITHUB_TOKEN_DETECTED"));
}

{
  const root = makeRoot("rt2-resident-surface-cli");
  const manifest = completeFixture();
  const manifestPath = path.join(root, writeJson(root, "fixtures/resident-surface.json", manifest));
  const result = spawnSync(process.execPath, [
    "scripts/rt2-resident-surface-gate.mjs",
    "--root",
    root,
    "--manifest",
    manifestPath,
    "--output-dir",
    ".planning/native-resident-runs",
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
}

console.log("rt2-resident-surface-gate tests passed");
