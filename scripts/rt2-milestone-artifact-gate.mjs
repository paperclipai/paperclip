#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_PHASES = [
  { number: "39", dir: "39-enterprise-connector-apply-loop", requirements: ["EXT-01", "EXT-02"] },
  { number: "40", dir: "40-trusted-local-knowledge-bridge", requirements: ["EXT-03"] },
  { number: "41", dir: "41-native-and-mobile-capture-hardening", requirements: ["CAP-01", "CAP-02", "CAP-03"] },
  { number: "42", dir: "42-jarvis-autonomy-eval-guardrails", requirements: ["AUTO-01", "AUTO-02", "AUTO-03"] },
  { number: "43", dir: "43-validation-debt-and-milestone-gate-closure", requirements: ["VAL-01", "VAL-02", "VAL-03"] },
];

const HISTORICAL_VALIDATION_PHASES = [
  { number: "19", dir: "19-validation-and-route-test-hardening" },
  { number: "20", dir: "20-enterprise-rollout-connectors" },
  { number: "21", dir: "21-obsidian-bidirectional-knowledge-sync" },
  { number: "22", dir: "22-settlement-governance-and-anti-gaming" },
  { number: "23", dir: "23-advanced-work-board-and-native-capture" },
  { number: "24", dir: "24-phase19-verification-artifact-closure" },
];

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
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

function extractFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return null;
  }
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return null;
  const fields = new Set();
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):/);
    if (field) fields.add(field[1]);
  }
  return fields;
}

function addIssue(issues, code, file, message) {
  issues.push({ code, file: path.normalize(file), message });
}

function requireFile(issues, root, rel, code, message) {
  const abs = path.join(root, rel);
  if (!exists(abs)) {
    addIssue(issues, code, rel, message);
    return false;
  }
  return true;
}

function findSummary(root, phase) {
  const dir = path.join(root, ".planning", "phases", phase.dir);
  if (!exists(dir)) return null;
  const candidates = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith("SUMMARY.md") && name.startsWith(`${phase.number}-`));
  return candidates.length > 0 ? path.join(".planning", "phases", phase.dir, candidates.sort()[0]) : null;
}

function checkSummaryFrontmatter(issues, root, rel, phase) {
  const text = readText(path.join(root, rel));
  const fields = extractFrontmatter(text);
  if (!fields) {
    addIssue(issues, "SUMMARY_FRONTMATTER_MISSING", rel, "Summary has no YAML frontmatter.");
    return;
  }
  for (const field of ["phase", "status"]) {
    if (!fields.has(field)) {
      addIssue(issues, "SUMMARY_FRONTMATTER_FIELD_MISSING", rel, `Summary frontmatter missing '${field}'.`);
    }
  }
  if (!fields.has("requirements_addressed") && !fields.has("requirements_completed") && !fields.has("requirements-completed")) {
    addIssue(
      issues,
      "SUMMARY_REQUIREMENTS_FIELD_MISSING",
      rel,
      `Summary frontmatter for Phase ${phase.number} must include requirements_addressed or requirements-completed.`,
    );
  }
}

function checkRequirements(issues, root) {
  const rel = path.join(".planning", "REQUIREMENTS.md");
  if (!requireFile(issues, root, rel, "REQUIREMENTS_MISSING", "Missing active requirements file.")) return;
  const text = readText(path.join(root, rel));
  for (const phase of DEFAULT_PHASES) {
    for (const req of phase.requirements) {
      const checked = new RegExp(`- \\[x\\] \\*\\*${req}\\*\\*`, "i").test(text);
      if (!checked) {
        addIssue(issues, "REQUIREMENT_CHECKBOX_OPEN", rel, `${req} checkbox is not checked.`);
      }
      const trace = new RegExp(`\\|\\s*${req}\\s*\\|\\s*Phase ${phase.number}\\s*\\|\\s*Complete\\s*\\|`, "i").test(text);
      if (!trace) {
        addIssue(issues, "REQUIREMENT_TRACEABILITY_INCOMPLETE", rel, `${req} traceability row is not Complete for Phase ${phase.number}.`);
      }
    }
  }
}

function checkPlanningArtifacts(root) {
  const issues = [];

  for (const phase of DEFAULT_PHASES) {
    const phaseDir = path.join(".planning", "phases", phase.dir);
    if (!requireFile(issues, root, phaseDir, "PHASE_DIR_MISSING", `Missing Phase ${phase.number} directory.`)) {
      continue;
    }

    const summary = findSummary(root, phase);
    if (!summary) {
      addIssue(issues, "SUMMARY_MISSING", phaseDir, `Missing Phase ${phase.number} summary artifact.`);
    } else {
      checkSummaryFrontmatter(issues, root, summary, phase);
    }

    requireFile(
      issues,
      root,
      path.join(phaseDir, `${phase.number}-VERIFICATION.md`),
      "VERIFICATION_MISSING",
      `Missing Phase ${phase.number} verification artifact.`,
    );
    requireFile(
      issues,
      root,
      path.join(phaseDir, `${phase.number}-VALIDATION.md`),
      "VALIDATION_MISSING",
      `Missing Phase ${phase.number} validation artifact.`,
    );
  }

  for (const phase of HISTORICAL_VALIDATION_PHASES) {
    requireFile(
      issues,
      root,
      path.join(".planning", "phases", phase.dir, `${phase.number}-VALIDATION.md`),
      "HISTORICAL_VALIDATION_MISSING",
      `Missing historical Phase ${phase.number} strict validation artifact.`,
    );
  }

  requireFile(
    issues,
    root,
    path.join(".planning", "phases", "43-validation-debt-and-milestone-gate-closure", "43-LEGACY-UAT-CLOSURE.md"),
    "LEGACY_UAT_CLOSURE_MISSING",
    "Missing legacy UAT closure artifact.",
  );

  checkRequirements(issues, root);

  return {
    passed: issues.length === 0,
    checkedPhases: DEFAULT_PHASES.map((phase) => phase.number),
    historicalValidationPhases: HISTORICAL_VALIDATION_PHASES.map((phase) => phase.number),
    issueCount: issues.length,
    issues,
  };
}

function printText(result) {
  console.log("# RT2 Milestone Artifact Gate");
  console.log("");
  console.log(`Status: ${result.passed ? "passed" : "failed"}`);
  console.log(`Checked phases: ${result.checkedPhases.join(", ")}`);
  console.log(`Historical validation phases: ${result.historicalValidationPhases.join(", ")}`);
  console.log("");
  if (result.passed) {
    console.log("No artifact gaps found.");
    return;
  }
  console.log("| Code | File | Message |");
  console.log("|------|------|---------|");
  for (const issue of result.issues) {
    console.log(`| ${issue.code} | \`${issue.file}\` | ${issue.message.replace(/\|/g, "\\|")} |`);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("rt2-milestone-artifact-gate.mjs")) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/rt2-milestone-artifact-gate.mjs [--root <path>] [--json]");
    process.exit(0);
  }
  const result = checkPlanningArtifacts(args.root);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }
  process.exit(result.passed ? 0 : 1);
}

export { checkPlanningArtifacts };
