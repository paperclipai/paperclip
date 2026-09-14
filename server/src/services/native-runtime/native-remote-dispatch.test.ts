import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, access, rename, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { canDispatchNativeRemoteRestart, prepareNativeRemoteDispatch, restoreNativeRemoteDispatchWorkspace } from "./native-remote-dispatch.js";
import { readNativeWorkspaceSyncReference } from "./native-workspace-sync.js";
import { seedRemoteDispatchFixture } from "./remote-dispatch.test-fixture.js";

describe("remote native dispatch preserves the original workspace", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: ReturnType<typeof createDb>, root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-remote-dispatch-")); process.env.PAPERCLIP_HOME = root;
    database = await startEmbeddedPostgresTestDatabase("paperclip-remote-dispatch-db-"); db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    await database?.cleanup(); if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (root) await rm(root, { recursive: true, force: true });
  });
  async function fixture(durableSeed = false) {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Developer", adapterType: "paperclip_runner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Retained dev server", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId });
    return seedRemoteDispatchFixture(db, { companyId, agentId, issueId, runId, hostCwd: path.join(root, runId, "workspace"), durableSeed });
  }
  it.each(["per_turn", "warm"] as const)("reads the %s saved mirror without provisioning commands, workspace refresh or database changes", async mode => {
    const f = await fixture();
    if (mode === "warm") {
      f.execution.session.lifecyclePolicy = { mode: "warm", idleTimeoutMs: 300_000 };
      [f.run] = await db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.run.runnerProfileJson, nativeExecutionInput: f.execution } }).where(eq(heartbeatRuns.id, f.runId)).returning();
    }
    const before = await readFile(path.join(f.hostCwd, "App.jsx"), "utf8");
    expect(canDispatchNativeRemoteRestart(f.run)).toBe(true);
    const recovery = await prepareNativeRemoteDispatch({ db, run: f.run, claim: f.claim });
    expect(recovery).toMatchObject({ workspace: f.workspace, execution: f.execution, process: f.claim.kind === "reattach_existing_runner" ? f.claim.process : null,
      realized: { cwd: f.hostCwd, created: false, warnings: [] } });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id))).toEqual([f.workspace]);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id))).toEqual([f.lease]);
    expect(await readFile(path.join(f.hostCwd, "App.jsx"), "utf8")).toBe(before);
  });
  it("restores a missing mirror and publishes its new identity without changing the original workspace or lease", async () => {
    const f = await fixture(true);
    await rm(f.hostCwd, { recursive: true });
    expect((await prepareNativeRemoteDispatch({ db, run: f.run, claim: f.claim })).hostState).toBe("missing");
    await expect(access(f.hostCwd)).rejects.toThrow();
    expect((await restoreNativeRemoteDispatchWorkspace({ db, run: f.run, claim: f.claim })).hostState).toBe("present");
    expect(await readFile(path.join(f.hostCwd, "App.jsx"), "utf8")).toContain("original app");
    expect((await prepareNativeRemoteDispatch({ db, run: f.run, claim: f.claim })).hostState).toBe("present");
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(readNativeWorkspaceSyncReference(run!.runnerProfileJson?.nativeWorkspaceSync)?.descriptorSha256).not.toBe(f.reference.descriptorSha256);
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id))).toEqual([f.lease]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspace.id))).toEqual([f.workspace]);
    // Another host-mirror loss uses the newly published receipt.
    await rm(f.hostCwd, { recursive: true });
    expect((await restoreNativeRemoteDispatchWorkspace({ db, run: run!, claim: f.claim })).hostState).toBe("present");
  });

  it("leaves a completed copy held when ownership changes, then resumes under the new controller claim", async () => {
    const f = await fixture(true);
    const canonical = await fs.realpath(f.hostCwd);
    await rm(f.hostCwd, { recursive: true });
    const originalLink = fs.link.bind(fs);
    const nextClaim = { ...f.claim, leaseOwner: "next-controller", controllerGeneration: 2 };
    const link = vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
      await originalLink(source, target);
      if (target === path.join(canonical, "App.jsx")) await db.update(nativeRunFinalizations).set({
        leaseOwner: nextClaim.leaseOwner, controllerGeneration: nextClaim.controllerGeneration,
      }).where(eq(nativeRunFinalizations.runId, f.runId));
    });
    try { await expect(restoreNativeRemoteDispatchWorkspace({ db, run: f.run, claim: f.claim })).rejects.toMatchObject({ name: "NativeRunnerOwnershipUnverifiedError" }); }
    finally { link.mockRestore(); }
    const [held] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    expect(readNativeWorkspaceSyncReference(held!.runnerProfileJson?.nativeWorkspaceSync)).toEqual(f.reference);
    expect(await readFile(path.join(f.hostCwd, "App.jsx"), "utf8")).toContain("original app");
    expect((await prepareNativeRemoteDispatch({ db, run: held!, claim: nextClaim })).hostState).toBe("recovering");
    expect((await restoreNativeRemoteDispatchWorkspace({ db, run: held!, claim: nextClaim })).hostState).toBe("present");
  });
  it.each(["invalid_lifecycle", "controller", "expired_controller", "scope", "profile", "reference", "workspace", "archived", "missing_mirror", "replaced_mirror", "replaced_parent", "git_metadata", "lease", "task", "agent"])("holds %s drift without rebuilding the workspace", async cause => {
    const f = await fixture(); let run = f.run;
    if (cause === "invalid_lifecycle" || cause === "profile" || cause === "reference") {
      const profile = structuredClone(f.run.runnerProfileJson!);
      if (cause === "invalid_lifecycle") (profile.nativeExecutionInput as typeof f.execution).session.lifecyclePolicy = { mode: "unknown", idleTimeoutMs: 300_000 } as never;
      if (cause === "profile") delete profile.nativeExecutionInput;
      if (cause === "reference") delete profile.nativeWorkspaceSync;
      [run] = await db.update(heartbeatRuns).set({ runnerProfileJson: profile }).where(eq(heartbeatRuns.id, f.runId)).returning();
    }
    if (cause === "controller" || cause === "expired_controller") await db.update(nativeRunFinalizations).set(cause === "controller" ? { controllerGeneration: 2 } : { leaseExpiresAt: new Date(0) }).where(eq(nativeRunFinalizations.runId, f.runId));
    if (cause === "scope") run = { ...run, companyId: randomUUID() };
    if (cause === "workspace" || cause === "archived") await db.update(executionWorkspaces).set(cause === "workspace" ? { cwd: path.join(root, "other") } : { status: "archived" }).where(eq(executionWorkspaces.id, f.workspace.id));
    if (cause === "missing_mirror") await rm(f.hostCwd, { recursive: true });
    if (cause === "replaced_mirror") {
      await rename(f.hostCwd, `${f.hostCwd}-original`); await mkdir(f.hostCwd);
      await writeFile(path.join(f.hostCwd, "App.jsx"), "replacement checkout must stay untouched\n");
    }
    if (cause === "replaced_parent") {
      await rename(path.dirname(f.hostCwd), `${path.dirname(f.hostCwd)}-original`); await mkdir(f.hostCwd, { recursive: true });
      await writeFile(path.join(f.hostCwd, "App.jsx"), "replacement checkout must stay untouched\n");
    }
    if (cause === "git_metadata") await mkdir(path.join(f.hostCwd, ".git"));
    if (cause === "lease") await db.update(environmentLeases).set({ status: "released" }).where(eq(environmentLeases.id, f.lease.id));
    if (cause === "task" || cause === "agent") await db.update(issues).set(cause === "task" ? { executionRunId: null } : { assigneeAgentId: null }).where(eq(issues.id, f.issueId));
    await expect(prepareNativeRemoteDispatch({ db, run, claim: f.claim })).rejects.toMatchObject({ name: "NativeRunnerOwnershipUnverifiedError" });
    if (cause === "missing_mirror") await expect(access(f.hostCwd)).rejects.toThrow();
    else if (cause === "replaced_mirror" || cause === "replaced_parent") expect(await readFile(path.join(f.hostCwd, "App.jsx"), "utf8")).toContain("replacement checkout must stay untouched");
    else expect(await readFile(path.join(f.hostCwd, "App.jsx"), "utf8")).toContain("original app");
  });
});
