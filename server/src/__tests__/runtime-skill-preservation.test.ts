import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agentInstructionRevisions, agents, companies, heartbeatRuns, issues, companySkillRepositorySnapshots as snapshots,
  nativeRunFinalizations, createDb } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as storageModule from "../storage/index.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { materializeAsset, rehydratePinnedInstructionAsset, rehydratePinnedSkillAssets } from "../services/native-runtime/runtime-context.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { canonicalNativeRuntimeContextDigest, parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { preserveRuntimeSkillAssets, hasLocalRuntimeSkillObligations, migrateRuntimeSkillAssets } from "../services/native-runtime/runtime-skill-preservation.js";
import { readEphemeralServerDataEligibility } from "../services/ephemeral-server-contract.js";
import { skillPackageMaintenance } from "../services/skill-package-maintenance.js";
import { removeRuntimeAssetTree } from "../services/native-runtime/runtime-asset-retention.js";

describe("admitted unversioned runtime skill preservation", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let home: string;
  let storage: storageModule.StorageService;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("runtime-skill-preservation-");
    db = createDb(database.connectionString, { maxConnections: 6 });
    home = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-skill-preservation-"));
    process.env.PAPERCLIP_HOME = home;
    // Real streaming storage/archives on disk with the same durable receipt
    // contract; no external provider credentials or HTTP mocks.
    storage = createStorageService({ ...createLocalDiskStorageProvider(path.join(home, "objects")), id: "s3" });
    vi.spyOn(storageModule, "getStorageService").mockReturnValue(storage);
  }, 90_000);
  afterEach(async () => {
    process.env.PAPERCLIP_HOME = home;
    await db.delete(activityLog);
    await db.delete(nativeRunFinalizations);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(snapshots);
    await db.delete(companies);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    await db?.$client.end({ timeout: 1 });
    await database?.cleanup();
    if (home) await removeRuntimeAssetTree(home);
  });
  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Skill preservation", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Recovery source" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve admitted skill" });
    const bundle = await materializeAsset([
      { path: "SKILL.md", content: Buffer.from("# original admitted skill\n"), mode: 0o400 },
      { path: "scripts/run.sh", content: Buffer.from("#!/bin/sh\necho preserve\n"), mode: 0o500 },
      { path: "binary", content: Buffer.from([0, 255, 7]), mode: 0o444 },
    ]);
    const context = nativeRuntimeContextFixture();
    context.skills = [{ key: "legacy", runtimeName: "legacy", versionId: null, bundle }];
    context.aggregateDigest = canonicalNativeRuntimeContextDigest(context);
    const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v3",
      binding: { companyId, runId, agentId, issueId, executionWorkspaceId: runId },
      task: { identifier: "PRESERVE-1", title: "Saved selection", description: null, prompt: "Read saved skills", workMode: "standard" },
      workspace: { cwd: "/tmp", repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: null, driverKind: "codex_app_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      provider: { kind: "codex", model: null },
      completionContract: { id: "contract", sha256: "saved", schemaVersion: "paperclip.completion-contract.v1",
        contract: { revision: "1", objective: "Read saved skills", criteria: [{ id: "read", requirement: "Read skills" }] } },
      interactionResponses: [], credentialBindings: [], executionMode: "default", planningContext: null, runtimeContext: context });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(),
      processPid: 1234, processStartedAt: new Date(0), runnerProfileJson: { nativeExecutionInput: execution, retainedWarning: "unresolved recovery" } });
    await db.insert(nativeRunFinalizations).values({ companyId, runId, issueId, phase: "terminal_failure", recoveryState: "blocked" });
    return { companyId, agentId, runId, issueId, context, bundle, execution };
  }
  it("blocks startup on a concrete local asset but ignores an unfinished ordinary admission", async () => {
    const f = await fixture();
    const [ordinary] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      runtimeMode: "native", status: "running", contextSnapshot: {} }).returning();
    expect((await readEphemeralServerDataEligibility(db, { purpose: "startup" })).blockers)
      .toContain("runtime_skill_assets_require_migration");
    await preserveRuntimeSkillAssets(db, f, storage);
    expect((await readEphemeralServerDataEligibility(db, { purpose: "startup" })).blockers)
      .not.toContain("runtime_skill_assets_require_migration");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ordinary!.id)))[0]!.contextSnapshot).toEqual({});
  });
  it("preserves exact bytes, modes and null pins for cold recovery without settling warnings or starting a turn", async () => {
    const f = await fixture();
    const before = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    expect(await preserveRuntimeSkillAssets(db, f, storage)).toEqual({ preserved: 1 });
    const saved = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
    expect(saved).toEqual({ ...before, runnerProfileJson: { ...before.runnerProfileJson,
      nativeRuntimeSkillPreservation: saved.runnerProfileJson!.nativeRuntimeSkillPreservation } });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", recoveryState: "blocked", leaseOwner: null });
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
    process.env.PAPERCLIP_HOME = path.join(home, `cold-${randomUUID()}`);
    const recovered = await rehydratePinnedSkillAssets(db, f, f.context);
    expect(recovered.aggregateDigest).toBe(f.context.aggregateDigest);
    expect(recovered.skills[0]!.versionId).toBeNull();
    const root = recovered.skills[0]!.bundle.rootPath;
    expect(root).not.toBe(f.bundle.rootPath);
    expect({ ...recovered.skills[0]!.bundle, rootPath: f.bundle.rootPath }).toEqual(f.bundle);
    expect(await fs.readFile(path.join(root, "binary"))).toEqual(Buffer.from([0, 255, 7]));
    expect((await fs.stat(path.join(root, "SKILL.md"))).mode & 0o777).toBe(0o400);
    expect((await fs.stat(path.join(root, "scripts/run.sh"))).mode & 0o777).toBe(0o500);
    expect(await fs.readFile(path.join(f.bundle.rootPath, "SKILL.md"), "utf8")).toBe("# original admitted skill\n");
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });
  it("reuses an authenticated local bundle during a storage outage and restores a damaged cache from its package", async () => {
    const f = await fixture();
    await preserveRuntimeSkillAssets(db, f, storage);
    const get = vi.spyOn(storage, "getObject").mockRejectedValue(new Error("storage offline"));
    try {
      expect((await rehydratePinnedSkillAssets(db, f, f.context)).skills[0]!.bundle).toEqual(f.bundle);
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); }
    const file = path.join(f.bundle.rootPath, "SKILL.md");
    await fs.chmod(file, 0o600); await fs.writeFile(file, "damaged"); await fs.chmod(file, 0o400);
    const read = vi.spyOn(storage, "getObject");
    try {
      expect((await rehydratePinnedSkillAssets(db, f, f.context)).skills[0]!.bundle).toEqual(f.bundle);
      expect(read).toHaveBeenCalled();
      expect(await fs.readFile(file, "utf8")).toBe("# original admitted skill\n");
    } finally { read.mockRestore(); }
  });
  it("rejects changed source bytes and changed admitted input before receipt publication", async () => {
    const f = await fixture();
    const file = path.join(f.bundle.rootPath, "SKILL.md");
    await fs.chmod(file, 0o600); await fs.writeFile(file, "changed"); await fs.chmod(file, 0o400);
    await expect(preserveRuntimeSkillAssets(db, f, storage)).rejects.toThrow("source_changed");
    expect((await db.select().from(snapshots))).toHaveLength(0);
    const g = await fixture();
    const put = storage.putFile.bind(storage);
    const spy = vi.spyOn(storage, "putFile").mockImplementation(async input => {
      const result = await put(input);
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: { ...g.execution,
        task: { ...g.execution.task, prompt: "new admitted intent" } } } }).where(eq(heartbeatRuns.id, g.runId));
      return result;
    });
    try { await expect(preserveRuntimeSkillAssets(db, g, storage)).rejects.toThrow("binding_changed"); }
    finally { spy.mockRestore(); }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, g.runId)))[0]!.runnerProfileJson)
      .not.toHaveProperty("nativeRuntimeSkillPreservation");
  });
  it("fails closed for missing/corrupt durable receipts and refuses another company's run", async () => {
    const f = await fixture();
    await expect(preserveRuntimeSkillAssets(db, { ...f, companyId: randomUUID() }, storage)).rejects.toThrow("source_unavailable");
    await preserveRuntimeSkillAssets(db, f, storage);
    const [snapshot] = await db.select().from(snapshots).where(eq(snapshots.companyId, f.companyId));
    await db.update(snapshots).set({ storage: null }).where(eq(snapshots.id, snapshot!.id));
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
    await db.update(snapshots).set({ storage: { ...snapshot!.storage!, durable: false } }).where(eq(snapshots.id, snapshot!.id));
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
    await expect(rehydratePinnedSkillAssets(db, f, f.context)).rejects.toThrow("package_not_durable");
    await db.update(snapshots).set({ storage: snapshot!.storage }).where(eq(snapshots.id, snapshot!.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = run!.runnerProfileJson!.nativeRuntimeSkillPreservation as { assets: Array<{ manifestText: string }> };
    receipt.assets[0]!.manifestText += " ";
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...run!.runnerProfileJson, nativeRuntimeSkillPreservation: receipt } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
    await expect(rehydratePinnedSkillAssets(db, f, f.context)).rejects.toThrow("manifest_digest_mismatch");
  });
  it("copies a running owner's immutable asset without taking its lease, changing its state, or requiring completion", async () => {
    const f = await fixture();
    const controllerBootId = randomUUID(), controllerLeaseExpiresAt = new Date(Date.now() + 600_000);
    await db.update(heartbeatRuns).set({ status: "running", finishedAt: null, controllerBootId, controllerLeaseExpiresAt })
      .where(eq(heartbeatRuns.id, f.runId));
    await db.update(nativeRunFinalizations).set({ leaseOwner: "original-live-owner" }).where(eq(nativeRunFinalizations.runId, f.runId));
    const preview = await migrateRuntimeSkillAssets(db, { companyId: f.companyId });
    expect(preview.results).toEqual([{ runId: f.runId, status: "candidate" }]);
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
    expect((await migrateRuntimeSkillAssets(db, { companyId: f.companyId, apply: true }, storage)).results)
      .toEqual([{ runId: f.runId, status: "preserved", preserved: 1 }]);
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0])
      .toMatchObject({ status: "running", finishedAt: null, controllerBootId, controllerLeaseExpiresAt, processPid: 1234 });
    expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, f.runId)))[0])
      .toMatchObject({ phase: "terminal_failure", recoveryState: "blocked", leaseOwner: "original-live-owner" });
    await removeRuntimeAssetTree(f.bundle.rootPath);
    expect(await preserveRuntimeSkillAssets(db, f, storage)).toEqual({ preserved: 1 });
  });
  it("retains the original receipt through a contract revision but rejects a changed admitted asset or binding", async () => {
    const f = await fixture();
    await preserveRuntimeSkillAssets(db, f, storage);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const profile = run!.runnerProfileJson!;
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile,
      nativeExecutionInput: { ...f.execution, task: { ...f.execution.task, prompt: "Revised task contract" } } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
    process.env.PAPERCLIP_HOME = path.join(home, `revision-${randomUUID()}`);
    expect((await rehydratePinnedSkillAssets(db, f, f.context)).skills[0]!.bundle.digest).toBe(f.bundle.digest);
    const changed = structuredClone(f.context);
    changed.skills[0]!.runtimeName = "different-admitted-selection";
    changed.aggregateDigest = canonicalNativeRuntimeContextDigest(changed);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile,
      nativeExecutionInput: { ...f.execution, runtimeContext: changed } } }).where(eq(heartbeatRuns.id, f.runId));
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
    await expect(rehydratePinnedSkillAssets(db, f, changed)).rejects.toThrow("preservation_required");
    await db.update(heartbeatRuns).set({ runnerProfileJson: { ...profile,
      nativeExecutionInput: { ...f.execution, binding: { ...f.execution.binding, executionWorkspaceId: randomUUID() } } } })
      .where(eq(heartbeatRuns.id, f.runId));
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(true);
  });
  it("keeps referenced packages through orphan collection and observes a receipt committed while deletion waits", async () => {
    const f = await fixture();
    await preserveRuntimeSkillAssets(db, f, storage);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const receipt = run!.runnerProfileJson!.nativeRuntimeSkillPreservation;
    const [snapshot] = await db.select().from(snapshots).where(eq(snapshots.companyId, f.companyId));
    await db.update(snapshots).set({ createdAt: new Date(0) }).where(eq(snapshots.id, snapshot!.id));
    expect((await skillPackageMaintenance(db, storage).collectOrphans({ companyId: f.companyId, apply: true })).removed).toBe(0);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: f.execution } }).where(eq(heartbeatRuns.id, f.runId));
    let unlock!: () => void, locked!: () => void, waiting!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const deleting = new Promise<void>(resolve => { waiting = resolve; });
    const publisher = db.transaction(async tx => {
      await tx.select().from(snapshots).where(eq(snapshots.id, snapshot!.id)).for("update");
      await tx.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: f.execution,
        nativeRuntimeSkillPreservation: receipt } }).where(eq(heartbeatRuns.id, f.runId));
      locked(); await release;
    });
    await acquired;
    const debug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { if (query.includes('from "company_skill_repository_snapshots"') && query.includes("for update")) waiting(); };
    try {
      const collection = skillPackageMaintenance(db, storage).collectOrphans({ companyId: f.companyId, apply: true });
      await deleting; unlock(); await publisher;
      expect((await collection).removed).toBe(0);
    } finally { unlock(); db.$client.options.debug = debug; }
    expect(await hasLocalRuntimeSkillObligations(db)).toBe(false);
    expect(await db.select().from(snapshots).where(and(eq(snapshots.companyId, f.companyId), eq(snapshots.id, snapshot!.id))))
      .toHaveLength(1);
  });

  it("rebuilds an admitted instruction bundle that is missing on a new controller host", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Instruction rehydration", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Rehydrated" });
    const admitted = Buffer.from("# Admitted instructions\n");
    for (const content of [admitted, Buffer.from("# Edited after admission\n")]) {
      await db.insert(agentInstructionRevisions).values({ companyId, agentId, entryFile: "AGENTS.md", contentBase64: content.toString("base64"),
        contentHash: "unused", byteLength: content.byteLength, source: "board" });
    }
    const bundle = await materializeAsset([{ path: "AGENTS.md", content: admitted, mode: 0o444 }]);
    const context = nativeRuntimeContextFixture();
    context.instructions = { entryPath: "AGENTS.md", bundle };
    await removeRuntimeAssetTree(bundle.rootPath);
    await fs.rm(path.join(home, "instances", "default", "runtime-context-assets", "manifests", `${bundle.digest}.json`), { force: true });
    await expect(fs.lstat(bundle.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
    const rehydrated = await rehydratePinnedInstructionAsset(db, { companyId, agentId }, context);
    expect(rehydrated.instructions.bundle).toEqual(bundle);
    expect(await fs.readFile(path.join(bundle.rootPath, "AGENTS.md"), "utf8")).toBe("# Admitted instructions\n");
    const elsewhere = { ...context, instructions: { ...context.instructions, bundle: { ...bundle, rootPath: "/other-home/runtime-context-assets/bundles/x" } } };
    expect(await rehydratePinnedInstructionAsset(db, { companyId, agentId }, elsewhere)).toBe(elsewhere);
  });
});
