import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issueRecoveryActions, type Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { inspectOnlineOrdinarySource, physicalPath, requiresOnlineOrdinarySource, type WorkspaceSourceScope } from "./remote-workspace-migration-tree.js";
import { workspaceSourceIdentities } from "./workspace-source-lock.js";
import { readWorkspaceGitSourceRoots } from "./workspace-git-source-roots.js";
import { inspectOnlineLegacyWorkspaceRecoveryHold, inspectOnlineLegacyWorkspaceRecoverySource, type OnlineLegacyWorkspaceRecoveryHold } from "./online-legacy-workspace-recovery.js";
import type { LegacyWorkspaceRecoverySource } from "./legacy-workspace-recovery-migration.js";
import { hasPendingGitExpiration } from "./git-workspace-expiration.js";
import { readGitCacheRestoration } from "./git-workspace-restoration.js";

type Workspace = typeof executionWorkspaces.$inferSelect;
type ReadDb = Pick<Db, "select">;
type Identities = Awaited<ReturnType<typeof workspaceSourceIdentities>>;
export type OnlineWorkspaceSource = WorkspaceSourceScope & {
  kind: "ordinary" | "git"; projectIds: string[];
  gitSourceFingerprints?: Array<{ workspaceId: string; fingerprint: string | null }>;
  companions: Array<{ workspaceId: string; sources: LegacyWorkspaceRecoverySource[];
    holds: Array<OnlineLegacyWorkspaceRecoveryHold & { actionId: string }> }>;
};
const intersects = (values: string[], keys: Set<string>) => values.some(value => keys.has(value));

export async function requiresOnlineWorkspaceSource(workspace: Workspace): Promise<boolean> {
  if (await requiresOnlineOrdinarySource(workspace)) return true;
  const cwd = workspace.cwd ?? workspace.providerRef;
  if (!cwd || !path.isAbsolute(cwd) || !["local_fs", "git_worktree"].includes(workspace.providerType)) return false;
  const entry = await fs.lstat(cwd).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
  if (!entry?.isDirectory() || entry.isSymbolicLink()) return false;
  return Boolean(workspace.repoUrl || workspace.branchName || workspace.strategyType === "git_worktree"
    || await fs.lstat(path.join(cwd, ".git")).then(() => true,
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return false; }));
}

async function companion(db: ReadDb, workspace: Workspace) {
  const runs = await db.select({ id: heartbeatRuns.id, issueId: heartbeatRuns.nativeIssueId,
    state: sql<string>`${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,state}'` }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, workspace.companyId),
    sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,workspaceId}'=${workspace.id}`,
    sql`${heartbeatRuns.runnerProfileJson}#>>'{nativeWorkspaceSync,state}' in ('prepared','finalized')`,
  )).orderBy(heartbeatRuns.id);
  const sources: LegacyWorkspaceRecoverySource[] = [];
  for (const run of runs.filter(run => run.state === "prepared")) {
    const source = await inspectOnlineLegacyWorkspaceRecoverySource(db, { workspace, runId: run.id });
    if (!source) return null;
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
    if (!hold) return null;
    holds.push({ actionId: recovery.id, ...hold });
  }
  return { workspaceId: workspace.id, sources, holds, recoveryIssueIds: issueIds };
}

export async function inspectOnlineWorkspaceSource(db: ReadDb, workspace: Workspace): Promise<OnlineWorkspaceSource | null> {
  const cwd = workspace.cwd ?? workspace.providerRef;
  if (!cwd || !path.isAbsolute(cwd) || !["local_fs", "git_worktree"].includes(workspace.providerType)) return null;
  const ordinary = await inspectOnlineOrdinarySource(db, workspace);
  let selected: Identities;
  try { selected = await workspaceSourceIdentities(workspace.companyId, cwd); } catch { return null; }
  if (ordinary && !selected.git) return { ...ordinary, kind: "ordinary", projectIds: ordinary.projectId ? [ordinary.projectId] : [], companions: [] };
  if (!selected.git || selected.git.root !== await physicalPath(cwd) || selected.unownedPaths.length || !workspace.sourceIssueId
    || workspace.cwd && workspace.providerRef && workspace.cwd !== workspace.providerRef) return null;
  const entry = await fs.lstat(cwd);
  const rows = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.companyId, workspace.companyId),
    inArray(executionWorkspaces.providerType, ["local_fs", "git_worktree"]))).orderBy(executionWorkspaces.id).limit(1001);
  if (rows.length > 1000) return null;
  const nodes: Array<{ row: Workspace; identities: Identities }> = [];
  for (const row of rows) {
    const cwd = row.cwd ?? row.providerRef;
    if (!cwd || !path.isAbsolute(cwd)) return null;
    try {
      const identities = await workspaceSourceIdentities(workspace.companyId, cwd);
      if (row.cwd && row.providerRef && row.providerRef !== row.cwd) {
        if (!path.isAbsolute(row.providerRef)) return null;
        const alternate = await workspaceSourceIdentities(workspace.companyId, row.providerRef);
        identities.projectIds = [...new Set([...identities.projectIds, ...alternate.projectIds])].sort();
        identities.issueIds = [...new Set([...identities.issueIds, ...alternate.issueIds])].sort();
      }
      nodes.push({ row, identities });
    } catch { return null; }
  }
  const projectIds = new Set(selected.projectIds), physicalIssueIds = new Set(selected.issueIds), aliases = new Set<string>();
  for (;;) {
    let changed = false;
    for (const node of nodes) {
      if (aliases.has(node.row.id)) continue;
      if (node.row.id !== workspace.id && !intersects(node.identities.projectIds, projectIds)
        && !intersects(node.identities.issueIds, physicalIssueIds)
        && !(node.row.projectId && projectIds.has(node.row.projectId))
        && !(node.row.sourceIssueId && physicalIssueIds.has(node.row.sourceIssueId))) continue;
      if (!node.row.sourceIssueId || node.row.cwd && node.row.providerRef && node.row.cwd !== node.row.providerRef
        || !["active", "idle", "in_review", "archived"].includes(node.row.status)
        || node.row.metadata?.remoteWorkspace || hasPendingGitExpiration(node.row)) return null;
      aliases.add(node.row.id); changed = true;
      for (const id of node.identities.projectIds) projectIds.add(id);
      for (const id of node.identities.issueIds) physicalIssueIds.add(id);
      if (node.row.projectId) projectIds.add(node.row.projectId);
    }
    if (!changed) break;
  }
  if (!aliases.has(workspace.id) || aliases.size > 256) return null;
  const included = nodes.filter(node => aliases.has(node.row.id));
  const issueIds = [...new Set([...physicalIssueIds, ...included.map(node => node.row.sourceIssueId!)])].sort();
  if (issueIds.length + projectIds.size > 128) return null;
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
      for (const cwd of new Set([row.cwd, row.providerRef])) {
        if (!cwd) continue;
        if (!path.isAbsolute(cwd)) return null;
        try {
          if (owned(await physicalPath(cwd))) return null;
          const git = await readWorkspaceGitSourceRoots(cwd, { ancestors: true });
          if (git && [git.gitDirectory.path, git.commonDirectory.path, ...git.objectDirectories.map(root => root.path)].some(owned)) return null;
        } catch { return null; }
      }
    }
    if (foreign.length < 256) break;
    if (page === 39) return null;
    after = foreign.at(-1)!.id;
  }
  const recipe = readGitCacheRestoration(workspace);
  if (recipe && (!recipe.restoredAt || recipe.contents && !recipe.contentsRestoredAt
    || recipe.restorePoint && !recipe.restorePoint.expiredAt && !recipe.restorePoint.appliedAt)) return null;
  const companions: OnlineWorkspaceSource["companions"] = [], settledPreparedWorkspaceIds: string[] = [], settledRecoveryIssueIds = new Set<string>();
  for (const node of included) {
    const proof = await companion(db, node.row);
    if (!proof) return null;
    companions.push({ workspaceId: proof.workspaceId, sources: proof.sources, holds: proof.holds });
    if (proof.sources.length) settledPreparedWorkspaceIds.push(proof.workspaceId);
    for (const id of proof.recoveryIssueIds) settledRecoveryIssueIds.add(id);
  }
  return { kind: "git", root: selected.git.root, projectId: null, projectIds: [...projectIds].sort(), issueIds,
    workspaceIds: [...aliases].sort(), device: entry.dev, inode: entry.ino, gitSourceRoots, companions,
    physicalRoots: included.map(node => node.row.cwd ?? node.row.providerRef!).sort(),
    settledPreparedWorkspaceIds: settledPreparedWorkspaceIds.sort(), settledRecoveryIssueIds: [...settledRecoveryIssueIds].sort(),
    settledFinalizationRunIds: [...new Set(companions.flatMap(proof => proof.sources.map(source => source.runId)))].sort(),
    gitSourceFingerprints: included.map(node => ({ workspaceId: node.row.id, fingerprint: node.identities.git?.fingerprint ?? null })),
  };
}
