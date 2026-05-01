import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  evaluateV31AcceptanceGate,
  writeV31AcceptanceGate,
} from "./rt2-v31-acceptance-gate.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rt2-v31-acceptance-"));
}

function write(root, rel, content = "evidence") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel.split(path.sep).join("/");
}

function alignmentSummary(overrides = {}) {
  return {
    version: 1,
    generatedAt: "2026-05-01T00:00:00.000Z",
    status: "passed",
    baselineScorePct: 64,
    currentScorePct: 100,
    runDir: ".planning/devplan-alignment-runs/test",
    rows: [
      {
        id: "prior-evidence",
        axis: "Prior evidence",
        ownerPhase: "69",
        evidence: [{ type: "test", path: "evidence/prior.txt" }],
      },
      {
        id: "v31-acceptance-gate",
        axis: "v3.1 acceptance score delta",
        ownerPhase: "71",
        evidence: [{ type: "gate", path: "scripts/rt2-v31-acceptance-gate.mjs" }],
      },
    ],
    ...overrides,
  };
}

function passedChecks() {
  return [
    {
      id: "focused",
      area: "test",
      command: "pnpm test",
      evidence: ["evidence/prior.txt"],
      status: "passed",
      exitCode: 0,
      stdout: "",
      stderr: "",
    },
  ];
}

{
  const root = makeRoot();
  write(root, "evidence/prior.txt");
  write(root, "scripts/rt2-v31-acceptance-gate.mjs");
  const summary = evaluateV31AcceptanceGate({
    root,
    alignmentSummary: alignmentSummary(),
    checkResults: passedChecks(),
    gitStatus: { available: true, lines: [], error: null },
    now: new Date("2026-05-01T00:00:00.000Z"),
  });
  assert.equal(summary.status, "passed");
  assert.equal(summary.scoreDeltaPct, 36);
  assert.equal(summary.counts.blockers, 0);
  assert.match(buildReport(summary), /Score delta: 36 percentage points/);
}

{
  const root = makeRoot();
  write(root, "evidence/prior.txt");
  write(root, "scripts/rt2-v31-acceptance-gate.mjs");
  const failed = [{ ...passedChecks()[0], status: "failed", exitCode: 1 }];
  const summary = evaluateV31AcceptanceGate({
    root,
    alignmentSummary: alignmentSummary(),
    checkResults: failed,
    gitStatus: { available: true, lines: [], error: null },
  });
  assert.equal(summary.status, "blocker");
  assert.ok(summary.blockers.some((blocker) => blocker.code === "V31_FOCUSED_CHECK_FAILED"));
}

{
  const root = makeRoot();
  write(root, "evidence/prior.txt");
  write(root, "scripts/rt2-v31-acceptance-gate.mjs");
  const summary = evaluateV31AcceptanceGate({
    root,
    alignmentSummary: alignmentSummary({ currentScorePct: 64 }),
    checkResults: passedChecks(),
    gitStatus: { available: true, lines: [], error: null },
  });
  assert.equal(summary.status, "blocker");
  assert.ok(summary.blockers.some((blocker) => blocker.code === "V31_SCORE_DELTA_NOT_POSITIVE"));
}

{
  const root = makeRoot();
  write(root, "evidence/prior.txt");
  write(root, "scripts/rt2-v31-acceptance-gate.mjs");
  const summary = evaluateV31AcceptanceGate({
    root,
    alignmentSummary: alignmentSummary(),
    checkResults: passedChecks(),
    gitStatus: { available: true, lines: [" M evidence/prior.txt"], error: null },
  });
  assert.equal(summary.status, "blocker");
  assert.ok(summary.blockers.some((blocker) => blocker.code === "V31_DIRTY_EVIDENCE_ANCHOR"));
}

{
  const root = makeRoot();
  write(root, "evidence/prior.txt");
  write(root, "scripts/rt2-v31-acceptance-gate.mjs");
  const summary = evaluateV31AcceptanceGate({
    root,
    alignmentSummary: alignmentSummary(),
    checkResults: passedChecks(),
    gitStatus: { available: true, lines: [], error: null },
    now: new Date("2026-05-01T00:00:00.000Z"),
  });
  const written = writeV31AcceptanceGate(summary, {
    root,
    outputDir: ".planning/v31-acceptance-runs",
  });
  assert.ok(fs.existsSync(path.join(root, written.runDir, "summary.json")));
  assert.ok(fs.existsSync(path.join(root, written.runDir, "report.md")));
}

console.log("rt2-v31-acceptance-gate tests passed");
