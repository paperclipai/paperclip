import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport,
  buildRuntimeConfidence,
  writeRuntimeConfidence,
} from "./rt2-runtime-confidence.mjs";

const phases = [
  ["44", "44-release-host-verification-harness", ["REL-01", "REL-02", "REL-03"], true],
  ["45", "45-embedded-postgres-runtime-coverage", ["PG-01", "PG-02", "PG-03"], true],
  ["46", "46-artifact-and-uat-truth-alignment", ["ART-01", "ART-02", "ART-03"], true],
  ["47", "47-runtime-confidence-operations-surface", ["CONF-01", "CONF-02"], false],
];

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function buildRoot({ phase47Complete = false, releaseStatus = "accepted_debt" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt2-runtime-confidence-"));
  const active = phases.map(([num, dir, reqs, complete]) => [num, dir, reqs, num === "47" ? phase47Complete : complete]);
  const requirements = active.flatMap(([num, _dir, reqs, complete]) =>
    reqs.map((req) => `- [${complete ? "x" : " "}] **${req}**: ${complete ? "done" : "pending"}\n| ${req} | Phase ${num} | ${complete ? "Complete" : "Pending"} |`),
  );
  write(path.join(root, ".planning", "REQUIREMENTS.md"), requirements.join("\n"));
  for (const [num, dir, reqs, complete] of active) {
    const phaseDir = path.join(root, ".planning", "phases", dir);
    if (!complete) continue;
    write(
      path.join(phaseDir, `${num}-01-SUMMARY.md`),
      `---\nphase: ${num}\nstatus: complete\nrequirements_addressed:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n# Summary\n`,
    );
    write(
      path.join(phaseDir, `${num}-VERIFICATION.md`),
      `---\nphase: ${num}\nstatus: passed\nrequirements_verified:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n${reqs.join("\n")}\n`,
    );
    write(
      path.join(phaseDir, `${num}-VALIDATION.md`),
      `---\nphase: ${num}\nstatus: passed\nvalidated_at: 2026-04-30\nrequirements_validated:\n${reqs.map((req) => `  - ${req}`).join("\n")}\n---\n\n# Validation\n`,
    );
  }
  const summaryPath = path.join(root, ".planning", "release-host-runs", "2026-04-30T00-00-00-000Z", "summary.json");
  const attempts = releaseStatus === "passed"
    ? [{ attemptNumber: 1, sliceId: "typecheck", suite: "typecheck", status: "passed", owner: "workspace", durationMs: 10 }]
    : releaseStatus === "failed"
      ? [{ attemptNumber: 1, sliceId: "typecheck", suite: "typecheck", status: "failed", owner: "workspace", durationMs: 10, retryRecommendation: "inspect logs" }]
      : [
          { attemptNumber: 1, sliceId: "typecheck", suite: "typecheck", status: "passed", owner: "workspace", durationMs: 10 },
          {
            attemptNumber: 2,
            sliceId: "embedded-postgres-windows-default-skip",
            suite: "embedded-postgres",
            status: "accepted_debt",
            owner: "db",
            durationMs: 0,
            retryRecommendation: "pnpm run rt2:embedded-postgres-host-ready",
            debt: {
              reasonCode: "windows_default_disabled",
              reason: "embedded Postgres tests are disabled by default on Windows",
            },
          },
        ];
  write(
    summaryPath,
    JSON.stringify({
      status: releaseStatus,
      runDir: ".planning/release-host-runs/2026-04-30T00-00-00-000Z",
      updatedAt: "2026-04-30T00:00:00.000Z",
      attempts,
    }, null, 2),
  );
  return { root, summaryPath };
}

const gatePass = { passed: true, issues: [] };
const gateFail = {
  passed: false,
  issues: [{ code: "VALIDATION_FRONTMATTER_STALE", file: ".planning/phases/46/46-VALIDATION.md", message: "stale" }],
};

const acceptedDebtRoot = buildRoot();
const acceptedDebt = buildRuntimeConfidence({
  root: acceptedDebtRoot.root,
  releaseHostSummaryPath: acceptedDebtRoot.summaryPath,
  gateResult: gatePass,
  now: new Date("2026-04-30T00:00:00.000Z"),
});
assert.equal(acceptedDebt.status, "accepted_debt");
assert.equal(acceptedDebt.counts.acceptedDebt, 1);
assert.equal(acceptedDebt.counts.pending, 2);
assert.match(buildReport(acceptedDebt), /Accepted Debt/);
assert.match(buildReport(acceptedDebt), /CONF-01/);

const passedRoot = buildRoot({ phase47Complete: true, releaseStatus: "passed" });
const passed = buildRuntimeConfidence({
  root: passedRoot.root,
  releaseHostSummaryPath: passedRoot.summaryPath,
  gateResult: gatePass,
});
assert.equal(passed.status, "passed");
assert.equal(passed.requirements.filter((row) => row.status === "passed").length, 11);

const missingRelease = buildRuntimeConfidence({
  root: fs.mkdtempSync(path.join(os.tmpdir(), "rt2-runtime-confidence-missing-")),
  gateResult: gatePass,
});
assert.equal(missingRelease.status, "blocker");
assert.ok(missingRelease.blockers.some((item) => item.code === "RELEASE_HOST_SUMMARY_MISSING"));

const blockerRoot = buildRoot({ releaseStatus: "failed" });
const blocker = buildRuntimeConfidence({
  root: blockerRoot.root,
  releaseHostSummaryPath: blockerRoot.summaryPath,
  gateResult: gateFail,
});
assert.equal(blocker.status, "blocker");
assert.ok(blocker.blockers.some((item) => item.code === "VALIDATION_FRONTMATTER_STALE"));
assert.ok(blocker.blockers.some((item) => item.code === "RELEASE_HOST_FAILED"));

const written = writeRuntimeConfidence(acceptedDebt, {
  root: acceptedDebtRoot.root,
  outputDir: path.join(acceptedDebtRoot.root, "out"),
});
assert.ok(fs.existsSync(path.join(acceptedDebtRoot.root, "out", "summary.json")));
assert.ok(fs.existsSync(path.join(acceptedDebtRoot.root, "out", "report.md")));
assert.equal(written.runDir, "out");

console.log("rt2-runtime-confidence tests passed");
