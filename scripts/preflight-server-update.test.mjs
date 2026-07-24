import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePreflight, SEVERITY } from "./preflight-server-update.mjs";

test("clean tree is safe to reset", () => {
  const r = evaluatePreflight({});
  assert.equal(r.verdict, "clean");
  assert.equal(r.findings.length, 0);
  assert.equal(r.blocking.length, 0);
});

test("tracked uncommitted changes block (destroyed by reset --hard)", () => {
  const r = evaluatePreflight({
    trackedUncommitted: [" M server/src/heartbeat.ts", "A  scripts/new.mjs"],
  });
  assert.equal(r.verdict, "blocked");
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].kind, "tracked_uncommitted");
  assert.equal(r.blocking[0].severity, SEVERITY.BLOCK);
  assert.equal(r.blocking[0].count, 2);
});

test("commits ahead of origin/master block", () => {
  const r = evaluatePreflight({
    aheadCommits: ["abc1234 fix: local hotpatch", "def5678 chore: tweak"],
  });
  assert.equal(r.verdict, "blocked");
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].kind, "ahead_commits");
});

test("stashes warn but do not block (they survive reset --hard)", () => {
  const r = evaluatePreflight({
    stashes: ["stash@{0}: On master: wip before pre-merge"],
  });
  assert.equal(r.verdict, "clean");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].severity, SEVERITY.WARN);
  assert.equal(r.blocking.length, 0);
});

test("untracked files are informational only", () => {
  const r = evaluatePreflight({ untracked: ["?? .codex/"] });
  assert.equal(r.verdict, "clean");
  assert.equal(r.findings[0].severity, SEVERITY.INFO);
});

test("--ack downgrades blocked to acked and records the reason", () => {
  const r = evaluatePreflight({
    aheadCommits: ["abc1234 fix: live hotpatch"],
    ack: "live-hotpatch, durable deploy tracked in #1234",
  });
  assert.equal(r.verdict, "acked");
  assert.equal(r.ack, "live-hotpatch, durable deploy tracked in #1234");
});

test("empty/whitespace ack does not satisfy the gate", () => {
  const r = evaluatePreflight({
    aheadCommits: ["abc1234 fix: live hotpatch"],
    ack: "   ",
  });
  assert.equal(r.verdict, "blocked");
  assert.equal(r.ack, null);
});

test("multiple divergence kinds are all reported; blocking drives the verdict", () => {
  const r = evaluatePreflight({
    trackedUncommitted: [" M server/src/index.ts"],
    aheadCommits: ["abc1234 fix"],
    stashes: ["stash@{0}: wip"],
    untracked: ["?? tmp.log"],
  });
  assert.equal(r.findings.length, 4);
  assert.equal(r.blocking.length, 2);
  assert.equal(r.verdict, "blocked");
});
