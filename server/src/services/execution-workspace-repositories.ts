import { measureRunTransaction } from "./execution-transaction-timing.js";
import { beginRunPhase, measureRunPhase } from "./execution-preparation-timing.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, eq, or, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, projects, projectWorkspaces, executionWorkspaceRepositories, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { prepareWorkspaceRepositorySchema, type PrepareWorkspaceRepository, type ProjectRepository } from "@paperclipai/shared";
import { withDirectoryPublicationLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { conflict, forbidden, notFound } from "../errors.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { assertTaskWorkspaceExecutionAccess, assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-access.js";
import { authorizationService, issueReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { taskWorkspaceSelectableCondition } from "./task-workspace-selection.js";
import { captureRunIdentity } from "./run-identity.js";
import { toolAccessService } from "./tool-access.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { buildGitAuthInvocation, createGitRemoteAuthProvider } from "./git-credentials.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "./managed-repository-checkout.js";
import { requiresAnonymousRepositoryAcquisition, taskRepositoryRunColumns } from "./task-repository-acquisition.js";

import { canonicalRepositoryRoot } from "./execution-workspace-source-roots.js";
export { canonicalRepositoryRoot } from "./execution-workspace-source-roots.js";

const execFile = promisify(execFileCallback);
type RepositoryRow = typeof executionWorkspaceRepositories.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const controllerAcquisitionMessage = "New controller repository acquisition requires a trusted task. Existing verified public checkouts remain available.";
const lowTrustRepositoryMessage = "Low-trust repository reuse permits anonymous public URLs only; new acquisition is unavailable. Use an authorized configured source for private repositories.";

function withRepositoryPublication<T>(cwd: string, work: () => Promise<T>): Promise<T> {
  return measureRunPhase("workspace.repository.publication", async () => {
    const finishWait = beginRunPhase("workspace.repository.lock_wait");
    let finishRelease: ((failed?: boolean) => void) | undefined;
    let bodyFailed = false;
    let bodyError: unknown;
    let failed = false;
    let releaseFailed = false;
    try {
      return await withDirectoryPublicationLock(cwd, async () => {
        finishWait();
        try {
          return await measureRunPhase("workspace.repository.critical_section", work);
        } catch (error) {
          bodyFailed = true;
          bodyError = error;
          throw error;
        } finally {
          // The adapter releases the lock after this callback settles. Keep that
          // interval separate from the callback rather than calling it held time.
          finishRelease = beginRunPhase("workspace.repository.lock_release");
        }
      });
    } catch (error) {
      failed = true;
      releaseFailed = !bodyFailed || error !== bodyError;
      throw error;
    } finally {
      finishWait(failed);
      finishRelease?.(releaseFailed);
    }
  });
}

function resolveAcquisitionSource(request: PrepareWorkspaceRepository["repository"], available: ProjectRepository[], anonymousOnly: boolean) {
  if (anonymousOnly && request.kind === "catalog") throw forbidden(lowTrustRepositoryMessage);
  return resolveTaskRepository(request, anonymousOnly ? [] : available);
}

function assertAcquisitionReceipt(row: Pick<RepositoryRow, "catalogRepositoryId">, anonymousOnly: boolean) {
  if (anonymousOnly && row.catalogRepositoryId) throw forbidden(lowTrustRepositoryMessage);
}

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

export function executionWorkspaceRepositoryService(db: Db) {
  async function catalog(companyId: string, userId: string | null, localTrusted: boolean) {
    return measureRunPhase("workspace.repository.catalog", async () =>
      (await toolAccessService(db).listProjectRepositories(companyId, userId, localTrusted)).repositories);
  }
  async function requiresAnonymousAcquisition(reader: Db | DbTransaction, input: {
    issue: typeof issues.$inferSelect; workspace: Pick<typeof executionWorkspaces.$inferSelect, "projectId"> | null;
    agentId?: string | null; runId?: string | null;
  }) {
    return measureRunPhase("workspace.repository.current_policy", async () => {
      const { issue, workspace } = input;
      const agentId = input.agentId ?? issue.assigneeAgentId;
      const [agent] = agentId ? await measureRunPhase("workspace.repository.db.agent", () => reader.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, issue.companyId)))) : [];
      if (agentId && !agent) throw forbidden("Task repository agent is unavailable");
      const [project] = issue.projectId ? await measureRunPhase("workspace.repository.db.project", () => reader.select().from(projects).where(and(eq(projects.id, issue.projectId!), eq(projects.companyId, issue.companyId)))) : [];
      const [workspaceSourceProject] = workspace?.projectId ? await measureRunPhase("workspace.repository.db.project", () => reader.select().from(projects).where(and(eq(projects.id, workspace.projectId!), eq(projects.companyId, issue.companyId)))) : [];
      const runId = input.runId ?? issue.executionRunId;
      const [run] = runId ? await measureRunPhase("workspace.repository.db.run", () => reader.select(taskRepositoryRunColumns).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, issue.companyId)))) : [];
      return requiresAnonymousRepositoryAcquisition({ companyId: issue.companyId, issue, agent, project,
        workspaceSourceProject, run, agentId, runId, explicitRunId: input.runId });
    });
  }
  async function assertCurrentControllerAcquisition(input: { companyId: string; issueId: string; workspaceId: string; agentId: string; runId: string }) {
    return measureRunPhase("workspace.repository.acquisition", async () => {
      const [issue] = await measureRunPhase("workspace.repository.db.issue", () => db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))));
      const [workspace] = await measureRunPhase("workspace.repository.db.workspace", () => db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId))));
      if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id) throw forbidden("Task repository workspace binding is unavailable");
      if (await requiresAnonymousAcquisition(db, { issue, workspace, agentId: input.agentId, runId: input.runId })) throw forbidden(controllerAcquisitionMessage);
    });
  }
  async function request(input: { companyId: string; issueId: string; actor: AuthorizationActor; request: PrepareWorkspaceRepository }) {
    const parsed = prepareWorkspaceRepositorySchema.parse(input.request);
    const [requestedIssue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), await issueReadSqlCondition(db, input.actor)));
    if (!requestedIssue) throw notFound("Task not found");
    const issueResource = (issue: typeof issues.$inferSelect) => ({ type: "issue" as const, companyId: issue.companyId, issueId: issue.id,
      status: issue.status, assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId });
    const decision = await authorizationService(db).decide({ actor: input.actor, action: "issue:mutate", resource: issueResource(requestedIssue) });
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
    const available = await catalog(input.companyId, userId, localTrusted);
    const requestedRef = parsed.ref ?? "HEAD";
    const receipt = await measureRunTransaction(db, "workspace", async tx => {
      const [issue] = await measureRunPhase("workspace.sources.inventory", async () => tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), await issueReadSqlCondition(tx, input.actor))).for("no key update"));
      if (!issue) throw notFound("Task not found");
      const currentDecision = await authorizationService(tx).decide({ actor: input.actor, action: "issue:mutate", resource: issueResource(issue) });
      if (!currentDecision.allowed) throw forbidden("Task workspace modification is not allowed");
      if (input.actor.type === "agent" && !["standard", "skill_test"].includes(issue.workMode)) throw forbidden("Repository preparation is unavailable in Ask or Plan mode");
      if (!issue.executionWorkspaceId) throw conflict("The task has no admitted workspace yet. Start it once before preparing a repository.");
      const [workspace] = await measureRunPhase("workspace.sources.inventory", async () => tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, issue.executionWorkspaceId!), eq(executionWorkspaces.companyId, input.companyId), taskWorkspaceSelectableCondition())).for("no key update"));
      if (!workspace) throw conflict("Execution workspace is unavailable");
      await assertTaskWorkspaceExecutionAccess(tx, input.actor, input.companyId, { issueId: input.issueId, workspaceId: workspace.id });
      const anonymousOnly = await requiresAnonymousAcquisition(tx, { issue, workspace,
        agentId: input.actor.agentId, runId: input.actor.runId });
      const source = resolveAcquisitionSource(parsed.repository, available, anonymousOnly);
      if (!workspace.cwd) throw conflict("The task workspace has no directory for repository preparation");
      if (anonymousOnly) throw forbidden(controllerAcquisitionMessage);
      const existing = await measureRunPhase("workspace.sources.inventory", async () => tx.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, input.companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id), or(eq(executionWorkspaceRepositories.repositoryIdentity, source.repositoryIdentity), sql`${executionWorkspaceRepositories.requestKeys} ? ${parsed.requestKey}`))));
      for (const row of existing) {
        assertAcquisitionReceipt(row, anonymousOnly);
        assertRepositoryRetryMatches(row, source.repositoryIdentity, requestedRef);
      }
      if (existing[0]) {
        const row = existing[0];
        if (!row.requestKeys.includes(parsed.requestKey)) {
          const [updated] = await tx.update(executionWorkspaceRepositories).set({ requestKeys: [...row.requestKeys, parsed.requestKey] }).where(eq(executionWorkspaceRepositories.id, row.id)).returning();
          return updated;
        }
        return row;
      }
      const [row] = await measureRunPhase("workspace.write", () => tx.insert(executionWorkspaceRepositories).values({ companyId: input.companyId, executionWorkspaceId: workspace.id, requestedByIssueId: input.issueId, ...source, relativePath: taskRepositoryRelativePath(source.repositoryIdentity), requestedRef, requestKey: parsed.requestKey, requestKeys: [parsed.requestKey] }).returning());
      await measureRunPhase("workspace.write", () => tx.insert(activityLog).values({ companyId: input.companyId, actorType: input.actor.type === "agent" ? "agent" : "user", actorId: input.actor.agentId ?? input.actor.userId ?? "local-board", action: "workspace.repository.requested", entityType: "execution_workspace", entityId: workspace.id, runId: input.actor.runId ?? null, responsibleUserId: userId, details: { repositoryId: row.id, issueId: input.issueId, applies: "next_normal_admission" } }));
      return row;
    });
    return { kind: "requires_next_admission" as const, applies: "next_normal_admission" as const, operationId: receipt.id, repository: receipt, reason: "immutable_admitted_workspace" };
  }
  async function list(companyId: string, workspaceId: string) {
    return measureRunPhase("workspace.repository.receipts", () => db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId))));
  }
  type PublicationInput = { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string; responsibleUserId?: string | null };
  async function currentRunActor(reader: Db | DbTransaction, input: PublicationInput): Promise<AuthorizationActor> {
    const [run] = await measureRunPhase("workspace.repository.db.run", () => reader.select(taskRepositoryRunColumns).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))));
    if (!run || run.agentId !== input.agentId) throw forbidden("Task repository run identity is unavailable");
    if ("responsibleUserId" in input && run.responsibleUserId !== input.responsibleUserId) {
      throw forbidden("Task repository responsible user identity is unavailable");
    }
    return { type: "agent", source: "agent_jwt", companyId: input.companyId, agentId: input.agentId,
      runId: input.runId, onBehalfOfUserId: run.responsibleUserId === "local-board" ? null : run.responsibleUserId };
  }
  async function publicationBinding(reader: Db | DbTransaction, input: PublicationInput, verifyDirectory = true) {
    return measureRunPhase("workspace.repository.binding", async () => {
      const [issue] = await measureRunPhase("workspace.repository.db.issue", () => reader.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))));
      const [workspace] = await measureRunPhase("workspace.repository.db.workspace", () => reader.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId))));
      if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id || !workspace.cwd
        || (verifyDirectory && await measureRunPhase("workspace.repository.paths", async () =>
          await canonicalRepositoryRoot(workspace.cwd!) !== await canonicalRepositoryRoot(input.cwd)))) {
        throw forbidden("Task repository publication binding is unavailable");
      }
      const acquisitionRestricted = await requiresAnonymousAcquisition(reader, { issue, workspace, agentId: input.agentId, runId: input.runId });
      const actor = await currentRunActor(reader, input);
      await assertTaskWorkspaceExecutionAccess(reader, actor, input.companyId, { issueId: issue.id, workspaceId: workspace.id });
      return { issue, workspace, actor, acquisitionRestricted };
    });
  }
  async function assertPublicationAllowed(input: PublicationInput) {
    await publicationBinding(db, input);
  }
  async function prepareConfiguredRepositoryCopy(input: PublicationInput & { sourceCwd: string; projectWorkspaceId?: string | null }): Promise<() => Promise<void>> {
    const sourceRoot = await fs.realpath(input.sourceCwd);
    const destinationRoot = await canonicalRepositoryRoot(input.cwd);
    const [selectedIssue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    if (!selectedIssue) throw forbidden("Task repository copy identity is unavailable");
    const [selectedWorkspace] = await db.select({ projectId: executionWorkspaces.projectId,
      projectWorkspaceId: executionWorkspaces.projectWorkspaceId }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    const selectionSource = selectedIssue.workspaceSelection?.selection;
    const anchorSourceId = selectedWorkspace?.projectWorkspaceId ?? selectedIssue.projectWorkspaceId
      ?? (selectionSource?.kind === "configured_source" ? selectionSource.projectWorkspaceId : null);
    const selectedSourceId = input.projectWorkspaceId ?? anchorSourceId;
    const [selectedSource] = selectedSourceId ? await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, selectedSourceId), eq(projectWorkspaces.companyId, input.companyId))) : [];
    if (selectedSourceId && !selectedSource) throw forbidden("Task repository copy source is unavailable");
    const verify = async () => {
      if (await fs.realpath(input.sourceCwd) !== sourceRoot || await canonicalRepositoryRoot(input.cwd) !== destinationRoot) {
        throw conflict("Repository copy source or destination changed during preparation");
      }
      const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
      if (!issue || issue.projectWorkspaceId !== selectedIssue.projectWorkspaceId || issue.projectId !== selectedIssue.projectId) {
        throw conflict("Repository copy configuration changed during preparation");
      }
      const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
      if (selectedWorkspace && (!workspace || workspace.projectId !== selectedWorkspace.projectId
        || workspace.projectWorkspaceId !== selectedWorkspace.projectWorkspaceId)) {
        throw conflict("Repository copy workspace configuration changed during preparation");
      }
      const currentSelection = issue.workspaceSelection?.selection;
      const currentAnchorSourceId = workspace?.projectWorkspaceId ?? issue.projectWorkspaceId
        ?? (currentSelection?.kind === "configured_source" ? currentSelection.projectWorkspaceId : null);
      if (currentAnchorSourceId !== anchorSourceId) throw conflict("Repository copy configuration changed during preparation");
      await requiresAnonymousAcquisition(db, { issue, workspace: workspace ?? null, agentId: input.agentId, runId: input.runId });
      const actor = await currentRunActor(db, input);
      const access = await assertTaskWorkspaceExecutionAccess(db, actor, input.companyId, { issueId: issue.id,
        ...(workspace ? { workspaceId: workspace.id } : {}), projectWorkspaceId: anchorSourceId });
      if (selectedSource && selectedSource.projectId !== (access.source?.projectId ?? access.workspace?.projectId ?? access.task.projectId)) {
        throw forbidden("Repository copy source is outside the selected project");
      }
      if (workspace) await publicationBinding(db, input);
      if (selectedSource) {
        const [source] = await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.id, selectedSource.id), eq(projectWorkspaces.companyId, input.companyId)));
        if (!source || source.cwd !== selectedSource.cwd || source.repoUrl !== selectedSource.repoUrl || source.repoRef !== selectedSource.repoRef
          || source.projectId !== selectedSource.projectId || source.sourceType !== selectedSource.sourceType) {
          throw conflict("Repository copy configuration changed during preparation");
        }
        await assertTaskWorkspaceSourceProjectAccess(db, actor, input.companyId, source.projectId);
      }
    };
    await verify();
    return verify;
  }
  async function assertRecoveryBinding(input: PublicationInput) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
    if (!issue || !run || run.agentId !== input.agentId) throw forbidden("Task repository recovery identity is unavailable");
    let execution;
    try { execution = parseNativeExecutionInput(run.runnerProfileJson?.nativeExecutionInput); } catch { /* Old non-native runs have no native input. */ }
    const binding = execution?.binding;
    if (run.runtimeMode === "native") {
      if (!binding || binding.companyId !== input.companyId || binding.runId !== input.runId
        || binding.agentId !== input.agentId || binding.issueId !== input.issueId || binding.executionWorkspaceId !== input.workspaceId
        || (!workspace && input.workspaceId !== input.runId)) {
        throw forbidden("Task repository recovery identity is unavailable");
      }
    } else if (!workspace || issue.executionWorkspaceId !== workspace.id) {
      throw forbidden("Task repository recovery identity is unavailable");
    }
    await requiresAnonymousAcquisition(db, { issue, workspace: workspace ?? null, agentId: input.agentId, runId: input.runId });
    const actor = await currentRunActor(db, input);
    // Recovery uses the native run's immutable binding rather than the task's latest workspace pointer.
    await assertTaskWorkspaceExecutionAccess(db, actor, input.companyId, { issueId: issue.id });
    if (workspace?.projectId) await assertTaskWorkspaceSourceProjectAccess(db, actor, input.companyId, workspace.projectId);
  }
  async function sharedPublicationPin(input: { row: RepositoryRow; root: string; ownership: { repositoryId?: unknown; pinnedCommit?: unknown } | null }) {
    const validPin = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
    let pin = input.row.pinnedCommit;
    if (pin && !validPin(pin)) throw conflict("Repository preparation receipt has an invalid pinned commit; repair is required before reuse");
    const ownerId = input.ownership?.repositoryId;
    if (typeof ownerId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ownerId)) return pin;
    if (ownerId === input.row.id) {
      if (validPin(input.ownership?.pinnedCommit)) {
        if (pin && pin !== input.ownership.pinnedCommit) throw conflict("Shared repository publication receipts disagree; repair is required before reuse");
        pin = input.ownership.pinnedCommit;
      }
      return pin;
    }
    // The checkout marker names at most one other receipt. This is integrity evidence,
    // not authority to disclose its originating workspace or task.
    const [owner] = await measureRunPhase("workspace.repository.receipts", () => db.select({ repository: executionWorkspaceRepositories, workspace: executionWorkspaces })
      .from(executionWorkspaceRepositories).innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
      .where(and(eq(executionWorkspaceRepositories.id, ownerId), eq(executionWorkspaceRepositories.companyId, input.row.companyId),
        eq(executionWorkspaces.companyId, input.row.companyId))));
    if (!owner || !owner.workspace.cwd) return pin;
    const { repository, workspace } = owner;
    if (repository.repositoryIdentity !== input.row.repositoryIdentity || repository.relativePath !== input.row.relativePath
      || await measureRunPhase("workspace.repository.paths", () => fs.realpath(workspace.cwd!).catch(() => null)) !== input.root) return pin;
    assertRepositoryRetryMatches(repository, input.row.repositoryIdentity, input.row.requestedRef);
    const markerPin = validPin(input.ownership?.pinnedCommit) ? input.ownership.pinnedCommit : null;
    if (repository.pinnedCommit && markerPin && repository.pinnedCommit !== markerPin) {
      throw conflict("Shared repository publication receipts disagree; repair is required before reuse");
    }
    const candidatePin = repository.pinnedCommit ?? markerPin;
    if (!validPin(candidatePin)) return pin;
    if (pin && pin !== candidatePin) throw conflict("Shared repository publication receipts disagree; repair is required before reuse");
    return candidatePin;
  }
  async function prepareForAdmission(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string; responsibleUserId: string | null }) {
    const { acquisitionRestricted } = await publicationBinding(db, input, false);
    const rows = await list(input.companyId, input.workspaceId);
    if (!rows.length) return [];
    await publicationBinding(db, input);
    if (acquisitionRestricted && rows.some(row => row.state !== "ready" || !row.pinnedCommit || !/^[a-f0-9]{40,64}$/.test(row.pinnedCommit))) {
      throw forbidden(controllerAcquisitionMessage);
    }
    const root = await measureRunPhase("workspace.repository.paths", () => fs.realpath(input.cwd));
    const available = acquisitionRestricted ? [] : await catalog(input.companyId, input.responsibleUserId, input.responsibleUserId === "local-board");
    const resolveAuth = createGitRemoteAuthProvider(db, input.companyId, { issueId: input.issueId, heartbeatRunId: input.runId, agentId: input.agentId, responsibleUserId: input.responsibleUserId });
    const sources = rows.map(row => {
      assertAcquisitionReceipt(row, acquisitionRestricted);
      return resolveAcquisitionSource(row.catalogRepositoryId ? { kind: "catalog", id: row.catalogRepositoryId } : { kind: "url", url: row.repoUrl }, available, acquisitionRestricted);
    });
    const stagingParent = await measureRunPhase("workspace.repository.fs_prepare", async () => {
      const repositoryRoot = path.join(root, ".paperclip-repositories");
      if (!acquisitionRestricted) await fs.mkdir(repositoryRoot, { recursive: true });
      if ((await fs.lstat(repositoryRoot)).isSymbolicLink() || await fs.realpath(repositoryRoot) !== repositoryRoot) throw conflict("Repository directory escapes the task workspace");
      let stagingParent = root;
      if (!acquisitionRestricted) {
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
        const ignorePath = path.join(stagingParent, ".gitignore");
        const ignoreEntry = await fs.lstat(ignorePath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (ignoreEntry && (!ignoreEntry.isFile() || ignoreEntry.isSymbolicLink())) {
          throw conflict("Repository staging ignore file is not a regular file");
        }
        const ignoreTemporary = path.join(stagingParent, `.ignore-${randomUUID()}.tmp`);
        try {
          await fs.writeFile(ignoreTemporary, "*\n", { flag: "wx", mode: 0o600 });
          await fs.rename(ignoreTemporary, ignorePath);
        } finally { await fs.rm(ignoreTemporary, { force: true }); }
        await measureRunPhase("workspace.repository.ignore_rules", () => ensureManagedRepositoriesIgnored(root));
      }
      return stagingParent;
    });
    const prepared: Array<{ id: string; cwd: string; repoUrl: string; relativePath: string; pinnedCommit: string; branchName: string | null }> = [];
    for (const [index, row] of rows.entries()) {
      const source = sources[index];
      if (source.repositoryIdentity !== row.repositoryIdentity || row.relativePath !== taskRepositoryRelativePath(row.repositoryIdentity)) throw conflict("Repository preparation receipt does not match its source");
      const cwd = path.join(root, row.relativePath);
      await withRepositoryPublication(cwd, async () => {
        const existing = await measureRunPhase("workspace.repository.checkout_identity", async () => {
          const existing = await fs.lstat(cwd).catch(() => null);
          if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || await fs.realpath(cwd) !== cwd)) throw conflict("Repository checkout path is not a contained directory");
          if (existing) {
            const gitDir = path.join(cwd, ".git");
            const metadata = await fs.lstat(gitDir).catch(() => null);
            if (!metadata?.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(gitDir) !== gitDir) throw conflict("Repository Git metadata escapes the managed checkout");
          }
          if (acquisitionRestricted && !existing) throw forbidden(controllerAcquisitionMessage);
          return existing;
        });
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        anonymous.env = { ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
        if (!acquisitionRestricted) await measureRunPhase("workspace.repository.state_write", () => db.update(executionWorkspaceRepositories).set({ state: "preparing", catalogRepositoryId: source.catalogRepositoryId, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id)));
        try {
          const ownershipPath = path.join(cwd, ".git", "paperclip-workspace-owner.json");
          const readOwnership = () => measureRunPhase("workspace.repository.ownership_read", async () => {
            const handle = await fs.open(ownershipPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK).catch(() => null);
            if (!handle) return null;
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > 4096) return null;
              const bytes = Buffer.alloc(4097);
              const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
              return bytesRead <= 4096 ? JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")) : null;
            } catch { return null; } finally { await handle.close(); }
          });
          const initialOwnership = await readOwnership();
          const authorizedPin = await measureRunPhase("workspace.repository.ownership_verify", () => sharedPublicationPin({ row, root, ownership: initialOwnership }));
          if (existing && !authorizedPin && initialOwnership?.repositoryId !== row.id) {
            throw conflict("Repository directory has no matching preparation receipt; repair it before retrying");
          }
          if (!acquisitionRestricted) {
            await assertCurrentControllerAcquisition(input);
            const result = await measureRunPhase("workspace.repository.materialize", () => materializeManagedProjectWorkspace(cwd, {
              repoUrl: source.repoUrl,
              stagingParent,
              repoRef: authorizedPin ?? (row.requestedRef === "HEAD" ? null : row.requestedRef),
              resolveGitAuth: source.catalogRepositoryId ? resolveAuth : async () => anonymous,
              beforePublish: async cloneCwd => {
                await assertCurrentControllerAcquisition(input);
                await assertPublicationAllowed(input);
                if (source.catalogRepositoryId) {
                  const currentCatalog = await catalog(input.companyId, input.responsibleUserId, input.responsibleUserId === "local-board");
                  const currentSource = resolveAcquisitionSource({ kind: "catalog", id: source.catalogRepositoryId }, currentCatalog, false);
                  if (currentSource.repositoryIdentity !== row.repositoryIdentity) throw conflict("Repository preparation receipt does not match its source");
                }
                const pinnedCommit = await measureRunPhase("workspace.repository.git_commit", async () =>
                  (await execFile("git", ["-C", cloneCwd, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim());
                await measureRunPhase("workspace.repository.ownership_write", () => fs.writeFile(path.join(cloneCwd, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ version: 1, repositoryId: row.id, pinnedCommit }), { flag: "wx", mode: 0o600 }));
              },
            }));
            if (result.warning) throw conflict(result.warning);
          }
          const git = async (...args: string[]) => (await execFile("git", ["-C", cwd, ...args], { timeout: 30_000, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } })).stdout.trim();
          const origin = normalizeProjectRepositoryUrl(await measureRunPhase("workspace.repository.git_origin", () => git("remote", "get-url", "origin")));
          if (origin.url.toLowerCase() !== row.repositoryIdentity) throw conflict("Repository checkout belongs to a different origin");
          const ownership = await readOwnership();
          if (!authorizedPin && (ownership?.repositoryId !== row.id || !/^[a-f0-9]{40,64}$/.test(ownership.pinnedCommit))) throw conflict("Repository publication has no valid preparation receipt");
          const pinnedCommit: string = authorizedPin ?? ownership.pinnedCommit;
          if (acquisitionRestricted) await measureRunPhase("workspace.repository.git_commit", () => git("cat-file", "-e", `${pinnedCommit}^{commit}`));
          const branchName = await measureRunPhase("workspace.repository.git_branch", () => git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => null));
          await assertPublicationAllowed(input);
          if (!acquisitionRestricted) {
            await assertCurrentControllerAcquisition(input);
            if (source.catalogRepositoryId) {
              const currentCatalog = await catalog(input.companyId, input.responsibleUserId, input.responsibleUserId === "local-board");
              const currentSource = resolveAcquisitionSource({ kind: "catalog", id: source.catalogRepositoryId }, currentCatalog, false);
              if (currentSource.repositoryIdentity !== row.repositoryIdentity) throw conflict("Repository preparation receipt does not match its source");
            }
          }
          if (ownership?.repositoryId !== row.id || ownership?.pinnedCommit !== pinnedCommit) {
            await measureRunPhase("workspace.repository.ownership_write", async () => {
              const gitDir = path.join(cwd, ".git");
              const metadata = await fs.lstat(gitDir);
              if (!metadata.isDirectory() || metadata.isSymbolicLink() || await fs.realpath(gitDir) !== gitDir) {
                throw conflict("Repository Git metadata escapes the managed checkout");
              }
              const temporaryOwnershipPath = path.join(gitDir, `.paperclip-workspace-owner-${randomUUID()}.tmp`);
              try {
                await fs.writeFile(temporaryOwnershipPath, JSON.stringify({ version: 1, repositoryId: row.id, pinnedCommit }), { flag: "wx", mode: 0o600 });
                // Keep bounded ownership lookup attached to a receipt for this root,
                // even if the workspace that originally published it later moves.
                await fs.rename(temporaryOwnershipPath, ownershipPath);
              } finally { await fs.rm(temporaryOwnershipPath, { force: true }); }
            });
          }
          await measureRunPhase("workspace.repository.state_write", () => db.update(executionWorkspaceRepositories).set({ state: "ready", pinnedCommit, branchName, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id)));
          prepared.push({ id: row.id, cwd, repoUrl: row.repoUrl, relativePath: row.relativePath, pinnedCommit, branchName });
        } catch (error) {
          await measureRunPhase("workspace.repository.state_write", () => db.update(executionWorkspaceRepositories).set({ state: "needs_repair", failureCode: "repository_preparation_failed", updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id)));
          throw error;
        }
      });
    }
    return prepared;
  }
  return { request, list, prepareForAdmission, assertRecoveryBinding, assertPublicationAllowed, prepareConfiguredRepositoryCopy };
}
