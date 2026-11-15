/**
 * Output directory validation and atomic file writing for quality filter (TECH-8572).
 *
 * ARCHITECTURAL INVARIANTS:
 * - Manifest in destination has EXACTLY the export manifest allowed keys (no unknown keys).
 * - Filter metadata is written to filter-metadata.json.
 * - All files written into exclusive temp directory next to destination (0700),
 *   ending with COMPLETE marker, then atomically renamed to destination.
 * - Stale temp directory is cleaned up on any failure; destination never partially created.
 * - Audit report strictly lists (import_key, decision, stage, reason) ONLY; never memory text.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPathInside } from "./census.js";
import type { ExportJsonlRecord } from "./export-contract.js";
import type { FilterAuditRecord, FilterMetadata } from "./filter-contract.js";
import type { ExportManifest } from "./filter-validation.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export function validateFilterOutputDirTarget(dirPath: string, repoRootPath?: string): {
  targetDir: string;
  parentDir: string;
} {
  const resolvedDir = path.resolve(process.cwd(), dirPath);
  const repoRoot = repoRootPath ?? path.resolve(fileURLToPath(new URL("../../../..", import.meta.url)));

  let realRepoRoot = repoRoot;
  try {
    realRepoRoot = realpathSync(repoRoot);
  } catch {
    // fallback
  }

  if (isPathInside(resolvedDir, repoRoot) || isPathInside(resolvedDir, realRepoRoot)) {
    throw new CompanyMemoryUpgradeError(
      "Refusing to write output inside repository. Memory reports contain sensitive identifiers. Use an external directory such as /tmp.",
      "OUTPUT_PATH_REJECTED",
    );
  }

  const parentDir = path.dirname(resolvedDir);
  if (!existsSync(parentDir)) {
    throw new CompanyMemoryUpgradeError(
      "Parent directory does not exist. The output parent directory must exist prior to execution.",
      "OUTPUT_PATH_REJECTED",
    );
  }

  let realParentDir = parentDir;
  try {
    realParentDir = realpathSync(parentDir);
  } catch {
    // fallback
  }

  if (isPathInside(realParentDir, repoRoot) || isPathInside(realParentDir, realRepoRoot)) {
    throw new CompanyMemoryUpgradeError(
      "Refusing to write output inside repository via parent directory. Use an external directory such as /tmp.",
      "OUTPUT_PATH_REJECTED",
    );
  }

  if (existsSync(resolvedDir)) {
    const err = new Error(`Output directory already exists: ${resolvedDir}`);
    (err as any).code = "EEXIST";
    throw err;
  }

  return { targetDir: resolvedDir, parentDir: realParentDir };
}

export function serializeExportRecordSameKeyOrder(r: ExportJsonlRecord): string {
  return JSON.stringify({
    import_key: r.import_key,
    company_id: r.company_id,
    agent_id: r.agent_id,
    text: r.text,
    created_at: r.created_at,
    type: r.type,
    subject: r.subject,
    confidence: r.confidence,
    migrated_from: r.migrated_from,
    migration_id: r.migration_id,
    converter_id: r.converter_id,
    converter_version: r.converter_version,
  });
}

export async function writeFilterOutputFiles(params: {
  outputDir: string;
  repoRoot?: string;
  inputJsonlPath: string;
  inputManifestPath: string;
  originalManifest: ExportManifest;
  keptRecords: ExportJsonlRecord[];
  auditRecords: FilterAuditRecord[];
  filterMetadata: FilterMetadata;
  _internalFailureHookAfterJsonl?: () => void;
}): Promise<{
  outputJsonlPath: string;
  outputManifestPath: string;
  outputJsonlSha256: string;
  auditTxtPath: string;
  auditJsonPath: string;
  metadataPath: string;
}> {
  const { targetDir, parentDir } = validateFilterOutputDirTarget(params.outputDir, params.repoRoot);
  const jsonlBase = path.basename(params.inputJsonlPath);
  const manifestBase = path.basename(params.inputManifestPath);

  const nonce = randomBytes(6).toString("hex");
  const tempDir = path.join(parentDir, `.${path.basename(targetDir)}-${nonce}.tmp`);
  mkdirSync(tempDir, { mode: 0o700 });

  try {
    // 1. Write JSONL in temp directory
    const jsonlLines =
      params.keptRecords.map(serializeExportRecordSameKeyOrder).join("\n") +
      (params.keptRecords.length > 0 ? "\n" : "");
    const jsonlSha256 = createHash("sha256").update(jsonlLines).digest("hex");
    const jsonlTempPath = path.join(tempDir, jsonlBase);

    await writeFile(jsonlTempPath, jsonlLines, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    if (params._internalFailureHookAfterJsonl) {
      params._internalFailureHookAfterJsonl();
    }

    // 2. Write Manifest with EXACTLY the export manifest allowed keys
    const totalDropped =
      params.filterMetadata.dropped_deterministic +
      params.filterMetadata.dropped_classified;

    const manifestOutput = {
      format_version: params.originalManifest.format_version,
      company_id: params.originalManifest.company_id,
      agent_id: params.originalManifest.agent_id,
      upgrade_id: params.originalManifest.upgrade_id,
      converter_id: params.originalManifest.converter_id,
      converter_version: params.originalManifest.converter_version,
      record_count: params.keptRecords.length,
      skipped_counts_by_outcome: {
        ...params.originalManifest.skipped_counts_by_outcome,
        dropped_low_value: totalDropped,
      },
      jsonl_sha256: jsonlSha256,
      created_at: params.originalManifest.created_at,
      tool: params.originalManifest.tool,
    };
    const manifestTempPath = path.join(tempDir, manifestBase);

    await writeFile(manifestTempPath, JSON.stringify(manifestOutput, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    // 3. Write filter-metadata.json
    const metadataTempPath = path.join(tempDir, "filter-metadata.json");
    await writeFile(metadataTempPath, JSON.stringify(params.filterMetadata, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    // 4. Write filter-audit.json
    const auditJsonData = params.auditRecords.map((a) => ({
      import_key: a.import_key,
      decision: a.decision,
      stage: a.stage,
      reason: a.reason,
    }));
    const auditJsonTempPath = path.join(tempDir, "filter-audit.json");
    await writeFile(auditJsonTempPath, JSON.stringify(auditJsonData, null, 2) + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    // 5. Write filter-audit.txt
    const auditTxtLines = [
      "# Filter Decision Audit Report",
      `# Tool: paperclip memory:upgrade filter`,
      `# Generated: ${params.filterMetadata.generated_at}`,
      `# Total: ${params.filterMetadata.input_record_count} | Kept: ${params.filterMetadata.kept} | Dropped: ${totalDropped}`,
      "import_key                            decision  stage          reason",
      "------------------------------------  --------  -------------  ------------------------------",
    ];
    for (const a of params.auditRecords) {
      const keyCol = a.import_key.padEnd(36, " ");
      const decCol = a.decision.padEnd(8, " ");
      const stgCol = a.stage.padEnd(13, " ");
      auditTxtLines.push(`${keyCol}  ${decCol}  ${stgCol}  ${a.reason}`);
    }
    const auditTxtTempPath = path.join(tempDir, "filter-audit.txt");
    await writeFile(auditTxtTempPath, auditTxtLines.join("\n") + "\n", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    // 6. Write COMPLETE marker file last
    const completeMarkerTempPath = path.join(tempDir, "COMPLETE");
    await writeFile(completeMarkerTempPath, `COMPLETE\ngenerated_at=${params.filterMetadata.generated_at}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });

    // Atomic rename of whole directory
    await rename(tempDir, targetDir);

    return {
      outputJsonlPath: path.join(targetDir, jsonlBase),
      outputManifestPath: path.join(targetDir, manifestBase),
      outputJsonlSha256: jsonlSha256,
      auditTxtPath: path.join(targetDir, "filter-audit.txt"),
      auditJsonPath: path.join(targetDir, "filter-audit.json"),
      metadataPath: path.join(targetDir, "filter-metadata.json"),
    };
  } catch (err) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}
