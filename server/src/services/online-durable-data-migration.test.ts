import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { StorageService } from "../storage/index.js";
import { runOnlineDurableDataMigration } from "./online-durable-data-migration.js";

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
    nativeHarnessBackups: page("nativeHarnessBackups", { inspected: 1, published: 1, current: 0, deferred: { source_active: 2 } }),
    nativeControllers: page("nativeControllers", { inspected: 1, imported: 1, unchanged: 0, archivedFailed: 0, sourceAlreadyAbsent: 0, deferred: {} }),
    eligibility: vi.fn(async () => ({ eligible: false, blockers: ["skills_require_migration"], controller: null })),
    ...overrides,
  };
  return { owners: base as never, calls, eligibility: base.eligibility };
}

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
      blockers: ["skills_require_migration"],
    });
    expect(fixture.eligibility).toHaveBeenCalledWith(db, { purpose: "startup" });
  });

  it("migrates agent files with live writers, never the offline mode", async () => {
    const agentFiles = vi.fn(async () => ({ results: [], next: null }));
    await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, owners({ agentFiles }).owners);
    expect(agentFiles).toHaveBeenCalledWith(db, expect.objectContaining({ apply: true, writersStopped: false }));
  });

  it.each([
    [{ storage: () => local }, "shared_object_storage_required"],
    [{ durableAgentFiles: () => false }, "durable_agent_files_disabled"],
  ])("does nothing on a server that would keep writing local data (%#)", async (override, reason) => {
    const fixture = owners(override);
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000 }, fixture.owners);
    expect(result).toMatchObject({ state: "unsupported", reason, counts: {}, eligible: false });
    expect(fixture.calls).toEqual([]);
  });

  it("stops between owners when the budget is spent and still reports eligibility", async () => {
    let clock = 0;
    const fixture = owners({ agentFiles: async () => { clock += 61_000; return { results: [], next: null }; } });
    const result = await runOnlineDurableDataMigration(db, { budgetMs: 60_000, now: () => clock }, fixture.owners);
    expect(result.state).toBe("budget_exhausted");
    expect(fixture.calls).toEqual([]);
    expect(fixture.eligibility).toHaveBeenCalledOnce();
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
