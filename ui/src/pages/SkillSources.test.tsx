// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillSources } from './SkillSources';
import { skillSourcesApi } from '@/api/skillSources';

const context = vi.hoisted(() => ({ navigate: vi.fn(), breadcrumbs: vi.fn(), sourceId: 'new' }));
vi.mock('@/context/CompanyContext', () => ({ useCompany: () => ({ selectedCompanyId: 'company-1', selectedCompany: { name: 'Acme' } }) }));
vi.mock('@/context/BreadcrumbContext', () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: context.breadcrumbs }) }));
vi.mock('@/lib/router', () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => context.navigate,
  useParams: () => ({ sourceId: context.sourceId }),
}));
vi.mock('@/api/skillSources', () => ({ skillSourcesApi: { list: vi.fn(), repositories: vi.fn(), discoverStream: vi.fn(), create: vi.fn(), select: vi.fn(), refresh: vi.fn(), disconnect: vi.fn() } }));

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
  vi.mocked(skillSourcesApi.repositories).mockResolvedValue(structuredClone(repos));
  vi.mocked(skillSourcesApi.discoverStream).mockResolvedValue(discovery);
  context.sourceId = 'new';
  sessionStorage.clear();
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); client?.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals();
});

describe('GitHub skill source import', () => {
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
    expect([...document.querySelectorAll('a')].find(el => el.textContent === 'Add repos')?.getAttribute('href')).toBe('https://github.com/settings/installations');
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
    expect(skillSourcesApi.discoverStream).toHaveBeenCalledWith('company-1', { repositoryUrl: 'https://github.com/acme/design', connectionId: 'shared' }, expect.any(Function), expect.any(AbortSignal));
  });
  it('recognizes pasted branch URLs and does not reuse their branch or credentials for another repository', async () => {
    await mount();
    await act(async () => button('... or add public repo by URL').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/ACME/team-skills/tree/feature/new-skills');
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discoverStream).toHaveBeenLastCalledWith('company-1', { repositoryUrl: 'https://github.com/ACME/team-skills/tree/feature/new-skills', connectionId: 'personal' }, expect.any(Function), expect.any(AbortSignal));
    await flush();
    expect(document.body.textContent).toContain('feature/new-skills');
    await act(async () => button('Back').click());
    await input('input[placeholder="https://github.com/owner/repository"]', 'https://github.com/public/skills');
    await act(async () => button('Find skills').click());
    expect(skillSourcesApi.discoverStream).toHaveBeenLastCalledWith('company-1', { repositoryUrl: 'https://github.com/public/skills', connectionId: null }, expect.any(Function), expect.any(AbortSignal));
  });
  it('opens the existing installation settings even when no repositories are available', async () => {
    vi.mocked(skillSourcesApi.repositories).mockResolvedValue({ repositories: [], connections: [{ id: 'personal', name: 'Personal', managementUrl: 'https://github.com/settings/installations/123' }], connectionCount: 1, failedConnectionCount: 0 });
    await mount();
    const link = [...document.querySelectorAll('a')].find(el => el.textContent === 'Add repos');
    expect(link?.getAttribute('href')).toBe('https://github.com/settings/installations/123');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(document.body.textContent).not.toContain('Connect GitHub to see your repos');
    vi.mocked(skillSourcesApi.repositories).mockResolvedValue(structuredClone(repos));
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Refresh repositories"]')!.click());
    await flush();
    expect(skillSourcesApi.repositories).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('[cmdk-item]')).toHaveLength(2);
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
});
