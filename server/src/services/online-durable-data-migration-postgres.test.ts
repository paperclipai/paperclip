import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, executionWorkspaceSnapshots, executionWorkspaces, heartbeatRuns, issues, projects, workspaceOperations } from "@paperclipai/db";
import { readRemoteWorkspaceAuthority } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import type { StorageService } from "../storage/types.js";
import { listLocalWorkspaceCompanies, listLocalWorkspaces } from "./local-workspace-dependencies.js";
import { reconcileOnlineWorkspaceOperations } from "./offline-workspace-operation-reconciliation.js";
import { inventoryRemoteWorkspaceMigration, migrateRemoteWorkspace } from "./remote-workspace-migration.js";
import { getWorkspaceSnapshot, loadWorkspaceSnapshotArchive } from "./remote-workspace-snapshot-storage.js";
import { restoreRemoteWorkspaceArchive } from "./remote-workspace-snapshot-archive.js";
import { resetOnlineDurableDataMigrationProgressForTests, runOnlineDurableDataMigration } from "./online-durable-data-migration.js";

const support = await getEmbeddedPostgresTestSupport();
describe.skipIf(!support.supported)("online durable-data migration of local workspaces", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, home: string, storage: StorageService;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("online-durable-workspaces-");
    db = createDb(database.connectionString);
    await db.execute(sql`set client_min_messages = warning`);
  }, 90_000);
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await database?.cleanup(); });
  beforeEach(async () => {
    resetOnlineDurableDataMigrationProgressForTests();
    home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-online-durable-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    storage = { ...createStorageService(createLocalDiskStorageProvider(path.join(home, "objects"))), provider: "s3" } as StorageService;
  });
  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaceSnapshots);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  async function localWorkspace(companyId: string, text: string) {
    const [project] = await db.insert(projects).values({ companyId, name: `Project ${text}` }).returning();
    const cwd = resolveManagedProjectWorkspaceDir({ companyId, projectId: project.id });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(path.join(cwd, "saved.txt"), text);
    const [issue] = await db.insert(issues).values({ companyId, projectId: project.id, title: `Task ${text}` }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project.id, sourceIssueId: issue.id,
      name: `Workspace ${text}`, mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd }).returning();
    await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issue.id));
    return { workspace, issue, cwd };
  }

  const done = async () => ({ results: [], inspected: 0, migrated: 0, busy: 0, after: null, next: null });
  const owners = () => ({
    storage: () => storage,
    localSkillStorage: () => storage,
    durableAgentFiles: () => true,
    agentFiles: done,
    skillObjects: done,
    skillPackages: () => ({ migrateSnapshots: done, migrateVersions: done }),
    skillInstallations: () => ({ installations: done }),
    runtimeSkillAssets: done,
    workspaceCompanies: listLocalWorkspaceCompanies,
    workspaceOperations: reconcileOnlineWorkspaceOperations,
    localWorkspaces: listLocalWorkspaces,
    inventoryWorkspace: inventoryRemoteWorkspaceMigration,
    migrateWorkspace: migrateRemoteWorkspace,
    nativeHarnessBackups: async () => undefined,
    nativeControllers: async () => undefined,
    eligibility: async () => ({ eligible: false, blockers: [] }),
    record: async () => undefined,
  }) as never;

  it("moves an idle local workspace to shared storage while serving and leaves a workspace with an active run in place", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Online workspaces", issuePrefix: `W${companyId.slice(0, 6)}` });
    const idle = await localWorkspace(companyId, "idle work\n");
    const busy = await localWorkspace(companyId, "busy work\n");
    const [agent] = await db.insert(agents).values({ companyId, name: "Writer" }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId: agent.id, issueId: busy.issue.id, status: "running", runtimeMode: "legacy" });
    const busyBefore = (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, busy.workspace.id)))[0];

    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, owners());

    expect(result).toMatchObject({ state: "completed", counts: { workspaces: 1 }, deferred: { "workspaces:active_execution": 1 } });
    const [moved] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, idle.workspace.id));
    const authority = readRemoteWorkspaceAuthority(moved.metadata)!;
    expect(moved.providerType).toBe("cloud_sandbox");
    expect(authority.snapshotId).toEqual(expect.any(String));
    const reference = await getWorkspaceSnapshot(db, { companyId, workspaceId: idle.workspace.id, snapshotId: authority.snapshotId! });
    const archivePath = path.join(home, "idle.pcws"), restored = path.join(home, "idle-restored");
    await loadWorkspaceSnapshotArchive({ storage, reference: reference!, targetPath: archivePath });
    await restoreRemoteWorkspaceArchive({ archivePath, targetDir: restored, expectedManifestDigest: reference!.manifestDigest });
    expect(await fs.readFile(path.join(restored, "saved.txt"), "utf8")).toBe("idle work\n");

    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, busy.workspace.id)))[0]).toEqual(busyBefore);
    expect(await fs.readFile(path.join(busy.cwd, "saved.txt"), "utf8")).toBe("busy work\n");
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, busy.workspace.id))).toEqual([]);
  }, 60_000);

  it("pages local workspaces deepest first and pages companies, with no skips or repeats across page boundaries", async () => {
    const expected: Array<{ id: string; depth: number }> = [];
    const companyIds = [randomUUID(), randomUUID()].sort();
    for (const companyId of companyIds) {
      await db.insert(companies).values({ id: companyId, name: "Paging", issuePrefix: `P${companyId.slice(0, 6)}` });
      for (const cwd of ["/a/b", "/a/bb", "/a/bb", "/a/b/c/d", "/a/b/c"]) {
        const [row] = await db.insert(executionWorkspaces).values({ companyId, name: cwd, mode: "shared_workspace",
          strategyType: "project_primary", providerType: "local_fs", cwd, providerRef: cwd }).returning();
        expected.push({ id: row.id, depth: cwd.length });
      }
    }
    expected.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listLocalWorkspaces(db, { after, limit: 3 });
      seen.push(...page.map(row => row.workspaceId));
      if (page.length < 3) break;
      after = page.at(-1)!.cursor;
    }
    expect(seen).toEqual(expected.map(row => row.id));
    expect(await listLocalWorkspaceCompanies(db, { limit: 1 })).toEqual([companyIds[0]]);
    expect(await listLocalWorkspaceCompanies(db, { after: companyIds[0], limit: 1 })).toEqual([companyIds[1]]);
    expect(await listLocalWorkspaceCompanies(db, { after: companyIds[1], limit: 1 })).toEqual([]);
  });
});
