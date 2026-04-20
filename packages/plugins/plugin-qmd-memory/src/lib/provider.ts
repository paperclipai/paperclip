import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import type {
  MemoryBinding,
  MemoryProviderConfigMetadata,
  MemoryProviderHealthCheck,
  MemoryProviderCaptureInput,
  MemoryProviderForgetInput,
  MemoryProviderQueryInput,
  MemoryRecord,
  MemoryScope,
  PluginMemoryProvider,
} from "@paperclipai/plugin-sdk";
import { QMD_PLUGIN_DATA_DIR_ENV, QMD_MEMORY_PROVIDER_KEY } from "../constants.js";
import { createQmdClient, type QmdClient, type QmdMemoryConfig, type QmdSearchMode } from "./qmd.js";
import {
  listRecordFiles,
  readStoredRecord,
  removeStoredRecords,
  resolveBindingDir,
  resolveRecordFileFromHit,
  writeStoredRecord,
} from "./storage.js";

export interface CreateQmdMemoryProviderOptions {
  dataDir?: string;
  qmdClient?: QmdClient;
  now?: () => Date;
  createId?: () => string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeScopeType(scope: MemoryScope, fallback: MemoryRecord["scopeType"] = "org"): MemoryRecord["scopeType"] {
  if (scope.scopeType) return scope.scopeType;
  if (scope.runId) return "run";
  if (scope.agentId) return "agent";
  if (scope.workspaceId) return "workspace";
  if (scope.projectId) return "project";
  if (scope.teamId) return "team";
  return fallback;
}

function normalizeScopeId(companyId: string, scopeType: MemoryRecord["scopeType"], scope: MemoryScope) {
  if (scope.scopeId) return scope.scopeId;
  switch (scopeType) {
    case "run":
      return scope.runId ?? null;
    case "agent":
      return scope.agentId ?? null;
    case "workspace":
      return scope.workspaceId ?? null;
    case "project":
      return scope.projectId ?? null;
    case "team":
      return scope.teamId ?? null;
    case "org":
      return companyId;
  }
}

function normalizeDate(value: string | Date | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function parseQmdMemoryConfig(config: Record<string, unknown> | null | undefined): QmdMemoryConfig {
  const source = config ?? {};
  const searchMode = source.searchMode;
  return {
    searchMode:
      searchMode === "search" || searchMode === "vsearch" || searchMode === "query"
        ? searchMode
        : "query",
    topK: clampInt(source.topK, 5, 1, 25),
    autoIndexOnWrite: source.autoIndexOnWrite === false ? false : true,
    qmdBinaryPath: typeof source.qmdBinaryPath === "string" && source.qmdBinaryPath.trim().length > 0
      ? source.qmdBinaryPath
      : null,
  };
}

function matchesScope(recordScope: MemoryScope, queryScope: MemoryScope) {
  for (const key of ["agentId", "projectId", "issueId", "runId", "subjectId"] as const) {
    const queryValue = queryScope[key];
    if (!queryValue) continue;
    const recordValue = recordScope[key];
    if (recordValue && recordValue !== queryValue) {
      return false;
    }
  }
  return true;
}

function matchesMetadataFilter(
  metadata: Record<string, unknown>,
  filter: Record<string, unknown> | undefined,
) {
  if (!filter) return true;
  return Object.entries(filter).every(([key, value]) => metadata[key] === value);
}

function buildRecord(
  input: MemoryProviderCaptureInput,
  recordId: string,
  now: Date,
): MemoryRecord {
  const scopeType = input.scopeType ?? input.scope.scopeType ?? normalizeScopeType(input.scope);
  const scopeId = input.scopeId ?? input.scope.scopeId ?? normalizeScopeId(input.binding.companyId, scopeType, input.scope);
  return {
    id: recordId,
    companyId: input.binding.companyId,
    bindingId: input.binding.id,
    providerKey: input.binding.providerKey,
    scope: input.scope,
    source: input.source,
    scopeType,
    scopeId,
    owner: input.owner ?? input.createdBy ?? null,
    createdBy: input.createdBy ?? null,
    sensitivityLabel: input.sensitivityLabel ?? "internal",
    retentionPolicy: input.retentionPolicy ?? null,
    expiresAt: normalizeDate(input.expiresAt),
    retentionState: "active",
    reviewState: input.reviewState ?? "pending",
    reviewedAt: null,
    reviewedBy: null,
    reviewNote: null,
    citation: input.citation ?? null,
    supersedesRecordId: null,
    supersededByRecordId: null,
    revokedAt: null,
    revokedBy: null,
    revocationReason: null,
    title: input.title ?? null,
    content: input.content,
    summary: input.summary ?? null,
    metadata: input.metadata ?? {},
    createdByOperationId: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildFallbackDataDir() {
  return path.resolve(process.cwd(), ".paperclip-plugin-data");
}

export function resolveQmdMemoryDataDir(dataDir?: string) {
  return dataDir ?? process.env[QMD_PLUGIN_DATA_DIR_ENV] ?? buildFallbackDataDir();
}

export function buildQmdMemoryConfigMetadata(dataDir = resolveQmdMemoryDataDir()): MemoryProviderConfigMetadata {
  return {
    suggestedConfig: {
      searchMode: "query",
      topK: 5,
      autoIndexOnWrite: true,
      qmdBinaryPath: null,
      hookPolicies: {
        issue_comment_capture: {
          enabled: false,
          extractionMode: "paperclip_managed",
          runMode: "sync",
          harness: "server_worker",
          sensitivityLabel: "internal",
          reviewState: "accepted",
        },
      },
    },
    pathSuggestions: [
      {
        key: "dataDir",
        label: "QMD storage root",
        path: dataDir,
        description: "Default plugin data directory used for markdown memory records and qmd indexes.",
      },
    ],
    healthChecks: [
      {
        key: "dataDir",
        label: "Storage directory",
        status: "unknown",
        message: "Checked by the QMD plugin health endpoint.",
      },
      {
        key: "qmdBinary",
        label: "qmd binary",
        status: "unknown",
        message: "Checked by the QMD plugin health endpoint.",
      },
    ],
    fields: [
      {
        key: "searchMode",
        label: "Search mode",
        description: "qmd command used for retrieval.",
        input: "select",
        defaultValue: "query",
        suggestedValue: "query",
        options: [
          { value: "query", label: "Query" },
          { value: "search", label: "Search" },
          { value: "vsearch", label: "Vector search" },
        ],
      },
      {
        key: "topK",
        label: "Result limit",
        description: "Maximum qmd hits requested before Paperclip policy filtering.",
        input: "number",
        defaultValue: 5,
        suggestedValue: 5,
        min: 1,
        max: 25,
      },
      {
        key: "autoIndexOnWrite",
        label: "Auto-index on write",
        description: "Refresh the qmd index after captures and forgets.",
        input: "boolean",
        defaultValue: true,
        suggestedValue: true,
      },
      {
        key: "qmdBinaryPath",
        label: "qmd binary path",
        description: "Optional absolute path to qmd. Leave empty to use qmd from PATH.",
        input: "path",
        defaultValue: null,
        suggestedValue: null,
        placeholder: "qmd",
      },
    ],
  };
}

export async function checkQmdMemoryHealth(options: {
  dataDir?: string;
  qmdClient?: QmdClient;
  qmdBinaryPath?: string | null;
} = {}) {
  const dataDir = resolveQmdMemoryDataDir(options.dataDir);
  const qmdClient = options.qmdClient ?? createQmdClient();
  const checks: MemoryProviderHealthCheck[] = [];

  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, fsConstants.W_OK);
    checks.push({
      key: "dataDir",
      label: "Storage directory",
      status: "ok",
      message: "QMD memory storage directory is writable.",
      details: { dataDir },
    });
  } catch (error) {
    checks.push({
      key: "dataDir",
      label: "Storage directory",
      status: "error",
      message: error instanceof Error ? error.message : "QMD memory storage directory is not accessible.",
      details: { dataDir },
    });
  }

  if (qmdClient.checkHealth) {
    const binary = await qmdClient.checkHealth({ binaryPath: options.qmdBinaryPath });
    checks.push({
      key: "qmdBinary",
      label: "qmd binary",
      status: binary.available ? "ok" : "warning",
      message: binary.message,
      details: {
        binaryPath: binary.binaryPath,
      },
    });
  } else {
    checks.push({
      key: "qmdBinary",
      label: "qmd binary",
      status: "unknown",
      message: "qmd binary health check is unavailable for this client.",
    });
  }

  return {
    dataDir,
    checks,
  };
}

async function maybeRefreshIndex(
  qmdClient: QmdClient,
  binding: MemoryBinding,
  dataDir: string,
  config: QmdMemoryConfig,
) {
  if (!config.autoIndexOnWrite) return false;
  await qmdClient.refreshIndex({
    bindingDir: resolveBindingDir(dataDir, binding),
    binaryPath: config.qmdBinaryPath,
  });
  return true;
}

export function createQmdMemoryProvider(options: CreateQmdMemoryProviderOptions = {}): PluginMemoryProvider {
  const qmdClient = options.qmdClient ?? createQmdClient();
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const dataDir = resolveQmdMemoryDataDir(options.dataDir);

  return {
    key: QMD_MEMORY_PROVIDER_KEY,
    displayName: "QMD Memory",
    description: "Stores markdown records on disk and queries them through qmd.",
    async query(input: MemoryProviderQueryInput) {
      const config = parseQmdMemoryConfig(input.binding.config);
      const bindingDir = resolveBindingDir(dataDir, input.binding);
      const files = await listRecordFiles(dataDir, input.binding);
      if (files.length === 0) {
        return {
          records: [],
          resultJson: {
            searchMode: config.searchMode,
            qmdHitCount: 0,
          },
        };
      }

      const hits = await qmdClient.query({
        bindingDir,
        binaryPath: config.qmdBinaryPath,
        query: input.query,
        topK: Math.min(input.topK ?? config.topK, 25),
        mode: config.searchMode as QmdSearchMode,
      });

      const records: MemoryRecord[] = [];
      const seenRecordIds = new Set<string>();

      for (const hit of hits) {
        const hitPath = resolveRecordFileFromHit(bindingDir, hit as Record<string, unknown>);
        if (!hitPath) continue;
        let record: MemoryRecord | null = null;
        try {
          record = await readStoredRecord(hitPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!record || record.deletedAt || seenRecordIds.has(record.id)) continue;
        if (!matchesScope(record.scope, input.scope)) continue;
        if (!matchesMetadataFilter(record.metadata, input.metadataFilter)) continue;
        records.push(record);
        seenRecordIds.add(record.id);
        if (records.length >= Math.min(input.topK ?? config.topK, 25)) break;
      }

      return {
        records,
        resultJson: {
          searchMode: config.searchMode,
          qmdHitCount: hits.length,
        },
      };
    },

    async capture(input: MemoryProviderCaptureInput) {
      const config = parseQmdMemoryConfig(input.binding.config);
      const record = buildRecord(input, createId(), now());
      await writeStoredRecord(dataDir, input.binding, {
        record,
        bindingKey: input.binding.key,
      });
      const indexed = await maybeRefreshIndex(qmdClient, input.binding, dataDir, config);
      return {
        records: [record],
        resultJson: {
          indexed,
        },
      };
    },

    async forget(input: MemoryProviderForgetInput) {
      const config = parseQmdMemoryConfig(input.binding.config);
      await removeStoredRecords(dataDir, input.binding, input.recordIds);
      const indexed = await maybeRefreshIndex(qmdClient, input.binding, dataDir, config);
      return {
        forgottenRecordIds: input.recordIds,
        resultJson: {
          indexed,
        },
      };
    },
  };
}
