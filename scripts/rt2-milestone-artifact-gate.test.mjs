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
  write(
    path.join(root, ".planning", "phases", "43-validation-debt-and-milestone-gate-closure", "43-LEGACY-UAT-CLOSURE.md"),
    "# Legacy UAT Closure\n",
  );
  const requirements = phases
    .flatMap(([num, _dir, reqs]) => reqs.map((req) => `- [x] **${req}**: done\n| ${req} | Phase ${num} | Complete |`))
    .join("\n");
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

console.log("rt2-milestone-artifact-gate tests passed");
