import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// Set a fixed instance root for tests
const TEST_INSTANCE_ROOT = path.join(os.tmpdir(), "paperclip-folder-test-instance");

beforeEach(async () => {
  process.env.PAPERCLIP_INSTANCE_ROOT = TEST_INSTANCE_ROOT;
  // Clean up any previous state
  await fs.rm(TEST_INSTANCE_ROOT, { recursive: true, force: true });
  await fs.mkdir(TEST_INSTANCE_ROOT, { recursive: true });
  // Import after env is set
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(TEST_INSTANCE_ROOT, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// We need to import fresh modules each time to pick up the env var
async function loadModule() {
  const {
    resolveFolderInstructions,
    clearFolderInstructionsCache,
    checkFolderInstructionsFreshness,
  } = await import("./folder-instructions.js");
  return { resolveFolderInstructions, clearFolderInstructionsCache, checkFolderInstructionsFreshness };
}

const COMPANY_ID = "company-test-123";
const ROOT_FOLDER_ID = "folder-root-abc";
const CHILD_FOLDER_ID = "folder-child-def";
const GRANDCHILD_FOLDER_ID = "folder-grandchild-ghi";

function makeMockResolver(folders: Record<string, { id: string; parentId: string | null; name: string; slug: string; sortOrder: number }>) {
  return async (id: string) => {
    return folders[id] ?? null;
  };
}

async function createFolderInstructions(companyId: string, folderId: string, content: string) {
  const dir = path.resolve(TEST_INSTANCE_ROOT, "companies", companyId, "folders", folderId, "instructions");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "AGENTS.md"), content, "utf-8");
}

describe("resolveFolderInstructions", () => {
  it("returns empty result when folderId is null", async () => {
    const { resolveFolderInstructions } = await loadModule();
    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: null,
      resolveFolder: makeMockResolver({}),
    });
    expect(result.mergedInstructions).toBe("");
    expect(result.chain).toEqual([]);
    expect(result.fingerprint).toBeNull();
  });

  it("reads single folder instructions", async () => {
    const { resolveFolderInstructions } = await loadModule();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "Root folder instructions for all agents.");

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
      }),
    });

    expect(result.mergedInstructions).toContain("Root folder instructions for all agents.");
    expect(result.chain).toHaveLength(1);
    expect(result.chain[0].id).toBe(ROOT_FOLDER_ID);
    expect(result.fingerprint).not.toBeNull();
  });

  it("walks the folder chain from leaf to root (deepest first)", async () => {
    const { resolveFolderInstructions } = await loadModule();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "ROOT: Base instructions");
    await createFolderInstructions(COMPANY_ID, CHILD_FOLDER_ID, "CHILD: Team-specific instructions");
    await createFolderInstructions(COMPANY_ID, GRANDCHILD_FOLDER_ID, "GRANDCHILD: Role-specific instructions");

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: GRANDCHILD_FOLDER_ID,
      resolveFolder: makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
        [CHILD_FOLDER_ID]: { id: CHILD_FOLDER_ID, parentId: ROOT_FOLDER_ID, name: "Child", slug: "child", sortOrder: 0 },
        [GRANDCHILD_FOLDER_ID]: { id: GRANDCHILD_FOLDER_ID, parentId: CHILD_FOLDER_ID, name: "Grandchild", slug: "grandchild", sortOrder: 0 },
      }),
    });

    // Chain should be leaf-to-root: grandchild → child → root
    expect(result.chain).toHaveLength(3);
    expect(result.chain[0].id).toBe(GRANDCHILD_FOLDER_ID);
    expect(result.chain[1].id).toBe(CHILD_FOLDER_ID);
    expect(result.chain[2].id).toBe(ROOT_FOLDER_ID);

    // Instructions should be merged in leaf-to-root order
    expect(result.mergedInstructions).toContain("GRANDCHILD: Role-specific instructions");
    expect(result.mergedInstructions).toContain("CHILD: Team-specific instructions");
    expect(result.mergedInstructions).toContain("ROOT: Base instructions");

    // Grandchild should appear before Child, which should appear before Root
    const grandchildIdx = result.mergedInstructions.indexOf("GRANDCHILD");
    const childIdx = result.mergedInstructions.indexOf("CHILD");
    const rootIdx = result.mergedInstructions.indexOf("ROOT");
    expect(grandchildIdx).toBeLessThan(childIdx);
    expect(childIdx).toBeLessThan(rootIdx);
  });

  it("skips folders with no instructions directory", async () => {
    const { resolveFolderInstructions } = await loadModule();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "ROOT: Base instructions");
    // CHILD_FOLDER_ID has no instructions directory — only create the folder structure for ROOT

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: CHILD_FOLDER_ID,
      resolveFolder: makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
        [CHILD_FOLDER_ID]: { id: CHILD_FOLDER_ID, parentId: ROOT_FOLDER_ID, name: "Child", slug: "child", sortOrder: 0 },
      }),
    });

    // Should still walk the chain and include root instructions
    expect(result.chain).toHaveLength(2);
    expect(result.mergedInstructions).toContain("ROOT: Base instructions");
  });

  it("detects hierarchy cycles", async () => {
    const { resolveFolderInstructions } = await loadModule();
    // folderA → folderB → folderA (cycle)
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "A instructions");

    await expect(
      resolveFolderInstructions({
        companyId: COMPANY_ID,
        folderId: ROOT_FOLDER_ID,
        resolveFolder: makeMockResolver({
          [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: CHILD_FOLDER_ID, name: "A", slug: "a", sortOrder: 0 },
          [CHILD_FOLDER_ID]: { id: CHILD_FOLDER_ID, parentId: ROOT_FOLDER_ID, name: "B", slug: "b", sortOrder: 0 },
        }),
      }),
    ).rejects.toThrow("Folder hierarchy cycle detected");
  });

  it("caches results with fingerprint-based invalidation", async () => {
    const { resolveFolderInstructions, clearFolderInstructionsCache } = await loadModule();
    clearFolderInstructionsCache();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "Original content");

    const resolver = makeMockResolver({
      [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
    });

    // First call
    const result1 = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: resolver,
    });
    expect(result1.mergedInstructions).toContain("Original content");

    // Second call should use cache
    const result2 = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: resolver,
    });
    expect(result2.mergedInstructions).toBe(result1.mergedInstructions);
    expect(result2.fingerprint).toBe(result1.fingerprint);

    // Modify the file content and wait to ensure mtime changes
    const dir = path.resolve(TEST_INSTANCE_ROOT, "companies", COMPANY_ID, "folders", ROOT_FOLDER_ID, "instructions");
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Updated content", "utf-8");
    // Invalidate cache to force re-read
    clearFolderInstructionsCache();

    // Third call should detect staleness and re-read
    const result3 = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: resolver,
    });
    expect(result3.mergedInstructions).toContain("Updated content");
    expect(result3.mergedInstructions).not.toContain("Original content");
  });

  it("includes file path suffix in instructions", async () => {
    const { resolveFolderInstructions } = await loadModule();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "Some instructions");

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
      }),
    });

    expect(result.mergedInstructions).toContain("loaded from");
    expect(result.mergedInstructions).toContain("companies");
    expect(result.mergedInstructions).toContain(COMPANY_ID);
    expect(result.mergedInstructions).toContain(ROOT_FOLDER_ID);
  });

  it("handles empty instruction files", async () => {
    const { resolveFolderInstructions } = await loadModule();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "   \n\n  ");

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
      }),
    });

    expect(result.mergedInstructions).toBe("");
    expect(result.chain).toHaveLength(1);
  });

  it("handles missing instructions entry file gracefully", async () => {
    const { resolveFolderInstructions } = await loadModule();
    // Create the instructions directory but no entry file
    const dir = path.resolve(TEST_INSTANCE_ROOT, "companies", COMPANY_ID, "folders", ROOT_FOLDER_ID, "instructions");
    await fs.mkdir(dir, { recursive: true });

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
      }),
    });

    expect(result.mergedInstructions).toBe("");
    expect(result.chain).toHaveLength(1);
  });
});

describe("checkFolderInstructionsFreshness", () => {
  it("returns stale=true when no cache entry exists", async () => {
    const { checkFolderInstructionsFreshness, clearFolderInstructionsCache } = await loadModule();
    clearFolderInstructionsCache();

    const result = await checkFolderInstructionsFreshness(
      COMPANY_ID,
      ROOT_FOLDER_ID,
      makeMockResolver({
        [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
      }),
    );
    expect(result.stale).toBe(true);
    expect(result.fingerprint).toBeNull();
  });

  it("returns stale=false after caching when files unchanged", async () => {
    const { resolveFolderInstructions, checkFolderInstructionsFreshness, clearFolderInstructionsCache } = await loadModule();
    clearFolderInstructionsCache();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "Original");

    const resolver = makeMockResolver({
      [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
    });

    // Cache it
    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: resolver,
    });

    // Check freshness
    const freshness = await checkFolderInstructionsFreshness(COMPANY_ID, ROOT_FOLDER_ID, resolver);
    expect(freshness.stale).toBe(false);
    expect(freshness.fingerprint).toBe(result.fingerprint);
  });

  it("returns stale=true when file is modified after caching", async () => {
    const { resolveFolderInstructions, checkFolderInstructionsFreshness, clearFolderInstructionsCache } = await loadModule();
    clearFolderInstructionsCache();
    await createFolderInstructions(COMPANY_ID, ROOT_FOLDER_ID, "Original");

    const resolver = makeMockResolver({
      [ROOT_FOLDER_ID]: { id: ROOT_FOLDER_ID, parentId: null, name: "Root", slug: "root", sortOrder: 0 },
    });

    // Cache it
    await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: ROOT_FOLDER_ID,
      resolveFolder: resolver,
    });

    // Modify the file
    const dir = path.resolve(TEST_INSTANCE_ROOT, "companies", COMPANY_ID, "folders", ROOT_FOLDER_ID, "instructions");
    await fs.writeFile(path.join(dir, "AGENTS.md"), "Updated", "utf-8");

    // Check freshness — should be stale
    const freshness = await checkFolderInstructionsFreshness(COMPANY_ID, ROOT_FOLDER_ID, resolver);
    expect(freshness.stale).toBe(true);
  });
});
