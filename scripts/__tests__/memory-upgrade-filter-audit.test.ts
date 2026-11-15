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

test("Filter Audit Report Privacy and Content Invariants", async (t) => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-audit-test-"));

  const secretText1 = "CONFIDENTIAL_ORGANIZATIONAL_SECRET_ALPHA";
  const secretText2 = "VERY_SECRET_RUN_TRIGGER_DATA_BETA";

  const rec1 = {
    import_key: "00000000-0000-4000-8000-000000000001",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: `Decision: ${secretText1}`,
    created_at: "2026-11-14T12:00:00.000Z",
    type: "decision",
    subject: "architecture",
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
    text: `Wake reason: ${secretText2}`,
    created_at: "2026-11-14T12:00:00.000Z",
    type: "fact",
    subject: "wake",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-9000-000000000002",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const jsonlContent = [rec1, rec2].map((r) => JSON.stringify(r)).join("\n") + "\n";
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
    record_count: 2,
    skipped_counts_by_outcome: {},
    jsonl_sha256: jsonlSha256,
    created_at: new Date().toISOString(),
    tool: "paperclip memory:upgrade export",
  };
  const manifestPath = path.join(tmpDir, "export-agent.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

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
      },
      { classifierClient: fakeClient, repoRoot: process.cwd() },
    );

    await t.test("audit report TXT contains NO memory text and strictly lists decisions", () => {
      const auditTxt = readFileSync(report.auditTxtPath!, "utf8");

      assert.ok(!auditTxt.includes(secretText1));
      assert.ok(!auditTxt.includes(secretText2));
      assert.ok(!auditTxt.includes("Decision:"));
      assert.ok(!auditTxt.includes("Wake reason:"));

      assert.ok(auditTxt.includes(rec1.import_key));
      assert.ok(auditTxt.includes("classifier"));
      assert.ok(auditTxt.includes("decision"));

      assert.ok(auditTxt.includes(rec2.import_key));
      assert.ok(auditTxt.includes("deterministic"));
      assert.ok(auditTxt.includes("rule_wake_trigger_reason"));
    });

    await t.test("audit report JSON contains NO memory text and matches schema", () => {
      const auditJsonRaw = readFileSync(report.auditJsonPath!, "utf8");

      assert.ok(!auditJsonRaw.includes(secretText1));
      assert.ok(!auditJsonRaw.includes(secretText2));
      assert.ok(!auditJsonRaw.includes("text"));

      const auditJson = JSON.parse(auditJsonRaw);
      assert.equal(auditJson.length, 2);
      for (const item of auditJson) {
        const keys = Object.keys(item).sort();
        assert.deepEqual(keys, ["decision", "import_key", "reason", "stage"]);
      }
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
