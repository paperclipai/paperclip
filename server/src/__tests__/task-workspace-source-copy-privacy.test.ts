import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, executionWorkspaceRepositoryRoots, executionWorkspaceRepositoryAccess, executionWorkspaces,
  heartbeatRuns, issues, projects, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { assertTaskWorkspaceExecutionAccess, assertExecutionWorkspaceRecordAccess } from "../services/task-workspace-access.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { authorizationService } from "../services/authorization.js";
import { getEmbeddedPostgresTestSupport } from "./helpers/embedded-postgres.js";
import { createRepositoryTrustFixture } from "./helpers/repository-trust-fixture.js";

const acquisition = vi.hoisted(() => ({ managedAuth: vi.fn(), materialize: vi.fn(), catalog: vi.fn() }));
vi.mock("../services/tool-access.js", () => ({ toolAccessService: () => ({ listProjectRepositories: acquisition.catalog }) }));
vi.mock("../services/git-credentials.js", async original => ({
  ...await original<typeof import("../services/git-credentials.js")>(),
  createGitRemoteAuthProvider: () => acquisition.managedAuth,
}));
vi.mock("../services/managed-repository-checkout.js", async original => ({
  ...await original<typeof import("../services/managed-repository-checkout.js")>(),
  materializeManagedProjectWorkspace: acquisition.materialize,
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("task workspace filesystem history independence", () => {
  const context = createRepositoryTrustFixture(acquisition);
  let db: ReturnType<typeof createDb>;
  let root: string;
  const exec = promisify(execFileCallback);
  beforeAll(async () => { ({ db, root } = await context.setup()); }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
  afterAll(context.cleanup);
  const { fixture, standardPeer, privateTask } = context;

  it.each(["same_root", "ancestor", "descendant", "symlink"] as const)("admits a current task despite private historical files at %s", async relation => {
    const f = await fixture();
    const peer = await standardPeer(f);
    await privateTask(f);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: peer.issueId,
      responsibleUserId: peer.userId }).where(eq(issues.id, peer.issueId));
    let historicalCwd = f.admission.cwd;
    if (relation === "ancestor") historicalCwd = root;
    if (relation === "descendant") {
      historicalCwd = path.join(f.admission.cwd, "private-child");
      await mkdir(historicalCwd);
    }
    if (relation === "symlink") {
      historicalCwd = path.join(root, `${peer.issueId}-alias`);
      await symlink(f.admission.cwd, historicalCwd);
    }
    await db.update(executionWorkspaces).set({ cwd: historicalCwd, sourceIssueId: peer.issueId }).where(eq(executionWorkspaces.id, peer.workspace.id));
    await writeFile(path.join(f.admission.cwd, "shared.txt"), "Bytes accessible to this OS identity\n");
    const decision = await authorizationService(db).decide({ actor: f.actor, action: "issue:read",
      resource: { type: "issue", companyId: f.companyId, issueId: peer.issueId } });
    expect(decision.allowed).toBe(false);
    await expect(assertExecutionWorkspaceRecordAccess(db, f.actor, f.companyId, peer.workspace.id)).rejects.toThrow();
    await expect(assertTaskWorkspaceExecutionAccess(db, f.actor, f.companyId, {
      issueId: f.issueId, workspaceId: f.workspace.id,
    })).resolves.toMatchObject({ task: { id: f.issueId } });
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(f.service.assertPublicationAllowed(f.admission)).resolves.toBeUndefined();
    expect(await readFile(path.join(f.admission.cwd, "shared.txt"), "utf8")).toContain("OS identity");
    expect(await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId))).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
    expect(acquisition.managedAuth).not.toHaveBeenCalled();
  });

  it.each(["anonymous_only", "managed"] as const)("ignores legacy %s reservations and deleted historical readers", async mode => {
    const f = await fixture();
    const rootKey = createHash("sha256").update(f.admission.cwd).digest("hex");
    await db.insert(executionWorkspaceRepositoryRoots).values({ companyId: f.companyId, rootKey, canonicalCwd: f.admission.cwd, mode });
    await db.insert(executionWorkspaceRepositoryAccess).values([
      { companyId: f.companyId, rootKey, canonicalCwd: f.admission.cwd, kind: "source", scopeId: randomUUID() },
      { companyId: f.companyId, rootKey, canonicalCwd: f.admission.cwd, kind: "reader", scopeId: randomUUID(), agentId: randomUUID(), responsibleUserId: randomUUID() },
    ]);
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(f.service.assertPublicationAllowed(f.admission)).resolves.toBeUndefined();
    const rows = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, f.companyId));
    expect(rows).toHaveLength(2);
  });

  it("does not infer trust or source-project access from another configuration at the same path", async () => {
    const f = await fixture();
    const [privateProject] = await db.insert(projects).values({ companyId: f.companyId,
      name: "Private unrelated project", visibility: "private", executionWorkspacePolicy: f.policy }).returning();
    await db.insert(projectWorkspaces).values({ companyId: f.companyId, projectId: privateProject.id,
      name: "Unrelated physical alias", cwd: f.admission.cwd });
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
    await expect(f.service.assertPublicationAllowed(f.admission)).resolves.toBeUndefined();
  });

  it("uses stored current-task selection without disclosing private full workspace metadata", async () => {
    const f = await fixture();
    const peer = await standardPeer(f);
    await db.update(issues).set({ visibility: "private", privacyRootIssueId: peer.issueId,
      responsibleUserId: peer.userId }).where(eq(issues.id, peer.issueId));
    await db.update(executionWorkspaces).set({ sourceIssueId: peer.issueId }).where(eq(executionWorkspaces.id, f.workspace.id));
    await db.update(executionWorkspaces).set({ sourceIssueId: null }).where(eq(executionWorkspaces.id, f.workspace.id));
    const selection = { kind: "existing" as const, workspaceId: f.workspace.id };
    await db.update(issues).set({ workspaceSelection: { version: 1, source: "explicit", selection } }).where(eq(issues.id, f.issueId));
    await expect(executionWorkspaceService(db).validateSelection({ companyId: f.companyId,
      actor: f.actor, issueId: f.issueId, selection })).rejects.toThrow();
    await expect(executionWorkspaceService(db).validateStoredSelectionForRun({ companyId: f.companyId,
      actor: f.actor, issueId: f.issueId, selection })).resolves.toMatchObject({ executionWorkspaceId: f.workspace.id });
    await expect(f.service.prepareForAdmission(f.admission)).resolves.toEqual([]);
  });

  it("checks concrete local copy identity again before publication", async () => {
    const f = await fixture();
    const sourceCwd = path.join(root, `${f.issueId}-source`);
    await mkdir(sourceCwd);
    await exec("git", ["init", "--initial-branch=main", sourceCwd]);
    await writeFile(path.join(sourceCwd, "source.txt"), "source bytes\n");
    await exec("git", ["-C", sourceCwd, "add", "."]);
    await exec("git", ["-C", sourceCwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "source"]);
    const beforePublish = await f.service.prepareConfiguredRepositoryCopy({ ...f.admission, sourceCwd });
    await expect(beforePublish()).resolves.toBeUndefined();
    await rename(sourceCwd, `${sourceCwd}-moved`);
    await expect(beforePublish()).rejects.toThrow();
  });

  it("rejects a stale current task binding and an invalid current run", async () => {
    const f = await fixture();
    const peer = await standardPeer(f);
    await expect(f.service.prepareForAdmission({ ...f.admission, runId: peer.runId })).rejects.toThrow();
    await db.update(issues).set({ executionWorkspaceId: peer.workspace.id }).where(eq(issues.id, f.issueId));
    await expect(f.service.assertPublicationAllowed(f.admission)).rejects.toThrow();
  });

  it("still rejects cross-company execution bindings", async () => {
    const f = await fixture();
    const other = await fixture();
    await expect(f.service.prepareForAdmission({ ...f.admission, workspaceId: other.workspace.id })).rejects.toThrow();
  });

  it.each(["url", "catalog"] as const)("rejects unsupported independent local-file acquisition through %s", async kind => {
    const f = await fixture();
    const url = `file://${f.admission.cwd}`;
    if (kind === "catalog") acquisition.catalog.mockResolvedValue({ repositories: [{ id: "private-repo", fullName: "private/local", url, connections: ["fixture"] }] });
    await expect(f.request(kind === "url" ? { kind, url } : { kind, id: "private-repo" })).rejects.toThrow(/HTTPS GitHub/);
    expect(await f.service.list(f.companyId, f.workspace.id)).toEqual([]);
    expect(acquisition.materialize).not.toHaveBeenCalled();
  });
});
