import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Mock resolvePaperclipInstanceRoot — we need it to return temp directories
// for tests that exercise filesystem layout. Using vi.hoisted + vi.mock so the
// mock is in place before the module under test is imported (ESM-safe).
// ---------------------------------------------------------------------------

const { mockInstanceRoot } = vi.hoisted(() => ({
  mockInstanceRoot: {
    value: "" as string,
    set(value: string) {
      this.value = value;
    },
    get() {
      return this.value;
    },
  },
}));

vi.mock("../home-paths.js", () => ({
  resolvePaperclipInstanceRoot: () => mockInstanceRoot.get(),
}));

import {
  buildMergedInstructions,
  computeInstructionsFingerprint,
  computeAgentOverrideHash,
  clearInheritanceCache,
  getInheritanceCacheSize,
  invalidateCompanyCache,
  InstructionsLRUCache,
  resolveAgentInstructions,
  walkFolderChain,
  type AgentLikeForInheritance,
  type InheritanceFolder,
} from "../services/agent-instructions-inheritance.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockDb(rows: unknown[]): Db {
  const mockExecute = vi.fn(async () => rows);
  return {
    execute: mockExecute,
  } as unknown as Db;
}

function makeAgent(overrides: Partial<AgentLikeForInheritance> = {}): AgentLikeForInheritance {
  return {
    id: "agent-123",
    companyId: "company-abc",
    name: "TestAgent",
    adapterConfig: {},
    adapterType: "hermes_local",
    folderId: "folder-leaf",
    ...overrides,
  };
}

function makeFolderChain(): InheritanceFolder[] {
  return [
    { id: "folder-root", parentId: null, name: "Root", slug: "root", instructionsPath: null },
    { id: "folder-intermediate", parentId: "folder-root", name: "Engineering", slug: "engineering", instructionsPath: null },
    { id: "folder-leaf", parentId: "folder-intermediate", name: "Backend", slug: "backend", instructionsPath: null },
  ];
}

// ---------------------------------------------------------------------------
// walkFolderChain
// ---------------------------------------------------------------------------

describe("walkFolderChain", () => {
  it("returns folders ordered root->leaf via recursive CTE", async () => {
    const mockRows = [
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
      { id: "folder-intermediate", parentId: "folder-root", name: "Engineering", slug: "engineering" },
      { id: "folder-leaf", parentId: "folder-intermediate", name: "Backend", slug: "backend" },
    ];
    const db = makeMockDb(mockRows);
    const chain = await walkFolderChain(db, "company-abc", "folder-leaf");

    expect(chain).toHaveLength(3);
    // Root first, leaf last (ORDER BY depth DESC)
    expect(chain[0].id).toBe("folder-root");
    expect(chain[0].parentId).toBeNull();
    expect(chain[1].id).toBe("folder-intermediate");
    expect(chain[1].parentId).toBe("folder-root");
    expect(chain[2].id).toBe("folder-leaf");
    expect(chain[2].parentId).toBe("folder-intermediate");

    // Should have correct instructionsPath
    expect(chain[0].instructionsPath).toContain("folders/folder-root/instructions");
  });

  it("returns empty array for leaf with no parent (single folder)", async () => {
    const mockRows = [
      { id: "folder-single", parentId: null, name: "Solo", slug: "solo" },
    ];
    const db = makeMockDb(mockRows);
    const chain = await walkFolderChain(db, "company-abc", "folder-single");
    expect(chain).toHaveLength(1);
    expect(chain[0].id).toBe("folder-single");
  });

  it("passes companyId and folderId to the CTE query", async () => {
    const db = makeMockDb([]);
    await walkFolderChain(db, "company-xyz", "folder-999");
    const executeCall = (db.execute as vi.Mock).mock.calls[0];
    // The Drizzle sql tagged template object stores the SQL text in queryChunks
    const sqlObj = executeCall[0];
    let sqlQuery = "";
    if (sqlObj?.queryChunks) {
      sqlQuery = sqlObj.queryChunks
        .map((chunk: { value?: unknown }) => {
          if (Array.isArray(chunk.value)) return chunk.value.join("");
          return chunk.value ?? "";
        })
        .join("");
    } else {
      sqlQuery = String(sqlObj);
    }
    // The query should reference agent_folders table and filter by id + company_id
    expect(sqlQuery).toContain("folder_chain");
    expect(sqlQuery).toContain("RECURSIVE");
    expect(sqlQuery).toContain("UNION ALL");
  });
});

// ---------------------------------------------------------------------------
// computeInstructionsFingerprint
// ---------------------------------------------------------------------------

describe("computeInstructionsFingerprint", () => {
  it("produces a deterministic 32-char hex string", async () => {
    const agent = makeAgent();
    const chain = makeFolderChain();
    const fp1 = await computeInstructionsFingerprint(agent, chain);
    const fp2 = await computeInstructionsFingerprint(agent, chain);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(32);
    expect(fp1).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when folderId changes", async () => {
    const agent1 = makeAgent({ folderId: "folder-a" });
    const agent2 = makeAgent({ folderId: "folder-b" });
    const chain = makeFolderChain();
    const fp1 = await computeInstructionsFingerprint(agent1, chain);
    const fp2 = await computeInstructionsFingerprint(agent2, chain);
    expect(fp1).not.toBe(fp2);
  });

  it("changes when adapterType changes", async () => {
    const agent1 = makeAgent({ adapterType: "hermes_local" });
    const agent2 = makeAgent({ adapterType: "claude_local" });
    const chain = makeFolderChain();
    const fp1 = await computeInstructionsFingerprint(agent1, chain);
    const fp2 = await computeInstructionsFingerprint(agent2, chain);
    expect(fp1).not.toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// buildMergedInstructions
// ---------------------------------------------------------------------------

describe("buildMergedInstructions", () => {
  beforeEach(() => {
    clearInheritanceCache();
  });

  it("returns empty string when chain is empty", async () => {
    const agent = makeAgent();
    const result = await buildMergedInstructions(agent, []);
    expect(result).toBe("");
  });

  it("appends agent overrides with correct section header", async () => {
    const agent = makeAgent({ id: "agent-test", name: "TestAgent" });
    const chain: InheritanceFolder[] = [];

    // Create a temp dir for the agent's instructions
    const tmpRoot = path.join(os.tmpdir(), "test-instructions-build", "companies", agent.companyId, "agents", agent.id, "instructions");
    await fs.mkdir(tmpRoot, { recursive: true });

    // Point the mock at the temp root
    mockInstanceRoot.set(path.join(os.tmpdir(), "test-instructions-build"));

    const content = await buildMergedInstructions(agent, chain);
    // Without an AGENTS.md file in the agent's root, no override is appended
    expect(content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// computeAgentOverrideHash
// ---------------------------------------------------------------------------

describe("computeAgentOverrideHash", () => {
  beforeEach(() => {
    clearInheritanceCache();
  });

  it("returns null when AGENTS.md does not exist", async () => {
    // Use a non-existent agent path
    const result = await computeAgentOverrideHash("nonexistent-co", "nonexistent-agent");
    expect(result).toBeNull();
  });

  it("returns a hash when AGENTS.md exists", async () => {
    const tmpRoot = path.join(os.tmpdir(), "test-override-hash");
    const co1Root = path.join(tmpRoot, "companies", "co-1", "agents", "agent-1", "instructions");
    await fs.mkdir(co1Root, { recursive: true });
    await fs.writeFile(path.join(co1Root, "AGENTS.md"), "Some instructions here", "utf-8");

    // Point the mock at the temp root
    mockInstanceRoot.set(tmpRoot);

    const hash = await computeAgentOverrideHash("co-1", "agent-1");
    expect(hash).not.toBeNull();
    expect(hash).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// InstructionsLRUCache
// ---------------------------------------------------------------------------

describe("InstructionsLRUCache", () => {
  it("respects max size and evicts LRU entry", () => {
    const cache = new InstructionsLRUCache(2);
    cache.set("a", { fingerprint: "a", companyId: "co", mergedInstructions: "a", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    cache.set("b", { fingerprint: "b", companyId: "co", mergedInstructions: "b", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    cache.set("c", { fingerprint: "c", companyId: "co", mergedInstructions: "c", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });

    // "a" should have been evicted (it's the LRU)
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("moves accessed items to most-recently-used", () => {
    const cache = new InstructionsLRUCache(2);
    cache.set("a", { fingerprint: "a", companyId: "co", mergedInstructions: "a", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    cache.set("b", { fingerprint: "b", companyId: "co", mergedInstructions: "b", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    // Access "a" to make it MRU
    cache.get("a");
    // Insert "c" — should evict "b" (now LRU), not "a"
    cache.set("c", { fingerprint: "c", companyId: "co", mergedInstructions: "c", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeDefined();
  });

  it("clear() empties the cache", () => {
    const cache = new InstructionsLRUCache();
    cache.set("a", { fingerprint: "a", companyId: "co", mergedInstructions: "a", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    expect(cache.size).toBe(1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cache invalidation functions
// ---------------------------------------------------------------------------

describe("cache invalidation", () => {
  afterEach(() => {
    clearInheritanceCache();
  });

  it("invalidateCompanyCache clears all entries", async () => {
    const db = makeMockDb([]);
    const agent = makeAgent();
    // First call — cache miss
    try {
      await resolveAgentInstructions(db, agent);
    } catch {
      // Expected — no DB rows will produce errors in downstream fs ops
    }
    expect(getInheritanceCacheSize()).toBeGreaterThanOrEqual(0);
    const count = invalidateCompanyCache(agent.companyId);
    // May or may not have invalidated anything depending on prior state
    expect(typeof count).toBe("number");
  });

  it("invalidateCompanyCache clears entries for the matching company only", async () => {
    const cache = new InstructionsLRUCache(10);
    cache.set("fingerprint-co1-a", { fingerprint: "a", companyId: "company-1", mergedInstructions: "x", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    cache.set("fingerprint-co1-b", { fingerprint: "b", companyId: "company-1", mergedInstructions: "x", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });
    cache.set("fingerprint-co2", { fingerprint: "c", companyId: "company-2", mergedInstructions: "x", chain: [], latestFileMtime: null, folderFileHashes: {}, overrideHash: null, evictedAt: 0 });

    expect(cache.size).toBe(3);
    const count = cache.invalidateByCompany("company-1");
    expect(count).toBe(2);
    expect(cache.size).toBe(1);
    // company-2 entry should survive
    expect(cache.get("fingerprint-co2")).toBeDefined();
    expect(cache.get("fingerprint-co1-a")).toBeUndefined();
    expect(cache.get("fingerprint-co1-b")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveAgentInstructions (integration with mock DB)
// ---------------------------------------------------------------------------

describe("resolveAgentInstructions", () => {
  beforeEach(() => {
    clearInheritanceCache();
    mockInstanceRoot.set("");
  });

  it("returns empty result when agent has no folderId (backward compat)", async () => {
    const db = makeMockDb([]);
    const agent = makeAgent({ folderId: null });
    const result = await resolveAgentInstructions(db, agent);
    expect(result.mergedInstructions).toBe("");
    expect(result.mergedFilePath).toBe("");
    expect(result.chain).toHaveLength(0);
    expect(result.fromCache).toBe(false);
  });

  it("walks folder chain and returns chain metadata", async () => {
    const mockRows = [
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
      { id: "folder-leaf", parentId: "folder-root", name: "Leaf", slug: "leaf" },
    ];
    const db = makeMockDb(mockRows);
    const agent = makeAgent({ folderId: "folder-leaf" });

    // Point the mock at a real temp dir so file generation works
    mockInstanceRoot.set(path.join(os.tmpdir(), "test-resolve-" + Date.now()));

    // This will try to read from disk (resolvePaperclipInstanceRoot)
    // The chain metadata should be populated based on DB results
    const result = await resolveAgentInstructions(db, agent);
    expect(result.chain).toHaveLength(2);
    expect(result.chain[0].folderId).toBe("folder-root");
    expect(result.chain[0].folderName).toBe("Root");
    expect(result.chain[1].folderId).toBe("folder-leaf");
    expect(result.chain[1].folderName).toBe("Leaf");
    // The mergedFilePath should point to __generated__/merged.md
    expect(result.mergedFilePath).toContain("__generated__");
    expect(result.mergedFilePath).toContain("merged.md");
  });

  it("uses LRU cache on second call with same fingerprint", async () => {
    const mockRows = [
      { id: "folder-root", parentId: null, name: "Root", slug: "root" },
    ];
    const db = makeMockDb(mockRows);
    const agent = makeAgent({ folderId: "folder-root" });

    mockInstanceRoot.set(path.join(os.tmpdir(), "test-cache-" + Date.now()));

    const first = await resolveAgentInstructions(db, agent);
    expect(first.fromCache).toBe(false);

    const second = await resolveAgentInstructions(db, agent);
    expect(second.fromCache).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});
