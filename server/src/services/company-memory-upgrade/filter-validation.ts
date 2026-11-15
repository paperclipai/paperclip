/**
 * Input manifest, JSONL, and keep-keys validation for quality filter (TECH-8572).
 *
 * ARCHITECTURAL INVARIANTS:
 * - Pure/isolated file reading and cryptographic verification.
 * - Strict JSONL SHA-256 match against manifest.
 * - Strict record count and per-record metadata match against manifest.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isValidUuid } from "./census.js";
import {
  EXPORT_MAX_METADATA_CHARS,
  EXPORT_MAX_TEXT_CHARS,
  type ExportJsonlRecord,
  parseAndNormalizeUtcIsoTimestamp,
} from "./export-contract.js";
import type { FilterMetadata } from "./filter-contract.js";
import { CompanyMemoryUpgradeError } from "./types.js";

export interface ExportManifest {
  format_version: number;
  company_id: string;
  agent_id: string;
  upgrade_id: string;
  converter_id: string;
  converter_version: number;
  record_count: number;
  skipped_counts_by_outcome: Record<string, number>;
  jsonl_sha256: string;
  created_at: string;
  tool: string;
  filter?: FilterMetadata;
}

export function readAndValidateInputManifest(manifestPath: string): ExportManifest {
  const resolved = path.resolve(process.cwd(), manifestPath);
  if (!existsSync(resolved)) {
    throw new CompanyMemoryUpgradeError(
      `Manifest file does not exist at path: ${manifestPath}`,
      "INVALID_ARGUMENT",
    );
  }

  let content: string;
  try {
    content = readFileSync(resolved, "utf8");
  } catch {
    throw new CompanyMemoryUpgradeError(
      `Manifest file could not be read: ${manifestPath}`,
      "INVALID_ARGUMENT",
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CompanyMemoryUpgradeError(
      "Manifest file is not valid JSON.",
      "INVALID_ARGUMENT",
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CompanyMemoryUpgradeError(
      "Manifest must be a JSON object.",
      "INVALID_ARGUMENT",
    );
  }

  if (parsed.format_version !== 1) {
    throw new CompanyMemoryUpgradeError(
      `Unsupported manifest format_version: ${parsed.format_version}. Expected 1.`,
      "INVALID_ARGUMENT",
    );
  }

  if (!isValidUuid(parsed.company_id) || !isValidUuid(parsed.agent_id) || !isValidUuid(parsed.upgrade_id)) {
    throw new CompanyMemoryUpgradeError(
      "Manifest contains invalid UUID identifiers.",
      "INVALID_ARGUMENT",
    );
  }

  if (typeof parsed.jsonl_sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(parsed.jsonl_sha256)) {
    throw new CompanyMemoryUpgradeError(
      "Manifest jsonl_sha256 is missing or invalid SHA-256 hex string.",
      "INVALID_ARGUMENT",
    );
  }

  if (!Number.isInteger(parsed.record_count) || parsed.record_count < 0) {
    throw new CompanyMemoryUpgradeError(
      "Manifest record_count must be a non-negative integer.",
      "INVALID_ARGUMENT",
    );
  }

  return {
    format_version: parsed.format_version,
    company_id: parsed.company_id.trim().toLowerCase(),
    agent_id: parsed.agent_id.trim().toLowerCase(),
    upgrade_id: parsed.upgrade_id.trim().toLowerCase(),
    converter_id: String(parsed.converter_id ?? ""),
    converter_version: Number(parsed.converter_version) || 1,
    record_count: parsed.record_count,
    skipped_counts_by_outcome: parsed.skipped_counts_by_outcome ?? {},
    jsonl_sha256: parsed.jsonl_sha256.trim().toLowerCase(),
    created_at: String(parsed.created_at ?? ""),
    tool: String(parsed.tool ?? ""),
  };
}

export function readAndValidateInputJsonl(
  jsonlPath: string,
  manifest: ExportManifest,
): { records: ExportJsonlRecord[]; sha256: string } {
  const resolved = path.resolve(process.cwd(), jsonlPath);
  if (!existsSync(resolved)) {
    throw new CompanyMemoryUpgradeError(
      `JSONL file does not exist at path: ${jsonlPath}`,
      "INVALID_ARGUMENT",
    );
  }

  let content: string;
  try {
    content = readFileSync(resolved, "utf8");
  } catch {
    throw new CompanyMemoryUpgradeError(
      `JSONL file could not be read: ${jsonlPath}`,
      "INVALID_ARGUMENT",
    );
  }

  const computedSha256 = createHash("sha256").update(content).digest("hex");
  if (computedSha256.toLowerCase() !== manifest.jsonl_sha256.toLowerCase()) {
    throw new CompanyMemoryUpgradeError(
      "JSONL SHA-256 checksum does not match manifest jsonl_sha256.",
      "MANIFEST_HASH_MISMATCH",
    );
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length !== manifest.record_count) {
    throw new CompanyMemoryUpgradeError(
      `JSONL record count (${lines.length}) does not match manifest record_count (${manifest.record_count}).`,
      "MANIFEST_RECORD_COUNT_MISMATCH",
    );
  }

  const records: ExportJsonlRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      throw new CompanyMemoryUpgradeError(
        `JSONL line ${i + 1} is not valid JSON.`,
        "INVALID_ARGUMENT",
      );
    }

    if (!r || typeof r !== "object" || Array.isArray(r)) {
      throw new CompanyMemoryUpgradeError(
        `JSONL line ${i + 1} is not an object.`,
        "INVALID_ARGUMENT",
      );
    }

    const cCo = String(r.company_id ?? "").trim().toLowerCase();
    const cAg = String(r.agent_id ?? "").trim().toLowerCase();
    const cUp = String(r.migration_id ?? "").trim().toLowerCase();
    const cConvId = String(r.converter_id ?? "");
    const cConvVer = Number(r.converter_version);

    if (
      cCo !== manifest.company_id ||
      cAg !== manifest.agent_id ||
      cUp !== manifest.upgrade_id ||
      cConvId !== manifest.converter_id ||
      cConvVer !== manifest.converter_version
    ) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} metadata does not match manifest.`,
        "RECORD_MANIFEST_MISMATCH",
      );
    }

    const importKey = String(r.import_key ?? "").trim().toLowerCase();
    const migratedFrom = String(r.migrated_from ?? "").trim().toLowerCase();
    if (!isValidUuid(importKey) || !isValidUuid(migratedFrom)) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} has invalid UUID keys.`,
        "RECORD_MANIFEST_MISMATCH",
      );
    }

    const text = r.text;
    if (typeof text !== "string" || text.length === 0 || text.length > EXPORT_MAX_TEXT_CHARS) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} has invalid text length.`,
        "IMPORTER_CONTRACT_VIOLATION",
      );
    }

    const conf = r.confidence;
    if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} has invalid confidence.`,
        "IMPORTER_CONTRACT_VIOLATION",
      );
    }

    const ts = parseAndNormalizeUtcIsoTimestamp(r.created_at);
    if (!ts.valid) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} has invalid created_at timestamp.`,
        "IMPORTER_CONTRACT_VIOLATION",
      );
    }

    const type = r.type;
    if (type !== null && type !== undefined && (typeof type !== "string" || type.length > EXPORT_MAX_METADATA_CHARS)) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} has invalid type metadata.`,
        "IMPORTER_CONTRACT_VIOLATION",
      );
    }

    const subject = r.subject;
    if (subject !== null && subject !== undefined && (typeof subject !== "string" || subject.length > EXPORT_MAX_METADATA_CHARS)) {
      throw new CompanyMemoryUpgradeError(
        `JSONL record at line ${i + 1} has invalid subject metadata.`,
        "IMPORTER_CONTRACT_VIOLATION",
      );
    }

    records.push({
      import_key: importKey,
      company_id: cCo,
      agent_id: cAg,
      text,
      created_at: ts.iso,
      type: typeof type === "string" ? type : null,
      subject: typeof subject === "string" ? subject : null,
      confidence: conf,
      migrated_from: migratedFrom,
      migration_id: cUp,
      converter_id: cConvId,
      converter_version: cConvVer,
    });
  }

  return { records, sha256: computedSha256 };
}

export function readKeepImportKeysFile(keysPath: string): Set<string> {
  const resolved = path.resolve(process.cwd(), keysPath);
  if (!existsSync(resolved)) {
    throw new CompanyMemoryUpgradeError(
      `Keep-import-keys file does not exist at path: ${keysPath}`,
      "INVALID_ARGUMENT",
    );
  }

  let content: string;
  try {
    content = readFileSync(resolved, "utf8");
  } catch {
    throw new CompanyMemoryUpgradeError(
      `Keep-import-keys file could not be read: ${keysPath}`,
      "INVALID_ARGUMENT",
    );
  }

  const lines = content.split("\n");
  const keys = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith("#")) continue;
    const lower = raw.toLowerCase();
    if (!isValidUuid(lower)) {
      throw new CompanyMemoryUpgradeError(
        `Invalid import_key in keep-import-keys file at line ${i + 1}: ${raw}`,
        "INVALID_ARGUMENT",
      );
    }
    keys.add(lower);
  }
  return keys;
}
