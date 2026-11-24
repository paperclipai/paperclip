// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSource } from '@paperclipai/shared';
import { SkillSources } from './SkillSources';
import { ApiError } from '@/api/client';
import { skillSourcesApi } from '@/api/skillSources';
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
const connectedSource: SkillSource = {
  id: 'source-1', companyId: 'company-1', repositoryId: '1', repositoryUrl: 'https://github.com/acme/team-skills', fullName: 'acme/team-skills',
  trackingRef: 'HEAD', connectionId: 'shared', excludedFolders: [], enabled: true, revision: 1,
  lastAttemptAt: null, lastSuccessAt: null, lastScanCommit: null, lastError: null, entries: [],
};
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

describe('Skill source security overrides', () => {
  it('lets an administrator trust flagged files with a reason while real risks stay blocked', async () => {
    const commitSha = 'c'.repeat(40);
    const flagged = { path: 'hooks/install.sh', code: 'remote_fetch_exec', message: 'Remote-fetch or dynamic execution pattern is not allowed.', sha256: 'd'.repeat(64), overridable: true };
    const leak = { path: 'scripts/leak.sh', code: 'secret_exfiltration', message: 'Secret exfiltration pattern is not allowed.', sha256: 'e'.repeat(64), overridable: false };
    sessionStorage.setItem('paperclip.skill-source-draft:company-1:new', JSON.stringify({ packageMode: 'repository', selectedPaths: ['skills/main/SKILL.md'],
      discovery: { ...discovery, commitSha, packageMode: 'repository', canOverrideSecurity: true, securityFindings: [flagged, leak],
        repositoryPackage: { files: [], requirements: null, error: null, warnings: [] },
        candidates: [{ path: 'skills/main/SKILL.md', name: 'Main', description: null, fileCount: 1, error: null, warnings: [] }] } }));
    vi.mocked(skillSourcesApi.create).mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(document.body.textContent).toContain('Always blocked');
    expect(document.body.textContent).toContain('scripts/leak.sh');
    const trust = document.querySelector<HTMLButtonElement>('section[aria-label="Security review"] button[role="checkbox"]')!;
    await act(async () => trust.click());
    expect(button('Import repository').disabled).toBe(true);
    await act(async () => {
      const element = document.querySelector<HTMLTextAreaElement>('section[aria-label="Security review"] textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'Maintained by our platform team.');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button('Import repository').disabled).toBe(false);
    await act(async () => button('Import repository').click());
    expect(skillSourcesApi.create).toHaveBeenCalledWith('company-1', expect.objectContaining({ securityOverride: {
      commitSha, reason: 'Maintained by our platform team.', trustFutureUpdates: false, reviewedRef: 'feature/new-skills', files: [{ path: flagged.path, sha256: flagged.sha256 }],
    } }));
  });
  it('lets an administrator scan a saved source again to renew trust in flagged files', async () => {
    context.sourceId = connectedSource.id;
    const commitSha = 'f'.repeat(40);
    const flagged = { path: 'hooks/install.sh', code: 'remote_fetch_exec', message: 'Remote-fetch or dynamic execution pattern is not allowed.', sha256: 'd'.repeat(64), overridable: true };
    const saved = { ...connectedSource, packageMode: 'repository' as const, entries: [], securityOverride: { commitSha: 'a'.repeat(40), reason: 'Reviewed earlier.',
      trustFutureUpdates: false, approvedByUserId: 'admin', approvedAt: '2026-11-01T00:00:00.000Z', fileCount: 1 } };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([saved]);
    vi.mocked(skillSourcesApi.discoverStream).mockResolvedValue({ ...discovery, trackingRef: 'main', commitSha, packageMode: 'repository', canOverrideSecurity: true,
      securityFindings: [flagged], repositoryPackage: { files: [], requirements: null, error: null, warnings: [] },
      candidates: [{ path: 'skills/main/SKILL.md', name: 'Main', description: null, fileCount: 1, error: null, warnings: [] }] });
    vi.mocked(skillSourcesApi.select).mockImplementation(() => new Promise(() => {}));
    await mount();
    expect(document.querySelector('section[aria-label="Security review"] button[role="checkbox"][id$="-trust"]')).toBeNull();
    await act(async () => button('Scan for flagged files').click());
    await flush();
    expect(skillSourcesApi.discoverStream).toHaveBeenCalledWith('company-1', expect.objectContaining({ repositoryUrl: saved.repositoryUrl, trackingRef: 'HEAD', sourceId: saved.id }), expect.any(Function), expect.any(AbortSignal));
    await act(async () => document.querySelector<HTMLButtonElement>('section[aria-label="Security review"] button[role="checkbox"]')!.click());
    await act(async () => {
      const element = document.querySelector<HTMLTextAreaElement>('section[aria-label="Security review"] textarea')!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'Reviewed the new commit by hand.');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save selection').click());
    expect(skillSourcesApi.select).toHaveBeenCalledWith('company-1', saved.id, expect.objectContaining({ securityOverride: {
      commitSha, reason: 'Reviewed the new commit by hand.', trustFutureUpdates: false, reviewedRef: 'main', files: [{ path: flagged.path, sha256: flagged.sha256 }],
    } }));
  });
  it('withdraws a saved approval so future updates leave the flagged files out', async () => {
    context.sourceId = connectedSource.id;
    const saved = { ...connectedSource, packageMode: 'repository' as const, entries: [], securityOverride: { commitSha: 'a'.repeat(40), reason: 'Reviewed earlier.',
      trustFutureUpdates: true, approvedByUserId: 'admin', approvedAt: '2026-11-01T00:00:00.000Z', fileCount: 2 } };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([saved]);
    vi.mocked(skillSourcesApi.select).mockImplementation(() => new Promise(() => {}));
    vi.mocked(skillSourcesApi.discoverStream).mockResolvedValue({ ...discovery, trackingRef: 'HEAD', packageMode: 'repository', canOverrideSecurity: true, securityFindings: [],
      repositoryPackage: { files: [], requirements: null, error: null, warnings: [] },
      candidates: [{ path: 'skills/main/SKILL.md', name: 'Main', description: null, fileCount: 1, error: null, warnings: [] }] });
    await mount();
    expect(document.querySelector('section[aria-label="Security review"]')?.textContent).toContain('2 flagged files are trusted');
    // Withdrawing needs the override permission, which a scan of the saved source reports.
    expect(document.querySelector('section[aria-label="Security review"] button[role="checkbox"][id$="-revoke"]')).toBeNull();
    await act(async () => button('Scan for flagged files').click());
    await flush();
    await act(async () => document.querySelector<HTMLButtonElement>('section[aria-label="Security review"] button[role="checkbox"][id$="-revoke"]')!.click());
    await act(async () => button('Save selection').click());
    expect(skillSourcesApi.select).toHaveBeenCalledWith('company-1', saved.id, expect.objectContaining({ securityOverride: null }));
  });
  it('does not offer to withdraw an approval to editors without the override permission', async () => {
    context.sourceId = connectedSource.id;
    const saved = { ...connectedSource, packageMode: 'repository' as const, entries: [], securityOverride: { commitSha: 'a'.repeat(40), reason: 'Reviewed earlier.',
      trustFutureUpdates: true, approvedByUserId: 'admin', approvedAt: '2026-11-01T00:00:00.000Z', fileCount: 2 } };
    vi.mocked(skillSourcesApi.list).mockResolvedValue([saved]);
    vi.mocked(skillSourcesApi.discoverStream).mockResolvedValue({ ...discovery, trackingRef: 'HEAD', packageMode: 'repository', canOverrideSecurity: false, securityFindings: [],
      repositoryPackage: { files: [], requirements: null, error: null, warnings: [] },
      candidates: [{ path: 'skills/main/SKILL.md', name: 'Main', description: null, fileCount: 1, error: null, warnings: [] }] });
    await mount();
    await act(async () => button('Scan for flagged files').click());
    await flush();
    expect(document.querySelector('section[aria-label="Security review"]')?.textContent).toContain('2 flagged files are trusted');
    expect(document.querySelector('section[aria-label="Security review"] button[role="checkbox"][id$="-revoke"]')).toBeNull();
  });
  it('explains that only administrators can include flagged files', async () => {
    sessionStorage.setItem('paperclip.skill-source-draft:company-1:new', JSON.stringify({ packageMode: 'repository', selectedPaths: ['skills/main/SKILL.md'],
      discovery: { ...discovery, packageMode: 'repository', canOverrideSecurity: false,
        securityFindings: [{ path: 'hooks/install.sh', code: 'remote_fetch_exec', message: 'Flagged.', sha256: 'd'.repeat(64), overridable: true }],
        repositoryPackage: { files: [], requirements: null, error: null, warnings: [] },
        candidates: [{ path: 'skills/main/SKILL.md', name: 'Main', description: null, fileCount: 1, error: null, warnings: [] }] } }));
    await mount();
    expect(document.body.textContent).toContain('Only a company administrator can include these files.');
    expect(document.querySelector('section[aria-label="Security review"] button[role="checkbox"]')).toBeNull();
  });
});
