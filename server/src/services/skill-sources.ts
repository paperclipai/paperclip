import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { companySkillSources as sources, companySkillSourceEntries as entries, companySkills, type Db } from '@paperclipai/db';
import type { CompanySkill, SkillSource, SkillSourceCreateRequest, SkillSourceDiscoveryRequest, SkillSourceSelectionRequest, SkillSourceRefreshResult, SkillSourcePreviewRequest } from '@paperclipai/shared';
import { normalizeAgentUrlKey } from '@paperclipai/shared';
import { conflict, notFound, unprocessable } from '../errors.js';
import { companySkillService, parseSkillImportSourceInput } from './company-skills.js';
import { scanGitHubSkills, previewGitHubSkillFile, type GitHubRead, type ScannedSkillSource, type SkillScanOptions } from './github-skill-source.js';
import { skillSnapshotHash } from './skill-snapshot.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type SourceRow = typeof sources.$inferSelect;
export type SkillSourceContext = {
  actor: { type: 'user' | 'agent' | 'system'; userId?: string | null; agentId?: string | null };
  read: (connectionId: string | null) => GitHubRead;
  authorize: (action: 'skills.import' | 'skills.update' | 'skills.edit', resource: { skillId?: string; skillKey?: string; sourceType: 'git'; sourceLocator: string }) => Promise<void>;
  audit: (tx: Tx, sourceId: string, action: string, details: Record<string, unknown>) => Promise<void>;
};
const scope = (companyId: string, id: string) => and(eq(sources.companyId, companyId), eq(sources.id, id));

export function skillSourceService(db: Db) {
  const skills = companySkillService(db);
  async function row(companyId: string, id: string, database: Db | Tx = db) {
    const [source] = await database.select().from(sources).where(scope(companyId, id));
    if (!source) throw notFound('Skill source not found.');
    return source;
  }
  async function detail(companyId: string, id: string, database: Db | Tx = db): Promise<SkillSource> {
    const { leaseToken: _token, leaseExpiresAt: _expires, createdAt: _created, ...source } = await row(companyId, id, database);
    const selected = await database.select().from(entries).where(and(eq(entries.companyId, companyId), eq(entries.sourceId, id))).orderBy(entries.path);
    return { ...source, entries: selected };
  }
  async function list(companyId: string) {
    const rows = await db.select({ id: sources.id }).from(sources).where(eq(sources.companyId, companyId)).orderBy(sources.fullName);
    return Promise.all(rows.map(source => detail(companyId, source.id)));
  }
  async function sourceForSkill(companyId: string, skillId: string) {
    const [entry] = await db.select().from(entries).where(and(eq(entries.companyId, companyId), eq(entries.skillId, skillId)));
    return entry ? detail(companyId, entry.sourceId) : null;
  }
  async function discover(input: SkillSourceDiscoveryRequest, context: SkillSourceContext, options?: SkillScanOptions) {
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: input.repositoryUrl });
    const { skills: _files, defaultBranch: _defaultBranch, ...result } = await scanGitHubSkills(input, context.read(input.connectionId ?? null), { ...options, retainFiles: false });
    return result;
  }
  async function preview(input: SkillSourcePreviewRequest, context: SkillSourceContext, options?: SkillScanOptions) {
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: input.repositoryUrl });
    return previewGitHubSkillFile(input, context.read(input.connectionId ?? null), options);
  }
  async function authorizeScan(source: SourceRow, scan: ScannedSkillSource, selectedPaths: string[], context: SkillSourceContext) {
    const previous = await db.select().from(entries).where(and(eq(entries.companyId, source.companyId), eq(entries.sourceId, source.id)));
    for (const candidate of scan.skills.filter(candidate => selectedPaths.includes(candidate.path) && !candidate.error)) {
      const old = previous.find(entry => entry.path === candidate.path);
      const skill = old?.skillId ? await skills.getById(source.companyId, old.skillId) : null;
      await context.authorize(skill ? 'skills.update' : 'skills.import', {
        sourceType: 'git', sourceLocator: source.repositoryUrl, ...(skill ? { skillId: skill.id, skillKey: skill.key } : { skillKey: newSkillKey(scan, candidate.path, candidate.name, source.id) }),
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
  function newSkillKey(scan: ScannedSkillSource, skillPath: string, name: string, sourceId: string) {
    const identity = createHash('sha256').update(`${scan.repositoryId}:${sourceId}:${skillPath}`).digest('hex').slice(0, 16);
    return `github/${scan.repositoryId}/${identity}/${normalizeAgentUrlKey(name) || 'skill'}`;
  }
  async function publish(tx: Tx, source: SourceRow, scan: ScannedSkillSource, selectedPaths: string[], excludedFolders: string[], context: SkillSourceContext, selectionReviewed: boolean): Promise<Omit<SkillSourceRefreshResult, 'source'>> {
    const previous = await tx.select().from(entries).where(and(eq(entries.companyId, source.companyId), eq(entries.sourceId, source.id)));
    const imported: CompanySkill[] = [], updated: CompanySkill[] = [];
    const warnings = [...scan.warnings];
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
        const hash = skillSnapshotHash(candidate.files);
        const slug = normalizeAgentUrlKey(candidate.name) || 'skill';
        const key = current?.key ?? newSkillKey(scan, candidate.path, candidate.name, source.id);
        const ownerRepo = scan.fullName.split('/');
        const metadata = { ...(current?.metadata ?? {}), sourceKind: 'github', hostname: 'github.com',
          owner: ownerRepo[0], repo: ownerRepo[1], ref: current?.metadata?.snapshotHash === hash && current.currentVersionId ? current.sourceRef : scan.commitSha, trackingRef: scan.trackingRef,
          repoSkillDir: path.posix.dirname(candidate.path) === '.' ? '' : path.posix.dirname(candidate.path),
          skillSourceId: source.id, skillSourcePath: candidate.path, skillSourceState: 'synced', snapshotHash: hash };
        const values = { name: candidate.name, description: candidate.description, markdown: candidate.files.find(file => file.path === 'SKILL.md')!.content,
          sourceType: 'github', sourceLocator: scan.repositoryUrl, sourceRef: current?.metadata?.snapshotHash === hash && current.currentVersionId ? current.sourceRef : scan.commitSha,
          fileInventory: candidate.files.map(({ path, kind }) => ({ path, kind })),
          trustLevel: candidate.files.some(file => file.kind === 'script' || file.executable) ? 'scripts_executables' : candidate.files.some(file => file.kind === 'asset' || file.kind === 'other') ? 'assets' : 'markdown_only',
          metadata, updatedAt: new Date() };
        const changed = !current?.currentVersionId || current.metadata?.snapshotHash !== hash;
        if (current && changed) await tx.update(companySkills).set(values).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, current.id)));
        else if (!current) {
          const [created] = await tx.insert(companySkills).values({ ...values, companyId: source.companyId, key, slug, installCount: 1 }).returning({ id: companySkills.id });
          skillId = created!.id;
        }
        else if (current.metadata?.skillSourceState !== 'synced') {
          await tx.update(companySkills).set({ metadata }).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, current.id)));
        }
        const installed = (await skills.getById(source.companyId, skillId!, tx))!;
        if (changed) {
          const version = await skills.createVersion(source.companyId, skillId!, { label: `GitHub ${scan.commitSha.slice(0, 8)}` }, context.actor, {
            database: tx, skipInventoryRefresh: true, skill: installed, fileInventory: candidate.files,
          });
          installed.currentVersionId = version.id;
          (current ? updated : imported).push(installed);
        } else unchanged++;
      } else if (current) {
        await tx.update(companySkills).set({ metadata: { ...current.metadata, skillSourceId: source.id, skillSourcePath: candidate.path,
          skillSourceState: selection !== 'selected' ? 'not_syncing' : 'update_failed' } }).where(and(eq(companySkills.companyId, source.companyId), eq(companySkills.id, current.id)));
      }
      if (candidate.error && selection === 'selected') warnings.push(`${candidate.path}: ${candidate.error}`);
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
    // Two old imports can represent distinct installed skills under HEAD and an
    // explicit branch. Keep HEAD as Git's default-branch alias when resolving it
    // would collide; merging their entries could discard skill IDs or selections.
    const [existingBranch] = source.trackingRef === 'HEAD' ? await tx.select({ id: sources.id }).from(sources).where(and(
      eq(sources.companyId, source.companyId), eq(sources.trackingRef, scan.trackingRef),
      or(eq(sources.repositoryId, scan.repositoryId), eq(sources.repositoryUrl, scan.repositoryUrl)),
    )) : [];
    await tx.update(sources).set({ repositoryId: scan.repositoryId, repositoryUrl: scan.repositoryUrl, fullName: scan.fullName,
      trackingRef: existingBranch ? 'HEAD' : scan.trackingRef, excludedFolders, lastSuccessAt: new Date(), lastScanCommit: scan.commitSha, lastError: warnings.length ? `${warnings.length} warning(s). Review the source’s skills.` : null,
      revision: source.revision + 1, leaseToken: null, leaseExpiresAt: null }).where(scope(source.companyId, source.id));
    await context.audit(tx, source.id, 'company.skill_source_refreshed', { commit: scan.commitSha, importedCount: imported.length, updatedCount: updated.length, unchanged, warningCount: warnings.length });
    return { imported, updated, unchanged, warnings };
  }
  async function create(companyId: string, input: SkillSourceCreateRequest, context: SkillSourceContext, staged?: ScannedSkillSource) {
    await context.authorize('skills.import', { sourceType: 'git', sourceLocator: input.repositoryUrl });
    const scan = staged ?? await scanGitHubSkills(input, context.read(input.connectionId ?? null));
    if (scan.trackingRef === scan.defaultBranch && (await list(companyId)).some(source => source.repositoryUrl.toLowerCase() === scan.repositoryUrl.toLowerCase() && source.trackingRef === 'HEAD')) {
      throw conflict('This repository is already in Sources. Manage its skills there.');
    }
    const id = randomUUID();
    // New imports are authorized per generated skill identity too, before publishing.
    for (const candidate of scan.skills.filter(candidate => input.selectedPaths.includes(candidate.path) && !candidate.error)) {
      await context.authorize('skills.import', { sourceType: 'git', sourceLocator: scan.repositoryUrl,
        skillKey: newSkillKey(scan, candidate.path, candidate.name, id) });
    }
    return db.transaction(async tx => {
      const [source] = await tx.insert(sources).values({ id, companyId, repositoryId: scan.repositoryId, repositoryUrl: scan.repositoryUrl, fullName: scan.fullName,
        trackingRef: scan.trackingRef, connectionId: scan.connectionId ?? input.connectionId ?? null, lastAttemptAt: new Date() }).onConflictDoNothing().returning();
      if (!source) throw conflict('This repository and branch are already in Sources. Manage its skills there.');
      const result = await publish(tx, source, scan, input.selectedPaths, input.excludedFolders ?? [], context, true);
      return { ...result, source: await detail(companyId, id, tx) };
    });
  }
  async function refresh(companyId: string, id: string, context: SkillSourceContext, selection?: SkillSourceSelectionRequest, staged?: ScannedSkillSource) {
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
      const current = await detail(companyId, id);
      const includedReferences = selection?.includedReferences ?? Object.fromEntries(current.entries.map(entry => [entry.path, entry.inspection?.includedReferences ?? []]));
      const scan = staged && !Object.values(includedReferences).some(paths => paths.length) ? staged
        : await scanGitHubSkills({ repositoryUrl: source.repositoryUrl, trackingRef: source.trackingRef, ...(staged ? { commitSha: staged.commitSha } : {}), includedReferences }, context.read(connectionId));
      if (source.repositoryId && source.repositoryId !== scan.repositoryId) throw conflict('The repository at this URL has changed identity. Add it as a new source.');
      const selectedPaths = selection?.selectedPaths ?? current.entries.filter(entry => entry.selection === 'selected').map(entry => entry.path);
      await authorizeScan(source, scan, selectedPaths, context);
      return await db.transaction(async tx => {
        const [locked] = await tx.select().from(sources).where(scope(companyId, id)).for('update');
        if (!locked || locked.leaseToken !== token || locked.revision !== source.revision || locked.leaseExpiresAt! < new Date()) throw conflict('Source refresh expired or changed. Try again.');
        const result = await publish(tx, locked, scan, selectedPaths, selection?.excludedFolders ?? source.excludedFolders, context, Boolean(selection));
        if (selection || scan.connectionId !== undefined) await tx.update(sources).set({ ...(selection ? { enabled: true } : {}), connectionId: scan.connectionId ?? connectionId }).where(scope(companyId, id));
        return { ...result, source: await detail(companyId, id, tx) };
      });
    } catch (error) {
      // Provider errors have already been sanitized. Never persist arbitrary exception text.
      const message = error instanceof Error && 'status' in error ? error.message : 'Refresh failed. The installed skills were kept. Try again.';
      await db.update(sources).set({ leaseToken: null, leaseExpiresAt: null, lastError: message }).where(and(scope(companyId, id), eq(sources.leaseToken, token)));
      throw error;
    }
  }
  async function disconnect(companyId: string, id: string, context: SkillSourceContext) {
    const source = await row(companyId, id);
    await context.authorize('skills.edit', { sourceType: 'git', sourceLocator: source.repositoryUrl });
    await authorizeSelection(source, [], context);
    return db.transaction(async tx => {
      await tx.select().from(sources).where(scope(companyId, id)).for('update');
      await tx.update(sources).set({ enabled: false, revision: sql`${sources.revision} + 1`, leaseToken: null, leaseExpiresAt: null }).where(scope(companyId, id));
      for (const entry of (await detail(companyId, id, tx)).entries) {
        if (!entry.skillId) continue;
        const skill = await skills.getById(companyId, entry.skillId, tx);
        if (skill) await tx.update(companySkills).set({ metadata: { ...skill.metadata, skillSourceId: id, skillSourceState: 'not_syncing' } }).where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, skill.id)));
      }
      await context.audit(tx, id, 'company.skill_source_disconnected', {});
      return detail(companyId, id, tx);
    });
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
    const scan = await scanGitHubSkills({ repositoryUrl, trackingRef, commitSha }, read);
    const existing = previous.find(source => source.trackingRef === scan.trackingRef || (source.trackingRef === 'HEAD' && scan.trackingRef === scan.defaultBranch));
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
  return { list, detail, sourceForSkill, discover, preview, create, refresh, disconnect, importFromUrl };
}
