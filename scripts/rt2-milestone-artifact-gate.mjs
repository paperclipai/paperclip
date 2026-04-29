#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const LEGACY_V2_6_PHASES = [
  { number: "39", dir: "39-enterprise-connector-apply-loop", requirements: ["EXT-01", "EXT-02"] },
  { number: "40", dir: "40-trusted-local-knowledge-bridge", requirements: ["EXT-03"] },
  { number: "41", dir: "41-native-and-mobile-capture-hardening", requirements: ["CAP-01", "CAP-02", "CAP-03"] },
  { number: "42", dir: "42-jarvis-autonomy-eval-guardrails", requirements: ["AUTO-01", "AUTO-02", "AUTO-03"] },
  { number: "43", dir: "43-validation-debt-and-milestone-gate-closure", requirements: ["VAL-01", "VAL-02", "VAL-03"] },
];

const ACTIVE_V2_7_PHASES = [
  { number: "44", dir: "44-release-host-verification-harness", requirements: ["REL-01", "REL-02", "REL-03"] },
  { number: "45", dir: "45-embedded-postgres-runtime-coverage", requirements: ["PG-01", "PG-02", "PG-03"] },
  { number: "46", dir: "46-artifact-and-uat-truth-alignment", requirements: ["ART-01", "ART-02", "ART-03"] },
  { number: "47", dir: "47-runtime-confidence-operations-surface", requirements: ["CONF-01", "CONF-02"] },
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

function parseRequirementsStatus(root) {
  const rel = path.join(".planning", "REQUIREMENTS.md");
  const abs = path.join(root, rel);
  if (!exists(abs)) return { text: "", checked: new Map(), traceRows: new Map() };
  const text = readText(abs);
  const checked = new Map();
  const traceRows = new Map();
  const checkboxPattern = /^- \[([ xX])\] \*\*([A-Z]+-\d+)\*\*/gm;
  for (const match of text.matchAll(checkboxPattern)) {
    checked.set(match[2], match[1].toLowerCase() === "x");
  }
  const rowPattern = /^\|\s*([A-Z]+-\d+)\s*\|\s*Phase\s+([0-9]+)\s*\|\s*([A-Za-z_ -]+)\s*\|/gm;
  for (const match of text.matchAll(rowPattern)) {
    const rows = traceRows.get(match[1]) ?? [];
    rows.push({ phase: match[2], status: match[3].trim() });
    traceRows.set(match[1], rows);
  }
  return { text, checked, traceRows };
}

function checkRequirements(issues, root) {
  const rel = path.join(".planning", "REQUIREMENTS.md");
  if (!requireFile(issues, root, rel, "REQUIREMENTS_MISSING", "Missing active requirements file.")) return;
  const { text } = parseRequirementsStatus(root);
  for (const phase of LEGACY_V2_6_PHASES) {
    for (const req of phase.requirements) {
      if (!new RegExp(`\\*\\*${req}\\*\\*`, "i").test(text)) {
        continue;
      }
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

function isRequirementComplete(requirementsStatus, req) {
  return requirementsStatus.checked.get(req) === true;
}

function phaseHasCompletedRequirement(requirementsStatus, phase) {
  return phase.requirements.some((req) => isRequirementComplete(requirementsStatus, req));
}

function checkValidationFrontmatter(issues, root, phase) {
  const rel = path.join(".planning", "phases", phase.dir, `${phase.number}-VALIDATION.md`);
  if (!requireFile(issues, root, rel, "VALIDATION_MISSING", `Missing Phase ${phase.number} validation artifact.`)) return;
  const frontmatter = extractFrontmatterMap(readText(path.join(root, rel)));
  if (!frontmatter) {
    addIssue(issues, "VALIDATION_FRONTMATTER_MISSING", rel, `Phase ${phase.number} validation artifact has no YAML frontmatter.`);
    return;
  }
  if (String(frontmatter.phase) !== phase.number) {
    addIssue(issues, "VALIDATION_FRONTMATTER_STALE", rel, `Phase ${phase.number} validation frontmatter has phase '${frontmatter.phase ?? "missing"}'.`);
  }
  if (!["passed", "complete", "validated"].includes(String(frontmatter.status ?? "").toLowerCase())) {
    addIssue(issues, "VALIDATION_FRONTMATTER_STALE", rel, `Phase ${phase.number} validation status is '${frontmatter.status ?? "missing"}', expected passed/complete/validated.`);
  }
  const listed = new Set([
    ...(Array.isArray(frontmatter.requirements_validated) ? frontmatter.requirements_validated : []),
    ...(Array.isArray(frontmatter.requirements_addressed) ? frontmatter.requirements_addressed : []),
  ]);
  for (const req of phase.requirements) {
    if (!listed.has(req)) {
      addIssue(issues, "VALIDATION_REQUIREMENT_MISSING", rel, `Phase ${phase.number} validation frontmatter does not list ${req}.`);
    }
  }
}

function countRequirementRows(requirementsStatus, req) {
  return requirementsStatus.traceRows.get(req) ?? [];
}

function checkActiveRequirementTraceability(issues, root, requirementsStatus) {
  const reqRel = path.join(".planning", "REQUIREMENTS.md");
  for (const phase of ACTIVE_V2_7_PHASES) {
    for (const req of phase.requirements) {
      const rows = countRequirementRows(requirementsStatus, req);
      if (rows.length === 0) {
        addIssue(issues, "REQUIREMENT_TRACEABILITY_MISSING", reqRel, `${req} has no v2.7 traceability row.`);
      } else if (rows.length > 1) {
        addIssue(issues, "REQUIREMENT_TRACEABILITY_DUPLICATE", reqRel, `${req} has ${rows.length} traceability rows; expected exactly one.`);
      }
      const row = rows[0];
      if (row && row.phase !== phase.number) {
        addIssue(issues, "REQUIREMENT_TRACEABILITY_WRONG_PHASE", reqRel, `${req} maps to Phase ${row.phase}; expected Phase ${phase.number}.`);
      }
      if (isRequirementComplete(requirementsStatus, req)) {
        if (!row || !/^complete$/i.test(row.status)) {
          addIssue(issues, "REQUIREMENT_TRACEABILITY_INCOMPLETE", reqRel, `${req} is checked but traceability row is not Complete.`);
        }
      } else if (row && !/^pending$/i.test(row.status)) {
        addIssue(issues, "REQUIREMENT_TRACEABILITY_STATUS_CONFLICT", reqRel, `${req} is unchecked but traceability row is '${row.status}', expected Pending.`);
      }
    }
  }
}

function checkVerificationAnchors(issues, root, requirementsStatus) {
  for (const phase of ACTIVE_V2_7_PHASES) {
    const completedReqs = phase.requirements.filter((req) => isRequirementComplete(requirementsStatus, req));
    if (completedReqs.length === 0) continue;
    const phaseDir = path.join(".planning", "phases", phase.dir);
    const verificationRel = path.join(phaseDir, `${phase.number}-VERIFICATION.md`);
    if (!requireFile(issues, root, verificationRel, "VERIFICATION_MISSING", `Missing Phase ${phase.number} verification artifact.`)) continue;
    const ownVerification = readText(path.join(root, verificationRel));
    for (const req of completedReqs) {
      if (!new RegExp(`\\b${req}\\b`).test(ownVerification)) {
        addIssue(issues, "REQUIREMENT_VERIFICATION_MISSING", verificationRel, `${req} is complete but is not cited in Phase ${phase.number} verification.`);
      }
      let anchors = 0;
      for (const otherPhase of ACTIVE_V2_7_PHASES) {
        const otherRel = path.join(".planning", "phases", otherPhase.dir, `${otherPhase.number}-VERIFICATION.md`);
        if (exists(path.join(root, otherRel)) && new RegExp(`\\b${req}\\b`).test(readText(path.join(root, otherRel)))) {
          anchors += 1;
        }
      }
      if (anchors !== 1) {
        addIssue(issues, "REQUIREMENT_VERIFICATION_ANCHOR_CONFLICT", verificationRel, `${req} appears in ${anchors} v2.7 verification artifact(s); expected exactly one.`);
      }
    }
  }
}

function checkLegacyUatClosure(issues, root) {
  const rel = path.join(".planning", "phases", "43-validation-debt-and-milestone-gate-closure", "43-LEGACY-UAT-CLOSURE.md");
  if (!requireFile(issues, root, rel, "LEGACY_UAT_CLOSURE_MISSING", "Missing legacy UAT closure artifact.")) return;
  const text = readText(path.join(root, rel));
  const requiredEvidence = [
    [".planning/phases/01-rt2-shell-and-product-truth/01-UAT.md", "reverified"],
    [".planning/phases/m1-6-daily-report/m1-6-UAT.md", "superseded"],
  ];
  for (const [file, classification] of requiredEvidence) {
    const matchingLine = text.split(/\r?\n/).find((line) => line.includes(file) && line.toLowerCase().includes(classification));
    if (!matchingLine) {
      addIssue(issues, "LEGACY_UAT_STATUS_CONFLICT", rel, `${file} is not classified as ${classification} in the canonical closure artifact.`);
    }
  }
  if (!/No plain `?unknown`? remains/i.test(text)) {
    addIssue(issues, "LEGACY_UAT_UNKNOWN_UNQUALIFIED", rel, "Legacy UAT closure artifact must explicitly state that no plain unknown status remains.");
  }
}

function checkPlanningArtifacts(root) {
  const issues = [];
  const requirementsStatus = parseRequirementsStatus(root);

  for (const phase of LEGACY_V2_6_PHASES) {
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

  for (const phase of ACTIVE_V2_7_PHASES) {
    if (!phaseHasCompletedRequirement(requirementsStatus, phase)) continue;
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
    checkValidationFrontmatter(issues, root, phase);
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

  checkLegacyUatClosure(issues, root);

  checkRequirements(issues, root);
  checkActiveRequirementTraceability(issues, root, requirementsStatus);
  checkVerificationAnchors(issues, root, requirementsStatus);

  return {
    passed: issues.length === 0,
    checkedPhases: LEGACY_V2_6_PHASES.map((phase) => phase.number),
    activeMilestonePhases: ACTIVE_V2_7_PHASES.map((phase) => phase.number),
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
  console.log(`Active milestone phases: ${result.activeMilestonePhases.join(", ")}`);
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

if (process.argv[1] && (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1].endsWith("rt2-milestone-artifact-gate.mjs"))) {
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
