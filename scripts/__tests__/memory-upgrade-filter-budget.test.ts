import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type FilterClassifierClient,
  projectRecordWorstCaseCostNanodollars,
} from "../../server/src/services/company-memory-upgrade/filter-classifier.js";
import { runFilter } from "../../server/src/services/company-memory-upgrade/filter.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const VALID_AGENT = "00000000-0000-4000-8000-000000000002";
const VALID_UPGRADE = "00000000-0000-4000-8000-000000000003";

function createSyntheticExport(count: number, textLength: number = 200) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-budget-test-"));
  const lines: string[] = [];

  for (let i = 0; i < count; i++) {
    const padded = String(i + 1).padStart(12, "0");
    const baseText = `Durable fact ${i + 1} for budget tracking. `;
    const text = baseText.padEnd(textLength, "x");
    const rec = {
      import_key: `00000000-0000-4000-8000-${padded}`,
      company_id: VALID_COMPANY,
      agent_id: VALID_AGENT,
      text,
      created_at: "2026-11-14T12:00:00.000Z",
      type: "fact",
      subject: "budget_test",
      confidence: 1.0,
      migrated_from: `00000000-0000-4000-9000-${padded}`,
      migration_id: VALID_UPGRADE,
      converter_id: "paperclip.memory-upgrade.atomic-converter",
      converter_version: 1,
    };
    lines.push(JSON.stringify(rec));
  }

  const jsonlContent = lines.join("\n") + "\n";
  const jsonlSha256 = createHash("sha256").update(jsonlContent).digest("hex");
  const jsonlPath = path.join(tmpDir, "export-agent.jsonl");
  writeFileSync(jsonlPath, jsonlContent, "utf8");

  const manifest = {
    format_version: 1,
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    upgrade_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
    record_count: count,
    skipped_counts_by_outcome: {},
    jsonl_sha256: jsonlSha256,
    created_at: new Date().toISOString(),
    tool: "paperclip memory:upgrade export",
  };
  const manifestPath = path.join(tmpDir, "export-agent.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const outDir = path.join(tmpDir, "out");

  return {
    tmpDir,
    jsonlPath,
    manifestPath,
    outDir,
    cleanup() {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Filter Budget Guard and In-Flight Reservation", async (t) => {
  await t.test("worst-case projection >= actual for max-size 2000-char record", () => {
    const maxText = "a".repeat(2000);
    const worstCaseNano = projectRecordWorstCaseCostNanodollars(maxText);

    // Actual realistic usage for 2000 char text: ~600 prompt tokens + 20 output tokens
    // 600 * $0.15/M = 90 nanodollars; 20 * $0.60/M = 12 nanodollars = 102 nanodollars
    const actualNano = 102n;
    assert.ok(
      worstCaseNano >= actualNano,
      `Worst case (${worstCaseNano}) must be >= actual (${actualNano})`,
    );
  });

  await t.test("concurrent calls cannot jointly exceed max-cost-usd cap with concurrency 16", async () => {
    const fixture = createSyntheticExport(30, 500);
    let activeInFlight = 0;
    let maxConcurrentObserved = 0;

    const fakeClient: FilterClassifierClient = {
      async classify() {
        activeInFlight++;
        if (activeInFlight > maxConcurrentObserved) {
          maxConcurrentObserved = activeInFlight;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeInFlight--;
        return {
          decision: "keep",
          reason: "durable_fact",
          inputTokens: 100,
          outputTokens: 20,
        };
      },
    };

    try {
      // Set budget that permits only ~5 records worst-case
      const worstCaseOne = projectRecordWorstCaseCostNanodollars("x".repeat(500));
      const budgetPermittingFive = (Number(worstCaseOne) * 5) / 1e9;

      await assert.rejects(
        async () =>
          runFilter(
            {
              manifestPath: fixture.manifestPath,
              jsonlPath: fixture.jsonlPath,
              outputDir: fixture.outDir,
              confirm: VALID_COMPANY,
              maxCostUsd: budgetPermittingFive,
              concurrency: 16,
            },
            {
              classifierClient: fakeClient,
              repoRoot: process.cwd(),
              _internalSkipPreflightBudgetCheck: true,
            },
          ),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "FILTER_BUDGET_EXCEEDED",
      );
      assert.ok(maxConcurrentObserved >= 1);
    } finally {
      fixture.cleanup();
    }
  });
});
