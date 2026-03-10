/**
 * Agent Runtime Sync Service
 *
 * Periodically syncs the local agent-runtime directory to S3 so that agent
 * memory, notes, and logs survive container restarts and re-deployments.
 *
 * Directory layout (local):
 *   <agentRuntimeDir>/<agentName>/<...files>
 *
 * S3 object key layout (per Paperclip instance):
 *   agent-runtime/<instanceId>/<agentName>/<...files>
 *
 * Only runs when the storage provider is "s3". Silently skips on "local_disk".
 * Skips individual files whose S3 etag matches the local content hash —
 * unchanged files are never re-uploaded.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";
import { resolvePaperclipInstanceId } from "../home-paths.js";
import type { StorageProvider } from "../storage/types.js";

function md5(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

function normalizeEtag(raw: string | undefined): string {
  // S3 ETags are quoted strings: "abc123" → abc123
  return raw ? raw.replace(/^"|"$/g, "") : "";
}

async function walkDir(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkDir(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

async function syncFile(
  provider: StorageProvider,
  localPath: string,
  objectKey: string,
): Promise<"uploaded" | "skipped" | "error"> {
  try {
    const body = await fs.readFile(localPath);
    const localEtag = md5(body);

    const head = await provider.headObject({ objectKey });
    if (head.exists && normalizeEtag(head.etag) === localEtag) {
      return "skipped";
    }

    await provider.putObject({
      objectKey,
      body,
      contentType: "application/octet-stream",
      contentLength: body.length,
    });
    return "uploaded";
  } catch {
    return "error";
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
}

export interface RestoreFileEntry {
  objectKey: string;
  relativePath: string;
  s3Size?: number;
  s3Etag?: string;
  localSize?: number;
}

export interface RestorePreview {
  enabled: boolean;
  storageProvider: string;
  totalS3Files: number;
  missing: RestoreFileEntry[];
  conflicts: RestoreFileEntry[];
  synced: number;
}

export type RestoreStrategy = "missing_only" | "overwrite_all" | "selected";

/**
 * Preview what a restore from S3 would do without writing any files.
 * Returns the set of missing files (not on disk) and conflict files
 * (on disk but with different content than S3).
 */
export async function previewAgentRuntimeRestore(): Promise<RestorePreview> {
  const config = loadConfig();

  if (config.storageProvider !== "s3") {
    return {
      enabled: false,
      storageProvider: config.storageProvider,
      totalS3Files: 0,
      missing: [],
      conflicts: [],
      synced: 0,
    };
  }

  const runtimeDir = config.agentRuntimeDir;
  const provider = createStorageProviderFromConfig(config);
  const instanceId = resolvePaperclipInstanceId();
  const s3Prefix = `agent-runtime/${instanceId}`;

  const objects = await provider.listObjects({ prefix: s3Prefix });

  const missing: RestoreFileEntry[] = [];
  const conflicts: RestoreFileEntry[] = [];
  let synced = 0;

  for (const obj of objects) {
    const relativePath = obj.objectKey.slice(s3Prefix.length + 1);
    if (!relativePath) continue;

    const localPath = path.join(runtimeDir, relativePath.split("/").join(path.sep));
    const localStat = await fs.stat(localPath).catch(() => null);

    const entry: RestoreFileEntry = {
      objectKey: obj.objectKey,
      relativePath,
      s3Size: obj.size,
      s3Etag: obj.etag ? normalizeEtag(obj.etag) : undefined,
    };

    if (!localStat) {
      missing.push(entry);
    } else {
      entry.localSize = localStat.size;
      // Compare etag to detect conflicts (local != S3)
      const localBody = await fs.readFile(localPath).catch(() => null);
      if (localBody && obj.etag && md5(localBody) !== normalizeEtag(obj.etag)) {
        conflicts.push(entry);
      } else {
        synced++;
      }
    }
  }

  return {
    enabled: true,
    storageProvider: "s3",
    totalS3Files: objects.length,
    missing,
    conflicts,
    synced,
  };
}

/**
 * Restore agent runtime files from S3 to the local runtime directory.
 *
 * Called once at server startup so that agent memory, notes, and plans survive
 * container replacements. Files that already exist locally are left untouched —
 * local state always wins (the live container may have written since the last
 * sync; we never clobber uncommitted work).
 *
 * When called from the API, callers can pass a strategy and an optional list
 * of specific objectKeys to restore (for `selected` strategy).
 */
export async function restoreAgentRuntimeFromS3(opts?: {
  strategy?: RestoreStrategy;
  selectedKeys?: string[];
}): Promise<{
  provider: string;
  restored: number;
  skipped: number;
  errors: number;
}> {
  const config = loadConfig();

  if (config.storageProvider !== "s3") {
    return { provider: config.storageProvider, restored: 0, skipped: 0, errors: 0 };
  }

  const strategy = opts?.strategy ?? "missing_only";
  const selectedKeys = opts?.selectedKeys ? new Set(opts.selectedKeys) : null;

  const runtimeDir = config.agentRuntimeDir;
  const provider = createStorageProviderFromConfig(config);
  const instanceId = resolvePaperclipInstanceId();
  const s3Prefix = `agent-runtime/${instanceId}`;

  const objects = await provider.listObjects({ prefix: s3Prefix });

  let restored = 0;
  let skipped = 0;
  let errors = 0;

  for (const obj of objects) {
    // obj.objectKey is relative to the provider's storage prefix, e.g.
    // "agent-runtime/<instanceId>/ceo/memory/notes.md"
    // Strip the instance prefix to get the path relative to runtimeDir.
    const relativePath = obj.objectKey.slice(s3Prefix.length + 1);
    if (!relativePath) continue;

    const localPath = path.join(runtimeDir, relativePath.split("/").join(path.sep));
    const localStat = await fs.stat(localPath).catch(() => null);

    // Determine whether to write this file
    let shouldWrite = false;
    if (!localStat) {
      shouldWrite = true; // file is missing — always restore
    } else if (strategy === "overwrite_all") {
      shouldWrite = true;
    } else if (strategy === "selected" && selectedKeys?.has(obj.objectKey)) {
      shouldWrite = true;
    }

    if (!shouldWrite) {
      skipped++;
      continue;
    }

    try {
      const result = await provider.getObject({ objectKey: obj.objectKey });
      const body = await streamToBuffer(result.stream);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, body);
      restored++;
    } catch {
      errors++;
    }
  }

  return { provider: "s3", restored, skipped, errors };
}

export async function syncAgentRuntimeToS3(): Promise<{
  provider: string;
  uploaded: number;
  skipped: number;
  errors: number;
}> {
  const config = loadConfig();

  if (config.storageProvider !== "s3") {
    return { provider: config.storageProvider, uploaded: 0, skipped: 0, errors: 0 };
  }

  const runtimeDir = config.agentRuntimeDir;

  // Ensure the directory exists before trying to walk it
  const exists = await fs.stat(runtimeDir).then((s) => s.isDirectory()).catch(() => false);
  if (!exists) {
    return { provider: "s3", uploaded: 0, skipped: 0, errors: 0 };
  }

  const provider = createStorageProviderFromConfig(config);
  const instanceId = resolvePaperclipInstanceId();
  const files = await walkDir(runtimeDir);

  let uploaded = 0;
  let skipped = 0;
  let errors = 0;

  for (const filePath of files) {
    const relative = path.relative(runtimeDir, filePath);
    const objectKey = `agent-runtime/${instanceId}/${relative.split(path.sep).join("/")}`;
    const result = await syncFile(provider, filePath, objectKey);
    if (result === "uploaded") uploaded++;
    else if (result === "skipped") skipped++;
    else errors++;
  }

  return { provider: "s3", uploaded, skipped, errors };
}
