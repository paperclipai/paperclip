import type { GitAuthInvocation, GitRemoteAuthProvider } from './git-credentials.js';
import { isAzureDevOpsRemote, withAnonymousGitFallback } from './git-credential-policy.js';

/** A linked project repository requires a current managed authorization. */
export async function assertProjectGitConnection(repoUrl: string, resolve: GitRemoteAuthProvider): Promise<GitAuthInvocation | null> {
  if (isAzureDevOpsRemote(repoUrl)) return withAnonymousGitFallback(resolve)(repoUrl);
  const github = /^git@(?:www\.)?github\.com:[^\s]+$/i.test(repoUrl) || (() => {
    try { const url = new URL(repoUrl); return ['https:', 'ssh:'].includes(url.protocol) &&
      ['github.com', 'www.github.com'].includes(url.hostname.toLowerCase()) && !url.password &&
      (url.protocol === 'https:' ? !url.username : url.username === 'git'); } catch { return false; }
  })();
  if (!github) return null;
  let auth: GitAuthInvocation | null;
  try { auth = await resolve(repoUrl); } catch { throw new Error('GitHub connection authorization is unavailable'); }
  if (!auth || auth.source !== 'managed_connection' || !auth.env.PAPERCLIP_GIT_TOKEN) throw new Error('GitHub connection authorization is unavailable');
  return auth;
}
