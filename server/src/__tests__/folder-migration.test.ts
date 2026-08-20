import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
} from "../__tests__/helpers/embedded-postgres.js";
import { FolderMigrationService } from "../services/folder-migration.js";
import { agentFolderService } from "../services/agent-folders.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres folder migration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("FolderMigrationService", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let migrationService!: FolderMigrationService;
  // Foreign companies created to produce genuinely dangling-within-company
  // references (a real folder row the self/agent FK accepts, but which lives in
  // another company so validateInheritance sees it as not-found). Cleaned up
  // after each test.
  const foreignCompanyIds: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-folder-migration-");
    db = createDb(tempDb.connectionString);
    migrationService = new FolderMigrationService(db);
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
    // Pointer files are written under the instance root; clean the DB state only.
    await db.delete(agentFolders).where(eq(agentFolders.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
    // Deleting the foreign company cascades to its agent_folders rows.
    while (foreignCompanyIds.length > 0) {
      const foreignId = foreignCompanyIds.pop()!;
      await db.delete(companies).where(eq(companies.id, foreignId));
    }
  });

  // Create a folder that lives in a throwaway *other* company and return its id.
  // The self/agent folder FKs are satisfied (it is a real row), but from the
  // company under test the reference is genuinely dangling — which is exactly
  // the broken state validateInheritance must detect. This replaces the old
  // all-zeros sentinel UUID, which the enforced FK (23503) rejects on insert.
  async function createForeignFolder(name: string, slug: string) {
    const foreignCompanyId = randomUUID();
    await db.insert(companies).values({
      id: foreignCompanyId,
      name: "Foreign Company",
      issuePrefix: `F${foreignCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    foreignCompanyIds.push(foreignCompanyId);
    const [folder] = await db
      .insert(agentFolders)
      .values({
        companyId: foreignCompanyId,
        name,
        slug,
        sortOrder: 0,
        parentId: null,
      })
      .returning();
    return folder;
  }

  async function createUnassignedAgent(name: string, role: string) {
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        name,
        role,
        adapterType: "process",
      })
      .returning();
    return agent;
  }

  describe("getUnassignedSummary", () => {
    it("returns total count and groups by role", async () => {
      await createUnassignedAgent("Agent A", "coordinator");
      await createUnassignedAgent("Agent B", "coordinator");
      await createUnassignedAgent("Agent C", "watchdog");

      const summary = await migrationService.getUnassignedSummary(companyId);

      expect(summary.total).toBe(3);
      expect(summary.roleGroups).toEqual({
        coordinator: 2,
        watchdog: 1,
      });
    });

    it("returns zero for empty company", async () => {
      const summary = await migrationService.getUnassignedSummary(companyId);
      expect(summary.total).toBe(0);
      expect(summary.roleGroups).toEqual({});
    });
  });

  describe("migrateByRole", () => {
    it("creates role-based folders and assigns agents", async () => {
      await createUnassignedAgent("Coordinator A", "coordinator");
      await createUnassignedAgent("Watchdog A", "watchdog");

      const result = await migrationService.migrateByRole(companyId);

      expect(result.totalUnassigned).toBe(2);
      expect(result.groupsCreated).toEqual(expect.arrayContaining(["coordinator", "watchdog"]));
      expect(result.foldersCreated).toHaveLength(2);
      expect(result.foldersReused).toBe(0);
    });

    it("is idempotent — running twice does not duplicate folders", async () => {
      await createUnassignedAgent("Agent A", "coordinator");

      const result1 = await migrationService.migrateByRole(companyId);
      expect(result1.foldersCreated).toHaveLength(1);
      expect(result1.totalUnassigned).toBe(1);

      const result2 = await migrationService.migrateByRole(companyId);
      expect(result2.totalUnassigned).toBe(0);
      expect(result2.foldersCreated).toHaveLength(0);
    });

    it("assigns agents to correct folders by role", async () => {
      const agent = await createUnassignedAgent("Coord Agent", "coordinator");

      await migrationService.migrateByRole(companyId);

      const [updated] = await db
        .select({ folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.id, agent.id))
        .limit(1);

      expect(updated!.folderId).not.toBeNull();

      const [folder] = await db
        .select({ name: agentFolders.name })
        .from(agentFolders)
        .where(eq(agentFolders.id, updated!.folderId!))
        .limit(1);

      expect(folder!.name).toBe("coordinator");
    });
  });

  describe("migrateToCustomFolder", () => {
    it("moves specified agents into a named folder", async () => {
      const agentA = await createUnassignedAgent("Agent A", "coordinator");
      const agentB = await createUnassignedAgent("Agent B", "watchdog");

      const result = await migrationService.migrateToCustomFolder(
        companyId,
        "Custom Group",
        [agentA.id, agentB.id],
      );

      expect(result.totalUnassigned).toBe(2);
      expect(result.groupsCreated).toEqual(["Custom Group"]);
      expect(result.foldersCreated).toHaveLength(1);

      const [folder] = await db
        .select({ id: agentFolders.id })
        .from(agentFolders)
        .where(eq(agentFolders.name, "Custom Group"));

      const moved = await db
        .select({ id: agents.id, folderId: agents.folderId })
        .from(agents)
        .where(eq(agents.folderId, folder.id));

      expect(moved).toHaveLength(2);
      expect(moved.map((a) => a.id)).toEqual(
        expect.arrayContaining([agentA.id, agentB.id]),
      );
    });
  });

  describe("validateInheritance", () => {
    it("returns zero issues for an empty company", async () => {
      const result = await migrationService.validateInheritance(companyId);
      expect(result.issueCount).toBe(0);
      expect(result.totalAgents).toBe(0);
      expect(result.agentsInFolders).toBe(0);
      expect(result.agentsUnassigned).toBe(0);
    });

    it("reports all flat agents with no folder issues", async () => {
      await createUnassignedAgent("Agent A", "coordinator");
      await createUnassignedAgent("Agent B", "watchdog");

      const result = await migrationService.validateInheritance(companyId);
      expect(result.totalAgents).toBe(2);
      expect(result.agentsInFolders).toBe(0);
      expect(result.agentsUnassigned).toBe(2);
      expect(result.issueCount).toBe(0);
    });

    it("detects broken folder references (agent pointing to non-existent folder)", async () => {
      // Create an agent whose folder_id points to a folder in another company.
      // The FK is satisfied (real row), but from this company's perspective the
      // folder does not exist — a genuinely dangling reference.
      const foreignFolder = await createForeignFolder("Foreign Folder", "foreign-folder");
      await db
        .insert(agents)
        .values({
          companyId,
          name: "Orphan Agent",
          role: "coordinator",
          adapterType: "process",
          folderId: foreignFolder.id,
        })
        .returning();

      const result = await migrationService.validateInheritance(companyId);
      expect(result.brokenFolderReferences).toHaveLength(1);
      expect(result.brokenFolderReferences[0].agentName).toBe("Orphan Agent");
      expect(result.brokenFolderReferences[0].reason).toBe("folder_not_found");
      expect(result.issueCount).toBe(1);
    });

    it("detects cycles in folder hierarchy", async () => {
      // Create two folders that reference each other
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

      // Create cycle: A -> B -> A
      await db
        .update(agentFolders)
        .set({ parentId: folderB.id })
        .where(eq(agentFolders.id, folderA.id));
      await db
        .update(agentFolders)
        .set({ parentId: folderA.id })
        .where(eq(agentFolders.id, folderB.id));

      const result = await migrationService.validateInheritance(companyId);
      expect(result.folderCycles.length).toBeGreaterThan(0);
      expect(result.brokenFolderChains.some((c) => c.reason === "cycle")).toBe(true);
      expect(result.issueCount).toBeGreaterThan(0);
    });

    it("detects broken folder chains (missing parent)", async () => {
      // Create a folder whose parent lives in another company. The self-FK is
      // satisfied (real row), but from this company's perspective the parent
      // does not exist — a genuinely dangling parent pointer.
      const foreignParent = await createForeignFolder("Foreign Parent", "foreign-parent");
      await db
        .insert(agentFolders)
        .values({
          companyId,
          name: "Child Folder",
          slug: "child",
          sortOrder: 0,
          parentId: foreignParent.id,
        })
        .returning();

      const result = await migrationService.validateInheritance(companyId);
      expect(result.brokenFolderChains.some((c) => c.reason === "missing_parent")).toBe(true);
      expect(result.issueCount).toBeGreaterThan(0);
    });

    it("detects missing folder-level instructions (AGENTS.md)", async () => {
      // This test relies on the fact that pointer files are written during migration
      // but AGENTS.md is not automatically created. We create a folder and assign
      // an agent to it without writing AGENTS.md.
      const svc = agentFolderService(db);
      const folder = await svc.create(companyId, {
        name: "Team A",
        slug: "team-a",
      });

      const agent = await createUnassignedAgent("Team Agent", "coordinator");
      await db
        .update(agents)
        .set({ folderId: folder.id })
        .where(eq(agents.id, agent.id));

      const result = await migrationService.validateInheritance(companyId);
      expect(result.missingFolderInstructions).toHaveLength(1);
      expect(result.missingFolderInstructions[0].agentName).toBe("Team Agent");
      expect(result.missingFolderInstructions[0].folderName).toBe("Team A");
      expect(result.issueCount).toBe(1);
    });
  });
});
