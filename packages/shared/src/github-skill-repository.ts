/** Parse a repository or branch URL without guessing a branch from a folder path. */
export function parseGitHubSkillRepositoryUrl(value: string): {
  fullName: string;
  repositoryUrl: string;
  trackingRef?: string;
} | null {
  try {
    if (value.includes('\\')) return null;
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port
      || url.username || url.password || url.search || url.hash) return null;
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/tree\/(.+?))?\/?$/.exec(url.pathname);
    if (!match) return null;
    const owner = match[1]!;
    const repo = match[2]!.replace(/\.git$/, '');
    if ([owner, repo].some(part => !part || part === '.' || part === '..')) return null;
    const trackingRef = match[3] ? decodeURIComponent(match[3]) : undefined;
    if (trackingRef && (trackingRef.length > 255 || /[\x00-\x20\x7f~^:?*\[\\]/.test(trackingRef)
      || trackingRef.includes('..') || trackingRef.includes('@{') || trackingRef === '@'
      || trackingRef.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')))) return null;
    const fullName = `${owner}/${repo}`;
    return { fullName, repositoryUrl: `https://github.com/${fullName.toLowerCase()}`, ...(trackingRef ? { trackingRef } : {}) };
  } catch {
    return null;
  }
}
