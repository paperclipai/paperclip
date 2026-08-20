/**
 * Agent folder instruction inheritance resolution.
 *
 * Resolves hierarchical folder-level shared instructions for an agent by
 * walking the agent's folder chain (agent.folderId → parent → parent's parent → …)
 * and reading instruction files from disk at:
 *
 *   <instanceRoot>/companies/<companyId>/folders/<folderId>/instructions/
 *
 * The resolved instructions are pre-merged in leaf-to-root order (deepest
 * folder first) so that more specific folder instructions take precedence,
 * with the agent's own instructions prepended last (highest precedence).
 *
 * Results are cached with a fingerprint that covers the folder chain, the
 * file modification times, and the agent's own instructions file hash, so
 * that re-merging is skipped when nothing has changed.
 *
 * This service is adapter-agnostic and relies only on the filesystem and
 * the Paperclip instance root — it does not require DB access.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

const INSTRUCTIONS_DIR = "instructions";
const ENTRY_FILE = "AGENTS.md";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FolderInfo {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  sortOrder: number;
}

interface FolderInstructionsCacheEntry {
  fingerprint: string;
  mergedInstructions: string;
  /** ISO timestamp of the most-recently-modified instruction file in the chain. */
  latestFileMtime: string | null;
  /** Per-folder file content hash, used for robust staleness detection. */
  folderFileHashes: Record<string, string | null>;
}

type FolderChainResolver = (
  companyId: string,
  folderId: string,
) => Promise<FolderInfo[]>;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the instance root. Honors the PAPERCLIP_INSTANCE_ROOT env var
 * (set by the heartbeat service for runs) and falls back to the standard
 * Paperclip instance path.
 */
function resolveInstanceRoot(): string {
  const envRoot = process.env.PAPERCLIP_INSTANCE_ROOT;
  if (envRoot && path.isAbsolute(envRoot)) return envRoot;
  const envConfig = process.env.PAPERCLIP_CONFIG_PATH;
  if (envConfig) {
    const base = path.dirname(envConfig);
    return base;
  }
  // Fallback: standard instance root
  return path.resolve(homedir(), ".paperclip", "instances", "default");
}

/**
 * Resolve the instructions directory for a given folder.
 * Path: <instanceRoot>/companies/<companyId>/folders/<folderId>/instructions/
 */
function resolveFolderInstructionsDir(
  companyId: string,
  folderId: string,
): string {
  return path.resolve(
    resolveInstanceRoot(),
    "companies",
    companyId,
    "folders",
    folderId,
    INSTRUCTIONS_DIR,
  );
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function readInstructionsFile(dir: string): Promise<string | null> {
  const entryPath = path.join(dir, ENTRY_FILE);
  const content = await fs.readFile(entryPath, "utf-8").catch(() => null);
  if (content === null) return null;

  const trimmed = content.trim();
  if (!trimmed) return null;

  const suffix = `\n\nThe above folder-level shared instructions were loaded from ${entryPath}. Resolve any relative file references from ${path.dirname(entryPath)}/.`;
  return trimmed + suffix;
}

async function getFileMtime(dir: string): Promise<string | null> {
  const entryPath = path.join(dir, ENTRY_FILE);
  const stat = await statIfExists(entryPath);
  return stat?.mtime?.toISOString() ?? null;
}

/**
 * Collect all instruction files in a folder's instructions directory,
 * returning their paths sorted deterministically. Used for fingerprinting
 * so that edits to non-entry files also invalidate the cache.
 */
async function listInstructionFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

async function getInstructionFilesHash(dir: string): Promise<string | null> {
  const files = await listInstructionFiles(dir);
  if (files.length === 0) return null;

  const hasher = createHash("sha256");
  for (const file of files) {
    const content = await fs.readFile(path.join(dir, file), "utf-8").catch(() => "");
    hasher.update(file);
    hasher.update(content);
  }
  return hasher.digest("hex");
}

// ---------------------------------------------------------------------------
// Fingerprint caching (in-memory, process-scoped)
// ---------------------------------------------------------------------------

const fingerprintCache = new Map<string, FolderInstructionsCacheEntry>();

/**
 * Build a cache key from the company ID, folder chain, and agent instructions hash.
 * The cache key encodes everything that could change the merged output.
 */
function buildCacheKey(
  companyId: string,
  chain: FolderInfo[],
  agentInstructionsHash: string | null,
): string {
  const chainIds = chain.map((f) => `${f.id}:${f.parentId ?? "null"}`).join(",");
  return `folder-instructions:${companyId}:${chainIds}:${agentInstructionsHash ?? "null"}`;
}

function hashAgentInstructions(instructions: string): string | null {
  if (!instructions || instructions.trim().length === 0) return null;
  return createHash("sha256").update(instructions).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Folder chain resolution
// ---------------------------------------------------------------------------

/**
 * Walk the folder chain from leaf to root using the provided resolver.
 * Returns folders ordered from leaf (agent's immediate folder) to root.
 *
 * The resolver is injected so this service can be tested without a DB.
 * In production, the resolver queries the Paperclip API or DB for folder
 * parent/child relationships.
 */
async function resolveFolderChain(
  companyId: string,
  folderId: string,
  resolveFolder: (id: string) => Promise<FolderInfo | null>,
): Promise<FolderInfo[]> {
  const chain: FolderInfo[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;

  while (currentId !== null && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = await resolveFolder(currentId);
    if (!folder) break;

    chain.push(folder);
    currentId = folder.parentId;
  }

  // Detect cycles: if we exited the loop because currentId was already visited,
  // it means there's a cycle in the hierarchy.
  if (currentId !== null && visited.has(currentId)) {
    throw new Error(
      `Folder hierarchy cycle detected: folder ${currentId} appears more than once in the chain`,
    );
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Merged instruction resolution
// ---------------------------------------------------------------------------

/**
 * Resolve merged folder-level instructions for an agent.
 *
 * Walks the agent's folder chain (leaf to root), reads instruction files
 * from each folder's instructions directory on disk, and concatenates them
 * in leaf-to-root order (so child folder instructions take precedence over
 * parent). Results are cached with a fingerprint that invalidates when
 * any file in the chain changes.
 *
 * @param companyId  - The Paperclip company ID
 * @param folderId   - The agent's immediate folder ID (may be null)
 * @param resolveFolder - Function to look up a folder by ID (from DB or API)
 * @param agentInstructions - The agent's own instructions (prepended at merge time, not in cache)
 * @returns The merged folder instructions string, or empty string if none
 */
export async function resolveFolderInstructions(options: {
  companyId: string;
  folderId: string | null;
  resolveFolder: (id: string) => Promise<FolderInfo | null>;
  agentInstructions?: string;
}): Promise<{
  mergedInstructions: string;
  chain: FolderInfo[];
  fingerprint: string | null;
}> {
  if (!options.folderId) {
    return { mergedInstructions: "", chain: [], fingerprint: null };
  }

  const { companyId, folderId, resolveFolder, agentInstructions } = options;

  // Walk the folder chain from leaf to root
  const chain = await resolveFolderChain(companyId, folderId, resolveFolder);
  if (chain.length === 0) {
    return { mergedInstructions: "", chain: [], fingerprint: null };
  }

  // Build fingerprint components
  const agentInstructionsHash = hashAgentInstructions(agentInstructions ?? "");
  const cacheKey = buildCacheKey(companyId, chain, agentInstructionsHash);

  // Collect folder instruction files and their fingerprints
  const folderData: Array<{
    folder: FolderInfo;
    instructions: string | null;
    fileMtime: string | null;
    filesHash: string | null;
  }> = [];

  let latestFileMtime: string | null = null;

  for (const folder of chain) {
    const dir = resolveFolderInstructionsDir(companyId, folder.id);
    const stat = await statIfExists(dir);
    if (!stat?.isDirectory()) {
      folderData.push({
        folder,
        instructions: null,
        fileMtime: null,
        filesHash: null,
      });
      continue;
    }

    const instructions = await readInstructionsFile(dir);
    const fileMtime = await getFileMtime(dir);
    const filesHash = await getInstructionFilesHash(dir);

    if (fileMtime && (!latestFileMtime || fileMtime > latestFileMtime)) {
      latestFileMtime = fileMtime;
    }

    folderData.push({
      folder,
      instructions,
      fileMtime,
      filesHash,
    });
  }

  // Check cache
  const cached = fingerprintCache.get(cacheKey);
  if (cached && cached.latestFileMtime === latestFileMtime) {
    return {
      mergedInstructions: cached.mergedInstructions,
      chain,
      fingerprint: cached.fingerprint,
    };
  }

  // Merge: leaf-to-root order (child folders take precedence)
  const parts: string[] = [];
  const fingerprintParts: string[] = [];

  for (const data of folderData) {
    if (data.instructions) {
      parts.push(data.instructions);
    }
    if (data.filesHash) {
      fingerprintParts.push(`${data.folder.id}:${data.filesHash}`);
    } else {
      fingerprintParts.push(`${data.folder.id}:empty`);
    }
  }

  const mergedInstructions = parts.length > 0
    ? parts.join("\n\n---\n\n") +
      `\n\n[Folder instructions merged from ${chain.length} folder(s) in chain]`
    : "";

  // Build fingerprint from folder chain + file hashes
  const fingerprint = createHash("sha256")
    .update(fingerprintParts.join("|"))
    .update(`|agent:${agentInstructionsHash ?? "null"}`)
    .digest("hex")
    .slice(0, 32);

  // Cache the result
  const folderFileHashes: Record<string, string | null> = {};
  for (const data of folderData) {
    folderFileHashes[data.folder.id] = data.filesHash;
  }
  fingerprintCache.set(cacheKey, {
    fingerprint,
    mergedInstructions,
    latestFileMtime,
    folderFileHashes,
  });

  return {
    mergedInstructions,
    chain,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

/** Clear the in-memory fingerprint cache. Useful for tests and forced refresh. */
export function clearFolderInstructionsCache(): void {
  fingerprintCache.clear();
}

/**
 * Check whether the cached folder instructions are stale for a given
 * company + folder chain. Returns null if no cache entry exists or if
 * any instruction file in the chain has been modified since caching.
 */
export async function checkFolderInstructionsFreshness(
  companyId: string,
  folderId: string | null,
  resolveFolder: (id: string) => Promise<FolderInfo | null>,
): Promise<{ stale: boolean; fingerprint: string | null }> {
  if (!folderId) {
    return { stale: true, fingerprint: null };
  }

  const chain = await resolveFolderChain(companyId, folderId, resolveFolder);
  const cacheKey = buildCacheKey(companyId, chain, null);
  const cached = fingerprintCache.get(cacheKey);

  if (!cached) {
    return { stale: true, fingerprint: null };
  }

  // Check if any file has changed: compare mtime AND content hash
  let currentLatestMtime: string | null = null;
  let contentChanged = false;
  for (const folder of chain) {
    const dir = resolveFolderInstructionsDir(companyId, folder.id);
    const mtime = await getFileMtime(dir);
    if (mtime && (!currentLatestMtime || mtime > currentLatestMtime)) {
      currentLatestMtime = mtime;
    }
    // Compare content hash for robust change detection (mtime can be same-ms)
    const currentHash = await getInstructionFilesHash(dir);
    const cachedHash = cached.folderFileHashes[folder.id];
    if (currentHash !== cachedHash) {
      contentChanged = true;
    }
  }

  const stale = contentChanged || currentLatestMtime !== cached.latestFileMtime;
  return { stale, fingerprint: cached.fingerprint };
}
