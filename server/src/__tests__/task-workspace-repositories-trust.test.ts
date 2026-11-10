import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, createDb, executionWorkspaceRepositoryRoots, executionWorkspaceRepositoryAccess, executionWorkspaceRepositories, executionWorkspaces,
  heartbeatRuns, issues, projects, projectWorkspaces, projectAccessMembers, companyMemberships, authUsers, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";

import { createRepositoryTrustFixture } from "./helpers/repository-trust-fixture.js";

const acquisition = vi.hoisted(() => ({ managedAuth: vi.fn(), materialize: vi.fn(), catalog: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: acquisition.catalog }) }));
vi.mock("../services/git-credentials.js", async (original) => ({
  ...await original<typeof import("../services/git-credentials.js")>(),
  createGitRemoteAuthProvider: () => acquisition.managedAuth,
}));
vi.mock("../services/managed-repository-checkout.js", async (original) => ({
  ...await original<typeof import("../services/managed-repository-checkout.js")>(),
  materializeManagedProjectWorkspace: acquisition.materialize,
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task repository trust authority", () => {
  const context = createRepositoryTrustFixture(acquisition);
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => { ({ db, root } = await context.setup()); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { acquisition.materialize.mockReset(); vi.clearAllMocks(); vi.restoreAllMocks(); });
  afterAll(context.cleanup);
  const { fixture, lowTrustPeer, standardPeer, privateTask, localPrivateClone } = context;

  it.each(["same_root", "ancestor", "descendant", "symlink"] as const)("ignores private historical filesystem owners at a %s path", async relation => {
    const f = await fixture(), peer = await standardPeer(f);
    await privateTask(f);
    let historicalRoot = f.admission.cwd;
    if (relation === "ancestor") historicalRoot = root;
    if (relation === "descendant") { historicalRoot = path.join(f.admission.cwd, "old-task"); await mkdir(historicalRoot); }
    if (relation === "symlink") { historicalRoot = path.join(root, `${f.issueId}-alias`); await symlink(f.admission.cwd, historicalRoot); }
    await db.update(executionWorkspaces).set({ cwd: historicalRoot }).where(eq(executionWorkspaces.id, f.workspace.id));
    const canonicalCwd = await realpath(f.admission.cwd);
    await db.insert(executionWorkspaceRepositoryAccess).values([
      { companyId: f.companyId, canonicalCwd, rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), kind: "source", scopeId: f.workspace.id },
      { companyId: f.companyId, canonicalCwd, rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), kind: "reader", scopeId: randomUUID(), issueId: randomUUID(), agentId: randomUUID(), responsibleUserId: "deleted-user" },
    ]);
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    await expect(f.service.assertPublicationAllowed(peer.admission)).resolves.toBeUndefined();
    const { authorizationService, canActorReadExecutionWorkspace } = await import("../services/authorization.js");
    expect((await authorizationService(db).decide({ actor: peer.actor, action: "issue:read",
      resource: { type: "issue", companyId: f.companyId, issueId: f.issueId } })).allowed).toBe(false);
    expect(await canActorReadExecutionWorkspace(db, peer.actor, f.workspace.id)).toBe(false);
  });

  it.each(["anonymous_only", "managed"] as const)("ignores a legacy %s directory reservation while preserving current acquisition restrictions", async mode => {
    const f = await fixture(), peer = await lowTrustPeer(f);
    const canonicalCwd = await realpath(f.admission.cwd);
    await db.insert(executionWorkspaceRepositoryRoots).values({ companyId: f.companyId, canonicalCwd,
      rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), mode });
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([]);
    await expect(f.request({ kind: "catalog", id: "private-repo" })).resolves.toMatchObject({ kind: "requires_next_admission" });
    await expect(f.service.request({ companyId: f.companyId, issueId: peer.admission.issueId, actor: peer.actor,
      request: { repository: { kind: "url", url: "https://github.com/public/new" }, requestKey: randomUUID() } })).rejects.toThrow(/trusted task|Selected workspace source trust/);
    expect(await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId)))
      .toHaveLength(1);
  });

  it("ignores unselected private/protected project aliases but rechecks the directly selected project", async () => {
    const f = await fixture();
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private source", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Other configuration", cwd: f.admission.cwd });
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(f.service.assertPublicationAllowed(f.admission)).resolves.toBeUndefined();
    await db.update(executionWorkspaces).set({ projectId: project.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow();
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await db.delete(projectAccessMembers).where(eq(projectAccessMembers.subjectId, f.userId));
    await expect(f.service.assertPublicationAllowed(f.admission)).rejects.toThrow();
  });

  it("rejects current identity and binding changes before publication", async () => {
    const f = await fixture();
    await expect(f.service.assertPublicationAllowed(f.admission)).resolves.toBeUndefined();
    await expect(f.service.assertPublicationAllowed({ ...f.admission, runId: randomUUID() })).rejects.toThrow(/identity/);
    await expect(f.service.prepareForAdmission({ ...f.admission, responsibleUserId: randomUUID() })).rejects.toThrow(/responsible user/);
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    await expect(f.service.assertPublicationAllowed(f.admission)).rejects.toThrow(/binding/);
  });

  it("rechecks source, destination, configuration, and current identity when copying", async () => {
    const f = await fixture();
    const source = path.join(root, `${f.issueId}-source`), moved = path.join(root, `${f.issueId}-moved`);
    await mkdir(source); await mkdir(moved);
    const alias = path.join(root, `${f.issueId}-source-alias`);
    await symlink(source, alias);
    const verify = await f.service.prepareConfiguredRepositoryCopy({ ...f.admission, sourceCwd: alias });
    await expect(verify()).resolves.toBeUndefined();
    await fs.unlink(alias); await symlink(moved, alias);
    await expect(verify()).rejects.toThrow(/source or destination changed/);
    const verifyIdentity = await f.service.prepareConfiguredRepositoryCopy({ ...f.admission, sourceCwd: source });
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    await expect(verifyIdentity()).rejects.toThrow(/identity/);
  });

  it("captures the bound workspace's source configuration even when the task has no source pointer", async () => {
    const f = await fixture();
    const source = path.join(root, `${f.issueId}-configured-source`);
    await mkdir(source);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Selected configuration" }).returning();
    const [configuration] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id,
      name: "Source", cwd: source }).returning();
    await db.update(executionWorkspaces).set({ projectId: project.id, projectWorkspaceId: configuration.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    const verify = await f.service.prepareConfiguredRepositoryCopy({ ...f.admission, sourceCwd: source });
    await expect(verify()).resolves.toBeUndefined();
    await db.update(projectWorkspaces).set({ cwd: f.admission.cwd }).where(eq(projectWorkspaces.id, configuration.id));
    await expect(verify()).rejects.toThrow(/configuration changed/);
  });

  it("validates a prebinding configured copy without requiring a destination workspace row", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
    const verify = await f.service.prepareConfiguredRepositoryCopy({ ...f.admission, workspaceId: randomUUID(),
      cwd: path.join(root, `${f.issueId}-not-created`), sourceCwd: f.admission.cwd });
    await expect(verify()).resolves.toBeUndefined();
  });

  it("reuses the marker's exact private-origin receipt without requiring its task's app access", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await privateTask(f);
    const first = await f.request({ kind: "catalog", id: "private-repo" });
    await localPrivateClone(f);
    const [published] = await f.service.prepareForAdmission(f.admission);
    const next = await f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } });
    const decoys = await db.insert(executionWorkspaces).values(Array.from({ length: 500 }, () => ({
      companyId: f.companyId, name: "Unrelated matching receipt", cwd: f.admission.cwd,
      mode: "shared_workspace", strategyType: "operator_directory" }))).returning({ id: executionWorkspaces.id });
    await db.insert(executionWorkspaceRepositories).values(decoys.map(workspace => ({ companyId: f.companyId,
      executionWorkspaceId: workspace.id, requestedByIssueId: f.issueId, repositoryIdentity: first.repository.repositoryIdentity,
      repoUrl: first.repository.repoUrl, catalogRepositoryId: "private-repo", relativePath: first.repository.relativePath,
      requestedRef: first.repository.requestedRef, requestKey: randomUUID(), state: "ready", pinnedCommit: "b".repeat(40) })));
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(actual.materializeManagedProjectWorkspace);
    await expect(f.service.prepareForAdmission(peer.admission)).resolves.toEqual([
      expect.objectContaining({ id: next.operationId, cwd: published.cwd, pinnedCommit: published.pinnedCommit }),
    ]);
    expect(JSON.parse(await readFile(path.join(published.cwd, ".git", "paperclip-workspace-owner.json"), "utf8")))
      .toMatchObject({ repositoryId: next.operationId, pinnedCommit: published.pinnedCommit });
    const { authorizationService } = await import("../services/authorization.js");
    expect((await authorizationService(db).decide({ actor: peer.actor, action: "issue:read",
      resource: { type: "issue", companyId: f.companyId, issueId: f.issueId } })).allowed).toBe(false);
  });

  it("keeps shared checkout ownership current when an earlier workspace moves", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    await f.request({ kind: "catalog", id: "private-repo" });
    await localPrivateClone(f);
    const [published] = await f.service.prepareForAdmission(f.admission);
    const next = await f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } });
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(actual.materializeManagedProjectWorkspace);
    await f.service.prepareForAdmission(peer.admission);
    const moved = path.join(root, `${f.issueId}-moved-after-reuse`);
    await mkdir(moved);
    await db.update(executionWorkspaces).set({ cwd: moved }).where(eq(executionWorkspaces.id, f.workspace.id));
    const latest = await standardPeer(f);
    const last = await f.service.request({ companyId: f.companyId, issueId: latest.issueId, actor: latest.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } });
    acquisition.materialize.mockImplementationOnce(actual.materializeManagedProjectWorkspace);
    await expect(f.service.prepareForAdmission(latest.admission)).resolves.toEqual([
      expect.objectContaining({ id: last.operationId, cwd: published.cwd, pinnedCommit: published.pinnedCommit }),
    ]);
    expect(JSON.parse(await readFile(path.join(published.cwd, ".git", "paperclip-workspace-owner.json"), "utf8")))
      .toMatchObject({ repositoryId: last.operationId, pinnedCommit: published.pinnedCommit });
    expect((await f.service.list(f.companyId, peer.workspace.id))[0])
      .toMatchObject({ id: next.operationId, state: "ready", pinnedCommit: published.pinnedCommit });
    expect(await readFile(path.join(published.cwd, "private.txt"), "utf8")).toBe("Private task edits\n");
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it("does not transfer shared ownership after the current task binding changes", async () => {
    const f = await fixture(), peer = await standardPeer(f);
    const first = await f.request({ kind: "catalog", id: "private-repo" });
    await localPrivateClone(f);
    const [published] = await f.service.prepareForAdmission(f.admission);
    await f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } });
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(async (cwd, input) => {
      const result = await actual.materializeManagedProjectWorkspace(cwd, input);
      await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, peer.issueId));
      return result;
    });
    await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/publication binding/);
    expect(JSON.parse(await readFile(path.join(published.cwd, ".git", "paperclip-workspace-owner.json"), "utf8")))
      .toMatchObject({ repositoryId: first.operationId, pinnedCommit: published.pinnedCommit });
  });

  it.each(["missing", "malformed", "symlink", "foreign_company", "conflicting_pin"] as const)("rejects unverified shared publication ownership (%s) without overwriting files", async marker => {
    const f = await fixture(), peer = await standardPeer(f);
    const first = await f.request({ kind: "catalog", id: "private-repo" });
    await localPrivateClone(f);
    const [published] = await f.service.prepareForAdmission(f.admission);
    const next = await f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository: { kind: "catalog", id: "private-repo" }, requestKey: randomUUID() } });
    const ownerPath = path.join(published.cwd, ".git", "paperclip-workspace-owner.json");
    await rm(ownerPath);
    if (marker === "malformed") await writeFile(ownerPath, "{not-json");
    if (marker === "symlink") {
      const outside = path.join(root, `${f.issueId}-owner.json`);
      await writeFile(outside, JSON.stringify({ repositoryId: first.operationId, pinnedCommit: published.pinnedCommit }));
      await symlink(outside, ownerPath);
    }
    if (marker === "foreign_company") {
      const foreign = await fixture();
      const foreignReceipt = await foreign.request({ kind: "catalog", id: "private-repo" });
      await writeFile(ownerPath, JSON.stringify({ repositoryId: foreignReceipt.operationId, pinnedCommit: published.pinnedCommit }));
    }
    if (marker === "conflicting_pin") {
      await writeFile(ownerPath, JSON.stringify({ repositoryId: first.operationId, pinnedCommit: "b".repeat(40) }));
    }
    await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/matching preparation receipt|receipts disagree/);
    expect((await f.service.list(f.companyId, peer.workspace.id))[0]).toMatchObject({ id: next.operationId, state: "needs_repair" });
    expect(await readFile(path.join(published.cwd, "private.txt"), "utf8")).toBe("Private task edits\n");
  });

  it.each(["agent", "issue", "project", "workspace_source_project", "run"] as const)(
    "rejects catalog acquisition from raw %s low-trust policy", async source => {
      const f = await fixture();
      if (source === "agent") await db.update(agents).set({ permissions: f.policy }).where(eq(agents.id, f.agentId));
      if (source === "issue") await db.update(issues).set({ executionPolicy: f.policy }).where(eq(issues.id, f.issueId));
      if (source === "run") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
      if (source === "project" || source === "workspace_source_project") {
        const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Restricted", executionWorkspacePolicy: f.policy }).returning();
        if (source === "project") await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
        else {
          await db.update(projects).set({ executionWorkspacePolicy: { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
            trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [project.id] } } } }).where(eq(projects.id, project.id));
          await db.update(executionWorkspaces).set({ projectId: project.id, strategyType: "git_worktree" }).where(eq(executionWorkspaces.id, f.workspace.id));
        }
      }
      await expect(f.request({ kind: "catalog", id: "private-repo" })).rejects.toThrow(/anonymous public URLs only|trusted task|Selected workspace source trust/);
      expect(await db.select().from(executionWorkspaceRepositories).where(eq(executionWorkspaceRepositories.companyId, f.companyId))).toHaveLength(0);
      expect(acquisition.managedAuth).not.toHaveBeenCalled();
    },
  );

  it.each(["agent", "issue", "project", "workspace_source_project", "run"] as const)(
    "rejects public acquisition from raw %s policy even with full-auto provider permissions", async source => {
      const f = await fixture();
      await db.update(agents).set({ adapterConfig: { provider: "codex", codexPermissionMode: "never" },
        ...(source === "agent" ? { permissions: f.policy } : {}) }).where(eq(agents.id, f.agentId));
      if (source === "issue") await db.update(issues).set({ executionPolicy: f.policy }).where(eq(issues.id, f.issueId));
      if (source === "run") {
        await db.update(issues).set({ executionPolicy: {} }).where(eq(issues.id, f.issueId));
        await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
      }
      if (source === "project" || source === "workspace_source_project") {
        const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Restricted", executionWorkspacePolicy: f.policy }).returning();
        if (source === "project") await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, f.issueId));
        else {
          const admittedPolicy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
            trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [project.id] } } };
          await db.update(projects).set({ executionWorkspacePolicy: admittedPolicy }).where(eq(projects.id, project.id));
          await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: admittedPolicy } }).where(eq(heartbeatRuns.id, f.runId));
          await db.update(executionWorkspaces).set({ projectId: project.id, strategyType: "git_worktree" }).where(eq(executionWorkspaces.id, f.workspace.id));
        }
      }
      for (const url of ["https://github.com/public/example", "https://github.com/sponsor/private"]) {
        await expect(f.request({ kind: "url", url })).rejects.toThrow(/trusted task|Selected workspace source trust/);
      }
      expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
      expect(acquisition.materialize).not.toHaveBeenCalled();
      expect(acquisition.managedAuth).not.toHaveBeenCalled();
    });

  it.each(["pending", "preparing"] as const)("blocks %s public acquisition after trust is downgraded", async state => {
    const f = await fixture();
    const receipt = await f.request({ kind: "url", url: "https://github.com/public/example" });
    await db.update(executionWorkspaceRepositories).set({ state }).where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/trusted task|Selected workspace source trust/);
    expect((await f.service.list(f.companyId, f.workspace.id))[0].state).toBe(state);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it("rejects an unsponsored request even when the caller supplies a sponsor actor", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ responsibleUserId: null }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.request({ kind: "url", url: "https://github.com/public/example" })).rejects.toThrow(/responsible user/);
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
    await expect(f.service.prepareForAdmission({ ...f.admission, responsibleUserId: null })).resolves.toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each(["pending", "ready"] as const)("blocks a %s managed receipt after the run becomes low trust", async state => {
    const f = await fixture();
    const receipt = await f.request({ kind: "catalog", id: "private-repo" });
    await db.update(executionWorkspaceRepositories).set({ state, pinnedCommit: state === "ready" ? "a".repeat(40) : null })
      .where(eq(executionWorkspaceRepositories.id, receipt.operationId));
    const checkout = path.join(f.admission.cwd, receipt.repository.relativePath);
    if (state === "ready") { await mkdir(checkout, { recursive: true }); await writeFile(path.join(checkout, "private.txt"), "retained private bytes"); }
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.request({ kind: "url", url: receipt.repository.repoUrl })).rejects.toThrow(/anonymous public URLs only|trusted task|Selected workspace source trust/);
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/anonymous public URLs only|trusted task|Selected workspace source trust/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    if (state === "ready") expect(await readFile(path.join(checkout, "private.txt"), "utf8")).toBe("retained private bytes");
  });

  it.each([
    { status: "active", closedAt: new Date() },
    { status: "idle", closedAt: new Date() },
    { status: "archived", closedAt: null },
    { status: "in_review", closedAt: null },
  ])("rejects repository requests for unavailable $status workspaces (closed=$closedAt)", async lifecycle => {
    const f = await fixture();
    await db.update(executionWorkspaces).set(lifecycle).where(eq(executionWorkspaces.id, f.workspace.id));
    await expect(f.request({ kind: "url", url: "https://github.com/public/example" })).rejects.toThrow("Execution workspace is unavailable");
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each([
    { name: "missing task owner", patch: { sourceIssueId: null } },
    { name: "configured directory source", patch: { metadata: { source: "project_primary" } } },
    { name: "agent directory source", patch: { metadata: { source: "agent_home" } } },
    { name: "worktree strategy", patch: { strategyType: "git_worktree" } },
    { name: "adapter-managed mode", patch: { mode: "adapter_managed" } },
    { name: "configured root repository", patch: { repoUrl: "https://github.com/public/anchor" } },
  ])("keeps strict Git validation for $name", async ({ patch }) => {
    const f = await fixture();
    await f.request({ kind: "url", url: "https://github.com/public/example" });
    await db.update(executionWorkspaces).set({ strategyType: "project_primary", sourceIssueId: f.issueId,
      metadata: { source: "task_session" }, ...patch }).where(eq(executionWorkspaces.id, f.workspace.id));
    await mkdir(path.join(f.admission.cwd, ".git", "info"), { recursive: true });
    await writeFile(path.join(f.admission.cwd, ".git", "info", "exclude"), "/.paperclip-repositories/\n");
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow("not a git repository");
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each(["sponsored", "sponsored_git_residue", "sponsored_shared_git_residue", "local_board", "local_board_jwt", "routine"] as const)("prepares public Git from an idle workspace for a trusted %s task and reuses verified bytes after trust downgrade", async principal => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ status: "idle" }).where(eq(executionWorkspaces.id, f.workspace.id));
    const localBoard = principal === "local_board" || principal === "local_board_jwt";
    if (localBoard) await db.update(heartbeatRuns).set({ responsibleUserId: "local-board" }).where(eq(heartbeatRuns.id, f.runId));
    if (principal === "local_board_jwt") {
      await db.insert(authUsers).values({ id: "local-board", name: "Local Board", email: "local-board@example.invalid",
        emailVerified: true, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "local-board", membershipRole: "owner", status: "active" });
    }
    const receipt = await f.service.request({ companyId: f.companyId, issueId: f.issueId,
      actor: localBoard ? { ...f.actor, onBehalfOfUserId: principal === "local_board_jwt" ? "local-board" : null } : f.actor,
      request: { repository: { kind: "url", url: "https://github.com/public/example" }, requestKey: randomUUID() } });
    const responsibleUserId = localBoard ? "local-board" : principal === "routine" ? null : f.userId;
    await db.update(heartbeatRuns).set({ responsibleUserId }).where(eq(heartbeatRuns.id, f.runId));
    const admission = { ...f.admission, responsibleUserId };
    const source = path.join(root, `${f.issueId}-public-source`);
    await mkdir(source);
    const exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", source]);
    await writeFile(path.join(source, "public.txt"), "Public fixture bytes\n");
    await exec("git", ["-C", source, "add", "."]);
    await exec("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "public source"]);
    const actual = await vi.importActual<typeof import("../services/managed-repository-checkout.js")>("../services/managed-repository-checkout.js");
    acquisition.materialize.mockImplementationOnce(async (cwd, input) => {
      const auth = await input.resolveGitAuth(input.repoUrl);
      expect(auth.env).toMatchObject({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" });
      expect(auth.configArgs).toEqual(buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null }).configArgs);
      const result = await actual.materializeManagedProjectWorkspace(cwd, { ...input, localSource: source });
      await exec("git", ["-C", cwd, "remote", "set-url", "origin", input.repoUrl]);
      return result;
    });
    if (principal === "sponsored_git_residue" || principal === "sponsored_shared_git_residue") {
      await db.update(executionWorkspaces).set({ strategyType: "project_primary", sourceIssueId: f.issueId,
        mode: principal === "sponsored_shared_git_residue" ? "shared_workspace" : "isolated_workspace", metadata: { source: "task_session" } }).where(eq(executionWorkspaces.id, f.workspace.id));
      await mkdir(path.join(f.admission.cwd, ".git", "info"), { recursive: true });
      await writeFile(path.join(f.admission.cwd, ".git", "info", "exclude"), "/.paperclip-repositories/\n");
    }
    const [prepared] = await f.service.prepareForAdmission(admission);
    expect(prepared.id).toBe(receipt.operationId);
    expect(await readFile(path.join(prepared.cwd, "public.txt"), "utf8")).toBe("Public fixture bytes\n");
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
    await writeFile(path.join(prepared.cwd, "committed.txt"), "Later task commit\n");
    await exec("git", ["-C", prepared.cwd, "add", "committed.txt"]);
    await exec("git", ["-C", prepared.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "task changes"]);
    const editedHead = (await exec("git", ["-C", prepared.cwd, "rev-parse", "HEAD"])).stdout.trim();
    expect(editedHead).not.toBe(prepared.pinnedCommit);
    await writeFile(path.join(prepared.cwd, "dirty.txt"), "Uncommitted task bytes\n");
    acquisition.materialize.mockClear();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.prepareForAdmission(admission)).resolves.toEqual([prepared]);
    await expect(f.service.assertRecoveryBinding(admission)).resolves.toBeUndefined();
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(await readFile(path.join(prepared.cwd, "public.txt"), "utf8")).toBe("Public fixture bytes\n");
    expect((await exec("git", ["-C", prepared.cwd, "rev-parse", "HEAD"])).stdout.trim()).toBe(editedHead);
    expect(await readFile(path.join(prepared.cwd, "dirty.txt"), "utf8")).toBe("Uncommitted task bytes\n");
    await rm(prepared.cwd, { recursive: true });
    await expect(f.service.prepareForAdmission(admission)).rejects.toThrow(/trusted task|Selected workspace source trust/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each(["local-board", null, "changed-human"])("rejects the former sponsor after responsibility changes to %s", async responsibleUserId => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ responsibleUserId }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.request({ kind: "url", url: "https://github.com/public/example" })).rejects.toThrow(
      responsibleUserId === null ? "Repository access requires a responsible user" : "Task workspace responsible user changed");
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
  });

  it("reauthorizes a public clone before publication after trust changes during Git", async () => {
    const f = await fixture();
    const receipt = await f.request({ kind: "url", url: "https://github.com/public/example" });
    await localPrivateClone(f, async () => {
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    });
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/trusted task|Selected workspace source trust/);
    await expect(fs.lstat(path.join(f.admission.cwd, receipt.repository.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.service.list(f.companyId, f.workspace.id))[0]).toMatchObject({ pinnedCommit: null, state: "needs_repair" });
    expect(acquisition.materialize).toHaveBeenCalledOnce();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it.each(["catalog_revocation", "binding_change", "responsible_user_change"] as const)("rejects a staged clone before publication after %s", async change => {
    const f = await fixture();
    const receipt = await f.request({ kind: "catalog", id: "private-repo" });
    await localPrivateClone(f, async () => {
      if (change === "catalog_revocation") acquisition.catalog.mockResolvedValue({ repositories: [] });
      if (change === "binding_change") await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.issueId));
      if (change === "responsible_user_change") await db.update(heartbeatRuns).set({ responsibleUserId: randomUUID() }).where(eq(heartbeatRuns.id, f.runId));
    });
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/no longer available|binding|responsible user/);
    await expect(fs.lstat(path.join(f.admission.cwd, receipt.repository.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await f.service.list(f.companyId, f.workspace.id))[0]).toMatchObject({ state: "needs_repair", pinnedCommit: null });
  });

  it.each(["standard", "retained_low_trust", "current_low_trust"] as const)("recovers an exact legacy run-ID binding with %s trust", async trust => {
    const f = await fixture();
    const execution = buildNativeExecutionInput({
      companyId: f.companyId, runId: f.runId, agentId: f.agentId,
      issue: { id: f.issueId, identifier: "LEG-1", title: "Legacy recovery", description: null, workMode: "standard" },
      taskPrompt: "Continue", normalizedSessionId: randomUUID(), provider: "codex",
      workspace: { id: f.runId, cwd: f.admission.cwd, repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: randomUUID(), sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.run-result.v1", contract: { revision: "1", objective: "Recover", criteria: [{ id: "objective", requirement: "Keep the admitted folder" }] } },
      runtimeContext: nativeRuntimeContextFixture(),
    });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", runnerProfileJson: { nativeExecutionInput: execution },
      contextSnapshot: { issueId: f.issueId, ...(trust === "retained_low_trust" ? { executionPolicy: f.policy } : {}) } }).where(eq(heartbeatRuns.id, f.runId));
    if (trust === "current_low_trust") await db.update(agents).set({ permissions: f.policy }).where(eq(agents.id, f.agentId));
    await expect(f.service.assertRecoveryBinding({ ...f.admission, workspaceId: f.runId })).resolves.toBeUndefined();
    const reservations = await db.select().from(executionWorkspaceRepositoryRoots).where(eq(executionWorkspaceRepositoryRoots.companyId, f.companyId));
    expect(reservations).toHaveLength(0);
    await expect(f.service.assertRecoveryBinding({ ...f.admission, workspaceId: randomUUID() })).rejects.toThrow(/recovery identity/);
    execution.binding.agentId = randomUUID();
    await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: execution } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.assertRecoveryBinding({ ...f.admission, workspaceId: f.runId })).rejects.toThrow(/recovery identity/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("retains previous run trust without confusing a board request's reassigned agent", async () => {
    const f = await fixture();
    const [replacement] = await db.insert(agents).values({ companyId: f.companyId, name: "Replacement", adapterType: "process" }).returning();
    await db.update(issues).set({ assigneeAgentId: replacement.id }).where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", contextSnapshot: { taskId: f.issueId } }).where(eq(heartbeatRuns.id, f.runId));
    const request = () => f.service.request({ companyId: f.companyId, issueId: f.issueId,
      actor: { type: "board", source: "local_implicit", userId: "local-board" },
      request: { requestKey: randomUUID(), repository: { kind: "catalog", id: "private-repo" } } });
    await expect(request()).resolves.toMatchObject({ kind: "requires_next_admission" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { taskId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(request()).rejects.toThrow(/anonymous public URLs only|trusted task|Selected workspace source trust/);
  });

  it("keeps standard empty-inventory admission free of repository acquisition work", async () => {
    const f = await fixture();
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    expect(acquisition.catalog).not.toHaveBeenCalled();
    expect(acquisition.materialize).not.toHaveBeenCalled();
    await db.insert(executionWorkspaceRepositories).values({ companyId: f.companyId, executionWorkspaceId: f.workspace.id,
      requestedByIssueId: f.issueId, repositoryIdentity: "https://github.com/public/example", repoUrl: "https://github.com/public/example",
      relativePath: ".paperclip-repositories/unused", requestedRef: "HEAD", requestKey: "requires-authority", requestKeys: ["requires-authority"] });
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow();
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("keeps low-trust empty-inventory admission free of acquisition-only filesystem requirements", async () => {
    const f = await fixture();
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.prepareForAdmission({ ...f.admission, cwd: path.join(root, "not-materialized") })).resolves.toEqual([]);
    expect(acquisition.catalog).not.toHaveBeenCalled();
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("rejects admission without the persisted task run before materialization", async () => {
    const f = await fixture();
    await f.request({ kind: "catalog", id: "private-repo" });
    await expect(f.service.prepareForAdmission({ ...f.admission, runId: randomUUID() })).rejects.toThrow(/run identity/);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });
});
