/**
 * Instruction Inheritance Resolution Engine (JAC-4750 Phase 2)
 *
 * Walks the agent folder chain (agent.folderId -> parent -> root),
 * reads per-folder shared instructions from disk, merges them with
 * section headers, and caches the result keyed by a content fingerprint.
 *
 * Disk layout:
 *   <instanceRoot>/companies/<companyId>/folders/<folderId>/instructions/
 *     AGENTS.md            <- folder-level shared instructions
 *     HERMES.md            <- hermes_local adapter supplementary
 *     CLAUDE.md            <- claude_local adapter supplementary
 *     <agentId>.md         <- agent-specific override (inherited on top)
 *
 * Merge order: root folder -> intermediate folders -> leaf folder -> agent overrides
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agentFolders } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTRUCTIONS_DIR = "instructions";
const AGENTS_ENTRY = "AGENTS.md";
const GENERATED_DIR = "__generated__";
const GENERATED_FILE = "merged.md";
const MERGED_FILE_PATH = path.join(GENERATED_DIR, GENERATED_FILE);

/** Max entries in the in-memory LRU cache. */
const CACHE_MAX_ENTRIES = 500;

/** Adapter type -> supplementary instruction file name (fallback).
 * Adapters may also declare instructionsSupplementaryFiles on their
 * ServerAdapterModule manifest, which overrides this map at resolution time
 * (JAC-4750 Phase 2). */
const ADAPTER_SUPPLEMENTARY_FILES: Record<string, string> = {
  hermes_local: "HERMES.md",
  claude_local: "CLAUDE.md",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal agent shape needed for inheritance resolution. */
export interface AgentLikeForInheritance {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
  adapterType: string;
  folderId: string | null;
}

/** A single folder in the chain (DB row shape). */
export interface InheritanceFolder {
  id: string;
  parentId: string | null;
  name: string;
  slug: string;
  instructionsPath: string | null;
}

/** A folder chain entry returned in the API response. */
export interface InheritanceChainEntry {
  folderId: string;
  folderName: string;
  folderSlug: string;
  hasInstructions: boolean;
  fileMtime: string | null;
  contentHash: string | null;
}

/** The full resolved inheritance result. */
export interface ResolvedAgentInstructions {
  mergedInstructions: string;
  mergedFilePath: string;
  fingerprint: string;
  chain: InheritanceChainEntry[];
  fromCache: boolean;
  /** The folderId that was resolved (from agent.folderId or adapterConfig.instructionsFolderId). */
  resolvedFolderId: string | null;
  /** Supplementary files map used during resolution (from adapter manifest). */
  instructionsSupplementaryFiles: Record<string, string>;
  /** Per-agent instruction overrides applied at the top of the merge chain. */
  instructionsOverrides: string | null;
  /** The effective instructions file path (the merged file path, suitable for adapterConfig.instructionsFilePath). */
  instructionsFilePath: string | null;
}

interface CacheEntry {
  fingerprint: string;
  companyId: string;
  mergedInstructions: string;
  chain: InheritanceChainEntry[];
  /** ISO timestamp of the most-recently-modified instruction file in the chain. */
  latestFileMtime: string | null;
  /** Per-folder file content hash, for robust staleness detection. */
  folderFileHashes: Record<string, string | null>;
  /** Hash of the agent's override AGENTS.md (null if none). */
  overrideHash: string | null;
  evictedAt: number;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the instructions directory for a given folder.
 * Path: <instanceRoot>/companies/<companyId>/folders/<folderId>/instructions/
 */
export function resolveFolderInstructionsDir(companyId: string, folderId: string): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    companyId,
    "folders",
    folderId,
    INSTRUCTIONS_DIR,
  );
}

/**
 * Resolve the agent's own instructions root (managed bundle root).
 * Path: <instanceRoot>/companies/<companyId>/agents/<agentId>/instructions/
 */
export function resolveAgentInstructionsRoot(companyId: string, agentId: string): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    companyId,
    "agents",
    agentId,
    INSTRUCTIONS_DIR,
  );
}

/**
 * Resolve the path to the generated merged file for an agent.
 * Path: <agentInstructionsRoot>/__generated__/merged.md
 */
export function resolveMergedFilePath(companyId: string, agentId: string): string {
  return path.resolve(resolveAgentInstructionsRoot(companyId, agentId), MERGED_FILE_PATH);
}

/**
 * Resolve the directory containing generated files for an agent.
 */
export function resolveGeneratedDir(companyId: string, agentId: string): string {
  return path.resolve(resolveAgentInstructionsRoot(companyId, agentId), GENERATED_DIR);
}

/**
 * Resolve the supplementary instruction file name for a given adapter type.
 * Uses the manifest-declared instructionsSupplementaryFiles map when provided
 * (JAC-4750 Phase 2), falling back to the built-in ADAPTER_SUPPLEMENTARY_FILES
 * map.
 */
function resolveSupplementaryFile(
  adapterType: string,
  manifestSupplementaryFiles?: Record<string, string>,
): string | null {
  if (manifestSupplementaryFiles) {
    const name = manifestSupplementaryFiles[adapterType];
    if (name) return name;
    // Manifest explicitly declared this adapter has no supplementary file
    if (Object.prototype.hasOwnProperty.call(manifestSupplementaryFiles, adapterType)) {
      return null;
    }
  }
  const name = ADAPTER_SUPPLEMENTARY_FILES[adapterType];
  return name ?? null;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function readFileIfExists(targetPath: string): Promise<string | null> {
  const content = await fs.readFile(targetPath, "utf-8").catch(() => null);
  if (content === null) return null;
  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the AGENTS.md entry file from a folder's instructions directory.
 * Returns null if the file doesn't exist or is empty.
 */
async function readFolderEntry(dir: string): Promise<string | null> {
  const entryPath = path.join(dir, AGENTS_ENTRY);
  return readFileIfExists(entryPath);
}

async function getFileMtime(dir: string): Promise<string | null> {
  const entryPath = path.join(dir, AGENTS_ENTRY);
  const stat = await statIfExists(entryPath);
  return stat?.mtime?.toISOString() ?? null;
}

/**
 * List all .md instruction files in a folder's instructions directory,
 * sorted deterministically. Used for fingerprinting so edits to
 * supplementary files (HERMES.md, CLAUDE.md) also invalidate the cache.
 */
async function listInstructionFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Compute a combined content hash of all .md instruction files in a folder.
 * This is more robust than mtime alone (mtime can be same-millis).
 */
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
// Fingerprint computation
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hash of the agent's own AGENTS.md override file.
 * Returns null if the file doesn't exist or is empty.
 */
export async function computeAgentOverrideHash(
  companyId: string,
  agentId: string,
): Promise<string | null> {
  const agentOverridePath = path.join(
    resolveAgentInstructionsRoot(companyId, agentId),
    AGENTS_ENTRY,
  );
  const content = await readFileIfExists(agentOverridePath);
  if (content === null) return null;
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Compute a fingerprint for an agent's instruction bundle.
 *
 * The fingerprint covers:
 *   - folder_id of the agent's leaf folder
 *   - per-folder content hashes (AGENTS.md + supplementary files) for each folder in the chain
 *   - agent override instructions hash (SHA-256 of the agent's own AGENTS.md)
 *   - adapter type (so adapter-specific supplementary files are accounted for)
 *
 * If any of these change, the fingerprint changes and the cache is invalidated.
 */
export async function computeInstructionsFingerprint(
  agent: AgentLikeForInheritance,
  chain: InheritanceFolder[],
  options?: {
    instructionsSupplementaryFiles?: Record<string, string>;
    instructionsOverrides?: string;
  },
): Promise<string> {
  const hasher = createHash("sha256");

  // Agent's leaf folder id (or null)
  hasher.update(`folder:${agent.folderId ?? "null"}`);

  // Adapter type
  hasher.update(`adapter:${agent.adapterType ?? "unknown"}`);

  // Per-folder content hashes for each folder in root→leaf order
  for (const folder of chain) {
    const dir = resolveFolderInstructionsDir(agent.companyId, folder.id);
    const filesHash = await getInstructionFilesHash(dir);
    hasher.update(`|folder:${folder.id}:${filesHash ?? "empty"}`);
  }

  // Agent override instructions hash (computed on-the-fly)
  const overrideHash = await computeAgentOverrideHash(agent.companyId, agent.id);
  hasher.update(`|agent:${overrideHash ?? "null"}`);

  // Inline overrides from adapterConfig (instructionsOverrides)
  const inlineOverrides = options?.instructionsOverrides?.trim() ?? "";
  hasher.update(`|inlineOverrides:${inlineOverrides.length > 0 ? createHash("sha256").update(inlineOverrides).digest("hex").slice(0, 16) : "null"}`);

  // Supplementary files map (so manifest changes invalidate cache)
  const suppKeys = Object.keys(options?.instructionsSupplementaryFiles ?? {}).sort();
  hasher.update(`|supp:${suppKeys.join(",")}`);

  return hasher.digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Folder chain resolution (recursive CTE)
// ---------------------------------------------------------------------------

/**
 * Walk the folder chain from the agent's leaf folder up to the root,
 * returning folders ordered root -> leaf.
 *
 * Uses a recursive CTE in SQL to traverse the parent_id chain:
 *   WITH RECURSIVE folder_chain AS (
 *     -- base case: the starting folder
 *     SELECT id, parent_id, name, slug, 0 AS depth
 *     FROM agent_folders WHERE id = :startId AND company_id = :companyId
 *     UNION ALL
 *     -- recursive step: join each folder to its parent
 *     SELECT f.id, f.parent_id, f.name, f.slug, fc.depth + 1
 *     FROM agent_folders f
 *     JOIN folder_chain fc ON f.id = fc.parent_id
 *     WHERE fc.depth < 100  -- safety: prevent infinite recursion
 *   )
 *   SELECT * FROM folder_chain ORDER BY depth DESC
 *
 * The ORDER BY depth DESC ensures root->leaf ordering (root has depth 0,
 * leaf has the highest depth).
 */
export async function walkFolderChain(
  db: Db,
  companyId: string,
  folderId: string,
): Promise<InheritanceFolder[]> {
  // Use raw SQL with a recursive CTE, as Drizzle ORM doesn't have
  // first-class recursive CTE support.
  const rows = await db.execute<{
    id: string;
    parentId: string | null;
    name: string;
    slug: string;
  }>(sql`
    WITH RECURSIVE folder_chain AS (
      SELECT
        ${agentFolders.id} AS "id",
        ${agentFolders.parentId} AS "parentId",
        ${agentFolders.name} AS "name",
        ${agentFolders.slug} AS "slug",
        0 AS "depth"
      FROM ${agentFolders}
      WHERE ${agentFolders.id} = ${folderId}
        AND ${agentFolders.companyId} = ${companyId}
      UNION ALL
      SELECT
        f.${agentFolders.id} AS "id",
        f.${agentFolders.parentId} AS "parentId",
        f.${agentFolders.name} AS "name",
        f.${agentFolders.slug} AS "slug",
        fc."depth" + 1 AS "depth"
      FROM ${agentFolders} AS f
      JOIN folder_chain AS fc ON f.${agentFolders.id} = fc."parentId"
      WHERE fc."depth" < 100
    )
    SELECT "id", "parentId", "name", "slug"
    FROM folder_chain
    ORDER BY "depth" DESC
  `);

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parentId ?? null,
    name: row.name,
    slug: row.slug,
    instructionsPath: path.join(
      resolvePaperclipInstanceRoot(),
      "companies",
      companyId,
      "folders",
      row.id,
      INSTRUCTIONS_DIR,
    ),
  }));
}

// ---------------------------------------------------------------------------
// Merged instruction building
// ---------------------------------------------------------------------------

/**
 * Build merged instructions from the folder chain and agent overrides.
 *
 * Merge semantics:
 *   Root folder -> intermediate folders -> leaf folder -> agent overrides
 *
 * Section headers are inserted before each section:
 *   # [Folder: Engineering]
 *   # [Agent: Builder-3]
 *
 * Adapter-specific supplementary files are read and appended after the AGENTS.md
 * content for each folder (HERMES.md for hermes_local, CLAUDE.md for claude_local).
 */
export async function buildMergedInstructions(
  agent: AgentLikeForInheritance,
  chain: InheritanceFolder[],
  options?: {
    instructionsSupplementaryFiles?: Record<string, string>;
    instructionsOverrides?: string;
  },
): Promise<string> {
  const supplementaryFiles = options?.instructionsSupplementaryFiles;
  const overrides = options?.instructionsOverrides;
  const parts: string[] = [];

  // Walk chain in root->leaf order (chain is already root->leaf from walkFolderChain)
  for (const folder of chain) {
    const dir = folder.instructionsPath ?? resolveFolderInstructionsDir(agent.companyId, folder.id);
    const dirStat = await statIfExists(dir);
    if (!dirStat?.isDirectory()) continue;

    // Read the folder's AGENTS.md entry
    const entryContent = await readFolderEntry(dir);
    if (entryContent) {
      parts.push(`# [Folder: ${folder.name}]\n\n${entryContent}`);
    }

    // Read adapter-specific supplementary file if it exists
    const supplementaryFile = resolveSupplementaryFile(agent.adapterType, supplementaryFiles);
    if (supplementaryFile) {
      const supplementaryPath = path.join(dir, supplementaryFile);
      const supplementaryContent = await readFileIfExists(supplementaryPath);
      if (supplementaryContent) {
        parts.push(`# [Folder: ${folder.name}] ${supplementaryFile}\n\n${supplementaryContent}`);
      }
    }
  }

  // Append agent-specific overrides (highest precedence — last)
  const agentOverridePath = path.join(
    resolveAgentInstructionsRoot(agent.companyId, agent.id),
    AGENTS_ENTRY,
  );
  const agentOverrideContent = await readFileIfExists(agentOverridePath);
  if (agentOverrideContent) {
    parts.push(`# [Agent: ${agent.name}]\n\n${agentOverrideContent}`);
  }

  // Append per-agent inline overrides from adapterConfig (instructionsOverrides)
  if (overrides && overrides.trim().length > 0) {
    parts.push(`# [Agent: ${agent.name} (override)]\n\n${overrides.trim()}`);
  }

  if (parts.length === 0) return "";

  return `${parts.join("\n\n---\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Merged file generation
// ---------------------------------------------------------------------------

/**
 * Generate the merged instructions file at:
 *   <agentInstructionsRoot>/__generated__/merged.md
 *
 * The generated file is marked as non-editable via bundle metadata
 * (editable: false, generated: true) which is handled by the caller
 * in the bundle response.
 */
export async function generateMergedFile(
  agent: AgentLikeForInheritance,
  chain: InheritanceFolder[],
  mergedInstructions: string,
  fingerprint: string,
): Promise<string> {
  const generatedDir = resolveGeneratedDir(agent.companyId, agent.id);
  await fs.mkdir(generatedDir, { recursive: true });

  const filePath = resolveMergedFilePath(agent.companyId, agent.id);
  const header = `<!-- AUTO-GENERATED by Instruction Inheritance Resolution Engine (JAC-4750) -->\n<!-- Do not edit this file directly. Edit folder AGENTS.md or agent overrides instead. -->\n<!-- Fingerprint: ${fingerprint} -->\n\n`;

  await fs.writeFile(filePath, header + mergedInstructions, "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// LRU Cache (max 500 entries)
// ---------------------------------------------------------------------------

/**
 * Simple LRU cache for merged instruction results, keyed by fingerprint.
 * Bounded at CACHE_MAX_ENTRIES (500). On overflow, evicts the least-recently-used entry.
 */
export class InstructionsLRUCache {
  private entries = new Map<string, CacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize: number = CACHE_MAX_ENTRIES) {
    this.maxSize = maxSize;
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      // Move to end (most recently used)
      this.entries.delete(key);
      this.entries.set(key, entry);
      return entry;
    }
    return undefined;
  }

  set(key: string, entry: CacheEntry): void {
    // If key exists, delete first so it moves to end
    if (this.entries.has(key)) this.entries.delete(key);

    if (this.entries.size >= this.maxSize) {
      // Evict least recently used (first entry)
      const lruKey = this.entries.keys().next().value;
      if (lruKey !== undefined) {
        const lruEntry = this.entries.get(lruKey);
        if (lruEntry) lruEntry.evictedAt = Date.now();
        this.entries.delete(lruKey);
      }
    }

    this.entries.set(key, entry);
  }

  /** Invalidate all cache entries belonging to a given company. */
  invalidateByCompany(companyId: string): number {
    let count = 0;
    for (const [key, entry] of this.entries.entries()) {
      if (entry.companyId === companyId) {
        this.entries.delete(key);
        count++;
      }
    }
    return count;
  }

  /** Invalidate a specific cache key. */
  invalidate(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Clear all cache entries. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

// Shared cache instance (process-scoped)
const cache = new InstructionsLRUCache();

/**
 * Invalidate all cached instruction fingerprints for agents in the given company.
 * Called when a folder's AGENTS.md is updated, or when a folder is reparented.
 */
export function invalidateCompanyCache(companyId: string): number {
  return cache.invalidateByCompany(companyId);
}

/** For tests: clear the entire cache. */
export function clearInheritanceCache(): void {
  cache.clear();
}

/** For tests: expose cache size. */
export function getInheritanceCacheSize(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// Main resolution entry point
// ---------------------------------------------------------------------------

// Cache key for the merged file path (used to return the file path from cache)
const mergedFilePathCache = new Map<string, string>();

/**
 * Options for instruction inheritance resolution (JAC-4750 Phase 2).
 */
export interface ResolveAgentInstructionsOptions {
  /** Supplementary instruction files map, typically from the adapter manifest. */
  instructionsSupplementaryFiles?: Record<string, string>;
  /** Per-agent inline instruction overrides from adapterConfig.instructionsOverrides. */
  instructionsOverrides?: string;
}

/**
 * Resolve the full merged instructions for an agent.
 *
 * Main entry point — walks the folder chain, builds merged instructions,
 * generates the merged file, and caches results by fingerprint.
 *
 * @param db    - Paperclip DB instance
 * @param agent - Agent with folderId and adapterType
 * @param options - Optional supplementary files map and inline overrides
 * @returns ResolvedAgentInstructions with merged content, file path, fingerprint, and chain
 */
export async function resolveAgentInstructions(
  db: Db,
  agent: AgentLikeForInheritance,
  options?: ResolveAgentInstructionsOptions,
): Promise<ResolvedAgentInstructions> {
  const supplementaryFiles = options?.instructionsSupplementaryFiles ?? ADAPTER_SUPPLEMENTARY_FILES;
  const overrides = options?.instructionsOverrides;

  // If agent has no folderId, return flat (empty) chain — backward compat
  if (!agent.folderId) {
    return {
      mergedInstructions: "",
      mergedFilePath: "",
      fingerprint: "",
      chain: [],
      fromCache: false,
      resolvedFolderId: agent.folderId,
      instructionsSupplementaryFiles: supplementaryFiles,
      instructionsOverrides: overrides ?? null,
      instructionsFilePath: null,
    };
  }

  // Walk the folder chain (root -> leaf)
  const chain = await walkFolderChain(db, agent.companyId, agent.folderId);

  // Compute fingerprint
  const fingerprint = await computeInstructionsFingerprint(agent, chain, {
    instructionsSupplementaryFiles: supplementaryFiles,
    instructionsOverrides: overrides,
  });

  // Check LRU cache
  const cacheKey = `fingerprint:${fingerprint}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    // Verify cache freshness by checking file mtimes
    const isFresh = await verifyCacheFreshness(agent, chain, cached);
    if (isFresh) {
      return {
        mergedInstructions: cached.mergedInstructions,
        mergedFilePath: mergedFilePathCache.get(fingerprint) ?? "",
        fingerprint,
        chain: cached.chain,
        fromCache: true,
        resolvedFolderId: agent.folderId,
        instructionsSupplementaryFiles: supplementaryFiles,
        instructionsOverrides: overrides ?? null,
        instructionsFilePath: mergedFilePathCache.get(fingerprint) ?? null,
      };
    }
  }

  // Cache miss (or stale) — regenerate
  const mergedInstructions = await buildMergedInstructions(agent, chain, {
    instructionsSupplementaryFiles: supplementaryFiles,
    instructionsOverrides: overrides,
  });
  const mergedFilePath = await generateMergedFile(agent, chain, mergedInstructions, fingerprint);

  // Compute chain metadata for the response
  const chainMetadata = await buildChainMetadata(agent, chain);

  // Cache the result
  const folderFileHashes: Record<string, string | null> = {};
  let latestFileMtime: string | null = null;
  for (const folder of chain) {
    const dir = folder.instructionsPath ?? resolveFolderInstructionsDir(agent.companyId, folder.id);
    const mtime = await getFileMtime(dir);
    const hash = await getInstructionFilesHash(dir);
    folderFileHashes[folder.id] = hash;
    if (mtime && (!latestFileMtime || mtime > latestFileMtime)) {
      latestFileMtime = mtime;
    }
  }

  const overrideHash = await computeAgentOverrideHash(agent.companyId, agent.id);
  const now = Date.now();
  cache.set(cacheKey, {
    fingerprint,
    companyId: agent.companyId,
    mergedInstructions,
    chain: chainMetadata,
    latestFileMtime,
    folderFileHashes,
    overrideHash,
    evictedAt: now,
  });
  mergedFilePathCache.set(fingerprint, mergedFilePath);

  return {
    mergedInstructions,
    mergedFilePath,
    fingerprint,
    chain: chainMetadata,
    fromCache: false,
    resolvedFolderId: agent.folderId,
    instructionsSupplementaryFiles: supplementaryFiles,
    instructionsOverrides: overrides ?? null,
    instructionsFilePath: mergedFilePath,
  };
}

/**
 * Build chain metadata for the API response.
 */
async function buildChainMetadata(
  agent: AgentLikeForInheritance,
  chain: InheritanceFolder[],
): Promise<InheritanceChainEntry[]> {
  const entries: InheritanceChainEntry[] = [];
  for (const folder of chain) {
    const dir = folder.instructionsPath ?? resolveFolderInstructionsDir(agent.companyId, folder.id);
    const entryContent = await readFolderEntry(dir);
    const fileMtime = await getFileMtime(dir);
    const contentHash = await getInstructionFilesHash(dir);
    entries.push({
      folderId: folder.id,
      folderName: folder.name,
      folderSlug: folder.slug,
      hasInstructions: entryContent !== null,
      fileMtime,
      contentHash,
    });
  }
  return entries;
}

/**
 * Verify that cached results are still fresh by checking file mtimes and content hashes.
 */
async function verifyCacheFreshness(
  agent: AgentLikeForInheritance,
  chain: InheritanceFolder[],
  cached: CacheEntry,
): Promise<boolean> {
  for (const folder of chain) {
    const dir = folder.instructionsPath ?? resolveFolderInstructionsDir(agent.companyId, folder.id);
    const mtime = await getFileMtime(dir);
    const hash = await getInstructionFilesHash(dir);

    // Check content hash changed
    if (hash !== cached.folderFileHashes[folder.id]) {
      return false;
    }

    // Check mtime changed
    if (mtime && cached.latestFileMtime && mtime > cached.latestFileMtime) {
      return false;
    }
  }

  // Also check agent override instructions hash has not changed
  const currentOverrideHash = await computeAgentOverrideHash(agent.companyId, agent.id);
  const cachedOverrideHash = cached.overrideHash;
  if (currentOverrideHash !== cachedOverrideHash) {
    return false;
  }

  return true;
}


/**
 * Write a pointer file recording that an agent is filed under a folder.
 *
 * For an agent with a folder-specific override (a non-null override content
 * passed in `options.overrideInstructions`), the pointer file contains the
 * agent-specific instructions so the inheritance resolver can layer them on
 * top of the folder-level bundle.
 *
 * For agents with no override, the pointer file is a tiny marker that the
 * agent inherits folder instructions verbatim (pure-DB pointer on the agent
 * row is the source of truth; this file is just a durable, inspectable record).
 *
 * Idempotent: repeated writes with unchanged content do not rewrite the file.
 */
export async function writeAgentFolderPointerFile(
  agent: AgentLikeForInheritance,
  folderId: string,
  options: { overrideInstructions?: string } = {},
): Promise<string> {
  const dir = resolveFolderInstructionsDir(agent.companyId, folderId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${agent.id}.md`);

  if (options.overrideInstructions && options.overrideInstructions.trim().length > 0) {
    const body = options.overrideInstructions.trim() + "\n";
    try {
      await fs.writeFile(filePath, body, "utf-8");
    } catch (err) {
      throw err;
    }
    // Agent override instructions changed — invalidate inheritance cache
    invalidateCompanyCache(agent.companyId);
    return filePath;
  }

  // Zero-override marker: the agent inherits folder instructions from the DB
  // pointer only. Write a small marker so the file tree is inspectable.
  const marker =
    `<!-- agent: ${agent.name} (${agent.id}) -->\n` +
    `<!-- This agent is filed under folder ${folderId} and has no local override; it inherits the folder-level shared instructions from AGENTS.md in this directory. -->\n` +
    `<!-- Override: remove this marker file and add agent-specific content to give this agent a local override. -->`;
  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    existing = null;
  }
  if (existing === marker) return filePath;
  await fs.writeFile(filePath, marker, "utf-8");
  // Pointer file written to folder instructions dir — invalidate inheritance cache
  invalidateCompanyCache(agent.companyId);
  return filePath;
}

/**
 * Remove an agent's pointer file (e.g. on unassign). Non-fatal if absent.
 */
export async function removeAgentFolderPointerFile(
  companyId: string,
  folderId: string,
  agentId: string,
): Promise<void> {
  const filePath = path.join(
    resolveFolderInstructionsDir(companyId, folderId),
    `${agentId}.md`,
  );
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  // Folder instruction file removed — invalidate inheritance cache for company
  invalidateCompanyCache(companyId);
}
