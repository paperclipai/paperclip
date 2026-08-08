import { describe, it, expect } from "vitest";

const COMPANY_ID = "87c32b8e-f131-4df8-ad8e-963d01b458e7";
const BACKEND_FOLDER_ID = "ce669ce4-a17a-46ad-a81c-eaeb8a7c1134";
const ENGINEERING_FOLDER_ID = "b50d4de3-a290-4aa5-be35-407e3a815082";
const API_URL = "http://127.0.0.1:3101/api";

describe("Folder instruction integration with live Paperclip API", () => {
  it("should resolve hierarchical folder instructions via Paperclip API", async () => {
    const { resolveFolderInstructions, clearFolderInstructionsCache } = await import(
      "./folder-instructions.js"
    );

    clearFolderInstructionsCache();

    // This test requires a running Paperclip server at localhost:3101
    const apiKey = process.env.PAPERCLIP_API_KEY;
    if (!apiKey) {
      expect.fail("PAPERCLIP_API_KEY is required for integration test");
    }

    const resolveFolder = async (id: string) => {
      const resp = await fetch(
        `${API_URL}/companies/${COMPANY_ID}/agent-folders/${id}`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
        },
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return {
        id: data.id,
        parentId: data.parentId ?? null,
        name: data.name ?? "",
        slug: data.slug ?? "",
        sortOrder: Number(data.sortOrder ?? 0),
      };
    };

    // Resolve instructions for the Backend folder (child of Engineering)
    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: BACKEND_FOLDER_ID,
      resolveFolder,
      agentInstructions: "",
    });

    // Should have a 2-level chain: Backend -> Engineering
    expect(result.chain.length).toBe(2);
    expect(result.chain[0].name).toBe("Backend");
    expect(result.chain[0].id).toBe(BACKEND_FOLDER_ID);
    expect(result.chain[1].name).toBe("Engineering");
    expect(result.chain[1].id).toBe(ENGINEERING_FOLDER_ID);

    // Should have merged instructions from both folders
    expect(result.mergedInstructions).toContain("Backend Engineering");
    expect(result.mergedInstructions).toContain("Engineering Team");

    // Folder instructions should come first (leaf-to-root precedence: child before parent)
    const backendIdx = result.mergedInstructions.indexOf("Backend Engineering");
    const engineeringIdx = result.mergedInstructions.indexOf("Engineering Team");
    expect(backendIdx).toBeLessThan(engineeringIdx);

    expect(result.fingerprint).toBeTruthy();
    expect(result.fingerprint).toHaveLength(32);
  });

  it("should handle agents without a folder (fail-open)", async () => {
    const { resolveFolderInstructions, clearFolderInstructionsCache } = await import(
      "./folder-instructions.js"
    );

    clearFolderInstructionsCache();

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: null,
      resolveFolder: async () => null,
      agentInstructions: "test instructions",
    });

    expect(result.mergedInstructions).toBe("");
    expect(result.chain.length).toBe(0);
    expect(result.fingerprint).toBeNull();
  });

  it("should fail open when API is unreachable", async () => {
    const { resolveFolderInstructions, clearFolderInstructionsCache } = await import(
      "./folder-instructions.js"
    );

    clearFolderInstructionsCache();

    const resolveFolder = async (id: string) => {
      // Simulate unreachable API
      return null;
    };

    const result = await resolveFolderInstructions({
      companyId: COMPANY_ID,
      folderId: BACKEND_FOLDER_ID,
      resolveFolder,
      agentInstructions: "",
    });

    // Should return empty results, not throw
    expect(result.mergedInstructions).toBe("");
    expect(result.chain.length).toBe(0);
  });
});
