import { reserveAutomaticSkillWork, settleAutomaticSkillWork } from './skill-source-refresh-budget.js';
import { skillSourceRepairAction } from './skill-source-problems.js';
import { listSkillSourceBranches } from './skill-source-branches.js';
import { createHash, randomUUID } from 'node:crypto';
import { skillSourceRetryAt } from './skill-source-retry.js';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { folderService } from './folders.js';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { companySkillSources as sources, companySkillSourceEntries as entries, companySkills, companySkillRepositorySnapshots, projectSkillSources, projects, type Db, authUsers } from '@paperclipai/db';
import type { CompanySkill, SkillSource, SkillSourceCreateRequest, SkillSourceDiscoveryRequest, SkillSourceSelectionRequest, SkillSourceRefreshResult, SkillSourcePreviewRequest, SkillSourceSettingsRequest, SkillSourceDisconnectRequest, SkillSourceDisconnectResult, SkillSourceBranchesQuery } from '@paperclipai/shared';
import { normalizeAgentUrlKey } from '@paperclipai/shared';
import { conflict, notFound, unprocessable } from '../errors.js';
import { companySkillService, parseSkillImportSourceInput } from './company-skills.js';
import { scanGitHubSkillsWithPackageFallback as scanGitHubSkills, previewGitHubSkillFile, type GitHubRead, type ScannedSkillSource, type SkillScanOptions } from './github-skill-source.js';
import { skillAccessService } from './skill-access.js';
import { skillSnapshotHash } from './skill-snapshot.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type SourceRow = typeof sources.$inferSelect;
export type SkillSourceContext = {
  actor: { type: 'user' | 'agent' | 'system'; userId?: string | null; agentId?: string | null };
  setup?: { userId: string | null; agentId?: string | null; localTrusted: boolean; grantId?: string | null };
  projectBindingId?: string;
  projectBindingLeaseToken?: string;
  read: (connectionId: string | null) => GitHubRead;
  authorize: (action: 'skills.import' | 'skills.update' | 'skills.edit' | 'skills.remove' | 'skills.create', resource: { skillId?: string; skillKey?: string; sourceType: 'git'; sourceLocator: string }) => Promise<void>;
  audit: (tx: Tx, sourceId: string, action: string, details: Record<string, unknown>) => Promise<void>;
  publishCommittedActivity?: () => void;
};
const scope = (companyId: string, id: string) => and(eq(sources.companyId, companyId), eq(sources.id, id));

export function skillSourceService(db: Db) {
  const skills = companySkillService(db);
  async function row(companyId: string, id: string, database: Db | Tx = db) {
    const [source] = await database.select().from(sources).where(scope(companyId, id));
    if (!source || source.removedAt) throw notFound('Skill source not found.');
    return source;
  }
  async function detail(companyId: string, id: string, database: Db | Tx = db): Promise<SkillSource> {
    await skillAccessService(database as Db).assertSource(companyId, id);
    const { leaseToken, leaseExpiresAt, createdAt: _created, removedAt: _removed, refreshUserId: _user, refreshAgentId: _agent, refreshLocalTrusted: _local, refreshGrantId: _grant, failureCount: _failures, nextSyncAt: _next, lastScanTreeSha: _tree, automaticBudgetBytes: _bytes, automaticBudgetAt: _budgetAt, ...source } = await row(companyId, id, database);
    const permitted = await skillAccessService(database as Db).projectIds(companyId, id);
    const associated = await database.select({ id: projects.id, name: projects.name, visibility: projects.visibility, active: projectSkillSources.active })
      .from(projectSkillSources).innerJoin(projects, eq(projects.id, projectSkillSources.projectId))
      .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.sourceId, id)));
    const visibleProjects = new Map<string, typeof associated[number]>();
    for (const project of associated) {
      if (!permitted.some(binding => binding.projectId === project.id)) continue;
      const previous = visibleProjects.get(project.id);
      visibleProjects.set(project.id, { ...project, active: project.active || Boolean(previous?.active) });
    }
    const refreshing = leaseToken && leaseExpiresAt && leaseExpiresAt > new Date();
    const trackingActive = source.accessScope === 'company' || associated.some(project => project.active);
    const selected = await database.select().from(entries).where(and(eq(entries.companyId, companyId), eq(entries.sourceId, id))).orderBy(entries.path);
    return { ...source, repairAction: skillSourceRepairAction(source.lastError), trackingActive, entries: selected, projects: [...visibleProjects.values()].map(project => ({ ...project, visibility: project.visibility as 'open' | 'private' })),
      syncState: !source.enabled || !source.automaticUpdates || !trackingActive ? 'paused' : refreshing ? 'refreshing' : source.lastError ? 'error' : source.lastSuccessAt ? 'ready' : 'pending' };
  }
  async function list(companyId: string) {
    const rows = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.companyId, companyId), isNull(sources.removedAt))).orderBy(sources.fullName);
    const visible = await skillAccessService(db).visibleSourceIds(companyId);
    return Promise.all(rows.filter(source => visible === null || visible.includes(source.id)).map(source => detail(companyId, source.id)));
  }
  async function sourceForSkill(companyId: string, skillId: string) {
    const [entry] = await db.select().from(entries).where(and(eq(entries.companyId, companyId), eq(entries.skillId, skillId)));
    return entry ? detail(companyId, entry.sourceId) : null;
  }
  async function discover(input: SkillSourceDiscoveryRequest, context: SkillSourceContext, options?: SkillScanOptions) {
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: input.repositoryUrl });
    const { skills: _files, repositoryFiles: _repositoryFiles, repositorySubset: _subset, defaultBranch: _defaultBranch, treeSha: _tree, downloadBytes: _download, scanBytes: _scan, ...result } = await scanGitHubSkills(input, context.read(input.connectionId ?? null), { ...options, retainFiles: false });
    return result;
  }
  async function preview(input: SkillSourcePreviewRequest, context: SkillSourceContext) {
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: input.repositoryUrl });
    return previewGitHubSkillFile(input, context.read(input.connectionId ?? null));
  }
  async function authorizeScan(source: SourceRow, scan: ScannedSkillSource, selectedPaths: string[], context: SkillSourceContext) {
    const previous = await db.select().from(entries).where(and(eq(entries.companyId, source.companyId), eq(entries.sourceId, source.id)));
    for (const candidate of scan.skills.filter(candidate => selectedPaths.includes(candidate.path) && !candidate.error)) {
      const old = previous.find(entry => entry.path === candidate.path);
      const skill = old?.skillId ? await skills.getById(source.companyId, old.skillId) : null;
      await context.authorize(skill ? 'skills.update' : 'skills.import', {
        sourceType: 'git', sourceLocator: source.repositoryUrl, ...(skill ? { skillId: skill.id, skillKey: skill.key } : { skillKey: newSkillKey(scan, candidate.path, candidate.name, source.id, source.revision) }),
      });
    }
  }
  async function authorizeSelection(source: SourceRow, selectedPaths: string[], context: SkillSourceContext) {
    for (const entry of (await detail(source.companyId, source.id)).entries) {
      if (!entry.skillId || (entry.selection === 'selected') === selectedPaths.includes(entry.path)) continue;
      const skill = await skills.getById(source.companyId, entry.skillId);
      if (skill) await context.authorize('skills.edit', { sourceType: 'git', sourceLocator: source.repositoryUrl, skillId: skill.id, skillKey: skill.key });
    }
  }
  function newSkillKey(scan: ScannedSkillSource, skillPath: string, name: string, sourceId: string, revision = 0) {
    // New imports after removal must not overwrite retained editable copies.
    // Existing entries keep their installed identity across later revisions.
    const identity = createHash('sha256').update(`${scan.repositoryId}:${sourceId}${revision ? `:${revision}` : ''}:${skillPath}`).digest('hex').slice(0, 16);
    return `github/${scan.repositoryId}/${identity}/${normalizeAgentUrlKey(name) || 'skill'}`;
  }
  async function publish(tx: Tx, source: SourceRow, scan: ScannedSkillSource, selectedPaths: string[], excludedFolders: string[], context: SkillSourceContext, selectionReviewed: boolean): Promise<Omit<SkillSourceRefreshResult, 'source'>> {
    await tx.execute(sql`SET CONSTRAINTS paperclip_skill_runtime_changed DEFERRED`);
    const mode = scan.packageMode ?? 'skills';
    if (mode === 'repository' && scan.skills.length > 0 && (scan.repositoryPackage?.error || !scan.repositoryFiles?.length)) {
      throw unprocessable(scan.repositoryPackage?.error ?? 'Repository package has no files. Scan it again before importing.');
    }
    let repositorySnapshotId: string | undefined;
    const repositoryHash = mode === 'repository' && scan.repositoryFiles?.length && !scan.repositoryPackage?.error ? skillSnapshotHash(scan.repositoryFiles) : null;
    if (repositoryHash) {
      await tx.insert(companySkillRepositorySnapshots).values({ companyId: source.companyId, contentHash: repositoryHash, fileInventory: scan.repositoryFiles! })
        .onConflictDoNothing();
      const [snapshot] = await tx.select({ id: companySkillRepositorySnapshots.id }).from(companySkillRepositorySnapshots).where(and(
        eq(companySkillRepositorySnapshots.companyId, source.companyId), eq(companySkillRepositorySnapshots.contentHash, repositoryHash)));
      repositorySnapshotId = snapshot!.id;
    }
    const previous = await tx.select().from(entries).where(and(eq(entries.companyId, source.companyId), eq(entries.sourceId, source.id)));
    const imported: CompanySkill[] = [], updated: CompanySkill[] = [];
    const warnings = [...new Set([...scan.warnings, ...(scan.repositoryPackage?.warnings ?? [])])];
    let unchanged = 0;
    const selected = new Set(selectedPaths);
    const scanned = new Set(scan.skills.map(candidate => candidate.path));
    for (const chosen of selected) {
      if (!scanned.has(chosen) && !previous.some(entry => entry.path === chosen)) throw unprocessable('A selected skill was not found in this repository scan.');
    }
    for (const candidate of scan.skills) {
      const old = previous.find(entry => entry.path === candidate.path);
      const selection = selected.has(candidate.path) ? 'selected' as const
        : (selectionReviewed && (Boolean(old) || source.revision === 0)) || old?.selection === 'excluded' || excludedFolders.some(folder => !folder || candidate.path.startsWith(`${folder}/`)) ? 'excluded' as const : 'new' as const;
      let skillId = old?.skillId ?? null;
      const current = skillId ? await skills.getById(source.companyId, skillId, tx) : null;
      if (selection === 'selected' && !candidate.error) {
        const hash = repositoryHash ? createHash('sha256').update(`${repositoryHash}:${candidate.path}`).digest('hex') : skillSnapshotHash(candidate.files);
        const slug = normalizeAgentUrlKey(candidate.name) || 'skill';
        const key = current?.key ?? newSkillKey(scan, candidate.path, candidate.name, source.id, source.revision);
        const ownerRepo = scan.fullName.split('/');
        const metadata = { ...(current?.metadata ?? {}), sourceKind: 'github', hostname: 'github.com',
          owner: ownerRepo[0], repo: ownerRepo[1], ref: current?.metadata?.snapshotHash === hash && current.currentVersionId ? current.sourceRef : scan.commitSha, trackingRef: scan.trackingRef,
          repoSkillDir: path.posix.dirname(candidate.path) === '.' ? '' : path.posix.dirname(candidate.path),
          skillSourceId: source.id, skillSourcePath: candidate.path, skillSourceState: 'synced', snapshotHash: hash, packageMode: mode };
        const trustFiles = mode === 'repository' ? scan.repositoryFiles! : candidate.files;
        const values = { name: candidate.name, description: candidate.description, markdown: candidate.files.find(file => file.path === 'SKILL.md')!.content,
          accessSourceId: source.accessScope === 'projects' ? source.id : current?.accessSourceId ?? null,
          sourceType: 'github', sourceLocator: scan.repositoryUrl, sourceRef: current?.metadata?.snapshotHash === hash && current.currentVersionId ? current.sourceRef : scan.commitSha,
          fileInventory: candidate.files.map(({ path, kind }) => ({ path, kind })),
          trustLevel: trustFiles.some(file => file.kind === 'script' || file.executable) ? 'scripts_executables' : trustFiles.some(file => file.kind === 'asset' || file.kind === 'other') ? 'assets' : 'markdown_only',
          metadata, updatedAt: new Date() };
        const changed = !current?.currentVersionId || current.metadata?.snapshotHash !== hash;
        if (current && changed) await tx.update(companySkills).set(values).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, current.id)));
        else if (!current) {
          const [created] = await tx.insert(companySkills).values({ ...values, companyId: source.companyId, key, slug, installCount: 1 }).returning({ id: companySkills.id });
          skillId = created!.id;
        }
        else if (current.metadata?.skillSourceState !== 'synced' || current.trustLevel !== values.trustLevel) {
          await tx.update(companySkills).set({ metadata, trustLevel: values.trustLevel }).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, current.id)));
        }
        const installed = (await skills.getById(source.companyId, skillId!, tx))!;
        if (changed) {
          const version = await skills.createVersion(source.companyId, skillId!, { label: `GitHub ${scan.commitSha.slice(0, 8)}` }, context.actor, {
            database: tx, skipInventoryRefresh: true, skill: installed, fileInventory: candidate.files,
            ...(repositorySnapshotId ? { repositorySnapshotId, repositorySkillPath: candidate.path } : {}),
          });
          installed.currentVersionId = version.id;
          (current ? updated : imported).push(installed);
        } else unchanged++;
      } else if (current) {
        await tx.update(companySkills).set({ metadata: { ...current.metadata, skillSourceId: source.id, skillSourcePath: candidate.path,
          skillSourceState: selection !== 'selected' ? 'not_syncing' : 'update_failed' } }).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, current.id)));
      }
      if (candidate.error && selection === 'selected') warnings.push(`${candidate.path}: ${candidate.error}`);
      if (selection === 'selected') {
        warnings.push(...(candidate.inspection?.warnings.filter(warning => warning.includes('not included') || warning.includes('couldn’t be included')) ?? []));
        warnings.push(...(candidate.inspection?.references.map(reference => `${reference.resolvedPath} — Referenced by ${candidate.path}; not included.`) ?? []));
      }
      await tx.insert(entries).values({ companyId: source.companyId, sourceId: source.id, path: candidate.path, name: candidate.name,
        description: candidate.description, inspection: candidate.inspection ?? null, skillId, selection, present: true, error: candidate.error })
        .onConflictDoUpdate({ target: [entries.sourceId, entries.path], set: { name: candidate.name, description: candidate.description, inspection: candidate.inspection ?? null, skillId, selection, present: true, error: candidate.error } });
    }
    for (const old of previous.filter(entry => !scanned.has(entry.path))) {
      await tx.update(entries).set({ present: false, selection: selected.has(old.path) ? 'selected' : 'excluded', error: null }).where(eq(entries.id, old.id));
      if (old.skillId) {
        const current = await skills.getById(source.companyId, old.skillId, tx);
        if (current) await tx.update(companySkills).set({ metadata: { ...current.metadata, skillSourceId: source.id, skillSourcePath: old.path, skillSourceState: 'removed' } }).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, old.skillId)));
      }
    }
    // HEAD remains the default-branch alias across refreshes and branch renames.
    await tx.update(sources).set({ repositoryId: scan.repositoryId, repositoryUrl: scan.repositoryUrl, fullName: scan.fullName,
      packageMode: mode, repositoryPackage: scan.repositoryPackage ?? null,
      trackingRef: source.trackingRef === 'HEAD' ? 'HEAD' : scan.trackingRef, excludedFolders, lastSuccessAt: new Date(), lastScanCommit: scan.commitSha, lastScanTreeSha: scan.treeSha ?? null, lastError: null,
      revision: source.revision + 1, leaseToken: null, leaseExpiresAt: null, failureCount: 0, nextSyncAt: new Date(Date.now() + 5 * 60_000) }).where(scope(source.companyId, source.id));
    await context.audit(tx, source.id, 'company.skill_source_refreshed', { commit: scan.commitSha, importedCount: imported.length, updatedCount: updated.length, unchanged, warningCount: warnings.length });
    return { imported, updated, unchanged, warnings: [...new Set(warnings)] };
  }
  async function create(companyId: string, input: SkillSourceCreateRequest, context: SkillSourceContext, staged?: ScannedSkillSource) {
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: input.repositoryUrl });
    const reader = context.read(input.connectionId ?? null);
    const scan = staged ?? await scanGitHubSkills(input, reader);
    if (!context.projectBindingId && scan.trackingRef === scan.defaultBranch && (await list(companyId)).some(source => source.repositoryUrl.toLowerCase() === scan.repositoryUrl.toLowerCase() && source.trackingRef === 'HEAD')) {
      throw conflict('This repository is already in Sources. Manage its skills there.');
    }
    const id = randomUUID();
    // New imports are authorized per generated skill identity too, before publishing.
    for (const candidate of scan.skills.filter(candidate => input.selectedPaths.includes(candidate.path) && !candidate.error)) {
      await context.authorize('skills.import', { sourceType: 'git', sourceLocator: scan.repositoryUrl,
        skillKey: newSkillKey(scan, candidate.path, candidate.name, id) });
    }
    const published = await db.transaction(async tx => {
      const [source] = await tx.insert(sources).values({ id, companyId, repositoryId: scan.repositoryId, repositoryUrl: scan.repositoryUrl, fullName: scan.fullName,
        packageMode: scan.packageMode ?? 'skills', trackingRef: context.projectBindingId && input.trackingRef === 'HEAD' ? 'HEAD' : scan.trackingRef, connectionId: scan.connectionId ?? input.connectionId ?? null, lastAttemptAt: new Date(),
        accessScope: context.projectBindingId ? 'projects' : 'company', importNewSkills: Boolean(context.projectBindingId),
        refreshUserId: context.setup?.userId, refreshAgentId: context.setup?.agentId, refreshLocalTrusted: context.setup?.localTrusted ?? false, refreshGrantId: reader.grantId ?? context.setup?.grantId }).onConflictDoNothing().returning();
      if (!source) throw conflict('This repository and branch are already in Sources. Manage its skills there.');
      if (context.projectBindingId) {
        const [binding] = await tx.select().from(projectSkillSources).where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.id, context.projectBindingId))).for('update');
        if (!binding?.active || (context.projectBindingLeaseToken && binding.leaseToken !== context.projectBindingLeaseToken)) throw conflict('Project repository changed during import.');
        await tx.update(projectSkillSources).set({ sourceId: source.id, status: 'ready', lastError: null }).where(eq(projectSkillSources.id, binding.id));
      }
      const result = await publish(tx, source, scan, input.selectedPaths, input.excludedFolders ?? [], context, true);
      return { ...result, source: await detail(companyId, id, tx) };
    });
    context.publishCommittedActivity?.();
    return published;
  }
  async function refresh(companyId: string, id: string, context: SkillSourceContext, selection?: SkillSourceSelectionRequest, staged?: ScannedSkillSource, options: { checkCommit?: boolean; automatic?: boolean; now?: Date; signal?: AbortSignal } = {}) {
    let source = await row(companyId, id);
    if (!source.enabled && !selection) throw conflict('This source is disconnected. Save its selection to reconnect.');
    await context.authorize(selection ? 'skills.edit' : 'skills.update', { sourceType: 'git', sourceLocator: source.repositoryUrl });
    if (selection) await authorizeSelection(source, selection.selectedPaths, context);
    if (selection && selection.revision !== source.revision) throw conflict('This source changed. Reload before saving your selection.');
    const token = randomUUID();
    const [leased] = await db.update(sources).set({ leaseToken: token, leaseExpiresAt: new Date(Date.now() + 10 * 60_000), lastAttemptAt: new Date() })
      .where(and(scope(companyId, id), eq(sources.revision, source.revision), or(isNull(sources.leaseToken), lt(sources.leaseExpiresAt, new Date())))).returning();
    if (!leased) throw conflict('This source is refreshing or changed. Try again after it finishes.');
    source = leased;
    try {
      const connectionId = selection?.connectionId !== undefined ? selection.connectionId : source.connectionId;
      const reader = context.read(connectionId);
      if (options.checkCommit && source.repositoryId && source.lastScanCommit) {
        const repo = await reader(`/repos/${source.fullName}`, options.signal) as { id: number; default_branch: string };
        if (String(repo.id) !== source.repositoryId) throw conflict('The repository at this URL has changed identity. Add it as a new source.');
        const ref = source.trackingRef === 'HEAD' ? repo.default_branch : source.trackingRef;
        const head = await reader(`/repos/${source.fullName}/commits/${encodeURIComponent(ref)}`, options.signal) as { sha: string; commit?: { tree?: { sha?: string } } };
        const rawTreeSha = head.commit?.tree?.sha;
        const treeSha = rawTreeSha && /^[a-f0-9]{40}$/i.test(rawTreeSha) ? rawTreeSha.toLowerCase() : null;
        const [legacyDependencyFailure] = await db.select({ id: entries.id }).from(entries).where(and(
          eq(entries.companyId, companyId), eq(entries.sourceId, id),
          sql`${entries.error} like 'This skill depends on files that its imported package cannot provide.%'`,
        )).limit(1);
        if (!legacyDependencyFailure && (head.sha === source.lastScanCommit || (treeSha && treeSha === source.lastScanTreeSha))) {
          await db.transaction(async tx => {
            const [locked] = await tx.select().from(sources).where(scope(companyId, id)).for('update');
            if (!locked || locked.leaseToken !== token || locked.revision !== source.revision) throw conflict('Source refresh changed. Try again.');
            await context.audit(tx, id, 'company.skill_source_checked', { commit: head.sha, unchangedTree: head.sha !== source.lastScanCommit });
            await tx.update(sources).set({ leaseToken: null, leaseExpiresAt: null, lastError: null, lastSuccessAt: new Date(), failureCount: 0, lastScanCommit: head.sha, lastScanTreeSha: treeSha ?? source.lastScanTreeSha,
              connectionId: reader.connectionId ?? source.connectionId, refreshGrantId: reader.grantId ?? source.refreshGrantId,
              nextSyncAt: new Date(Date.now() + 5 * 60_000) }).where(scope(companyId, id));
          });
          context.publishCommittedActivity?.();
          return { source: await detail(companyId, id), imported: [], updated: [], unchanged: (await detail(companyId, id)).entries.filter(entry => entry.selection === 'selected').length, warnings: [] };
        }
      }
      const packageMode = selection?.packageMode ?? (source.accessScope === 'projects' ? 'repository' : source.packageMode);
      if (options.automatic) await reserveAutomaticSkillWork(db, source, token, options.now ?? new Date());
      const scan = staged ?? await scanGitHubSkills({ repositoryUrl: source.repositoryUrl, trackingRef: source.trackingRef, packageMode }, reader, { signal: options.signal });
      if (options.automatic) await settleAutomaticSkillWork(db, companyId, id, token,
        packageMode === 'repository' && (scan.packageMode === 'skills' || scan.repositorySubset) ? {} : scan);
      if (source.repositoryId && source.repositoryId !== scan.repositoryId) throw conflict('The repository at this URL has changed identity. Add it as a new source.');
      const current = await detail(companyId, id);
      const includedRepositoryPaths = new Set(scan.repositoryFiles?.map(file => file.path));
      const omittedInstalledFiles = current.entries.some(entry => entry.skillId && current.repositoryPackage?.files.some(file => {
        if (scan.repositorySubset) return !includedRepositoryPaths.has(file.path);
        const root = path.posix.dirname(entry.path);
        return root !== '.' && !file.path.startsWith(`${root}/`);
      }));
      if (source.packageMode === 'repository' && (scan.packageMode === 'skills' || scan.repositorySubset)
        && selection?.packageMode !== 'skills' && current.entries.some(entry => entry.skillId)
        && (omittedInstalledFiles || (scan.packageMode === 'skills' && scan.skills.some(skill => skill.inspection?.references.length)))) {
        throw unprocessable('The repository exceeds the supported package size. Installed repository skills and their dependencies were kept. Reduce the repository package size before refreshing.');
      }
      const selectedPaths = selection?.selectedPaths ?? current.entries.filter(entry => entry.selection === 'selected').map(entry => entry.path);
      if (!selection && source.importNewSkills) {
        for (const candidate of scan.skills) {
          if (current.entries.some(entry => entry.path === candidate.path) || source.excludedFolders.some(folder => !folder || candidate.path.startsWith(`${folder}/`))) continue;
          selectedPaths.push(candidate.path);
        }
      }
      await authorizeScan(source, scan, selectedPaths, context);
      const published = await db.transaction(async tx => {
        const [locked] = await tx.select().from(sources).where(scope(companyId, id)).for('update');
        if (!locked || locked.leaseToken !== token || locked.revision !== source.revision || locked.leaseExpiresAt! < new Date()) throw conflict('Source refresh expired or changed. Try again.');
        const result = await publish(tx, locked, scan, selectedPaths, selection?.excludedFolders ?? source.excludedFolders, context, Boolean(selection));
        if (selection || scan.connectionId !== undefined) await tx.update(sources).set({ ...(selection ? { enabled: true } : {}), connectionId: scan.connectionId ?? connectionId,
          ...(source.refreshGrantId === null && reader.grantId ? { refreshGrantId: reader.grantId } : {}),
          ...(selection?.connectionId !== undefined || (!source.refreshUserId && !source.refreshLocalTrusted && context.setup) ? { refreshUserId: context.setup?.userId, refreshAgentId: context.setup?.agentId ?? null, refreshLocalTrusted: context.setup?.localTrusted ?? false, refreshGrantId: reader.grantId ?? null } : {}) }).where(scope(companyId, id));
        return { ...result, source: await detail(companyId, id, tx) };
      });
      context.publishCommittedActivity?.();
      return published;
    } catch (error) {
      // Provider errors have already been sanitized. Never persist arbitrary exception text.
      const message = error instanceof Error && 'status' in error ? error.message : 'Refresh failed. The installed skills were kept. Try again.';
      await db.update(sources).set({ leaseToken: null, leaseExpiresAt: null, lastError: options.signal?.aborted ? source.lastError : message, failureCount: options.signal?.aborted ? source.failureCount : source.failureCount + 1, nextSyncAt: options.signal?.aborted ? new Date() : skillSourceRetryAt(error, source.failureCount) }).where(and(scope(companyId, id), eq(sources.leaseToken, token)));
      throw error;
    }
  }
  async function branches(companyId: string, id: string, input: SkillSourceBranchesQuery, context: SkillSourceContext, signal?: AbortSignal) {
    await skillAccessService(db).assertSource(companyId, id);
    const source = await row(companyId, id);
    await context.authorize('skills.edit', { sourceType: 'git', sourceLocator: source.repositoryUrl });
    return listSkillSourceBranches(source, context.read(input.connectionId ?? source.connectionId), signal);
  }
  async function settings(companyId: string, id: string, input: SkillSourceSettingsRequest, context: SkillSourceContext) {
    await skillAccessService(db).assertSource(companyId, id);
    const source = await row(companyId, id);
    await context.authorize('skills.edit', { sourceType: 'git', sourceLocator: source.repositoryUrl });
    // Validate a replacement connection before binding unattended work to it.
    let reader: GitHubRead | undefined;
    if (input.trackingRef !== undefined) {
      const [binding] = await db.select({ id: projectSkillSources.id }).from(projectSkillSources)
        .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.sourceId, id), eq(projectSkillSources.active, true))).limit(1);
      if (source.accessScope === 'projects' || binding) throw unprocessable('Update the repository branch in its project settings.');
    }
    if (input.connectionId !== undefined || input.trackingRef !== undefined) {
      reader = context.read(input.connectionId !== undefined ? input.connectionId : source.connectionId);
      const repository = await reader(`/repos/${source.fullName}`) as { id: number; default_branch: string };
      if (source.repositoryId && String(repository.id) !== source.repositoryId) throw conflict('The repository at this URL has changed identity. Add it as a new source.');
      const requestedRef = input.trackingRef ?? source.trackingRef;
      const ref = requestedRef === 'HEAD' ? repository.default_branch : requestedRef;
      if (typeof ref !== 'string' || !ref) throw unprocessable('The selected branch or revision is unavailable.', { code: 'skill_source_ref_unavailable' });
      const commit = await reader(`/repos/${source.fullName}/commits/${encodeURIComponent(ref)}`) as { sha?: unknown } | null;
      if (!commit || typeof commit.sha !== 'string' || !/^[a-f0-9]{40}$/i.test(commit.sha)) throw unprocessable('The selected branch or revision is unavailable.', { code: 'skill_source_ref_unavailable' });
    }
    return db.transaction(async tx => {
      if (input.trackingRef !== undefined) {
        // Attachment/removal lock the source before changing its project bindings.
        await tx.select({ id: sources.id }).from(sources).where(scope(companyId, id)).for('update');
        const [binding] = await tx.select({ id: projectSkillSources.id }).from(projectSkillSources)
          .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.sourceId, id), eq(projectSkillSources.active, true))).limit(1);
        if (binding) throw unprocessable('Update the repository branch in its project settings.');
        const [duplicate] = await tx.select({ id: sources.id }).from(sources).where(and(
          eq(sources.companyId, companyId), eq(sources.repositoryUrl, source.repositoryUrl), eq(sources.trackingRef, input.trackingRef), isNull(sources.removedAt), sql`${sources.id} <> ${id}`));
        if (duplicate) throw conflict('This repository and branch are already in Sources. Use that source; installed skills were kept.');
      }
      const [updated] = await tx.update(sources).set({
        ...(input.automaticUpdates !== undefined ? { automaticUpdates: input.automaticUpdates } : {}),
        ...(input.importNewSkills !== undefined ? { importNewSkills: input.importNewSkills } : {}),
        ...(input.connectionId !== undefined ? { connectionId: reader?.connectionId ?? input.connectionId,
          refreshUserId: context.setup?.userId, refreshAgentId: context.setup?.agentId ?? null,
          refreshLocalTrusted: context.setup?.localTrusted ?? false, refreshGrantId: reader?.grantId ?? null, lastError: null } : {}),
        ...(input.trackingRef !== undefined ? { trackingRef: input.trackingRef, lastError: null, failureCount: 0 } : {}),
        revision: sql`${sources.revision} + 1`, nextSyncAt: new Date(),
      }).where(and(scope(companyId, id), eq(sources.revision, input.revision), or(isNull(sources.leaseToken), lt(sources.leaseExpiresAt, new Date())))).returning();
      if (!updated) throw conflict('This source is refreshing or changed. Reload before saving.', { code: 'skill_source_settings_changed' });
      await context.audit(tx, id, 'company.skill_source_settings_updated', { automaticUpdates: updated.automaticUpdates, importNewSkills: updated.importNewSkills, connectionChanged: input.connectionId !== undefined,
        ...(input.trackingRef !== undefined ? { previousRef: source.trackingRef, trackingRef: updated.trackingRef } : {}) });
      return detail(companyId, id, tx);
    });
  }
  async function disconnect(companyId: string, id: string, context: SkillSourceContext, input: SkillSourceDisconnectRequest): Promise<SkillSourceDisconnectResult> {
    const source = await detail(companyId, id);
    if (source.revision !== input.revision) throw conflict('This source changed. Reload before disconnecting.');
    await context.authorize('skills.edit', { sourceType: 'git', sourceLocator: source.repositoryUrl });
    const skillIds = [...new Set(source.entries.flatMap(entry => entry.skillId ? [entry.skillId] : []))];
    for (const skillId of skillIds) {
      const skill = await skills.getById(companyId, skillId);
      if (!skill) continue;
      const resource = { sourceType: 'git' as const, sourceLocator: source.repositoryUrl, skillId, skillKey: skill.key };
      await context.authorize(input.skills === 'delete' ? 'skills.remove' : 'skills.edit', resource);
      if (input.skills === 'copy') await context.authorize('skills.create', resource);
    }
    async function lock(tx: Tx) {
      const [locked] = await tx.select().from(sources).where(scope(companyId, id)).for('update');
      if (!locked || locked.revision !== input.revision) throw conflict('This source changed. Reload before disconnecting.');
    }
    async function remove(tx: Tx, copiedCount: number, deletedCount: number) {
      // Stop both pending attachments and an in-flight refresh before removing tracking.
      await tx.update(projectSkillSources).set({ active: false, leaseToken: null, leaseExpiresAt: null })
        .where(and(eq(projectSkillSources.companyId, companyId), eq(projectSkillSources.sourceId, id)));
      if (source.accessScope === 'projects') {
        // Copies and forks keep this source identity as their dynamic access boundary.
        await tx.delete(entries).where(and(eq(entries.companyId, companyId), eq(entries.sourceId, id)));
        await tx.update(sources).set({ removedAt: new Date(), enabled: false, automaticUpdates: false,
          revision: sql`${sources.revision} + 1`, leaseToken: null, leaseExpiresAt: null })
          .where(scope(companyId, id));
      } else {
        await tx.delete(sources).where(scope(companyId, id));
      }
      await context.audit(tx, id, 'company.skill_source_disconnected', { skills: input.skills, skillIds, copiedCount, deletedCount });
    }
    if (input.skills === 'delete') {
      const deleted = await skills.deleteSkills(companyId, skillIds, (tx, deleted) => remove(tx, 0, deleted.length), lock);
      return { id, copiedCount: 0, deletedCount: deleted.length };
    }
    let folderId: string | null = null;
    if (skillIds.length && context.actor.type === 'user' && context.actor.userId) {
      const [user] = await db.select({ name: authUsers.name }).from(authUsers).where(eq(authUsers.id, context.actor.userId));
      folderId = (await folderService(db).ensureMyFolder(companyId, context.actor.userId, user?.name ?? null)).id;
    }
    const directories: string[] = [];
    try {
      return await db.transaction(async tx => {
        await tx.execute(sql`SET CONSTRAINTS paperclip_skill_runtime_changed DEFERRED`);
        await lock(tx);
        for (const skillId of skillIds) await skills.makeImportedSkillEditable(companyId, skillId, context.actor, folderId, tx, directories);
        await remove(tx, skillIds.length, 0);
        return { id, copiedCount: skillIds.length, deletedCount: 0 };
      });
    } catch (error) {
      await Promise.all(directories.map(directory => fs.rm(directory, { recursive: true, force: true })));
      throw error;
    }
  }
  async function importFromUrl(companyId: string, input: string, context: SkillSourceContext) {
    const parsed = parseSkillImportSourceInput(input);
    const url = new URL(parsed.resolvedSource);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const repositoryUrl = `https://github.com/${parts[0]}/${parts[1]!.replace(/\.git$/i, '')}`.toLowerCase();
    const previous = (await list(companyId)).filter(source => source.repositoryUrl.toLowerCase() === repositoryUrl);
    let trackingRef: string | undefined;
    let prefix = '';
    let commitSha: string | undefined;
    // Prefer a saved authorization for compatibility imports. Every read still checks this caller.
    const connectionId = previous.find(source => source.enabled)?.connectionId ?? null;
    const read = context.read(connectionId);
    if (parts.length > 2) {
      if (!['tree', 'blob'].includes(parts[2]!)) throw unprocessable('Use a GitHub repository, folder, or SKILL.md URL.');
      const suffix = parts.slice(3);
      // GitHub URLs do not delimit slash-containing refs. Resolve the longest valid ref.
      for (let count = suffix.length; count > 0; count--) {
        const candidate = suffix.slice(0, count).join('/');
        try {
          const commit = await read(`/repos/${parts[0]}/${parts[1]!.replace(/\.git$/i, '')}/commits/${encodeURIComponent(candidate)}`) as { sha: string };
          trackingRef = candidate; commitSha = commit.sha; prefix = suffix.slice(count).join('/'); break;
        } catch (error) {
          if (!(error instanceof Error && 'details' in error && (error.details as { status?: number })?.status === 404)) throw error;
        }
      }
      if (!trackingRef) throw unprocessable('GitHub branch or commit was not found.');
    }
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: repositoryUrl });
    let scan = await scanGitHubSkills({ repositoryUrl, trackingRef, commitSha }, read);
    const existing = previous.find(source => source.trackingRef === scan.trackingRef || (source.trackingRef === 'HEAD' && scan.trackingRef === scan.defaultBranch));
    if (existing?.packageMode === 'repository' || existing?.accessScope === 'projects') {
      scan = await scanGitHubSkills({ repositoryUrl, trackingRef: scan.trackingRef, commitSha: scan.commitSha, packageMode: 'repository' }, read);
    }
    const selectedPaths = scan.candidates.filter(candidate =>
      (!prefix || candidate.path === prefix || candidate.path.startsWith(`${prefix}/`)) &&
      (!parsed.requestedSkillSlug || normalizeAgentUrlKey(candidate.name) === parsed.requestedSkillSlug || candidate.path.split('/').at(-2) === parsed.requestedSkillSlug)
    ).map(candidate => candidate.path);
    if (!selectedPaths.length) throw unprocessable('No matching SKILL.md files were found in this repository.');
    const result = existing
      ? await refresh(companyId, existing.id, context, { revision: existing.revision, selectedPaths: [...new Set([...existing.entries.filter(entry => entry.selection === 'selected').map(entry => entry.path), ...selectedPaths])], excludedFolders: existing.excludedFolders }, scan)
      : await create(companyId, { repositoryUrl: scan.repositoryUrl, trackingRef: scan.trackingRef, commitSha: scan.commitSha, connectionId, selectedPaths }, context, scan);
    const imported = await Promise.all(result.source.entries.filter(entry => selectedPaths.includes(entry.path) && entry.skillId && !entry.error).map(entry => skills.getById(companyId, entry.skillId!)));
    return { imported: imported.filter((skill): skill is CompanySkill => Boolean(skill)), warnings: result.warnings };
  }
  return { list, detail, sourceForSkill, discover, preview, create, refresh, branches, settings, disconnect, importFromUrl };
}
