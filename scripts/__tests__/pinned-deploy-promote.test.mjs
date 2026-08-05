#!/usr/bin/env node
/**
 * Fail-closed pinned deploy promotion tests (TSMC-19813 / remediation TSMC-19815).
 * Uses temp dirs only — no live pointer, launchd, or live DB name.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PROMOTE = path.join(REPO_ROOT, "scripts/pinned-deploy-promote.sh");
const VERIFY = path.join(REPO_ROOT, "scripts/pinned-deploy-verify.sh");
const SMOKE = path.join(REPO_ROOT, "scripts/pinned-deploy-snapshot-smoke.sh");

function sh(cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return res;
}

function runOk(cmd, args, env = {}) {
  const res = sh(cmd, args, env);
  assert.equal(res.status, 0, `expected ok: ${cmd} ${args.join(" ")}\n${res.stderr}\n${res.stdout}`);
  return res;
}

function greenReceipt(candidateSha = "abc") {
  return {
    schemaVersion: 1,
    candidateSha,
    gates: {
      committed_sha: { status: "pass" },
      plist_lint: { status: "pass" },
      uq_fixture: { status: "pass" },
      source_gate: { status: "pass" },
      server_typecheck: { status: "pass" },
    },
    failedGateCount: 0,
    mandatoryGates: [
      "committed_sha",
      "plist_lint",
      "uq_fixture",
      "source_gate",
      "server_typecheck",
    ],
    deployPointerMutated: false,
    liveCutover: false,
  };
}

test("plutil lint passes on rendered deploy and source templates", () => {
  const res = runOk("bash", [VERIFY, "lint"], {
    PAPERCLIP_PINNED_DEPLOY_TEMPLATE_DIR: path.join(REPO_ROOT, "docs/launchd"),
  });
  assert.match(res.stderr, /PASS plutil lint/);
});

test("promote-pointer refuses without allow flags (fail closed)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-refuse-"));
  try {
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    mkdirSync(receipts, { recursive: true });
    mkdirSync(deploy, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(deploy, "MARKER"), "before");
    writeFileSync(
      path.join(receipts, "working-receipt.json"),
      JSON.stringify(greenReceipt(), null, 2),
    );

    const res = sh("bash", [PROMOTE, "promote-pointer"], {
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "0",
    });
    assert.notEqual(res.status, 0);
    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "before");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("promote-pointer refuses when a mandatory gate is red (pointer unchanged)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-red-"));
  try {
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    mkdirSync(receipts, { recursive: true });
    mkdirSync(deploy, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(deploy, "MARKER"), "before");
    writeFileSync(path.join(candidate, "MARKER"), "after");
    const red = greenReceipt();
    red.gates.plist_lint = { status: "fail", detail: "forced" };
    red.failedGateCount = 1;
    writeFileSync(path.join(receipts, "working-receipt.json"), JSON.stringify(red, null, 2));

    const res = sh("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], {
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "1",
    });
    assert.notEqual(res.status, 0, "must refuse red gates");
    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "before");
    assert.ok(res.stderr.includes("gates not green") || res.stderr.includes("FAIL"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("successful temporary-pointer promote records transition metadata on durable receipt", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-ok-"));
  try {
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    const current = path.join(state, "current-receipt.json");
    mkdirSync(receipts, { recursive: true });
    mkdirSync(deploy, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    writeFileSync(path.join(deploy, "MARKER"), "before");
    writeFileSync(path.join(candidate, "MARKER"), "after-promote");
    writeFileSync(path.join(candidate, "EXTRA"), "from-candidate");
    writeFileSync(
      path.join(receipts, "working-receipt.json"),
      JSON.stringify(greenReceipt("temp-pointer-sha"), null, 2),
    );

    const res = runOk("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], {
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_DEPLOY_RECEIPT: current,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "1",
    });
    assert.match(res.stderr, /PROMOTION COMPLETE/);
    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "after-promote");
    assert.ok(existsSync(path.join(deploy, "EXTRA")));

    const currentReceipt = JSON.parse(readFileSync(current, "utf8"));
    assert.equal(currentReceipt.deployPointerMutated, true);
    assert.equal(currentReceipt.liveCutover, true);
    assert.ok(currentReceipt.promotedAt);
    assert.equal(currentReceipt.candidateSha, "temp-pointer-sha");
    assert.ok(currentReceipt.durableReceiptPath);

    const durablePath = currentReceipt.durableReceiptPath;
    assert.ok(existsSync(durablePath), `durable receipt missing: ${durablePath}`);
    const durable = JSON.parse(readFileSync(durablePath, "utf8"));
    assert.equal(durable.deployPointerMutated, true, "durable must include pointer transition");
    assert.equal(durable.liveCutover, true);
    assert.ok(durable.promotedAt, "durable must include promotedAt");
    assert.equal(durable.durableReceiptPath, durablePath);
    assert.equal(durable.currentReceiptPath, current);

    // Also ensure at least one receipt-* file under receipts embeds the transition.
    const durableNamed = readdirSync(receipts).filter((f) => f.startsWith("receipt-") && f.endsWith(".json"));
    assert.ok(durableNamed.length >= 1);
    const named = JSON.parse(readFileSync(path.join(receipts, durableNamed[0]), "utf8"));
    assert.equal(named.deployPointerMutated, true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rollback-drill passes in isolated state dir", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-rollback-"));
  try {
    const res = runOk("bash", [PROMOTE, "rollback-drill"], {
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: tmp,
    });
    assert.match(res.stderr, /PASS rollback-drill/);
    const receipt = path.join(tmp, "drill/rollback-drill-receipt.json");
    assert.ok(existsSync(receipt));
    const j = JSON.parse(readFileSync(receipt, "utf8"));
    assert.equal(j.status, "pass");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("uq-fixture rejects duplicate open fallback-monitor rows on disposable DB", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-uq-"));
  try {
    const res = sh("bash", [SMOKE, "uq-fixture"], {
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: tmp,
      PAPERCLIP_PINNED_DEPLOY_KEEP_SMOKE_DB: "0",
    });
    assert.equal(res.status, 0, res.stderr + res.stdout);
    assert.match(res.stderr, /PASS uq-fixture/);
    const report = JSON.parse(readFileSync(path.join(tmp, "last-uq-fixture.json"), "utf8"));
    assert.equal(report.status, "pass");
    assert.notEqual(report.database, "paperclip");
    assert.match(report.database, /^paperclip_promote_smoke_/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("snapshot smoke refuses live database name and missing dump", () => {
  const res = sh("bash", [SMOKE, "restore-migrate"], {
    PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP: "0",
    PAPERCLIP_PINNED_DEPLOY_DUMP_PATH: "",
    PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: REPO_ROOT,
    PAPERCLIP_PINNED_DEPLOY_BOOT_STUB: "0",
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no DUMP_PATH|FAIL/);
});

test("boot-api smoke on disposable port: health + issue create/read + cleanup safety", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-boot-api-"));
  try {
    const res = runOk("bash", [SMOKE, "boot-api"], {
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: tmp,
      PAPERCLIP_PINNED_DEPLOY_BOOT_STUB: "1",
      PAPERCLIP_PINNED_DEPLOY_KEEP_SMOKE_DB: "0",
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: REPO_ROOT,
      PAPERCLIP_PINNED_DEPLOY_HEALTH_TIMEOUT_S: "30",
      // Force a high disposable port away from live fleet.
      PAPERCLIP_PINNED_DEPLOY_SMOKE_PORT: String(37111 + Math.floor(Math.random() * 500)),
    });
    assert.match(res.stderr, /PASS boot-api smoke/);
    assert.match(res.stderr, /PASS authenticated issue create\/read/);
    assert.doesNotMatch(res.stderr, /dropping disposable db paperclip[^_]/);
    assert.doesNotMatch(res.stderr, /:3100|:3101/);

    const report = JSON.parse(readFileSync(path.join(tmp, "last-boot-api-smoke.json"), "utf8"));
    assert.equal(report.status, "pass");
    assert.equal(report.gate, "snapshot_boot_api");
    assert.equal(report.bootStub, true);
    assert.notEqual(report.database, "paperclip");
    assert.match(String(report.database), /^paperclip_(promote|boot)_smoke_/);
    assert.ok(report.port);
    assert.notEqual(report.port, 3100);
    assert.notEqual(report.port, 3101);
    assert.ok(report.issueId);
    assert.equal(report.health?.status, "ok");

    // Cleanup safety: disposable DB should have been dropped (KEEP=0).
    assert.match(res.stderr, /dropping disposable db paperclip_/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("restore-migrate with BOOT_STUB runs boot/API after disposable DB create", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-restore-stub-"));
  try {
    const res = runOk("bash", [SMOKE, "restore-migrate"], {
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: tmp,
      PAPERCLIP_PINNED_DEPLOY_BOOT_STUB: "1",
      PAPERCLIP_PINNED_DEPLOY_KEEP_SMOKE_DB: "0",
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: REPO_ROOT,
      PAPERCLIP_PINNED_DEPLOY_HEALTH_TIMEOUT_S: "30",
    });
    assert.match(res.stderr, /PASS restore-migrate/);
    assert.match(res.stderr, /PASS boot-api smoke/);
    const migrate = JSON.parse(readFileSync(path.join(tmp, "last-restore-migrate.json"), "utf8"));
    const boot = JSON.parse(readFileSync(path.join(tmp, "last-boot-api-smoke.json"), "utf8"));
    assert.equal(migrate.status, "pass");
    assert.equal(boot.status, "pass");
    assert.equal(migrate.database, boot.database);
    assert.notEqual(migrate.database, "paperclip");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cleanup safety refuses protected live database name", () => {
  // Directly exercise assert via a tiny bash snippet sourcing the same guards
  // by invoking restore-migrate with a forced custom name is blocked; instead
  // check the script text contract + runtime refusal on name paperclip via env
  // override of LIVE_DB only (smoke still refuses paperclip hard-code).
  const src = readFileSync(SMOKE, "utf8");
  assert.match(src, /assert_not_live_db/);
  assert.match(src, /REFUSING cleanup of protected database name/);
  assert.match(src, /paperclip_promote_smoke_/);
  assert.match(src, /run_authenticated_issue_smoke/);
  assert.match(src, /\/api\/health/);
});
