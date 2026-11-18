import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import { resetOnlineDurableDataMigrationProgressForTests, runOnlineDurableDataMigration } from "./online-durable-data-migration.js";

const db = {} as Db;
const s3 = { provider: "s3" } as StorageService;
const local = { provider: "local_disk" } as StorageService;

function owners(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const page = <T>(name: string, value: T) => async () => { calls.push(name); return value; };
  const base = {
    storage: () => s3,
    localSkillStorage: () => local,
    durableAgentFiles: () => true,
    agentFiles: page("agentFiles", { results: [{ agentId: "a1", state: "durable" }, { agentId: "a2", state: "active_execution" }], next: null }),
    skillObjects: page("skillObjects", { inspected: 2, migrated: 1, busy: 1, after: null }),
    skillPackages: () => ({
      migrateSnapshots: page("skillSnapshots", { inspected: 1, migrated: 1, after: null }),
      migrateVersions: page("skillVersions", { inspected: 0, migrated: 0, after: null }),
    }),
    skillInstallations: () => ({ installations: page("skillInstallations", { inspected: 3, after: null, results: [
      { skillId: "s1", companyId: "c", status: "converted" }, { skillId: "s2", companyId: "c", status: "unchanged" },
      { skillId: "s3", companyId: "c", status: "linked_local" }] }) }),
    runtimeSkillAssets: page("runtimeSkillAssets", { inspected: 1, after: null, results: [{ runId: "r1", status: "preserved" }] }),
    nativeHarnessBackups: async (_db: Db, input: { onOutcome?: (outcome: string) => void }) => {
      calls.push("nativeHarnessBackups");
      for (const outcome of ["published", "current", "source_active", "source_active"]) input.onOutcome?.(outcome);
      return { inspected: 4, published: 1, current: 1, deferred: { source_active: 2 } };
    },
    nativeControllers: async (_db: Db, input: { onOutcome?: (outcome: string) => void }) => {
      calls.push("nativeControllers");
      for (const outcome of ["imported", "unchanged"]) input.onOutcome?.(outcome);
      return { inspected: 2, imported: 1, unchanged: 1, archivedFailed: 0, sourceAlreadyAbsent: 0, deferred: {} };
    },
    eligibility: vi.fn(async () => ({ eligible: false, blockers: ["skills_require_migration", "volume_free_storage_flags_required"] })),
    record: vi.fn(async () => undefined),
    ...overrides,
  };
  return { owners: base as never, calls, eligibility: base.eligibility, record: base.record };
}

beforeEach(() => resetOnlineDurableDataMigrationProgressForTests());

describe("online durable-data migration pass", () => {
  it("drives every online-safe owner while serving and reports what it moved and what it left", async () => {
    const fixture = owners();
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(fixture.calls).toEqual(["agentFiles", "skillObjects", "skillSnapshots", "skillVersions", "skillInstallations",
      "runtimeSkillAssets", "nativeHarnessBackups", "nativeControllers"]);
    expect(result).toEqual({
      state: "completed",
      counts: { agentFiles: 1, skillObjects: 1, skillSnapshots: 1, skillInstallations: 1, runtimeSkillRuns: 1, nativeHarnessBackups: 1, nativeControllers: 1 },
      deferred: { "agent_files:active_execution": 1, "skill_objects:owner_busy": 1, "skills:linked_local": 1, "native_harness:source_active": 2 },
      eligible: false,
      blockers: ["skills_require_migration", "volume_free_storage_flags_required"],
    });
    expect(fixture.eligibility).toHaveBeenCalledWith(db);
    expect(fixture.record).toHaveBeenCalledWith(db, result);
  });

  it("migrates agent files with live writers, never the offline mode", async () => {
    const agentFiles = vi.fn(async () => ({ results: [], next: null }));
    await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, owners({ agentFiles }).owners);
    expect(agentFiles).toHaveBeenCalledWith(db, expect.objectContaining({ apply: true, writersStopped: false, limit: 5, signal: expect.any(AbortSignal) }));
  });

  it.each([
    [{ storage: () => local }, "shared_object_storage_required"],
    [{ durableAgentFiles: () => false }, "durable_agent_files_disabled"],
  ])("does nothing on a server that would keep writing local data (%#)", async (override, reason) => {
    const fixture = owners(override);
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(result).toMatchObject({ state: "unsupported", reason, counts: {}, eligible: false });
    expect(fixture.calls).toEqual([]);
    expect(fixture.record).toHaveBeenCalledOnce();
  });

  it("resumes where the last budget ended instead of rescanning finished rows", async () => {
    let clock = 0;
    const seen: Array<string | undefined> = [];
    const runtimeSkillAssets = vi.fn(async (_db: Db, options: { after?: string }) => {
      seen.push(options.after);
      clock += 40_000;
      const start = Number(options.after ?? 0);
      return { inspected: 50, after: String(start + 50), results: [] };
    });
    const fixture = owners({ runtimeSkillAssets });
    const run = () => runOnlineDurableDataMigration(db, { budgetMs: 60_000, now: () => clock }, fixture.owners);
    expect(await run()).toMatchObject({ state: "budget_exhausted", resumePhase: "runtime_skill_assets" });
    expect(await run()).toMatchObject({ state: "budget_exhausted", resumePhase: "runtime_skill_assets" });
    expect(seen).toEqual([undefined, "50", "100", "150"]);
    expect(fixture.calls.filter(call => call === "agentFiles")).toHaveLength(1);
  });

  it("reaches the later owners over repeated budget-limited calls", async () => {
    let clock = 0;
    const slow = (name: string, value: unknown) => vi.fn(async () => { clock += 70_000; return value; });
    const fixture = owners({
      agentFiles: slow("agentFiles", { results: [], next: null }),
      runtimeSkillAssets: slow("runtimeSkillAssets", { inspected: 0, after: null, results: [] }),
    });
    const run = () => runOnlineDurableDataMigration(db, { budgetMs: 60_000, now: () => clock }, fixture.owners);
    expect((await run()).state).toBe("budget_exhausted");
    expect((await run()).state).toBe("budget_exhausted");
    expect((await run()).state).toBe("completed");
    expect(fixture.calls).toContain("nativeControllers");
  });

  it("stops an owner that overruns the budget and keeps the work it already finished", async () => {
    const nativeHarnessBackups = vi.fn(async (_db: Db, input: { signal: AbortSignal; onOutcome?: (outcome: string) => void }) => {
      input.onOutcome?.("published");
      input.onOutcome?.("source_active");
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const fixture = owners({ nativeHarnessBackups });
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 20 }, fixture.owners);
    expect(result).toMatchObject({ state: "budget_exhausted", resumePhase: "native_harness_backups",
      counts: { agentFiles: 1, nativeHarnessBackups: 1 }, deferred: { "native_harness:source_active": 1 } });
    expect(fixture.record).toHaveBeenCalledWith(db, result);
  });

  it("halves a page that overruns the budget, then skips an owner whose single item keeps overrunning", async () => {
    const limits: number[] = [];
    const runtimeSkillAssets = vi.fn(async (_db: Db, input: { limit: number; signal: AbortSignal }) => {
      limits.push(input.limit);
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const fixture = owners({ runtimeSkillAssets });
    let last;
    for (let pass = 0; pass < 9 && !fixture.calls.includes("nativeControllers"); pass++) {
      last = await runOnlineDurableDataMigration(db, { budgetMs: 10 }, fixture.owners);
    }
    expect(limits).toEqual([50, 25, 12, 6, 3, 1, 1]);
    expect(fixture.calls).toContain("nativeControllers");
    expect(last).toMatchObject({ state: "completed", deferred: expect.objectContaining({}) });
    expect(fixture.record).toHaveBeenCalledWith(db, expect.objectContaining({ deferred: expect.objectContaining({ "runtime_skill_assets:stalled": 1 }) }));
  });

  it("defers an owner that fails and revisits earlier owners on the next cycle, so an abandoned claim cannot pin it", async () => {
    let versionsFail = true;
    const objectCalls: number[] = [];
    const fixture = owners({
      skillObjects: async () => { objectCalls.push(1); versionsFail = objectCalls.length < 2; return { inspected: 1, migrated: 1, busy: 0, after: null }; },
      skillPackages: () => ({
        migrateSnapshots: async () => ({ inspected: 0, migrated: 0, after: null }),
        migrateVersions: async () => {
          if (versionsFail) throw new Error("skill_package_not_durable");
          return { inspected: 1, migrated: 1, after: null };
        },
      }),
    });
    const first = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(first).toMatchObject({ state: "completed", deferred: expect.objectContaining({ "skill_versions:skill_package_not_durable": 1 }) });
    expect(fixture.calls).toContain("nativeControllers");
    const second = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(objectCalls).toHaveLength(2);
    expect(second).toMatchObject({ state: "completed", counts: expect.objectContaining({ skillVersions: 1 }) });
    expect(second.deferred).not.toHaveProperty("skill_versions:skill_package_not_durable");
  });

  it("keeps a qualified owner code such as a missing runtime skill source", async () => {
    const fixture = owners({ runtimeSkillAssets: async () => { throw new Error("runtime_skill_source_absent:missing"); } });
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(result.deferred).toMatchObject({ "runtime_skill_assets:runtime_skill_source_absent:missing": 1 });
  });

  it("passes the page size to the skill object copy so a slow page can shrink", async () => {
    const skillObjects = vi.fn(async () => ({ inspected: 0, migrated: 0, busy: 0, after: null }));
    await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, owners({ skillObjects }).owners);
    expect(skillObjects).toHaveBeenCalledWith(db, expect.objectContaining({ limit: 50, online: true }));
  });

  it("names an unexpected owner error without echoing its message", async () => {
    const fixture = owners({ skillObjects: async () => { throw new Error("connect ECONNREFUSED 10.0.0.1:5432 secret"); } });
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(result.deferred).toMatchObject({ "skill_objects:owner_failed": 1 });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("runs one pass at a time and shares it with a concurrent caller", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const agentFiles = vi.fn(async () => { await gate; return { results: [], next: null }; });
    const fixture = owners({ agentFiles });
    const first = runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    const second = runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    release();
    expect(await second).toBe(await first);
    expect(agentFiles).toHaveBeenCalledOnce();
  });
});
