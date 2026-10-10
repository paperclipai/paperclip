import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, eq, or, sql } from "drizzle-orm";
import { activityLog, executionWorkspaceRepositories, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { prepareWorkspaceRepositorySchema, type PrepareWorkspaceRepository, type ProjectRepository } from "@paperclipai/shared";
import { withDirectoryPublicationLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { conflict, forbidden, notFound } from "../errors.js";
import { accessService } from "./access.js";
import { assertTaskWorkspaceAccess } from "./task-workspace-source-access.js";
import { canActorReadExecutionWorkspace, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { captureRunIdentity } from "./run-identity.js";
import { toolAccessService } from "./tool-access.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { buildGitAuthInvocation, createGitRemoteAuthProvider } from "./git-credentials.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "./managed-repository-checkout.js";

const execFile = promisify(execFileCallback);
type RepositoryRow = typeof executionWorkspaceRepositories.$inferSelect;

/** The catalog is refreshed on request and admission; saved IDs are not grants. */
export function resolveTaskRepository(request: PrepareWorkspaceRepository["repository"], available: ProjectRepository[]) {
  const selected = request.kind === "catalog" ? available.find(repo => repo.id === request.id) : null;
  if (request.kind === "catalog" && !selected) throw forbidden("Repository access is no longer available; refresh the repository catalog");
  const source = normalizeProjectRepositoryUrl(selected?.url ?? (request.kind === "url" ? request.url : ""));
  const match = selected ?? available.find(repo => normalizeProjectRepositoryUrl(repo.url).url.toLowerCase() === source.url.toLowerCase());
  return { repoUrl: source.url, repositoryIdentity: source.url.toLowerCase(), catalogRepositoryId: match?.id ?? null };
}

export function taskRepositoryRelativePath(identity: string) {
  return `.paperclip-repositories/task-repo-${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
}

export function assertRepositoryRetryMatches(row: Pick<RepositoryRow, "repositoryIdentity" | "requestedRef">, identity: string, ref: string) {
  if (row.repositoryIdentity !== identity || row.requestedRef !== ref) {
    throw conflict("Repository preparation conflicts with an existing receipt. A different ref requires a separate workspace; existing files are never switched automatically.");
  }
}

/** Workspace aggregate child. It owns acquisition receipts, never task binding or provider sessions. */
export function executionWorkspaceRepositoryService(db: Db) {
  async function catalog(companyId: string, userId: string | null, localTrusted: boolean) {
    return (await toolAccessService(db).listProjectRepositories(companyId, userId, localTrusted)).repositories;
  }
  async function request(input: { companyId: string; issueId: string; actor: AuthorizationActor; request: PrepareWorkspaceRepository }) {
    const parsed = prepareWorkspaceRepositorySchema.parse(input.request);
    const decision = await accessService(db).decide({ actor: input.actor, action: "issue:mutate", resource: { type: "issue", companyId: input.companyId, issueId: input.issueId } });
    if (!decision.allowed) throw forbidden("Task workspace modification is not allowed");
    let userId = input.actor.userId ?? null;
    let localTrusted = input.actor.source === "local_implicit";
    if (input.actor.type === "agent") {
      if (input.actor.source !== "agent_jwt" || !input.actor.agentId || !input.actor.runId || input.actor.companyId !== input.companyId) throw forbidden("Repository preparation requires an authenticated task run");
      const identity = await captureRunIdentity(db, { companyId: input.companyId, agentId: input.actor.agentId, runId: input.actor.runId });
      const runIssueId = identity.run.nativeIssueId ?? identity.run.contextSnapshot?.issueId;
      if (runIssueId !== input.issueId) throw forbidden("Repository preparation is scoped to the current task");
      userId = identity.run.responsibleUserId;
      localTrusted = userId === "local-board";
      if (!userId) throw forbidden("Repository access requires a responsible user");
    }
    const source = resolveTaskRepository(parsed.repository, await catalog(input.companyId, userId, localTrusted));
    const requestedRef = parsed.ref ?? "HEAD";
    const receipt = await db.transaction(async tx => {
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), await issueReadSqlCondition(tx, input.actor))).for("no key update");
      if (!issue) throw notFound("Task not found");
      if (input.actor.type === "agent" && !["standard", "skill_test"].includes(issue.workMode)) throw forbidden("Repository preparation is unavailable in Ask or Plan mode");
      if (!issue.executionWorkspaceId) throw conflict("The task has no admitted workspace yet. Start it once before preparing a repository.");
      if (!(await canActorReadExecutionWorkspace(db, input.actor, issue.executionWorkspaceId))) throw notFound("Execution workspace not found");
      // Serialize receipts across tasks without blocking unchanged-ID foreign-key reads.
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, issue.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId))).for("no key update");
      if (!workspace || workspace.status !== "active") throw conflict("Execution workspace is unavailable");
      await assertTaskWorkspaceAccess(tx, input.actor, input.companyId, workspace.id);
      const existing = await tx.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id), or(eq(executionWorkspaceRepositories.repositoryIdentity, source.repositoryIdentity), sql`${executionWorkspaceRepositories.requestKeys} ? ${parsed.requestKey}`)));
      for (const row of existing) assertRepositoryRetryMatches(row, source.repositoryIdentity, requestedRef);
      if (existing[0]) {
        const row = existing[0];
        if (!row.requestKeys.includes(parsed.requestKey)) {
          const [updated] = await tx.update(executionWorkspaceRepositories).set({ requestKeys: [...row.requestKeys, parsed.requestKey] }).where(eq(executionWorkspaceRepositories.id, row.id)).returning();
          return updated;
        }
        return row;
      }
      const [row] = await tx.insert(executionWorkspaceRepositories).values({ companyId: input.companyId, executionWorkspaceId: workspace.id, requestedByIssueId: input.issueId, ...source, relativePath: taskRepositoryRelativePath(source.repositoryIdentity), requestedRef, requestKey: parsed.requestKey, requestKeys: [parsed.requestKey] }).returning();
      await tx.insert(activityLog).values({ companyId: input.companyId, actorType: input.actor.type === "agent" ? "agent" : "user", actorId: input.actor.agentId ?? input.actor.userId ?? "local-board", action: "workspace.repository.requested", entityType: "execution_workspace", entityId: workspace.id, runId: input.actor.runId ?? null, responsibleUserId: userId, details: { repositoryId: row.id, issueId: input.issueId, applies: "next_normal_admission" } });
      return row;
    });
    // No host-only checkout is represented as ready in an already admitted remote session.
    return { kind: "requires_next_admission" as const, applies: "next_normal_admission" as const, operationId: receipt.id, repository: receipt, reason: "immutable_admitted_workspace" };
  }
  async function list(companyId: string, workspaceId: string) {
    return db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId)));
  }
  /** Logical rows may deliberately name one physical folder. Reuse bytes only
   * after validating every published owner's retained privacy and source intent. */
  async function sharedPublicationPin(input: { row: RepositoryRow; root: string; actor: AuthorizationActor; ownership: { repositoryId?: string; pinnedCommit?: string } | null }) {
    const candidates = await db.select({ repository: executionWorkspaceRepositories, workspace: executionWorkspaces })
      .from(executionWorkspaceRepositories).innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
      .where(and(eq(executionWorkspaceRepositories.companyId, input.row.companyId), eq(executionWorkspaces.companyId, input.row.companyId),
        eq(executionWorkspaceRepositories.repositoryIdentity, input.row.repositoryIdentity), eq(executionWorkspaceRepositories.relativePath, input.row.relativePath)));
    let pin = input.row.pinnedCommit;
    for (const { repository, workspace } of candidates) {
      if (repository.id === input.row.id || !workspace.cwd) continue;
      const candidatePin = repository.pinnedCommit ?? (input.ownership?.repositoryId === repository.id ? input.ownership.pinnedCommit : null);
      // An intent that has not published anything cannot claim another task's checkout.
      if (!candidatePin || !/^[a-f0-9]{40,64}$/.test(candidatePin)) continue;
      if (await fs.realpath(workspace.cwd).catch(() => null) !== input.root) continue;
      assertRepositoryRetryMatches(repository, input.row.repositoryIdentity, input.row.requestedRef);
      if (!(await canActorReadExecutionWorkspace(db, input.actor, workspace.id))) throw forbidden("The shared repository retains files from a workspace outside this actor's access");
      await assertTaskWorkspaceAccess(db, input.actor, input.row.companyId, workspace.id);
      if (pin && pin !== candidatePin) throw conflict("Shared repository publication receipts disagree; repair is required before reuse");
      pin = candidatePin;
    }
    return pin;
  }
  async function prepareForAdmission(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string; responsibleUserId: string | null }) {
    const rows = await list(input.companyId, input.workspaceId);
    if (!rows.length) return [];
    const available = await catalog(input.companyId, input.responsibleUserId, input.responsibleUserId === "local-board");
    const resolveAuth = createGitRemoteAuthProvider(db, input.companyId, { issueId: input.issueId, heartbeatRunId: input.runId, agentId: input.agentId, responsibleUserId: input.responsibleUserId });
    const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId: input.companyId,
      agentId: input.agentId, runId: input.runId,
      // local-board is a server identity, not a membership record. Preserve the
      // agent's own authority rather than promoting it to a board actor.
      onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId };
    await assertTaskWorkspaceAccess(db, actor, input.companyId, input.workspaceId);
    const root = await fs.realpath(input.cwd);
    const repositoryRoot = path.join(root, ".paperclip-repositories");
    await fs.mkdir(repositoryRoot, { recursive: true });
    if ((await fs.lstat(repositoryRoot)).isSymbolicLink() || await fs.realpath(repositoryRoot) !== repositoryRoot) throw conflict("Repository directory escapes the task workspace");
    // Incomplete clones belong to the runtime tree, which is excluded from
    // transfer and recovery. The published namespace contains checkouts only.
    let stagingParent = root;
    for (const name of [".paperclip-runtime", "repository-staging"]) {
      stagingParent = path.join(stagingParent, name);
      await fs.mkdir(stagingParent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const entry = await fs.lstat(stagingParent);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(stagingParent) !== stagingParent) {
        throw conflict("Repository staging directory escapes the task workspace");
      }
    }
    await ensureManagedRepositoriesIgnored(root);
    const prepared: Array<{ id: string; cwd: string; repoUrl: string; relativePath: string; pinnedCommit: string; branchName: string | null }> = [];
    for (const row of rows) {
      const source = resolveTaskRepository(row.catalogRepositoryId ? { kind: "catalog", id: row.catalogRepositoryId } : { kind: "url", url: row.repoUrl }, available);
      if (source.repositoryIdentity !== row.repositoryIdentity || row.relativePath !== taskRepositoryRelativePath(row.repositoryIdentity)) throw conflict("Repository preparation receipt does not match its source");
      const cwd = path.join(root, row.relativePath);
      await withDirectoryPublicationLock(cwd, async () => {
        const existing = await fs.lstat(cwd).catch(() => null);
        if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || await fs.realpath(cwd) !== cwd)) throw conflict("Repository checkout path is not a contained directory");
        if (existing) {
          const gitDir = path.join(cwd, ".git");
          const metadata = await fs.lstat(gitDir).catch(() => null);
          if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(gitDir) !== gitDir) throw conflict("Repository Git metadata escapes the managed checkout");
        }
        // Uncataloged URLs may use anonymous public Git only. Never borrow a user's/company's credential for an arbitrary URL.
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        anonymous.env = { ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
        await db.update(executionWorkspaceRepositories).set({ state: "preparing", catalogRepositoryId: source.catalogRepositoryId, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
        try {
          const ownershipPath = path.join(cwd, ".git", "paperclip-workspace-owner.json");
          const readOwnership = async () => {
            const handle = await fs.open(ownershipPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
            if (!handle) return null;
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > 4096) return null;
              const bytes = Buffer.alloc(4097);
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
              return bytesRead <= 4096 ? JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) : null;
            } catch { return null; } finally { await handle.close(); }
          };
          const initialOwnership = await readOwnership();
          const authorizedPin = await sharedPublicationPin({ row, root, actor, ownership: initialOwnership });
          if (existing && !authorizedPin && initialOwnership?.repositoryId !== row.id) {
            throw conflict("Repository directory has no matching preparation receipt; repair it before retrying");
          }
          const result = await materializeManagedProjectWorkspace(cwd, {
            repoUrl: row.repoUrl,
            stagingParent,
            repoRef: authorizedPin ?? (row.requestedRef === "HEAD" ? null : row.requestedRef),
            resolveGitAuth: source.catalogRepositoryId ? resolveAuth : async () => anonymous,
            beforePublish: async cloneCwd => {
              const pinnedCommit = (await execFile("git", ["-C", cloneCwd, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
              await fs.writeFile(path.join(cloneCwd, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ version: 1, repositoryId: row.id, pinnedCommit }), { flag: "wx", mode: 0o600 });
            },
          });
          if (result.warning) throw conflict(result.warning);
          const git = async (...args: string[]) => (await execFile("git", ["-C", cwd, ...args], { timeout: 30_000 })).stdout.trim();
          const origin = normalizeProjectRepositoryUrl(await git("remote", "get-url", "origin"));
          if (origin.url.toLowerCase() !== row.repositoryIdentity) throw conflict("Repository checkout belongs to a different origin");
          const ownership = await readOwnership();
          if (!authorizedPin && (ownership?.repositoryId !== row.id || !/^[a-f0-9]{40,64}$/.test(ownership.pinnedCommit))) throw conflict("Repository publication has no valid preparation receipt");
          // The pre-publication commit survives a crash before the database update.
          const pinnedCommit: string = authorizedPin ?? ownership.pinnedCommit;
          const branchName = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => null);
          await db.update(executionWorkspaceRepositories).set({ state: "ready", pinnedCommit, branchName, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
          prepared.push({ id: row.id, cwd, repoUrl: row.repoUrl, relativePath: row.relativePath, pinnedCommit, branchName });
        } catch (error) {
          await db.update(executionWorkspaceRepositories).set({ state: "needs_repair", failureCode: "repository_preparation_failed", updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
          throw error;
        }
      });
    }
    return prepared;
  }
  return { request, list, prepareForAdmission };
}
