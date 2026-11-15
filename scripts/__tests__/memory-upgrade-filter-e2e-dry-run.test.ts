import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runFilter } from "../../server/src/services/company-memory-upgrade/filter.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const VALID_AGENT = "00000000-0000-4000-8000-000000000002";
const VALID_UPGRADE = "00000000-0000-4000-8000-000000000003";

test("Memory Upgrade Quality Filter End-to-End Dry Run", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-e2e-dryrun-"));

  const rec1 = {
    import_key: "00000000-0000-4000-8000-000000000001",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "550e8400-e29b-41d4-a716-446655440000",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "fact",
    subject: "uuid",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-9000-000000000001",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const rec2 = {
    import_key: "00000000-0000-4000-8000-000000000002",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "The billing service processes credit card settlements daily at 02:00 UTC.",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "fact",
    subject: "billing",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-9000-000000000002",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const records = [rec1, rec2];
  const jsonlContent = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const jsonlSha256 = createHash("sha256").update(jsonlContent).digest("hex");
  const jsonlPath = path.join(tmpDir, `export-${VALID_AGENT}.jsonl`);
  writeFileSync(jsonlPath, jsonlContent, "utf8");

  const originalManifest = {
    format_version: 1,
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    upgrade_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
    record_count: 2,
    skipped_counts_by_outcome: {},
    jsonl_sha256: jsonlSha256,
    created_at: "2026-11-14T11:00:00.000Z",
    tool: "paperclip memory:upgrade export",
  };
  const manifestPath = path.join(tmpDir, `export-${VALID_AGENT}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(originalManifest, null, 2), "utf8");

  const outDir = path.join(tmpDir, "filtered-output");

  try {
    // Dry run without key runs deterministic prefilter only
    const dryRunNoKeyReport = await runFilter(
      {
        manifestPath,
        jsonlPath,
        outputDir: outDir,
        isDryRun: true,
      },
      { repoRoot: process.cwd() },
    );

    assert.equal(dryRunNoKeyReport.isDryRun, true);
    assert.equal(dryRunNoKeyReport.outputJsonlPath, null);
    assert.equal(dryRunNoKeyReport.outputManifestPath, null);
    assert.equal(dryRunNoKeyReport.droppedDeterministicCount, 1);
    assert.equal(dryRunNoKeyReport.droppedClassifiedCount, 0);
    assert.equal(dryRunNoKeyReport.ruleCounts.rule_run_identifier_or_uuid, 1);

    // Dry run with fake client classifies remaining
    const fakeClient = {
      async classify() {
        return { decision: "keep" as const, reason: "durable_fact" as const, inputTokens: 50, outputTokens: 10 };
      },
    };

    const dryRunWithKeyReport = await runFilter(
      {
        manifestPath,
        jsonlPath,
        outputDir: outDir,
        isDryRun: true,
      },
      { classifierClient: fakeClient, repoRoot: process.cwd() },
    );

    assert.equal(dryRunWithKeyReport.isDryRun, true);
    assert.equal(dryRunWithKeyReport.outputJsonlPath, null);
    assert.equal(dryRunWithKeyReport.keptCount, 1);
    assert.equal(dryRunWithKeyReport.droppedDeterministicCount, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
