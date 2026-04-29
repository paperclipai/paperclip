#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { checkPlanningArtifacts } from "./rt2-milestone-artifact-gate.mjs";

const V2_7_PHASES = [
  { number: "44", dir: "44-release-host-verification-harness", requirements: ["REL-01", "REL-02", "REL-03"] },
  { number: "45", dir: "45-embedded-postgres-runtime-coverage", requirements: ["PG-01", "PG-02", "PG-03"] },
  { number: "46", dir: "46-artifact-and-uat-truth-alignment", requirements: ["ART-01", "ART-02", "ART-03"] },
  { number: "47", dir: "47-runtime-confidence-operations-surface", requirements: ["CONF-01", "CONF-02"] },
];

const DEFAULT_DEFERRED_SCOPE = [
  {
    category: "deferred_scope",
    title: "Native/mobile distribution",
    source: ".planning/REQUIREMENTS.md",
    reason: "Requires the v2.7 release confidence foundation first.",
  },
  {
    category: "deferred_scope",
    title: "Cross-company knowledge federation",
    source: ".planning/REQUIREMENTS.md",
    reason: "Outside trusted single-company confidence gate for this milestone.",
  },
  {
    category: "deferred_scope",
    title: "Provider-backed eval mandate",
    source: ".planning/REQUIREMENTS.md",
    reason: "Deterministic local and CI fallback remains required.",
  },
  {
    category: "deferred_scope",
    title: "New Jarvis autonomous apply behavior",
    source: ".planning/REQUIREMENTS.md",
    reason: "Direct apply remains approval-first future scope.",
  },
];

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    outputDir: null,
    releaseHostSummary: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[++i]);
    } else if (arg === "--output-dir") {
      args.outputDir = path.resolve(argv[++i]);
    } else if (arg === "--release-host-summary") {
      args.releaseHostSummary = path.resolve(argv[++i]);
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

function exists(filePath) {
  return fs.existsSync(filePath);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readText(filePath));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function repoPath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/") || ".";
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function latestAttemptsBySlice(attempts = []) {
  const latest = new Map();
  for (const attempt of attempts) latest.set(attempt.sliceId, attempt);
  return [...latest.values()];
}

function findLatestReleaseHostSummary(root) {
  const runsDir = path.join(root, ".planning", "release-host-runs");
  if (!exists(runsDir)) return null;
  const summaries = [];
  for (const entry of fs.readdirSync(runsDir)) {
    const summary = path.join(runsDir, entry, "summary.json");
    if (exists(summary)) summaries.push(summary);
  }
  summaries.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs || b.localeCompare(a));
  return summaries[0] ?? null;
}

function parseRequirements(root) {
  const rel = path.join(".planning", "REQUIREMENTS.md");
  const abs = path.join(root, rel);
  if (!exists(abs)) return { checked: new Map(), traceRows: new Map() };
  const text = readText(abs);
  const checked = new Map();
  const traceRows = new Map();
  for (const match of text.matchAll(/^- \[([ xX])\] \*\*([A-Z]+-\d+)\*\*/gm)) {
    checked.set(match[2], match[1].toLowerCase() === "x");
  }
  for (const match of text.matchAll(/^\|\s*([A-Z]+-\d+)\s*\|\s*Phase\s+([0-9]+)\s*\|\s*([A-Za-z_ -]+)\s*\|/gm)) {
    traceRows.set(match[1], { phase: match[2], status: match[3].trim() });
  }
  return { checked, traceRows };
}

function extractFrontmatterMap(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const values = {};
  let currentList = null;
  for (const line of match[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s*-\s+(.+?)\s*$/);
    if (currentList && listItem) {
      values[currentList].push(listItem[1].replace(/^["']|["']$/g, ""));
      continue;
    }
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) {
      currentList = null;
      continue;
    }
    const [, key, rawValue] = field;
    if (rawValue === "") {
      values[key] = [];
      currentList = key;
    } else {
      values[key] = rawValue.replace(/^["']|["']$/g, "");
      currentList = null;
    }
  }
  return values;
}

function findSummaryArtifact(root, phase) {
  const dir = path.join(root, ".planning", "phases", phase.dir);
  if (!exists(dir)) return null;
  const candidate = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(`${phase.number}-`) && name.endsWith("SUMMARY.md"))
    .sort()[0];
  return candidate ? path.join(".planning", "phases", phase.dir, candidate).split(path.sep).join("/") : null;
}

function buildRequirementEvidence(root) {
  const requirements = parseRequirements(root);
  const rows = [];
  for (const phase of V2_7_PHASES) {
    for (const req of phase.requirements) {
      const verification = path.join(".planning", "phases", phase.dir, `${phase.number}-VERIFICATION.md`).split(path.sep).join("/");
      const validation = path.join(".planning", "phases", phase.dir, `${phase.number}-VALIDATION.md`).split(path.sep).join("/");
      const verificationAbs = path.join(root, verification);
      const validationAbs = path.join(root, validation);
      const checked = requirements.checked.get(req) === true;
      const trace = requirements.traceRows.get(req);
      const validationFrontmatter = exists(validationAbs) ? extractFrontmatterMap(readText(validationAbs)) : null;
      const verificationMentionsReq = exists(verificationAbs) && new RegExp(`\\b${req}\\b`).test(readText(verificationAbs));
      const validationMentionsReq = Array.isArray(validationFrontmatter?.requirements_validated)
        ? validationFrontmatter.requirements_validated.includes(req)
        : false;
      rows.push({
        requirement: req,
        phase: phase.number,
        status: checked ? "passed" : "pending",
        traceabilityStatus: trace?.status ?? "missing",
        verificationArtifact: exists(verificationAbs) ? verification : null,
        validationArtifact: exists(validationAbs) ? validation : null,
        summaryArtifact: findSummaryArtifact(root, phase),
        verificationMentionsReq,
        validationStatus: validationFrontmatter?.status ?? null,
        validationMentionsReq,
      });
    }
  }
  return rows;
}

function releaseHostItems(root, releaseHostSummaryPath) {
  const blockers = [];
  const acceptedDebt = [];
  const passed = [];
  const summaryPath = releaseHostSummaryPath ?? findLatestReleaseHostSummary(root);
  if (!summaryPath || !exists(summaryPath)) {
    blockers.push({
      category: "blocker",
      source: ".planning/release-host-runs",
      code: "RELEASE_HOST_SUMMARY_MISSING",
      message: "No release-host summary found.",
      owner: "workspace",
      nextCommand: "pnpm run rt2:release-host-verify",
    });
    return { summary: null, summaryPath: null, blockers, acceptedDebt, passed };
  }

  const summary = readJson(summaryPath);
  for (const attempt of latestAttemptsBySlice(summary.attempts)) {
    if (attempt.status === "accepted_debt") {
      const hasClosure = Boolean(attempt.retryRecommendation);
      const debtItem = {
        category: hasClosure ? "accepted_debt" : "blocker",
        source: repoPath(root, summaryPath),
        code: attempt.debt?.reasonCode ?? "ACCEPTED_DEBT",
        message: attempt.debt?.reason ?? `${attempt.sliceId} is accepted debt.`,
        owner: attempt.owner ?? "unknown",
        nextCommand: attempt.retryRecommendation ?? null,
        sliceId: attempt.sliceId,
      };
      if (hasClosure) acceptedDebt.push(debtItem);
      else blockers.push({ ...debtItem, code: "ACCEPTED_DEBT_CLOSURE_MISSING" });
    } else if (["failed", "timeout", "error"].includes(attempt.status)) {
      blockers.push({
        category: "blocker",
        source: repoPath(root, summaryPath),
        code: `RELEASE_HOST_${String(attempt.status).toUpperCase()}`,
        message: `${attempt.sliceId} ended with ${attempt.status}.`,
        owner: attempt.owner ?? "unknown",
        nextCommand: attempt.retryRecommendation ?? "pnpm run rt2:release-host-rerun -- <summary.json>",
        sliceId: attempt.sliceId,
      });
    } else if (attempt.status === "passed") {
      passed.push({
        category: "passed",
        source: repoPath(root, summaryPath),
        code: "RELEASE_HOST_SLICE_PASSED",
        message: `${attempt.sliceId} passed.`,
        owner: attempt.owner ?? "unknown",
        sliceId: attempt.sliceId,
      });
    }
  }
  return { summary, summaryPath: repoPath(root, summaryPath), blockers, acceptedDebt, passed };
}

function artifactGateItems(root, gateResult = null) {
  const result = gateResult ?? checkPlanningArtifacts(root);
  const blockers = [];
  const passed = [];
  if (result.passed) {
    passed.push({
      category: "passed",
      source: "scripts/rt2-milestone-artifact-gate.mjs",
      code: "MILESTONE_GATE_PASSED",
      message: "Milestone artifact gate passed.",
      owner: "planning-tooling",
    });
  } else {
    for (const issue of result.issues ?? []) {
      blockers.push({
        category: "blocker",
        source: issue.file,
        code: issue.code,
        message: issue.message,
        owner: "planning-tooling",
        nextCommand: "pnpm run rt2:milestone-gate -- --json",
      });
    }
  }
  return { result, blockers, passed };
}

function buildRuntimeConfidence(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const release = releaseHostItems(root, options.releaseHostSummaryPath);
  const artifactGate = artifactGateItems(root, options.gateResult ?? null);
  const requirements = buildRequirementEvidence(root);
  const pending = requirements
    .filter((row) => row.status === "pending")
    .map((row) => ({
      category: "pending",
      source: ".planning/REQUIREMENTS.md",
      code: "REQUIREMENT_PENDING",
      message: `${row.requirement} is still pending for Phase ${row.phase}.`,
      owner: "planning-tooling",
      requirement: row.requirement,
    }));
  const blockers = [...release.blockers, ...artifactGate.blockers];
  const acceptedDebt = release.acceptedDebt;
  const deferredScope = options.deferredScope ?? DEFAULT_DEFERRED_SCOPE;
  const passed = [...release.passed, ...artifactGate.passed];
  const status = blockers.length > 0
    ? "blocker"
    : acceptedDebt.length > 0
      ? "accepted_debt"
      : pending.length > 0
        ? "pending"
        : "passed";

  return {
    version: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    status,
    counts: {
      blockers: blockers.length,
      acceptedDebt: acceptedDebt.length,
      deferredScope: deferredScope.length,
      pending: pending.length,
      passed: passed.length,
    },
    inputs: {
      releaseHostSummary: release.summaryPath,
      milestoneGatePassed: artifactGate.result.passed,
    },
    blockers,
    acceptedDebt,
    deferredScope,
    pending,
    passed,
    releaseHost: release.summary
      ? {
          status: release.summary.status,
          runDir: release.summary.runDir ?? null,
          updatedAt: release.summary.updatedAt ?? null,
          attempts: latestAttemptsBySlice(release.summary.attempts),
        }
      : null,
    milestoneGate: artifactGate.result,
    requirements,
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
    "# RT2 Runtime Confidence",
    "",
    `Status: ${summary.status}`,
    `Generated: ${summary.generatedAt}`,
    `Release-host summary: ${summary.inputs.releaseHostSummary ? `\`${summary.inputs.releaseHostSummary}\`` : "missing"}`,
    `Milestone gate: ${summary.inputs.milestoneGatePassed ? "passed" : "failed"}`,
    "",
    "| Blockers | Accepted Debt | Deferred Scope | Pending | Passed Signals |",
    "|----------|---------------|----------------|---------|----------------|",
    `| ${summary.counts.blockers} | ${summary.counts.acceptedDebt} | ${summary.counts.deferredScope} | ${summary.counts.pending} | ${summary.counts.passed} |`,
    "",
  ];

  lines.push("## Blockers", "");
  if (summary.blockers.length === 0) {
    lines.push("None.");
  } else {
    lines.push(markdownTable(summary.blockers, [
      { header: "Code", value: (row) => row.code },
      { header: "Owner", value: (row) => row.owner },
      { header: "Source", value: (row) => row.source },
      { header: "Message", value: (row) => row.message },
      { header: "Next Command", value: (row) => row.nextCommand },
    ]));
  }

  lines.push("", "## Accepted Debt", "");
  if (summary.acceptedDebt.length === 0) {
    lines.push("None.");
  } else {
    lines.push(markdownTable(summary.acceptedDebt, [
      { header: "Code", value: (row) => row.code },
      { header: "Owner", value: (row) => row.owner },
      { header: "Source", value: (row) => row.source },
      { header: "Reason", value: (row) => row.message },
      { header: "Closure Command", value: (row) => row.nextCommand },
    ]));
  }

  lines.push("", "## Deferred Future Scope", "");
  lines.push(markdownTable(summary.deferredScope, [
    { header: "Item", value: (row) => row.title },
    { header: "Source", value: (row) => row.source },
    { header: "Reason", value: (row) => row.reason },
  ]));

  lines.push("", "## Release Host Attempts", "");
  if (!summary.releaseHost) {
    lines.push("No release-host summary available.");
  } else {
    lines.push(markdownTable(summary.releaseHost.attempts, [
      { header: "Slice", value: (row) => row.sliceId },
      { header: "Suite", value: (row) => row.suite },
      { header: "Status", value: (row) => row.status },
      { header: "Owner", value: (row) => row.owner },
      { header: "Duration", value: (row) => `${row.durationMs ?? 0}ms` },
      { header: "Retry", value: (row) => row.retryRecommendation },
    ]));
  }

  lines.push("", "## v2.7 Requirement Evidence", "");
  lines.push(markdownTable(summary.requirements, [
    { header: "Requirement", value: (row) => row.requirement },
    { header: "Phase", value: (row) => row.phase },
    { header: "Status", value: (row) => row.status },
    { header: "Traceability", value: (row) => row.traceabilityStatus },
    { header: "Verification", value: (row) => row.verificationArtifact ?? "missing" },
    { header: "Validation", value: (row) => row.validationArtifact ?? "missing" },
  ]));

  return `${lines.join("\n")}\n`;
}

function writeRuntimeConfidence(summary, { root, outputDir }) {
  const runDirAbs = path.resolve(outputDir ?? path.join(root, ".planning", "runtime-confidence", timestampForPath()));
  ensureDir(runDirAbs);
  const out = {
    ...summary,
    runDir: repoPath(root, runDirAbs),
  };
  fs.writeFileSync(path.join(runDirAbs, "summary.json"), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(runDirAbs, "report.md"), buildReport(out), "utf8");
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/rt2-runtime-confidence.mjs [options]

Options:
  --root <path>                    Repository root (default: cwd)
  --release-host-summary <path>    Release-host summary.json to consume
  --output-dir <path>              Output directory (default: .planning/runtime-confidence/<timestamp>)
  --json                           Print JSON summary
  --help                           Show this help
`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      printHelp();
      return;
    }
    const root = path.resolve(args.root);
    const summary = buildRuntimeConfidence({
      root,
      releaseHostSummaryPath: args.releaseHostSummary,
    });
    const written = writeRuntimeConfidence(summary, {
      root,
      outputDir: args.outputDir,
    });
    if (args.json) {
      console.log(JSON.stringify(written, null, 2));
    } else {
      console.log("# RT2 Runtime Confidence");
      console.log("");
      console.log(`Status: ${written.status}`);
      console.log(`Summary: ${path.join(written.runDir, "summary.json").split(path.sep).join("/")}`);
      console.log(`Report: ${path.join(written.runDir, "report.md").split(path.sep).join("/")}`);
      console.log(`Blockers: ${written.counts.blockers}`);
      console.log(`Accepted debt: ${written.counts.acceptedDebt}`);
      console.log(`Deferred scope: ${written.counts.deferredScope}`);
    }
    process.exit(written.status === "blocker" ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-runtime-confidence.mjs")) {
  main();
}

export {
  buildReport,
  buildRequirementEvidence,
  buildRuntimeConfidence,
  findLatestReleaseHostSummary,
  releaseHostItems,
  writeRuntimeConfidence,
};
