import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  type ExportManifest,
  readAndValidateInputJsonl,
  readAndValidateInputManifest,
} from "../../server/src/services/company-memory-upgrade/filter-paths.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const VALID_AGENT = "00000000-0000-4000-8000-000000000002";
const VALID_UPGRADE = "00000000-0000-4000-8000-000000000003";

function createFixture(overrides: {
  recordCompanyId?: string;
  recordAgentId?: string;
  recordMigrationId?: string;
  recordConverterId?: string;
} = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-manifest-records-"));
  const record = {
    import_key: "00000000-0000-4000-8000-000000000010",
    company_id: overrides.recordCompanyId ?? VALID_COMPANY,
    agent_id: overrides.recordAgentId ?? VALID_AGENT,
    text: "Dan Costanza decided to use PostgreSQL for the upgrade ledger.",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "decision",
    subject: "ledger",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-8000-000000000020",
    migration_id: overrides.recordMigrationId ?? VALID_UPGRADE,
    converter_id: overrides.recordConverterId ?? "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const jsonlContent = JSON.stringify(record) + "\n";
  const jsonlSha256 = createHash("sha256").update(jsonlContent).digest("hex");
  const jsonlPath = path.join(tmpDir, "export-agent.jsonl");
  writeFileSync(jsonlPath, jsonlContent, "utf8");

  const manifest: ExportManifest = {
    format_version: 1,
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    upgrade_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
    record_count: 1,
    skipped_counts_by_outcome: {},
    jsonl_sha256: jsonlSha256,
    created_at: new Date().toISOString(),
    tool: "paperclip memory:upgrade export",
  };
  const manifestPath = path.join(tmpDir, "export-agent.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    tmpDir,
    jsonlPath,
    manifestPath,
    cleanup() {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

test("Filter Input Manifest Per-Record Metadata Verification", async (t) => {
  await t.test("refuses when record company_id mismatches manifest", () => {
    const fixture = createFixture({ recordCompanyId: "11111111-1111-4111-8111-111111111111" });
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      assert.throws(
        () => readAndValidateInputJsonl(fixture.jsonlPath, manifest),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "RECORD_MANIFEST_MISMATCH",
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("refuses when record agent_id mismatches manifest", () => {
    const fixture = createFixture({ recordAgentId: "22222222-2222-4222-8222-222222222222" });
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      assert.throws(
        () => readAndValidateInputJsonl(fixture.jsonlPath, manifest),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "RECORD_MANIFEST_MISMATCH",
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("refuses when record migration_id mismatches manifest upgrade_id", () => {
    const fixture = createFixture({ recordMigrationId: "33333333-3333-4333-8333-333333333333" });
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      assert.throws(
        () => readAndValidateInputJsonl(fixture.jsonlPath, manifest),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "RECORD_MANIFEST_MISMATCH",
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("refuses when record converter_id mismatches manifest", () => {
    const fixture = createFixture({ recordConverterId: "other-converter" });
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      assert.throws(
        () => readAndValidateInputJsonl(fixture.jsonlPath, manifest),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "RECORD_MANIFEST_MISMATCH",
      );
    } finally {
      fixture.cleanup();
    }
  });
});
