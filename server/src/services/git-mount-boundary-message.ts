export function isGitMountBoundaryMessage(stderr: unknown): boolean {
  if (typeof stderr !== "string") return false;
  const match = /^fatal: not a git repository \(or any parent up to mount point [^\r\n]+\)\r?\nStopping at filesystem boundary \(GIT_DISCOVERY_ACROSS_FILESYSTEM not set\)\.\r?\n?$/.exec(stderr);
  return match?.[0] === stderr;
}
