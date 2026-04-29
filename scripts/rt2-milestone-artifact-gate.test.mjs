import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkPlanningArtifacts } from "./rt2-milestone-artifact-gate.mjs";

const phases = [
  ["39", "39-enterprise-connector-apply-loop", ["EXT-01", "EXT-02"]],
  ["40", "40-trusted-local-knowledge-bridge", ["EXT-03"]],
  ["41", "41-native-and-mobile-capture-hardening", ["CAP-01", "CAP-02", "CAP-03"]],
  ["42", "42-jarvis-autonomy-eval-guardrails", ["AUTO-01", "AUTO-02", "AUTO-03"]],
  ["43", "43-validation-debt-and-milestone-gate-closure", ["VAL-01", "VAL-02", "VAL-03"]],
];

const historical = [
  ["19", "19-validation-and-route-test-hardening"],
  ["20", "20-enterprise-rollout-connectors"],
  ["21", "21-obsidian-bidirectional-knowledge-sync"],
  ["22", "22-settlement-governance-and-anti-gaming"],
  ["23", "23-advanced-work-board-and-native-capture"],
  ["24", "24-phase19-verification-artifact-closure"],
];

const activePhases = [
  ["44", "44-release-host-verification-harness", ["REL-01", "REL-02", "REL-03"], true],
  ["45", "45-embedded-postgres-runtime-coverage", ["PG-01", "PG-02", "PG-03"], true],
  ["46", "46-artifact-and-uat-truth-alignment", ["ART-01", "ART-02", "ART-03"], true],
  ["47", "47-runtime-confidence-operations-surface", ["CONF-01", "CONF-02"], false],
];

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt2-gate-"));
  for (const [num, dir, reqs] of phases) {
    const phaseDir = path.join(root, ".planning", "phases", dir);
    write(
      path.join(phaseDir, `${num}-01-SUMMARY.md`),
      `---\nphase: ${num}\nstatus: complete\nrequirements_addressed:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n# Summary\n`,
    );
    write(path.join(phaseDir, `${num}-VERIFICATION.md`), `# Verification ${num}\n`);
    write(path.join(phaseDir, `${num}-VALIDATION.md`), `# Validation ${num}\n`);
  }
  for (const [num, dir] of historical) {
    write(path.join(root, ".planning", "phases", dir, `${num}-VALIDATION.md`), `# Historical Validation ${num}\n`);
  }
  for (const [num, dir, reqs, complete] of activePhases) {
    if (!complete) continue;
    const phaseDir = path.join(root, ".planning", "phases", dir);
    write(
      path.join(phaseDir, `${num}-01-SUMMARY.md`),
      `---\nphase: ${num}\nstatus: complete\nrequirements_addressed:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n# Summary\n`,
    );
    write(
      path.join(phaseDir, `${num}-VERIFICATION.md`),
      `---\nphase: ${num}\nstatus: passed\nrequirements_verified:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n# Verification ${num}\n\n${reqs.join("\n")}\n`,
    );
    write(
      path.join(phaseDir, `${num}-VALIDATION.md`),
      `---\nphase: ${num}\nstatus: passed\nvalidated_at: 2026-04-30\nrequirements_validated:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n# Validation ${num}\n`,
    );
  }
  write(
    path.join(root, ".planning", "phases", "43-validation-debt-and-milestone-gate-closure", "43-LEGACY-UAT-CLOSURE.md"),
    [
      "# Legacy UAT Closure",
      "",
      "| UAT File | Prior Status | Current Classification | Reason |",
      "|----------|--------------|------------------------|--------|",
      "| `.planning/phases/01-rt2-shell-and-product-truth/01-UAT.md` | unknown, 0 pending scenarios | reverified | checked |",
      "| `.planning/phases/m1-6-daily-report/m1-6-UAT.md` | unknown, 0 pending scenarios | superseded with scoped future items | later phases |",
      "",
      "No plain `unknown` remains.",
      "",
    ].join("\n"),
  );
  const legacyRequirements = phases.flatMap(([num, _dir, reqs]) =>
    reqs.map((req) => `- [x] **${req}**: done\n| ${req} | Phase ${num} | Complete |`),
  );
  const activeRequirements = activePhases.flatMap(([num, _dir, reqs, complete]) =>
    reqs.map((req) => `- [${complete ? "x" : " "}] **${req}**: ${complete ? "done" : "pending"}\n| ${req} | Phase ${num} | ${complete ? "Complete" : "Pending"} |`),
  );
  const requirements = [...legacyRequirements, ...activeRequirements].join("\n");
  write(path.join(root, ".planning", "REQUIREMENTS.md"), requirements);
  return root;
}

const passingRoot = buildFixture();
assert.equal(checkPlanningArtifacts(passingRoot).passed, true);

const failingRoot = buildFixture();
fs.rmSync(path.join(failingRoot, ".planning", "phases", "42-jarvis-autonomy-eval-guardrails", "42-VALIDATION.md"));
const failed = checkPlanningArtifacts(failingRoot);
assert.equal(failed.passed, false);
assert.ok(failed.issues.some((issue) => issue.code === "VALIDATION_MISSING" && issue.file.includes("42-VALIDATION.md")));

const staleValidationRoot = buildFixture();
write(
  path.join(staleValidationRoot, ".planning", "phases", "46-artifact-and-uat-truth-alignment", "46-VALIDATION.md"),
  "---\nphase: 46\nstatus: draft\nrequirements_validated:\n  - ART-01\n  - ART-02\n  - ART-03\n---\n\n# Validation\n",
);
const staleValidation = checkPlanningArtifacts(staleValidationRoot);
assert.equal(staleValidation.passed, false);
assert.ok(staleValidation.issues.some((issue) => issue.code === "VALIDATION_FRONTMATTER_STALE" && issue.file.includes("46-VALIDATION.md")));

const legacyConflictRoot = buildFixture();
write(
  path.join(legacyConflictRoot, ".planning", "phases", "43-validation-debt-and-milestone-gate-closure", "43-LEGACY-UAT-CLOSURE.md"),
  "# Legacy UAT Closure\n\nThe legacy UAT status is unknown.\n",
);
const legacyConflict = checkPlanningArtifacts(legacyConflictRoot);
assert.equal(legacyConflict.passed, false);
assert.ok(legacyConflict.issues.some((issue) => issue.code === "LEGACY_UAT_STATUS_CONFLICT" || issue.code === "LEGACY_UAT_UNKNOWN_UNQUALIFIED"));

const duplicateTraceRoot = buildFixture();
fs.appendFileSync(
  path.join(duplicateTraceRoot, ".planning", "REQUIREMENTS.md"),
  "\n| ART-01 | Phase 45 | Complete |\n",
  "utf8",
);
const duplicateTrace = checkPlanningArtifacts(duplicateTraceRoot);
assert.equal(duplicateTrace.passed, false);
assert.ok(duplicateTrace.issues.some((issue) => issue.code === "REQUIREMENT_TRACEABILITY_DUPLICATE"));

console.log("rt2-milestone-artifact-gate tests passed");
