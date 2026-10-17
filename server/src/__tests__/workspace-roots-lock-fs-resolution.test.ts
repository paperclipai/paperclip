import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { authUsers, companies, companyMemberships, createDb, executionWorkspaceRepositoryAccess,
  executionWorkspaces, projects, projectAccessMembers, projectWorkspaces, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import * as executionWorkspaceRepositories from "../services/execution-workspace-repositories.js";
import { repositoryRootsOverlap } from "../services/execution-workspace-source-roots.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const { lockExecutionWorkspaceRootProvenance, preserveExecutionWorkspaceRootProvenance, assertIsolatedWorkspaceSourceReadAccess, retainIsolatedWorkspaceSourceAccess } = executionWorkspaceRepositories;
const stageRepositoryRootResolutions = (executionWorkspaceRepositories as {
  stageRepositoryRootResolutions?: (db: ReturnType<typeof createDb>, companyId: string) => Promise<unknown>;
}).stageRepositoryRootResolutions?.bind(executionWorkspaceRepositories);

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("workspace roots lock filesystem resolution (issue #16381)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-roots-lock-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "paperclip-roots-lock-"));
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function seedCompanyWorkspaceRow(companyId: string, name: string, cwd: string, options?: { projectId?: string; strategyType?: string }) {
    const [row] = await db.insert(executionWorkspaces).values({ companyId, name,
      mode: "shared_workspace", strategyType: options?.strategyType ?? "task_directory", cwd,
      ...(options?.projectId ? { projectId: options.projectId } : {}) }).returning();
    return row;
  }

  async function seedPeerWorkspaces(companyId: string, count: number, prefix: string) {
    const peerDir = path.join(root, prefix);
    await mkdir(peerDir, { recursive: true });
    const rows = Array.from({ length: count }, (_unused, index) => ({ companyId, name: `${prefix}-${index}`,
      mode: "shared_workspace", strategyType: "task_directory", cwd: path.join(peerDir, String(index)) }));
    await Promise.all(rows.map(row => mkdir(row.cwd!, { recursive: true })));
    await db.insert(executionWorkspaces).values(rows);
  }

  async function countRealpathsUnderRootsLock(companyId: string, workspaceId: string, cwd: string) {
    const realpathSpy = vi.spyOn(fs, "realpath");
    const staged = await stageRepositoryRootResolutions?.(db, companyId);
    let underLock = 0;
    await db.transaction(async tx => {
      await lockExecutionWorkspaceRootProvenance(tx, companyId);
      realpathSpy.mockClear();
      try {
        await preserveExecutionWorkspaceRootProvenance(tx, { companyId, workspaceId, cwd },
          staged as Parameters<typeof preserveExecutionWorkspaceRootProvenance>[2]);
      } finally {
        underLock = realpathSpy.mock.calls.length;
        realpathSpy.mockRestore();
      }
    });
    return underLock;
  }

  it("does not re-resolve every workspace cwd while holding the company roots lock", async () => {
    const small = randomUUID(), large = randomUUID();
    await db.insert(companies).values([{ id: small, name: "Roots lock small", issuePrefix: `S${small.slice(0, 6)}` },
      { id: large, name: "Roots lock large", issuePrefix: `L${large.slice(0, 6)}` }]);
    const smallTarget = await seedCompanyWorkspaceRow(small, "target", path.join(root, small, "target"));
    const largeTarget = await seedCompanyWorkspaceRow(large, "target", path.join(root, large, "target"));
    await mkdir(path.join(root, small, "target"), { recursive: true });
    await mkdir(path.join(root, large, "target"), { recursive: true });
    await seedPeerWorkspaces(small, 200, `peers-${small}`);
    await seedPeerWorkspaces(large, 400, `peers-${large}`);
    const smallUnderLock = await countRealpathsUnderRootsLock(small, smallTarget.id, smallTarget.cwd!);
    const largeUnderLock = await countRealpathsUnderRootsLock(large, largeTarget.id, largeTarget.cwd!);
    expect(smallUnderLock).toBeLessThanOrEqual(8);
    expect(largeUnderLock - smallUnderLock).toBeLessThanOrEqual(8);
  }, 120_000);

  it("still retains overlapping peer workspaces discovered through staged resolutions", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Roots lock discovery", issuePrefix: `D${companyId.slice(0, 6)}` });
    const targetDir = path.join(root, companyId, "target");
    await mkdir(targetDir, { recursive: true });
    const target = await seedCompanyWorkspaceRow(companyId, "target", targetDir);
    const peer = await seedCompanyWorkspaceRow(companyId, "peer", path.join(targetDir, "inner"));
    await mkdir(path.join(targetDir, "inner"), { recursive: true });
    await countRealpathsUnderRootsLock(companyId, target.id, targetDir);
    const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, companyId));
    const discoveries = retained.filter(entry => entry.kind === "source");
    expect(discoveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: target.id, canonicalCwd: await realpath(targetDir) }),
      expect.objectContaining({ scopeId: peer.id, canonicalCwd: await realpath(targetDir) }),
    ]));
  }, 60_000);

  it("isolated source read access completes against a git checkout with many peer workspaces", async () => {
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Roots lock isolated", issuePrefix: `I${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Reader", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "member", status: "active" });
    const [project] = await db.insert(projects).values({ companyId, name: "Isolated source", visibility: "private" }).returning();
    await db.insert(projectAccessMembers).values({ companyId, projectId: project.id, subjectType: "user", subjectId: userId });
    const checkout = path.join(root, companyId, "checkout");
    await mkdir(checkout, { recursive: true });
    const git = async (...args: string[]) => new Promise<void>((resolve, reject) => {
      import("node:child_process").then(({ execFile }) => execFile("git", ["-C", checkout, ...args], error => error ? reject(error) : resolve()));
    });
    await git("init", "-q");
    await git("-c", "user.email=root-lock@example.test", "-c", "user.name=Roots Lock", "commit", "--allow-empty", "-q", "-m", "seed");
    const checkoutWorkspace = await seedCompanyWorkspaceRow(companyId, "checkout", checkout, { projectId: project.id });
    const innerWorkspace = await seedCompanyWorkspaceRow(companyId, "inner", path.join(checkout, "inner"), { projectId: project.id });
    await mkdir(path.join(checkout, "inner"), { recursive: true });
    await seedPeerWorkspaces(companyId, 200, `peers-${companyId}`);
    const actor = { type: "board" as const, source: "session" as const, userId, ignoreInstanceAdmin: true };
    const captured = await assertIsolatedWorkspaceSourceReadAccess(db, { companyId, sourceCwd: checkout, actor });
    expect(captured.workspaceIds.sort()).toEqual([checkoutWorkspace.id, innerWorkspace.id].sort());
    expect(captured.projectIds).toEqual([project.id]);
  }, 120_000);

  it("re-resolves configured workspaces whose cwd changed between staging and the roots lock", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Roots lock staleness", issuePrefix: `S${companyId.slice(0, 6)}` });
    const [project] = await db.insert(projects).values({ companyId, name: "Stale configured", visibility: "private" }).returning();
    const targetDir = path.join(root, companyId, "target");
    const unrelatedDir = path.join(root, companyId, "unrelated");
    const movedDir = path.join(targetDir, "moved");
    await mkdir(movedDir, { recursive: true });
    await mkdir(unrelatedDir, { recursive: true });
    const target = await seedCompanyWorkspaceRow(companyId, "target", targetDir);
    const [configured] = await db.insert(projectWorkspaces).values({ companyId, projectId: project.id, name: "configured", cwd: unrelatedDir }).returning();
    const staged = await stageRepositoryRootResolutions?.(db, companyId);
    // The configured row moves into the requested source directory after staging
    // but before the roots lock is acquired: the staged root must be discarded.
    await db.update(projectWorkspaces).set({ cwd: movedDir }).where(eq(projectWorkspaces.id, configured.id));
    await db.transaction(async tx => {
      await lockExecutionWorkspaceRootProvenance(tx, companyId);
      await preserveExecutionWorkspaceRootProvenance(tx, { companyId, workspaceId: target.id, cwd: targetDir },
        staged as Parameters<typeof preserveExecutionWorkspaceRootProvenance>[2]);
    });
    const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, companyId));
    const projectSources = retained.filter(entry => entry.kind === "project_source" && entry.scopeId === project.id);
    expect(projectSources).toHaveLength(1);
    expect(repositoryRootsOverlap(projectSources[0]!.canonicalCwd, await realpath(targetDir))).toBe(true);
  }, 60_000);

  it("still retains captured ownership when staged resolution fails on a broken directory", async () => {
    const companyId = randomUUID(), userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Roots lock fault", issuePrefix: `F${companyId.slice(0, 6)}` });
    await db.insert(authUsers).values({ id: userId, name: "Reader", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const targetDir = path.join(root, companyId, "target");
    await mkdir(path.join(targetDir, "inner"), { recursive: true });
    const target = await seedCompanyWorkspaceRow(companyId, "target", targetDir);
    const peer = await seedCompanyWorkspaceRow(companyId, "peer", path.join(targetDir, "inner"));
    const poisonDir = path.join(root, companyId, "poison");
    await mkdir(poisonDir, { recursive: true });
    const [project] = await db.insert(projects).values({ companyId, name: "Fault configured", visibility: "private" }).returning();
    await db.insert(projectWorkspaces).values({ companyId, projectId: project.id, name: "poison", cwd: poisonDir });
    const targetRoot = await realpath(targetDir);
    const realpathOriginal = fs.realpath;
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (p: Parameters<typeof realpathOriginal>[0]) => {
      if (p === poisonDir) throw Object.assign(new Error("i/o error"), { code: "EIO" });
      return realpathOriginal(p);
    });
    try {
      const actor = { type: "board" as const, source: "session" as const, userId, ignoreInstanceAdmin: true };
      const captured = { companyId, roots: [targetRoot], workspaceIds: [target.id, peer.id], projectIds: [] as string[] };
      await expect(retainIsolatedWorkspaceSourceAccess(db, {
        companyId, sourceCwd: targetDir, targetCwd: path.join(root, companyId, "copy-target"), actor, captured, phase: "preparing", copyKind: "repository",
      })).rejects.toThrow();
      const retained = await db.select().from(executionWorkspaceRepositoryAccess).where(eq(executionWorkspaceRepositoryAccess.companyId, companyId));
      const isolatedSources = retained.filter(entry => entry.kind === "isolated_source").map(entry => entry.scopeId).sort();
      expect(isolatedSources).toEqual([target.id, peer.id].sort());
    } finally {
      realpathSpy.mockRestore();
    }
  }, 60_000);
});
