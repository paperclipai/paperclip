import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BUILT_IN_CHECKS,
  evaluateCase,
  loadEvalPack,
  replayEvalPack,
} from "./workflow-eval-replay.mjs";

const scriptPath = fileURLToPath(new URL("./workflow-eval-replay.mjs", import.meta.url));
const packPath = fileURLToPath(new URL("../evals/workflow-packs/v0/pack.json", import.meta.url));

function writeTempPack(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-eval-pack-"));
  const fixture = {
    redaction: { sanitized: true },
    actions: [{ type: "issue_comment", localOnly: true, body: "synthetic fixture" }],
  };
  fs.writeFileSync(path.join(dir, "fixture.json"), JSON.stringify(fixture, null, 2));
  const pack = {
    id: "test.workflow-pack",
    version: "0.0.0",
    offlineOnly: true,
    sanitized: true,
    cases: [
      {
        id: "synthetic-case",
        title: "Synthetic case",
        fixture: "fixture.json",
        expected: { classification: "unknown", checks: ["redacted", "offline-only", "classification"] },
      },
    ],
    ...overrides,
  };
  const packFile = path.join(dir, "pack.json");
  fs.writeFileSync(packFile, JSON.stringify(pack, null, 2));
  return packFile;
}

describe("workflow eval replay v0", () => {
  test("loads the v0 eval pack with all required regression cases", () => {
    const pack = loadEvalPack(packPath);
    assert.equal(pack.id, "paperclip.workflow-regression.v0");
    assert.equal(pack.offlineOnly, true);
    assert.equal(pack.sanitized, true);

    const caseIds = new Set(pack.cases.map((item) => item.id));
    assert.deepEqual(
      [
        "useful-output-but-failed-adapter",
        "duplicate-recovery-child",
        "stale-blocker-graph",
        "missing-validation-evidence",
        "review-stage-hang",
      ].filter((id) => !caseIds.has(id)),
      [],
    );
  });

  test("fails closed when eval pack metadata is not marked offline and sanitized", () => {
    assert.throws(
      () => replayEvalPack(writeTempPack({ offlineOnly: false })),
      /offlineOnly must be true/,
    );
    assert.throws(
      () => replayEvalPack(writeTempPack({ sanitized: false })),
      /sanitized must be true/,
    );
  });

  test("passes every golden v0 fixture without network or vendor calls", () => {
    const result = replayEvalPack(packPath);
    assert.equal(result.summary.failed, 0, result.cases.map((item) => `${item.id}: ${item.failures.join("; ")}`).join("\n"));
    assert.equal(result.summary.passed, 5);
    assert.equal(result.summary.networkCalls, 0);
    assert.equal(result.summary.vendorCalls, 0);
  });

  test("fails closed when a fixture includes an external network action", () => {
    const result = evaluateCase({
      id: "network-leak",
      title: "network leak",
      fixture: {
        redaction: { sanitized: true },
        actions: [
          {
            type: "http_request",
            url: "https://api.vendor.example/v1/complete",
          },
        ],
      },
      expected: {
        classification: "offline_only_violation",
        checks: ["offline-only"],
      },
    });

    assert.equal(result.passed, false);
    assert.match(result.failures.join("\n"), /external network/i);
  });

  test("CLI ignores pnpm's standalone -- delimiter when selecting one case", () => {
    const output = execFileSync(
      process.execPath,
      [scriptPath, "--pack", packPath, "--", "--case", "review-stage-hang"],
      { encoding: "utf8" },
    );

    assert.match(output, /Summary: 1\/1 passed/);
    assert.match(output, /PASS review-stage-hang/);
  });

  test("built-in checks detect missing validation evidence", () => {
    const result = BUILT_IN_CHECKS["validation-evidence-required"]({
      issue: {
        status: "in_review",
        validationEvidence: [],
      },
    });

    assert.equal(result.passed, false);
    assert.match(result.message, /validation evidence/i);
  });
});
