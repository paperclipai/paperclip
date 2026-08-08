/**
 * Phase 4 Integration Tests — Agent Folder Service (real DB)
 *
 * The existing agent-folders.test.ts uses a mock DB with only 3 light tests.
 * These integration tests use a real embedded Postgres database to exercise
 * the actual Drizzle query builder behavior, including:
 * - Real slug generation and conflict detection
 * - Real cycle detection in moveFolder
 * - Real descendant counting
 * - Real agent assignment and recursive listing
 * - Real pointer file generation on disk
 * - Cache invalidation behavior on folder update
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import {
  writeAgentFolderPointerFile,
  resolveFolderInstructionsDir,
  type AgentLikeForInheritance,
} from "../services/agent-instructions-inheritance.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;
type AgentFolderService = ReturnType<typeof agentFolderService>;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent folder service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * Integration tests for agentFolderService using a real embedded Postgres DB.
 * These complement the existing mock-based tests in agent-folders.test.ts.
 */
describeEmbeddedPostgres("agent folder service (real DB)", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let svc!: AgentFolderService;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-folder-svc-");
    db = createDb(tempDb.connectionString);
    svc = agentFolderService(db);
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
    // Clean up pointer files from disk before clearing DB
    const folderRows = await db
      .select({ id: agentFolders.id })
      .from(agentFolders)
      .where(eq(agentFolders.companyId, companyId));

    for (const f of folderRows) {
      const dir = resolveFolderInstructionsDir(companyId, f.id);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }

    await db.delete(agentFolders).where(eq(agentFolders.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ── Helpers ──────────────────────────────────────────────

  async function createAgent(name: string, folderId: string | null = null) {
    const [result] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role: "general",
        adapterType: "process",
        folderId,
      })
      .returning();
    return result!;
  }

  async function createFolder(name: string, parentId: string | null = null) {
    return svc.create(companyId, { name, parentId });
  }

  // ── Slug and Conflict ─────────────────────────────────────

  describe("slug resolution", () => {
    it("auto-generates slug from name", async () => {
      const folder = await createFolder("Engineering Team");
      expect(folder.slug).toBe("engineering-team");
    });

    it("rejects slug conflict under same parent with 409", async () => {
      await createFolder("My Folder");
      await expect(createFolder("My Folder")).rejects.toMatchObject({
        status: 409,
      });
    });

    it("allows same slug under different parents", async () => {
      const parent1 = await createFolder("Parent1");
      const parent2 = await createFolder("Parent2");

      const child1 = await createFolder("Shared", parent1.id);
      const child2 = await createFolder("Shared", parent2.id);

      expect(child1.slug).toBe("shared");
      expect(child2.slug).toBe("shared");
    });
  });

  // ── Move with Cycle Detection ────────────────────────────

  describe("moveFolder cycle detection", () => {
    it("prevents moving a folder into its own child", async () => {
      const parent = await createFolder("Parent");
      const child = await createFolder("Child", parent.id);

      await expect(
        svc.moveFolder(companyId, parent.id, { parentId: child.id }),
      ).rejects.toThrow(/own subtree/);
    });

    it("prevents moving a folder into its own grandchild", async () => {
      const l1 = await createFolder("L1");
      const l2 = await createFolder("L2", l1.id);
      const l3 = await createFolder("L3", l2.id);

      await expect(
        svc.moveFolder(companyId, l1.id, { parentId: l3.id }),
      ).rejects.toThrow(/own subtree/);
    });

    it("prevents a folder from being its own parent", async () => {
      const folder = await createFolder("Folder");

      await expect(
        svc.moveFolder(companyId, folder.id, { parentId: folder.id }),
      ).rejects.toThrow(/own parent/);
    });

    it("allows moving a folder to root level", async () => {
      const parent = await createFolder("Parent");
      const child = await createFolder("Child", parent.id);

      const moved = await svc.moveFolder(companyId, child.id, { parentId: null });
      expect(moved!.parentId).toBeNull();
    });

    it("allows moving a folder to a different parent", async () => {
      const parent1 = await createFolder("Parent1");
      const parent2 = await createFolder("Parent2");
      const child = await createFolder("Child", parent1.id);

      const moved = await svc.moveFolder(companyId, child.id, { parentId: parent2.id });
      expect(moved!.parentId).toBe(parent2.id);
    });
  });

  // ── Delete ───────────────────────────────────────────────

  describe("deleteFolder", () => {
    it("throws 409 when folder has child folders", async () => {
      const parent = await createFolder("Parent");
      await createFolder("Child", parent.id);

      await expect(svc.deleteFolder(companyId, parent.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(await svc.get(companyId, parent.id)).not.toBeNull();
    });

    it("cascade-nullifies agents on delete", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("Agent A", folder.id);

      await svc.deleteFolder(companyId, folder.id);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });
  });

  // ── Agent Assignment ────────────────────────────────────

  describe("assignAgents / listAgentsInFolder", () => {
    it("assigns agents and lists them recursively", async () => {
      const parent = await createFolder("Parent");
      const child = await createFolder("Child", parent.id);
      const a1 = await createAgent("A1", parent.id);
      const a2 = await createAgent("A2", child.id);

      const listed = await svc.listAgentsInFolder(companyId, parent.id);
      expect(listed).toHaveLength(2);
      const names = listed.map((a: { name: string }) => a.name);
      expect(names).toEqual(expect.arrayContaining(["A1", "A2"]));
    });

    it("assignAgents validates all agents exist (404)", async () => {
      const folder = await createFolder("Team");
      await expect(
        svc.assignAgents(companyId, folder.id, [randomUUID()]),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("assignAgents validates all agents are in the same company", async () => {
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other",
        issuePrefix: "OTH",
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

      const folder = await createFolder("Team");
      await expect(
        svc.assignAgents(companyId, folder.id, [otherAgent.id]),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("unassignAgent sets folderId to null", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("A1", folder.id);

      await svc.unassignAgent(companyId, agent.id);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });
  });

  // ── Descendant Counting ──────────────────────────────────

  describe("descendantIds and listing", () => {
    it("counts descendants correctly", async () => {
      const l1 = await createFolder("L1");
      await createFolder("L2", l1.id);
      await createFolder("L3", l1.id);
      const l4 = await createFolder("L4", l1.id);
      await createFolder("L5", l4.id);

      const listed = await svc.list(companyId);
      const l1Item = listed.folders.find((f: { id: string }) => f.id === l1.id)!;
      expect(l1Item.descendantCount).toBe(4);

      const l4Item = listed.folders.find((f: { id: string }) => f.id === l4.id)!;
      expect(l4Item.descendantCount).toBe(1);
    });

    it("descendantIds returns all descendants", async () => {
      const l1 = await createFolder("L1");
      await createFolder("L2", l1.id);
      await createFolder("L3", l1.id);
      const descendants = await svc.descendantIds(companyId, l1.id);
      expect(descendants.size).toBe(3); // includes self per service implementation
    });
  });

  // ── Pointer File Integration ─────────────────────────────

  describe("pointer file integration", () => {
    it("writeAgentFolderPointerFile creates the directory and marker file", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("Agent A", folder.id);

      const agentLike: AgentLikeForInheritance = {
        id: agent.id,
        companyId,
        name: agent.name,
        adapterConfig: {},
        folderId: folder.id,
      };

      const filePath = await writeAgentFolderPointerFile(agentLike, folder.id);

      // File should exist on disk
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain(agent.name);
      expect(content).toContain(folder.id);
      expect(content).toContain("inherits the folder-level shared instructions");

      // The path should resolve under the instance root
      expect(filePath).toContain(folder.id);
      expect(path.basename(filePath)).toBe(`${agent.id}.md`);
    });

    it("resolveFolderInstructionsDir returns a valid path pattern", () => {
      const dir = resolveFolderInstructionsDir(companyId, "test-folder-123");
      expect(dir).toMatch(/companies\/.*\/folders\/test-folder-123\/instructions$/);
    });
  });

  // ── Cache Invalidation ──────────────────────────────────

  describe("cache invalidation", () => {
    it("folder update does not break descendant resolution", async () => {
      const parent = await createFolder("Parent");
      const child = await createFolder("Child", parent.id);
      await createAgent("A1", parent.id);
      await createAgent("A2", child.id);

      // Update parent folder name
      await svc.update(companyId, parent.id, { name: "Renamed Parent" });

      // Descendant agents should still be listed correctly
      const listed = await svc.listAgentsInFolder(companyId, parent.id);
      expect(listed).toHaveLength(2);
    });

    it("folder delete invalidates agent listing (agents become unassigned)", async () => {
      const folder = await createFolder("Team");
      const agent = await createAgent("A1", folder.id);

      // Before delete, folder has 1 agent
      const listedBefore = await svc.listAgentsInFolder(companyId, folder.id);
      expect(listedBefore).toHaveLength(1);

      // Delete folder — agents nullified
      await svc.deleteFolder(companyId, folder.id);

      // Agent should no longer have a folder
      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);
      expect(updated!.folderId).toBeNull();
    });
  });

  // ── Company Isolation ───────────────────────────────────

  describe("company isolation", () => {
    it("folders are scoped to company — same slug in different companies is allowed", async () => {
      const company2Id = randomUUID();
      await db.insert(companies).values({
        id: company2Id,
        name: "Company 2",
        issuePrefix: "C2",
        requireBoardApprovalForNewAgents: false,
      });

      const f1 = await createFolder("Shared");
      const f2 = await agentFolderService(db).create(company2Id, { name: "Shared" });

      expect(f1.slug).toBe("shared");
      expect(f2.slug).toBe("shared");
      expect(f1.companyId).toBe(companyId);
      expect(f2.companyId).toBe(company2Id);

      const r1 = await svc.list(companyId);
      const r2 = await agentFolderService(db).list(company2Id);
      expect(r1.totalCount).toBe(1);
      expect(r2.totalCount).toBe(1);
    });

    it("agents from one company cannot be assigned to another company's folder", async () => {
      const otherCompanyId = randomUUID();
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Company 2",
        issuePrefix: "C3",
        requireBoardApprovalForNewAgents: false,
      });

      const folder = await createFolder("Team"); // company1
      const [agent2] = await db
        .insert(agents)
        .values({
          companyId: otherCompanyId,
          name: "Agent C2",
          role: "general",
          adapterType: "process",
        })
        .returning();

      await expect(
        svc.assignAgents(companyId, folder.id, [agent2.id]),
      ).rejects.toMatchObject({ status: 404 });
    });
  });
});
