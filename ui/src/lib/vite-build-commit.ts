/** Only a full source commit may enter the public browser bundle. */
export function resolveBrowserBuildCommit(value: string | undefined): string | null {
  const commit = value?.trim() ?? "";
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}
