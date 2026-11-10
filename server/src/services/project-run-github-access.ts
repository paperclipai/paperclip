import { and, eq } from 'drizzle-orm';
import { connectionGrants, projectWorkspaces, type Db } from '@paperclipai/db';
import { forbidden } from '../errors.js';
import { resolveGitHubOperationCredentials } from './github-operation-credentials.js';

function githubRepository(value: string): string | null {
  let path: string;
  const scp = /^git@(?:www\.)?github\.com:([^\s]+)$/i.exec(value);
  if (scp) path = scp[1]!;
  else {
    try {
      const url = new URL(value);
      if (!['https:', 'ssh:'].includes(url.protocol) || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) || url.port || url.password || url.search || url.hash ||
          (url.protocol === 'https:' ? Boolean(url.username) : url.username !== 'git')) return null;
      path = url.pathname.replace(/^\//, '');
    } catch { return null; }
  }
  const parts = path.replace(/\.git\/?$/i, '').replace(/\/$/, '').split('/');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null;
  return parts.map(encodeURIComponent).join('/');
}

export function isGitHubProjectRemote(value: string): boolean {
  try { return ['github.com', 'www.github.com'].includes(new URL(value).hostname.toLowerCase().replace(/\.+$/, '')); }
  catch { return /^(?:[^@/\s]+@)?(?:www\.)?github\.com\.*:/i.test(value); }
}

/** Canonical repository URLs contain no URL credentials or other provider data. */
export function canonicalProjectGitHubRepositories(urls: string[]): string[] {
  return [...new Set(urls.map(githubRepository).filter((repo): repo is string => Boolean(repo))
    .map(repo => `https://github.com/${repo}`))];
}

export function canonicalGitHubProjectBindings(values: Array<{ projectId: string | null; repoUrl: string | null }>) {
  const result = new Map<string, { projectId: string; repositoryUrl: string }>();
  for (const value of values) {
    if (!value.projectId || !value.repoUrl) continue;
    const [repositoryUrl] = canonicalProjectGitHubRepositories([value.repoUrl]);
    if (repositoryUrl) result.set(`${value.projectId}:${repositoryUrl.toLowerCase()}`, { projectId: value.projectId, repositoryUrl });
  }
  return [...result.values()];
}

/** Check the run's managed connection before admitting a linked GitHub workspace. */
export async function resolveRunProjectGitHubCredentials(db: Db, input: {
  companyId: string; agentId: string; runId: string; repoUrls: string[]; hostGitHub?: boolean;
  expectedRepositoryIds?: Record<string, string>;
}, resolve = resolveGitHubOperationCredentials, request = fetch) {
  if (input.repoUrls.some(value => isGitHubProjectRemote(value) && !githubRepository(value)))
    throw forbidden('Project GitHub authorization is unavailable. Reconnect an authorized connection.');
  const repositories = [...new Set(input.repoUrls.map(githubRepository).filter((repo): repo is string => Boolean(repo)))];
  if (!repositories.length) return null;
  if (input.hostGitHub) throw forbidden('Project GitHub authorization is unavailable. Reconnect an authorized connection.');
  let status: Awaited<ReturnType<typeof resolveGitHubOperationCredentials>>;
  try { status = await resolve(db, { companyId: input.companyId, agentId: input.agentId, runId: input.runId }); }
  catch { throw forbidden('Project GitHub authorization is unavailable. Reconnect an authorized connection.'); }
  const unavailable = () => forbidden('Project GitHub authorization is unavailable. Reconnect an authorized connection.');
  const token = status.env?.PAPERCLIP_GIT_TOKEN;
  if (status.status !== 'available' || !token || !status.grantId || !status.connectionId) throw unavailable();
  const assertCatalog = async () => {
    const [grant] = await db.select({ tenant: connectionGrants.providerTenant }).from(connectionGrants).where(and(
      eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, status.grantId!), eq(connectionGrants.status, 'active')));
    const allowed = grant?.tenant?.github?.repositories ?? [];
    return repositories.map(repo => {
      const matches = allowed.filter(entry => entry.fullName.toLowerCase() === decodeURIComponent(repo).toLowerCase());
      const ids = [...new Set(matches.map(entry => entry.id))];
      if (ids.length !== 1 || !/^\d+$/.test(ids[0]!)) throw unavailable();
      if (input.expectedRepositoryIds && input.expectedRepositoryIds[repo.toLowerCase()] !== ids[0]) throw unavailable();
      return ids[0]!;
    });
  };
  let validated: Awaited<ReturnType<typeof resolveGitHubOperationCredentials>>;
  try {
    const repositoryIds = await assertCatalog();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, repositories.length) }, async () => {
      while (cursor < repositories.length) {
        const repository = repositories[cursor++]!;
        const response = await request(`https://api.github.com/repos/${repository}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          redirect: 'error', signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
        const payload = await response.json() as { id?: unknown };
        const index = repositories.indexOf(repository);
        if ((typeof payload?.id !== 'number' && typeof payload?.id !== 'string') || String(payload.id) !== repositoryIds[index])
          throw unavailable();
      }
    }));
    if (JSON.stringify(await assertCatalog()) !== JSON.stringify(repositoryIds)) throw unavailable();
    const current = await resolve(db, { companyId: input.companyId, agentId: input.agentId, runId: input.runId });
    if (current.status !== 'available' || current.grantId !== status.grantId || current.connectionId !== status.connectionId ||
        current.identityContextId !== status.identityContextId || current.revision !== status.revision || current.env?.PAPERCLIP_GIT_TOKEN !== token) throw unavailable();
    validated = current;
  } catch { throw unavailable(); }
  return validated;
}

/** Authorize a project checkout against its persisted repository identity before Git runs. */
export async function authorizeProjectGitHubCheckout(db: Db, input: {
  companyId: string; projectId: string; agentId: string; runId: string; repoUrl: string;
}, resolve = resolveGitHubOperationCredentials, request = fetch) {
  const repository = githubRepository(input.repoUrl);
  const unavailable = () => forbidden('Project GitHub authorization is unavailable. Reconnect and reselect the repository.');
  if (!repository) throw unavailable();
  const currentId = async () => {
    const rows = await db.select({ repoUrl: projectWorkspaces.repoUrl, metadata: projectWorkspaces.metadata })
      .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)));
    const matches = rows.filter(row => row.repoUrl && githubRepository(row.repoUrl)?.toLowerCase() === repository.toLowerCase());
    const ids = [...new Set(matches.map(row => {
      const metadata = row.metadata ?? {};
      if (metadata.repositoryProvider !== undefined && metadata.repositoryProvider !== 'github') return null;
      if (typeof metadata.repositoryId === 'string' && typeof metadata.githubRepositoryId === 'string' &&
          metadata.repositoryId !== metadata.githubRepositoryId) return null;
      return typeof metadata.repositoryId === 'string' && (metadata.repositoryProvider === undefined || metadata.repositoryProvider === 'github')
        ? metadata.repositoryId : typeof metadata.githubRepositoryId === 'string' ? metadata.githubRepositoryId : null;
    }))];
    if (ids.length !== 1 || !ids[0] || !/^\d+$/.test(ids[0])) throw unavailable();
    return ids[0];
  };
  const id = await currentId();
  const result = await resolveRunProjectGitHubCredentials(db, { ...input, repoUrls: [input.repoUrl],
    expectedRepositoryIds: { [repository.toLowerCase()]: id } }, resolve, request);
  if (!result || await currentId() !== id) throw unavailable();
  return result;
}

/** Revalidate every controller-bound project before releasing the run credential. */
export async function resolveBoundProjectGitHubCredentials(db: Db, input: {
  companyId: string; agentId: string; runId: string;
  bindings: Array<{ projectId: string; repositoryUrl: string }>;
}) {
  if (!input.bindings.length) throw forbidden('Project GitHub authorization is unavailable.');
  let credential: Awaited<ReturnType<typeof authorizeProjectGitHubCheckout>> | undefined;
  for (const binding of input.bindings) {
    const current = await authorizeProjectGitHubCheckout(db, { ...input, projectId: binding.projectId, repoUrl: binding.repositoryUrl });
    if (credential && (credential.grantId !== current.grantId || credential.connectionId !== current.connectionId ||
      credential.revision !== current.revision || credential.env?.PAPERCLIP_GIT_TOKEN !== current.env?.PAPERCLIP_GIT_TOKEN))
      throw forbidden('Project GitHub authorization is unavailable.');
    credential = current;
  }
  return credential!;
}

/** Reopen a workspace under the project's explicit, currently valid GitHub consent. */
export async function authorizeProjectGitHubReopen(db: Db, input: {
  companyId: string; projectId: string; repoUrl: string;
}, request = fetch) {
  const repo = githubRepository(input.repoUrl);
  const unavailable = () => forbidden('Project GitHub authorization is unavailable. Reconnect and reselect the repository.');
  if (!repo) throw unavailable();
  const identity = async () => {
    const rows = await db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, metadata: projectWorkspaces.metadata })
      .from(projectWorkspaces).where(and(eq(projectWorkspaces.companyId, input.companyId), eq(projectWorkspaces.projectId, input.projectId)));
    const matches = rows.filter(row => row.repoUrl && githubRepository(row.repoUrl)?.toLowerCase() === repo.toLowerCase());
    if (matches.length !== 1) throw unavailable();
    const workspace = matches[0]!;
    const metadata = workspace.metadata ?? {};
    if (metadata.repositoryProvider !== undefined && metadata.repositoryProvider !== 'github') throw unavailable();
    const id = typeof metadata.repositoryId === 'string' && (metadata.repositoryProvider === undefined || metadata.repositoryProvider === 'github')
      ? metadata.repositoryId : typeof metadata.githubRepositoryId === 'string' ? metadata.githubRepositoryId : null;
    if (!id || !/^\d+$/.test(id) || (typeof metadata.githubRepositoryId === 'string' && metadata.githubRepositoryId !== id)) throw unavailable();
    return { workspaceId: workspace.id, id };
  };
  try {
    const first = await identity();
    const { projectGitAuthorizationService } = await import('./project-git-authorization.js');
    const resolve = () => projectGitAuthorizationService(db).resolve({ ...input, workspaceId: first.workspaceId,
      expectedRepository: decodeURIComponent(repo), expectedRepositoryId: first.id, requireConnected: true },
    { projectId: input.projectId, workspaceId: first.workspaceId, operation: 'prepare' });
    const token = await resolve();
    if (!token) throw unavailable();
    const response = await request(`https://api.github.com/repos/${repo}`, { headers: {
      Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    }, redirect: 'error', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const live = await response.json() as { id?: unknown };
    if ((typeof live.id !== 'number' && typeof live.id !== 'string') || String(live.id) !== first.id) throw unavailable();
    const current = await identity();
    if (current.workspaceId !== first.workspaceId || current.id !== first.id || await resolve() !== token) throw unavailable();
    return token;
  } catch { throw unavailable(); }
}

/** Check project repositories without exposing the transient credential. */
export async function assertRunProjectGitHubAccess(db: Db, input: Parameters<typeof resolveRunProjectGitHubCredentials>[1],
  resolve = resolveGitHubOperationCredentials, request = fetch) {
  return Boolean(await resolveRunProjectGitHubCredentials(db, input, resolve, request));
}
