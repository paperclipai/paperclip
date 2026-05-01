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
  {
    id: "phase72-public-marketplace",
    area: "phase72",
    command: "pnpm exec vitest run server/src/__tests__/rt2-phase72-public-marketplace.test.ts",
    env: { PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true" },
    evidence: ["server/src/__tests__/rt2-phase72-public-marketplace.test.ts"],
  },
  {
    id: "phase73-payroll-settlement",
    area: "phase73",
    command: "pnpm exec vitest run server/src/__tests__/rt2-phase73-payroll-settlement.test.ts",
    env: { PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true" },
    evidence: ["server/src/__tests__/rt2-phase73-payroll-settlement.test.ts"],
  },
  {
    id: "phase74-federation",
    area: "phase74",
    command: "pnpm exec vitest run server/src/__tests__/rt2-phase74-federation.test.ts",
    env: { PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true" },
    evidence: ["server/src/__tests__/rt2-phase74-federation.test.ts"],
  },
  {
    id: "phase75-jarvis-autonomy",
    area: "phase75",
    command: "pnpm exec vitest run server/src/__tests__/rt2-phase75-jarvis-autonomy.test.ts",
    env: { PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true" },
    evidence: ["server/src/__tests__/rt2-phase75-jarvis-autonomy.test.ts"],
  },
  {
    id: "phase76-store-operations",
    area: "phase76",
    command: "pnpm exec vitest run server/src/__tests__/rt2-phase76-store-operations.test.ts",
    env: { PAPERCLIP_ENABLE_EMBEDDED_POSTGRES_TESTS: "true" },
    evidence: ["server/src/__tests__/rt2-phase76-store-operations.test.ts"],
  },
];

const DEFAULT_FUTURE_SCOPE = [
  {
    category: "future_scope",
    title: "v3.3 Planning",
    source: ".planning/ROADMAP.md",
    reason: "v3.2 is complete. Future phases TBD based on product direction.",
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
      args.outputDir = path.resolve(argv[++i]);
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
  console.log(`Usage: node scripts/rt2-v32-acceptance-gate.mjs [options]

Options:
  --root <path>          Repository root (default: cwd)
  --output-dir <path>   Evidence parent directory (default: .planning/v32-acceptance-runs)
  --json                Print JSON summary
  --help                Show this help
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
  owner = "v32-acceptance",
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
    // Only include dirty items owned by phase 72+
    const postV31Phase = ownerPhases.some((phase) => {
      const num = parseInt(phase, 10);
      return !isNaN(num) && num >= 72;
    });
    if (!postV31Phase) continue;
    dirty.push({
      path: dirtyPath,
      status: line.slice(0, 2),
      rows: evidence.rows,
      ownerPhases,
    });
  }
  return dirty;
}

function evaluateV32AcceptanceGate({
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
      code: "V32_ALIGNMENT_SUMMARY_MISSING",
      message: "DevPlan alignment summary is required.",
      nextCommand: "pnpm run rt2:devplan-alignment-gate",
    });
  } else if (alignmentSummary.status !== "passed") {
    addBlocker(blockers, {
      area: "devplan-alignment",
      check: "alignment-summary",
      code: "V32_ALIGNMENT_GATE_BLOCKED",
      message: `DevPlan alignment gate status is ${alignmentSummary.status}.`,
      source: alignmentSummary.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
      nextCommand: "pnpm run rt2:devplan-alignment-gate",
    });
  } else {
    addPass(passed, {
      area: "devplan-alignment",
      check: "alignment-summary",
      code: "V32_ALIGNMENT_GATE_PASSED",
      message: "DevPlan alignment gate passed.",
      source: alignmentSummary.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
    });
  }

  // Score delta check (v3.2 should improve on v3.1 baseline)
  if (scoreDeltaPct < 0) {
    addBlocker(blockers, {
      area: "score-delta",
      check: "score-delta",
      code: "V32_SCORE_DELTA_NEGATIVE",
      message: `Current score ${alignmentSummary?.currentScorePct ?? "unknown"}% is below baseline ${alignmentSummary?.baselineScorePct ?? "unknown"}%.`,
      source: alignmentSummary?.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
    });
  } else {
    addPass(passed, {
      area: "score-delta",
      check: "score-delta",
      code: "V32_SCORE_DELTA_ACCEPTABLE",
      message: `Score delta ${scoreDeltaPct >= 0 ? "is non-negative" : `improved by ${scoreDeltaPct}`} percentage points from baseline.`,
      source: alignmentSummary?.runDir ? `${alignmentSummary.runDir}/summary.json` : null,
    });
  }

  for (const result of results) {
    if (result.status === "passed") {
      addPass(passed, {
        area: result.area,
        check: result.id,
        code: "V32_FOCUSED_CHECK_PASSED",
        message: `${result.id} passed.`,
        source: result.evidence?.[0] ?? null,
      });
    } else {
      addBlocker(blockers, {
        area: result.area,
        check: result.id,
        code: "V32_FOCUSED_CHECK_FAILED",
        message: `${result.id} failed with exit code ${result.exitCode ?? "unknown"}.`,
        source: result.evidence?.[0] ?? null,
        nextCommand: result.command,
      });
    }
  }

  // Check for dirty evidence
  const evidenceByPath = collectEvidenceByPath(alignmentSummary);
  const gitStatusLines = gitStatus?.lines ?? [];
  const dirtyEvidence = buildDirtyEvidenceItems(evidenceByPath, gitStatusLines);
  for (const item of dirtyEvidence) {
    acceptedDebt.push({
      category: "accepted-debt",
      area: "dirty-evidence",
      check: item.path,
      code: "V32_DIRTY_EVIDENCE",
      message: `${item.path} has uncommitted changes (${item.status}) but is evidence for ${item.rows.join(", ")}.`,
      source: item.path,
      ownerPhases: item.ownerPhases,
    });
  }

  // Check for missing evidence files
  for (const row of alignmentSummary?.rows ?? []) {
    if (row.status !== "complete") continue;
    for (const entry of row.evidence ?? []) {
      if (!entry.path) continue;
      if (!evidenceExists(normalizedRoot, entry.path)) {
        addBlocker(blockers, {
          area: "evidence",
          check: row.id,
          code: "V32_EVIDENCE_FILE_MISSING",
          message: `Evidence file ${entry.path} does not exist.`,
          source: entry.path,
          owner: row.ownerPhase ?? "unknown",
        });
      }
    }
  }

  const counts = {
    blockers: blockers.length,
    passed: passed.length,
    acceptedDebt: acceptedDebt.length,
    futureScope: futureScope.length,
  };

  const status =
    blockers.length > 0
      ? "blocker"
      : acceptedDebt.length > 0
        ? "accepted-debt"
        : "passed";

  return {
    status,
    counts,
    blockers,
    passed,
    acceptedDebt,
    futureScope,
    results,
    scoreDeltaPct,
    currentScorePct: alignmentSummary?.currentScorePct ?? 0,
    baselineScorePct: alignmentSummary?.baselineScorePct ?? 0,
  };
}

function buildReport(evaluation) {
  const lines = [];
  lines.push(`# v3.2 Acceptance Gate Report`);
  lines.push("");
  lines.push(`**Status:** ${evaluation.status}`);
  lines.push(`**Score:** ${evaluation.currentScorePct}% (baseline: ${evaluation.baselineScorePct}%, delta: ${evaluation.scoreDeltaPct}pp)`);
  lines.push("");

  lines.push("## Passed Checks");
  lines.push("");
  for (const item of evaluation.passed) {
    lines.push(`- [${item.code}] ${item.message}`);
    if (item.source) lines.push(`  - Evidence: ${item.source}`);
  }
  lines.push("");

  if (evaluation.blockers.length > 0) {
    lines.push("## Blockers");
    lines.push("");
    for (const item of evaluation.blockers) {
      lines.push(`- [${item.code}] ${item.message}`);
      if (item.source) lines.push(`  - Source: ${item.source}`);
      if (item.nextCommand) lines.push(`  - Fix: \`${item.nextCommand}\``);
    }
    lines.push("");
  }

  if (evaluation.acceptedDebt.length > 0) {
    lines.push("## Accepted Debt");
    lines.push("");
    for (const item of evaluation.acceptedDebt) {
      lines.push(`- [${item.code}] ${item.message}`);
    }
    lines.push("");
  }

  if (evaluation.futureScope.length > 0) {
    lines.push("## Future Scope");
    lines.push("");
    for (const item of evaluation.futureScope) {
      lines.push(`- **${item.title}** — ${item.reason}`);
    }
    lines.push("");
  }

  lines.push("## Focused Check Results");
  lines.push("");
  for (const result of evaluation.results) {
    const icon = result.status === "passed" ? "✅" : "❌";
    lines.push(`- ${icon} **${result.id}** (${result.durationMs}ms)`);
  }
  lines.push("");

  return lines.join("\n");
}

function writeV32AcceptanceGate(summary, {
  root = process.cwd(),
  outputDir = null,
}) {
  const ts = timestampForPath();
  const dir = outputDir ?? path.join(root, ".planning", "v32-acceptance-runs", ts);
  ensureDir(dir);

  const reportMd = buildReport(summary);
  fs.writeFileSync(path.join(dir, "report.md"), reportMd, "utf8");
  fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  return {
    status: summary.status,
    runDir: repoPath(root, dir),
    counts: summary.counts,
    currentScorePct: summary.currentScorePct,
    baselineScorePct: summary.baselineScorePct,
    scoreDeltaPct: summary.scoreDeltaPct,
  };
}

async function runV32AcceptanceGate({
  root = process.cwd(),
  outputDir = null,
  alignmentSummary = null,
} = {}) {
  const normalizedRoot = path.resolve(root);
  const gitStatus = readGitStatusLines(normalizedRoot);

  // Run alignment gate if not provided
  if (!alignmentSummary) {
    const alignmentResult = await runDevPlanAlignmentGate({ root: normalizedRoot });
    alignmentSummary = alignmentResult;
  }

  const summary = evaluateV32AcceptanceGate({
    root: normalizedRoot,
    alignmentSummary,
    gitStatus: gitStatus ?? null,
  });
  return writeV32AcceptanceGate(summary, {
    root,
    outputDir,
  });
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const written = await runV32AcceptanceGate({
      root: args.root,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(written, null, 2));
    } else {
      console.log("# RealTycoon2 v3.2 Acceptance Gate");
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

if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("rt2-v32-acceptance-gate.mjs"))) {
  main();
}

export {
  DEFAULT_CHECKS,
  DEFAULT_FUTURE_SCOPE,
  buildReport,
  evaluateV32AcceptanceGate,
  runFocusedChecks,
  runV32AcceptanceGate,
};
