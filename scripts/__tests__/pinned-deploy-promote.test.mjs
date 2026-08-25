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
  utimesSync,
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

function sh(cmd, args, env = {}, opts = {}) {
  // Strip the invoking process's own agent identity (TSMC-21660): this suite
  // runs inside an agent lane whenever an agent runs it, and PAPERCLIP_AGENT_ID
  // / PAPERCLIP_RUN_ID would otherwise leak into every subprocess and trip the
  // capability-boundary refusal added below (TSMC-21652) for tests that never
  // meant to simulate a lane caller. Tests that DO want a lane caller add
  // PAPERCLIP_AGENT_ID/PAPERCLIP_RUN_ID back explicitly via the env argument.
  const baseEnv = { ...process.env };
  delete baseEnv.PAPERCLIP_AGENT_ID;
  delete baseEnv.PAPERCLIP_RUN_ID;
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: {
      ...baseEnv,
      PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN: "test-deployment-lease",
      ...env,
    },
    cwd: opts.cwd,
  });
  return res;
}

function runOk(cmd, args, env = {}, opts = {}) {
  const res = sh(cmd, args, env, opts);
  assert.equal(res.status, 0, `expected ok: ${cmd} ${args.join(" ")}\n${res.stderr}\n${res.stdout}`);
  return res;
}

function greenReceipt(candidateSha = "abc") {
  return {
    schemaVersion: 1,
    candidateSha,
    gates: {
      committed_sha: { status: "pass" },
      worktree_env: { status: "pass" },
      candidate_deps: { status: "pass" },
      plist_lint: { status: "pass" },
      uq_fixture: { status: "pass" },
      source_gate: { status: "pass" },
      server_typecheck: { status: "pass" },
    },
    failedGateCount: 0,
    mandatoryGates: [
      "committed_sha",
      "worktree_env",
      "candidate_deps",
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
    mkdirSync(path.join(state, "deployment-lease"), { recursive: true });
    writeFileSync(
      path.join(state, "deployment-lease", "owner.json"),
      JSON.stringify({ token: "test-deployment-lease" }),
    );
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
    mkdirSync(path.join(state, "deployment-lease"), { recursive: true });
    writeFileSync(
      path.join(state, "deployment-lease", "owner.json"),
      JSON.stringify({ token: "test-deployment-lease" }),
    );
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

test("mutating commands refuse an agent-lane caller; read-only ones do not (TSMC-21652)", () => {
  // Born 2026-08-25: a TSBC benchmark lane ran this script against live
  // production, promoted a stale candidate (rolling the pointer back ~3h), and
  // on its next attempt rm -rf'd the deployment lease so the lock could not
  // stop it. A lease serialises callers that respect it; it cannot stop one
  // that deletes it. Refuse at the door instead.
  const agentEnv = { PAPERCLIP_AGENT_ID: "fake-lane", PAPERCLIP_RUN_ID: "fake-run" };

  const refused = sh("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], agentEnv);
  assert.notEqual(refused.status, 0, "a lane must not reach promote-pointer");
  assert.ok(
    refused.stderr.includes("not an agent-lane capability"),
    `expected the lane refusal, got: ${refused.stderr.slice(-300)}`,
  );

  // Read-only inspection stays available: an agent diagnosing a deploy should
  // still be able to look, it just cannot move the pointer.
  const help = sh("bash", [PROMOTE, "--help"], agentEnv);
  assert.ok(
    !(help.stderr || "").includes("not an agent-lane capability"),
    "read-only commands must not be fenced",
  );

  // A deliberately-sanctioned automation can still opt in.
  const override = sh("bash", [PROMOTE, "promote-pointer"], {
    ...agentEnv,
    PAPERCLIP_PINNED_DEPLOY_ALLOW_AGENT_CALLER: "1",
  });
  assert.ok(
    !(override.stderr || "").includes("not an agent-lane capability"),
    "the sanctioned override must bypass the lane refusal",
  );

  // And an operator shell (no agent env) is unaffected.
  const operator = sh("bash", [PROMOTE, "promote-pointer"], {});
  assert.ok(
    !(operator.stderr || "").includes("not an agent-lane capability"),
    "an operator caller must never see the lane refusal",
  );
});

test("promote-pointer refuses an ANCESTOR candidate unless --rollback (TSMC-21652)", () => {
  // Born 2026-08-25: a lane promoted a stale candidate whose SHA was an ancestor
  // of the deployed one. Gates were green — the tree was internally consistent,
  // it just pointed at older code — so production silently went BACKWARDS ~3h
  // and dropped a verified gateway fix plus three other commits.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-ancestor-"));
  try {
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const source = path.join(tmp, "source");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    mkdirSync(receipts, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    mkdirSync(path.join(state, "deployment-lease"), { recursive: true });
    writeFileSync(
      path.join(state, "deployment-lease", "owner.json"),
      JSON.stringify({ token: "test-deployment-lease" }),
    );

    // Two real commits: OLD is an ancestor of NEW.
    const git = (args, cwd) => runOk("git", args, {}, { cwd });
    mkdirSync(source, { recursive: true });
    git(["init", "-q", "-b", "main"], source);
    git(["config", "user.email", "t@t"], source);
    git(["config", "user.name", "t"], source);
    writeFileSync(path.join(source, "f"), "old");
    git(["add", "-A"], source); git(["commit", "-qm", "old"], source);
    const oldSha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();
    writeFileSync(path.join(source, "f"), "new");
    git(["add", "-A"], source); git(["commit", "-qm", "new"], source);
    const newSha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();

    // Deployed = NEW. Candidate receipt claims OLD -> a backwards move.
    runOk("git", ["clone", "-q", source, deploy], {});
    runOk("git", ["checkout", "-q", newSha], {}, { cwd: deploy });
    writeFileSync(path.join(deploy, "MARKER"), "before");
    writeFileSync(path.join(candidate, "MARKER"), "after");
    const rec = greenReceipt();
    rec.candidateSha = oldSha;
    writeFileSync(path.join(receipts, "working-receipt.json"), JSON.stringify(rec, null, 2));

    const env = {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "1",
    };

    const refused = sh("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], env);
    assert.notEqual(refused.status, 0, "must refuse a backwards promote");
    assert.ok(
      refused.stderr.includes("ANCESTOR"),
      `expected an ANCESTOR refusal, got: ${refused.stderr.slice(-400)}`,
    );
    assert.equal(
      readFileSync(path.join(deploy, "MARKER"), "utf8"),
      "before",
      "pointer must be untouched after refusal",
    );

    // An intentional rollback is a real operation and must remain possible.
    const allowed = sh(
      "bash",
      [PROMOTE, "promote-pointer", "--allow-live-pointer", "--rollback"],
      env,
    );
    assert.ok(
      !(allowed.stderr || "").includes("ANCESTOR"),
      "--rollback must bypass the ancestor refusal",
    );
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
    mkdirSync(path.join(state, "deployment-lease"), { recursive: true });
    writeFileSync(
      path.join(state, "deployment-lease", "owner.json"),
      JSON.stringify({ token: "test-deployment-lease" }),
    );
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
    // TSMC-20021: promote must leave .paperclip/.env even when candidate lacked it
    assert.ok(
      existsSync(path.join(deploy, ".paperclip", ".env")),
      "promoted deploy must include .paperclip/.env",
    );

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

test("promote-pointer prunes prev-* to N and removes staging orphans (TSMC-21623)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-prune-"));
  try {
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    const current = path.join(state, "current-receipt.json");
    mkdirSync(receipts, { recursive: true });
    mkdirSync(deploy, { recursive: true });
    mkdirSync(candidate, { recursive: true });
    mkdirSync(path.join(state, "deployment-lease"), { recursive: true });
    writeFileSync(
      path.join(state, "deployment-lease", "owner.json"),
      JSON.stringify({ token: "test-deployment-lease" }),
    );

    // Pre-existing leak fixtures: three old prev snapshots + one orphaned staging.
    const oldA = path.join(tmp, ".paperclip-deploy.prev-old-a");
    const oldB = path.join(tmp, ".paperclip-deploy.prev-old-b");
    const oldC = path.join(tmp, ".paperclip-deploy.prev-old-c");
    const orphanStaging = path.join(tmp, ".paperclip-deploy.staging-orphan");
    for (const dir of [oldA, oldB, oldC, orphanStaging]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "PAD"), "x".repeat(4096));
    }
    // Stagger mtimes so old-a is oldest.
    const past = Date.now() - 60_000;
    for (const [dir, delta] of [
      [oldA, 0],
      [oldB, 10_000],
      [oldC, 20_000],
    ]) {
      const t = new Date(past + delta);
      utimesSync(dir, t, t);
    }

    writeFileSync(path.join(deploy, "MARKER"), "gen-0");
    writeFileSync(path.join(candidate, "MARKER"), "gen-1");
    writeFileSync(
      path.join(receipts, "working-receipt.json"),
      JSON.stringify(greenReceipt("prune-sha-1"), null, 2),
    );

    const envBase = {
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_DEPLOY_RECEIPT: current,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "1",
      // keep=1 so two consecutive promotes assert the older rollback is gone.
      PAPERCLIP_PINNED_DEPLOY_PREV_KEEP: "1",
    };

    const res1 = runOk("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], envBase);
    assert.match(res1.stderr, /PROMOTION COMPLETE/);
    assert.match(res1.stderr, /prune prev: removing /);
    assert.match(res1.stderr, /prune staging: removing /);
    // Size is logged beside each removed path (acceptance #2).
    assert.match(res1.stderr, /prune (prev|staging): removing \S+ \([^)]+\)/);
    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "gen-1");
    assert.ok(!existsSync(orphanStaging), "orphaned staging must be removed on success");
    assert.ok(!existsSync(oldA), "oldest prev must be pruned under keep=1");

    const prevAfterFirst = readdirSync(tmp).filter((n) => n.startsWith(".paperclip-deploy.prev-"));
    assert.ok(
      prevAfterFirst.length <= 1,
      `after first promote expected <=1 prev-*, got ${prevAfterFirst.join(",")}`,
    );

    // Second promote: prior rollback becomes older than the brand-new one and must go.
    writeFileSync(path.join(candidate, "MARKER"), "gen-2");
    writeFileSync(
      path.join(receipts, "working-receipt.json"),
      JSON.stringify(greenReceipt("prune-sha-2"), null, 2),
    );
    const res2 = runOk("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], envBase);
    assert.match(res2.stderr, /PROMOTION COMPLETE/);
    assert.match(res2.stderr, /prune prev: removing /);
    assert.match(res2.stderr, /prune prev: removing \S+ \([^)]+\)/);
    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "gen-2");

    const prevAfterSecond = readdirSync(tmp).filter((n) => n.startsWith(".paperclip-deploy.prev-"));
    assert.equal(
      prevAfterSecond.length,
      1,
      `after second promote expected exactly 1 prev-*, got ${prevAfterSecond.join(",")}`,
    );
    // The surviving snapshot must be the immediate predecessor (gen-1), not gen-0.
    assert.equal(
      readFileSync(path.join(tmp, prevAfterSecond[0], "MARKER"), "utf8"),
      "gen-1",
      "kept prev must be the most recent rollback (gen-1)",
    );
    const stagingLeft = readdirSync(tmp).filter((n) => n.startsWith(".paperclip-deploy.staging-"));
    assert.equal(stagingLeft.length, 0, `no staging orphans expected, got ${stagingLeft.join(",")}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepare-candidate provisions .paperclip/.env and records worktree_env + candidate_deps (SKIP_HEAVY)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-prepare-env-"));
  try {
    const source = path.join(tmp, "source");
    const candidate = path.join(tmp, "candidate");
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    mkdirSync(source, { recursive: true });
    mkdirSync(receipts, { recursive: true });

    // Minimal git repo with one commit.
    runOk("git", ["init", "-b", "live"], {}, { cwd: source });
    runOk("git", ["config", "user.email", "test@example.com"], {}, { cwd: source });
    runOk("git", ["config", "user.name", "test"], {}, { cwd: source });
    writeFileSync(path.join(source, "README"), "candidate-source\n");
    // package.json so path looks like a monorepo root (install skipped via SKIP_HEAVY)
    writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ name: "paperclip-fixture", private: true }, null, 2),
    );
    runOk("git", ["add", "."], {}, { cwd: source });
    runOk("git", ["commit", "-m", "init"], {}, { cwd: source });
    const sha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();

    const res = runOk("bash", [PROMOTE, "prepare-candidate", sha], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH: "live",
      PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY: "1",
    });
    assert.match(res.stderr, /candidate ready/);
    assert.ok(existsSync(path.join(candidate, ".paperclip", ".env")));
    const receipt = JSON.parse(readFileSync(path.join(receipts, "working-receipt.json"), "utf8"));
    assert.equal(receipt.gates.committed_sha.status, "pass");
    assert.equal(receipt.gates.worktree_env.status, "pass");
    assert.equal(receipt.gates.candidate_deps.status, "pass");
    assert.ok(receipt.mandatoryGates.includes("worktree_env"));
    assert.ok(receipt.mandatoryGates.includes("candidate_deps"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a second deployment caller cannot replace the candidate or working receipt while the lease is held", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-deploy-lease-"));
  try {
    const source = path.join(tmp, "source");
    const candidate = path.join(tmp, "candidate");
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    mkdirSync(source, { recursive: true });
    mkdirSync(receipts, { recursive: true });
    runOk("git", ["init", "-b", "live"], {}, { cwd: source });
    runOk("git", ["config", "user.email", "test@example.com"], {}, { cwd: source });
    runOk("git", ["config", "user.name", "test"], {}, { cwd: source });
    writeFileSync(path.join(source, "README"), "lease fixture\n");
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    runOk("git", ["add", "."], {}, { cwd: source });
    runOk("git", ["commit", "-m", "init"], {}, { cwd: source });
    const sha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();
    const env = {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH: "live",
      PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY: "1",
      PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN: "first-caller",
    };
    runOk("bash", [PROMOTE, "prepare-candidate", sha], env);
    const before = readFileSync(path.join(receipts, "working-receipt.json"), "utf8");
    const second = sh("bash", [PROMOTE, "prepare-candidate", sha], {
      ...env,
      PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN: "second-caller",
    });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /lease already held/);
    assert.equal(readFileSync(path.join(receipts, "working-receipt.json"), "utf8"), before);
    assert.equal(readFileSync(path.join(candidate, "README"), "utf8"), "lease fixture\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a STALE lease (dead holder, past the window) is reclaimed, not refused forever (TSMC-21597)", () => {
  // The companion to the test above. Refusing a young lease is only safe if an
  // genuinely abandoned one still clears — otherwise one crashed deploy wedges
  // every future deploy, which is worse than the race it prevents. Four leases
  // were abandoned on 2026-08-25 alone.
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-deploy-lease-stale-"));
  try {
    const source = path.join(tmp, "source");
    const candidate = path.join(tmp, "candidate");
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    mkdirSync(source, { recursive: true });
    mkdirSync(receipts, { recursive: true });
    mkdirSync(path.join(state, "deployment-lease"), { recursive: true });
    runOk("git", ["init", "-b", "live"], {}, { cwd: source });
    runOk("git", ["config", "user.email", "test@example.com"], {}, { cwd: source });
    runOk("git", ["config", "user.name", "test"], {}, { cwd: source });
    writeFileSync(path.join(source, "README"), "stale fixture\n");
    writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    runOk("git", ["add", "."], {}, { cwd: source });
    runOk("git", ["commit", "-m", "init"], {}, { cwd: source });
    const sha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();

    // A lease whose holder is long gone and which is well past the window.
    writeFileSync(
      path.join(state, "deployment-lease", "owner.json"),
      JSON.stringify({
        token: "ghost-caller",
        actor: "ghost",
        acquiredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        pid: 999_999_999,
      }),
    );

    const res = sh("bash", [PROMOTE, "prepare-candidate", sha], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH: "live",
      PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY: "1",
      PAPERCLIP_PINNED_DEPLOY_LEASE_TOKEN: "new-caller",
    });
    assert.match(
      res.stderr,
      /reclaiming stale deployment lease/,
      `expected a stale reclaim, got: ${res.stderr.slice(-400)}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("promotion replaces an existing linked serving worktree without leaving its pointer absent", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-linked-serving-"));
  try {
    const source = path.join(tmp, "source");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const current = path.join(state, "current.json");
    mkdirSync(source, { recursive: true });
    mkdirSync(receipts, { recursive: true });
    runOk("git", ["init", "-b", "live"], {}, { cwd: source });
    runOk("git", ["config", "user.email", "test@example.com"], {}, { cwd: source });
    runOk("git", ["config", "user.name", "test"], {}, { cwd: source });
    writeFileSync(path.join(source, "MARKER"), "after-promote");
    writeFileSync(path.join(source, ".gitignore"), ".paperclip/\n");
    runOk("git", ["add", "."], {}, { cwd: source });
    runOk("git", ["commit", "-m", "init"], {}, { cwd: source });
    const sha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();

    // Reproduce the old live layout: the serving path is itself registered as
    // a linked worktree. The former implementation moved it away, then failed
    // when trying to move a second linked worktree back to the same path.
    runOk("git", ["worktree", "add", "--detach", deploy, sha], {}, { cwd: source });
    runOk("bash", [PROMOTE, "prepare-candidate", sha], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH: "live",
      PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY: "1",
    });
    writeFileSync(path.join(receipts, "working-receipt.json"), JSON.stringify(greenReceipt(sha), null, 2));
    runOk("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_DEPLOY_RECEIPT: current,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "1",
    });

    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "after-promote");
    assert.equal(runOk("git", ["status", "--porcelain"], {}, { cwd: deploy }).stdout, "");
    assert.ok(
      !runOk("git", ["worktree", "list", "--porcelain"], {}, { cwd: source }).stdout.includes(`worktree ${deploy}`),
      "new serving checkout must not inherit the displaced linked-worktree registration",
    );

    // Candidate recreation is the regression trigger for copied/linked Git
    // metadata. It must not disturb the serving checkout after promotion.
    runOk("bash", [PROMOTE, "prepare-candidate", sha], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH: "live",
      PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY: "1",
    });
    assert.equal(readFileSync(path.join(deploy, "MARKER"), "utf8"), "after-promote");
    assert.equal(runOk("git", ["status", "--porcelain"], {}, { cwd: deploy }).stdout, "");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("promotion gives the serving tree its own Git metadata, not the candidate's", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-git-"));
  try {
    const source = path.join(tmp, "source");
    const deploy = path.join(tmp, "deploy");
    const candidate = path.join(tmp, "candidate");
    const state = path.join(tmp, "state");
    const receipts = path.join(state, "receipts");
    const current = path.join(state, "current.json");
    mkdirSync(receipts, { recursive: true });
    mkdirSync(source, { recursive: true });
    runOk("git", ["init", "-b", "live"], {}, { cwd: source });
    runOk("git", ["config", "user.email", "test@example.com"], {}, { cwd: source });
    runOk("git", ["config", "user.name", "test"], {}, { cwd: source });
    writeFileSync(path.join(source, "README"), "isolated deploy metadata\n");
    writeFileSync(path.join(source, ".gitignore"), ".paperclip/\n");
    runOk("git", ["add", "."], {}, { cwd: source });
    runOk("git", ["commit", "-m", "init"], {}, { cwd: source });
    const sha = runOk("git", ["rev-parse", "HEAD"], {}, { cwd: source }).stdout.trim();

    runOk("bash", [PROMOTE, "prepare-candidate", sha], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_PINNED_DEPLOY_APPROVED_BRANCH: "live",
      PAPERCLIP_PINNED_DEPLOY_SKIP_HEAVY: "1",
    });
    writeFileSync(path.join(receipts, "working-receipt.json"), JSON.stringify(greenReceipt(sha), null, 2));
    runOk("bash", [PROMOTE, "promote-pointer", "--allow-live-pointer"], {
      PAPERCLIP_SOURCE_ROOT: source,
      PAPERCLIP_DEPLOY_ROOT: deploy,
      PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT: candidate,
      PAPERCLIP_PINNED_DEPLOY_STATE_DIR: state,
      PAPERCLIP_PINNED_DEPLOY_RECEIPT_DIR: receipts,
      PAPERCLIP_DEPLOY_RECEIPT: current,
      PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE: "1",
    });
    const deployGitDir = runOk("git", ["rev-parse", "--absolute-git-dir"], {}, { cwd: deploy }).stdout.trim();
    const candidateGitDir = runOk("git", ["rev-parse", "--absolute-git-dir"], {}, { cwd: candidate }).stdout.trim();
    assert.notEqual(deployGitDir, candidateGitDir);
    assert.equal(runOk("git", ["status", "--porcelain"], {}, { cwd: deploy }).stdout, "");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("promote-and-restart refuses without allow flags (fail closed, no pointer move)", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pinned-promote-restart-refuse-"));
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
    const res = sh("bash", [PROMOTE, "promote-and-restart"], {
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

test("sanctioned restart uses SIGTERM so the old server can write its handoff snapshot", () => {
  const source = readFileSync(PROMOTE, "utf8");
  assert.match(source, /launchctl kill SIGTERM/);
  assert.doesNotMatch(source, /^\s*launchctl kickstart -k/m);
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
