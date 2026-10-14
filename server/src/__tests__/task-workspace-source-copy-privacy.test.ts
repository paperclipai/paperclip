import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositoryRoots, executionWorkspaceRepositoryAccess, executionWorkspaceRepositories, executionWorkspaces,
  heartbeatRuns, issueAccessGrants, issues, projects, projectWorkspaces, projectAccessMembers, principalPermissionGrants, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertExecutionWorkspaceRootReadAccess, assertExecutionWorkspaceRootWriteAccess, assertIsolatedWorkspaceSourceReadAccess, retainIsolatedWorkspaceSourceAccess, executionWorkspaceRepositoryService } from "../services/execution-workspace-repositories.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { projectService } from "../services/projects.js";
import { buildNativeExecutionInput } from "../services/native-runtime/native-execution-input.js";
import { nativeRuntimeContextFixture } from "../services/native-runtime/runtime-context.test-fixture.js";
import { buildGitAuthInvocation } from "../services/git-credentials.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

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
(support.supported ? describe : describe.skip)("task workspace source copy privacy", () => {
  const context = createRepositoryTrustFixture(acquisition);
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => { ({ db, root } = await context.setup()); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
  afterAll(context.cleanup);
  const { fixture, lowTrustPeer, standardPeer, privateTask, grantPeer, localPrivateClone } = context;

  it.each(["current", "retained", "standard_run", "absent_run_policy", "narrower_boundary"] as const)("rejects incompatible physical project trust (%s) without changing file read authority", async scenario => {
    const f = await fixture();
    const projectId = randomUUID();
    const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy, trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [projectId] } } };
    const [owner] = await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Low-trust physical owner", executionWorkspacePolicy: policy }).returning();
    const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: owner.id, name: "Physical source", cwd: f.admission.cwd, isPrimary: true }).returning();
    if (scenario === "retained") await projectService(db).updateWorkspace(owner.id, source.id, { cwd: path.join(root, randomUUID()) });
    if (scenario === "standard_run" || scenario === "absent_run_policy") {
      await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issueId));
      if (scenario === "standard_run") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: { trustPreset: "standard" } } }).where(eq(heartbeatRuns.id, f.runId));
    }
    if (scenario === "narrower_boundary") {
      const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy, trustBoundary: {
        mode: "low_trust_review", companyId: f.companyId, issueIds: [f.issueId], projectIds: [owner.id],
      } } };
      await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issueId));
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: policy } }).where(eq(heartbeatRuns.id, f.runId));
    }
    await expect(assertExecutionWorkspaceRootReadAccess(db, { ...f.admission, actor: f.actor, sourceWorkspaceId: f.workspace.id })).resolves.toBeUndefined();
    await expect(assertExecutionWorkspaceRootWriteAccess(db, { ...f.admission, actor: f.actor, sourceWorkspaceId: f.workspace.id })).rejects.toThrow("Physical workspace source trust is incompatible");
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow("Physical workspace source trust is incompatible");
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("keeps a declared low-trust source compatible with its retained effective policy", async () => {
    const f = await fixture();
    const projectId = randomUUID();
    const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy, trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [projectId] } } };
    const [owner] = await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Declared low-trust source", executionWorkspacePolicy: policy }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: owner.id, name: "Source", cwd: f.admission.cwd, isPrimary: true });
    await db.update(executionWorkspaces).set({ projectId: owner.id }).where(eq(executionWorkspaces.id, f.workspace.id));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: policy } }).where(eq(heartbeatRuns.id, f.runId));
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each(["writer", "retained_reader"] as const)("rejects incompatible %s trust before copy provisioning without minting copy proof", async principal => {
    const f = await fixture(), exec = promisify(execFileCallback);
    if (principal === "retained_reader") await f.service.prepareForAdmission(f.admission);
    const sourceCwd = path.join(root, `${f.issueId}-low-trust-source`);
    await mkdir(sourceCwd);
    await exec("git", ["init", "--initial-branch=main", sourceCwd]);
    await writeFile(path.join(sourceCwd, "source.txt"), "Low-trust source\n");
    await exec("git", ["-C", sourceCwd, "add", "."]);
    await exec("git", ["-C", sourceCwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    await rm(f.admission.cwd, { recursive: true });
    await exec("git", ["-C", sourceCwd, "worktree", "add", "-b", "target", f.admission.cwd]);
    const projectId = randomUUID();
    const policy = { ...f.policy, authorizationPolicy: { ...f.policy.authorizationPolicy,
      trustBoundary: { ...f.policy.authorizationPolicy.trustBoundary, projectIds: [projectId] } } };
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Low-trust copied source", executionWorkspacePolicy: policy });
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId, name: "Source", cwd: sourceCwd });
    let actor = f.actor;
    if (principal === "retained_reader") {
      const runId = randomUUID();
      await db.update(issues).set({ executionPolicy: policy }).where(eq(issues.id, f.issueId));
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, responsibleUserId: f.userId,
        status: "running", contextSnapshot: { issueId: f.issueId, executionPolicy: policy } });
      actor = { ...f.actor, runId };
    }
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd, actor });
    await expect(retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd, targetCwd: f.admission.cwd,
      actor, issueId: f.issueId, captured, phase: "verified" })).rejects.toThrow("Physical workspace source trust is incompatible");
    const entries = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(entries.some(entry => entry.kind === "isolated_project_source" && entry.scopeId === projectId)).toBe(true);
    expect(entries.some(entry => entry.kind === "isolated_copy")).toBe(false);
    expect(await readFile(path.join(f.admission.cwd, "source.txt"), "utf8")).toBe("Low-trust source\n");
  });

  it.each([
    { owner: "configured", direction: "descendant" }, { owner: "configured", direction: "ancestor" },
    { owner: "execution", direction: "descendant" }, { owner: "execution", direction: "ancestor" },
  ])("authorizes newly overlapping private $owner $direction owners before selection, admission and publication", async ({ owner, direction }) => {
    const f = await fixture();
    const child = path.join(f.admission.cwd, "private");
    await mkdir(child);
    const privateCwd = direction === "descendant" ? child : f.admission.cwd;
    if (direction === "ancestor") {
      f.admission.cwd = child;
      await db.update(executionWorkspaces).set({ cwd: child }).where(eq(executionWorkspaces.id, f.workspace.id));
    }
    await f.service.prepareForAdmission(f.admission);  
    let grant: () => Promise<unknown>;
    let detach: () => Promise<unknown>;
    if (owner === "configured") {
      const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Nested private source", visibility: "private" }).returning();
      const [source] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Private files", cwd: privateCwd }).returning();
      grant = () => db.insert(projectAccessMembers).values([
        { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
        { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
      ]);
      detach = async () => {
        await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, source.id));
        await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, project.id));
      };
    } else {
      const peer = await standardPeer(f);
      await db.update(executionWorkspaces).set({ cwd: privateCwd }).where(eq(executionWorkspaces.id, peer.workspace.id));
      await db.update(issues).set({ visibility: "private", privacyRootIssueId: peer.issueId, responsibleUserId: peer.userId }).where(eq(issues.id, peer.issueId));
      grant = () => db.insert(issueAccessGrants).values([
        { issueId: peer.issueId, subjectType: "agent", subjectId: f.agentId, source: "explicit", grantedByUserId: peer.userId },
        { issueId: peer.issueId, subjectType: "user", subjectId: f.userId, source: "explicit", grantedByUserId: peer.userId },
      ]);
      detach = async () => {
        const moved = path.join(root, `${peer.issueId}-moved`); await mkdir(moved);
        await executionWorkspaceService(db).update(peer.workspace.id, { cwd: moved });
        await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, peer.issueId));
      };
    }
    await writeFile(path.join(privateCwd, "private.txt"), "Nested private files\n");
    const read = () => assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: f.admission.cwd, actor: f.actor, sourceWorkspaceId: f.workspace.id });
    const select = () => executionWorkspaceService(db).selectTaskWorkspace({ companyId: f.companyId, issueId: f.issueId, actor: f.actor,
      selection: { kind: "existing", workspaceId: f.workspace.id }, expectedBindingRevision: 0, requestKey: randomUUID() });
    await expect(read()).rejects.toThrow(/source project|workspace access|authorization boundary/);
    await expect(select()).rejects.toThrow(/source project|workspace access|authorization boundary/);
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/source project|workspace access|authorization boundary/);
    await expect(f.service.guardForPublication(f.admission)).rejects.toThrow(/source project|workspace access|authorization boundary/);
    await grant();
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(read()).resolves.toBeUndefined();
    await detach();
    await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/source project|workspace access|authorization boundary/);
    await expect(read()).rejects.toThrow(/source project|workspace access|authorization boundary/);
  });

  it("does not confuse sibling component prefixes with overlapping roots", async () => {
    const f = await fixture();
    const sibling = `${f.admission.cwd}er`; await mkdir(sibling);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Unrelated private source", visibility: "private" }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Sibling", cwd: sibling });
    await db.insert(executionWorkspaceRepositoryAccess).values({ companyId: f.companyId, rootKey: createHash("sha256").update(await realpath(sibling)).digest("hex"),
      canonicalCwd: await realpath(sibling), kind: "project_source", scopeId: project.id });
    await db.insert(executionWorkspaceRepositoryRoots).values({ companyId: f.companyId, rootKey: createHash("sha256").update(await realpath(sibling)).digest("hex"),
      canonicalCwd: await realpath(sibling), mode: "anonymous_only" });
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(f.request({ kind: "catalog", id: "private-repo" })).resolves.toMatchObject({ kind: "requires_next_admission" });
  });

  it.each([
    { mode: "managed", direction: "ancestor" }, { mode: "managed", direction: "descendant" },
    { mode: "anonymous_only", direction: "ancestor" }, { mode: "anonymous_only", direction: "descendant" },
  ] as const)("fences $mode root policy against opposite-mode $direction acquisition", async ({ mode, direction }) => {
    const f = await fixture();
    const child = path.join(f.admission.cwd, "nested"); await mkdir(child);
    const existingRoot = direction === "ancestor" ? child : f.admission.cwd;
    if (direction === "descendant") {
      f.admission.cwd = child;
      await db.update(executionWorkspaces).set({ cwd: child }).where(eq(executionWorkspaces.id, f.workspace.id));
    }
    const canonicalCwd = await realpath(existingRoot);
    await db.insert(executionWorkspaceRepositoryRoots).values({ companyId: f.companyId, canonicalCwd,
      rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), mode });
    if (mode === "managed") {
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, executionPolicy: f.policy } }).where(eq(heartbeatRuns.id, f.runId));
      await expect(f.service.prepareForAdmission(f.admission)).rejects.toThrow(/anonymous public URLs only/);
    } else await expect(f.request({ kind: "catalog", id: "private-repo" })).rejects.toThrow(/anonymous public URLs only/);
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it("reauthorizes a nested private publication against an already-admitted parent reader", async () => {
    const f = await fixture();
    await f.service.prepareForAdmission(f.admission);
    const peer = await standardPeer(f), child = path.join(f.admission.cwd, "private"); await mkdir(child);
    peer.admission.cwd = child;
    await db.update(executionWorkspaces).set({ cwd: child }).where(eq(executionWorkspaces.id, peer.workspace.id));
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: peer.issueId, responsibleUserId: peer.userId }).where(eq(issues.id, peer.issueId));
    const request = () => f.service.request({ companyId: f.companyId, issueId: peer.issueId, actor: peer.actor,
      request: { repository: { kind: "url", url: "https://github.com/public/nested" }, requestKey: randomUUID() } });
    await expect(request()).rejects.toThrow(/workspace access|authorization boundary/);
    await db.insert(issueAccessGrants).values([
      { issueId: peer.issueId, subjectType: "agent", subjectId: f.agentId, source: "explicit", grantedByUserId: peer.userId },
      { issueId: peer.issueId, subjectType: "user", subjectId: f.userId, source: "explicit", grantedByUserId: peer.userId },
    ]);
    const receipt = await request();
    await localPrivateClone({ ...f, issueId: peer.issueId }, async () => {
      await db.delete(issueAccessGrants).where(eq(issueAccessGrants.issueId, peer.issueId));
    });
    await expect(f.service.prepareForAdmission(peer.admission)).rejects.toThrow(/workspace access|authorization boundary/);
    await expect(fs.lstat(path.join(child, receipt.repository.relativePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect(acquisition.materialize).toHaveBeenCalledOnce();
  });

  it.each(["subdirectory", "linked_worktree", "nested_target"] as const)("retains private Git owner provenance copied through a %s without requiring source write grants", async sourceKind => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const privateCwd = path.join(f.admission.cwd, "private"), publicCwd = path.join(f.admission.cwd, "public");
    await mkdir(privateCwd); await mkdir(publicCwd);
    await writeFile(path.join(privateCwd, "secret.txt"), "Copied private Git bytes\n");
    await writeFile(path.join(publicCwd, "readme.txt"), "Public nested configuration\n");
    await exec("git", ["init", "--initial-branch=main", f.admission.cwd]);
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private copied source", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Private nested files", cwd: privateCwd });
    if (sourceKind === "nested_target") {
      const [outer] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected ancestor source",
        executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
      await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: outer.id, name: "Ancestor source", cwd: f.admission.cwd });
    }
    let sourceCwd = publicCwd;
    if (sourceKind === "linked_worktree") {
      sourceCwd = path.join(root, `${f.issueId}-linked`);
      await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "linked", sourceCwd]);
    }
    await expect(assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd, actor: f.actor })).rejects.toThrow(/source project/);
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd, actor: f.actor });
    expect(captured.projectIds).toContain(project.id);
    const targetCwd = sourceKind === "nested_target" ? path.join(f.admission.cwd, ".paperclip", "worktrees", "copy") : path.join(root, `${f.issueId}-copy`);
    await retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd, targetCwd, actor: f.actor, captured });
    await expect(fs.lstat(targetCwd)).rejects.toMatchObject({ code: "ENOENT" });
    if (sourceKind === "nested_target") {
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { companyId: f.companyId, cwd: targetCwd,
        actor: f.actor, issueId: f.issueId })).rejects.toThrow(/protected|assignment grant/);
    }
    await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "copy", targetCwd]);
    await retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd, targetCwd, actor: f.actor, captured, phase: "verified" });
    const [target] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Isolated copy", cwd: targetCwd,
      mode: "isolated_workspace", strategyType: "git_worktree" }).returning();
    await db.update(issues).set({ executionWorkspaceId: target.id }).where(eq(issues.id, f.issueId));
    await expect(f.service.prepareForAdmission({ ...f.admission, workspaceId: target.id, cwd: targetCwd })).resolves.toEqual([]);
    expect(await readFile(path.join(targetCwd, "private", "secret.txt"), "utf8")).toBe("Copied private Git bytes\n");
    if (sourceKind === "nested_target") {
      await fs.rename(path.join(targetCwd, ".git"), path.join(targetCwd, ".saved-git"));
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { companyId: f.companyId, cwd: targetCwd,
        actor: f.actor, issueId: f.issueId })).rejects.toThrow(/protected|assignment grant/);
      await fs.rename(path.join(targetCwd, ".saved-git"), path.join(targetCwd, ".git"));
    }
    await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, project.id));
    await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: targetCwd, actor: f.actor, sourceWorkspaceId: target.id })).rejects.toThrow(/source project/);
  });

  it.each(["file_uri", "absolute_path", "materialized_copy"] as const)("authorizes URL-only private configured owners before a public local clone (%s)", async transport => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const sourceCwd = path.join(root, `${f.issueId}-url-only-source`); await mkdir(sourceCwd);
    await exec("git", ["init", "--initial-branch=main", sourceCwd]);
    await writeFile(path.join(sourceCwd, "secret.txt"), "Private URL source\n");
    await exec("git", ["-C", sourceCwd, "add", "."]);
    await exec("git", ["-C", sourceCwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const repoUrl = transport === "absolute_path" ? sourceCwd : `file://${sourceCwd}`;
    const [privateProject] = await db.insert(projects).values({ companyId: f.companyId, name: "Private URL owner", visibility: "private" }).returning();
    const privateCopy = transport === "materialized_copy" ? path.join(root, `${f.issueId}-independent-private`) : null;
    if (privateCopy) await exec("git", ["clone", repoUrl, privateCopy]);
    const [privateSource] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: privateProject.id,
      name: "URL-only private source", cwd: privateCopy, repoUrl }).returning();
    const [publicProject] = await db.insert(projects).values({ companyId: f.companyId, name: "Public URL selection" }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: publicProject.id, name: "Same URL", cwd: null, repoUrl });
    await db.update(issues).set({ projectId: publicProject.id }).where(eq(issues.id, f.issueId));
    const sourceInput = { companyId: f.companyId, sourceCwd, actor: f.actor, copyKind: "repository" as const };
    if (privateCopy) {
      const captured = await assertIsolatedWorkspaceSourceReadAccess(db, sourceInput);
      expect(captured.projectIds).not.toContain(privateProject.id);
      return;  
    }
    await expect(assertIsolatedWorkspaceSourceReadAccess(db, sourceInput)).rejects.toThrow(/source project/);
    const before = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(before).toEqual([]);
    await projectService(db, { captureWorkspaceUpdates: false }).updateWorkspace(privateProject.id, privateSource.id,
      { repoUrl: "https://github.com/example/moved" });
    await expect(assertIsolatedWorkspaceSourceReadAccess(db, sourceInput)).rejects.toThrow(/source project/);
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: privateProject.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: privateProject.id, subjectType: "user", subjectId: f.userId },
    ]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, sourceInput);
    const targetCwd = path.join(root, `${f.issueId}-url-copy`);
    await retainIsolatedWorkspaceSourceAccess(db, { ...sourceInput, targetCwd, captured, issueId: f.issueId });
    await exec("git", ["clone", repoUrl, targetCwd]);
    await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, privateProject.id));
    await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: targetCwd, actor: f.actor })).rejects.toThrow(/source project/);
    expect(await readFile(path.join(targetCwd, "secret.txt"), "utf8")).toBe("Private URL source\n");
  });

  it.each(["checkout", "bare", "protected_ancestor"] as const)("guards unbound local repository staging and publication without worktree authority (%s)", async scenario => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const checkout = path.join(root, `${f.issueId}-local-origin`); await mkdir(checkout);
    await exec("git", ["init", "--initial-branch=main", checkout]);
    await writeFile(path.join(checkout, "secret.txt"), "Committed private bytes\n");
    await exec("git", ["-C", checkout, "add", "."]);
    await exec("git", ["-C", checkout, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "private source"]);
    const sourceCwd = scenario === "bare" ? path.join(root, `${f.issueId}-bare.git`) : checkout;
    if (scenario === "bare") await exec("git", ["clone", "--bare", checkout, sourceCwd]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private local origin", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Local source owner", cwd: sourceCwd });
    const sourceInput = { companyId: f.companyId, sourceCwd, actor: f.actor, copyKind: "repository" as const };
    await expect(assertIsolatedWorkspaceSourceReadAccess(db, sourceInput)).rejects.toThrow(/source project/);
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, sourceInput);
    const stage = scenario === "protected_ancestor" ? path.join(sourceCwd, "clone-staging") : path.join(root, `${f.issueId}-staging`);
    const input = { ...sourceInput, targetCwd: stage, captured, issueId: f.issueId, phase: "verified" as const };
    if (scenario === "protected_ancestor") {
      await expect(retainIsolatedWorkspaceSourceAccess(db, input)).rejects.toThrow(/protected|assignment grant/);
      await expect(fs.lstat(stage)).rejects.toMatchObject({ code: "ENOENT" });
    } else {
      await retainIsolatedWorkspaceSourceAccess(db, input);
      await exec("git", ["clone", sourceCwd, stage]);
      const target = path.join(root, `${f.issueId}-published-local`);
      await retainIsolatedWorkspaceSourceAccess(db, { ...input, targetCwd: target });
      await fs.rename(stage, target);
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, project.id));
      await expect(retainIsolatedWorkspaceSourceAccess(db, { ...input, targetCwd: target })).rejects.toThrow(/source project/);
      await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: target, actor: f.actor })).rejects.toThrow(/source project/);
      expect(await readFile(path.join(target, "secret.txt"), "utf8")).toBe("Committed private bytes\n");
    }
    const entries = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(entries.some(entry => entry.kind === "isolated_project_source" && entry.scopeId === project.id)).toBe(true);
    expect(entries.some(entry => entry.kind === "isolated_copy")).toBe(false);
  });

  it.each(["url", "catalog"] as const)("rejects independent local-file acquisition through %s before a receipt or clone", async kind => {
    const f = await fixture();
    const url = `file://${f.admission.cwd}`;
    if (kind === "catalog") acquisition.catalog.mockResolvedValue({ repositories: [{ id: "private-repo", fullName: "private/local", url, connections: ["fixture"] }] });
    await expect(f.request(kind === "url" ? { kind, url } : { kind, id: "private-repo" })).rejects.toThrow(/HTTPS GitHub/);
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });

  it.each(["grant_revoked", "source_detached", "retained_reader"] as const)("retains configured sibling source privacy on the task root (%s)", async scenario => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const sourceCwd = path.join(root, `${f.issueId}-configured-source`);
    await mkdir(sourceCwd);
    const privateCwd = path.join(sourceCwd, "private"); await mkdir(privateCwd);
    await writeFile(path.join(privateCwd, "secret.txt"), "Private configured bytes\n");
    await exec("git", ["init", "--initial-branch=main", sourceCwd]);
    await exec("git", ["-C", sourceCwd, "add", "."]);
    await exec("git", ["-C", sourceCwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private sibling source", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    const [configuration] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Private subtree", cwd: privateCwd }).returning();
    const input = { ...f.admission, sourceCwd };
    const peer = scenario === "retained_reader" ? await standardPeer(f) : null;
    if (peer) await f.service.prepareForAdmission(peer.admission);
    await expect(f.service.prepareConfiguredRepositorySource(input)).rejects.toThrow(/source project/);
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    if (peer) {
      await expect(f.service.prepareConfiguredRepositorySource(input)).rejects.toThrow(/source project/);
    } else {
      const beforePublish = await f.service.prepareConfiguredRepositorySource(input);
      const destination = path.join(f.admission.cwd, ".paperclip-repositories", "configured-source");
      await exec("git", ["clone", sourceCwd, destination]);
      await expect(beforePublish()).resolves.toBeUndefined();
      if (scenario === "source_detached") await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, configuration.id));
      await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, project.id));
      await expect(beforePublish()).rejects.toThrow(/source project/);
      await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: f.admission.cwd, actor: f.actor })).rejects.toThrow(/source project/);
      expect(await readFile(path.join(destination, "private", "secret.txt"), "utf8")).toBe("Private configured bytes\n");
    }
    const entries = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(entries.some(entry => entry.kind === "isolated_project_source" && entry.scopeId === project.id)).toBe(true);
    expect(entries.some(entry => entry.kind === "isolated_copy")).toBe(false);
    expect(entries.filter(entry => entry.kind === "reader")).toHaveLength(peer ? 1 : 0);
  });

  it.each(["primary", "linked", "separate primary"] as const)("does not probe unrelated company Git paths when the %s source is identified", async kind => {
    const f = await fixture(), exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main",
      ...(kind === "separate primary" ? ["--separate-git-dir", path.join(root, `${f.issueId}-metadata`)] : []), f.admission.cwd]);
    const privateCwd = path.join(f.admission.cwd, "private"); await mkdir(privateCwd);
    await writeFile(path.join(privateCwd, "secret.txt"), "Private tracked bytes\n");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    let sourceCwd = f.admission.cwd;
    if (kind === "linked") {
      sourceCwd = path.join(root, `${f.issueId}-linked-normal`);
      await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "linked-normal", sourceCwd]);
    }
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private nested owner", visibility: "private" }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Nested source", cwd: privateCwd });
    const unrelated = path.join(root, `${f.issueId}-unrelated-candidate`); await mkdir(unrelated);
    await db.insert(executionWorkspaces).values({ companyId: f.companyId, name: "Unrelated task files", cwd: unrelated,
      mode: "shared_workspace", strategyType: "operator_directory" });
    const wrapper = path.join(root, `${f.issueId}-git-bin`); await mkdir(wrapper);
    const probeLog = path.join(wrapper, "probed.txt");
    await writeFile(probeLog, "");
    const realGit = (await exec("sh", ["-c", "command -v git"])).stdout.trim();
    await writeFile(path.join(wrapper, "git"), `#!/bin/sh
if [ "$1" = "-C" ] && [ "$2" = "$PROBE_UNRELATED" ]; then
  printf 'unexpected Git probe\\n' >> "$PROBE_LOG"
  exit 78
fi
exec "$PROBE_REAL_GIT" "$@"
`, { mode: 0o755 });
    const previous = { PATH: process.env.PATH, PROBE_UNRELATED: process.env.PROBE_UNRELATED,
      PROBE_LOG: process.env.PROBE_LOG, PROBE_REAL_GIT: process.env.PROBE_REAL_GIT };
    try {
      vi.stubEnv("PATH", `${wrapper}${path.delimiter}${process.env.PATH}`);
      vi.stubEnv("PROBE_UNRELATED", await realpath(unrelated));
      vi.stubEnv("PROBE_LOG", probeLog); vi.stubEnv("PROBE_REAL_GIT", realGit);
      const input = { companyId: f.companyId, sourceCwd, actor: f.actor };
      await expect(assertIsolatedWorkspaceSourceReadAccess(db, input)).rejects.toThrow(/source project/);
      await db.insert(projectAccessMembers).values([
        { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
        { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
      ]);
      const captured = await assertIsolatedWorkspaceSourceReadAccess(db, input);
      expect(captured.projectIds).toContain(project.id);
      expect(await readFile(probeLog, "utf8")).toBe("");
    } finally {
      for (const [name, value] of Object.entries(previous)) vi.stubEnv(name, value);
    }
  });

  it.each(["unrelated", "metadata", "checkout", "linked_main", "linked_retained"] as const)("authorizes actual separate Git storage without inferring its parent (%s)", async owner => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const storageParent = path.join(root, `${f.issueId}-storage`);
    const metadata = path.join(storageParent, "metadata"), unrelated = path.join(storageParent, "private-task");
    await mkdir(unrelated, { recursive: true });
    await exec("git", ["init", "--initial-branch=main", "--separate-git-dir", metadata, f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "source.txt"), "Source bytes\n");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    let sourceCwd = f.admission.cwd;
    if (owner === "linked_main" || owner === "linked_retained") {
      sourceCwd = path.join(root, `${f.issueId}-linked-source`);
      await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "source-linked", sourceCwd]);
    }
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Private actual owner", visibility: "private" }).returning();
    const [configuration] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Private source",
      cwd: owner === "metadata" ? metadata : owner === "unrelated" ? unrelated : f.admission.cwd }).returning();
    if (owner === "linked_retained") {
      const taskRoot = path.join(root, `${f.issueId}-different-task-root`);
      await mkdir(taskRoot);
      await db.update(executionWorkspaces).set({ cwd: taskRoot }).where(eq(executionWorkspaces.id, f.workspace.id));
      await projectService(db).removeWorkspace(project.id, configuration.id);
    }
    const input = { companyId: f.companyId, sourceCwd, actor: f.actor, copyKind: "repository" as const };
    if (owner !== "unrelated") {
      await expect(assertIsolatedWorkspaceSourceReadAccess(db, input)).rejects.toThrow(/source project/);
      await db.insert(projectAccessMembers).values([
        { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
        { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
      ]);
    }
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, input);
    expect(captured.roots).toContain(await realpath(metadata));
    expect(captured.roots).toContain(await realpath(f.admission.cwd));
    expect(captured.roots).not.toContain(await realpath(storageParent));
    expect(captured.projectIds.includes(project.id)).toBe(owner !== "unrelated");
  });

  it.each(["deleted_primary", "retained_reader"] as const)("retains separate metadata privacy across %s", async scenario => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const storageParent = path.join(root, `${f.issueId}-deleted-primary-storage`);
    const metadata = path.join(storageParent, "metadata"), linked = path.join(root, `${f.issueId}-surviving-linked`);
    await mkdir(storageParent);
    await exec("git", ["init", "--initial-branch=main", "--separate-git-dir", metadata, f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "private.txt"), "PRIVATE_PRIMARY_BYTES");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "private source"]);
    await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "surviving-linked", linked]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Deleted private primary", visibility: "private" }).returning();
    const [configuration] = await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Private source", cwd: f.admission.cwd }).returning();
    const input = { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor, copyKind: "repository" as const };
    await expect(assertIsolatedWorkspaceSourceReadAccess(db, input)).rejects.toThrow(/source project/);
    expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId))).toEqual([]);
    const peer = scenario === "retained_reader" ? await standardPeer(f) : null;
    if (peer) {
      await db.update(executionWorkspaces).set({ cwd: metadata }).where(eq(executionWorkspaces.id, peer.workspace.id));
      await f.service.prepareForAdmission({ ...peer.admission, cwd: metadata });
    }
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    if (peer) {
      await expect(assertIsolatedWorkspaceSourceReadAccess(db, input)).rejects.toThrow(/source project/);
      const before = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
      expect(before.some(entry => entry.kind === "project_source" && entry.scopeId === project.id)).toBe(false);
      await db.insert(projectAccessMembers).values([
        { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: peer.agentId },
        { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: peer.userId },
      ]);
    }
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, input);
    expect(captured.projectIds).toContain(project.id);
    const metadataRows = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(metadataRows).toContainEqual(expect.objectContaining({ canonicalCwd: await realpath(metadata), kind: "project_source", scopeId: project.id }));
    expect(metadataRows.some(entry => entry.kind === "isolated_copy")).toBe(false);
    if (peer) return;
    const firstCopy = path.join(root, `${f.issueId}-authorized-copy`);
    await retainIsolatedWorkspaceSourceAccess(db, { ...input, captured, targetCwd: firstCopy, issueId: f.issueId });
    await exec("git", ["clone", "--no-hardlinks", f.admission.cwd, firstCopy]);
    await projectService(db).removeWorkspace(project.id, configuration.id);
    await rm(f.admission.cwd, { recursive: true, force: true });
    await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, project.id));
    expect(await readFile(path.join(linked, "private.txt"), "utf8")).toBe("PRIVATE_PRIMARY_BYTES");
    await expect(assertIsolatedWorkspaceSourceReadAccess(db, { ...input, sourceCwd: linked })).rejects.toThrow(/source project/);
  });

  it.each(["ordinary", "linked"] as const)("requires real linked-worktree identity with separate Git metadata (%s)", async kind => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const metadata = path.join(root, `${f.issueId}-metadata`);
    await exec("git", ["init", "--initial-branch=main", "--separate-git-dir", metadata, f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "source.txt"), "Source bytes\n");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected separate checkout", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Source", cwd: f.admission.cwd });
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor });
    const targetCwd = kind === "ordinary" ? f.admission.cwd : path.join(f.admission.cwd, "linked");
    if (kind === "linked") await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "linked", targetCwd]);
    await writeFile(path.join(targetCwd, "source.txt"), "Preserved dirty edit\n");
    const retain = () => retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd,
      targetCwd, actor: f.actor, issueId: f.issueId, captured, phase: "verified" });
    if (kind === "ordinary") await expect(retain()).rejects.toThrow(/not a verified Git worktree|protected/);
    else {
      await expect(retain()).resolves.toBeUndefined();
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { companyId: f.companyId, cwd: targetCwd, actor: f.actor, issueId: f.issueId })).resolves.toBeUndefined();
    }
    const entries = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(entries.some(entry => entry.kind === "isolated_copy")).toBe(kind === "linked");
    expect(await readFile(path.join(targetCwd, "source.txt"), "utf8")).toBe("Preserved dirty edit\n");
  });

  it.each(["upgrade", "interrupted_creation", "unrelated_owner"] as const)("validates a registered dirty worktree without completed copy proof after %s", async scenario => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const git = async (...args: string[]) => (await exec("git", ["-C", f.admission.cwd, ...args])).stdout;
    await exec("git", ["init", "--initial-branch=main", f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "tracked.txt"), "Original source\n");
    await git("add", ".");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source");
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected legacy source", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Source", cwd: f.admission.cwd });
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor });
    const targetCwd = path.join(f.admission.cwd, ".paperclip", "worktrees", "legacy");
    const input = { companyId: f.companyId, sourceCwd: f.admission.cwd, targetCwd, actor: f.actor, issueId: f.issueId, captured };
    if (scenario === "interrupted_creation") await retainIsolatedWorkspaceSourceAccess(db, input);
    if (scenario === "unrelated_owner") {
      const unrelated = path.join(root, `${f.issueId}-unrelated-git`);
      await exec("git", ["init", "--initial-branch=main", unrelated]);
      await exec("git", ["-C", unrelated, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-m", "unrelated"]);
      await exec("git", ["-C", unrelated, "worktree", "add", "-b", "legacy", targetCwd]);
    } else await git("worktree", "add", "-b", "legacy", targetCwd);
    await writeFile(path.join(targetCwd, "tracked.txt"), "Keep dirty edit\n");
    await writeFile(path.join(targetCwd, "untracked.txt"), "Keep untracked work\n");
    const before = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(before.some(entry => entry.kind === "isolated_copy")).toBe(false);
    const gitState = await exec("git", ["-C", targetCwd, "status", "--porcelain"]);
    const head = await exec("git", ["-C", targetCwd, "rev-parse", "HEAD"]);
    if (scenario === "unrelated_owner") {
      await expect(retainIsolatedWorkspaceSourceAccess(db, input)).rejects.toThrow(/protected|assignment grant/);
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { companyId: f.companyId, cwd: targetCwd, actor: f.actor, issueId: f.issueId })).rejects.toThrow(/protected|assignment grant/);
    } else {
      await expect(retainIsolatedWorkspaceSourceAccess(db, input)).resolves.toBeUndefined();
      await expect(assertExecutionWorkspaceRootWriteAccess(db, { companyId: f.companyId, cwd: targetCwd, actor: f.actor, issueId: f.issueId })).resolves.toBeUndefined();
    }
    const after = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(after.some(entry => entry.kind === "isolated_copy" && entry.scopeId === project.id)).toBe(scenario !== "unrelated_owner");
    expect((await exec("git", ["-C", targetCwd, "status", "--porcelain"])).stdout).toBe(gitState.stdout);
    expect((await exec("git", ["-C", targetCwd, "rev-parse", "HEAD"])).stdout).toBe(head.stdout);
    expect(await readFile(path.join(targetCwd, "tracked.txt"), "utf8")).toBe("Keep dirty edit\n");
    expect(await readFile(path.join(targetCwd, "untracked.txt"), "utf8")).toBe("Keep untracked work\n");
  });

  it("does not let an unmaterialized copy intent authorize writes to an existing source folder", async () => {
    const f = await fixture(), exec = promisify(execFileCallback);
    const targetCwd = path.join(f.admission.cwd, "tracked-private-folder");
    await mkdir(targetCwd);
    await writeFile(path.join(targetCwd, "existing.txt"), "Protected original bytes\n");
    await exec("git", ["init", "--initial-branch=main", f.admission.cwd]);
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected original source", visibility: "private",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Original files", cwd: f.admission.cwd });
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    const writeInput = { companyId: f.companyId, cwd: targetCwd, actor: f.actor, issueId: f.issueId };
    await expect(assertExecutionWorkspaceRootWriteAccess(db, writeInput)).rejects.toThrow(/protected|assignment grant/);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor });
    await expect(retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, targetCwd,
      actor: f.actor, issueId: f.issueId, captured })).rejects.toThrow(/protected|assignment grant/);
    await expect(fs.lstat(path.join(targetCwd, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(targetCwd, "existing.txt"), "utf8")).toBe("Protected original bytes\n");
    await expect(assertExecutionWorkspaceRootWriteAccess(db, writeInput)).rejects.toThrow(/protected|assignment grant/);
  });

  it("does not verify a missing or ordinary empty directory as an isolated copy", async () => {
    const f = await fixture(), exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "source.txt"), "Source\n");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor });
    const targetCwd = path.join(root, `${f.issueId}-never-materialized`);
    const input = { companyId: f.companyId, sourceCwd: f.admission.cwd, targetCwd, actor: f.actor, captured, phase: "verified" as const };
    await expect(retainIsolatedWorkspaceSourceAccess(db, input)).rejects.toThrow(/not a verified Git worktree/);
    await mkdir(targetCwd);
    await expect(retainIsolatedWorkspaceSourceAccess(db, input)).rejects.toThrow(/not a verified Git worktree/);
    const entries = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(entries.some(entry => entry.kind === "isolated_copy")).toBe(false);
  });

  it.each(["exact", "descendant"] as const)("requires write authority for a protected %s target before copying", async relation => {
    const f = await fixture(), exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "source.txt"), "Source bytes\n");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const targetCwd = path.join(root, `${f.issueId}-protected-target`);
    const protectedCwd = relation === "exact" ? targetCwd : path.join(targetCwd, "private");
    await mkdir(protectedCwd, { recursive: true });
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Protected target",
      executionWorkspacePolicy: { authorizationPolicy: { assignmentPolicy: { mode: "protected" } } } }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Target owner", cwd: protectedCwd });
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor });
    await expect(retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, targetCwd,
      actor: f.actor, issueId: f.issueId, captured })).rejects.toThrow(/protected|assignment grant/);
    await expect(fs.lstat(path.join(targetCwd, "source.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const owners = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(owners).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "isolated_source", scopeId: f.workspace.id })]));
  });

  it("excludes available lexical descendants whose canonical roots are unrelated", async () => {
    const f = await fixture();
    const unrelated = path.join(root, `${f.issueId}-unrelated`); await mkdir(unrelated);
    const alias = path.join(f.admission.cwd, "link"); await symlink(unrelated, alias);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Unrelated private owner", visibility: "private" }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Unrelated alias", cwd: alias });
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Unrelated alias", cwd: alias,
      mode: "shared_workspace", strategyType: "project_primary" }).returning();
    await db.insert(executionWorkspaceRepositories).values({ companyId: f.companyId, requestedByIssueId: f.issueId, executionWorkspaceId: workspace.id,
      repositoryIdentity: "https://github.com/private/unrelated", repoUrl: "https://github.com/private/unrelated", relativePath: "unused",
      requestedRef: "HEAD", requestKey: randomUUID() });
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
  });

  it.each(["revoked", "deleted_source", "deleted_owner", "retained_reader"] as const)("protects already-copied bytes when post-copy authorization fails (%s)", async failure => {
    const f = await fixture(), exec = promisify(execFileCallback);
    await exec("git", ["init", "--initial-branch=main", f.admission.cwd]);
    await writeFile(path.join(f.admission.cwd, "secret.txt"), "Failed copy still private\n");
    await exec("git", ["-C", f.admission.cwd, "add", "."]);
    await exec("git", ["-C", f.admission.cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Failed private copy", visibility: "private" }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: project.id, name: "Private source", cwd: f.admission.cwd });
    await db.insert(projectAccessMembers).values([
      { companyId: f.companyId, projectId: project.id, subjectType: "agent", subjectId: f.agentId },
      { companyId: f.companyId, projectId: project.id, subjectType: "user", subjectId: f.userId },
    ]);
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, actor: f.actor });
    const targetCwd = path.join(root, `${f.issueId}-failed-copy`);
    if (failure === "retained_reader") {
      await mkdir(targetCwd);
      const peer = await standardPeer(f);
      await db.update(executionWorkspaces).set({ cwd: targetCwd }).where(eq(executionWorkspaces.id, peer.workspace.id));
      await f.service.prepareForAdmission({ ...peer.admission, cwd: targetCwd });
      await expect(retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, targetCwd,
        actor: f.actor, captured })).rejects.toThrow(/source project/);
      await expect(fs.lstat(path.join(targetCwd, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      return;
    }
    await exec("git", ["-C", f.admission.cwd, "worktree", "add", "-b", "failed-copy", targetCwd]);
    if (failure === "revoked") await db.delete(projectAccessMembers).where(eq(projectAccessMembers.projectId, project.id));
    if (failure === "deleted_owner") await db.delete(projects).where(eq(projects.id, project.id));
    if (failure === "deleted_source") await rm(f.admission.cwd, { recursive: true });
    await expect(retainIsolatedWorkspaceSourceAccess(db, { companyId: f.companyId, sourceCwd: f.admission.cwd, targetCwd, actor: f.actor, captured })).rejects.toThrow();
    const canonicalCwd = await realpath(targetCwd);
    const owners = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.rootKey, createHash("sha256").update(canonicalCwd).digest("hex")));
    expect(owners).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "isolated_project_source", scopeId: project.id })]));
    const peer = await standardPeer(f);
    await expect(assertExecutionWorkspaceRootReadAccess(db, { companyId: f.companyId, cwd: targetCwd, actor: peer.actor })).rejects.toThrow(/source project/);
    expect(await readFile(path.join(targetCwd, "secret.txt"), "utf8")).toBe("Failed copy still private\n");
  });


});
