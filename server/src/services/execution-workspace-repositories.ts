import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { and, inArray, eq, isNotNull, or, sql } from "drizzle-orm";
import { activityLog, agents, heartbeatRuns, projects, projectWorkspaces, executionWorkspaceRepositoryAccess, executionWorkspaceRepositoryRoots, executionWorkspaceRepositories, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import { prepareWorkspaceRepositorySchema, type PrepareWorkspaceRepository, type ProjectRepository } from "@paperclipai/shared";
import { withDirectoryPublicationLock } from "@paperclipai/adapter-utils/workspace-restore-merge";
import { conflict, forbidden, notFound } from "../errors.js";
import { parseNativeExecutionInput } from "../vendor/paperclip-runner/index.js";
import { assertTaskWorkspacesReadAccessForActors, assertTaskWorkspacesReadAccess, assertTaskWorkspaceAccess, assertTaskWorkspaceSourceProjectAccess } from "./task-workspace-source-access.js";
import { authorizationService, canActorReadExecutionWorkspace, executionWorkspaceReadSqlCondition, issueReadSqlCondition, projectReadSqlCondition, type AuthorizationActor } from "./authorization.js";
import { LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH, resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { taskWorkspaceSelectableCondition } from "./task-workspace-selection.js";
import { captureRunIdentity } from "./run-identity.js";
import { toolAccessService } from "./tool-access.js";
import { normalizeProjectRepositoryUrl } from "./project-repositories.js";
import { buildGitAuthInvocation, createGitRemoteAuthProvider } from "./git-credentials.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "./managed-repository-checkout.js";

import { canonicalRepositoryRoot, repositoryRootsOverlap, legacyRepositoryRootMayMatch, configuredWorkspaceRoot, verifiedIsolatedWorktree, unusedIsolatedCopyTarget, isolatedWorkspaceSourceRoots, type WorkspaceSourceCopyKind } from "./execution-workspace-source-roots.js";
export { canonicalRepositoryRoot } from "./execution-workspace-source-roots.js";

const execFile = promisify(execFileCallback);
type RepositoryRow = typeof executionWorkspaceRepositories.$inferSelect;
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const controllerAcquisitionMessage = "New controller repository acquisition requires a trusted task. Existing verified public checkouts remain available.";
const lowTrustRepositoryMessage = "Low-trust repository reuse permits anonymous public URLs only; new acquisition is unavailable. Use an authorized configured source for private repositories.";

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

async function resolveRepositoryRootSources(tx: Db | DbTransaction, input: {
  companyId: string; cwd: string; sourceWorkspaceId?: string; inspectCurrentAliases?: boolean; preparingCopyProjectIds?: Set<string>;
}) {
  const canonicalCwd = await canonicalRepositoryRoot(input.cwd);
  const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
  const companyEntries = await tx.select().from(executionWorkspaceRepositoryAccess)
    .where(eq(executionWorkspaceRepositoryAccess.companyId, input.companyId));
  const entries = companyEntries.filter(entry => entry.rootKey === rootKey);
  const overlappingEntries = companyEntries.filter(entry => repositoryRootsOverlap(entry.canonicalCwd, canonicalCwd));
  if (entries.some(entry => entry.canonicalCwd !== canonicalCwd)
    || overlappingEntries.some(entry => createHash("sha256").update(entry.canonicalCwd).digest("hex") !== entry.rootKey)) {
    throw forbidden("Repository root identity conflicts with its retained access record");
  }
  const proofs = entries.filter(entry => entry.kind === "isolated_copy");
  const copiedProjectIds = new Set(input.preparingCopyProjectIds ?? []);
  if (proofs.length && await verifiedIsolatedWorktree(canonicalCwd)) {
    for (const proof of proofs) copiedProjectIds.add(proof.scopeId);
  }
  const isCopiedAncestor = (projectId: string, sourceRoot: string) => copiedProjectIds.has(projectId)
    && sourceRoot !== canonicalCwd && repositoryRootsOverlap(sourceRoot, canonicalCwd)
    && !path.relative(sourceRoot, canonicalCwd).startsWith(`..${path.sep}`)
    && path.relative(sourceRoot, canonicalCwd) !== "..";
  const sharedSourceRoots = new Map<string, Set<string>>();
  const addSharedSource = (id: string, cwd: string) => {
    const roots = sharedSourceRoots.get(id) ?? new Set<string>();
    roots.add(cwd); sharedSourceRoots.set(id, roots);
  };
  for (const entry of overlappingEntries) if (entry.kind === "source") addSharedSource(entry.scopeId, entry.canonicalCwd);
  const sharedSourceIds = new Set(sharedSourceRoots.keys());
  const isolatedSourceIds = new Set(overlappingEntries.filter(entry => entry.kind === "isolated_source").map(entry => entry.scopeId));
  const sourceIds = new Set([...sharedSourceIds, ...isolatedSourceIds]);
  if (input.sourceWorkspaceId) { sourceIds.add(input.sourceWorkspaceId); sharedSourceIds.add(input.sourceWorkspaceId); addSharedSource(input.sourceWorkspaceId, canonicalCwd); }
  const workspaces = await tx.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd }).from(executionWorkspaces)
    .where(eq(executionWorkspaces.companyId, input.companyId));
  for (const workspace of workspaces) {
    if (!workspace.cwd) continue;
    const peerRoot = await canonicalRepositoryRoot(workspace.cwd).catch((error: NodeJS.ErrnoException) => {
      if (["ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(error.code ?? "")) return null;
      throw error;
    });
    if (peerRoot && repositoryRootsOverlap(peerRoot, canonicalCwd)) {
      sourceIds.add(workspace.id); sharedSourceIds.add(workspace.id); addSharedSource(workspace.id, peerRoot);
    }
  }
  const inventory = await tx.select({ id: executionWorkspaceRepositories.id, workspaceId: executionWorkspaces.id, cwd: executionWorkspaces.cwd,
    identity: executionWorkspaceRepositories.repositoryIdentity }).from(executionWorkspaceRepositories)
    .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
    .where(and(eq(executionWorkspaceRepositories.companyId, input.companyId), eq(executionWorkspaces.companyId, input.companyId)));
  const namespace = path.join(canonicalCwd, ".paperclip-repositories");
  const namespaceEntry = await fs.lstat(namespace).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const publishedNames = new Set<string>();
  if (namespaceEntry) {
    if (!namespaceEntry.isDirectory() || namespaceEntry.isSymbolicLink() || await fs.realpath(namespace) !== namespace) {
      throw forbidden("Repository namespace has no verifiable contained ownership");
    }
    for (const name of await fs.readdir(namespace)) if (name.startsWith("task-repo-")) publishedNames.add(name);
  }
  const repositoryOrigins = await tx.select({ id: executionWorkspaceRepositoryAccess.scopeId }).from(executionWorkspaceRepositoryAccess)
    .where(and(eq(executionWorkspaceRepositoryAccess.companyId, input.companyId), eq(executionWorkspaceRepositoryAccess.kind, "repository")));
  const knownOrigins = new Set(repositoryOrigins.map(origin => origin.id));
  const recognizedNames = new Set<string>();
  for (const peer of inventory) {
    const name = path.basename(taskRepositoryRelativePath(peer.identity));
    const published = publishedNames.has(name);
    const peerRoot = peer.cwd ? await fs.realpath(peer.cwd).catch((error: NodeJS.ErrnoException) => {
      if (["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP", "ENAMETOOLONG"].includes(error.code ?? "")) return null;
      throw error;
    }) : null;
    const matches = sourceIds.has(peer.workspaceId) || (peerRoot !== null && repositoryRootsOverlap(peerRoot, canonicalCwd))
      || (published && peerRoot === null && !knownOrigins.has(peer.id))
      || (peerRoot === null && !entries.some(entry => entry.kind === "reader") && peer.cwd && await legacyRepositoryRootMayMatch(peer.cwd, canonicalCwd));
    if (matches) {
      sourceIds.add(peer.workspaceId);
      if (!isolatedSourceIds.has(peer.workspaceId) || (peerRoot && repositoryRootsOverlap(peerRoot, canonicalCwd))) {
        sharedSourceIds.add(peer.workspaceId); addSharedSource(peer.workspaceId, peerRoot ?? canonicalCwd);
      }
      if (published) recognizedNames.add(name);
    }
  }
  if ([...publishedNames].some(name => !recognizedNames.has(name))) throw forbidden("Published repository has no retained workspace provenance");
  const configured = await tx.select({ projectId: projectWorkspaces.projectId, cwd: projectWorkspaces.cwd, repoUrl: projectWorkspaces.repoUrl })
    .from(projectWorkspaces).where(eq(projectWorkspaces.companyId, input.companyId));
  const sourceProjectIds = new Set(overlappingEntries.filter(entry => (entry.kind === "project_source" || entry.kind === "isolated_project_source")).map(entry => entry.scopeId));
  const sharedProjectIds = new Set(overlappingEntries.filter(entry => entry.kind === "shared_project_source" && !isCopiedAncestor(entry.scopeId, entry.canonicalCwd)).map(entry => entry.scopeId));
  const isolatedProjectIds = new Set(overlappingEntries.filter(entry => entry.kind === "isolated_project_source").map(entry => entry.scopeId));
  if (sourceIds.size) {
    const owners = await tx.select({ id: executionWorkspaces.id, projectId: executionWorkspaces.projectId, strategyType: executionWorkspaces.strategyType }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, input.companyId), or(...[...sourceIds].map(id => eq(executionWorkspaces.id, id)))));
    for (const owner of owners) if (owner.projectId) {
      sourceProjectIds.add(owner.projectId);
      if (owner.strategyType === "git_worktree" || !sharedSourceIds.has(owner.id)
        || [...sharedSourceRoots.get(owner.id) ?? []].every(cwd => isCopiedAncestor(owner.projectId!, cwd))) isolatedProjectIds.add(owner.projectId);
      else sharedProjectIds.add(owner.projectId);
    }
  }
  for (const source of configured) {
    if (sharedProjectIds.has(source.projectId)) continue;
    const sourceRoot = await configuredWorkspaceRoot(source, true);
    if (!sourceRoot || !repositoryRootsOverlap(sourceRoot, canonicalCwd)) continue;
    sourceProjectIds.add(source.projectId);
    if (!isCopiedAncestor(source.projectId, sourceRoot)) sharedProjectIds.add(source.projectId);
  }
  for (const entry of overlappingEntries) if (entry.kind === "project_source" && !isolatedProjectIds.has(entry.scopeId)) {
    sharedProjectIds.add(entry.scopeId);
  }
  return { canonicalCwd, rootKey, entries, overlappingEntries, sourceIds, sharedSourceIds, isolatedSourceIds, sourceProjectIds, sharedProjectIds, isolatedProjectIds };
}

async function assertRootProjectAccess(db: Db | DbTransaction, actor: AuthorizationActor, companyId: string, projectIds: Set<string>,
  write?: { sharedProjectIds: Set<string> } & Omit<NonNullable<Parameters<typeof assertTaskWorkspaceSourceProjectAccess>[4]>, "write">) {
  for (const projectId of projectIds) {
    const [project] = await db.select({ id: projects.id }).from(projects).where(and(
      eq(projects.id, projectId), eq(projects.companyId, companyId), await projectReadSqlCondition(db, actor)));
    if (!project) throw forbidden("Workspace source project is no longer accessible");
    await assertTaskWorkspaceSourceProjectAccess(db, actor, companyId, projectId, {
      ...write, write: write?.sharedProjectIds.has(projectId),
    });
  }
}

async function retainedRootReader(tx: DbTransaction, companyId: string, reader: Pick<typeof executionWorkspaceRepositoryAccess.$inferSelect, "scopeId" | "issueId" | "agentId" | "responsibleUserId">) {
  const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, reader.scopeId), eq(heartbeatRuns.companyId, companyId)));
  const [agent] = reader.agentId ? await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, reader.agentId), eq(agents.companyId, companyId))) : [];
  const [issue] = reader.issueId ? await tx.select().from(issues).where(and(eq(issues.id, reader.issueId), eq(issues.companyId, companyId))) : [];
  if (!run || !agent || !issue || run.agentId !== reader.agentId || run.responsibleUserId !== reader.responsibleUserId
    || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== reader.issueId) {
    throw forbidden("Repository root retains a reader whose identity is no longer available");
  }
  const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId,
    agentId: reader.agentId!, runId: reader.scopeId, onBehalfOfUserId: reader.responsibleUserId === "local-board" ? null : reader.responsibleUserId };
  return { actor, issue };
}

export async function lockExecutionWorkspaceRootProvenance(tx: DbTransaction, companyId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`task-repository-roots:${companyId}`}, 0))`);
}

export async function preserveConfiguredProjectWorkspaceRootProvenance(tx: DbTransaction, input: {
  companyId: string; projectId: string; cwd: string | null; repoUrl?: string | null;
}): Promise<void> {
  const canonicalCwd = await configuredWorkspaceRoot(input, false);
  if (!canonicalCwd) return;
  const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
  const entries = await tx.select().from(executionWorkspaceRepositoryAccess).where(and(
    eq(executionWorkspaceRepositoryAccess.companyId, input.companyId), eq(executionWorkspaceRepositoryAccess.rootKey, rootKey)));
  if (entries.some(entry => entry.canonicalCwd !== canonicalCwd)) throw forbidden("Repository root identity conflicts with its retained access record");
  for (const kind of ["project_source", "shared_project_source"] as const) {
    if (!entries.some(entry => entry.kind === kind && entry.scopeId === input.projectId)) {
      await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, canonicalCwd, rootKey, kind, scopeId: input.projectId });
    }
  }
}

export async function preserveExecutionWorkspaceRootProvenance(tx: DbTransaction, input: {
  companyId: string; workspaceId: string; cwd: string | null;
}): Promise<void> {
  if (!input.cwd) return;
  const directory = await fs.stat(input.cwd).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!directory) return;
  if (!directory.isDirectory()) throw forbidden("Workspace files cannot be detached from unverifiable provenance");
  const { canonicalCwd, rootKey, entries, sharedSourceIds, isolatedSourceIds, sourceProjectIds, sharedProjectIds, isolatedProjectIds } = await resolveRepositoryRootSources(tx, {
    companyId: input.companyId, cwd: input.cwd, sourceWorkspaceId: input.workspaceId, inspectCurrentAliases: true,
  });
  for (const [kind, ids] of [["source", sharedSourceIds], ["isolated_source", isolatedSourceIds], ["project_source", sourceProjectIds], ["shared_project_source", sharedProjectIds], ["isolated_project_source", isolatedProjectIds]] as const) {
    for (const scopeId of ids) {
      if (!entries.some(entry => entry.kind === kind && entry.scopeId === scopeId)) {
        await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, canonicalCwd, rootKey, kind, scopeId });
      }
    }
  }
}

export async function assertExecutionWorkspaceRootReadAccess(db: Db | DbTransaction, input: {
  companyId: string; cwd: string; actor: AuthorizationActor; sourceWorkspaceId?: string;
}): Promise<void> {
  const { sourceIds, sourceProjectIds } = await resolveRepositoryRootSources(db, { ...input, inspectCurrentAliases: true });
  await assertTaskWorkspacesReadAccess(db, input.actor, input.companyId, sourceIds);
  await assertRootProjectAccess(db, input.actor, input.companyId, sourceProjectIds);
}

export type IsolatedWorkspaceSourceAccess = {
  companyId: string;
  roots: string[];
  workspaceIds: string[];
  projectIds: string[];
};

async function retainGitMetadataOwners(tx: DbTransaction, input: {
  companyId: string; commonRoot: string; workspaceIds: Set<string>; projectIds: Set<string>;
}): Promise<void> {
  const closure = await resolveRepositoryRootSources(tx, { companyId: input.companyId, cwd: input.commonRoot, inspectCurrentAliases: true });
  const workspaceIds = new Set([...closure.sourceIds, ...input.workspaceIds]);
  const projectIds = new Set([...closure.sourceProjectIds, ...input.projectIds]);
  const readerActors: AuthorizationActor[] = [];
  for (const reader of closure.overlappingEntries.filter(entry => entry.kind === "reader")) {
    const { actor } = await retainedRootReader(tx, input.companyId, reader);
    readerActors.push(actor);
    await assertRootProjectAccess(tx, actor, input.companyId, projectIds);
  }
  await assertTaskWorkspacesReadAccessForActors(tx, readerActors, input.companyId, workspaceIds);
  for (const [kind, ids] of [["source", workspaceIds], ["project_source", projectIds]] as const) {
    for (const scopeId of ids) if (!closure.entries.some(entry => entry.kind === kind && entry.scopeId === scopeId)) {
      await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId,
        canonicalCwd: closure.canonicalCwd, rootKey: closure.rootKey, kind, scopeId });
    }
  }
}

export async function assertIsolatedWorkspaceSourceReadAccess(db: Db, input: {
  companyId: string; sourceCwd: string; actor: AuthorizationActor; copyKind?: WorkspaceSourceCopyKind;
}): Promise<IsolatedWorkspaceSourceAccess> {
  const { roots, commonRoot } = await isolatedWorkspaceSourceRoots(db, input.companyId, input.sourceCwd, input.copyKind);
  return db.transaction(async tx => {
    await lockExecutionWorkspaceRootProvenance(tx, input.companyId);
    const workspaceIds = new Set<string>(), projectIds = new Set<string>();
    for (const cwd of roots) {
      const closure = await resolveRepositoryRootSources(tx, { companyId: input.companyId, cwd, inspectCurrentAliases: true });
      await assertTaskWorkspacesReadAccess(tx, input.actor, input.companyId, closure.sourceIds);
      for (const id of closure.sourceIds) workspaceIds.add(id);
      await assertRootProjectAccess(tx, input.actor, input.companyId, closure.sourceProjectIds);
      for (const id of closure.sourceProjectIds) projectIds.add(id);
    }
    await retainGitMetadataOwners(tx, { companyId: input.companyId, commonRoot, workspaceIds, projectIds });
    return { companyId: input.companyId, roots, workspaceIds: [...workspaceIds], projectIds: [...projectIds] };
  });
}

export async function retainIsolatedWorkspaceSourceAccess(db: Db, input: {
  companyId: string; sourceCwd: string; targetCwd: string; actor: AuthorizationActor;
  captured: IsolatedWorkspaceSourceAccess; issueId?: string; phase?: "preparing" | "verified"; copyKind?: WorkspaceSourceCopyKind;
}): Promise<void> {
  if (input.captured.companyId !== input.companyId) throw forbidden("Isolated copy source identity changed");
  let sourceFailure: unknown;
  const roots = new Set(input.captured.roots);
  try { for (const cwd of (await isolatedWorkspaceSourceRoots(db, input.companyId, input.sourceCwd, input.copyKind)).roots) roots.add(cwd); }
  catch (error) { sourceFailure = error; }
  const canonicalCwd = await canonicalRepositoryRoot(input.targetCwd);
  const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
  const denied = await db.transaction(async tx => {
    await lockExecutionWorkspaceRootProvenance(tx, input.companyId);
    const existing = await tx.select().from(executionWorkspaceRepositoryAccess).where(and(
      eq(executionWorkspaceRepositoryAccess.companyId, input.companyId), eq(executionWorkspaceRepositoryAccess.rootKey, rootKey)));
    if (existing.some(entry => entry.canonicalCwd !== canonicalCwd)) throw forbidden("Repository root identity conflicts with its retained access record");
    const workspaceIds = new Set(input.captured.workspaceIds), projectIds = new Set(input.captured.projectIds);
    let failure = sourceFailure;
    for (const cwd of roots) {
      try {
        const closure = await resolveRepositoryRootSources(tx, { companyId: input.companyId, cwd, inspectCurrentAliases: true });
        for (const id of closure.sourceIds) workspaceIds.add(id);
        for (const id of closure.sourceProjectIds) projectIds.add(id);
      } catch (error) { failure ??= error; }
    }
    try { await assertTaskWorkspacesReadAccess(tx, input.actor, input.companyId, workspaceIds); }
    catch (error) { failure ??= error; }
    for (const id of projectIds) {
      try { await assertRootProjectAccess(tx, input.actor, input.companyId, new Set([id])); }
      catch (error) { failure ??= error; }
    }
    for (const [kind, ids] of [["isolated_source", workspaceIds], ["isolated_project_source", projectIds]] as const) {
      for (const scopeId of ids) if (!existing.some(entry => entry.kind === kind && entry.scopeId === scopeId)) {
        await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, rootKey, canonicalCwd, kind, scopeId });
      }
    }
    const phase = input.phase ?? "preparing";
    let preparingCopyProjectIds: Set<string> | undefined;
    let verifiedCopyProjectIds: Set<string> | undefined;
    try {
      const targetEntry = await fs.lstat(input.targetCwd).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (targetEntry?.isSymbolicLink()) throw forbidden("Isolated copy target cannot be a symbolic link");
      const linkedWorktree = input.copyKind !== "repository";
      const verifiedTarget = linkedWorktree && await verifiedIsolatedWorktree(canonicalCwd, roots);
      if (linkedWorktree && (phase === "verified" || verifiedTarget)) {
        if (!verifiedTarget) throw forbidden("Isolated copy target is not a verified Git worktree");
        preparingCopyProjectIds = projectIds;
        verifiedCopyProjectIds = projectIds;
      } else if (linkedWorktree && await unusedIsolatedCopyTarget(input.targetCwd)) {
        preparingCopyProjectIds = projectIds;
      }
    } catch (error) { failure ??= error; }
    try {
      const target = await resolveRepositoryRootSources(tx, { companyId: input.companyId, cwd: canonicalCwd, preparingCopyProjectIds });
      await assertRootProjectTrust(tx, { companyId: input.companyId, actor: input.actor, issueId: input.issueId, projectIds: target.sourceProjectIds });
      await assertTaskWorkspacesReadAccess(tx, input.actor, input.companyId, target.sourceIds);
      await assertRootProjectAccess(tx, input.actor, input.companyId, target.sourceProjectIds,
        { sharedProjectIds: target.sharedProjectIds, issueId: input.issueId });
      const readerActors: AuthorizationActor[] = [];
      for (const reader of target.overlappingEntries.filter(entry => entry.kind === "reader")) {
        const { actor, issue } = await retainedRootReader(tx, input.companyId, reader);
        readerActors.push(actor);
        await assertRootProjectTrust(tx, { companyId: input.companyId, actor, issueId: issue.id, projectIds: target.sourceProjectIds });
        await assertRootProjectAccess(tx, actor, input.companyId, target.sourceProjectIds);
      }
      await assertTaskWorkspacesReadAccessForActors(tx, readerActors, input.companyId, target.sourceIds);
    } catch (error) { failure ??= error; }
    if (!failure && verifiedCopyProjectIds) {
      for (const scopeId of verifiedCopyProjectIds) if (!existing.some(entry => entry.kind === "isolated_copy" && entry.scopeId === scopeId)) {
        await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, rootKey, canonicalCwd, kind: "isolated_copy", scopeId });
      }
    }
    return failure;
  });
  if (denied) throw denied;
}

export type TaskWorkspaceCreationTrustContext = {
  parentIssueId?: string | null; projectId?: string | null; assigneeAgentId?: string | null; executionPolicy?: unknown;
};

async function assertRootProjectTrust(db: Db | DbTransaction, input: {
  companyId: string; projectIds: Set<string>; actor: AuthorizationActor;
  issueId?: string | null; sourceWorkspaceId?: string; assigneeAgentId?: string | null; taskCreation?: TaskWorkspaceCreationTrustContext;
}) {
  if (!input.projectIds.size) return;
  const owners = await db.select().from(projects).where(and(eq(projects.companyId, input.companyId),
    or(...[...input.projectIds].map(id => eq(projects.id, id)))));
  const restricted = owners.filter(owner => resolveCoreTrustPreset({ companyId: input.companyId, workspaceSourceProject: owner }).kind !== "standard");
  if (!restricted.length) return;
  const incompatible = () => forbidden("Physical workspace source trust is incompatible with the task's execution policy");
  const runId = input.actor.runId;
  const [run] = runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, input.companyId))) : [];
  const creation = !input.issueId && input.actor.type === "agent" && runId ? input.taskCreation : undefined;
  const runIssueId = run?.nativeIssueId ?? run?.contextSnapshot?.issueId ?? run?.contextSnapshot?.taskId ?? run?.issueId;
  const issueId = input.issueId ?? (creation && typeof runIssueId === "string" ? runIssueId : null);
  const [issue] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, input.companyId))) : [];
  const agentId = input.actor.type === "agent" ? input.actor.agentId : issue?.assigneeAgentId ?? input.assigneeAgentId;
  const [agent] = agentId ? await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, input.companyId))) : [];
  const [project] = issue?.projectId ? await db.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, input.companyId))) : [];
  const workspaceId = input.sourceWorkspaceId ?? issue?.executionWorkspaceId;
  const [workspace] = workspaceId ? await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, input.companyId))) : [];
  const [source] = workspace?.projectId ? await db.select().from(projects).where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, input.companyId))) : [];
  if ((agentId && !agent) || (runId && (!run || run.agentId !== agentId || !issue
    || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== issue.id))) throw incompatible();
  const retainedPolicy = run?.contextSnapshot?.executionPolicy;
  const current = resolveCoreTrustPreset({ companyId: input.companyId, agent, project, workspaceSourceProject: source, issue,
    run: run ? { companyId: input.companyId, executionPolicy: retainedPolicy } : null });
  const selected = run
    ? resolveCoreTrustPreset({ companyId: input.companyId, run: { companyId: input.companyId, executionPolicy: retainedPolicy } })
    : current;
  if (selected.kind !== "low_trust_review" || current.kind !== "low_trust_review"
    || !isDeepStrictEqual(selected.boundary, current.boundary)) throw incompatible();
  if (creation) {
    const sponsor = run!.responsibleUserId === "local-board" ? null : run!.responsibleUserId;
    if ((input.actor.onBehalfOfUserId ?? null) !== sponsor) throw incompatible();
    let parentId = creation.parentIssueId;
    const ancestors: Array<typeof issues.$inferSelect> = [];
    for (let depth = 0; parentId && depth < LOW_TRUST_ISSUE_ANCESTRY_MAX_DEPTH; depth++) {
      const [parent] = await db.select().from(issues).where(and(eq(issues.id, parentId), eq(issues.companyId, input.companyId)));
      if (!parent || ancestors.some(ancestor => ancestor.id === parent.id)) throw incompatible();
      ancestors.push(parent);
      if (parent.id === issue!.id) break;
      parentId = parent.parentId;
    }
    if (ancestors.at(-1)?.id !== issue!.id) throw incompatible();
    const decision = await authorizationService(db).decide({ actor: input.actor, action: "issue:mutate",
      resource: { type: "issue", companyId: input.companyId, parentIssueId: creation.parentIssueId,
        projectId: creation.projectId, assigneeAgentId: creation.assigneeAgentId } });
    if (!decision.allowed) throw incompatible();
    const [childAgent] = creation.assigneeAgentId ? await db.select().from(agents).where(and(
      eq(agents.id, creation.assigneeAgentId), eq(agents.companyId, input.companyId))) : [];
    if (creation.assigneeAgentId && !childAgent) throw incompatible();
    for (const candidate of [...ancestors, { companyId: input.companyId, projectId: creation.projectId,
      executionPolicy: creation.executionPolicy }]) {
      const [candidateProject] = candidate.projectId ? await db.select().from(projects).where(and(
        eq(projects.id, candidate.projectId), eq(projects.companyId, input.companyId))) : [];
      if (candidate.projectId && !candidateProject) throw incompatible();
      const prospective = resolveCoreTrustPreset({ companyId: input.companyId,
        agent: "id" in candidate ? agent : childAgent, project: candidateProject, workspaceSourceProject: source,
        issue: candidate, run: { companyId: input.companyId, executionPolicy: retainedPolicy } });
      if (prospective.kind !== "low_trust_review" || !isDeepStrictEqual(prospective.boundary, selected.boundary)) throw incompatible();
    }
  }
  const selectedPolicy = { trustPreset: selected.preset, authorizationPolicy: {
    trustPreset: selected.preset, trustBoundary: selected.boundary,
  } };
  for (const owner of restricted) {
    const combined = resolveCoreTrustPreset({ companyId: input.companyId, workspaceSourceProject: owner,
      run: { companyId: input.companyId, executionPolicy: selectedPolicy } });
    if (combined.kind !== "low_trust_review" || !isDeepStrictEqual(combined.boundary, selected.boundary)) throw incompatible();
  }
}

export async function assertExecutionWorkspaceRootWriteAccess(db: Db | DbTransaction, input: {
  companyId: string; cwd: string; actor: AuthorizationActor; sourceWorkspaceId?: string; taskCreation?: TaskWorkspaceCreationTrustContext;
} & Omit<NonNullable<Parameters<typeof assertTaskWorkspaceSourceProjectAccess>[4]>, "write">): Promise<void> {
  const { sourceIds, sourceProjectIds, sharedProjectIds } = await resolveRepositoryRootSources(db, { ...input, inspectCurrentAliases: true });
  await assertTaskWorkspacesReadAccess(db, input.actor, input.companyId, sourceIds);
  await assertRootProjectAccess(db, input.actor, input.companyId, sourceProjectIds, { ...input, sharedProjectIds });
  await assertRootProjectTrust(db, { ...input, projectIds: sourceProjectIds });
}

export function executionWorkspaceRepositoryService(db: Db) {
  async function catalog(companyId: string, userId: string | null, localTrusted: boolean) {
    return (await toolAccessService(db).listProjectRepositories(companyId, userId, localTrusted)).repositories;
  }
  async function requiresAnonymousAcquisition(reader: Db | DbTransaction, input: {
    issue: typeof issues.$inferSelect; workspace: Pick<typeof executionWorkspaces.$inferSelect, "projectId"> | null;
    agentId?: string | null; runId?: string | null;
  }) {
    const { issue, workspace } = input;
    const agentId = input.agentId ?? issue.assigneeAgentId;
    const [agent] = agentId ? await reader.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, issue.companyId))) : [];
    if (agentId && !agent) throw forbidden("Task repository agent is unavailable");
    const [project] = issue.projectId ? await reader.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, issue.companyId))) : [];
    const [workspaceSourceProject] = workspace?.projectId ? await reader.select().from(projects).where(and(eq(projects.id, workspace.projectId), eq(projects.companyId, issue.companyId))) : [];
    const runId = input.runId ?? issue.executionRunId;
    const [run] = runId ? await reader.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, issue.companyId))) : [];
    if (runId && (!run || (input.runId && run.agentId !== agentId) || (run.nativeIssueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.issueId) !== issue.id)) {
      throw forbidden("Task repository run identity is unavailable");
    }
    const trust = resolveCoreTrustPreset({ companyId: issue.companyId, agent, project, workspaceSourceProject, issue,
      run: run ? { companyId: run.companyId, executionPolicy: run.contextSnapshot?.executionPolicy } : null });
    if (trust.kind === "denied") throw forbidden(trust.detail);
    return trust.kind === "low_trust_review";
  }
  async function assertCurrentControllerAcquisition(input: { companyId: string; issueId: string; workspaceId: string; agentId: string; runId: string }) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id) throw forbidden("Task repository workspace binding is unavailable");
    if (await requiresAnonymousAcquisition(db, { issue, workspace, agentId: input.agentId, runId: input.runId })) throw forbidden(controllerAcquisitionMessage);
  }
  async function reserveRootPolicy(tx: DbTransaction, companyId: string, cwd: string, mode: "anonymous_only" | "managed") {
    const canonicalCwd = await canonicalRepositoryRoot(cwd);
    const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
    const reservations = await tx.select().from(executionWorkspaceRepositoryRoots)
      .where(eq(executionWorkspaceRepositoryRoots.companyId, companyId));
    const existing = reservations.find(entry => entry.rootKey === rootKey);
    const overlapping = reservations.filter(entry => repositoryRootsOverlap(entry.canonicalCwd, canonicalCwd));
    if ((existing && existing.canonicalCwd !== canonicalCwd)
      || overlapping.some(entry => entry.mode !== mode || createHash("sha256").update(entry.canonicalCwd).digest("hex") !== entry.rootKey)) {
      throw forbidden(lowTrustRepositoryMessage);
    }
    if (mode === "anonymous_only") {
      const managed = await tx.select({ cwd: executionWorkspaces.cwd, repositoryIdentity: executionWorkspaceRepositories.repositoryIdentity }).from(executionWorkspaceRepositories)
        .innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
        .where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaces.companyId, companyId),
          isNotNull(executionWorkspaceRepositories.catalogRepositoryId)));
      if (managed.length) {
        const namespace = path.join(canonicalCwd, ".paperclip-repositories");
        const namespaceEntry = await fs.lstat(namespace).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (namespaceEntry) {
          if (!namespaceEntry.isDirectory() || namespaceEntry.isSymbolicLink() || await fs.realpath(namespace) !== namespace) {
            throw forbidden(lowTrustRepositoryMessage);
          }
          for (const identity of new Set(managed.map(peer => peer.repositoryIdentity))) {
            const entry = await fs.lstat(path.join(canonicalCwd, taskRepositoryRelativePath(identity))).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (entry) throw forbidden(lowTrustRepositoryMessage);
          }
        }
      }
      for (const peer of managed) {
        if (peer.cwd && await legacyRepositoryRootMayMatch(peer.cwd, canonicalCwd)) throw forbidden(lowTrustRepositoryMessage);
      }
    }
    if (!existing) await tx.insert(executionWorkspaceRepositoryRoots).values({ companyId, canonicalCwd, rootKey, mode });
    return canonicalCwd;
  }
  type RootReader = { runId: string; issueId: string; agentId: string };
  async function authorizeRootAccess(tx: DbTransaction, input: {
    companyId: string; cwd: string; sourceWorkspaceId?: string; reader?: RootReader; actor?: AuthorizationActor; issueId?: string; preserveOwnAdmission?: boolean;
  }) {
    const { canonicalCwd, rootKey, entries, overlappingEntries, sourceIds, sharedSourceIds, isolatedSourceIds, sourceProjectIds, sharedProjectIds, isolatedProjectIds } = await resolveRepositoryRootSources(tx, input);
    const readers = overlappingEntries.filter(entry => entry.kind === "reader");
    if (input.reader && !entries.some(entry => entry.kind === "reader" && entry.scopeId === input.reader!.runId)) {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.reader.runId), eq(heartbeatRuns.companyId, input.companyId)));
      readers.push({ id: randomUUID(), companyId: input.companyId, rootKey, canonicalCwd, kind: "reader", scopeId: input.reader.runId,
        issueId: input.reader.issueId, agentId: input.reader.agentId, responsibleUserId: run?.responsibleUserId ?? null, createdAt: new Date(), updatedAt: new Date() });
    }
    const ownAdmissionOnly = input.preserveOwnAdmission && input.reader && input.sourceWorkspaceId
      && sourceIds.size === 1 && sourceIds.has(input.sourceWorkspaceId)
      && readers.every(reader => reader.issueId === input.reader!.issueId);
    const sourceProjects = sourceIds.size ? await tx.selectDistinct({ projectId: executionWorkspaces.projectId }).from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, input.companyId), inArray(executionWorkspaces.id, [...sourceIds]))) : [];
    const sourceActors: AuthorizationActor[] = [];
    for (const reader of readers) {
      const { actor, issue } = await retainedRootReader(tx, input.companyId, reader);
      await assertRootProjectTrust(tx, { companyId: input.companyId, projectIds: sourceProjectIds, actor, issueId: issue.id,
        sourceWorkspaceId: input.reader?.runId === reader.scopeId ? input.sourceWorkspaceId : undefined });
      await assertRootProjectAccess(tx, actor, input.companyId, sourceProjectIds,
        input.reader?.runId === reader.scopeId ? { sharedProjectIds, issueId: issue.id } : undefined);
      if (ownAdmissionOnly) {
        const [ownSource] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
          eq(executionWorkspaces.companyId, input.companyId), eq(executionWorkspaces.id, input.sourceWorkspaceId!),
          await executionWorkspaceReadSqlCondition(tx, { ...actor, onBehalfOfUserId: null }),
          actor.onBehalfOfUserId ? await executionWorkspaceReadSqlCondition(tx, {
            type: "board", userId: actor.onBehalfOfUserId, ignoreInstanceAdmin: true,
          }) : undefined));
        if (!ownSource) throw forbidden("Task workspace access is no longer available");
      } else sourceActors.push(actor);
      for (const sourceWorkspace of sourceProjects.length ? sourceProjects : [null]) {
        if (await requiresAnonymousAcquisition(tx, { issue, workspace: sourceWorkspace, agentId: reader.agentId!, runId: reader.scopeId })) {
          await reserveRootPolicy(tx, input.companyId, canonicalCwd, "anonymous_only");
        }
      }
    }
    if (input.actor) {
      if (!input.issueId) throw forbidden("Workspace write authorization requires a task");
      await assertRootProjectTrust(tx, { ...input, projectIds: sourceProjectIds, actor: input.actor });
      await assertRootProjectAccess(tx, input.actor, input.companyId, sourceProjectIds, { sharedProjectIds, issueId: input.issueId });
      sourceActors.push(input.actor);
    }
    await assertTaskWorkspacesReadAccessForActors(tx, sourceActors, input.companyId, sourceIds);
    for (const [kind, ids] of [["source", sharedSourceIds], ["isolated_source", isolatedSourceIds], ["project_source", sourceProjectIds],
      ["shared_project_source", sharedProjectIds], ["isolated_project_source", isolatedProjectIds]] as const) {
      for (const scopeId of ids) {
        if (!entries.some(entry => entry.kind === kind && entry.scopeId === scopeId)) {
          await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, rootKey, canonicalCwd, kind, scopeId });
        }
      }
    }
    for (const reader of readers) {
      if (reader.rootKey === rootKey && !entries.some(entry => entry.kind === "reader" && entry.scopeId === reader.scopeId)) {
        await tx.insert(executionWorkspaceRepositoryAccess).values(reader);
      }
    }
  }
  async function reserveRootAccess(input: Parameters<typeof authorizeRootAccess>[1]) {
    return db.transaction(async tx => {
      await lockExecutionWorkspaceRootProvenance(tx, input.companyId);
      await authorizeRootAccess(tx, input);
    });
  }
  async function reserveAdmissionRoot(companyId: string, cwd: string, mode: "anonymous_only" | "managed") {
    return db.transaction(async tx => {
      await lockExecutionWorkspaceRootProvenance(tx, companyId);
      return reserveRootPolicy(tx, companyId, cwd, mode);
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
    const receipt = await db.transaction(async tx => {
      await lockExecutionWorkspaceRootProvenance(tx, input.companyId);
      const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId), await issueReadSqlCondition(tx, input.actor))).for("no key update");
      if (!issue) throw notFound("Task not found");
      const currentDecision = await authorizationService(tx).decide({ actor: input.actor, action: "issue:mutate", resource: issueResource(issue) });
      if (!currentDecision.allowed) throw forbidden("Task workspace modification is not allowed");
      if (input.actor.type === "agent" && !["standard", "skill_test"].includes(issue.workMode)) throw forbidden("Repository preparation is unavailable in Ask or Plan mode");
      if (!issue.executionWorkspaceId) throw conflict("The task has no admitted workspace yet. Start it once before preparing a repository.");
      if (!(await canActorReadExecutionWorkspace(db, input.actor, issue.executionWorkspaceId))) throw notFound("Execution workspace not found");
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, issue.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId), taskWorkspaceSelectableCondition())).for("no key update");
      if (!workspace) throw conflict("Execution workspace is unavailable");
      await assertTaskWorkspaceAccess(tx, input.actor, input.companyId, workspace.id, { write: true, issueId: input.issueId });
      const anonymousOnly = await requiresAnonymousAcquisition(tx, { issue, workspace,
        agentId: input.actor.agentId, runId: input.actor.runId });
      const source = resolveAcquisitionSource(parsed.repository, available, anonymousOnly);
      if (anonymousOnly || source.catalogRepositoryId) {
        if (!workspace.cwd) throw conflict("The task workspace has no directory for repository preparation");
        await reserveRootPolicy(tx, input.companyId, workspace.cwd, anonymousOnly ? "anonymous_only" : "managed");
      }
      if (!workspace.cwd) throw conflict("The task workspace has no directory for repository preparation");
      await authorizeRootAccess(tx, { companyId: input.companyId, cwd: workspace.cwd, sourceWorkspaceId: workspace.id, actor: input.actor, issueId: input.issueId });
      if (anonymousOnly) throw forbidden(controllerAcquisitionMessage);
      const existing = await tx.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.executionWorkspaceId, workspace.id), or(eq(executionWorkspaceRepositories.repositoryIdentity, source.repositoryIdentity), sql`${executionWorkspaceRepositories.requestKeys} ? ${parsed.requestKey}`)));
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
      const [row] = await tx.insert(executionWorkspaceRepositories).values({ companyId: input.companyId, executionWorkspaceId: workspace.id, requestedByIssueId: input.issueId, ...source, relativePath: taskRepositoryRelativePath(source.repositoryIdentity), requestedRef, requestKey: parsed.requestKey, requestKeys: [parsed.requestKey] }).returning();
      const canonicalCwd = await canonicalRepositoryRoot(workspace.cwd);
      await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId,
        rootKey: createHash("sha256").update(canonicalCwd).digest("hex"), canonicalCwd, kind: "repository", scopeId: row.id });
      await tx.insert(activityLog).values({ companyId: input.companyId, actorType: input.actor.type === "agent" ? "agent" : "user", actorId: input.actor.agentId ?? input.actor.userId ?? "local-board", action: "workspace.repository.requested", entityType: "execution_workspace", entityId: workspace.id, runId: input.actor.runId ?? null, responsibleUserId: userId, details: { repositoryId: row.id, issueId: input.issueId, applies: "next_normal_admission" } });
      return row;
    });
    return { kind: "requires_next_admission" as const, applies: "next_normal_admission" as const, operationId: receipt.id, repository: receipt, reason: "immutable_admitted_workspace" };
  }
  async function list(companyId: string, workspaceId: string) {
    return db.select().from(executionWorkspaceRepositories).where(and(eq(executionWorkspaceRepositories.companyId, companyId), eq(executionWorkspaceRepositories.executionWorkspaceId, workspaceId)));
  }
  type PublicationInput = { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string };
  async function publicationBinding(tx: DbTransaction, input: PublicationInput) {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id || !workspace.cwd
      || await canonicalRepositoryRoot(workspace.cwd) !== await canonicalRepositoryRoot(input.cwd)) {
      throw forbidden("Task repository publication binding is unavailable");
    }
    await requiresAnonymousAcquisition(tx, { issue, workspace, agentId: input.agentId, runId: input.runId });
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
    const { actor } = await retainedRootReader(tx, input.companyId, {
      scopeId: input.runId, issueId: input.issueId, agentId: input.agentId, responsibleUserId: run?.responsibleUserId ?? null,
    });
    return { workspace, actor };
  }
  async function guardForPublication(input: PublicationInput) {
    await db.transaction(async tx => {
      await lockExecutionWorkspaceRootProvenance(tx, input.companyId);
      const { workspace } = await publicationBinding(tx, input);
      await authorizeRootAccess(tx, { companyId: input.companyId, cwd: input.cwd, sourceWorkspaceId: workspace.id, reader: input });
    });
  }
  async function prepareConfiguredRepositorySource(input: PublicationInput & { sourceCwd: string }): Promise<() => Promise<void>> {
    const roots = new Set<string>(), workspaceIds = new Set<string>(), projectIds = new Set<string>();
    const retain = async () => {
      let sourceFailure: unknown;
      let commonRoot: string | undefined;
      try {
        roots.add(await fs.realpath(input.sourceCwd));
        const source = await isolatedWorkspaceSourceRoots(db, input.companyId, input.sourceCwd, "repository");
        commonRoot = source.commonRoot;
        for (const cwd of source.roots) roots.add(cwd);
      } catch (error) { sourceFailure = error; }
      const denied = await db.transaction(async tx => {
        await lockExecutionWorkspaceRootProvenance(tx, input.companyId);
        const { workspace, actor } = await publicationBinding(tx, input);
        const canonicalCwd = await canonicalRepositoryRoot(input.cwd);
        const rootKey = createHash("sha256").update(canonicalCwd).digest("hex");
        const existing = await tx.select().from(executionWorkspaceRepositoryAccess).where(and(
          eq(executionWorkspaceRepositoryAccess.companyId, input.companyId), eq(executionWorkspaceRepositoryAccess.rootKey, rootKey)));
        if (existing.some(entry => entry.canonicalCwd !== canonicalCwd)) throw forbidden("Repository root identity conflicts with its retained access record");
        let failure = sourceFailure;
        for (const cwd of roots) {
          try {
            const source = await resolveRepositoryRootSources(tx, { companyId: input.companyId, cwd });
            for (const id of source.sourceIds) workspaceIds.add(id);
            for (const id of source.sourceProjectIds) projectIds.add(id);
          } catch (error) { failure ??= error; }
        }
        try { await assertTaskWorkspacesReadAccess(tx, actor, input.companyId, workspaceIds); }
        catch (error) { failure ??= error; }
        for (const id of projectIds) {
          try { await assertRootProjectAccess(tx, actor, input.companyId, new Set([id])); }
          catch (error) { failure ??= error; }
        }
        for (const [kind, ids] of [["isolated_source", workspaceIds], ["isolated_project_source", projectIds]] as const) {
          for (const scopeId of ids) if (!existing.some(entry => entry.kind === kind && entry.scopeId === scopeId)) {
            await tx.insert(executionWorkspaceRepositoryAccess).values({ companyId: input.companyId, rootKey, canonicalCwd, kind, scopeId });
          }
        }
        try {
          await authorizeRootAccess(tx, { companyId: input.companyId, cwd: input.cwd, sourceWorkspaceId: workspace.id,
            actor, issueId: input.issueId });
        } catch (error) { failure ??= error; }
        if (!failure && commonRoot) {
          try { await retainGitMetadataOwners(tx, { companyId: input.companyId, commonRoot, workspaceIds, projectIds }); }
          catch (error) { failure ??= error; }
        }
        return failure;
      });
      if (denied) throw denied;
    };
    await retain();
    return retain;
  }
  async function reserveForRecovery(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string }) {
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    if (!issue) throw forbidden("Task repository recovery identity is unavailable");
    if (!workspace) {
      const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
      let execution;
      try { execution = parseNativeExecutionInput(run?.runnerProfileJson?.nativeExecutionInput); } catch {   }
      const binding = execution?.binding;
      if (input.workspaceId !== input.runId || run?.runtimeMode !== "native" || !binding
        || binding.companyId !== input.companyId || binding.runId !== input.runId
        || binding.agentId !== input.agentId || binding.issueId !== input.issueId
        || binding.executionWorkspaceId !== input.runId) {
        throw forbidden("Task repository recovery identity is unavailable");
      }
    }
    const anonymousOnly = await requiresAnonymousAcquisition(db, { issue, workspace: workspace ?? null, agentId: input.agentId, runId: input.runId });
    if (anonymousOnly) await reserveAdmissionRoot(input.companyId, input.cwd, "anonymous_only");
    else if ((await list(input.companyId, input.workspaceId)).some(row => row.catalogRepositoryId)) {
      await reserveAdmissionRoot(input.companyId, input.cwd, "managed");
    }
    await reserveRootAccess({ companyId: input.companyId, cwd: input.cwd, reader: input,
      ...(workspace ? { sourceWorkspaceId: workspace.id } : {}),
      preserveOwnAdmission: !(await list(input.companyId, input.workspaceId)).length });
  }
  async function sharedPublicationPin(input: { issueId: string; row: RepositoryRow; root: string; actor: AuthorizationActor; anonymousOnly: boolean; ownership: { repositoryId?: string; pinnedCommit?: string } | null }) {
    const candidates = await db.select({ repository: executionWorkspaceRepositories, workspace: executionWorkspaces })
      .from(executionWorkspaceRepositories).innerJoin(executionWorkspaces, eq(executionWorkspaces.id, executionWorkspaceRepositories.executionWorkspaceId))
      .where(and(eq(executionWorkspaceRepositories.companyId, input.row.companyId), eq(executionWorkspaces.companyId, input.row.companyId),
        eq(executionWorkspaceRepositories.repositoryIdentity, input.row.repositoryIdentity), eq(executionWorkspaceRepositories.relativePath, input.row.relativePath)));
    let pin = input.row.pinnedCommit;
    for (const { repository, workspace } of candidates) {
      if (repository.id === input.row.id || !workspace.cwd) continue;
      const candidatePin = repository.pinnedCommit ?? (input.ownership?.repositoryId === repository.id ? input.ownership.pinnedCommit : null);
      if (!candidatePin || !/^[a-f0-9]{40,64}$/.test(candidatePin)) continue;
      if (await fs.realpath(workspace.cwd).catch(() => null) !== input.root) continue;
      assertAcquisitionReceipt(repository, input.anonymousOnly);
      assertRepositoryRetryMatches(repository, input.row.repositoryIdentity, input.row.requestedRef);
      if (!(await canActorReadExecutionWorkspace(db, input.actor, workspace.id))) throw forbidden("The shared repository retains files from a workspace outside this actor's access");
      await assertTaskWorkspaceAccess(db, input.actor, input.row.companyId, workspace.id, { write: true, issueId: input.issueId });
      if (pin && pin !== candidatePin) throw conflict("Shared repository publication receipts disagree; repair is required before reuse");
      pin = candidatePin;
    }
    return pin;
  }
  async function prepareForAdmission(input: { companyId: string; issueId: string; workspaceId: string; cwd: string; agentId: string; runId: string; responsibleUserId: string | null }) {
    const rows = await list(input.companyId, input.workspaceId);
    const actor: AuthorizationActor = { type: "agent", source: "agent_jwt", companyId: input.companyId,
      agentId: input.agentId, runId: input.runId,
      onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId };
    const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, input.workspaceId), eq(executionWorkspaces.companyId, input.companyId)));
    if (!issue || !workspace || issue.executionWorkspaceId !== workspace.id) throw forbidden("Task repository workspace binding is unavailable");
    const anonymousOnly = await requiresAnonymousAcquisition(db, { issue, workspace: workspace ?? null, agentId: input.agentId, runId: input.runId });
    if (!rows.length) {
      if (anonymousOnly) await reserveAdmissionRoot(input.companyId, input.cwd, "anonymous_only");
      await reserveRootAccess({ companyId: input.companyId, cwd: input.cwd, reader: input,
        sourceWorkspaceId: workspace.id, preserveOwnAdmission: true });
      return [];
    }
    const acquisitionRestricted = anonymousOnly;
    if (acquisitionRestricted && rows.some(row => row.state !== "ready" || !row.pinnedCommit || !/^[a-f0-9]{40,64}$/.test(row.pinnedCommit))) {
      throw forbidden(controllerAcquisitionMessage);
    }
    await assertTaskWorkspaceAccess(db, actor, input.companyId, input.workspaceId, { write: true, issueId: input.issueId });
    const root = await fs.realpath(input.cwd);
    const available = acquisitionRestricted ? [] : await catalog(input.companyId, input.responsibleUserId, input.responsibleUserId === "local-board");
    const resolveAuth = createGitRemoteAuthProvider(db, input.companyId, { issueId: input.issueId, heartbeatRunId: input.runId, agentId: input.agentId, responsibleUserId: input.responsibleUserId });
    const sources = rows.map(row => {
      assertAcquisitionReceipt(row, anonymousOnly);
      return resolveAcquisitionSource(row.catalogRepositoryId ? { kind: "catalog", id: row.catalogRepositoryId } : { kind: "url", url: row.repoUrl }, available, anonymousOnly);
    });
    if (anonymousOnly || sources.some(source => source.catalogRepositoryId)) {
      const reservedRoot = await reserveAdmissionRoot(input.companyId, root, anonymousOnly ? "anonymous_only" : "managed");
      if (reservedRoot !== root) throw conflict("Repository workspace root changed during admission");
    }
    await reserveRootAccess({ companyId: input.companyId, cwd: root, sourceWorkspaceId: input.workspaceId, reader: input });
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
      await ensureManagedRepositoriesIgnored(root);
    }
    const prepared: Array<{ id: string; cwd: string; repoUrl: string; relativePath: string; pinnedCommit: string; branchName: string | null }> = [];
    for (const [index, row] of rows.entries()) {
      const source = sources[index];
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
        if (acquisitionRestricted && !existing) throw forbidden(controllerAcquisitionMessage);
        const anonymous = buildGitAuthInvocation({ token: "", source: "managed_connection", secretName: null });
        anonymous.env = { ...anonymous.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
        if (!acquisitionRestricted) await db.update(executionWorkspaceRepositories).set({ state: "preparing", catalogRepositoryId: source.catalogRepositoryId, failureCode: null, updatedAt: new Date() }).where(eq(executionWorkspaceRepositories.id, row.id));
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
          const authorizedPin = await sharedPublicationPin({ issueId: input.issueId, row, root, actor, anonymousOnly, ownership: initialOwnership });
          if (existing && !authorizedPin && initialOwnership?.repositoryId !== row.id) {
            throw conflict("Repository directory has no matching preparation receipt; repair it before retrying");
          }
          if (!acquisitionRestricted) {
            await assertCurrentControllerAcquisition(input);
            const result = await materializeManagedProjectWorkspace(cwd, {
              repoUrl: source.repoUrl,
              stagingParent,
              repoRef: authorizedPin ?? (row.requestedRef === "HEAD" ? null : row.requestedRef),
              resolveGitAuth: source.catalogRepositoryId ? resolveAuth : async () => anonymous,
              beforePublish: async cloneCwd => {
                await assertCurrentControllerAcquisition(input);
                await reserveRootAccess({ companyId: input.companyId, cwd: root, sourceWorkspaceId: input.workspaceId, reader: input });
                const pinnedCommit = (await execFile("git", ["-C", cloneCwd, "rev-parse", "HEAD"], { timeout: 30_000 })).stdout.trim();
                await fs.writeFile(path.join(cloneCwd, ".git", "paperclip-workspace-owner.json"), JSON.stringify({ version: 1, repositoryId: row.id, pinnedCommit }), { flag: "wx", mode: 0o600 });
              },
            });
            if (result.warning) throw conflict(result.warning);
          }
          const git = async (...args: string[]) => (await execFile("git", ["-C", cwd, ...args], { timeout: 30_000, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } })).stdout.trim();
          const origin = normalizeProjectRepositoryUrl(await git("remote", "get-url", "origin"));
          if (origin.url.toLowerCase() !== row.repositoryIdentity) throw conflict("Repository checkout belongs to a different origin");
          const ownership = await readOwnership();
          if (!authorizedPin && (ownership?.repositoryId !== row.id || !/^[a-f0-9]{40,64}$/.test(ownership.pinnedCommit))) throw conflict("Repository publication has no valid preparation receipt");
          const pinnedCommit: string = authorizedPin ?? ownership.pinnedCommit;
          if (acquisitionRestricted) await git("cat-file", "-e", `${pinnedCommit}^{commit}`);
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
  return { request, list, prepareForAdmission, reserveForRecovery, guardForPublication, prepareConfiguredRepositorySource };
}
