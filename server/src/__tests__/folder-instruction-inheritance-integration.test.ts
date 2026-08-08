/**
 * Phase 4 Integration Tests — Instruction Inheritance Engine (JAC-4755)
 *
 * These tests exercise the instruction inheritance resolution engine end-to-end
 * with a real embedded Postgres database and a real on-disk instructions layout
 * (instance root redirected to a temp directory via a hoisted mock).
 *
 * They close coverage gaps identified against the JAC-4755 acceptance checklist:
 *
 * - Instruction inheritance: single folder, multi-level chain, agent overrides
 * - Cache invalidation: folder edit → descendant cache cleared; company-scoped
 *   invalidation evicts the right entries
 * - Adapter-specific files: HERMES.md loaded for hermes_local, CLAUDE.md for
 *   claude_local; adapter mismatch excludes the wrong supplementary file
 * - Inline instructionsOverrides precedence (folder → agent file → inline)
 * - Backward compat: agent without folder_id yields flat (empty) bundle
 *
 * The mock-based unit tests in agent-instructions-inheritance.test.ts cover
 * walkFolderChain + computeInstructionsFingerprint + LRU mechanics with a fake DB.
 * These tests cover the *content* merging path (buildMergedInstructions +
 * resolveAgentInstructions) with real Postgres chains and real filesystem writes.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agentFolders,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentFolderService } from "../services/agent-folders.js";

// Hoist a mutable instance-root mock so resolvePaperclipInstanceRoot (imported by
// the inheritance service) resolves into a per-test temp directory. The mock must
// be hoisted above the imports of the modules under test (ESM-safe pattern).
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
  clearInheritanceCache,
  computeInstructionsFingerprint,
  getInheritanceCacheSize,
  invalidateCompanyCache,
  resolveAgentInstructions,
  resolveAgentInstructionsRoot,
  resolveFolderInstructionsDir,
  type AgentLikeForInheritance,
  type InheritanceFolder,
} from "../services/agent-instructions-inheritance.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping folder instruction-inheritance integration tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("folder instruction inheritance (integration)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let svc!: ReturnType<typeof agentFolderService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-folder-inherit-");
    db = createDb(tempDb.connectionString);
    svc = agentFolderService(db);
  }, 20_000);

  beforeEach(async () => {
    // Redirect the disk-backed instructions layout into a temp dir per test.
    mockInstanceRoot.set(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-inherit-")));
    clearInheritanceCache();

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Company",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  });

  afterEach(async () => {
    await db.delete(agentFolders).where(eq(agentFolders.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    await fs.rm(mockInstanceRoot.get(), { recursive: true, force: true }).catch(() => undefined);
    clearInheritanceCache();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── Helpers ──────────────────────────────────────────────

  async function createFolder(name: string, parentId: string | null = null) {
    return svc.create(companyId, { name, parentId });
  }

  async function createAgent(
    name: string,
    folderId: string | null = null,
  ) {
    const [agent] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        name,
        role: "general",
        adapterType: "process",
        folderId,
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning();
    return agent!;
  }

  /** Write AGENTS.md (and optional supplementary files) for a folder. */
  async function writeFolderInstructions(
    folderId: string,
    agenTsContent: string,
    supplementary?: Record<string, string>,
  ) {
    const dir = resolveFolderInstructionsDir(companyId, folderId);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "AGENTS.md"), agenTsContent, "utf-8");
    if (supplementary) {
      for (const [name, content] of Object.entries(supplementary)) {
        await fs.writeFile(path.join(dir, name), content, "utf-8");
      }
    }
  }

  function makeAgentLike(
    agent: { id: string; name: string; companyId: string; folderId: string | null },
    adapterType = "hermes_local",
  ): AgentLikeForInheritance {
    return {
      id: agent.id,
      companyId: agent.companyId,
      name: agent.name,
      adapterConfig: {},
      adapterType,
      folderId: agent.folderId,
    };
  }

  // ── Single-folder inheritance ───────────────────────────

  describe("single-folder inheritance", () => {
    it("resolves a folder's AGENTS.md for an agent in that folder", async () => {
      const folder = await createFolder("Solo");
      const agent = await createAgent("Solo Agent", folder.id);
      await writeFolderInstructions(folder.id, "# Solo team instructions\n\nDo the thing.");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      expect(result.mergedInstructions).toContain("# Solo team instructions");
      expect(result.mergedInstructions).toContain("Do the thing.");
      expect(result.mergedInstructions).toContain("# [Folder: Solo]");
      expect(result.chain).toHaveLength(1);
      expect(result.chain[0].folderId).toBe(folder.id);
      expect(result.resolvedFolderId).toBe(folder.id);
      expect(result.fromCache).toBe(false);
    });

    it("generates the merged file under the agent's __generated__ dir", async () => {
      const folder = await createFolder("Solo");
      const agent = await createAgent("Solo Agent", folder.id);
      await writeFolderInstructions(folder.id, "# Instructions");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      expect(result.mergedFilePath).toBeTruthy();
      expect(path.basename(result.mergedFilePath!)).toBe("merged.md");
      const generatedContent = await fs.readFile(result.mergedFilePath!, "utf-8");
      expect(generatedContent).toContain("AUTO-GENERATED");
      expect(generatedContent).toContain("# Instructions");
    });
  });

  // ── Multi-level inheritance chain ───────────────────────

  describe("multi-level inheritance chain", () => {
    it("merges root -> intermediate -> leaf instructions in order", async () => {
      const root = await createFolder("Root");
      const inter = await createFolder("Intermediate", root.id);
      const leaf = await createFolder("Leaf", inter.id);
      const agent = await createAgent("Chain Agent", leaf.id);

      await writeFolderInstructions(root.id, "# Root AGENTS\n\nroot rule");
      await writeFolderInstructions(inter.id, "# Inter AGENTS\n\ninter rule");
      await writeFolderInstructions(leaf.id, "# Leaf AGENTS\n\nleaf rule");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      // Sections must appear in root -> intermediate -> leaf order
      expect(result.mergedInstructions).toMatch(
        /# \[Folder: Root\][\s\S]*root rule[\s\S]*# \[Folder: Intermediate\][\s\S]*inter rule[\s\S]*# \[Folder: Leaf\][\s\S]*leaf rule/,
      );
      expect(result.chain).toHaveLength(3);
      expect(result.chain.map((c) => c.folderName)).toEqual(["Root", "Intermediate", "Leaf"]);
      expect(result.fingerprint).toHaveLength(32);
    });

    it("sections are joined with --- separators", async () => {
      const root = await createFolder("Root");
      const leaf = await createFolder("Leaf", root.id);
      const agent = await createAgent("Agent", leaf.id);

      await writeFolderInstructions(root.id, "root body");
      await writeFolderInstructions(leaf.id, "leaf body");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      expect(result.mergedInstructions).toContain("root body");
      expect(result.mergedInstructions).toContain("leaf body");
      expect(result.mergedInstructions).toContain("\n\n---\n\n");
    });

    it("omits folders with no AGENTS.md from the merged output but keeps them in the chain", async () => {
      const root = await createFolder("Root");
      const leaf = await createFolder("Leaf", root.id);
      const agent = await createAgent("Agent", leaf.id);

      // Root has no instructions file; leaf does
      await writeFolderInstructions(leaf.id, "# Leaf only\n\nonly the leaf");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      expect(result.chain).toHaveLength(2);
      expect(result.chain[0].folderName).toBe("Root");
      expect(result.chain[0].hasInstructions).toBe(false);
      expect(result.chain[1].folderName).toBe("Leaf");
      expect(result.chain[1].hasInstructions).toBe(true);
      expect(result.mergedInstructions).toContain("only the leaf");
      expect(result.mergedInstructions).not.toContain("Root");
    });
  });

  // ── Agent overrides precedence ──────────────────────────

  describe("agent overrides", () => {
    it("appends agent-specific AGENTS.md override last (highest precedence in folder chain)", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("Override Agent", folder.id);
      await writeFolderInstructions(folder.id, "# Folder AGENTS\n\nfolder rule");

      // Write the agent's own override AGENTS.md under its instructions root
      const agentDir = resolveAgentInstructionsRoot(companyId, agent.id);
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "AGENTS.md"),
        "# My personal rule\n\nbe specific",
        "utf-8",
      );

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      expect(result.mergedInstructions).toContain("# [Folder: Team]");
      expect(result.mergedInstructions).toContain("# [Agent: Override Agent]");
      expect(result.mergedInstructions).toContain("be specific");
      // Agent override section appears after the folder section
      expect(result.mergedInstructions!.indexOf("# [Agent:")).toBeGreaterThan(
        result.mergedInstructions!.indexOf("# [Folder: Team]"),
      );
    });

    it("returns empty merged content when agent has no instructions and no folder AGENTS.md", async () => {
      const folder = await createFolder("Empty");
      const agent = await createAgent("Bare Agent", folder.id);
      // No instructions written anywhere

      const result = await resolveAgentInstructions(db, makeAgentLike(agent));

      expect(result.mergedInstructions).toBe("");
      // But the chain is still resolved
      expect(result.chain).toHaveLength(1);
      expect(result.chain[0].folderId).toBe(folder.id);
    });
  });

  // ── Inline instructionsOverrides precedence ────────────

  describe("inline instructionsOverrides", () => {
    it("appends inline overrides after folder content with the (override) header", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("Override Agent", folder.id);
      await writeFolderInstructions(folder.id, "# Folder\n\nfolder rule");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent), {
        instructionsOverrides: "# Inline override\n\ninline rule",
      });

      const folderIdx = result.mergedInstructions!.indexOf("# [Folder: Team]");
      const overrideIdx = result.mergedInstructions!.indexOf(
        "# [Agent: Override Agent (override)]",
      );
      expect(folderIdx).toBeGreaterThanOrEqual(0);
      expect(overrideIdx).toBeGreaterThan(folderIdx);
      expect(result.mergedInstructions).toContain("inline rule");
      expect(result.mergedInstructions).toContain("folder rule");
    });
  });

  // ── Adapter-specific supplementary files ───────────────

  describe("adapter-specific supplementary files", () => {
    it("loads HERMES.md for hermes_local adapters", async () => {
      const root = await createFolder("Root");
      const leaf = await createFolder("Leaf", root.id);
      const agent = await createAgent("Hermes Agent", leaf.id);

      await writeFolderInstructions(
        root.id,
        "# Root AGENTS\n\nroot",
        {"HERMES.md": "# Root HERMES\n\nhermes-only" },
      );
      await writeFolderInstructions(leaf.id, "# Leaf AGENTS\n\nleaf");

      const result = await resolveAgentInstructions(db, makeAgentLike(agent, "hermes_local"));

      expect(result.mergedInstructions).toContain("# Root HERMES");
      expect(result.mergedInstructions).toContain("hermes-only");
      // HERMES.md section appears within the root folder section, before leaf
      expect(
        result.mergedInstructions!.indexOf("# Root HERMES"),
      ).toBeGreaterThan(result.mergedInstructions!.indexOf("# [Folder: Root]"));
      expect(
        result.mergedInstructions!.indexOf("# Root HERMES"),
      ).toBeLessThan(result.mergedInstructions!.indexOf("# [Folder: Leaf]"));
    });

    it("loads CLAUDE.md for claude_local adapters", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("Claude Agent", folder.id);

      await writeFolderInstructions(
        folder.id,
        "# AGENTS\n\nag",
        {"CLAUDE.md": "# Claude notes\n\nclaude-specific" },
      );

      const result = await resolveAgentInstructions(db, makeAgentLike(agent, "claude_local"));

      expect(result.mergedInstructions).toContain("# Claude notes");
      expect(result.mergedInstructions).toContain("claude-specific");
    });

    it("does not load CLAUDE.md for hermes_local adapters", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("Hermes Agent", folder.id);

      // Only CLAUDE.md exists; hermes_local should ignore it
      await writeFolderInstructions(
        folder.id,
        "# AGENTS\n\nag",
        {"CLAUDE.md": "# Claude only\n\nx" },
      );

      const result = await resolveAgentInstructions(db, makeAgentLike(agent, "hermes_local"));

      expect(result.mergedInstructions).not.toContain("Claude only");
      // AGENTS.md still loads
      expect(result.mergedInstructions).toContain("# AGENTS");
    });
  });

  // ── Backward compatibility ──────────────────────────────

  describe("backward compatibility", () => {
    it("agent with no folder_id yields empty merged bundle (flat)", async () => {
      const agent = await createAgent("Flat Agent", null);

      const result = await resolveAgentInstructions(db, makeAgentLike(agent, "hermes_local"));

      expect(result.mergedInstructions).toBe("");
      expect(result.mergedFilePath).toBe("");
      expect(result.chain).toHaveLength(0);
      expect(result.resolvedFolderId).toBeNull();
      expect(result.instructionsFilePath).toBeNull();
      expect(result.fromCache).toBe(false);
    });
  });

  // ── Cache invalidation ──────────────────────────────────

  describe("cache invalidation", () => {
    it("folder AGENTS.md edit clears descendant cache and forces re-resolve", async () => {
      const root = await createFolder("Root");
      const agent = await createAgent("Cached Agent", root.id);
      await writeFolderInstructions(root.id, "# v1\n\noriginal");

      const first = await resolveAgentInstructions(db, makeAgentLike(agent));
      expect(first.fromCache).toBe(false);
      expect(getInheritanceCacheSize()).toBe(1);

      // Second call should hit the LRU cache
      const second = await resolveAgentInstructions(db, makeAgentLike(agent));
      expect(second.fromCache).toBe(true);
      expect(second.fingerprint).toBe(first.fingerprint);

      // Edit the folder's AGENTS.md — the content hash changes, so the
      // fingerprint changes. resolveAgentInstructions recomputes the fingerprint,
      // finds no cache entry, and regenerates.
      await writeFolderInstructions(root.id, "# v2\n\nupdated");

      const third = await resolveAgentInstructions(db, makeAgentLike(agent));
      expect(third.fromCache).toBe(false);
      expect(third.mergedInstructions).toContain("updated");
      expect(third.fingerprint).not.toBe(first.fingerprint);
    });

    it("invalidateCompanyCache clears entries belonging to the company", async () => {
      const folder = await createFolder("Team");
      const a1 = await createAgent("A1", folder.id);
      const a2 = await createAgent("A2", folder.id);

      // Distinct override files so the two agents get distinct fingerprints.
      await writeFolderInstructions(folder.id, "# Shared\n\nbase");
      const dir1 = resolveAgentInstructionsRoot(companyId, a1.id);
      const dir2 = resolveAgentInstructionsRoot(companyId, a2.id);
      await fs.mkdir(dir1, { recursive: true });
      await fs.mkdir(dir2, { recursive: true });
      await fs.writeFile(path.join(dir1, "AGENTS.md"), "# A1 override", "utf-8");
      await fs.writeFile(path.join(dir2, "AGENTS.md"), "# A2 override", "utf-8");

      await resolveAgentInstructions(db, makeAgentLike(a1));
      await resolveAgentInstructions(db, makeAgentLike(a2));

      expect(getInheritanceCacheSize()).toBe(2);
      const cleared = invalidateCompanyCache(companyId);
      expect(cleared).toBe(2);
      expect(getInheritanceCacheSize()).toBe(0);
    });

    it("fingerprint is deterministic for identical inputs", async () => {
      const folder = await createFolder("Team");
      await writeFolderInstructions(folder.id, "# Stable\n\ncontent");

      const chain: InheritanceFolder[] = [
        {
          id: folder.id,
          parentId: null,
          name: "Team",
          slug: "team",
          instructionsPath: resolveFolderInstructionsDir(companyId, folder.id),
        },
      ];
      const agentLike: AgentLikeForInheritance = {
        id: "agent-x",
        companyId,
        name: "Agent X",
        adapterConfig: {},
        adapterType: "hermes_local",
        folderId: folder.id,
      };

      const fp1 = await computeInstructionsFingerprint(agentLike, chain);
      const fp2 = await computeInstructionsFingerprint(agentLike, chain);
      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  // ── buildMergedInstructions direct unit ─────────────────

  describe("buildMergedInstructions", () => {
    it("returns empty string for an empty chain", async () => {
      const result = await buildMergedInstructions(
        { id: "a", companyId, name: "A", adapterConfig: {}, adapterType: "hermes_local", folderId: null },
        [],
      );
      expect(result).toBe("");
    });

    it("orders folders root->leaf and inserts section headers", async () => {
      const root = await createFolder("Root");
      const leaf = await createFolder("Leaf", root.id);
      await writeFolderInstructions(root.id, "root body");
      await writeFolderInstructions(leaf.id, "leaf body");

      const chain: InheritanceFolder[] = [
        { id: root.id, parentId: null, name: "Root", slug: "root", instructionsPath: resolveFolderInstructionsDir(companyId, root.id) },
        { id: leaf.id, parentId: root.id, name: "Leaf", slug: "leaf", instructionsPath: resolveFolderInstructionsDir(companyId, leaf.id) },
      ];

      const merged = await buildMergedInstructions(
        { id: "a", companyId, name: "A", adapterConfig: {}, adapterType: "hermes_local", folderId: leaf.id },
        chain,
      );

      expect(merged).toContain("# [Folder: Root]");
      expect(merged).toContain("# [Folder: Leaf]");
      const rootIdx = merged.indexOf("# [Folder: Root]");
      const leafIdx = merged.indexOf("# [Folder: Leaf]");
      expect(rootIdx).toBeLessThan(leafIdx);
      expect(merged).toContain("root body");
      expect(merged).toContain("leaf body");
    });
  });
});
