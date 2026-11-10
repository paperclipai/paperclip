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
