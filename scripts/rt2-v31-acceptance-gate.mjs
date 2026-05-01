#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runDevPlanAlignmentGate } from "./rt2-devplan-alignment-gate.mjs";

const DEFAULT_CHECKS = [
  {
    id: "test-devplan-alignment-gate",
    area: "devplan-alignment",
    command: "pnpm run test:devplan-alignment-gate",
    evidence: ["scripts/rt2-devplan-alignment-gate.test.mjs"],
  },
  {
    id: "test-identity-gate",
    area: "identity",
    command: "pnpm run test:identity-gate",
    evidence: ["scripts/rt2-identity-gate.test.mjs"],
  },
  {
    id: "rt2-identity-gate",
    area: "identity",
    command: "pnpm run rt2:identity-gate",
    evidence: ["scripts/rt2-identity-gate.mjs"],
  },
  {
    id: "shared-core-contracts",
    area: "shared-contracts",
    command:
      "pnpm exec vitest run packages/shared/src/rt2-daily-report.test.ts packages/shared/src/rt2-task.test.ts packages/shared/src/rt2-knowledge.test.ts packages/shared/src/rt2-graph.test.ts packages/shared/src/rt2-gamification.test.ts",
    evidence: [
      "packages/shared/src/rt2-daily-report.test.ts",
      "packages/shared/src/rt2-task.test.ts",
      "packages/shared/src/rt2-knowledge.test.ts",
      "packages/shared/src/rt2-graph.test.ts",
      "packages/shared/src/rt2-gamification.test.ts",
    ],
  },
  {
    id: "ui-core-surfaces",
    area: "ui",
    command:
      "pnpm exec vitest run ui/src/components/Rt2DailyBoard.test.tsx ui/src/components/Rt2TaskPanel.test.tsx ui/src/components/Rt2QualityPanel.test.tsx",
    evidence: [
      "ui/src/components/Rt2DailyBoard.test.tsx",
      "ui/src/components/Rt2TaskPanel.test.tsx",
      "ui/src/components/Rt2QualityPanel.test.tsx",
    ],
  },
  {
    id: "server-core-routes",
    area: "server",
    command:
      "pnpm exec vitest run server/src/__tests__/rt2-task-routes.test.ts server/src/__tests__/rt2-knowledge-projector.test.ts server/src/__tests__/rt2-knowledge-routes.test.ts server/src/__tests__/rt2-corpus-graph.test.ts server/src/__tests__/rt2-phase7-economy-marketplace.test.ts",
    env: { PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true" },
    evidence: [
      "server/src/__tests__/rt2-task-routes.test.ts",
      "server/src/__tests__/rt2-knowledge-projector.test.ts",
      "server/src/__tests__/rt2-knowledge-routes.test.ts",
      "server/src/__tests__/rt2-corpus-graph.test.ts",
      "server/src/__tests__/rt2-phase7-economy-marketplace.test.ts",
    ],
  },
  {
    id: "typecheck",
    area: "standard-verification",
    command: "pnpm typecheck",
    evidence: ["package.json"],
  },
  {
    id: "unit-suite",
    area: "standard-verification",
    command: "pnpm test",
    evidence: ["package.json"],
  },
];

const DEFAULT_FUTURE_SCOPE = [
  {
    category: "future_scope",
    title: "Public/open marketplace launch",
    source: ".planning/REQUIREMENTS.md",
    reason: "v3.1 is scoped to trusted-company evidence, not public rollout.",
  },
  {
    category: "future_scope",
    title: "Autonomous Jarvis direct apply",
    source: ".planning/PROJECT.md",
    reason: "Approval-first Jarvis apply remains the safety boundary.",
  },
  {
    category: "future_scope",
    title: "Cross-company federation full apply",
    source: ".planning/PROJECT.md",
    reason: "Federation remains outside the trusted single-company v3.1 loop.",
  },
  {
    category: "future_scope",
    title: "Native credentials and public store operations",
    source: ".planning/ROADMAP.md",
    reason: "v3.0 defined evidence gates; real credential/store operations are operator scope.",
  },
  {
    category: "future_scope",
    title: "Billing, payroll, and external payment settlement",
    source: ".planning/phases/70-economy-marketplace-p-l-and-careermate-loop/70-CONTEXT.md",
    reason: "Phase 70 explicitly deferred real billing/payroll/export behavior.",
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
  console.log(`Usage: node scripts/rt2-v31-acceptance-gate.mjs [options]

Options:
  --root <path>          Repository root (default: cwd)
  --output-dir <path>    Evidence parent directory (default: .planning/v31-acceptance-runs)
  --json                 Print JSON summary
  --help                 Show this help
`);
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function repoPath(root, target) {
  const resolved = path.resolve(target);
  return path.relative(root, resolved).split(path.sep).join("/") || ".";
}

function normalizeRepoPath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^"\s*|\s*"$/g, "");
}

function trimOutput(value, max = 4000) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[trimmed ${text.length - max} chars]`;
}

function runShellCheck(root, check) {
  const startedAt = new Date();
  const result = spawnSync(check.command, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, ...(check.env ?? {}) },
  });
  const endedAt = new Date();
  return {
    id: check.id,
    area: check.area,
    command: check.command,
    evidence: check.evidence ?? [],
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
    signal: result.signal,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    stdout: trimOutput(result.stdout),
    stderr: trimOutput(result.stderr),
  };
}

function runFocusedChecks(root, checks = DEFAULT_CHECKS, runner = runShellCheck) {
  return checks.map((check) => runner(root, check));
}

function readGitStatusLines(root) {
  const result = spawnSync("git", ["status", "--short", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      available: false,
      lines: [],
      error: trimOutput(result.stderr || result.stdout),
    };
  }
  return {
    available: true,
    lines: result.stdout.split(/\r?\n/).filter(Boolean),
    error: null,
  };
}

function parseStatusPath(line) {
  const raw = line.slice(3).trim();
  const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1) : raw;
  return normalizeRepoPath(renamed);
}

function collectEvidenceByPath(alignmentSummary) {
  const evidence = new Map();
  for (const row of alignmentSummary?.rows ?? []) {
    for (const entry of row.evidence ?? []) {
      if (!entry.path) continue;
      const key = normalizeRepoPath(entry.path);
      if (!evidence.has(key)) {
        evidence.set(key, {
          path: key,
          rows: [],
          ownerPhases: new Set(),
        });
      }
      const record = evidence.get(key);
      record.rows.push(row.id);
      if (row.ownerPhase) record.ownerPhases.add(String(row.ownerPhase));
    }
  }
  return evidence;
}

function evidenceExists(root, evidencePath) {
  return fs.existsSync(path.join(root, evidencePath));
}

function addBlocker(blockers, {
  area,
  check,
  code,
  message,
  source = null,
  owner = "v31-acceptance",
  nextCommand = null,
}) {
  blockers.push({
    category: "blocker",
    area,
    check,
    code,
    message,
    source,
    owner,
    nextCommand,
  });
}

function addPass(passed, { area, check, code, message, source = null }) {
  passed.push({
    category: "passed",
    area,
    check,
    code,
    message,
    source,
  });
}

function buildDirtyEvidenceItems(evidenceByPath, gitStatusLines) {
  const dirty = [];
  for (const line of gitStatusLines ?? []) {
    const dirtyPath = parseStatusPath(line);
    const evidence = evidenceByPath.get(dirtyPath);
    if (!evidence) continue;
    const ownerPhases = [...evidence.ownerPhases];
    const phase71Only = ownerPhases.length > 0 && ownerPhases.every((phase) => phase === "71");
    if (phase71Only) continue;
    dirty.push({
      path: dirtyPath,
      status: line.slice(0, 2),
      rows: evidence.rows,
      ownerPhases,
    });
  }
  return dirty;
}

function evaluateV31AcceptanceGate({
  root = process.cwd(),
  now = new Date(),
  checks = DEFAULT_CHECKS,
  checkResults = null,
  alignmentSummary,
  gitStatus = null,
  futureScope = DEFAULT_FUTURE_SCOPE,
} = {}) {
  const normalizedRoot = path.resolve(root);
  const results = checkResults ?? runFocusedChecks(normalizedRoot, checks);
  const blockers = [];
  const passed = [];
  const acceptedDebt = [];
  const scoreDeltaPct = (alignmentSummary?.currentScorePct ?? 0) - (alignmentSummary?.baselineScorePct ?? 0);

  if (!alignmentSummary) {
    addBlocker(blockers, {
      area: "devplan-alignment",
      check: "alignment-summary",
      code: "V31_ALIGNMENT_SUMMARY_MISSING",
      message: "DevPlan alignment summary is required.",
      nextCommand: "pnpm run rt2:devplan-alignment-gate",
    });
  } else if (alignmentSummary.status !== "passed") {
    addBlocker(blockers, {
      area: "devplan-alignment",
      check: "alignment-summary",
      code: "V31_ALIGNMENT_GATE_BLOCKED",
      message: `DevPlan alignment gate status is ${alignmentSummary.status}.`,
      source: alignmentSummary.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
      nextCommand: "pnpm run rt2:devplan-alignment-gate",
    });
  } else {
    addPass(passed, {
      area: "devplan-alignment",
      check: "alignment-summary",
      code: "V31_ALIGNMENT_GATE_PASSED",
      message: "DevPlan alignment gate passed.",
      source: alignmentSummary.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
    });
  }

  if (scoreDeltaPct <= 0) {
    addBlocker(blockers, {
      area: "score-delta",
      check: "score-delta",
      code: "V31_SCORE_DELTA_NOT_POSITIVE",
      message: `Current score ${alignmentSummary?.currentScorePct ?? "unknown"}% does not improve on baseline ${alignmentSummary?.baselineScorePct ?? "unknown"}%.`,
      source: alignmentSummary?.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
    });
  } else {
    addPass(passed, {
      area: "score-delta",
      check: "score-delta",
      code: "V31_SCORE_DELTA_POSITIVE",
      message: `Score improved by ${scoreDeltaPct} percentage points from baseline.`,
      source: alignmentSummary?.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
    });
  }

  for (const result of results) {
    if (result.status === "passed") {
      addPass(passed, {
        area: result.area,
        check: result.id,
        code: "V31_FOCUSED_CHECK_PASSED",
        message: `${result.id} passed.`,
        source: result.evidence?.[0] ?? null,
      });
    } else {
      addBlocker(blockers, {
        area: result.area,
        check: result.id,
        code: "V31_FOCUSED_CHECK_FAILED",
        message: `${result.id} failed with exit code ${result.exitCode ?? "unknown"}.`,
        source: result.evidence?.[0] ?? null,
        nextCommand: result.command,
      });
    }
  }

  const evidenceByPath = collectEvidenceByPath(alignmentSummary);
  const missingEvidence = [];
  for (const evidence of evidenceByPath.values()) {
    if (!evidenceExists(normalizedRoot, evidence.path)) {
      missingEvidence.push({
        path: evidence.path,
        rows: evidence.rows,
        ownerPhases: [...evidence.ownerPhases],
      });
      addBlocker(blockers, {
        area: "required-evidence",
        check: "evidence-exists",
        code: "V31_REQUIRED_EVIDENCE_MISSING",
        message: `Required evidence path is missing: ${evidence.path}.`,
        source: evidence.path,
      });
    }
  }
  if (missingEvidence.length === 0) {
    addPass(passed, {
      area: "required-evidence",
      check: "evidence-exists",
      code: "V31_REQUIRED_EVIDENCE_PRESENT",
      message: `${evidenceByPath.size} required evidence path(s) exist.`,
    });
  }

  const git = gitStatus ?? readGitStatusLines(normalizedRoot);
  const dirtyEvidenceAnchors = git.available ? buildDirtyEvidenceItems(evidenceByPath, git.lines) : [];
  if (!git.available) {
    acceptedDebt.push({
      category: "accepted_debt",
      area: "git-status",
      code: "V31_GIT_STATUS_UNAVAILABLE",
      message: "Could not read git status; dirty evidence guard was skipped.",
      source: git.error,
      nextCommand: "git status --short --untracked-files=all",
    });
  }
  for (const item of dirtyEvidenceAnchors) {
    addBlocker(blockers, {
      area: "dirty-evidence",
      check: "git-status",
      code: "V31_DIRTY_EVIDENCE_ANCHOR",
      message: `Prior-phase evidence anchor is dirty or untracked: ${item.path}.`,
      source: item.path,
      nextCommand: "git status --short --untracked-files=all",
    });
  }
  if (git.available && dirtyEvidenceAnchors.length === 0) {
    addPass(passed, {
      area: "dirty-evidence",
      check: "git-status",
      code: "V31_PRIOR_EVIDENCE_CLEAN",
      message: "No dirty prior-phase evidence anchors detected.",
    });
  }

  return {
    version: 1,
    generatedAt: now.toISOString(),
    status: blockers.length > 0 ? "blocker" : "passed",
    baselineScorePct: alignmentSummary?.baselineScorePct ?? null,
    currentScorePct: alignmentSummary?.currentScorePct ?? null,
    scoreDeltaPct,
    alignmentRunDir: alignmentSummary?.runDir ?? null,
    counts: {
      checks: results.length,
      checksPassed: results.filter((result) => result.status === "passed").length,
      blockers: blockers.length,
      acceptedDebt: acceptedDebt.length,
      futureScope: futureScope.length,
      requiredEvidence: evidenceByPath.size,
      missingEvidence: missingEvidence.length,
      dirtyEvidenceAnchors: dirtyEvidenceAnchors.length,
    },
    checks: results,
    blockers,
    passed,
    acceptedDebt,
    futureScope,
    missingEvidence,
    dirtyEvidenceAnchors,
    gitStatus: {
      available: git.available,
      lines: git.lines ?? [],
      error: git.error ?? null,
    },
  };
}

function markdownTable(rows, columns) {
  const lines = [
    `| ${columns.map((column) => column.header).join(" | ")} |`,
    `| ${columns.map(() => "---").join(" | ")} |`,
  ];
  for (const row of rows) {
    lines.push(`| ${columns.map((column) => String(column.value(row) ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")).join(" | ")} |`);
  }
  return lines.join("\n");
}

function buildReport(summary) {
  const lines = [
    "# RealTycoon2 v3.1 Acceptance Gate",
    "",
    `Status: ${summary.status}`,
    `Generated: ${summary.generatedAt}`,
    `Baseline score: ${summary.baselineScorePct}%`,
    `Current score: ${summary.currentScorePct}%`,
    `Score delta: ${summary.scoreDeltaPct} percentage points`,
    `Alignment run: ${summary.alignmentRunDir ?? "none"}`,
    "",
    "| Checks | Passed | Blockers | Accepted debt | Future scope | Dirty evidence anchors |",
    "|--------|--------|----------|---------------|--------------|------------------------|",
    `| ${summary.counts.checks} | ${summary.counts.checksPassed} | ${summary.counts.blockers} | ${summary.counts.acceptedDebt} | ${summary.counts.futureScope} | ${summary.counts.dirtyEvidenceAnchors} |`,
    "",
    "## Focused Checks",
    "",
    markdownTable(summary.checks, [
      { header: "ID", value: (row) => row.id },
      { header: "Area", value: (row) => row.area },
      { header: "Status", value: (row) => row.status },
      { header: "Exit", value: (row) => row.exitCode ?? "" },
      { header: "Command", value: (row) => row.command },
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
      { header: "Area", value: (row) => row.area },
      { header: "Message", value: (row) => row.message },
      { header: "Source", value: (row) => row.source ?? "" },
      { header: "Next", value: (row) => row.nextCommand ?? "" },
    ]));
  }

  lines.push("", "## Accepted Debt", "");
  if (summary.acceptedDebt.length === 0) {
    lines.push("None.");
  } else {
    lines.push(markdownTable(summary.acceptedDebt, [
      { header: "Code", value: (row) => row.code },
      { header: "Message", value: (row) => row.message },
      { header: "Next", value: (row) => row.nextCommand ?? "" },
    ]));
  }

  lines.push("", "## Future Scope", "");
  lines.push(markdownTable(summary.futureScope, [
    { header: "Title", value: (row) => row.title },
    { header: "Source", value: (row) => row.source },
    { header: "Reason", value: (row) => row.reason },
  ]));

  lines.push("", "## Dirty Evidence Anchors", "");
  if (summary.dirtyEvidenceAnchors.length === 0) {
    lines.push("None.");
  } else {
    lines.push(markdownTable(summary.dirtyEvidenceAnchors, [
      { header: "Path", value: (row) => row.path },
      { header: "Status", value: (row) => row.status },
      { header: "Rows", value: (row) => row.rows.join(", ") },
      { header: "Owner phases", value: (row) => row.ownerPhases.join(", ") },
    ]));
  }

  return `${lines.join("\n")}\n`;
}

function writeV31AcceptanceGate(summary, { root, outputDir }) {
  const parent = outputDir
    ? path.resolve(root, outputDir)
    : path.join(root, ".planning", "v31-acceptance-runs");
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

function runV31AcceptanceGate(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const now = options.now ?? new Date();
  const alignmentSummary = options.alignmentSummary ?? runDevPlanAlignmentGate({ root, now });
  const summary = evaluateV31AcceptanceGate({
    root,
    now,
    checks: options.checks ?? DEFAULT_CHECKS,
    checkResults: options.checkResults ?? null,
    alignmentSummary,
    gitStatus: options.gitStatus ?? null,
  });
  return writeV31AcceptanceGate(summary, {
    root,
    outputDir: options.outputDir ?? null,
  });
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const written = runV31AcceptanceGate({
      root: args.root,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(written, null, 2));
    } else {
      console.log("# RealTycoon2 v3.1 Acceptance Gate");
      console.log("");
      console.log(`Status: ${written.status}`);
      console.log(`Current score: ${written.currentScorePct}%`);
      console.log(`Score delta: ${written.scoreDeltaPct} percentage points`);
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

if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("rt2-v31-acceptance-gate.mjs"))) {
  main();
}

export {
  DEFAULT_CHECKS,
  DEFAULT_FUTURE_SCOPE,
  buildReport,
  evaluateV31AcceptanceGate,
  runFocusedChecks,
  runV31AcceptanceGate,
  writeV31AcceptanceGate,
};
