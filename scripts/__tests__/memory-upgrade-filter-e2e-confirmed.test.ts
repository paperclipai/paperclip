import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EXPORT_MANIFEST_ALLOWED_KEYS } from "../../server/src/services/company-memory-upgrade/export-contract.js";
import { runFilter } from "../../server/src/services/company-memory-upgrade/filter.js";
import { FILTER_ID, FILTER_VERSION } from "../../server/src/services/company-memory-upgrade/filter-contract.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const VALID_AGENT = "00000000-0000-4000-8000-000000000002";
const VALID_UPGRADE = "00000000-0000-4000-8000-000000000003";

const GOLDEN_MANIFEST_KEYS = [
  "format_version", "company_id", "agent_id", "upgrade_id",
  "converter_id", "converter_version", "record_count",
  "skipped_counts_by_outcome", "jsonl_sha256", "created_at", "tool",
];

function createMultiRecordFixture(dir: string, count: number = 8) {
  const records = [];
  for (let i = 0; i < count; i++) {
    const padded = String(i + 1).padStart(12, "0");
    records.push({
      import_key: `00000000-0000-4000-8000-${padded}`,
      company_id: VALID_COMPANY,
      agent_id: VALID_AGENT,
      text: i % 2 === 0
        ? `Dan Costanza decision ${i + 1}: keep postgres for ledger.`
        : `Run ID: 550e8400-e29b-41d4-a716-${padded}`,
      created_at: "2026-11-14T12:00:00.000Z",
      type: "decision",
      subject: "upgrade_ledger",
      confidence: 1.0,
      migrated_from: `00000000-0000-4000-9000-${padded}`,
      migration_id: VALID_UPGRADE,
      converter_id: "paperclip.memory-upgrade.atomic-converter",
      converter_version: 1,
    });
  }

  const jsonlContent = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const jsonlSha256 = createHash("sha256").update(jsonlContent).digest("hex");
  const jsonlPath = path.join(dir, `export-${VALID_AGENT}.jsonl`);
  writeFileSync(jsonlPath, jsonlContent, "utf8");

  const originalManifest = {
    format_version: 1,
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    upgrade_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
    record_count: count,
    skipped_counts_by_outcome: { dropped_noise: 5 },
    jsonl_sha256: jsonlSha256,
    created_at: "2026-11-14T11:00:00.000Z",
    tool: "paperclip memory:upgrade export",
  };
  const manifestPath = path.join(dir, `export-${VALID_AGENT}.manifest.json`);
  writeFileSync(manifestPath, JSON.stringify(originalManifest, null, 2), "utf8");

  return { jsonlPath, manifestPath };
}

test("Filter End-to-End Confirmed Execution & Importer Contract", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-e2e-confirmed-"));
  const { jsonlPath, manifestPath } = createMultiRecordFixture(tmpDir, 6);
  const outDir = path.join(tmpDir, "filtered-output");

  const fakeClientWithLatency = {
    async classify(text: string) {
      const delay = Math.floor(Math.random() * 20);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { decision: "keep" as const, reason: "decision" as const, inputTokens: 60, outputTokens: 12 };
    },
  };

  try {
    const report = await runFilter(
      {
        manifestPath,
        jsonlPath,
        outputDir: outDir,
        confirm: VALID_COMPANY,
        concurrency: 4,
      },
      { classifierClient: fakeClientWithLatency, repoRoot: process.cwd() },
    );

    assert.equal(report.isDryRun, false);
    assert.ok(report.outputJsonlPath);
    assert.ok(report.outputManifestPath);

    // Cross-repo compatibility: manifest has EXACTLY the export manifest allowed keys
    const manifestContent = JSON.parse(readFileSync(report.outputManifestPath!, "utf8"));
    const actualKeys = Object.keys(manifestContent).sort();
    assert.deepEqual(actualKeys, [...GOLDEN_MANIFEST_KEYS].sort());
    assert.deepEqual(actualKeys, [...EXPORT_MANIFEST_ALLOWED_KEYS].sort());

    // Filter metadata moved to filter-metadata.json
    assert.ok(report.metadataPath);
    assert.ok(existsSync(report.metadataPath!));
    const metadataContent = JSON.parse(readFileSync(report.metadataPath!, "utf8"));
    assert.equal(metadataContent.filter_id, FILTER_ID);
    assert.equal(metadataContent.filter_version, FILTER_VERSION);

    // COMPLETE marker exists
    const completePath = path.join(outDir, "COMPLETE");
    assert.ok(existsSync(completePath));

    // Concurrency determinism: concurrency 8 vs concurrency 1 on randomized latencies
    const outDirC1 = path.join(tmpDir, "out-c1");
    const outDirC8 = path.join(tmpDir, "out-c8");
    const fixedNow = new Date("2026-11-14T12:00:00.000Z");

    const reportC1 = await runFilter(
      {
        manifestPath,
        jsonlPath,
        outputDir: outDirC1,
        confirm: VALID_COMPANY,
        concurrency: 1,
      },
      { classifierClient: fakeClientWithLatency, repoRoot: process.cwd(), now: fixedNow },
    );

    const reportC8 = await runFilter(
      {
        manifestPath,
        jsonlPath,
        outputDir: outDirC8,
        confirm: VALID_COMPANY,
        concurrency: 8,
      },
      { classifierClient: fakeClientWithLatency, repoRoot: process.cwd(), now: fixedNow },
    );

    const jsonlC1 = readFileSync(reportC1.outputJsonlPath!, "utf8");
    const jsonlC8 = readFileSync(reportC8.outputJsonlPath!, "utf8");
    assert.equal(jsonlC1, jsonlC8, "Concurrency 8 must produce byte-identical JSONL to concurrency 1");

    const auditC1 = readFileSync(reportC1.auditTxtPath!, "utf8");
    const auditC8 = readFileSync(reportC8.auditTxtPath!, "utf8");
    assert.equal(auditC1, auditC8, "Concurrency 8 must produce byte-identical audit TXT to concurrency 1");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
