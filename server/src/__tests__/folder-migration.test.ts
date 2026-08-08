import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
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
  });

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
      // Create an agent with a folder_id pointing to a non-existent folder.
      // The agents.folder_id FK (added in 0217) prevents inserting an orphan
      // directly, so we drop the constraint within a transaction, insert the
      // orphan row, and re-add the constraint as NOT VALID.
      await db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE "agents" DROP CONSTRAINT IF EXISTS "agents_folder_id_fkey"`);
        await tx.insert(agents).values({
          companyId,
          name: "Orphan Agent",
          role: "coordinator",
          adapterType: "process",
          folderId: "00000000-0000-0000-0000-000000000000",
        });
        await tx.execute(sql`ALTER TABLE "agents" ADD CONSTRAINT "agents_folder_id_fkey" FOREIGN KEY ("folder_id") REFERENCES "agent_folders" ("id") ON DELETE SET NULL NOT VALID`);
      });

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
      // Create a folder with a non-existent parent.
      // The agent_folders.parent_id self-referencing FK (added in 0217) prevents
      // inserting a broken parent chain directly, so we drop the constraint within
      // a transaction, insert the orphan folder, and re-add as NOT VALID.
      await db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE "agent_folders" DROP CONSTRAINT IF EXISTS "agent_folders_parent_id_fkey"`);
        await tx
          .insert(agentFolders)
          .values({
            companyId,
            name: "Child Folder",
            slug: "child",
            sortOrder: 0,
            parentId: "00000000-0000-0000-0000-000000000000",
          })
          .returning();
        await tx.execute(sql`ALTER TABLE "agent_folders" ADD CONSTRAINT "agent_folders_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "agent_folders" ("id") ON DELETE SET NULL NOT VALID`);
      });

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
