const FAVICON_BLOCK_START = "<!-- PAPERCLIP_FAVICON_START -->";
const FAVICON_BLOCK_END = "<!-- PAPERCLIP_FAVICON_END -->";

const DEFAULT_FAVICON_LINKS = [
  '<link rel="icon" href="/favicon.ico" sizes="48x48" />',
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />',
  '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />',
].join("\n");

const WORKTREE_FAVICON_LINKS = [
  '<link rel="icon" href="/worktree-favicon.ico" sizes="48x48" />',
  '<link rel="icon" href="/worktree-favicon.svg" type="image/svg+xml" />',
  '<link rel="icon" type="image/png" sizes="32x32" href="/worktree-favicon-32x32.png" />',
  '<link rel="icon" type="image/png" sizes="16x16" href="/worktree-favicon-16x16.png" />',
].join("\n");

function isTruthyEnvValue(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isWorktreeUiBrandingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env.PAPERCLIP_IN_WORKTREE);
}

export function renderFaviconLinks(worktree: boolean): string {
  return worktree ? WORKTREE_FAVICON_LINKS : DEFAULT_FAVICON_LINKS;
}

export function applyUiBranding(html: string, env: NodeJS.ProcessEnv = process.env): string {
  const start = html.indexOf(FAVICON_BLOCK_START);
  const end = html.indexOf(FAVICON_BLOCK_END);
  if (start === -1 || end === -1 || end < start) return html;

  const before = html.slice(0, start + FAVICON_BLOCK_START.length);
  const after = html.slice(end);
  const links = renderFaviconLinks(isWorktreeUiBrandingEnabled(env));
  return `${before}\n${links}\n    ${after}`;
}
