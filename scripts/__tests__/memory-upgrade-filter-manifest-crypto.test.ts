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
  manifestJsonlSha?: string;
  manifestRecordCount?: number;
  formatVersion?: number;
} = {}) {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-manifest-crypto-"));
  const record = {
    import_key: "00000000-0000-4000-8000-000000000010",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "Dan Costanza decided to use PostgreSQL for the upgrade ledger.",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "decision",
    subject: "ledger",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-8000-000000000020",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const jsonlContent = JSON.stringify(record) + "\n";
  const jsonlSha256 = createHash("sha256").update(jsonlContent).digest("hex");
  const jsonlPath = path.join(tmpDir, "export-agent.jsonl");
  writeFileSync(jsonlPath, jsonlContent, "utf8");

  const manifest: ExportManifest = {
    format_version: overrides.formatVersion ?? 1,
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    upgrade_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
    record_count: overrides.manifestRecordCount ?? 1,
    skipped_counts_by_outcome: {},
    jsonl_sha256: overrides.manifestJsonlSha ?? jsonlSha256,
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

test("Filter Input Manifest Cryptographic & Count Verification", async (t) => {
  await t.test("valid manifest and jsonl pass strict validation", () => {
    const fixture = createFixture();
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      const { records, sha256 } = readAndValidateInputJsonl(fixture.jsonlPath, manifest);
      assert.equal(records.length, 1);
      assert.equal(sha256, manifest.jsonl_sha256);
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("refuses when JSONL SHA-256 does not match manifest", () => {
    const fixture = createFixture({
      manifestJsonlSha: "0000000000000000000000000000000000000000000000000000000000000000",
    });
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      assert.throws(
        () => readAndValidateInputJsonl(fixture.jsonlPath, manifest),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "MANIFEST_HASH_MISMATCH",
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("refuses when record count does not match manifest", () => {
    const fixture = createFixture({ manifestRecordCount: 99 });
    try {
      const manifest = readAndValidateInputManifest(fixture.manifestPath);
      assert.throws(
        () => readAndValidateInputJsonl(fixture.jsonlPath, manifest),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "MANIFEST_RECORD_COUNT_MISMATCH",
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("refuses when manifest format_version is unsupported", () => {
    const fixture = createFixture({ formatVersion: 2 });
    try {
      assert.throws(
        () => readAndValidateInputManifest(fixture.manifestPath),
        (err: any) => err instanceof CompanyMemoryUpgradeError && err.code === "INVALID_ARGUMENT",
      );
    } finally {
      fixture.cleanup();
    }
  });
});
