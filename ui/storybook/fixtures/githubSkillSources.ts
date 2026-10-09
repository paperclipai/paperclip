import { parseGitHubSkillRepositoryUrl } from "@paperclipai/shared";
import type { AgentDesiredSkillEntry, CompanySkillDetail, CompanySkillListItem, CompanySkillVersion, CompanySkill, SkillSource, SkillPackageInspection, SkillSourceCandidate, SkillSourceEntry, SkillSourceRefreshResult, SkillRepositoryPackage } from "@paperclipai/shared";
import { companySkillsApi } from "@/api/companySkills";
import { agentsApi } from "@/api/agents";
import { foldersApi } from "@/api/folders";
import { storybookAgents } from "./paperclipData";
import { skillSourcesApi } from "@/api/skillSources";

export const COMPANY_ID = "company-storybook";
export const SOURCE_ID = "source-team-skills";
export const COMMIT = "a17d36c9e4521f06b932ac670854d1293f24bc18";
const fixtureSkillId = (entryId: string) => `00000000-0000-4000-8000-${entryId.replace('entry-', '').padStart(12, '0')}`;
const packageContents: Record<string, Record<string, string | null>> = {
  'SKILL.md': { 'SKILL.md': '---\nname: Team handbook\ndescription: Shared team conventions\n---\nRead [team conventions](references/conventions.md) before starting.\n', 'references/conventions.md': '# Team conventions\n\nKeep changes company-scoped. Report evidence with each review.\n', 'LICENSE': 'Example license text' },
  '.agents/skills/review/SKILL.md': { 'SKILL.md': '---\nname: Code review\ndescription: Review code changes\ncompatibility: Requires Python 3.11 and git.\n---\nRead [the checklist](references/checklist.md). Run `scripts/review.py` when a diff is ready.\n', 'references/checklist.md': '# Review checklist\n\n- Check company boundaries.\n- Test failure handling.\n- Verify migrations.\n', 'scripts/review.py': '#!/usr/bin/env python3\nprint("Ready to review the diff")\n', 'assets/diagram.png': null, 'LICENSE': 'Example license text' },
  '.agents/skills/review/security/SKILL.md': { 'SKILL.md': '---\nname: Security review\ndescription: Review authentication boundaries\ncompatibility: Requires Python 3.11.\n---\nRead [policy](../../shared/policy.md) and [threat model](references/threat-model.md).\n', 'scripts/check.py': '#!/usr/bin/env python3\nprint("Check company boundaries")\n', 'references/checklist.md': '# Security checklist\n\n- Validate caller access.\n- Preserve company boundaries.\n' },
  'skills/research/SKILL.md': { 'SKILL.md': '---\nname: Research\ndescription: Gather primary sources\n---\nRead [method](references/method.md).\n', 'references/method.md': '# Research method\n\nStart with primary sources.\n' },
  'experimental/deploy/SKILL.md': { 'SKILL.md': '---\nname: Deploy preview\n---\nDeploy the app.', 'README.md': '# Deployment notes' },
};
function inspection(skillPath: string): SkillPackageInspection {
  return {
    commitSha: COMMIT,
    files: Object.entries(packageContents[skillPath]!).map(([path, content]) => ({ path, kind: path === 'SKILL.md' ? 'skill' : path.startsWith('scripts/') ? 'script' : path.startsWith('assets/') ? 'asset' : 'reference', encoding: content === null ? 'base64' : 'utf8', sizeBytes: content === null ? 2048 : new TextEncoder().encode(content).length, executable: path.startsWith('scripts/') })),
    requirements: skillPath.includes('/security/') ? 'Requires Python 3.11.' : skillPath.includes('/review/') ? 'Requires Python 3.11 and git.' : null,
    references: skillPath.includes('/security/') ? [
      { fromPath: 'SKILL.md', target: '../../shared/policy.md', resolvedPath: '.agents/skills/shared/policy.md', kind: 'outside_package' },
      { fromPath: 'SKILL.md', target: 'references/threat-model.md', resolvedPath: '.agents/skills/review/security/references/threat-model.md', kind: 'missing' },
    ] : [],
    warnings: skillPath.includes('/review/') ? ['Skill includes a script file.'] : [],
  };
}
export const candidates: SkillSourceCandidate[] = [
  { path: "SKILL.md", name: "Team handbook", description: "Shared conventions and context for every agent.", error: null },
  { path: ".agents/skills/review/SKILL.md", name: "Code review", description: "Review changes for correctness and maintainability.", error: null },
  { path: ".agents/skills/review/security/SKILL.md", name: "Security review", description: "Inspect authentication and company boundaries.", error: null },
  { path: "skills/research/SKILL.md", name: "Research", description: "Gather primary sources and write a concise brief.", error: null },
  { path: "experimental/deploy/SKILL.md", name: "Deploy preview", description: null, error: "Missing required description in SKILL.md frontmatter." },
].map(candidate => ({ ...candidate, inspection: inspection(candidate.path), fileCount: Object.keys(packageContents[candidate.path]!).length, warnings: [] }));

export const repositoryContents: Record<string, string | null> = Object.fromEntries(
  Object.entries(packageContents).filter(([root]) => !root.startsWith('experimental/')).flatMap(([root, files]) =>
    Object.entries(files).map(([file, content]) => [root.replace(/SKILL.md$/, '') + file, content])),
);
Object.assign(repositoryContents, {
  '.agents/skills/shared/policy.md': '# Shared policy\n\nCheck company boundaries before changing access.',
  '.agents/skills/review/security/references/threat-model.md': '# Threat model\n\nReview caller authorization.',
  'NOTICE.md': 'Example upstream credits are preserved with this repository.',
  'paperclip.skills.json': JSON.stringify({ version: 1, skills: ['.agents/skills/review/SKILL.md', 'skills/research/SKILL.md'], requirements: 'Python 3.11 and Git. Configure GitHub access for agents that review pull requests.' }, null, 2),
});
export function repositoryFixture(blocked = false): SkillRepositoryPackage {
  return { files: Object.entries(repositoryContents).map(([path, content]) => ({ path, kind: path.endsWith('SKILL.md') ? 'skill' : 'reference', encoding: content === null ? 'base64' : 'utf8', sizeBytes: content?.length ?? 2048, executable: path.endsWith('.py') })),
    skillPaths: ['.agents/skills/review/SKILL.md', 'skills/research/SKILL.md'], requirements: 'Python 3.11 and Git. Configure GitHub access for agents that review pull requests.',
    error: blocked ? 'Unsupported symlink or submodule: shared/tools' : null, warnings: [] };
}
export function repositoryCandidates(blocked = false): SkillSourceCandidate[] {
  return candidates.filter(candidate => !candidate.error).map(candidate => ({ ...candidate, error: repositoryFixture(blocked).error,
    inspection: candidate.inspection ? { ...candidate.inspection, references: [] } : undefined }));
}

export function sourceFixture(): SkillSource {
  return {
    id: SOURCE_ID, companyId: COMPANY_ID, repositoryId: "123456",
    repositoryUrl: "https://github.com/acme/team-skills", fullName: "acme/team-skills",
    trackingRef: "main", connectionId: "github-storybook", excludedFolders: ["experimental"],
    enabled: true, revision: 1, lastAttemptAt: new Date(), lastSuccessAt: new Date(),
    lastScanCommit: COMMIT, lastError: null,
    entries: candidates.map((candidate, index) => ({
      id: `entry-${index}`, sourceId: SOURCE_ID, path: candidate.path, name: candidate.name,
      description: candidate.description, inspection: candidate.inspection, error: candidate.error, present: true,
      skillId: index < 2 ? fixtureSkillId(`entry-${index}`) : null,
      selection: index < 2 ? "selected" : index === 4 ? "excluded" : "new",
    })),
  };
}

export function importedSkill(source: SkillSource, entry: SkillSourceEntry): CompanySkill {
  return {
    id: entry.skillId!, companyId: COMPANY_ID, key: `github/${source.id}/${entry.path}`,
    slug: entry.name.toLowerCase().replaceAll(" ", "-"), name: entry.name, description: entry.description,
    markdown: `---\nname: ${entry.name}\ndescription: ${entry.description}\n---\n\n# ${entry.name}\n\n${entry.description}\n\n## Workflow\n\n1. Read the task and the relevant project context.\n2. Follow the checklist in references/checklist.md.\n3. Report findings with evidence and clear next steps.\n`, sourceType: "github", sourceLocator: source.repositoryUrl, sourceRef: COMMIT,
    trustLevel: "assets", compatibility: "compatible", fileInventory: [{ path: "SKILL.md", kind: "skill" }, { path: "references/checklist.md", kind: "reference" }],
    iconUrl: null, color: null, tagline: null, authorName: null, homepageUrl: null,
    categories: [], sharingScope: "company", publicShareToken: null, forkedFromSkillId: null,
    forkedFromCompanyId: null, starCount: 0, installCount: 0, forkCount: 0,
    currentVersionId: `version-${entry.id}`, metadata: { skillSourceId: source.id, skillSourcePath: entry.path, skillSourceState: "synced" }, createdAt: new Date(), updatedAt: new Date(),
  };
}

export type RepositoryScenario = 'single' | 'multiple' | 'none' | 'empty' | 'partial-error' | 'error' | 'loading';

/** Scoped API fixtures keep the production page interactive without contacting GitHub. */
export function installFixtures(empty: boolean, needsConnection: boolean, options: { packageScenario?: 'ready' | 'blocked'; journey?: boolean; refreshed?: boolean; assigned?: boolean; repositories?: RepositoryScenario; scan?: "live" | "large" | "interrupted"; saving?: boolean } = {}) {
  const fixtureController = new AbortController();
  const wait = (ms: number, signal = fixtureController.signal) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const stop = () => { clearTimeout(timer); reject(new DOMException('Scan cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
  });
  const original = { ...skillSourcesApi };
  const sources = empty ? [] : [sourceFixture()];
  const originalSkills = { ...companySkillsApi };
  const originalAgents = { ...agentsApi };
  const originalFolders = { ...foldersApi };
  const discoveryCandidates = options.packageScenario ? repositoryCandidates() : options.journey ? candidates.filter(candidate => !candidate.path.includes('/security/')) : candidates;
  const assigned = new Map<string, AgentDesiredSkillEntry[]>();
  const demoAgents = storybookAgents.slice(0, 3).map(agent => ({ ...agent, adapterType: 'codex_local' }));
  if (options.journey && sources[0]) {
    sources[0].entries = sources[0].entries.filter(entry => options.refreshed || !entry.path.includes('/security/')).map(entry => ({
      ...entry,
      skillId: entry.error || entry.path.includes('/security/') ? null : fixtureSkillId(entry.id),
      selection: entry.error ? 'excluded' : entry.path.includes('/security/') ? 'new' : 'selected',
    }));
  }
  const sourceSkills = () => sources.flatMap(source => source.entries.filter(entry => entry.skillId).map(entry => importedSkill(source, entry)));
  if (options.assigned && demoAgents[0]) {
    const review = sourceSkills().find(skill => skill.slug === 'code-review');
    if (review) assigned.set(demoAgents[0].id, [{ key: review.key, versionId: null }]);
  }
  function detail(id: string): CompanySkillDetail {
    const skill = sourceSkills().find(skill => skill.id === id);
    if (!skill) throw new Error('This skill is not installed in the preview.');
    const usedByAgents = demoAgents.filter(agent => assigned.get(agent.id)?.some(entry => entry.key === skill.key)).map(agent => ({
      id: agent.id, name: agent.name, urlKey: agent.urlKey, adapterType: agent.adapterType,
      desired: true, actualState: null, versionId: assigned.get(agent.id)?.find(entry => entry.key === skill.key)?.versionId ?? null,
    }));
    return { ...skill, attachedAgentCount: usedByAgents.length, usedByAgents, existingForks: [], editable: false,
      editableReason: 'This skill is synced from GitHub. Make a copy to edit it.', sourceLabel: 'GitHub', sourceBadge: 'github',
      sourcePath: String(skill.metadata?.skillSourcePath), currentVersion: version(skill), starredByCurrentActor: false };
  }
  function version(skill: CompanySkill): CompanySkillVersion {
    return { id: skill.currentVersionId!, companyId: COMPANY_ID, companySkillId: skill.id, revisionNumber: 1,
      label: null, releaseId: null, releaseName: null, releasedAt: null, authorAgentId: null, authorUserId: 'user-board', createdAt: skill.createdAt,
      fileInventory: [{ path: 'SKILL.md', kind: 'skill', content: skill.markdown }, { path: 'references/checklist.md', kind: 'reference', content: '# Checklist\n\n- Check company boundaries.\n- Verify failure handling.\n- Include evidence in the review.' }],
    };
  }
  if (options.journey) {
    companySkillsApi.list = async () => sourceSkills().map(skill => ({ ...detail(skill.id), catalogKind: null, originHash: null, packageName: null, packageVersion: null } satisfies CompanySkillListItem));
    companySkillsApi.detail = async (_companyId, id) => detail(id);
    companySkillsApi.categories = async () => [];
    companySkillsApi.catalogList = async () => [];
    companySkillsApi.versions = async (_companyId, id) => [version(detail(id))];
    companySkillsApi.file = async (_companyId, id, path) => ({ skillId: id, path, kind: path === 'SKILL.md' ? 'skill' : 'reference',
      content: version(detail(id)).fileInventory.find(file => file.path === path)?.content ?? '', language: 'markdown', markdown: true, editable: false });
    companySkillsApi.updateStatus = async () => ({ supported: true, reason: null, trackingRef: 'main', currentRef: COMMIT, latestRef: COMMIT,
      hasUpdate: false, installedHash: null, originHash: null, userModifiedAt: null, updateHoldReason: null, auditVerdict: null, auditCodes: [] });
    companySkillsApi.comments = async () => [];
    companySkillsApi.testInputs = async () => [];
    companySkillsApi.testRuns = async () => [];
    companySkillsApi.testRunTemplates = async () => [];
    companySkillsApi.forkPrecheck = async (_companyId, id) => {
      const skill = detail(id);
      return { skillId: id, original: { id, name: skill.name, slug: skill.slug, sourceType: skill.sourceType, sourceLocator: skill.sourceLocator, sourceRef: skill.sourceRef }, agentUsageCount: skill.attachedAgentCount, usedByAgents: skill.usedByAgents, existingForks: [] };
    };
    foldersApi.list = async () => ({ kind: 'skill', folders: [], allCount: sourceSkills().length, unfiledCount: sourceSkills().length });
    agentsApi.list = async () => structuredClone(demoAgents);
    agentsApi.skills = async id => ({ adapterType: 'codex_local', supported: true, mode: 'persistent', desiredSkills: (assigned.get(id) ?? []).map(entry => entry.key), desiredSkillEntries: assigned.get(id) ?? [], entries: [], warnings: [] });
    agentsApi.syncSkills = async (id, entries) => {
      assigned.set(id, entries.map(entry => typeof entry === 'string' ? { key: entry, versionId: null } : entry));
      return agentsApi.skills(id);
    };
  }
  if (needsConnection && sources[0]) sources[0].lastError = "GitHub access is no longer available. Reconnect GitHub or choose another connection.";
  function save(source: SkillSource, selectedPaths: string[], excludedFolders: string[]): SkillSourceRefreshResult {
    const imported: CompanySkill[] = [];
    const warnings: string[] = [];
    let unchanged = 0;
    source.entries = source.entries.map(entry => {
      const selected = selectedPaths.includes(entry.path);
      const next: SkillSourceEntry = { ...entry, selection: selected ? "selected" : "excluded" };
      if (selected && entry.error) warnings.push(`${entry.path}: ${entry.error}`);
      else if (selected && !entry.skillId) {
        next.skillId = fixtureSkillId(entry.id);
        imported.push(importedSkill(source, next));
      } else if (selected) unchanged++;
      return next;
    });
    Object.assign(source, { excludedFolders, enabled: true, revision: source.revision + 1, lastAttemptAt: new Date(), lastSuccessAt: new Date(), lastError: null });
    return structuredClone({ source, imported, updated: [], unchanged, warnings });
  }
  skillSourcesApi.list = async () => structuredClone(sources);
  const repositoryScenario = options.repositories ?? 'single';
  skillSourcesApi.repositories = async () => {
    if (repositoryScenario === 'loading') return new Promise(() => {});
    if (repositoryScenario === 'error') throw new Error('GitHub is temporarily unavailable. Try again.');
    const personal = { id: 'github-storybook', name: 'My GitHub account' };
    const shared = { id: 'github-acme', name: 'Acme engineering' };
    const connections = repositoryScenario === 'none' ? [] : repositoryScenario === 'multiple' || repositoryScenario === 'partial-error' ? [personal, shared] : [personal];
    const repo = (id: string, fullName: string, privateRepo: boolean, accounts = [personal]) => ({
      id, fullName, private: privateRepo, url: `https://github.com/${fullName}`,
      connections: accounts.map(account => account.name), connectionIds: accounts.map(account => account.id),
    });
    return {
      connections, connectionCount: connections.length, failedConnectionCount: repositoryScenario === 'partial-error' ? 1 : 0,
      repositories: ['none', 'empty'].includes(repositoryScenario) ? [] : repositoryScenario === 'multiple' ? [
        repo('234567', 'acme/agent-playbooks', true, [shared]),
        repo('345678', 'acme/design-system', false, [shared]),
        repo('456789', 'acme/engineering', true, [shared]),
        // One row even though two authorized connections can access this repository.
        repo('123456', 'acme/team-skills', true, [personal, shared]),
        repo('567890', 'maya/research-skills', false),
        repo('678901', 'maya/writing-tools', true),
      ] : [repo('123456', 'acme/team-skills', true)],
    };
  };
  skillSourcesApi.discover = async (_companyId, input) => {
    const parsed = parseGitHubSkillRepositoryUrl(input.repositoryUrl);
    if (!parsed) throw new Error('Enter an HTTPS GitHub repository or branch URL.');
    return {
      repositoryId: '123456', repositoryUrl: parsed.repositoryUrl, fullName: parsed.fullName,
      trackingRef: input.trackingRef || parsed.trackingRef || 'main', commitSha: COMMIT, candidates: input.packageMode === 'repository' && options.packageScenario ? repositoryCandidates(options.packageScenario === 'blocked') : discoveryCandidates, warnings: [],
      packageMode: input.packageMode, ...(input.packageMode === 'repository' ? { repositoryPackage: repositoryFixture(options.packageScenario === 'blocked') } : {}),
    };
  };
  skillSourcesApi.discoverStream = async (companyId, input, onProgress, signal) => {
    const active = signal ? AbortSignal.any([signal, fixtureController.signal]) : fixtureController.signal;
    const result = await skillSourcesApi.discover(companyId, input);
    const progress = { type: 'progress' as const, phase: 'connecting' as 'connecting' | 'downloading' | 'listing' | 'checking', totalSkills: null as number | null, checkedSkills: 0, currentPath: null as string | null, checkedFiles: 0, totalFiles: null as number | null };
    onProgress({ ...progress });
    await wait(options.scan ? 900 : 100, active);
    progress.phase = 'downloading';
    for (const percent of [12, 38, 64, 88, 100]) {
      onProgress({ ...progress, download: { stage: 'receiving', percent, receivedBytes: Math.round(percent / 100 * 28 * 1024 * 1024) } });
      await wait(options.scan ? 500 : 20, active);
    }
    onProgress({ ...progress, download: { stage: 'resolving', percent: 70 } });
    await wait(options.scan ? 600 : 20, active);
    progress.phase = 'listing'; onProgress({ ...progress });
    await wait(options.scan ? 1200 : 100, active);
    progress.phase = 'checking'; progress.totalSkills = options.scan === 'large' ? 128 : result.candidates.length;
    for (const candidate of result.candidates) {
      progress.currentPath = candidate.path; progress.checkedFiles = 0; progress.totalFiles = candidate.fileCount;
      onProgress({ ...progress });
      for (const file of candidate.inspection?.files ?? []) {
        progress.currentPath = `${candidate.path.replace(/SKILL.md$/, '')}${file.path}`;
        onProgress({ ...progress });
        await wait(options.scan ? 350 : 50, active);
        progress.checkedFiles++;
      }
      onProgress({ type: 'candidate', candidate });
      progress.checkedSkills++; onProgress({ ...progress });
      if (options.scan === 'interrupted' && progress.checkedSkills === 2) throw new Error('GitHub is temporarily unavailable. Try again.');
    }
    if (options.scan === 'large') {
      progress.totalFiles = 72; progress.checkedFiles = 0;
      for (let file = 0; file < 72; file++) {
        progress.currentPath = `skills/document-processing/references/guide-${file + 1}.md`;
        progress.checkedFiles = file; onProgress({ ...progress }); await wait(1000, active);
      }
      await wait(3600000, active);
    }
    return result;
  };
  skillSourcesApi.preview = async (_companyId, input) => {
    const file = (input.packageMode === 'repository' ? repositoryFixture().files : inspection(input.skillPath).files).find(file => file.path === input.filePath);
    if (!file) throw new Error('File is not included in this package.');
    return { file, content: input.packageMode === 'repository' ? repositoryContents[input.filePath]! : packageContents[input.skillPath]![input.filePath]!, truncated: false, commitSha: input.commitSha };
  };
  skillSourcesApi.create = async (_companyId, input) => {
    if (options.saving) await wait(3600000);
    const source = sourceFixture();
    Object.assign(source, { id: `source-${sources.length + 1}`, packageMode: input.packageMode, repositoryPackage: input.packageMode === 'repository' ? repositoryFixture() : null, repositoryUrl: input.repositoryUrl, fullName: input.repositoryUrl.replace("https://github.com/", ""), trackingRef: input.trackingRef || "main", connectionId: input.connectionId ?? null });
    source.entries = source.entries.filter(entry => discoveryCandidates.some(candidate => candidate.path === entry.path)).map(entry => ({ ...entry, sourceId: source.id, skillId: null }));
    sources.push(source);
    return save(source, input.selectedPaths, input.excludedFolders ?? []);
  };
  skillSourcesApi.select = async (_companyId, id, input) => {
    const source = sources.find(item => item.id === id)!;
    source.connectionId = input.connectionId ?? null;
    source.packageMode = input.packageMode ?? source.packageMode;
    source.repositoryPackage = source.packageMode === 'repository' ? repositoryFixture() : null;
    return save(source, input.selectedPaths, input.excludedFolders);
  };
  skillSourcesApi.refresh = async (_companyId, id) => {
    const source = sources.find(item => item.id === id)!;
    if (needsConnection) throw new Error(source.lastError ?? "Reconnect GitHub to refresh this source.");
    if (options.journey && !source.entries.some(entry => entry.path.includes('/security/'))) {
      source.entries.push({ ...sourceFixture().entries[2]!, sourceId: source.id });
      source.revision++;
    }
    source.lastAttemptAt = new Date();
    source.lastSuccessAt = new Date();
    return structuredClone({ source, imported: [], updated: [], unchanged: source.entries.filter(entry => entry.selection === "selected").length, warnings: [] });
  };
  skillSourcesApi.disconnect = async (_companyId, id) => {
    const source = sources.find(item => item.id === id)!;
    source.enabled = false;
    return structuredClone(source);
  };
  return () => {
    fixtureController.abort();
    Object.assign(skillSourcesApi, original);
    Object.assign(companySkillsApi, originalSkills);
    Object.assign(agentsApi, originalAgents);
    Object.assign(foldersApi, originalFolders);
  };
}
