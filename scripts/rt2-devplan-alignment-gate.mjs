#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const ALLOWED_STATUSES = new Set(["complete", "partial", "tech_debt", "missing", "deferred"]);

const STATUS_SCORE = {
  complete: 1,
  partial: 0.6,
  tech_debt: 0.35,
  missing: 0,
  deferred: 0,
};

const DEFAULT_ROWS = [
  {
    id: "alignment-truth",
    axis: "DevPlan truth matrix",
    status: "complete",
    weight: 10,
    ownerPhase: "65",
    requirements: ["ALIGN-01", "ALIGN-02"],
    evidence: [
      { type: "gate", path: "scripts/rt2-devplan-alignment-gate.mjs" },
      { type: "ui", path: "ui/src/pages/rt2/PlanAlignmentPage.tsx" },
      { type: "context", path: ".planning/phases/65-devplan-truth-and-identity-cleanup/65-CONTEXT.md" },
    ],
    gaps: [],
  },
  {
    id: "identity-boundary",
    axis: "RealTycoon2 product identity boundary",
    status: "complete",
    weight: 10,
    ownerPhase: "65",
    requirements: ["IDENTITY-01", "IDENTITY-03"],
    evidence: [
      { type: "doc", path: "doc/REALTYCOON2-COMPATIBILITY.md" },
      { type: "doc", path: "doc/PRODUCT.md" },
      { type: "doc", path: "doc/SPEC.md" },
    ],
    gaps: [],
  },
  {
    id: "identity-regression",
    axis: "Product-facing identity regression scan",
    status: "complete",
    weight: 10,
    ownerPhase: "65",
    requirements: ["IDENTITY-02"],
    evidence: [
      { type: "gate", path: "scripts/rt2-identity-gate.mjs" },
      { type: "test", path: "scripts/rt2-identity-gate.test.mjs" },
    ],
    gaps: [],
  },
  {
    id: "daily-cockpit",
    axis: "Daily Work cockpit",
    status: "complete",
    weight: 12,
    ownerPhase: "66",
    requirements: ["DAILY-01", "DAILY-02", "DAILY-03"],
    evidence: [
      { type: "ui", path: "ui/src/pages/rt2/DailyWorkPage.tsx" },
      { type: "ui", path: "ui/src/components/Rt2DailyBoard.tsx" },
      { type: "test", path: "ui/src/components/Rt2DailyBoard.test.tsx" },
      { type: "service", path: "server/src/services/rt2-work-board.ts" },
      { type: "test", path: "server/src/__tests__/rt2-task-routes.test.ts" },
    ],
    gaps: [],
  },
  {
    id: "mission-okr-rollup",
    axis: "Mission to To-Do hierarchy",
    status: "complete",
    weight: 8,
    ownerPhase: "66",
    requirements: ["DAILY-03"],
    evidence: [
      { type: "shared", path: "packages/shared/src/types/rt2-daily-report.ts" },
      { type: "service", path: "server/src/services/rt2-daily-report.ts" },
      { type: "test", path: "packages/shared/src/rt2-daily-report.test.ts" },
      { type: "test", path: "server/src/__tests__/rt2-daily-report-routes.test.ts" },
      { type: "test", path: "ui/src/components/Rt2DailyBoard.test.tsx" },
    ],
    gaps: [],
  },
  {
    id: "multica-runtime",
    axis: "Multica-style runtime execution",
    status: "complete",
    weight: 12,
    ownerPhase: "67",
    requirements: ["RUNTIME-01", "RUNTIME-02", "RUNTIME-03"],
    engineParity: true,
    evidence: [
      { type: "service", path: "server/src/services/rt2-task-execution.ts" },
      { type: "route", path: "server/src/routes/rt2-tasks.ts" },
      { type: "ui", path: "ui/src/components/Rt2TaskPanel.tsx" },
      { type: "test", path: "server/src/__tests__/rt2-task-routes.test.ts" },
      { type: "audit", path: ".planning/research/ENGINE-REFERENCE-AUDIT.md" },
    ],
    gaps: [],
  },
  {
    id: "wikillm-memory",
    axis: "wikiLLM living memory workflow",
    status: "complete",
    weight: 10,
    ownerPhase: "68",
    requirements: ["WIKI-01", "WIKI-02", "WIKI-03"],
    engineParity: true,
    evidence: [
      { type: "shared", path: "packages/shared/src/types/rt2-knowledge.ts" },
      { type: "shared", path: "packages/shared/src/types/rt2-governance.ts" },
      { type: "service", path: "server/src/services/rt2-knowledge-projector.ts" },
      { type: "service", path: "server/src/services/rt2-jarvis.ts" },
      { type: "route", path: "server/src/routes/rt2-knowledge.ts" },
      { type: "route", path: "server/src/routes/rt2-jarvis.ts" },
      { type: "ui", path: "ui/src/pages/rt2/KnowledgePage.tsx" },
      { type: "ui", path: "ui/src/components/Rt2QualityPanel.tsx" },
      { type: "test", path: "packages/shared/src/rt2-knowledge.test.ts" },
      { type: "test", path: "server/src/__tests__/rt2-knowledge-projector.test.ts" },
      { type: "test", path: "server/src/__tests__/rt2-knowledge-routes.test.ts" },
      { type: "test", path: "server/src/__tests__/rt2-phase6-intelligence.test.ts" },
      { type: "test", path: "ui/src/components/Rt2QualityPanel.test.tsx" },
      { type: "schema", path: "packages/db/src/schema/rt2_v33_wiki_pages.ts" },
      { type: "audit", path: ".planning/research/ENGINE-REFERENCE-AUDIT.md" },
    ],
    gaps: [],
  },
  {
    id: "graphify-v3-sidecar",
    axis: "Graphify v3 corpus graph sidecar",
    status: "tech_debt",
    weight: 12,
    ownerPhase: "69",
    requirements: ["GRAPH-01", "GRAPH-02", "GRAPH-03", "GRAPH-04"],
    engineParity: true,
    evidence: [
      { type: "schema", path: "packages/db/src/schema/rt2_v33_graph_projection.ts" },
      { type: "audit", path: ".planning/research/ENGINE-REFERENCE-AUDIT.md" },
    ],
    gaps: ["Corpus ingest, file cache, provenance, real clustering/path/query/report parity remain Phase 69 scope."],
  },
  {
    id: "economy-loop",
    axis: "Economy, marketplace, P&L, CareerMate loop",
    status: "partial",
    weight: 12,
    ownerPhase: "70",
    requirements: ["ECON-01", "ECON-02", "ECON-03"],
    evidence: [
      { type: "route", path: "server/src/routes/rt2-personal-pnl.ts" },
      { type: "route", path: "server/src/routes/rt2-agent-marketplace.ts" },
      { type: "ui", path: "ui/src/components/Rt2GamificationPanel.tsx" },
    ],
    gaps: ["Primary navigation loop and CareerMate progression tied to ledger/quality evidence remain Phase 70 scope."],
  },
  {
    id: "v31-acceptance-gate",
    axis: "v3.1 acceptance score delta",
    status: "missing",
    weight: 4,
    ownerPhase: "71",
    requirements: ["GATE-01", "GATE-02"],
    evidence: [
      { type: "roadmap", path: ".planning/ROADMAP.md" },
      { type: "requirements", path: ".planning/REQUIREMENTS.md" },
    ],
    gaps: ["Final score delta audit waits for Phases 66-70 and belongs to Phase 71."],
  },
];

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    outputDir: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[++i]);
    } else if (arg === "--output-dir") {
      args.outputDir = argv[++i];
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/rt2-devplan-alignment-gate.mjs [options]

Options:
  --root <path>          Repository root (default: cwd)
  --output-dir <path>    Evidence parent directory (default: .planning/devplan-alignment-runs)
  --json                 Print JSON summary
  --help                 Show this help
`);
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function repoPath(root, target) {
  const resolved = path.resolve(target);
  return path.relative(root, resolved).split(path.sep).join("/") || ".";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function addBlocker(blockers, { row, code, message, source = null }) {
  blockers.push({
    category: "blocker",
    row: row?.id ?? null,
    axis: row?.axis ?? null,
    code,
    message,
    source,
    owner: "planning-truth",
  });
}

function normalizeRows(rows = DEFAULT_ROWS) {
  return rows.map((row) => ({
    evidence: [],
    gaps: [],
    requirements: [],
    engineParity: false,
    ...row,
  }));
}

function validateRows(rows) {
  const blockers = [];
  const passed = [];
  for (const row of rows) {
    if (!row.id || !row.axis) {
      addBlocker(blockers, {
        row,
        code: "DEVPLAN_ROW_ID_MISSING",
        message: "Every DevPlan row needs a stable id and axis.",
      });
      continue;
    }
    if (!ALLOWED_STATUSES.has(row.status)) {
      addBlocker(blockers, {
        row,
        code: "DEVPLAN_STATUS_INVALID",
        message: `${row.id} has unsupported status '${row.status}'.`,
      });
    }
    if (typeof row.weight !== "number" || row.weight <= 0) {
      addBlocker(blockers, {
        row,
        code: "DEVPLAN_WEIGHT_INVALID",
        message: `${row.id} needs a positive numeric weight.`,
      });
    }
    if (!row.ownerPhase) {
      addBlocker(blockers, {
        row,
        code: "DEVPLAN_OWNER_PHASE_MISSING",
        message: `${row.id} needs an owner phase.`,
      });
    }
    if (row.status === "complete" && row.evidence.length === 0) {
      addBlocker(blockers, {
        row,
        code: "DEVPLAN_COMPLETE_WITHOUT_EVIDENCE",
        message: `${row.id} is complete but has no evidence anchors.`,
      });
    }
    if (row.status === "complete") {
      passed.push({
        category: "passed",
        row: row.id,
        code: "DEVPLAN_COMPLETE_HAS_EVIDENCE",
        message: `${row.id} complete claim has ${row.evidence.length} evidence anchor(s).`,
      });
    }
    const hasEngineReferenceEvidence = row.evidence.some((entry) =>
      /ENGINE-REFERENCE-AUDIT\.md$/.test(entry.path ?? "") || entry.engineReferenceEvidence === true,
    );
    if (row.engineParity && row.status === "complete" && !hasEngineReferenceEvidence) {
      addBlocker(blockers, {
        row,
        code: "DEVPLAN_ENGINE_PARITY_OVERCLAIM",
        message: `${row.id} claims engine parity without reference-engine evidence.`,
        source: ".planning/research/ENGINE-REFERENCE-AUDIT.md",
      });
    }
  }
  return { blockers, passed };
}

function calculateScore(rows) {
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  const earned = rows.reduce((sum, row) => sum + row.weight * (STATUS_SCORE[row.status] ?? 0), 0);
  return totalWeight > 0 ? Math.round((earned / totalWeight) * 100) : 0;
}

function statusCounts(rows) {
  return rows.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  }, {});
}

function evaluateDevPlanAlignment({ rows = DEFAULT_ROWS, now = new Date() } = {}) {
  const normalizedRows = normalizeRows(rows);
  const { blockers, passed } = validateRows(normalizedRows);
  const currentScore = calculateScore(normalizedRows);
  return {
    version: 1,
    generatedAt: now.toISOString(),
    status: blockers.length > 0 ? "blocker" : "passed",
    baselineScorePct: 64,
    currentScorePct: currentScore,
    counts: {
      rows: normalizedRows.length,
      blockers: blockers.length,
      passed: passed.length,
      byStatus: statusCounts(normalizedRows),
    },
    blockers,
    passed,
    rows: normalizedRows,
  };
}

function markdownTable(rows, columns) {
  const lines = [
    `| ${columns.map((column) => column.header).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${columns.map((column) => String(column.value(row) ?? "").replace(/\|/g, "\\|")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildReport(summary) {
  const lines = [
    "# RealTycoon2 DevPlan Alignment Gate",
    "",
    `Status: ${summary.status}`,
    `Generated: ${summary.generatedAt}`,
    `Baseline score: ${summary.baselineScorePct}%`,
    `Current score: ${summary.currentScorePct}%`,
    "",
    "| Rows | Complete | Partial | Tech debt | Missing | Blockers |",
    "|------|----------|---------|-----------|---------|----------|",
    `| ${summary.counts.rows} | ${summary.counts.byStatus.complete ?? 0} | ${summary.counts.byStatus.partial ?? 0} | ${summary.counts.byStatus.tech_debt ?? 0} | ${summary.counts.byStatus.missing ?? 0} | ${summary.counts.blockers} |`,
    "",
    "## Matrix",
    "",
    markdownTable(summary.rows, [
      { header: "Axis", value: (row) => row.axis },
      { header: "Status", value: (row) => row.status },
      { header: "Weight", value: (row) => row.weight },
      { header: "Owner", value: (row) => `Phase ${row.ownerPhase}` },
      { header: "Requirements", value: (row) => row.requirements.join(", ") },
      { header: "Evidence", value: (row) => row.evidence.map((entry) => entry.path).join("<br>") || "none" },
      { header: "Gaps", value: (row) => row.gaps.join("<br>") || "none" },
    ]),
    "",
    "## Blockers",
    "",
  ];
  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push(markdownTable(summary.blockers, [
      { header: "Code", value: (row) => row.code },
      { header: "Axis", value: (row) => row.axis },
      { header: "Message", value: (row) => row.message },
      { header: "Source", value: (row) => row.source ?? "" },
    ]));
  }
  return `${lines.join("\n")}\n`;
}

function writeDevPlanAlignmentGate(summary, { root, outputDir }) {
  const parent = outputDir
    ? path.resolve(root, outputDir)
    : path.join(root, ".planning", "devplan-alignment-runs");
  const runDirAbs = path.join(parent, timestampForPath(new Date(summary.generatedAt)));
  ensureDir(runDirAbs);
  const out = {
    ...summary,
    runDir: repoPath(root, runDirAbs),
  };
  fs.writeFileSync(path.join(runDirAbs, "summary.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDirAbs, "report.md"), buildReport(out), "utf8");
  return out;
}

function runDevPlanAlignmentGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const summary = evaluateDevPlanAlignment({ now: options.now ?? new Date() });
  return writeDevPlanAlignmentGate(summary, { root, outputDir: options.outputDir ?? null });
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const written = runDevPlanAlignmentGate({
      root: args.root,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(written, null, 2));
    } else {
      console.log("# RealTycoon2 DevPlan Alignment Gate");
      console.log("");
      console.log(`Status: ${written.status}`);
      console.log(`Current score: ${written.currentScorePct}%`);
      console.log(`Summary: ${path.join(written.runDir, "summary.json").split(path.sep).join("/")}`);
      console.log(`Report: ${path.join(written.runDir, "report.md").split(path.sep).join("/")}`);
      console.log(`Blockers: ${written.counts.blockers}`);
    }
    process.exit(written.status === "blocker" ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("rt2-devplan-alignment-gate.mjs"))) {
  main();
}

export {
  DEFAULT_ROWS,
  buildReport,
  calculateScore,
  evaluateDevPlanAlignment,
  runDevPlanAlignmentGate,
  validateRows,
  writeDevPlanAlignmentGate,
};
