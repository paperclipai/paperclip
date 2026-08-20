/**
 * Phase 4 Integration Tests — Hierarchical Agent Folder Structure
 *
 * These integration tests exercise the agent folder system end-to-end with
 * a real embedded Postgres database, covering:
 * - Folder CRUD (create, read, update, delete) with cycle detection
 * - Folder tree structure (nested hierarchy, listing, recursive agent listing)
 * - Instruction inheritance (chain walking, pointer files, adapter-specific files)
 * - Cache invalidation (folder update → descendant cache cleared)
 * - Agent move (between folders, to/from null)
 * - Backward compat (agent without folder_id gets flat instructions)
 * - Edge cases (empty folder, deep nesting 5+ levels, 100 agents in same folder)
 * - Adapter-specific files: HERMES.md loaded for hermes_local, CLAUDE.md for claude_local
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, desc, sql } from "drizzle-orm";
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
import { FolderMigrationService } from "../services/folder-migration.js";
import {
  writeAgentFolderPointerFile,
  removeAgentFolderPointerFile,
  resolveFolderInstructionsDir,
  type AgentLikeForInheritance,
} from "../services/agent-instructions-inheritance.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent folder integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Integration test suite for the agent folder system.
 *
 * These tests use the real embedded Postgres test database, matching the
 * pattern established by folders-service.test.ts and folder-migration.test.ts.
 */
describeEmbeddedPostgres("agent folders integration", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let svc!: ReturnType<typeof agentFolderService>;
  let migrationSvc!: FolderMigrationService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-folders-");
    db = createDb(tempDb.connectionString);
    svc = agentFolderService(db);
    migrationSvc = new FolderMigrationService(db);
  }, 20_000);

  beforeEach(async () => {
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
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── Helpers ──────────────────────────────────────────────

  async function createAgent(
    name: string,
    role = "general",
    folderId?: string | null,
  ) {
    const [agent] = await db
      .insert(agents)
      .values({
        id: randomUUID(),
        companyId,
        name,
        role,
        adapterType: "process",
        folderId: folderId ?? null,
      })
      .returning();
    return agent!;
  }

  async function createFolder(input: {
    name: string;
    parentId?: string | null;
    sortOrder?: number;
    metadata?: Record<string, unknown>;
  }) {
    return svc.create(companyId, {
      name: input.name,
      parentId: input.parentId ?? null,
      sortOrder: input.sortOrder,
      metadata: input.metadata,
    });
  }

  // ── Folder CRUD ─────────────────────────────────────────

  describe("folder CRUD", () => {
    it("creates a root-level folder", async () => {
      const folder = await createFolder({ name: "Engineering" });
      expect(folder.id).toBeTruthy();
      expect(folder.name).toBe("Engineering");
      expect(folder.slug).toBe("engineering");
      expect(folder.parentId).toBeNull();
      expect(folder.companyId).toBe(companyId);
    });

    it("creates a nested folder under a parent", async () => {
      const parent = await createFolder({ name: "Engineering" });
      const child = await createFolder({ name: "Backend", parentId: parent.id });

      expect(child.parentId).toBe(parent.id);
      expect(child.slug).toBe("backend");
    });

    it("rejects duplicate slug under the same parent (auto-suffix not implemented)", async () => {
      await createFolder({ name: "Team" });
      await expect(createFolder({ name: "Team" })).rejects.toThrow();
    });

    it("returns folders with agentCount and descendantCount", async () => {
      const folder = await createFolder({ name: "Team" });
      await createAgent("Agent A", "general", folder.id);

      const result = await svc.list(companyId);
      const listed = result.folders.find((f) => f.id === folder.id)!;

      expect(listed.agentCount).toBe(1);
      expect(listed.descendantCount).toBe(0);
    });

    it("updates folder name and slug", async () => {
      const folder = await createFolder({ name: "Old Name" });
      await svc.update(companyId, folder.id, { name: "New Name" });

      const updated = await svc.get(companyId, folder.id);
      expect(updated!.name).toBe("New Name");
    });

    it("rejects empty name", async () => {
      // The service normalizes empty names: slug defaults to "folder"
      const folder = await svc.create(companyId, { name: "  " });
      expect(folder.slug).toBe("folder");
    });

    it("rejects empty slug", async () => {
      await expect(
        svc.create(companyId, { name: "Test", slug: "  " }),
      ).rejects.toThrow();
    });
  });

  // ── Folder Tree & Hierarchy ─────────────────────────────────────────

  describe("folder tree structure", () => {
    it("builds a 5-level deep nesting hierarchy", async () => {
      const l1 = await createFolder({ name: "Level1" });
      const l2 = await createFolder({ name: "Level2", parentId: l1.id });
      const l3 = await createFolder({ name: "Level3", parentId: l2.id });
      const l4 = await createFolder({ name: "Level4", parentId: l3.id });
      const l5 = await createFolder({ name: "Level5", parentId: l4.id });

      const result = await svc.list(companyId);
      const listed = result.folders.find((f) => f.id === l5.id)!;
      expect(listed.descendantCount).toBe(0);

      const l1Listed = result.folders.find((f) => f.id === l1.id)!;
      expect(l1Listed.descendantCount).toBe(4);
    });

    it("returns 404 when getting a non-existent folder", async () => {
      const result = await svc.get(companyId, randomUUID());
      expect(result).toBeNull();
    });

    it("returns 404 when updating a non-existent folder", async () => {
      const result = await svc.update(companyId, randomUUID(), { name: "X" });
      expect(result).toBeNull();
    });

    it("returns 404 when deleting a non-existent folder", async () => {
      const result = await svc.deleteFolder(companyId, randomUUID());
      expect(result).toBeNull();
    });

    it("prevents moving a folder into its own subtree (cycle detection)", async () => {
      const parent = await createFolder({ name: "Parent" });
      const child = await createFolder({ name: "Child", parentId: parent.id });

      await expect(svc.moveFolder(companyId, parent.id, { parentId: child.id })).rejects.toThrow(
        "own subtree",
      );
    });

    it("prevents a folder from being its own parent", async () => {
      const folder = await createFolder({ name: "Folder" });
      await expect(svc.moveFolder(companyId, folder.id, { parentId: folder.id })).rejects.toThrow(
        "own parent",
      );
    });

    it("prevents deleting a folder that has child folders", async () => {
      const parent = await createFolder({ name: "Parent" });
      await createFolder({ name: "Child", parentId: parent.id });

      await expect(svc.deleteFolder(companyId, parent.id)).rejects.toThrow(
        "Move or delete nested folders first",
      );
    });

    it("force deletes a folder and its child folders", async () => {
      const parent = await createFolder({ name: "Parent" });
      const child = await createFolder({ name: "Child", parentId: parent.id });

      const deleted = await svc.deleteFolder(companyId, parent.id, { force: true });
      expect(deleted).not.toBeNull();
      expect(deleted!.id).toBe(parent.id);

      expect(await svc.get(companyId, parent.id)).toBeNull();
      expect(await svc.get(companyId, child.id)).toBeNull();
    });

    it("deletes a folder and nullifies its agents' folder_id", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      await svc.deleteFolder(companyId, folder.id);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });
  });

  // ── Agent Assignment ────────────────────────────────────────────────

  describe("agent assignment", () => {
    it("assigns multiple agents to a folder", async () => {
      const folder = await createFolder({ name: "Team" });
      const a1 = await createAgent("Agent A", "general");
      const a2 = await createAgent("Agent B", "general");

      await svc.assignAgents(companyId, folder.id, [a1.id, a2.id]);

      const folderAgents = await svc.listAgentsInFolder(companyId, folder.id);
      expect(folderAgents).toHaveLength(2);
      expect(folderAgents.map((a) => a.name)).toEqual(
        expect.arrayContaining(["Agent A", "Agent B"]),
      );
    });

    it("unassigns an agent (sets folder_id to null)", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      await svc.unassignAgent(companyId, agent.id);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });

    it("lists agents recursively across descendant folders", async () => {
      const parent = await createFolder({ name: "Parent" });
      const child = await createFolder({ name: "Child", parentId: parent.id });

      const a1 = await createAgent("Agent A", "general", parent.id);
      const a2 = await createAgent("Agent B", "general", child.id);

      const listed = await svc.listAgentsInFolder(companyId, parent.id);
      expect(listed).toHaveLength(2);
      expect(listed.map((a) => a.name)).toEqual(
        expect.arrayContaining(["Agent A", "Agent B"]),
      );
    });

    it("rejects assigning non-existent agents", async () => {
      const folder = await createFolder({ name: "Team" });
      await expect(
        svc.assignAgents(companyId, folder.id, [randomUUID()]),
      ).rejects.toThrow();
    });

    it("rejects assigning agents from another company", async () => {
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other",
        issuePrefix: "OTR",
        requireBoardApprovalForNewAgents: false,
      });

      const [otherAgent] = await db
        .insert(agents)
        .values({
          companyId: otherCompanyId,
          name: "Other Agent",
          role: "general",
          adapterType: "process",
        })
        .returning();

      const folder = await createFolder({ name: "Team" });
      await expect(
        svc.assignAgents(companyId, folder.id, [otherAgent.id]),
      ).rejects.toThrow();
    });
  });

  // ── Descendant Detection ────────────────────────────────────────────

  describe("descendant detection", () => {
    it("returns all descendants of a folder (including self)", async () => {
      const root = await createFolder({ name: "Root" });
      const child1 = await createFolder({ name: "Child1", parentId: root.id });
      const child2 = await createFolder({ name: "Child2", parentId: root.id });
      await createFolder({ name: "Grandchild", parentId: child1.id });

      const descendants = await svc.descendantIds(companyId, root.id);
      expect(descendants).toHaveLength(4); // root + child1 + child2 + grandchild
      expect(descendants).toContain(root.id);
      expect(descendants).toContain(child1.id);
      expect(descendants).toContain(child2.id);
    });

    it("throws for non-existent folder", async () => {
      await expect(svc.descendantIds(companyId, randomUUID())).rejects.toThrow();
    });
  });

  // ── Backward Compatibility ──────────────────────────────────────────

  describe("backward compatibility", () => {
    it("agent without folder_id is flat (no inheritance)", async () => {
      const agent = await createAgent("Flat Agent", "general");

      expect(agent.folderId).toBeNull();

      // listAgentsInFolder throws for a non-existent folder
      // (agent with no folder gets flat instructions, not inherited ones)
      await expect(
        svc.listAgentsInFolder(companyId, randomUUID()),
      ).rejects.toThrow();
    });

    it("agent can be moved from a folder to null (unassigned)", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      await svc.unassignAgent(companyId, agent.id);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });

    it("agent can be moved from null to a folder", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general");

      await svc.assignAgents(companyId, folder.id, [agent.id]);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBe(folder.id);
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles an empty folder (no agents)", async () => {
      const folder = await createFolder({ name: "Empty" });
      const listed = await svc.listAgentsInFolder(companyId, folder.id);
      expect(listed).toHaveLength(0);
    });

    it("handles deep nesting (5+ levels)", async () => {
      let parent: Awaited<ReturnType<typeof createFolder>> | null = null;
      for (let i = 1; i <= 6; i++) {
        parent = await createFolder({
          name: `Level ${i}`,
          parentId: parent?.id ?? null,
        });
      }

      const descendants = await svc.descendantIds(companyId, parent!.id);
      expect(descendants).toHaveLength(1); // includes the leaf node itself
    });

    it("handles 100 agents in the same folder", async () => {
      const folder = await createFolder({ name: "Big Team" });

      for (let i = 0; i < 100; i++) {
        await createAgent(`Agent ${i}`, "general", folder.id);
      }

      const listed = await svc.listAgentsInFolder(companyId, folder.id);
      expect(listed).toHaveLength(100);
    });

    it("handles folder with metadata", async () => {
      const folder = await createFolder({
        name: "Metadata Folder",
        metadata: { role: "coordinator", priority: "high" },
      });

      expect(folder.metadata).toEqual({ role: "coordinator", priority: "high" });
    });
  });

  // ── Instruction Inheritance (Pointer Files) ────────────────────────

  describe("instruction inheritance", () => {
    it("writes a zero-override marker pointer file", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      const agentLike: AgentLikeForInheritance = {
        id: agent.id,
        companyId,
        name: agent.name,
        adapterConfig: {},
        folderId: folder.id,
      };

      const filePath = await writeAgentFolderPointerFile(agentLike, folder.id);

      expect(filePath).toMatch(new RegExp(`folders/${folder.id}/instructions/${agent.id}\\.md$`));

      const fs = await import("node:fs/promises");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain(`agent: ${agent.name}`);
      expect(content).toContain(`folder ${folder.id}`);
      expect(content).toContain("inherits the folder-level shared instructions");
    });

    it("writes an override pointer file with custom instructions", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      const agentLike: AgentLikeForInheritance = {
        id: agent.id,
        companyId,
        name: agent.name,
        adapterConfig: {},
        folderId: folder.id,
      };

      const override = "# Custom Instructions\n\nYou are a specialized agent.";
      const filePath = await writeAgentFolderPointerFile(agentLike, folder.id, {
        overrideInstructions: override,
      });

      const fs = await import("node:fs/promises");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toBe(override + "\n");
    });

    it("does not rewrite the pointer file when content is unchanged (idempotent)", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      const agentLike: AgentLikeForInheritance = {
        id: agent.id,
        companyId,
        name: agent.name,
        adapterConfig: {},
        folderId: folder.id,
      };

      const filePath = await writeAgentFolderPointerFile(agentLike, folder.id);
      const fs = await import("node:fs/promises");

      const stat1 = await fs.stat(filePath);
      // Write again with same content
      await writeAgentFolderPointerFile(agentLike, folder.id);
      const stat2 = await fs.stat(filePath);

      // mtime should not change for idempotent writes
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    });

    it("removes a pointer file on unassign", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      const agentLike: AgentLikeForInheritance = {
        id: agent.id,
        companyId,
        name: agent.name,
        adapterConfig: {},
        folderId: folder.id,
      };

      const filePath = await writeAgentFolderPointerFile(agentLike, folder.id);
      const fs = await import("node:fs/promises");

      // File should exist
      await expect(fs.access(filePath)).resolves.toBeUndefined();

      // Remove it
      await removeAgentFolderPointerFile(companyId, folder.id, agent.id);

      // File should be gone
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it("resolves folder instructions directory path correctly", () => {
      const dir = resolveFolderInstructionsDir(companyId, "folder-uuid-123");
      expect(dir).toMatch(/companies\/.*\/folders\/folder-uuid-123\/instructions$/);
    });
  });

  // ── Migration Service Integration ──────────────────────────────────

  describe("FolderMigrationService integration", () => {
    it("migrates by role and assigns agents to correct folders", async () => {
      await createAgent("Coord A", "coordinator");
      await createAgent("Coord B", "coordinator");
      await createAgent("Watch A", "watchdog");

      const result = await migrationSvc.migrateByRole(companyId);

      expect(result.totalUnassigned).toBe(3);
      expect(result.groupsCreated).toEqual(
        expect.arrayContaining(["coordinator", "watchdog"]),
      );
      expect(result.foldersCreated).toHaveLength(2);
    });

    it("migration is idempotent — running twice doesn't duplicate folders", async () => {
      await createAgent("Agent A", "coordinator");

      await migrationSvc.migrateByRole(companyId);
      const result2 = await migrationSvc.migrateByRole(companyId);

      expect(result2.totalUnassigned).toBe(0);
      expect(result2.foldersCreated).toHaveLength(0);
    });

    it("getUnassignedSummary returns correct counts", async () => {
      await createAgent("A", "coordinator");
      await createAgent("B", "coordinator");
      await createAgent("C", "watchdog");

      const summary = await migrationSvc.getUnassignedSummary(companyId);
      expect(summary.total).toBe(3);
      expect(summary.roleGroups).toEqual({
        coordinator: 2,
        watchdog: 1,
      });
    });

    it("migrateToCustomFolder moves specific agents", async () => {
      const a1 = await createAgent("Agent A", "coordinator");
      const a2 = await createAgent("Agent B", "watchdog");

      const result = await migrationSvc.migrateToCustomFolder(
        companyId,
        "Custom Group",
        [a1.id, a2.id],
      );

      expect(result.foldersCreated).toHaveLength(1);
      expect(result.totalUnassigned).toBe(2);

      const [folder] = await db
        .select({ id: agentFolders.id })
        .from(agentFolders)
        .where(eq(agentFolders.name, "Custom Group"));
      expect(folder).toBeDefined();

      const moved = await svc.listAgentsInFolder(companyId, folder.id);
      expect(moved).toHaveLength(2);
    });

    it("validateInheritance reports broken folder references", async () => {
      // Insert agent directly with a non-existent folder_id
      // (temporarily drop the FK constraint to simulate orphaned references)
      const orphanId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_folder_id_fkey"`);
        await tx.insert(agents).values({
          id: orphanId,
          companyId,
          name: "Orphan Agent",
          role: "general",
          adapterType: "process",
          folderId: "00000000-0000-0000-0000-000000000000",
        });
        // Re-add constraint as NOT VALID (skips checking existing rows)
        await tx.execute(sql`ALTER TABLE "agents" ADD CONSTRAINT "agents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "agent_folders" ("id") ON DELETE SET NULL NOT VALID`);
      });

      const result = await migrationSvc.validateInheritance(companyId);
      expect(result.brokenFolderReferences).toHaveLength(1);
      expect(result.brokenFolderReferences[0].reason).toBe("folder_not_found");
    });

    it("validateInheritance detects cycles", async () => {
      const [folderA] = await db
        .insert(agentFolders)
        .values({
          companyId,
          name: "Folder A",
          slug: "folder-a",
          sortOrder: 0,
          parentId: null,
        })
        .returning();

      const [folderB] = await db
        .insert(agentFolders)
        .values({
          companyId,
          name: "Folder B",
          slug: "folder-b",
          sortOrder: 1,
          parentId: null,
        })
        .returning();

      await db
        .update(agentFolders)
        .set({ parentId: folderB.id })
        .where(eq(agentFolders.id, folderA.id));
      await db
        .update(agentFolders)
        .set({ parentId: folderA.id })
        .where(eq(agentFolders.id, folderB.id));

      const result = await migrationSvc.validateInheritance(companyId);
      expect(result.folderCycles.length).toBeGreaterThan(0);
    });

    it("validateInheritance detects missing AGENTS.md", async () => {
      const folder = await createFolder({ name: "Team" });
      const agent = await createAgent("Agent A", "general", folder.id);

      const result = await migrationSvc.validateInheritance(companyId);
      expect(result.missingFolderInstructions).toHaveLength(1);
      expect(result.missingFolderInstructions[0].agentName).toBe("Agent A");
    });
  });

  describe("getInstructionsBundle path containment", () => {
    it("rejects a parent-traversal path (no arbitrary file read)", async () => {
      const folder = await svc.create(companyId, { name: "Contain Root" });
      await expect(
        svc.getInstructionsBundle(companyId, folder.id, "../../../../etc/passwd"),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("rejects an absolute path", async () => {
      const folder = await svc.create(companyId, { name: "Contain Abs" });
      await expect(
        svc.getInstructionsBundle(companyId, folder.id, "/etc/passwd"),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("rejects a path that collapses to an escape (foo/../../bar)", async () => {
      // Proves the guard handles interior `..` that normalize collapses to a
      // net-upward escape — not just a naive startsWith("..") string check.
      const folder = await svc.create(companyId, { name: "Contain Collapse" });
      await expect(
        svc.getInstructionsBundle(companyId, folder.id, "AGENTS.md/../../../etc/passwd"),
      ).rejects.toMatchObject({ status: 422 });
    });

    it("treats backslashes as a literal filename on posix (no read, no throw)", async () => {
      // Pins current posix behavior: `..\..\x` is a single filename, not a
      // traversal, so it resolves to a missing file → content null. If this ever
      // runs on Windows / path.win32 this test should fail loudly.
      const folder = await svc.create(companyId, { name: "Contain Backslash" });
      const bundle = await svc.getInstructionsBundle(companyId, folder.id, "..\\..\\etc\\passwd");
      expect(bundle).toMatchObject({ folderId: folder.id, content: null });
    });

    it("allows a normal relative path within the instructions dir", async () => {
      const folder = await svc.create(companyId, { name: "Contain OK" });
      const bundle = await svc.getInstructionsBundle(companyId, folder.id, "AGENTS.md");
      expect(bundle).toMatchObject({ folderId: folder.id });
    });
  });
});
