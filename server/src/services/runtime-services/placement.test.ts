import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, projects, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createRuntimeServiceSchema } from "@paperclipai/shared";
import { bindRuntimeServiceInvocationDirectory, createRuntimeServicePlacementResolver } from "./placement.js";

describe("service placement from the authenticated run's execution boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-service-placement-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-placement-"));
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });
  async function fixture(provider: "local" | "daytona" = "local") {
    const companyId = randomUUID();
    const cwd = path.join(root!, companyId);
    await fs.mkdir(path.join(cwd, "app"), { recursive: true });
    await db.insert(companies).values({ id: companyId, name: "Placement", issuePrefix: `P${companyId.slice(0, 6)}` });
    const [agent] = await db.insert(agents).values({ companyId, name: "Developer" }).returning();
    const [project] = await db.insert(projects).values({ companyId, name: "Project" }).returning();
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: project!.id, name: "App", mode: "isolated_workspace", strategyType: "git_worktree", cwd }).returning();
    const [task] = await db.insert(issues).values({ companyId, title: "Develop", executionWorkspaceId: workspace!.id, assigneeAgentId: agent!.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId: agent!.id, status: "running", contextSnapshot: { issueId: task!.id } }).returning();
    const [environment] = await db.insert(environments).values({ name: `Placement ${companyId}`, driver: "sandbox", config: { provider } }).returning();
    const boundary = { version: 1, provider, workspaceRoot: cwd, executionWorkspaceId: workspace!.id, network: "disabled" };
    const [lease] = await db.insert(environmentLeases).values({ companyId, environmentId: environment!.id, executionWorkspaceId: workspace!.id, heartbeatRunId: run!.id, provider, providerLeaseId: provider === "daytona" ? randomUUID() : null, metadata: { runtimeServiceBoundary: boundary, sandboxProviderPlugin: true, pluginId: randomUUID() } }).returning();
    const request = { actor: { type: "agent", source: "agent_jwt", agentId: agent!.id, companyId, runId: run!.id } } as Request;
    const resolve = createRuntimeServicePlacementResolver(db, { allowLocal: true });
    const input = (extra = {}) => createRuntimeServiceSchema.parse({ name: "Preview", requestId: randomUUID(), command: "npm run dev", issueId: task!.id, ...extra });
    return { companyId, cwd, run: run!, lease: lease!, boundary, resolve, request, input };
  }

  it("keeps local paths and network policy inside the server-issued boundary, including symlinks", async () => {
    const f = await fixture();
    const placement = await f.resolve(f.request, f.companyId, f.input({ cwd: "app" }));
    expect(placement).toMatchObject({ provider: "local", cwd: await fs.realpath(path.join(f.cwd, "app")), environmentLeaseId: f.lease.id, metadata: { localBoundary: { network: "disabled" } } });
    await expect(f.resolve(f.request, f.companyId, f.input({ cwd: root }))).rejects.toMatchObject({ status: 403 });
    await fs.symlink(root!, path.join(f.cwd, "escape"));
    await expect(f.resolve(f.request, f.companyId, f.input({ cwd: "escape" }))).rejects.toMatchObject({ status: 403 });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await expect(f.resolve(f.request, f.companyId, f.input())).rejects.toMatchObject({ status: 403 });
  });

  it("does not fall back to host execution for an unready or foreign allocation", async () => {
    const f = await fixture();
    await expect(f.resolve(f.request, f.companyId, f.input({ environmentId: randomUUID() }))).rejects.toMatchObject({ status: 422 });
    await db.update(environmentLeases).set({ metadata: {} }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.resolve(f.request, f.companyId, f.input())).rejects.toMatchObject({ status: 422 });
  });

  it("binds the actual local adapter directory before tools run while preserving company, run, and remote boundaries", async () => {
    const f = await fixture();
    const actual = await fs.mkdtemp(path.join(root!, "configured-adapter-"));
    const binding = { companyId: f.companyId, runId: f.run.id, environmentLeaseId: f.lease.id, cwd: actual };
    await bindRuntimeServiceInvocationDirectory(db, { ...binding, companyId: randomUUID() });
    await bindRuntimeServiceInvocationDirectory(db, { ...binding, runId: randomUUID() });
    await expect(f.resolve(f.request, f.companyId, f.input({ cwd: actual }))).rejects.toMatchObject({ status: 403 });
    await bindRuntimeServiceInvocationDirectory(db, binding);
    expect(await f.resolve(f.request, f.companyId, f.input({ cwd: actual }))).toMatchObject({ cwd: await fs.realpath(actual), metadata: { localBoundary: { network: "disabled" } } });
    await expect(f.resolve(f.request, f.companyId, f.input({ cwd: f.cwd }))).rejects.toMatchObject({ status: 403 });
    const remote = await fixture("daytona");
    await bindRuntimeServiceInvocationDirectory(db, { companyId: remote.companyId, runId: remote.run.id, environmentLeaseId: remote.lease.id, cwd: actual });
    expect(await remote.resolve(remote.request, remote.companyId, remote.input())).toMatchObject({ cwd: remote.cwd, provider: "daytona" });
  });

  it("preserves sandbox identity and refuses unsupported network or fixed lifetime policies", async () => {
    const f = await fixture("daytona");
    const placement = await f.resolve(f.request, f.companyId, f.input({ cwd: "app" }));
    expect(placement).toMatchObject({ provider: "daytona", cwd: path.join(f.cwd, "app"), environmentLeaseId: f.lease.id });
    expect(placement.reuseKey).toContain(f.lease.providerLeaseId!);
    await expect(f.resolve(f.request, f.companyId, f.input({ cwd: "../escape" }))).rejects.toMatchObject({ status: 403 });
    await db.update(environmentLeases).set({ expiresAt: new Date(Date.now() + 300_000) }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.resolve(f.request, f.companyId, f.input())).rejects.toMatchObject({ status: 422 });
    await db.update(environmentLeases).set({ expiresAt: null, metadata: { ...f.lease.metadata, runtimeServiceBoundary: { ...f.boundary, network: "allowlist" } } }).where(eq(environmentLeases.id, f.lease.id));
    await expect(f.resolve(f.request, f.companyId, f.input())).rejects.toMatchObject({ status: 422 });
  });
});
