// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillSources } from './SkillSources';
import { skillSourcesApi } from '@/api/skillSources';
import { ApiError } from '@/api/client';
import { sourceFixture } from '../../storybook/fixtures/githubSkillSources';

const context = vi.hoisted(() => ({ navigate: vi.fn(), breadcrumbs: vi.fn(), sourceId: 'new', streamlinedEnabled: true }));
vi.mock('@/context/CompanyContext', () => ({ useCompany: () => ({ selectedCompanyId: 'company-1', selectedCompany: { name: 'Acme' } }) }));
vi.mock('@/context/BreadcrumbContext', () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: context.breadcrumbs }) }));
vi.mock('@/lib/router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => context.navigate,
  useParams: () => ({ sourceId: context.sourceId }),
}));
vi.mock('@/api/skillSources', () => ({ skillSourcesApi: { list: vi.fn(), projectRepositories: vi.fn(), adoptProject: vi.fn(), settings: vi.fn(), branches: vi.fn(), repositories: vi.fn(), discoverStream: vi.fn(), create: vi.fn(), select: vi.fn(), refresh: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@/hooks/useStreamlinedUiEnabled', () => ({ useStreamlinedUiEnabled: () => ({ enabled: context.streamlinedEnabled, loaded: true }) }));

const repos = {
  connections: [{ id: 'personal', name: 'Personal' }, { id: 'shared', name: 'Engineering' }],
  connectionCount: 2, failedConnectionCount: 0,
  repositories: [
    { id: '1', fullName: 'acme/team-skills', url: 'https://github.com/acme/team-skills', private: true, connections: ['Personal', 'Engineering'], connectionIds: ['personal', 'shared'] },
    { id: '2', fullName: 'acme/design', url: 'https://github.com/acme/design', private: true, connections: ['Engineering'], connectionIds: ['shared'] },
  ],
};
const discovery = { repositoryId: '1', repositoryUrl: 'https://github.com/acme/team-skills', fullName: 'acme/team-skills', trackingRef: 'feature/new-skills', commitSha: 'a'.repeat(40), candidates: [], warnings: [] };
let root: Root;
let host: HTMLDivElement;
let client: QueryClient;
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount() {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><SkillSources /></QueryClientProvider>));
  await flush(); await flush();
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === text)!; }
async function input(selector: string, value: string) {
  await act(async () => {
    const element = document.querySelector<HTMLInputElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  vi.mocked(skillSourcesApi.list).mockResolvedValue([]);
  vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([]);
  vi.mocked(skillSourcesApi.repositories).mockResolvedValue(structuredClone(repos));
  vi.mocked(skillSourcesApi.branches).mockResolvedValue({ defaultBranch: 'master', branches: [{ name: 'master', isDefault: true }], truncated: false });
  vi.mocked(skillSourcesApi.discoverStream).mockResolvedValue(discovery);
  context.sourceId = 'new';
  context.streamlinedEnabled = true;
  sessionStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe('GitHub skill source import', () => {
  it('keeps the Skills views available while managing Sources', async () => {
    context.sourceId = '';
    await mount();
    const navigation = document.querySelector('nav[aria-label="Skills views"]');
    expect([...navigation!.querySelectorAll('a')].map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Installed', '/skills'],
      ['Discover', '/skills?tab=discover'],
      ['My Skills', '/skills/studio'],
    ]);
    expect(navigation!.querySelector('[aria-current="page"]')).toBeNull();
  });

  it('groups the same repository and ref across projects and shows import progress until it is installed', async () => {
    context.sourceId = '';
    const repository = { projectId: 'one', projectName: 'Paperclip', projectVisibility: 'open' as const,
      workspaceId: 'workspace-one', repositoryUrl: 'https://github.com/acme/skills', trackingRef: 'HEAD',
      bindingId: null, sourceId: null, status: 'available' as const, lastError: null };
    vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([repository, { ...repository, projectId: 'two', projectName: 'Sentry', workspaceId: 'workspace-two' }]);
    let finish!: (value: { bindingId: string }) => void;
    vi.mocked(skillSourcesApi.adoptProject).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ bindingId: 'binding-two' });
    await mount();
    expect(document.querySelectorAll('[aria-label="Project repositories"] section')).toHaveLength(1);
    expect(document.body.textContent).toContain('Paperclip, Sentry');
    await act(async () => button('Import skills').click()); await flush();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Starting import');
    vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([
      { ...repository, status: 'pending' }, { ...repository, projectId: 'two', projectName: 'Sentry', workspaceId: 'workspace-two', status: 'pending' },
    ]);
    await act(async () => finish({ bindingId: 'binding-one' })); await flush();
    expect(skillSourcesApi.adoptProject).toHaveBeenCalledWith('company-1', 'workspace-two');
    expect(document.querySelector('[role="status"]')?.textContent).toContain('queued');
    expect(button('Importing…').disabled).toBe(true);
  });

  it('offers branch repair rather than connection repair for an unavailable tracked ref', async () => {
    context.sourceId = '';
    const source = { ...sourceFixture(), trackingRef: 'main', lastError: 'The tracked GitHub branch or revision is unavailable. Use the repository’s default branch or update its configured ref.' };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([{ ...source, repairAction: 'branch' }]);
    vi.mocked(skillSourcesApi.settings).mockResolvedValue({ ...source, trackingRef: 'master', lastError: null });
    await mount();
    expect(button('Choose connection')).toBeUndefined();
    await act(async () => button('Choose a new branch').click()); await flush();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Branch"]')!.click()); await flush();
    await act(async () => (document.querySelector('[cmdk-item][data-value="master"]') as HTMLElement).click()); await flush();
    await act(async () => button('Change branch').click()); await flush();
    expect(skillSourcesApi.branches).toHaveBeenCalledWith('company-1', source.id, {}, expect.any(AbortSignal));
    expect(skillSourcesApi.settings).toHaveBeenCalledWith('company-1', source.id, { revision: source.revision, trackingRef: 'master' });
  });

  it.each([
    'This repository and branch are already in Sources. Use that source; installed skills were kept.',
    'The repository at this URL has changed identity. Add it as a new source.',
  ])('preserves actionable branch conflict advice: %s', async message => {
    context.sourceId = '';
    const source = { ...sourceFixture(), trackingRef: 'main', lastError: 'Unavailable branch.', repairAction: 'branch' as const };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([source]);
    vi.mocked(skillSourcesApi.settings).mockRejectedValue(new ApiError(message, 409, {}));
    await mount();
    await act(async () => button('Choose a new branch').click()); await flush();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Branch"]')!.click()); await flush();
    await act(async () => (document.querySelector('[cmdk-item][data-value="master"]') as HTMLElement).click()); await flush();
    await act(async () => button('Change branch').click()); await flush();
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(message);
    expect(document.querySelector('button[aria-label="Branch"]')?.textContent).toContain('master');
  });

  it('keeps an existing source compact while project import is pending', async () => {
    context.sourceId = '';
    vi.mocked(skillSourcesApi.list).mockResolvedValue([{ ...sourceFixture(), trackingRef: 'HEAD', projects: [{ id: 'paperclip', name: 'Paperclip', visibility: 'open', active: true }] }]);
    vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([{ projectId: 'sentry', projectName: 'Sentry', projectVisibility: 'open',
      workspaceId: 'second-workspace', repositoryUrl: sourceFixture().repositoryUrl, trackingRef: 'HEAD', bindingId: 'binding', sourceId: null, status: 'pending', lastError: null }]);
    await mount();
    expect(document.querySelectorAll(`a[href="${sourceFixture().repositoryUrl}"]`)).toHaveLength(1);
    expect(document.querySelector('[aria-label="Project repositories"]')).toBeNull();
    expect(document.querySelector('[aria-label="Skills from Sentry"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Other projects with this repo');
    expect(document.body.textContent).not.toContain('Sentry');
    expect(document.body.textContent).not.toContain('Paperclip');
    expect(document.querySelector('section a[href="/skills"]')).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('Importing skills');
  });

  it('allows remaining project imports while another matching workspace is pending', async () => {
    context.sourceId = '';
    const repository = { projectId: 'one', projectName: 'Paperclip', projectVisibility: 'open' as const, workspaceId: 'already-pending',
      repositoryUrl: 'https://github.com/acme/skills', trackingRef: 'HEAD', bindingId: 'binding', sourceId: null, status: 'pending' as const, lastError: null };
    vi.mocked(skillSourcesApi.projectRepositories).mockResolvedValue([repository,
      { ...repository, projectId: 'two', projectName: 'Sentry', workspaceId: 'available-workspace', status: 'available', bindingId: null }]);
    vi.mocked(skillSourcesApi.adoptProject).mockResolvedValue({ bindingId: 'second-binding' });
    await mount();
    expect(document.querySelector('[role="status"]')?.textContent).toContain('queued');
    expect(button('Import remaining skills')?.disabled).toBe(false);
    await act(async () => button('Import remaining skills').click()); await flush();
    expect(skillSourcesApi.adoptProject).toHaveBeenCalledTimes(1);
    expect(skillSourcesApi.adoptProject).toHaveBeenCalledWith('company-1', 'available-workspace');
  });

  it('retains the selected connection and repairs a missing branch directly from connection setup', async () => {
    context.sourceId = '';
    const source = { ...sourceFixture(), connectionId: 'personal', lastError: 'Choose a GitHub connection to enable automatic updates.', repairAction: 'connection' as const };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([source]);
    vi.mocked(skillSourcesApi.settings).mockRejectedValueOnce(new ApiError('The tracked GitHub branch or revision is unavailable.', 422, { code: 'skill_source_ref_unavailable' }))
      .mockResolvedValue({ ...source, trackingRef: 'master', lastError: null });
    await mount();
    await act(async () => button('Choose connection').click()); await flush();
    await act(async () => button('Save connection').click()); await flush();
    expect(skillSourcesApi.settings).toHaveBeenLastCalledWith('company-1', source.id, { revision: source.revision, connectionId: 'personal' });
    await act(async () => button('Choose a new branch').click()); await flush();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Branch"]')!.click()); await flush();
    await act(async () => (document.querySelector('[cmdk-item][data-value="master"]') as HTMLElement).click()); await flush();
    await act(async () => button('Change branch').click()); await flush();
    expect(skillSourcesApi.branches).toHaveBeenLastCalledWith('company-1', source.id, { connectionId: 'personal' }, expect.any(AbortSignal));
    expect(skillSourcesApi.settings).toHaveBeenLastCalledWith('company-1', source.id, { revision: source.revision, connectionId: 'personal', trackingRef: 'master' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('shows measured Git download progress before skill discovery and retains the automatically chosen connection', async () => {
    let finish!: (value: typeof discovery & { connectionId: string }) => void;
    vi.mocked(skillSourcesApi.discoverStream).mockImplementation((_company, _input, update) => {
      update({ type: 'progress', phase: 'downloading', download: { stage: 'receiving', percent: 64, receivedBytes: 18 * 1024 * 1024 }, totalSkills: null, checkedSkills: 0, currentPath: null, checkedFiles: 0, totalFiles: null });
      return new Promise(resolve => { finish = resolve; });
    });
    await mount();
    await act(async () => button('... or add public repo by URL').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/public/skills');
    await act(async () => button('Find skills').click()); await flush();
    expect(document.body.textContent).toContain('Downloading repository');
    expect(document.body.textContent).toContain('64% received · 18 MB');
    expect(document.querySelector('progress')?.value).toBe(64);
    expect(skillSourcesApi.create).not.toHaveBeenCalled();
    await act(async () => finish({ ...discovery, connectionId: 'shared' })); await flush();
    expect(JSON.parse(sessionStorage.getItem('paperclip.skill-source-draft:company-1:new')!).connectionId).toBe('shared');
  });
  it('shows streamed candidates without allowing a partial import, then discards them on failure', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(skillSourcesApi.discoverStream).mockImplementation((_company, _input, update) => {
      update({ type: 'progress', phase: 'checking', totalSkills: 20, checkedSkills: 1, currentPath: 'one/references/guide.md', checkedFiles: 2, totalFiles: 10 });
      update({ type: 'candidate', candidate: { path: 'one/SKILL.md', name: 'Code review', description: null, fileCount: 10, error: null } });
      return new Promise((_resolve, reject) => { fail = reject; });
    });
    await mount();
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click());
    await act(async () => button('Find skills').click()); await flush();
    expect(document.body.textContent).toContain('20 skills found');
    expect(document.body.textContent).toContain('1 of 20 checked');
    expect(document.body.textContent).toContain('Code review');
    expect(document.querySelector('progress')?.value).toBe(1);
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    expect(skillSourcesApi.create).not.toHaveBeenCalled();
    await act(async () => fail(new Error('Network interrupted'))); await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Network interrupted');
    expect(document.body.textContent).not.toContain('Code review');
    expect(button('Find skills').disabled).toBe(false);
  });
  it('bounds the live feed while keeping the full server progress count', async () => {
    vi.mocked(skillSourcesApi.discoverStream).mockImplementation((_company, _input, update, signal) => {
      for (let index = 0; index < 40; index++) update({ type: 'candidate', candidate: { path: `${index}/SKILL.md`, name: `Skill ${index}`, description: null, fileCount: 1, error: null } });
      update({ type: 'progress', phase: 'checking', totalSkills: 100, checkedSkills: 40, currentPath: '40/SKILL.md', checkedFiles: 0, totalFiles: 1 });
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    await mount();
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click());
    await act(async () => button('Find skills').click()); await flush();
    expect(document.querySelectorAll('[aria-label="Skills checked so far"] li')).toHaveLength(5);
    expect(document.body.textContent).toContain('40 of 100 checked');
    expect(document.body.textContent).toContain('40 checked');
    expect(document.body.textContent).not.toContain('Skill 0');
    expect(document.body.textContent).toContain('Skill 39');
  });
  it('cancels a scan, preserves the repository, and ignores late progress and completion', async () => {
    let finish!: (result: typeof discovery) => void;
    let update!: Parameters<typeof skillSourcesApi.discoverStream>[2];
    let signal: AbortSignal | undefined;
    vi.mocked(skillSourcesApi.discoverStream).mockImplementation((_company, _input, callback, active) => {
      update = callback; signal = active; return new Promise(resolve => { finish = resolve; });
    });
    await mount();
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click());
    await act(async () => button('Find skills').click()); await flush();
    await act(async () => button('Cancel scan').click());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      update({ type: 'candidate', candidate: { path: 'late/SKILL.md', name: 'Late result', description: null, error: null, fileCount: 1 } });
      finish(discovery);
    }); await flush();
    expect(document.body.textContent).not.toContain('Late result');
    expect(button('Find skills').disabled).toBe(false);
    expect(JSON.parse(sessionStorage.getItem('paperclip.skill-source-draft:company-1:new')!).repositoryUrl).toBe('https://github.com/acme/team-skills');
  });

  it('searches the combined repository inventory and uses the selected repository’s authorized connection', async () => {
    await mount();
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    expect(document.body.textContent).toContain('Personal · Engineering');
    expect([...document.querySelectorAll('a')].find(el => el.textContent === 'Add repos')?.getAttribute('href')).toBe('/apps/connect?source=github');
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh repositories"]')!.click());
    await flush();
    expect(skillSourcesApi.repositories).toHaveBeenCalledTimes(2);
    expect(document.querySelector('select')).toBeNull();
    expect(document.body.textContent).not.toContain('Choose a branch');
    expect(document.querySelector('input[placeholder="https://github.com/owner/repository"]')).toBeNull();
    await input('[aria-label="Search repositories"]', 'design');
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(1);
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click());
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discoverStream).toHaveBeenCalledWith('company-1', { repositoryUrl: 'https://github.com/acme/design', packageMode: 'repository', trackingRef: undefined, connectionId: 'shared' }, expect.any(Function), expect.any(AbortSignal));
  });
  it('recognizes pasted branch URLs and does not reuse their branch or credentials for another repository', async () => {
    await mount();
    await act(async () => button('... or add public repo by URL').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/ACME/team-skills/tree/feature/new-skills');
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discoverStream).toHaveBeenLastCalledWith('company-1', { repositoryUrl: 'https://github.com/ACME/team-skills/tree/feature/new-skills', packageMode: 'repository', trackingRef: undefined, connectionId: 'personal' }, expect.any(Function), expect.any(AbortSignal));
    await flush();
    expect(document.body.textContent).toContain('feature/new-skills');
    await act(async () => button('Back').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/public/skills');
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discoverStream).toHaveBeenLastCalledWith('company-1', { repositoryUrl: 'https://github.com/public/skills', packageMode: 'repository', trackingRef: undefined, connectionId: null }, expect.any(Function), expect.any(AbortSignal));
  });
  it('links empty repositories to standard GitHub setup in Apps while preserving the import draft', async () => {
    vi.mocked(skillSourcesApi.repositories).mockResolvedValue({ repositories: [], connections: [], connectionCount: 0, failedConnectionCount: 0 });
    await mount();
    const link = [...document.querySelectorAll('a')].find(el => el.textContent === 'Connect GitHub to see your repos');
    expect(link?.getAttribute('href')).toBe('/apps/connect?source=github');
    expect(document.querySelector('input[placeholder="https://github.com/owner/repository"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Imported skills will be available');
    await act(async () => button('... or add public repo by URL').click());
    expect(document.body.textContent).not.toContain('Uses the default branch');
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/acme/team-skills/tree/release');
    await act(async () => root.unmount());
    expect(JSON.parse(sessionStorage.getItem('paperclip.skill-source-draft:company-1:new')!).repositoryUrl).toBe('https://github.com/acme/team-skills/tree/release');
    // Returning from Apps remounts the importer and rechecks the new inventory.
    host.remove();
    await mount();
    expect(document.querySelector<HTMLInputElement>('input[placeholder="https://github.com/owner/repository"]')?.value).toBe('https://github.com/acme/team-skills/tree/release');
    expect(skillSourcesApi.repositories).toHaveBeenCalledTimes(2);
  });
  it('keeps usable repositories visible during partial failure and provides recovery in Apps', async () => {
    vi.mocked(skillSourcesApi.repositories).mockResolvedValue({ ...repos, failedConnectionCount: 1 });
    await mount();
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Some GitHub connections could not load repositories.');
    expect([...document.querySelectorAll('a')].find(el => el.textContent === 'Manage connections')?.getAttribute('href')).toBe('/apps');
    expect(button('Try again')).toBeTruthy();
  });
  it('defaults to the repository, selects every discovered skill without a packaging menu', async () => {
    const main = { path: 'skills/main/SKILL.md', name: 'Main', description: 'Work', fileCount: 1, error: null, warnings: [] };
    const helper = { ...main, path: 'automations/helper/SKILL.md', name: 'Helper' };
    vi.mocked(skillSourcesApi.discoverStream).mockImplementation(async (_company, input) => ({ ...discovery, packageMode: input.packageMode,
      candidates: [main, helper], ...(input.packageMode === 'repository' ? { repositoryPackage: {
        files: [{ path: 'agents/worker.md', kind: 'markdown', encoding: 'utf8' as const, executable: false, sizeBytes: 10 }],
        requirements: 'Bun for orchestration', error: null, warnings: [], skillPaths: [main.path],
      } } : {}) }));
    await mount();
    await act(async () => (document.querySelector('[cmdk-item]') as HTMLElement).click());
    await act(async () => button('Find skills').click()); await flush();
    expect(skillSourcesApi.discoverStream).toHaveBeenLastCalledWith('company-1', expect.objectContaining({ packageMode: 'repository' }), expect.any(Function), expect.any(AbortSignal));
    expect(skillSourcesApi.discoverStream).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('2 of 2 selected');
    expect([...document.querySelectorAll('summary')].some(summary => summary.textContent?.includes('Choose skills'))).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Import skills/main/SKILL.md"]')?.checked).toBe(true);
    expect(document.querySelector<HTMLInputElement>('[aria-label="Import automations/helper/SKILL.md"]')?.checked).toBe(true);
    expect(document.body.textContent).not.toContain('Select whole skill packages.');
    expect(document.body.textContent).not.toContain('The full repository travels');
    expect(document.body.textContent).not.toContain('Importing does not install');
    expect(button('View 1 file')).toBeTruthy();
    expect(button('Import repository').disabled).toBe(false);
    const draft = JSON.parse(sessionStorage.getItem('paperclip.skill-source-draft:company-1:new')!);
    expect(draft.packageMode).toBe('repository'); expect(draft.selectedPaths).toEqual([main.path, helper.path]);
    expect(document.querySelector('[aria-label="More import options"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Import individual skills');
  });
  it('warns about omitted files while allowing import without a confirmation', async () => {
    sessionStorage.setItem('paperclip.skill-source-draft:company-1:new', JSON.stringify({ packageMode: 'repository', selectedPaths: ['skills/main/SKILL.md'],
      discovery: { ...discovery, packageMode: 'repository', repositoryPackage: { files: [], requirements: null, error: null, warnings: ['shared/tools — Symlink couldn’t be included.'] },
        candidates: [{ path: 'skills/main/SKILL.md', name: 'Main', description: null, fileCount: 1, error: null, warnings: [] }] } }));
    vi.mocked(skillSourcesApi.create).mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(document.body.textContent).toContain('1 import warning');
    expect(document.querySelector('[aria-label="Import warnings"]')?.hasAttribute('open')).toBe(false);
    expect(button('Import repository').disabled).toBe(false);
    await act(async () => button('Import repository').click());
    expect(skillSourcesApi.create).toHaveBeenCalledWith('company-1', expect.objectContaining({ packageMode: 'repository', selectedPaths: ['skills/main/SKILL.md'] }));
  });
  it('uses repository packaging when returning to an old individual-import draft', async () => {
    sessionStorage.setItem('paperclip.skill-source-draft:company-1:new', JSON.stringify({ packageMode: 'skills', repositoryUrl: discovery.repositoryUrl }));
    const candidate = { path: 'skills/main/SKILL.md', name: 'Main', description: 'A useful skill', error: null, fileCount: 1, warnings: [],
      inspection: { files: [], requirements: null, warnings: [], references: [{ fromPath: 'SKILL.md', target: '../../shared.md', resolvedPath: 'shared.md', kind: 'outside_package' as const }] } };
    vi.mocked(skillSourcesApi.discoverStream).mockResolvedValueOnce({ ...discovery, packageMode: 'repository', candidates: [{ ...candidate, inspection: { ...candidate.inspection, references: [] } }], repositoryPackage: { files: [], requirements: null, warnings: [], error: null } });
    await mount();
    await act(async () => button('Find skills').click()); await flush();
    expect(skillSourcesApi.discoverStream).toHaveBeenCalledTimes(1);
    expect(skillSourcesApi.discoverStream).toHaveBeenLastCalledWith('company-1', expect.objectContaining({ packageMode: 'repository' }), expect.any(Function), expect.any(AbortSignal));
    expect(button('Import repository').disabled).toBe(false);
    expect(document.body.textContent).not.toContain('Include repository files');
  });

  async function openRemoval(disconnected = false) {
    context.sourceId = '';
    const source = { ...sourceFixture(), companyId: 'company-1', enabled: !disconnected };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([source]);
    await mount();
    const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${source.fullName}"]`)!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
    const menu = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(el => el.textContent === (disconnected ? 'Remove source' : 'Disconnect source'))!;
    await act(async () => menu.click()); await flush();
    return source;
  }
  it('requires a keep-or-delete choice and cancellation leaves the source intact', async () => {
    await openRemoval();
    expect(button('Disconnect source').disabled).toBe(true);
    expect(document.querySelector('[role="radio"][tabindex="0"]')?.textContent).toContain('Keep editable copies');
    expect(skillSourcesApi.disconnect).not.toHaveBeenCalled();
    await act(async () => button('Cancel').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain('acme/team-skills');
  });
  it('removes an already-disconnected source and sends the explicit delete choice and revision', async () => {
    const source = await openRemoval(true);
    vi.mocked(skillSourcesApi.disconnect).mockImplementation(async () => {
      vi.mocked(skillSourcesApi.list).mockResolvedValue([]);
      return { id: source.id, copiedCount: 0, deletedCount: 2 };
    });
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(el => el.textContent?.startsWith('Delete skills'))!;
    await act(async () => choice.click());
    await act(async () => button('Remove source').click()); await flush(); await flush();
    expect(skillSourcesApi.disconnect).toHaveBeenCalledWith('company-1', source.id, { revision: source.revision, skills: 'delete' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain('acme/team-skills');
  });
  it('reloads a stale confirmation and requires a new choice for the updated skill count', async () => {
    const source = await openRemoval();
    vi.mocked(skillSourcesApi.disconnect).mockRejectedValueOnce(new ApiError('Source changed. Reload before disconnecting.', 409, {}));
    await act(async () => document.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    await act(async () => button('Disconnect source').click()); await flush();
    expect(button('Disconnect source').disabled).toBe(true);
    vi.mocked(skillSourcesApi.list).mockResolvedValue([{ ...source, revision: source.revision + 1, entries: source.entries.slice(0, 1) }]);
    await act(async () => button('Reload source').click()); await flush(); await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('1 imported skill');
    expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
    expect(button('Disconnect source').disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[role="radio"]')!.click());
    vi.mocked(skillSourcesApi.disconnect).mockImplementation(async () => {
      vi.mocked(skillSourcesApi.list).mockResolvedValue([]);
      return { id: source.id, copiedCount: 1, deletedCount: 0 };
    });
    await act(async () => button('Disconnect source').click()); await flush(); await flush();
    expect(skillSourcesApi.disconnect).toHaveBeenLastCalledWith('company-1', source.id, { revision: source.revision + 1, skills: 'copy' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('sends the keep-copy choice and keeps failures in the confirmation for retry', async () => {
    const source = await openRemoval();
    vi.mocked(skillSourcesApi.disconnect).mockRejectedValue(new Error('Source changed. Reload before disconnecting.'));
    const choice = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(el => el.textContent?.startsWith('Keep editable copies'))!;
    await act(async () => choice.click());
    await act(async () => button('Disconnect source').click()); await flush();
    expect(skillSourcesApi.disconnect).toHaveBeenCalledWith('company-1', source.id, { revision: source.revision, skills: 'copy' });
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('Source changed');
    expect(button('Disconnect source').disabled).toBe(false);
    expect(document.querySelector('section[aria-label="acme/team-skills"]')).not.toBeNull();
    const other = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(el => el.textContent?.startsWith('Delete skills'))!;
    await act(async () => other.click()); await flush();
    expect(document.querySelector('[role="dialog"] [role="alert"]')).toBeNull();
  });

});
