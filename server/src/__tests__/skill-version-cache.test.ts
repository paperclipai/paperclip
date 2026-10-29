import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { applyPendingMigrations } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issues, nativeRunFinalizations, environmentLeases, companies, companySkills, companySkillVersions, companySkillRepositorySnapshots, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companySkillService } from "../services/company-skills.js";
import { skillVersionCachePaths, touchSkillVersionCache, withSkillVersionCacheLock } from "../services/skill-version-cache.js";

import { skillVersionRetentionService } from "../services/skill-version-retention.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
async function sweepSkillVersionCache(db: ReturnType<typeof createDb>, options: { companyId: string; now?: number; dryRun?: boolean }) {
  const result = await skillVersionRetentionService(db).pruneCompany(options.companyId, { dryRun: options.dryRun, now: options.now === undefined ? undefined : new Date(options.now) });
  return { ...result, evicted: result.removed };
}

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_SKILL_CACHE_TEST_DATABASE_URL");
const support = external ? { supported: true, reason: undefined } : await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skill cache tests require Postgres: ${support.reason}`);

describePostgres("immutable skill version cache", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;
  let home: string;
  const previousHome = process.env.PAPERCLIP_HOME;

  beforeAll(async () => {
    if (!external) database = await startEmbeddedPostgresTestDatabase("skill-version-cache-");
    if (external) await applyPendingMigrations(external);
    db = createDb(external ?? database!.connectionString);
    home = await fs.mkdtemp(path.join(os.tmpdir(), "skill-version-cache-"));
    process.env.PAPERCLIP_HOME = home;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    if (home) await fs.rm(home, { recursive: true, force: true });
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const skillId = randomUUID();
    const key = `company/${companyId}/saved-repository`;
    await db.insert(companies).values({ id: companyId, name: "Skill cache", issuePrefix: `S${companyId.slice(0, 6)}` });
    await db.insert(companySkills).values({ id: skillId, companyId, key, slug: "saved-repository", name: "Saved repository",
      markdown: "# Saved skill", sourceType: "github", sourceLocator: "https://github.com/example/unavailable",
      metadata: { skillSourceId: randomUUID(), snapshotHash: "saved" } });
    const versions = [];
    for (const revision of [1, 2]) {
      const [snapshot] = await db.insert(companySkillRepositorySnapshots).values({ companyId, contentHash: `revision-${revision}`,
        fileInventory: [
          { path: "skills/example/SKILL.md", kind: "skill", content: `---\nname: saved-repository\ndescription: Saved revision ${revision}\n---\nRun ../../scripts/example.sh.\n` },
          { path: "scripts/example.sh", kind: "script", content: `#!/bin/sh\necho revision-${revision}\n`, executable: true },
          { path: "marker.bin", kind: "reference", content: Buffer.from([0, revision, 255]).toString("base64"), encoding: "base64" },
        ] }).returning();
      const [version] = await db.insert(companySkillVersions).values({ companyId, companySkillId: skillId, revisionNumber: revision,
        repositorySnapshotId: snapshot!.id, repositorySkillPath: "skills/example/SKILL.md" }).returning();
      versions.push(version!);
    }
    await db.update(companySkills).set({ currentVersionId: versions[1]!.id }).where(eq(companySkills.id, skillId));
    const service = companySkillService(db);
    async function resolve(versionId: string) {
      const entries = await service.listRuntimeSkillEntries(companyId, { onlyKeys: new Set([key]), versionSelections: new Map([[key, versionId]]) });
      expect(entries).toHaveLength(1);
      expect(entries[0]!.sourceStatus, entries[0]!.missingDetail ?? undefined).toBe("available");
      return entries[0]!;
    }
    return { companyId, skillId, key, versions, resolve };
  }

  it("rebuilds an old repository-backed version from database bytes with upstream unavailable", async () => {
    const upstream = vi.fn(() => Promise.reject(new Error("Upstream is unavailable")));
    vi.stubGlobal("fetch", upstream);
    const { versions, resolve } = await fixture();
    const old = await resolve(versions[0]!.id);
    const current = await resolve(versions[1]!.id);
    await fs.rm(old.source, { recursive: true });
    const restored = await resolve(versions[0]!.id);
    expect(restored.source).toBe(old.source);
    const repository = path.join(restored.source, ".paperclip-repository");
    expect(await fs.readFile(path.join(repository, "marker.bin"))).toEqual(Buffer.from([0, 1, 255]));
    expect(await fs.readFile(path.join(repository, "scripts/example.sh"), "utf8")).toBe("#!/bin/sh\necho revision-1\n");
    expect((await fs.stat(path.join(repository, "scripts/example.sh"))).mode & 0o111).toBe(0o111);
    expect(await fs.readFile(path.join(current.source, ".paperclip-repository/marker.bin"))).toEqual(Buffer.from([0, 2, 255]));
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["latest", "pinned"] as const)("does not materialize %s repository versions while listing agent skills", async selection => {
    const f = await fixture();
    const version = f.versions[selection === "pinned" ? 0 : 1]!;
    const options = {
      onlyKeys: new Set([f.key]),
      materializeMissing: false,
      ...(selection === "pinned" ? { versionSelections: new Map([[f.key, version.id]]) } : {}),
    };
    const paths = skillVersionCachePaths(f.companyId, f.skillId, version.id);
    const service = companySkillService(db);
    const upstream = vi.fn(() => Promise.reject(new Error("Upstream is unavailable")));
    vi.stubGlobal("fetch", upstream);

    const cold = await service.listRuntimeSkillEntries(f.companyId, options);
    expect(cold).toMatchObject([{ key: f.key, versionId: version.id, sourceStatus: "missing" }]);
    await expect(fs.stat(paths.directory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(paths.access)).rejects.toMatchObject({ code: "ENOENT" });

    const prepare = async () => {
      const entries = await service.listRuntimeSkillEntries(f.companyId, { ...options, snapshotLatest: true });
      expect(entries).toMatchObject([{ key: f.key, versionId: version.id, sourceStatus: "available" }]);
      return entries[0]!;
    };
    const prepared = await prepare();
    const accessed = await fs.readFile(paths.access, "utf8");
    const read = vi.spyOn(fs, "readFile");
    const warm = await service.listRuntimeSkillEntries(f.companyId, options);
    expect(warm).toMatchObject([{ key: f.key, versionId: version.id, sourceStatus: "available", source: prepared.source }]);
    // Browsing must not validate every repository file or extend cache use.
    expect(read.mock.calls.some(([filename]) => String(filename).startsWith(paths.directory + path.sep))).toBe(false);
    read.mockRestore();
    expect(await fs.readFile(paths.access, "utf8")).toBe(accessed);

    // Full validation remains at the execution boundary, including repair.
    const marker = path.join(prepared.source, ".paperclip-repository/marker.bin");
    await fs.chmod(marker, 0o644);
    await fs.writeFile(marker, "corrupt");
    await prepare();
    expect(await fs.readFile(marker)).toEqual(Buffer.from([0, selection === "pinned" ? 1 : 2, 255]));
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects a symlinked cache entrypoint during read-only listing", async () => {
    const f = await fixture();
    const version = f.versions[1]!;
    const prepared = await f.resolve(version.id);
    const entrypoint = path.join(prepared.source, "SKILL.md");
    await fs.unlink(entrypoint);
    await fs.symlink(path.join(prepared.source, ".paperclip-repository/scripts/example.sh"), entrypoint);
    const entries = await companySkillService(db).listRuntimeSkillEntries(f.companyId, {
      onlyKeys: new Set([f.key]), materializeMissing: false,
    });
    expect(entries).toMatchObject([{ key: f.key, sourceStatus: "missing", missingDetail: expect.stringContaining("Unsafe skill cache entrypoint") }]);
    expect((await fs.lstat(entrypoint)).isSymbolicLink()).toBe(true);
  });

  it("expires only idle old versions, reports dry-run candidates, and restores the evicted version", async () => {
    const f = await fixture();
    const old = await f.resolve(f.versions[0]!.id);
    const current = await f.resolve(f.versions[1]!.id);
    const aged = Date.now() - 2 * 60 * 60 * 1000;
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, aged);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[1]!.id, aged);
    const dry = await sweepSkillVersionCache(db, { companyId: f.companyId, dryRun: true });
    expect(dry).toMatchObject({ candidates: 1, evicted: 0, reclaimedBytes: 0 });
    expect(await fs.stat(old.source)).toBeTruthy();
    const swept = await sweepSkillVersionCache(db, { companyId: f.companyId });
    expect(swept).toMatchObject({ candidates: 1, evicted: 1 });
    expect(swept.reclaimedBytes).toBeGreaterThan(0);
    await expect(fs.stat(old.source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(current.source)).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Upstream unavailable"))));
    expect(await f.resolve(f.versions[0]!.id)).toMatchObject({ source: old.source });
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).evicted).toBe(0);
  });

  it("gives existing unobserved caches a full grace period", async () => {
    const f = await fixture();
    await f.resolve(f.versions[0]!.id);
    const paths = skillVersionCachePaths(f.companyId, f.skillId, f.versions[0]!.id);
    await fs.unlink(paths.access);
    const now = Date.now();
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId, now })).skipped.observation_grace).toBe(1);
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId, now: now + 59 * 60 * 1000 })).evicted).toBe(0);
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId, now: now + 61 * 60 * 1000 })).evicted).toBe(1);
  });

  async function activeRun(companyId: string, contextSnapshot: Record<string, unknown> | null) {
    const [agent] = await db.insert(agents).values({ companyId, name: "Cache reader", role: "engineer", adapterType: "process" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", contextSnapshot }).returning();
    return run!;
  }

  it("retains pinned versions and skips companies with unrecorded active selections", async () => {
    const f = await fixture();
    await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    const run = await activeRun(f.companyId, { skillVersions: { [f.key]: f.versions[0]!.id } });
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.protected_version).toBe(1);
    await db.update(heartbeatRuns).set({ contextSnapshot: null }).where(eq(heartbeatRuns.id, run.id));
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.unknown_run_pins).toBe(1);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).evicted).toBe(1);
  });

  it("releases settled interrupted runs but preserves unfinished execution and cleanup", async () => {
    const f = await fixture();
    await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    const run = await activeRun(f.companyId, null);
    await db.update(heartbeatRuns).set({ status: "interrupted" }).where(eq(heartbeatRuns.id, run.id));
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.unknown_run_pins).toBe(1);
    await db.update(heartbeatRuns).set({ finishedAt: new Date(), controllerLeaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(heartbeatRuns.id, run.id));
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.unknown_run_pins).toBe(1);
    await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, run.id));
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: run.id,
      status: "pending_cleanup", cleanupStatus: "failed" }).returning();
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.unknown_run_pins).toBe(1);
    await db.update(environmentLeases).set({ status: "released", cleanupStatus: "success", releasedAt: new Date() })
      .where(eq(environmentLeases.id, lease!.id));
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).evicted).toBe(1);
  });

  async function legacyNativeRun(companyId: string, skills: Array<{ key: string; versionId: string | null }> = []) {
    const run = await activeRun(companyId, null);
    const [issue] = await db.insert(issues).values({ companyId, title: "Saved native selection" }).returning();
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.skills = skills.map((skill, index) => ({ ...skill, runtimeName: `skill-${index}`, bundle: runtimeContext.instructions.bundle }));
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v3",
      binding: { companyId, runId: run.id, agentId: run.agentId, issueId: issue!.id, executionWorkspaceId: run.id },
      task: { identifier: "CACHE-1", title: "Saved selection", description: null, prompt: "Read saved skills", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      provider: { kind: "codex", model: null },
      completionContract: { id: "contract", sha256: "saved", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Read saved skills", criteria: [{ id: "read", requirement: "Read skills" }] } },
      interactionResponses: [], credentialBindings: [], executionMode: "default", planningContext: null, runtimeContext,
    });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue!.id, status: "failed", finishedAt: new Date(),
      runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId, issueId: issue!.id, runId: run.id,
      phase: "terminal_failure", recoveryState: "blocked" });
    return { run, execution };
  }

  it.each([false, true])("uses the legacy native manifest without changing unresolved recovery (bundled skill: %s)", async bundled => {
    const f = await fixture();
    const old = await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    const { run } = await legacyNativeRun(f.companyId, bundled ? [{ key: "paperclipai/paperclip/slack", versionId: null }] : []);
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).evicted).toBe(1);
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, run.id)))[0])
      .toMatchObject({ phase: "terminal_failure", recoveryState: "blocked" });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0]!.contextSnapshot).toBeNull();
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("Upstream unavailable"))));
    expect(await f.resolve(f.versions[0]!.id)).toMatchObject({ source: old.source });
  });

  it("preserves exact legacy manifest pins", async () => {
    const f = await fixture();
    await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    await legacyNativeRun(f.companyId, [{ key: f.key, versionId: f.versions[0]!.id }]);
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.protected_version).toBe(1);
  });

  it.each(["companyId", "runId", "agentId", "issueId", "digest", "missing", "invalid_version", "invalid_pins", "legacy_adapter"])(
    "fails closed for unusable native selection evidence (%s)", async invalid => {
      const f = await fixture();
      await f.resolve(f.versions[0]!.id);
      await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
      const { run, execution } = await legacyNativeRun(f.companyId,
        invalid === "invalid_version" ? [{ key: f.key, versionId: "not-a-version" }] : []);
      if (["companyId", "runId", "agentId", "issueId"].includes(invalid)) Object.assign(execution.binding, { [invalid]: randomUUID() });
      if (invalid === "digest" && "runtimeContext" in execution) execution.runtimeContext.aggregateDigest = "f".repeat(64);
      await db.update(heartbeatRuns).set({
        runnerProfileJson: invalid === "missing" ? {} : { nativeExecutionInput: execution },
        ...(invalid === "invalid_pins" ? { contextSnapshot: { skillVersions: null } } : {}),
        ...(invalid === "legacy_adapter" ? { runtimeMode: "legacy" } : {}),
      }).where(eq(heartbeatRuns.id, run.id));
      expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.unknown_run_pins).toBe(1);
    },
  );

  it("serializes eviction behind preparation and durable pinning across database clients", async () => {
    const f = await fixture();
    await f.resolve(f.versions[0]!.id);
    const run = await activeRun(f.companyId, null);
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const preparing = companySkillService(db).withRuntimeSkillEntries(f.companyId, {
      onlyKeys: new Set([f.key]), versionSelections: new Map([[f.key, f.versions[0]!.id]]),
    }, async entries => {
      expect(entries).toMatchObject([{ key: f.key, versionId: f.versions[0]!.id, sourceStatus: "available" }]);
      await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
      ready.resolve();
      await release.promise;
      await db.update(heartbeatRuns).set({ contextSnapshot: { skillVersions: { [f.key]: f.versions[0]!.id } } })
        .where(eq(heartbeatRuns.id, run.id));
    });
    await ready.promise;
    const other = createDb(external ?? database!.connectionString);
    try {
      const cleaning = await sweepSkillVersionCache(other, { companyId: f.companyId });
      expect(cleaning.evicted).toBe(0);
      expect(cleaning.skipped.cache_busy).toBeGreaterThan(0);
    } finally { release.resolve(); }
    await preparing;
    expect(await sweepSkillVersionCache(other, { companyId: f.companyId })).toMatchObject({ evicted: 0, skipped: { protected_version: 1 } });
    await other.$client.end({ timeout: 0 });
  });

  it("releases the cache lock after a runtime selection consumer fails", async () => {
    const f = await fixture();
    await expect(companySkillService(db).withRuntimeSkillEntries(f.companyId, {
      onlyKeys: new Set([f.key]), versionSelections: new Map([[f.key, f.versions[0]!.id]]),
    }, async entries => {
      expect(entries[0]!.sourceStatus).toBe("available");
      throw new Error("durable pin write failed");
    })).rejects.toThrow("durable pin write failed");
    const other = createDb(external ?? database!.connectionString);
    try {
      expect(await withSkillVersionCacheLock(other, f.companyId, async () => "released", true)).toBe("released");
    } finally { await other.$client.end({ timeout: 0 }); }
  });

  it("reads company-wide protection twice per batch regardless of version count", async () => {
    const f = await fixture();
    const versionIds = [f.versions[0]!.id];
    for (let revision = 3; revision < 8; revision++) {
      const [version] = await db.insert(companySkillVersions).values({ companyId: f.companyId,
        companySkillId: f.skillId, revisionNumber: revision, repositorySnapshotId: f.versions[0]!.repositorySnapshotId,
        repositorySkillPath: "skills/example/SKILL.md" }).returning();
      versionIds.push(version!.id);
    }
    for (const id of [...versionIds, f.versions[1]!.id]) {
      await f.resolve(id);
      await touchSkillVersionCache(f.companyId, f.skillId, id, Date.now() - 7_200_000);
    }
    const statements: string[] = [];
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { statements.push(query); };
    try {
      expect(await sweepSkillVersionCache(db, { companyId: f.companyId })).toMatchObject({ evicted: 6 });
      expect(statements.filter(query => /from "agents"/.test(query))).toHaveLength(2);
      expect(statements.filter(query => /from "heartbeat_runs"/.test(query))).toHaveLength(2);
    } finally { db.$client.options.debug = debug; }
  });

  it("lets preparation finish during slow byte inspection and rechecks its new pin", async () => {
    const f = await fixture();
    const old = await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    const inspecting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const lstat = fs.lstat.bind(fs);
    let held = false;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (!held && String(args[0]) === path.join(old.source, ".paperclip-repository", "marker.bin")) {
        held = true;
        inspecting.resolve();
        await release.promise;
      }
      return lstat(...args);
    }) as typeof fs.lstat);
    const sweep = sweepSkillVersionCache(db, { companyId: f.companyId });
    await inspecting.promise;
    const other = createDb(external ?? database!.connectionString);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const preparation = withSkillVersionCacheLock(other, f.companyId, async () => {
      await companySkillService(other).listRuntimeSkillEntries(f.companyId, {
        onlyKeys: new Set([f.key]), versionSelections: new Map([[f.key, f.versions[0]!.id]]),
      });
      // Remove grace as an alternative explanation: the newly persisted run pin
      // must prevent eviction after the original candidate snapshot was read.
      await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
      await activeRun(f.companyId, { skillVersions: { [f.key]: f.versions[0]!.id } });
      return true;
    });
    try {
      expect(await Promise.race([preparation, new Promise<boolean>(resolve => {
        timeout = setTimeout(() => resolve(false), 10_000);
      })])).toBe(true);
    } finally { clearTimeout(timeout); release.resolve(); }
    await preparation;
    expect(await sweep).toMatchObject({ evicted: 0, skipped: { protected_version: 1 } });
    expect(await fs.stat(old.source)).toBeTruthy();
    await other.$client.end({ timeout: 1 });
  });

  it("keeps terminal run pins until native finalization has settled", async () => {
    const f = await fixture();
    await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    const run = await activeRun(f.companyId, { skillVersions: { [f.key]: f.versions[0]!.id } });
    const [issue] = await db.insert(issues).values({ companyId: f.companyId, title: "Pending recovery" }).returning();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: issue!.id, status: "failed", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, run.id));
    await db.insert(nativeRunFinalizations).values({ companyId: f.companyId, issueId: issue!.id, runId: run.id, phase: "terminal_failure" });
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.protected_version).toBe(1);
    await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, run.id));
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).evicted).toBe(1);
  });

  it("finishes interrupted trash removal without deleting a rehydrated copy", async () => {
    const f = await fixture();
    const old = await f.resolve(f.versions[0]!.id);
    const paths = skillVersionCachePaths(f.companyId, f.skillId, f.versions[0]!.id);
    const trash = path.join(path.dirname(paths.directory), `.trash-${randomUUID()}`);
    await fs.rename(old.source, trash);
    await f.resolve(f.versions[0]!.id);
    const result = await sweepSkillVersionCache(db, { companyId: f.companyId });
    expect(result.evicted).toBe(0);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    await expect(fs.stat(trash)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.stat(old.source)).toBeTruthy();
  });

  it("does not traverse symlinked cache roots", async () => {
    const f = await fixture();
    const old = await f.resolve(f.versions[0]!.id);
    await touchSkillVersionCache(f.companyId, f.skillId, f.versions[0]!.id, Date.now() - 7_200_000);
    const outside = await fs.mkdtemp(path.join(home, "outside-"));
    await fs.writeFile(path.join(outside, "unique.txt"), "keep");
    await fs.rm(old.source, { recursive: true });
    await fs.symlink(outside, old.source);
    expect((await sweepSkillVersionCache(db, { companyId: f.companyId })).skipped.unsafe_or_unavailable).toBe(1);
    expect(await fs.readFile(path.join(outside, "unique.txt"), "utf8")).toBe("keep");
  });
});
