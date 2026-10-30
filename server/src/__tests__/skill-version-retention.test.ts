import { instanceSettingsService } from "../services/instance-settings.js";
import { logger } from "../middleware/logger.js";
import { prepareAgentHireApproval } from "../services/agent-hiring.js";
import { notifyRetainedNativeSessionCleanup } from "../services/retained-native-session-cleanup-notifications.js";
import { setTimeout as realDelay } from "node:timers/promises";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { sql } from "drizzle-orm";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerSkillVersionRetentionWork } from "../services/skill-version-retention-work.js";
import { notifySkillVersionRetention } from "../services/skill-version-retention-notifications.js";
import { notifyInstructionCollection } from "../services/instruction-collection-notifications.js";
import { notifyNativeEnvironmentSettlement } from "../services/native-environment-settlement-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { applyPendingMigrations } from "@paperclipai/db";
import { touchSkillVersionCache, lastUsedAt, skillVersionCachePaths } from "../services/skill-version-cache.js";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  companySkills,
  companySkillVersions,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.ts";
import {
  resolveCompanySkillVersionsRoot,
  runVersionSnapshotFlight,
  skillVersionRetentionService,
} from "../services/skill-version-retention.ts";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SKILL_RETENTION_TEST_DATABASE_URL");
const embeddedPostgresSupport = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres skill version retention tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const HOUR_MS = 60 * 60 * 1000;

async function exists(target: string) {
  return fs.lstat(target).then(() => true, () => false);
}

async function makeWritable(target: string): Promise<void> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isDirectory()) return;
  await fs.chmod(target, 0o755);
  for (const entry of await fs.readdir(target)) await makeWritable(path.join(target, entry));
}

describeEmbeddedPostgres("skill version snapshot retention", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let oldPaperclipHome: string | undefined;
  let oldPaperclipInstanceId: string | undefined;
  let paperclipHome: string | null = null;

  beforeAll(async () => {
    if (!external) tempDb = await startEmbeddedPostgresTestDatabase("paperclip-skill-version-retention-");
    if (external) await applyPendingMigrations(external);
    oldPaperclipHome = process.env.PAPERCLIP_HOME;
    oldPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skill-version-retention-home-"));
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
    db = createDb(external ?? tempDb!.connectionString, { maxConnections: 6, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
  }, 20_000);

  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  let worker: ReturnType<typeof registerSkillVersionRetentionWork> | undefined;
  let admitted = true;
  afterEach(async () => {
    worker?.unsubscribe();
    await coordinator?.stop();
    await worker?.dispose();
    worker = undefined; coordinator = undefined; admitted = true;
    vi.useRealTimers();
    vi.restoreAllMocks();
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    if (paperclipHome) {
      const skillsRoot = path.join(paperclipHome, "instances", "default", "skills");
      await makeWritable(skillsRoot);
      await fs.rm(skillsRoot, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (oldPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = oldPaperclipHome;
    if (oldPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = oldPaperclipInstanceId;
    if (paperclipHome) await fs.rm(paperclipHome, { recursive: true, force: true });
    await db?.$client.end({ timeout: 1 });
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retention", issuePrefix: `R${companyId.slice(0, 6)}` });
    return companyId;
  }

  async function createSkill(companyId: string, versionCount: number, currentIndex = versionCount - 1) {
    const skillId = randomUUID();
    const key = `company/${companyId}/retained-${skillId.slice(0, 8)}`;
    await db.insert(companySkills).values({
      id: skillId, companyId, key, slug: `retained-${skillId.slice(0, 8)}`, name: "Retained",
      markdown: "# Retained", sourceType: "github", sourceLocator: "https://github.com/acme/retained",
      sourceRef: "a".repeat(40), trustLevel: "markdown_only", compatibility: "compatible",
      metadata: {}, fileInventory: [{ path: "SKILL.md", kind: "skill" }],
    });
    const versionIds: string[] = [];
    for (let index = 0; index < versionCount; index++) {
      const [version] = await db.insert(companySkillVersions).values({
        companyId, companySkillId: skillId, revisionNumber: index + 1, label: `v${index + 1}`,
        fileInventory: [
          { path: "SKILL.md", kind: "skill", content: `---\nname: retained\n---\n\n# Revision ${index + 1}\n` },
          { path: "references/notes.md", kind: "reference", content: `notes ${index + 1}` },
        ],
      }).returning({ id: companySkillVersions.id });
      versionIds.push(version!.id);
    }
    if (versionCount > 0) {
      await db.update(companySkills).set({ currentVersionId: versionIds[currentIndex]! })
        .where(eq(companySkills.id, skillId));
    }
    return { skillId, key, versionIds };
  }

  /** Writes a read-only snapshot directory like materializeVersionSnapshot does, aged by `ageMs`. */
  async function writeSnapshot(companyId: string, skillId: string, name: string, ageMs = 3 * HOUR_MS) {
    const dir = path.join(resolveCompanySkillVersionsRoot(companyId), skillId, name);
    await fs.mkdir(path.join(dir, "references"), { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "# Snapshot", { mode: 0o444 });
    await fs.writeFile(path.join(dir, "references", "notes.md"), "notes", { mode: 0o444 });
    await fs.chmod(path.join(dir, "references"), 0o555);
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    if (/^[a-f0-9-]{36}$/.test(name)) await touchSkillVersionCache(companyId, skillId, name, when.getTime());
    return dir;
  }

  async function startRetention(graceMs = 20_000, service = skillVersionRetentionService(db, { graceMs })) {
    await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select 1`)));
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => admitted, canReconcile: () => true,
      onError: error => { throw error; } });
    worker = registerSkillVersionRetentionWork(coordinator, service, () => admitted);
    await worker.ready;
    return service;
  }
  async function settled(deadline: number | null = null) {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0);
      expect(coordinator!.nextWakeAt()).toBe(deadline);
    }, { timeout: 10_000 });
  }
  async function quiet(ms = 3 * HOUR_MS) {
    const reads = vi.spyOn(db, "select"), transactions = vi.spyOn(db, "transaction"), directories = vi.spyOn(fs, "opendir");
    await vi.advanceTimersByTimeAsync(ms);
    expect(reads).not.toHaveBeenCalled(); expect(transactions).not.toHaveBeenCalled(); expect(directories).not.toHaveBeenCalled();
    reads.mockRestore(); transactions.mockRestore(); directories.mockRestore();
  }

  it("disarms after empty reconstruction without hourly SQL or directory reads", async () => {
    await startRetention(); await settled(); await quiet();
  });

  it("keeps only permanent pins quiet with completed run history", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    await writeSnapshot(companyId, skillId, versionIds[0]!);
    await writeSnapshot(companyId, skillId, versionIds[1]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Finished", adapterType: "codex_local" }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, invocationSource: "on_demand", status: "succeeded",
      finishedAt: new Date(), contextSnapshot: { skillVersions: { old: versionIds[0] } } });
    await startRetention(); await settled();
    expect(await exists(path.join(resolveCompanySkillVersionsRoot(companyId), skillId, versionIds[0]!))).toBe(false);
    expect(await exists(path.join(resolveCompanySkillVersionsRoot(companyId), skillId, versionIds[1]!))).toBe(true);
    await quiet();
  });

  it("wakes ordinary materialization and re-use at the saved access grace deadline", async () => {
    const companyId = await createCompany();
    const { skillId, key, versionIds } = await createSkill(companyId, 2);
    await startRetention(); await settled(); await quiet();
    const [entry] = await companySkillService(db).listRuntimeSkillEntries(companyId, {
      onlyKeys: new Set([key]), versionSelections: new Map([[key, versionIds[0]!]]) });
    expect(entry!.sourceStatus).toBe("available");
    const marker = path.join(path.dirname(path.dirname(resolveCompanySkillVersionsRoot(companyId))), companyId,
      "__version_access__", skillId, `${versionIds[0]}.json`);
    const accessed = JSON.parse(await fs.readFile(marker, "utf8")).lastUsedAt as number;
    await settled(accessed + 20_000);
    await vi.advanceTimersByTimeAsync(5000);
    await touchSkillVersionCache(companyId, skillId, versionIds[0]!);
    const reused = JSON.parse(await fs.readFile(marker, "utf8")).lastUsedAt as number;
    await settled(reused + 20_000);
    await vi.advanceTimersByTimeAsync(reused + 20_000 - Date.now());
    await settled(); expect(await exists(entry!.source)).toBe(false); await quiet();
  });

  it("releases current-version protection only after the real version transaction commits", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    await startRetention(); await settled(); await quiet();
    const inventory = [{ path: "SKILL.md", kind: "skill" as const, content: "---\nname: next\n---\n# Next" }];
    await expect(db.transaction(async tx => {
      await companySkillService(db).createVersion(companyId, skillId, {}, null,
        { database: tx, fileInventory: inventory, skipInventoryRefresh: true });
      await vi.advanceTimersByTimeAsync(60_000); expect(await exists(directory)).toBe(true);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await settled(); await quiet(); expect(await exists(directory)).toBe(true);
    await db.transaction(async tx => {
      await companySkillService(db).createVersion(companyId, skillId, {}, null,
        { database: tx, fileInventory: inventory, skipInventoryRefresh: true });
      await vi.advanceTimersByTimeAsync(60_000); expect(await exists(directory)).toBe(true);
    });
    await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it.each([notifyInstructionCollection, notifyNativeEnvironmentSettlement, notifyRetainedNativeSessionCleanup])("releases a captured run pin on its existing settlement notification %$", async notify => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Running", adapterType: "codex_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, invocationSource: "on_demand", status: "running",
      contextSnapshot: { skillVersions: { selected: versionIds[0] } } }).returning();
    await startRetention(); await settled(); await quiet(); expect(await exists(directory)).toBe(true);
    await db.transaction(async tx => {
      await notify(tx, { companyId, runId: run!.id });
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    });
    await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it("retains the first cache change during drain and resumes without passive inspection", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    await startRetention(); await settled(); admitted = false;
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(idleWorkSnapshot().active).toBe(0); });
    await quiet(60_000); expect(await exists(directory)).toBe(true);
    admitted = true; await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it("retains changes arriving during a page", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const service = skillVersionRetentionService(db, { graceMs: 0 });
    const prune = service.pruneCompany;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = vi.fn();
    service.pruneCompany = async (...args) => { const result = await prune(...args); began(); await held; return result; };
    const starting = startRetention(0, service);
    await vi.waitFor(() => expect(began).toHaveBeenCalledOnce());
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    release(); await starting; await settled(); expect(await exists(directory)).toBe(false);
    await quiet();
  });

  it.each(["configuration", "approval"])("wakes when agent %s removes a permanent pin", async mode => {
    const companyId = await createCompany();
    const { skillId, key, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Pinned", adapterType: "codex_local",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [{ key, versionId: versionIds[0] }] } } }).returning();
    await startRetention(); await settled(); await quiet(); expect(await exists(directory)).toBe(true);
    const patch = { adapterConfig: { paperclipSkillSync: { desiredSkills: [] } } };
    if (mode === "configuration") await createAgentLifecycle(db).updateConfiguration(agent!.id, patch);
    else await db.transaction(async tx => {
      const approved = await prepareAgentHireApproval(tx as unknown as typeof db, agent!, patch);
      await tx.update(agents).set(approved).where(eq(agents.id, agent!.id));
    });
    await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it("reconstructs saved staging grace on restart and stays quiet after removal", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    const staging = await writeSnapshot(companyId, skillId, `.${versionIds[0]}-abc123`, 0);
    const deadline = (await fs.stat(staging)).mtimeMs + 20_000;
    await startRetention(); await settled(deadline);
    worker!.unsubscribe(); await coordinator!.stop(); await worker!.dispose();
    vi.useRealTimers();
    await startRetention(); await settled(deadline);
    await vi.advanceTimersByTimeAsync(deadline - Date.now()); await settled();
    expect(await exists(staging)).toBe(false); await quiet();
  });

  it("uses the saved terminal controller deadline and preserves the database clock fence", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Lease", adapterType: "codex_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "succeeded", finishedAt: new Date(),
      contextSnapshot: { skillVersions: { selected: versionIds[0] } },
      controllerLeaseExpiresAt: sql`date_trunc('milliseconds', clock_timestamp()) + interval '3 seconds'` }).returning();
    const deadline = run!.controllerLeaseExpiresAt!.getTime();
    const service = skillVersionRetentionService(db, { graceMs: 0 });
    expect((await service.pruneCompany(companyId)).nextRunAt).toBe(deadline);
    await service.dispose();
    await startRetention(0); await settled(deadline);
    await vi.advanceTimersByTimeAsync(deadline - Date.now());
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).toBeGreaterThan(deadline));
    expect(await exists(directory)).toBe(true);
    await realDelay(3100);
    await vi.advanceTimersByTimeAsync(2000); await settled();
    expect(await exists(directory)).toBe(false); await quiet();
  });

  it("retains only a concrete failed company for retry while healthy companies settle", async () => {
    const companyId = await createCompany(), healthyId = await createCompany();
    const failedSkill = await createSkill(companyId, 2), healthySkill = await createSkill(healthyId, 2);
    const failedDir = await writeSnapshot(companyId, failedSkill.skillId, failedSkill.versionIds[0]!);
    const healthyDir = await writeSnapshot(healthyId, healthySkill.skillId, healthySkill.versionIds[0]!);
    const service = skillVersionRetentionService(db, { graceMs: 0 }), prune = service.pruneCompany;
    let failed = true;
    service.pruneCompany = vi.fn(async (...args) => {
      if (args[0] === companyId && failed) throw new Error("inspection unavailable");
      return prune(...args);
    });
    await startRetention(0, service);
    await vi.waitFor(() => expect(coordinator!.nextWakeAt()).not.toBeNull());
    const retryAt = coordinator!.nextWakeAt()!;
    expect(await exists(healthyDir)).toBe(false); expect(await exists(failedDir)).toBe(true);
    await quiet(5000); expect(service.pruneCompany).toHaveBeenCalledTimes(2);
    failed = false; await vi.advanceTimersByTimeAsync(retryAt - Date.now()); await settled();
    expect(await exists(failedDir)).toBe(false); await quiet();
  });

  it("continues directory pages without evicting another company's iterator", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 18; index++) {
      const companyId = await createCompany(); ids.push(companyId);
      const root = path.join(resolveCompanySkillVersionsRoot(companyId), randomUUID());
      await fs.mkdir(root, { recursive: true });
      for (let entry = 0; entry < 55; entry++) await fs.mkdir(path.join(root, `operator-${entry}`));
    }
    const opened = vi.spyOn(fs, "opendir");
    await startRetention(); await settled();
    for (const id of ids) expect(opened.mock.calls.filter(([directory]) => directory === resolveCompanySkillVersionsRoot(id))).toHaveLength(1);
    opened.mockRestore(); await quiet();
  });

  it("wakes ordinary skill deletion and removes its unpinned orphan caches", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    await startRetention(); await settled(); await quiet();
    await companySkillService(db).deleteSkill(companyId, skillId);
    await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it("observes abandoned staging after a failed materialization flight", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    await startRetention(); await settled(); await quiet();
    let staging = "";
    await expect(runVersionSnapshotFlight(path.join(resolveCompanySkillVersionsRoot(companyId), skillId, versionIds[0]!), async () => {
      staging = await writeSnapshot(companyId, skillId, `.${versionIds[0]}-abc123`, 0);
      throw new Error("interrupted publication");
    })).rejects.toThrow("interrupted publication");
    const deadline = (await fs.stat(staging)).mtimeMs + 20_000;
    await settled(deadline); await vi.advanceTimersByTimeAsync(deadline - Date.now()); await settled();
    expect(await exists(staging)).toBe(false); await quiet();
  });

  it("retries incomplete pins only for the affected company and disarms after terminal settlement", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Unknown pins", adapterType: "codex_local" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", contextSnapshot: null }).returning();
    await startRetention(); expect(await exists(directory)).toBe(true);
    expect(coordinator!.nextWakeAt()).toBeGreaterThan(Date.now()); await quiet(5000);
    await db.transaction(async tx => {
      await notifyInstructionCollection(tx, { companyId, runId: run!.id });
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    });
    await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it("reconstructs beyond one company page without repeating settled companies", async () => {
    for (let index = 0; index < 55; index++) await createCompany();
    const service = skillVersionRetentionService(db);
    const listed = vi.spyOn(service, "listCompanies"), pruned = vi.spyOn(service, "pruneCompany");
    await startRetention(20_000, service); await settled();
    expect(listed).toHaveBeenCalledTimes(2); expect(pruned).toHaveBeenCalledTimes(55);
    expect(new Set(pruned.mock.calls.map(([id]) => id)).size).toBe(55); await quiet();
  });

  it.each(["inspection", "rename"])("restarts a company page interrupted during %s so cleanup is not forgotten", async stage => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    for (let index = 0; index < 60; index++) await fs.mkdir(path.join(path.dirname(directory), `operator-${index}`));
    let paused = false;
    const list = fs.readdir, rename = fs.rename;
    const reading = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
      const entries = await list(...args);
      if (stage === "inspection" && !paused && args[0] === directory) { paused = true; admitted = false; }
      return entries;
    });
    const renaming = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      if (stage === "rename" && !paused && args[0] === directory) { paused = true; admitted = false; }
    });
    await startRetention(0);
    await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(1000); expect(paused).toBe(true); });
    reading.mockRestore(); renaming.mockRestore(); admitted = true;
    await settled(); expect(await exists(directory)).toBe(false);
    expect((await fs.readdir(path.dirname(directory))).filter(name => name.startsWith(".trash-"))).toEqual([]);
    await quiet();
  });

  it("reports dry-run candidates and bytes while keeping the cache intact", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const reported = vi.spyOn(logger, "info");
    await startRetention(0, skillVersionRetentionService(db, { dryRun: true, graceMs: 0 })); await settled();
    expect(reported.mock.calls).toEqual(expect.arrayContaining([[expect.objectContaining({ companyId,
      candidates: 1, candidateBytes: expect.any(Number), dryRun: true }), "skill version snapshot retention"]]));
    const report = reported.mock.calls.find(([value]) => value && typeof value === "object" && "candidateBytes" in value)![0] as { candidateBytes: number };
    expect(report.candidateBytes).toBeGreaterThan(0); expect(await exists(directory)).toBe(true); await quiet();
  });

  it("wakes the missing-local-source reconciliation deletion path", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    const source = path.join(paperclipHome!, "local-source");
    await fs.mkdir(source, { recursive: true }); await fs.writeFile(path.join(source, "SKILL.md"), "# Local source");
    await db.update(companySkills).set({ sourceType: "local_path", sourceLocator: source }).where(eq(companySkills.id, skillId));
    const service = companySkillService(db); await service.list(companyId);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!);
    await startRetention(); await settled(); await quiet();
    await fs.rm(source, { recursive: true, force: true }); await service.list(companyId);
    expect(await db.select().from(companySkills).where(eq(companySkills.id, skillId))).toEqual([]);
    await settled(); expect(await exists(directory)).toBe(false); await quiet();
  });

  it("coalesces repeated run settlement into one fresh company scan per thirty seconds", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    await writeSnapshot(companyId, skillId, versionIds[0]!);
    const service = skillVersionRetentionService(db), pruned = vi.spyOn(service, "pruneCompany");
    await startRetention(20_000, service); await settled();
    for (let index = 0; index < 10; index++) {
      await db.transaction(tx => notifyInstructionCollection(tx, { companyId }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(pruned).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); await settled(); expect(pruned).toHaveBeenCalledTimes(2); await quiet();
  });

  it.each(["empty", "uncertain"] as const)("bounds fresh $0-company scans across repeated scoped settlement", async state => {
    const companyId = await createCompany(), otherId = await createCompany();
    let runId: string | undefined;
    if (state === "uncertain") {
      const { skillId, versionIds } = await createSkill(companyId, 2);
      await writeSnapshot(companyId, skillId, versionIds[0]!);
      const [agent] = await db.insert(agents).values({ companyId, name: "Unknown pins", adapterType: "codex_local" }).returning();
      const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", contextSnapshot: null }).returning();
      runId = run!.id;
    }
    const service = skillVersionRetentionService(db), pruned = vi.spyOn(service, "pruneCompany");
    const discovered = vi.spyOn(service, "listCompanies");
    await startRetention(20_000, service);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    for (let index = 0; index < 10; index++) {
      await db.transaction(tx => notifyNativeEnvironmentSettlement(tx, { companyId }));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(discovered).toHaveBeenCalledOnce();
    expect(pruned.mock.calls.filter(([id]) => id === companyId)).toHaveLength(1);
    expect(pruned.mock.calls.filter(([id]) => id === otherId)).toHaveLength(1);
    if (runId) await db.transaction(async tx => {
      await notifyInstructionCollection(tx, { companyId, runId });
      await tx.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId!));
    });
    await vi.advanceTimersByTimeAsync(30_000); await settled();
    expect(pruned.mock.calls.filter(([id]) => id === companyId)).toHaveLength(2);
    expect(pruned.mock.calls.filter(([id]) => id === otherId)).toHaveLength(1);
    await quiet();
  });

  it("does not rediscover tenant caches after a runless environment notification", async () => {
    const companyId = await createCompany(), otherId = await createCompany();
    const service = skillVersionRetentionService(db), pruned = vi.spyOn(service, "pruneCompany");
    const discovered = vi.spyOn(service, "listCompanies");
    await startRetention(20_000, service); await settled();
    for (let index = 0; index < 10; index++) {
      await db.transaction(tx => notifyNativeEnvironmentSettlement(tx));
      await vi.advanceTimersByTimeAsync(1000);
    }
    await settled();
    expect(discovered).toHaveBeenCalledOnce();
    expect(pruned.mock.calls.map(([id]) => id).sort()).toEqual([companyId, otherId].sort());
    await quiet();
  });

  it("coalesces repeated instance reconstruction without restarting global discovery", async () => {
    await createCompany(); await createCompany();
    const service = skillVersionRetentionService(db), discovered = vi.spyOn(service, "listCompanies");
    await startRetention(20_000, service); await settled();
    for (let index = 0; index < 10; index++) {
      await instanceSettingsService(db).updateExperimental({ enableWorktreeRunExecution: index % 2 === 0 });
      await vi.advanceTimersByTimeAsync(1000);
    }
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    expect(discovered).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000); await settled();
    expect(discovered).toHaveBeenCalledTimes(2); await quiet();
  });

  it("retains a new cache grace deadline that arrives after a company scan read", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    await writeSnapshot(companyId, skillId, versionIds[1]!);
    const service = skillVersionRetentionService(db, { graceMs: 5000 });
    const prune = service.pruneCompany;
    const began = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let held = false;
    service.pruneCompany = async (...args) => {
      const result = await prune(...args);
      if (held) { began.resolve(); await release.promise; }
      return result;
    };
    await startRetention(5000, service); await settled(); held = true;
    await db.transaction(tx => notifyInstructionCollection(tx, { companyId }));
    const advancing = vi.advanceTimersByTimeAsync(30_000);
    let directory = "", deadline = 0;
    try {
      await began.promise;
      directory = await writeSnapshot(companyId, skillId, versionIds[0]!, 0);
      deadline = (await lastUsedAt(skillVersionCachePaths(companyId, skillId, versionIds[0]!).access))! + 5000;
    } finally { held = false; release.resolve(); }
    await advancing; await settled(deadline);
    await vi.advanceTimersByTimeAsync(deadline - Date.now()); await settled();
    expect(await exists(directory)).toBe(false); await quiet();
  });

  it("lets an actual five-second grace deadline preempt the fresh scan limit", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const directory = await writeSnapshot(companyId, skillId, versionIds[0]!, 0);
    const deadline = (await lastUsedAt(skillVersionCachePaths(companyId, skillId, versionIds[0]!).access))! + 5000;
    await startRetention(5000); await settled(deadline);
    await db.transaction(tx => notifyInstructionCollection(tx, { companyId }));
    await vi.advanceTimersByTimeAsync(deadline - Date.now()); await settled();
    expect(await exists(directory)).toBe(false); await quiet();
  });

  it("keeps directory pages moving while another company's grace deadline is due", async () => {
    const dueCompany = await createCompany(), pagedCompany = await createCompany();
    const dueSkill = await createSkill(dueCompany, 2), pagedSkill = await createSkill(pagedCompany, 1);
    const expiring = await writeSnapshot(dueCompany, dueSkill.skillId, dueSkill.versionIds[0]!, 0);
    const parent = path.join(resolveCompanySkillVersionsRoot(pagedCompany), pagedSkill.skillId);
    await fs.mkdir(parent, { recursive: true });
    for (let index = 0; index < 410; index++) await fs.mkdir(path.join(parent, `operator-${index}`));
    const service = skillVersionRetentionService(db, { graceMs: 5000 });
    vi.spyOn(service, "listCompanies").mockResolvedValue([{ id: dueCompany }, { id: pagedCompany }]);
    const prune = service.pruneCompany, pageTimes: number[] = [];
    service.pruneCompany = async (id, options) => {
      if (id === pagedCompany) pageTimes.push(Date.now());
      return prune(id, options);
    };
    await startRetention(5000, service); await settled();
    expect(pageTimes.length).toBeGreaterThan(5);
    expect(Math.max(...pageTimes.slice(1).map((at, index) => at - pageTimes[index]!))).toBeLessThan(3000);
    expect(await exists(expiring)).toBe(false); await quiet();
  });

  it("waits for an admitted page before disposing its scan on shutdown", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    await writeSnapshot(companyId, skillId, versionIds[0]!);
    const service = skillVersionRetentionService(db), prune = service.pruneCompany;
    const release = Promise.withResolvers<void>(), began = Promise.withResolvers<void>();
    service.pruneCompany = async (...args) => { began.resolve(); await release.promise; return prune(...args); };
    const disposed = vi.spyOn(service, "dispose");
    const starting = startRetention(20_000, service); await began.promise;
    worker!.unsubscribe();
    const stopping = coordinator!.stop().then(() => worker!.dispose());
    await realDelay(30); expect(disposed).not.toHaveBeenCalled();
    release.resolve(); await starting; await stopping;
    expect(disposed).toHaveBeenCalledOnce(); expect(coordinator!.nextWakeAt()).toBeNull();
  });

  it("keeps current, pinned, live-run, newest, and recent versions and removes superseded ones", async () => {
    const companyId = await createCompany();
    const { skillId, key, versionIds: v } = await createSkill(companyId, 7);
    const [agent] = await db.insert(agents).values({
      companyId, name: "Pinned agent",
      adapterConfig: { paperclipSkillSync: { desiredSkills: [{ key, versionId: v[0] }] } },
    }).returning({ id: agents.id });
    await db.insert(heartbeatRuns).values([
      { companyId, agentId: agent!.id, status: "running", contextSnapshot: { skillVersions: { [key]: v[1] } } },
      { companyId, agentId: agent!.id, status: "succeeded", finishedAt: new Date(), contextSnapshot: { skillVersions: { [key]: v[2] } } },
    ]);
    const dirs = await Promise.all(v.map((id, index) => writeSnapshot(companyId, skillId, id, index === 3 ? 0 : 3 * HOUR_MS)));

    const result = await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 2 });

    // v1 pinned, v2 live run, v4 recent, v6 + v7 newest (v7 current).
    expect(await Promise.all(dirs.map(exists))).toEqual([true, true, false, true, false, true, true]);
    expect(result).toMatchObject({ removed: 2, removedOrphans: 0, skippedRecent: 1, failed: 0, truncated: false });
    // Rows are never deleted.
    expect(await db.select().from(companySkillVersions).where(eq(companySkillVersions.companySkillId, skillId))).toHaveLength(7);
  });

  it("removes orphan version folders, orphan skill folders, and stale staging folders", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 1);
    const root = resolveCompanySkillVersionsRoot(companyId);
    const current = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const orphanVersion = await writeSnapshot(companyId, skillId, randomUUID());
    const orphanSkillId = randomUUID();
    const orphanSkillVersion = await writeSnapshot(companyId, orphanSkillId, randomUUID());
    const staleStaging = await writeSnapshot(companyId, skillId, `.${versionIds[0]}-abc123`);
    const freshStaging = await writeSnapshot(companyId, skillId, `.${versionIds[0]}-def456`, 0);
    const leftoverTrash = await writeSnapshot(companyId, skillId, `\.trash-${randomUUID()}`, 0);
    const unknown = await writeSnapshot(companyId, skillId, "operator-notes");
    const hidden = await writeSnapshot(companyId, skillId, ".notes");

    const result = await skillVersionRetentionService(db).pruneCompany(companyId);

    expect(await exists(current)).toBe(true);
    expect(await exists(orphanVersion)).toBe(false);
    expect(await exists(orphanSkillVersion)).toBe(false);
    expect(await fs.readdir(path.join(root, orphanSkillId))).toEqual([]);
    expect(await exists(staleStaging)).toBe(false);
    expect(await exists(freshStaging)).toBe(true);
    expect(await exists(leftoverTrash)).toBe(false);
    expect(await exists(unknown)).toBe(true);
    expect(await exists(hidden)).toBe(true);
    expect(result).toMatchObject({ removedOrphans: 2, removedStaging: 1, failed: 0 });
    expect((await fs.readdir(path.join(root, skillId))).filter(name => name.startsWith(".trash-"))).toEqual([]);
  });

  it("re-materializes a pruned version from its row on the next resolve", async () => {
    const companyId = await createCompany();
    const { key, versionIds } = await createSkill(companyId, 5);
    const svc = companySkillService(db);
    const selections = new Map([[key, versionIds[0]!]]);
    const first = (await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections }))
      .find(entry => entry.key === key)!;
    expect(first.sourceStatus).toBe("available");
    const old = new Date(Date.now() - 3 * HOUR_MS);
    await touchSkillVersionCache(companyId, path.basename(path.dirname(first.source)), path.basename(first.source), old.getTime());

    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(await exists(first.source)).toBe(false);

    const again = (await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections }))
      .find(entry => entry.key === key)!;
    expect(again).toMatchObject({ sourceStatus: "available", source: first.source });
    expect(await fs.readFile(path.join(again.source, "SKILL.md"), "utf8")).toContain("# Revision 1");
  });

  it("refreshes the age of a reused snapshot so the grace window protects it", async () => {
    const companyId = await createCompany();
    const { key, versionIds } = await createSkill(companyId, 5);
    const svc = companySkillService(db);
    const selections = new Map([[key, versionIds[0]!]]);
    const first = (await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections }))
      .find(entry => entry.key === key)!;
    const old = new Date(Date.now() - 3 * HOUR_MS);
    await touchSkillVersionCache(companyId, path.basename(path.dirname(first.source)), path.basename(first.source), old.getTime());
    await svc.listRuntimeSkillEntries(companyId, { versionSelections: selections });

    const result = await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(result.skippedRecent).toBe(1);
    expect(await exists(first.source)).toBe(true);
  });

  it("skips a version folder while a materialization holds it", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 3);
    const dir = await writeSnapshot(companyId, skillId, versionIds[0]!);
    let release!: () => void;
    const held = runVersionSnapshotFlight(dir, () => new Promise<string>(resolve => { release = () => resolve(dir); }));

    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(await exists(dir)).toBe(true);
    release();
    await held;
    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });
    expect(await exists(dir)).toBe(false);
  });

  it("sweeps deleted skills after protecting existing runs", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 2);
    const first = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const second = await writeSnapshot(companyId, skillId, versionIds[1]!);
    const [agent] = await db.insert(agents).values({ companyId, name: "Detached agent" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running",
      contextSnapshot: { skillVersions: { retained: versionIds[0] } } }).returning();
    await companySkillService(db).deleteSkill(companyId, skillId);
    expect(await exists(first)).toBe(true);
    await skillVersionRetentionService(db).pruneCompany(companyId);
    expect(await exists(first)).toBe(true);
    expect(await exists(second)).toBe(false);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
    await skillVersionRetentionService(db).pruneCompany(companyId);
    expect(await exists(first)).toBe(false);
  });

  it("never removes anything outside the company's versions root", async () => {
    const companyId = await createCompany();
    const otherCompanyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 3);
    const other = await createSkill(otherCompanyId, 3);
    const otherDirs = await Promise.all(other.versionIds.map(id => writeSnapshot(otherCompanyId, other.skillId, id)));
    const outside = await fs.mkdtemp(path.join(paperclipHome!, "outside-"));
    await fs.writeFile(path.join(outside, "keep.txt"), "keep");
    const root = resolveCompanySkillVersionsRoot(companyId);
    const victim = await writeSnapshot(companyId, skillId, versionIds[0]!);
    const safe = await writeSnapshot(companyId, skillId, versionIds[1]!);
    await fs.chmod(victim, 0o755);
    await fs.symlink(outside, path.join(victim, "escape"));
    const old = new Date(Date.now() - 3 * HOUR_MS);
    await fs.utimes(victim, old, old);
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, randomUUID()));
    await fs.symlink(outside, path.join(root, skillId, randomUUID()));

    await skillVersionRetentionService(db).pruneCompany(companyId, { keepNewest: 1 });

    expect(await exists(victim)).toBe(true);
    expect(await exists(safe)).toBe(false);
    expect(await fs.readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(await Promise.all(otherDirs.map(exists))).toEqual([true, true, true]);
  });

  it("bounds removals per tick and continues on the next tick", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 6);
    await Promise.all(versionIds.map(id => writeSnapshot(companyId, skillId, id)));
    const retention = skillVersionRetentionService(db, { keepNewest: 1, maxRemovals: 2 });

    let total = 0;
    for (let index = 0; index < 5; index++) {
      const result = await retention.tick();
      expect(result.checked).toBeLessThanOrEqual(2);
      total += result.removed;
      if (!result.truncated) break;
    }
    expect(total).toBe(5);
    expect(await fs.readdir(path.join(resolveCompanySkillVersionsRoot(companyId), skillId))).toEqual([versionIds[5]]);
  });
  it("bounds directory reads and retains the discovery cursor between pages", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 100);
    await Promise.all(versionIds.map(id => writeSnapshot(companyId, skillId, id)));
    const parent = path.join(resolveCompanySkillVersionsRoot(companyId), skillId);
    const originalOpen = fs.opendir.bind(fs);
    let reads = 0;
    const opened = vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
      const directory = await originalOpen(...args);
      const read = directory.read.bind(directory);
      vi.spyOn(directory, "read").mockImplementation(async () => { reads++; return read(); });
      return directory;
    });
    const stat = vi.spyOn(fs, "lstat");
    const retention = skillVersionRetentionService(db, { maxEntries: 2, dryRun: true });
    try {
      const first = await retention.tick();
      expect(first).toMatchObject({ checked: 2, truncated: true });
      expect(reads).toBeLessThanOrEqual(2);
      const inspected = () => new Set(stat.mock.calls.map(call => String(call[0]))
        .filter(file => path.dirname(file) === parent).map(file => path.basename(file)));
      const firstPaths = inspected();
      expect(firstPaths.size).toBe(1); // Opening the skill root also consumes a slot.
      stat.mockClear(); reads = 0;
      const second = await retention.tick();
      expect(second).toMatchObject({ checked: 2, truncated: true });
      expect(reads).toBe(2);
      expect(inspected().size).toBe(2);
      expect([...inspected()].some(name => firstPaths.has(name))).toBe(false);
      expect(opened.mock.calls.filter(call => call[0] === parent)).toHaveLength(1);
    } finally { await retention.dispose(); }
  });

  it("continues beyond a page ending at an exhausted skill root", async () => {
    const companyId = await createCompany();
    const roots = [1, 2, 3].map(value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`);
    await Promise.all([randomUUID(), randomUUID()].map(id => writeSnapshot(companyId, roots[0]!, id, 0)));
    await fs.mkdir(path.join(resolveCompanySkillVersionsRoot(companyId), roots[1]!), { recursive: true });
    const versions = Array.from({ length: 5 }, () => randomUUID()).sort();
    const paths = await Promise.all(versions.map((id, index) => writeSnapshot(companyId, roots[2]!, id, index === 4 ? 3 * HOUR_MS : 0)));
    const retention = skillVersionRetentionService(db, { maxEntries: 3 });
    let reclaimed = 0;
    for (let page = 0; page < 5; page++) {
      const result = await retention.tick();
      expect(result.checked).toBeLessThanOrEqual(3);
      reclaimed += result.removed;
      if (!result.truncated) break;
    }
    expect(reclaimed).toBe(1);
    expect(await exists(paths[4]!)).toBe(false);
    expect(await Promise.all(paths.slice(0, 4).map(exists))).toEqual([true, true, true, true]);
  });

  it("bounds failed attempts and continues beyond them", async () => {
    const companyId = await createCompany();
    const { skillId, versionIds } = await createSkill(companyId, 6);
    await Promise.all(versionIds.map(id => writeSnapshot(companyId, skillId, id)));
    const rename = vi.spyOn(fs, "rename").mockRejectedValue(Object.assign(new Error("read-only fixture"), { code: "EACCES" }));
    const retention = skillVersionRetentionService(db, { maxRemovals: 2 });
    let checked = 0;
    let failures = 0;
    for (let index = 0; index < 5; index++) {
      const result = await retention.tick();
      expect(result.checked).toBeLessThanOrEqual(2);
      checked += result.checked;
      failures += result.failed;
      if (!result.truncated) break;
    }
    expect(checked).toBe(7); // Six versions plus the skill-root discovery slot.
    expect(failures).toBe(5);
    expect(rename).toHaveBeenCalledTimes(5);
  });

});
