import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runFilter } from "../../server/src/services/company-memory-upgrade/filter.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const VALID_AGENT = "00000000-0000-4000-8000-000000000002";
const VALID_UPGRADE = "00000000-0000-4000-8000-000000000003";

test("Filter Keep Override with --keep-import-keys", async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-override-test-"));

  // Record 1: matches deterministic rule "rule_made_no_changes"
  const rec1 = {
    import_key: "00000000-0000-4000-8000-000000000001",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "Made no changes.",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "fact",
    subject: "status",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-9000-000000000001",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  // Record 2: substantive fact
  const rec2 = {
    import_key: "00000000-0000-4000-8000-000000000002",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "Dan decided: keep primary keys indexed.",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "decision",
    subject: "architecture",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-9000-000000000002",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  // Record 3: normal drop
  const rec3 = {
    import_key: "00000000-0000-4000-8000-000000000003",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "Wake reason: periodic heartbeat",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "fact",
    subject: "wake",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-9000-000000000003",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const jsonlContent = [rec1, rec2, rec3].map((r) => JSON.stringify(r)).join("\n") + "\n";
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
    record_count: 3,
    skipped_counts_by_outcome: {},
    jsonl_sha256: jsonlSha256,
    created_at: new Date().toISOString(),
    tool: "paperclip memory:upgrade export",
  };
  const manifestPath = path.join(tmpDir, "export-agent.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const keepKeysPath = path.join(tmpDir, "keep-keys.txt");
  writeFileSync(keepKeysPath, `${rec1.import_key}\n`, "utf8");

  const outDir = path.join(tmpDir, "out");

  const fakeClient = {
    async classify() {
      return { decision: "keep" as const, reason: "decision" as const, inputTokens: 50, outputTokens: 10 };
    },
  };

  try {
    const report = await runFilter(
      {
        manifestPath,
        jsonlPath,
        outputDir: outDir,
        confirm: VALID_COMPANY,
        keepImportKeysPath: keepKeysPath,
      },
      { classifierClient: fakeClient, repoRoot: process.cwd() },
    );

    assert.equal(report.keptCount, 2);
    assert.equal(report.droppedDeterministicCount, 1);

    const outputJsonl = readFileSync(report.outputJsonlPath!, "utf8");
    const lines = outputJsonl.split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 2);
    const parsedKeys = lines.map((l) => JSON.parse(l).import_key);
    assert.deepEqual(parsedKeys, [rec1.import_key, rec2.import_key]);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
