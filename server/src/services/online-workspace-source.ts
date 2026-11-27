import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { explainOnlineOrdinarySource, inspectImportedWorkspaceSourcePaths, physicalPath, requiresOnlineOrdinarySource, type WorkspaceSourceScope } from "./remote-workspace-migration-tree.js";
import { workspaceSourceIdentities } from "./workspace-source-lock.js";
import { WORKSPACE_SOURCE_KEY_LIMIT } from "./workspace-source-key-limit.js";
import { readNestedWorkspaceGitSourceRoots, readWorkspaceGitLinkedRoots, readWorkspaceGitSourceRoots, type WorkspaceGitSourceRoots } from "./workspace-git-source-roots.js";
import { inspectOnlineLegacyWorkspaceRecoveryHold, inspectOnlineLegacyWorkspaceRecoverySource, type OnlineLegacyWorkspaceRecoveryHold } from "./online-legacy-workspace-recovery.js";
import type { LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { hasPendingGitExpiration } from "./git-workspace-expiration.js";
import { readGitCacheRestoration } from "./git-workspace-restoration.js";
import { localWorkspaceSourcePaths } from "./execution-workspace-source-roots.js";

type Workspace = typeof executionWorkspaces.$inferSelect;
type ReadDb = Pick<Db, "select">;
type Identities = Awaited<ReturnType<typeof workspaceSourceIdentities>>;
export type OnlineWorkspaceSource = WorkspaceSourceScope & {
  kind: "ordinary" | "git"; projectIds: string[];
  gitSourceFingerprints?: Array<{ workspaceId: string; fingerprint: string | null }>;
  importedChildren?: Array<Awaited<ReturnType<typeof inspectImportedWorkspaceSourcePaths>>[number] & { gitFingerprint: string | null }>;
  companions: Array<{ workspaceId: string; sources: LegacyWorkspaceRecoverySource[];
    holds: Array<OnlineLegacyWorkspaceRecoveryHold & { actionId: string }> }>;
};
const intersects = (values: string[], keys: Set<string>) => values.some(value => keys.has(value));
type CompanionRun = { id: string; issueId: string | null; state: string };

export async function requiresOnlineWorkspaceSource(workspace: Workspace): Promise<boolean> {
  if (await requiresOnlineOrdinarySource(workspace)) return true;
  if (!["local_fs", "git_worktree"].includes(workspace.providerType)) return false;
  for (const cwd of localWorkspaceSourcePaths(workspace)) {
    if (!path.isAbsolute(cwd)) continue;
    const root = await physicalPath(cwd);
    const entry = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
    if (workspace.repoUrl || workspace.branchName || workspace.strategyType === "git_worktree"
      || await fs.lstat(path.join(root, ".git")).then(() => true,
        (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; })) return true;
  }
  return false;
}

async function companion(db: ReadDb, workspace: Workspace, runs: CompanionRun[]) {
  const sources: LegacyWorkspaceRecoverySource[] = [];
  for (const run of runs.filter(run => run.state === "prepared")) {
    const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace, runId: run.id });
    if (!source) return "companion_copyback_unresolved";
    sources.push(source);
  }
  const issueIds = [...new Set([workspace.sourceIssueId, ...runs.map(run => run.issueId)].filter((id): id is string => Boolean(id)))];
  const actions = issueIds.length ? await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, workspace.companyId), inArray(issueRecoveryActions.sourceIssueId, issueIds),
    inArray(issueRecoveryActions.status, ["active", "escalated"]),
  )).orderBy(issueRecoveryActions.id) : [];
  const holds: Array<OnlineLegacyWorkspaceRecoveryHold & { actionId: string }> = [];
  for (const recovery of actions) {
    const hold = await inspectOnlineLegacyWorkspaceRecoveryHold(db, { workspace, recovery });
    if (!hold) return "companion_recovery_unresolved";
    holds.push({ actionId: recovery.id, ...hold });
  }
  return { workspaceId: workspace.id, sources, holds, recoveryIssueIds: issueIds };
}

export async function inspectOnlineWorkspaceSource(db: ReadDb, workspace: Workspace): Promise<OnlineWorkspaceSource | null> {
  const result = await explainOnlineWorkspaceSource(db, workspace);
  return "unproven" in result ? null : result;
}

function gitLinkUnproven(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return message === "workspace_git_link_stale" ? "git_link_stale" : message === "workspace_git_links_exceeded" ? "git_links_exceeded" : "git_links_unreadable";
}

function memberUnproven(row: Workspace) {
  if (!row.sourceIssueId) return "member_task_binding_missing";
  if (row.cwd && row.providerRef && row.cwd !== row.providerRef) return "member_locator_mismatch";
  if (!["active", "idle", "in_review", "archived"].includes(row.status)) return "member_status_unsupported";
  if (row.metadata?.remoteWorkspace) return "member_already_remote";
  if (hasPendingGitExpiration(row)) return "member_git_expiration_pending";
  return null;
}

export async function explainOnlineWorkspaceSource(db: ReadDb, workspace: Workspace): Promise<OnlineWorkspaceSource | { unproven: string }> {
  const unproven = (code: string) => ({ unproven: code });
  const cwd = workspace.cwd ?? workspace.providerRef;
  if (!cwd || !path.isAbsolute(cwd) || !["local_fs", "git_worktree"].includes(workspace.providerType)) return unproven("locator_unsupported");
  const explained = await explainOnlineOrdinarySource(db, workspace);
  const ordinary = explained && !("unproven" in explained) ? explained : null;
  const ordinaryUnproven = explained && "unproven" in explained ? explained.unproven : null;
  let nestedGit: WorkspaceGitSourceRoots[] = [];
  if (ordinary) {
    const marker = await fs.lstat(path.join(ordinary.root, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    if (!marker) {
      try { nestedGit = await readNestedWorkspaceGitSourceRoots(ordinary.root); } catch { return unproven("nested_git_unreadable"); }
      if (!nestedGit.length) return { ...ordinary, kind: "ordinary", projectIds: ordinary.projectId ? [ordinary.projectId] : [], companions: [] };
    }
  }
  let selected: Identities;
  try {
    selected = nestedGit.length && ordinary ? { projectIds: ordinary.projectId ? [ordinary.projectId] : [],
      issueIds: [...ordinary.issueIds], unownedPaths: [], git: null } : await workspaceSourceIdentities(workspace.companyId, cwd);
    for (const source of nestedGit) {
      const nested = await workspaceSourceIdentities(workspace.companyId, source.root);
      if (!nested.git || nested.git.fingerprint !== source.fingerprint) return unproven("nested_git_changed");
      selected.projectIds = [...new Set([...selected.projectIds, ...nested.projectIds])].sort();
      selected.issueIds = [...new Set([...selected.issueIds, ...nested.issueIds])].sort();
      selected.unownedPaths = [...new Set([...selected.unownedPaths, ...nested.unownedPaths])].sort();
    }
  } catch { return unproven("git_identity_unreadable"); }
  const captureRoot = await physicalPath(cwd), gitSources = selected.git ? [selected.git] : nestedGit;
  if (!gitSources.length) {
    if (ordinaryUnproven) return unproven(ordinaryUnproven);
    const marker = await fs.lstat(path.join(captureRoot, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    return unproven(marker ? "git_marker_not_repository" : "git_checkout_missing");
  }
  if (selected.git && selected.git.root !== captureRoot) return unproven("git_root_mismatch");
  if (selected.unownedPaths.length) return unproven("unowned_path");
  if (!workspace.sourceIssueId) return unproven("task_binding_missing");
  if (workspace.cwd && workspace.providerRef && workspace.cwd !== workspace.providerRef) return unproven("locator_mismatch");
  for (const source of gitSources) {
    const head = await fs.lstat(path.join(source.gitDirectory.path, "HEAD")).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error; return null;
    });
    if (!head || !head.isFile() && !head.isSymbolicLink()) return unproven("git_head_missing");
  }
  const linkedSources = new Map<string, Awaited<ReturnType<typeof readWorkspaceGitLinkedRoots>>[number]>();
  try {
    for (const source of gitSources) {
      for (const proof of await readWorkspaceGitLinkedRoots(source)) {
        const existing = linkedSources.get(proof.commonDirectory.path);
        if (existing && JSON.stringify(existing) !== JSON.stringify(proof)) return unproven("git_links_conflict");
        linkedSources.set(proof.commonDirectory.path, proof);
      }
    }
    for (const proof of linkedSources.values()) {
      for (const link of proof.links) {
        const linked = await workspaceSourceIdentities(workspace.companyId, link.root.path);
        if (!linked.git || linked.git.gitDirectory.path !== link.gitDirectory.path) return unproven("git_link_changed");
        selected.projectIds = [...new Set([...selected.projectIds, ...linked.projectIds])].sort();
        selected.issueIds = [...new Set([...selected.issueIds, ...linked.issueIds])].sort();
        selected.unownedPaths = [...new Set([...selected.unownedPaths, ...linked.unownedPaths])].sort();
      }
    }
  } catch (error) { return unproven(gitLinkUnproven(error)); }
  if (selected.unownedPaths.length) return unproven("unowned_path");
  const selectedFingerprint = createHash("sha256").update(JSON.stringify([gitSources, [...linkedSources.values()]])).digest("hex");
  const entry = await fs.lstat(cwd);
  const rows = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, workspace.companyId),
    inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]))).orderBy(executionWorkspaces.id).limit(1001);
  if (rows.length > 1000) return unproven("company_records_exceeded");
  const nodes: Array<{ row: Workspace; identities: Identities; fingerprint: string | null }> = [];
  for (const row of rows) {
    const paths = localWorkspaceSourcePaths(row);
    if (!paths.length || paths.some(cwd => !path.isAbsolute(cwd))) return unproven("member_locator_invalid");
    try {
      const identities = paths[0] === captureRoot ? { ...selected, projectIds: [...selected.projectIds], issueIds: [...selected.issueIds] }
        : await workspaceSourceIdentities(workspace.companyId, paths[0]);
      for (const cwd of paths.slice(1)) {
        const alternate = await workspaceSourceIdentities(workspace.companyId, cwd);
        identities.projectIds = [...new Set([...identities.projectIds, ...alternate.projectIds])].sort();
        identities.issueIds = [...new Set([...identities.issueIds, ...alternate.issueIds])].sort();
      }
      nodes.push({ row, identities, fingerprint: paths[0] === captureRoot ? selectedFingerprint : identities.git?.fingerprint ?? null });
    } catch { return unproven("member_unreadable"); }
  }
  const projectIds = new Set(selected.projectIds), physicalIssueIds = new Set(selected.issueIds), aliases = new Set<string>();
  const importedChildren: NonNullable<OnlineWorkspaceSource["importedChildren"]> = [];
  try {
    for (const child of await inspectImportedWorkspaceSourcePaths(db, workspace,
      [...linkedSources.values()].flatMap(proof => proof.links.map(link => link.root.path)))) {
      const identities = await workspaceSourceIdentities(workspace.companyId, child.sourcePath);
      if (identities.unownedPaths.length) return unproven("imported_child_unowned");
      for (const id of identities.projectIds) projectIds.add(id);
      for (const id of identities.issueIds) physicalIssueIds.add(id);
      importedChildren.push({ ...child, gitFingerprint: identities.git?.fingerprint ?? null });
    }
  } catch { return unproven("imported_child_unreadable"); }
  for (;;) {
    let changed = false;
    for (const node of nodes) {
      if (aliases.has(node.row.id)) continue;
      if (node.row.id !== workspace.id && !intersects(node.identities.projectIds, projectIds)
        && !intersects(node.identities.issueIds, physicalIssueIds)
        && !(node.row.projectId && projectIds.has(node.row.projectId))
        && !(node.row.sourceIssueId && physicalIssueIds.has(node.row.sourceIssueId))) continue;
      const member = memberUnproven(node.row);
      if (member) return unproven(member);
      aliases.add(node.row.id); changed = true;
      for (const id of node.identities.projectIds) projectIds.add(id);
      for (const id of node.identities.issueIds) physicalIssueIds.add(id);
      if (node.row.projectId) projectIds.add(node.row.projectId);
    }
    if (!changed) break;
  }
  if (!aliases.has(workspace.id)) return unproven("self_excluded");
  if (aliases.size > 256) return unproven("members_exceeded");
  const included = nodes.filter(node => aliases.has(node.row.id));
  const registeredRoots = await Promise.all([...included.flatMap(node => localWorkspaceSourcePaths(node.row)),
    ...importedChildren.map(child => child.sourcePath)].map(physicalPath));
  if ([...linkedSources.values()].some(proof => proof.links.some(link => !registeredRoots.some(root =>
    link.root.path === root || link.root.path.startsWith(root + path.sep))))) return unproven("git_link_unregistered");
  const issueIds = [...new Set([...physicalIssueIds, ...included.map(node => node.row.sourceIssueId!)])].sort();
  if (issueIds.length + projectIds.size > WORKSPACE_SOURCE_KEY_LIMIT) return unproven("source_keys_exceeded");
  const instance = await physicalPath(resolvePaperclipInstanceRoot());
  const gitSourceRoots = [...[...projectIds].map(id => path.join(instance, "projects", workspace.companyId, id)),
    ...issueIds.flatMap(id => ["isolated-workspaces", "isolated-workspace-attempts", "isolated-repository-sources"].map(kind =>
      path.join(instance, kind, workspace.companyId, id, ...(kind === "isolated-repository-sources" ? ["checkout"] : []))))].sort();
  const owned = (target: string) => gitSourceRoots.some(root => target === root || target.startsWith(root + path.sep));
  let after: string | undefined;
  for (let page = 0; ; page++) {
    const foreign = await db.select({ id: executionWorkspaces.id, cwd: executionWorkspaces.cwd, providerRef: executionWorkspaces.providerRef })
      .from(executionWorkspaces).where(and(ne(executionWorkspaces.companyId, workspace.companyId),
        inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]), ...(after ? [gt(executionWorkspaces.id, after)] : [])))
      .orderBy(executionWorkspaces.id).limit(256);
    for (const row of foreign) {
      for (const cwd of localWorkspaceSourcePaths(row)) {
        if (!path.isAbsolute(cwd)) return unproven("foreign_locator_invalid");
        try {
          if (owned(await physicalPath(cwd))) return unproven("foreign_alias");
          const git = await readWorkspaceGitSourceRoots(cwd, { ancestors: true });
          if (git && [git.gitDirectory.path, git.commonDirectory.path, ...git.objectDirectories.map(root => root.path)].some(owned)) return unproven("foreign_git_alias");
        } catch { return unproven("foreign_unreadable"); }
      }
    }
    if (foreign.length < 256) break;
    if (page === 39) return unproven("foreign_records_exceeded");
    after = foreign.at(-1)!.id;
  }
  const recipe = readGitCacheRestoration(workspace);
  if (recipe && (!recipe.restoredAt || recipe.contents && !recipe.contentsRestoredAt
    || recipe.restorePoint && !recipe.restorePoint.expiredAt && !recipe.restorePoint.appliedAt)) return unproven("git_restoration_pending");
  const runs = await db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.nativeIssueId,
    workspaceId: sql<string>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId'`,
    state: sql<string>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state'` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, workspace.companyId),
    inArray(sql<string>`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'workspaceId'`, included.map(node => node.row.id)),
    sql`${heartbeatRuns.runnerProfileJson}->'nativeWorkspaceSync'->>'state' in ('prepared','finalized')`,
  )).orderBy(heartbeatRuns.id);
  const runsByWorkspace = new Map<string, CompanionRun[]>();
  for (const run of runs) {
    const group = runsByWorkspace.get(run.workspaceId) ?? [];
    group.push(run);
    runsByWorkspace.set(run.workspaceId, group);
  }
  const companions: OnlineWorkspaceSource["companions"] = [], settledPreparedWorkspaceIds: string[] = [], settledRecoveryIssueIds = new Set<string>();
  for (const node of included) {
    const proof = await companion(db, node.row, runsByWorkspace.get(node.row.id) ?? []);
    if (typeof proof === "string") return unproven(proof);
    companions.push({ workspaceId: proof.workspaceId, sources: proof.sources, holds: proof.holds });
    if (proof.sources.length) settledPreparedWorkspaceIds.push(proof.workspaceId);
    for (const id of proof.recoveryIssueIds) settledRecoveryIssueIds.add(id);
  }
  return { kind: "git", root: captureRoot, projectId: null, projectIds: [...projectIds].sort(), issueIds,
    workspaceIds: [...aliases].sort(), device: entry.dev, inode: entry.ino, gitSourceRoots, companions,
    physicalRoots: [...new Set([...included.flatMap(node => localWorkspaceSourcePaths(node.row)), ...importedChildren.map(child => child.sourcePath)])].sort(),
    settledPreparedWorkspaceIds: settledPreparedWorkspaceIds.sort(), settledRecoveryIssueIds: [...settledRecoveryIssueIds].sort(),
    settledFinalizationRunIds: [...new Set(companions.flatMap(proof => proof.sources.map(source => source.runId)))].sort(),
    gitSourceFingerprints: included.map(node => ({ workspaceId: node.row.id, fingerprint: node.fingerprint })), importedChildren,
  };
}
