import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ROWS,
  buildReport,
  evaluateDevPlanAlignment,
  runDevPlanAlignmentGate,
} from "./rt2-devplan-alignment-gate.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rt2-devplan-alignment-"));
}

{
  const summary = evaluateDevPlanAlignment({ now: new Date("2026-05-01T00:00:00.000Z") });
  assert.equal(summary.status, "passed");
  assert.equal(summary.baselineScorePct, 64);
  assert.equal(summary.currentScorePct, 88);
  assert.equal(summary.counts.byStatus.complete, 8);
  assert.match(buildReport(summary), /Graphify v3 corpus graph sidecar/);
  assert.match(buildReport(summary), /Economy, marketplace, P&L, CareerMate loop/);
  const economyRow = summary.rows.find((row) => row.id === "economy-loop");
  assert.equal(economyRow?.status, "complete");
  assert.ok(economyRow?.evidence.some((entry) => entry.path === "server/src/routes/rt2-career-mate.ts"));
  assert.ok(economyRow?.evidence.some((entry) => entry.path === "ui/src/components/Rt2DailyBoard.tsx"));
}

{
  const rows = [
    {
      id: "unsupported-complete",
      axis: "Unsupported complete claim",
      status: "complete",
      weight: 1,
      ownerPhase: "65",
      requirements: ["ALIGN-02"],
      evidence: [],
      gaps: [],
    },
  ];
  const summary = evaluateDevPlanAlignment({ rows });
  assert.equal(summary.status, "blocker");
  assert.ok(summary.blockers.some((item) => item.code === "DEVPLAN_COMPLETE_WITHOUT_EVIDENCE"));
}

{
  const rows = [
    {
      id: "graphify-overclaim",
      axis: "Graphify parity",
      status: "complete",
      weight: 1,
      ownerPhase: "69",
      requirements: ["GRAPH-04"],
      engineParity: true,
      evidence: [{ type: "ui", path: "ui/src/components/Rt2GraphPanel.tsx" }],
      gaps: [],
    },
  ];
  const summary = evaluateDevPlanAlignment({ rows });
  assert.equal(summary.status, "blocker");
  assert.ok(summary.blockers.some((item) => item.code === "DEVPLAN_ENGINE_PARITY_OVERCLAIM"));
}

{
  const rows = DEFAULT_ROWS.map((row) =>
    row.id === "graphify-v3-sidecar"
      ? {
          ...row,
          status: "complete",
          evidence: [{ type: "audit", path: ".planning/research/ENGINE-REFERENCE-AUDIT.md" }],
          gaps: [],
        }
      : row,
  );
  const summary = evaluateDevPlanAlignment({ rows });
  assert.equal(summary.status, "passed");
}

{
  const root = makeRoot();
  const written = runDevPlanAlignmentGate({
    root,
    outputDir: ".planning/devplan-alignment-runs",
    now: new Date("2026-05-01T00:00:00.000Z"),
  });
  assert.equal(written.status, "passed");
  assert.ok(fs.existsSync(path.join(root, written.runDir, "summary.json")));
  assert.ok(fs.existsSync(path.join(root, written.runDir, "report.md")));
}

console.log("rt2-devplan-alignment-gate tests passed");
