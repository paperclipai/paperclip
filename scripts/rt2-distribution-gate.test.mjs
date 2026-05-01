import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  evaluateDistributionGateManifest,
  runDistributionGate,
} from "./rt2-distribution-gate.mjs";

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

function passedSummary(overrides = {}) {
  return {
    version: 1,
    generatedAt: "2026-05-01T00:10:00.000Z",
    status: "passed",
    counts: { blockers: 0, passed: 8 },
    blockers: [],
    passed: [{ code: "CHECK_PASSED", message: "check passed" }],
    ...overrides,
  };
}

function releaseIdentity(overrides = {}) {
  return {
    channel: "beta",
    version: "2026.501.0",
    buildId: "beta-2026.501.0-current",
    generatedAt: "2026-05-01T01:00:00.000Z",
    maxAgeHours: 24,
    ...overrides,
  };
}

function regressionEvidence(overrides = {}) {
  const commands = [
    {
      id: "shared-rt2-task",
      command: "pnpm exec vitest run --project @paperclipai/shared packages/shared/src/rt2-task.test.ts",
    },
    {
      id: "server-rt2-task-routes",
      command: "pnpm exec vitest run --project @paperclipai/server server/src/__tests__/rt2-task-routes.test.ts",
    },
    {
      id: "ui-quick-capture-queue",
      command: "pnpm exec vitest run --project @paperclipai/ui ui/src/lib/rt2-quick-capture-queue.test.ts",
    },
    {
      id: "ui-quick-capture-page",
      command: "pnpm exec vitest run --project @paperclipai/ui ui/src/pages/rt2/QuickCapturePage.test.tsx",
    },
    {
      id: "ui-daily-board",
      command: "pnpm exec vitest run --project @paperclipai/ui ui/src/components/Rt2DailyBoard.test.tsx",
    },
    { id: "test-identity-gate", command: "pnpm run test:identity-gate" },
    { id: "rt2-identity-gate", command: "pnpm run rt2:identity-gate" },
    { id: "typecheck", command: "pnpm typecheck" },
  ].map((entry, index) => ({
    ...entry,
    status: "passed",
    evidence: `logs/${entry.id}.log`,
    startedAt: `2026-05-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    endedAt: `2026-05-01T00:${String(index).padStart(2, "0")}:10.000Z`,
  }));
  return { commands, ...overrides };
}

function writeSummaries(root, overrides = {}) {
  const installed = {
    channel: "beta",
    version: "2026.501.0",
    buildId: "beta-2026.501.0-current",
  };
  const updateState = {
    state: "available",
    checkedAt: "2026-05-01T00:30:00.000Z",
    latestChannel: "beta",
    latestVersion: "2026.501.0",
    failureReason: null,
  };
  const summaries = {
    signing: passedSummary({
      platforms: { macos: true, windows: true },
    }),
    updater: passedSummary({
      installed,
      updateState,
    }),
    resident: passedSummary({
      installed,
      updateState,
      tray: { releaseChannel: "beta", buildIdentity: "beta-2026.501.0-current", updateState: "available" },
      shortcut: { accelerator: "CommandOrControl+Shift+Space" },
      captureHandoff: { source: "native", requiresReview: true },
    }),
    push: passedSummary({
      registrations: [{ id: "reg-web-1", companyId: "company-1", registrationState: "active" }],
      signals: [{ id: "signal-1", type: "approval_waiting", companyId: "company-1" }],
      deliveries: [{ id: "delivery-1", status: "delivered" }],
      clicks: [{ id: "click-1", reachedTarget: true }],
      captureReliability: {
        metrics: {
          permissionDenied: 0,
          tokenInvalid: 0,
          deliveryFailures: 0,
          retryCount: 1,
          clickThroughCount: 1,
        },
      },
    }),
  };

  const merged = { ...summaries, ...overrides };
  return {
    signing: writeJson(root, "summaries/signing.json", merged.signing),
    updater: writeJson(root, "summaries/updater.json", merged.updater),
    resident: writeJson(root, "summaries/resident.json", merged.resident),
    push: writeJson(root, "summaries/push.json", merged.push),
  };
}

function completeFixture(root, overrides = {}) {
  return {
    schemaVersion: 1,
    release: releaseIdentity(overrides.release),
    summaries: writeSummaries(root, overrides.summaries),
    regressionEvidence: regressionEvidence(overrides.regressionEvidence),
  };
}

function codesFor(manifest, root = makeRoot("rt2-distribution-codes")) {
  return evaluateDistributionGateManifest({ root, manifest }).blockers.map((blocker) => blocker.code);
}

{
  const root = makeRoot("rt2-distribution-pass");
  const manifest = completeFixture(root);
  const manifestPath = writeJson(root, "fixtures/distribution.json", manifest);
  const summary = runDistributionGate({
    root,
    manifestPath: path.join(root, manifestPath),
    outputDir: ".planning/native-distribution-gate-runs",
    now: new Date("2026-05-01T01:00:00.000Z"),
  });

  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.blockers, 0);
  assert.ok(summary.counts.passed >= 12);
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "summary.json")));
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "report.md")));
  assert.match(buildReport(summary), /RT2 Distribution Gate/);
  assert.match(buildReport(summary), /Release Identity/);
  assert.match(buildReport(summary), /Regression Evidence/);
}

{
  const root = makeRoot("rt2-distribution-missing-summary");
  const manifest = completeFixture(root);
  delete manifest.summaries.signing;
  const codes = codesFor(manifest, root);

  assert.ok(codes.includes("SIGNING_SUMMARY_MISSING"));
}

{
  const root = makeRoot("rt2-distribution-blocked-summary");
  const manifest = completeFixture(root, {
    summaries: {
      signing: passedSummary({
        status: "blocker",
        counts: { blockers: 1, passed: 1 },
        blockers: [{ code: "MACOS_NOTARIZATION_MISSING", message: "notarization missing" }],
      }),
    },
  });
  const codes = codesFor(manifest, root);

  assert.ok(codes.includes("SIGNING_SUMMARY_BLOCKED"));
  assert.ok(codes.includes("UPSTREAM_MACOS_NOTARIZATION_MISSING"));
}

{
  const root = makeRoot("rt2-distribution-stale-updater");
  const manifest = completeFixture(root, {
    release: { maxAgeHours: 1 },
    summaries: {
      updater: passedSummary({
        generatedAt: "2026-04-30T00:00:00.000Z",
        installed: {
          channel: "beta",
          version: "2026.501.0",
          buildId: "beta-2026.501.0-current",
        },
        updateState: {
          state: "available",
          checkedAt: "2026-04-30T00:00:00.000Z",
          latestChannel: "beta",
          latestVersion: "2026.501.0",
        },
      }),
    },
  });
  const codes = codesFor(manifest, root);

  assert.ok(codes.includes("UPDATER_SUMMARY_STALE"));
}

{
  const root = makeRoot("rt2-distribution-channel-mismatch");
  const manifest = completeFixture(root, {
    summaries: {
      updater: passedSummary({
        installed: {
          channel: "internal",
          version: "2026.501.0",
          buildId: "internal-2026.501.0-current",
        },
        updateState: {
          state: "available",
          checkedAt: "2026-05-01T00:30:00.000Z",
          latestChannel: "internal",
          latestVersion: "2026.501.0",
        },
      }),
      resident: passedSummary({
        installed: {
          channel: "beta",
          version: "2026.501.0",
          buildId: "beta-2026.501.0-other",
        },
        updateState: {
          state: "available",
          checkedAt: "2026-05-01T00:30:00.000Z",
          latestChannel: "beta",
          latestVersion: "2026.501.0",
        },
      }),
    },
  });
  const codes = codesFor(manifest, root);

  assert.ok(codes.includes("UPDATER_CHANNEL_MISMATCH"));
  assert.ok(codes.includes("RESIDENT_BUILD_MISMATCH"));
}

{
  const root = makeRoot("rt2-distribution-regression");
  const failed = regressionEvidence();
  failed.commands[0].status = "failed";
  failed.commands = failed.commands.filter((command) => command.id !== "typecheck");
  const manifest = completeFixture(root, {
    regressionEvidence: failed,
  });
  const codes = codesFor(manifest, root);

  assert.ok(codes.includes("CAPTURE_REGRESSION_FAILED"));
  assert.ok(codes.includes("CAPTURE_REGRESSION_MISSING"));
}

{
  const root = makeRoot("rt2-distribution-secret");
  const manifest = completeFixture(root);
  manifest.release.privateKey = "raw-private-key";
  manifest.signingToken = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
  const codes = codesFor(manifest, root);

  assert.ok(codes.includes("SECRET_REFERENCE_REQUIRED"));
  assert.ok(codes.includes("SECRET_PRIVATE_KEY_DETECTED"));
}

{
  const root = makeRoot("rt2-distribution-cli");
  const manifest = completeFixture(root);
  const manifestPath = path.join(root, writeJson(root, "fixtures/distribution.json", manifest));
  const result = spawnSync(process.execPath, [
    "scripts/rt2-distribution-gate.mjs",
    "--root",
    root,
    "--manifest",
    manifestPath,
    "--output-dir",
    ".planning/native-distribution-gate-runs",
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
}

console.log("rt2-distribution-gate tests passed");
