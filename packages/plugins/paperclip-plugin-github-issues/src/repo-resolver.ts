export function resolveProjectId(repoFullName: string, map: Record<string, string>): string | null {
  return map[repoFullName] ?? null;
}
