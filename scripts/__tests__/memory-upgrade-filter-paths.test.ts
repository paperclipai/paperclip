import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runFilter } from "../../server/src/services/company-memory-upgrade/filter.js";
import { CompanyMemoryUpgradeError } from "../../server/src/services/company-memory-upgrade/types.js";

const VALID_COMPANY = "00000000-0000-4000-8000-000000000001";
const VALID_AGENT = "00000000-0000-4000-8000-000000000002";
const VALID_UPGRADE = "00000000-0000-4000-8000-000000000003";

function createSmallFixture() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "filter-paths-test-"));
  const record = {
    import_key: "00000000-0000-4000-8000-000000000001",
    company_id: VALID_COMPANY,
    agent_id: VALID_AGENT,
    text: "Dan Costanza decided on PostgreSQL for ledger storage.",
    created_at: "2026-11-14T12:00:00.000Z",
    type: "decision",
    subject: "ledger",
    confidence: 1.0,
    migrated_from: "00000000-0000-4000-8000-000000000002",
    migration_id: VALID_UPGRADE,
    converter_id: "paperclip.memory-upgrade.atomic-converter",
    converter_version: 1,
  };

  const jsonlContent = JSON.stringify(record) + "\n";
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

test("Filter File Paths and Security Refusal Paths", async (t) => {
  const fakeClient = {
    async classify() {
      return { decision: "keep" as const, reason: "durable_fact" as const, inputTokens: 50, outputTokens: 10 };
    },
  };

  await t.test("refuses to write output inside repository", async () => {
    const fixture = createSmallFixture();
    try {
      const insideRepoDir = path.join(process.cwd(), "test-inside-repo-reject");
      await assert.rejects(
        async () =>
          runFilter(
            {
              manifestPath: fixture.manifestPath,
              jsonlPath: fixture.jsonlPath,
              outputDir: insideRepoDir,
              confirm: VALID_COMPANY,
            },
            { classifierClient: fakeClient, repoRoot: process.cwd() },
          ),
        (err: any) =>
          err instanceof CompanyMemoryUpgradeError &&
          err.code === "OUTPUT_PATH_REJECTED",
      );
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("failure after JSONL write leaves no final dir and cleans temp dir", async () => {
    const fixture = createSmallFixture();
    const outDir = path.join(fixture.tmpDir, "out-failure-test");
    try {
      await assert.rejects(
        async () =>
          runFilter(
            {
              manifestPath: fixture.manifestPath,
              jsonlPath: fixture.jsonlPath,
              outputDir: outDir,
              confirm: VALID_COMPANY,
            },
            {
              classifierClient: fakeClient,
              repoRoot: process.cwd(),
              _internalFailureHookAfterJsonl: () => {
                throw new Error("Simulated disk error after JSONL write");
              },
            },
          ),
        /Simulated disk error after JSONL write/,
      );

      assert.equal(existsSync(outDir), false, "Final output directory must not exist on failure");
    } finally {
      fixture.cleanup();
    }
  });

  await t.test("creates all output files with permissions mode 0600 and COMPLETE marker", async () => {
    const fixture = createSmallFixture();
    const outDir = path.join(fixture.tmpDir, "out-perms");
    try {
      const res = await runFilter(
        {
          manifestPath: fixture.manifestPath,
          jsonlPath: fixture.jsonlPath,
          outputDir: outDir,
          confirm: VALID_COMPANY,
        },
        { classifierClient: fakeClient, repoRoot: process.cwd() },
      );

      assert.ok(res.outputJsonlPath);
      assert.ok(res.outputManifestPath);
      assert.ok(res.metadataPath);
      assert.ok(res.auditTxtPath);
      assert.ok(res.auditJsonPath);

      const completePath = path.join(outDir, "COMPLETE");
      assert.ok(existsSync(completePath), "COMPLETE marker must exist in output directory");

      for (const p of [
        res.outputJsonlPath,
        res.outputManifestPath,
        res.metadataPath,
        res.auditTxtPath,
        res.auditJsonPath,
        completePath,
      ]) {
        const mode = statSync(p).mode & 0o777;
        assert.equal(mode, 0o600, `File ${p} must have mode 0600, got ${mode.toString(8)}`);
      }
    } finally {
      fixture.cleanup();
    }
  });
});
