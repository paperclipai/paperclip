import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  evaluatePushNotificationManifest,
  runPushNotificationGate,
} from "./rt2-push-notification-gate.mjs";

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
    generatedAt: "2026-05-01T00:00:00.000Z",
    registrations: [
      {
        id: "reg-web-1",
        companyId: "company-1",
        userId: "user-1",
        externalUserId: "operator-1",
        deviceId: "device-pwa-1",
        provider: "web_push",
        platform: "pwa",
        registrationState: "active",
        endpointHost: "push.example.test",
        endpointHash: "sha256:web-endpoint-hash",
        publicKeyRef: "vapid-public:current",
        permission: {
          state: "granted",
          evidence: "browser notification permission granted",
        },
      },
      {
        id: "reg-apns-1",
        companyId: "company-1",
        userId: "user-1",
        externalUserId: "operator-1",
        deviceId: "device-ios-1",
        provider: "apns",
        platform: "ios",
        registrationState: "active",
        tokenHash: "sha256:apns-token-hash",
        topic: "com.isens.realtycoon2",
        environment: "sandbox",
        permission: {
          state: "granted",
          evidence: "APNs remote notification permission granted",
        },
      },
    ],
    signals: [
      {
        id: "signal-approval-1",
        type: "approval_waiting",
        companyId: "company-1",
        eventId: "evt-approval-1",
        eventTimestamp: "2026-05-01T00:00:00.000Z",
        target: {
          type: "capture_draft",
          id: "draft-1",
          route: "/companies/company-1/rt2/capture-drafts/draft-1",
        },
        payload: {
          signalType: "approval_waiting",
          companyId: "company-1",
          targetType: "capture_draft",
          targetId: "draft-1",
          route: "/companies/company-1/rt2/capture-drafts/draft-1",
          eventId: "evt-approval-1",
          eventTimestamp: "2026-05-01T00:00:00.000Z",
          title: "RealTycoon2",
          body: "검수할 캡처가 있습니다.",
        },
      },
      {
        id: "signal-failed-sync-1",
        type: "failed_sync",
        companyId: "company-1",
        eventId: "evt-sync-1",
        eventTimestamp: "2026-05-01T00:01:00.000Z",
        target: {
          type: "capture_draft",
          id: "draft-failed-1",
          route: "/companies/company-1/rt2/capture-drafts/draft-failed-1",
        },
        payload: {
          signalType: "failed_sync",
          companyId: "company-1",
          targetType: "capture_draft",
          targetId: "draft-failed-1",
          route: "/companies/company-1/rt2/capture-drafts/draft-failed-1",
          eventId: "evt-sync-1",
          eventTimestamp: "2026-05-01T00:01:00.000Z",
          title: "RealTycoon2",
          body: "전송 실패를 확인하세요.",
        },
      },
      {
        id: "signal-review-1",
        type: "review_requested",
        companyId: "company-1",
        eventId: "evt-review-1",
        eventTimestamp: "2026-05-01T00:02:00.000Z",
        target: {
          type: "board_card",
          id: "issue-1",
          route: "/companies/company-1/rt2/work-board?issueIds=issue-1",
        },
        payload: {
          signalType: "review_requested",
          companyId: "company-1",
          targetType: "board_card",
          targetId: "issue-1",
          route: "/companies/company-1/rt2/work-board?issueIds=issue-1",
          eventId: "evt-review-1",
          eventTimestamp: "2026-05-01T00:02:00.000Z",
          title: "RealTycoon2",
          body: "리뷰 요청이 도착했습니다.",
        },
      },
    ],
    deliveries: [
      {
        id: "delivery-web-1",
        signalId: "signal-approval-1",
        registrationId: "reg-web-1",
        provider: "web_push",
        status: "delivered",
        attemptCount: 1,
        lastAttemptAt: "2026-05-01T00:00:05.000Z",
        evidence: "push service accepted and client displayed notification",
      },
      {
        id: "delivery-apns-1",
        signalId: "signal-review-1",
        registrationId: "reg-apns-1",
        provider: "apns",
        status: "sent",
        attemptCount: 1,
        lastAttemptAt: "2026-05-01T00:02:05.000Z",
        evidence: "APNs provider accepted notification request",
      },
      {
        id: "delivery-retry-1",
        signalId: "signal-failed-sync-1",
        registrationId: "reg-web-1",
        provider: "web_push",
        status: "retry_scheduled",
        attemptCount: 2,
        lastAttemptAt: "2026-05-01T00:01:05.000Z",
        errorCode: "WEB_PUSH_503",
        retry: {
          decision: "scheduled",
          nextAttemptAt: "2026-05-01T00:06:05.000Z",
          reason: "push service temporary failure",
        },
        evidence: "bounded retry scheduled after provider 503",
      },
    ],
    clicks: [
      {
        id: "click-web-1",
        deliveryId: "delivery-web-1",
        signalId: "signal-approval-1",
        registrationId: "reg-web-1",
        clickedAt: "2026-05-01T00:00:20.000Z",
        route: "/companies/company-1/rt2/capture-drafts/draft-1",
        reachedTarget: true,
        target: {
          type: "capture_draft",
          id: "draft-1",
        },
        evidence: "service worker notificationclick opened capture review route",
      },
      {
        id: "click-apns-1",
        deliveryId: "delivery-apns-1",
        signalId: "signal-review-1",
        registrationId: "reg-apns-1",
        clickedAt: "2026-05-01T00:02:20.000Z",
        route: "/companies/company-1/rt2/work-board?issueIds=issue-1",
        reachedTarget: true,
        target: {
          type: "board_card",
          id: "issue-1",
        },
        evidence: "native deep link opened board review target",
      },
    ],
    captureReliability: {
      reportPath: "/companies/company-1/rt2/capture-drafts/reliability-report",
      metrics: {
        permissionDenied: 0,
        tokenInvalid: 0,
        deliveryFailures: 0,
        retryCount: 1,
        clickThroughCount: 2,
      },
      evidence: "push metrics are represented beside capture reliability report",
    },
  };
}

function codesFor(manifest, root = makeRoot("rt2-push-codes")) {
  return evaluatePushNotificationManifest({ root, manifest }).blockers.map((blocker) => blocker.code);
}

{
  const root = makeRoot("rt2-push-pass");
  const manifest = completeFixture();
  const manifestPath = writeJson(root, "fixtures/push-notification.json", manifest);
  const summary = runPushNotificationGate({
    root,
    manifestPath: path.join(root, manifestPath),
    outputDir: ".planning/native-push-runs",
    now: new Date("2026-05-01T00:00:00.000Z"),
  });

  assert.equal(summary.status, "passed");
  assert.equal(summary.counts.blockers, 0);
  assert.ok(summary.counts.passed >= 10);
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "summary.json")));
  assert.ok(fs.existsSync(path.join(summary.runDirAbs, "report.md")));
  assert.match(buildReport(summary), /RT2 Push Notification Gate/);
  assert.match(buildReport(summary), /Registrations/);
  assert.match(buildReport(summary), /Signals/);
  assert.match(buildReport(summary), /Delivery Evidence/);
  assert.match(buildReport(summary), /Click Evidence/);
  assert.match(buildReport(summary), /Capture Reliability/);
}

{
  const manifest = completeFixture();
  delete manifest.registrations[0].companyId;
  manifest.registrations[1].deviceId = "";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_REGISTRATION_COMPANY_MISSING"));
  assert.ok(codes.includes("PUSH_REGISTRATION_DEVICE_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.registrations[0].registrationState = "permission_denied";
  manifest.registrations[0].reason = "";
  manifest.registrations[0].permission = { state: "denied", evidence: "" };
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_REGISTRATION_NOT_ACTIVE"));
  assert.ok(codes.includes("PUSH_REGISTRATION_REASON_MISSING"));
  assert.ok(codes.includes("PUSH_PERMISSION_DENIED_EVIDENCE_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.registrations[0].deviceToken = "abcdef1234567890";
  manifest.registrations[1].vapidPrivateKey = "not-a-secret-ref";
  manifest.registrations[1].apnsAuthKey = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("SECRET_REFERENCE_REQUIRED"));
  assert.ok(codes.includes("SECRET_PRIVATE_KEY_DETECTED"));
}

{
  const manifest = completeFixture();
  manifest.signals[0].type = "full_task_payload";
  manifest.signals[0].payload.rawText = "customer private task details";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_SIGNAL_TYPE_INVALID"));
  assert.ok(codes.includes("PUSH_PAYLOAD_SENSITIVE_FIELD"));
}

{
  const manifest = completeFixture();
  manifest.signals[0].target.route = "/companies/company-1/rt2/tasks/promote";
  manifest.signals[0].payload.route = "/companies/company-1/rt2/tasks/promote";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_TARGET_ROUTE_INVALID"));
}

{
  const manifest = completeFixture();
  manifest.deliveries[0].status = "failed";
  manifest.deliveries[0].errorCode = "";
  manifest.deliveries[0].retry = null;
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_DELIVERY_FAILURE_CODE_MISSING"));
  assert.ok(codes.includes("PUSH_DELIVERY_RETRY_DECISION_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.deliveries[0].status = "failed";
  manifest.deliveries[0].errorCode = "TOKEN_INVALID";
  manifest.deliveries[0].retry = { decision: "not_retryable", reason: "invalid token" };
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_INVALID_TOKEN_NOT_REVOKED"));
}

{
  const manifest = completeFixture();
  manifest.registrations[0].permission = { state: "denied", evidence: "" };
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_PERMISSION_DENIED_EVIDENCE_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.clicks = [];
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_CLICK_EVIDENCE_MISSING"));
}

{
  const manifest = completeFixture();
  manifest.clicks[0].reachedTarget = false;
  manifest.clicks[0].route = "/somewhere-else";
  const codes = codesFor(manifest);

  assert.ok(codes.includes("PUSH_CLICK_TARGET_NOT_REACHED"));
  assert.ok(codes.includes("PUSH_CLICK_ROUTE_MISMATCH"));
}

{
  const root = makeRoot("rt2-push-cli");
  const manifest = completeFixture();
  const manifestPath = path.join(root, writeJson(root, "fixtures/push-notification.json", manifest));
  const result = spawnSync(process.execPath, [
    "scripts/rt2-push-notification-gate.mjs",
    "--root",
    root,
    "--manifest",
    manifestPath,
    "--output-dir",
    ".planning/native-push-runs",
    "--json",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "passed");
}

console.log("rt2-push-notification-gate tests passed");
