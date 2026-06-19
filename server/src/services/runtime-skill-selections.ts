export function skillVersionSelectionMap(entries: Array<{ key: string; versionId: string | null }>) {
  return new Map(entries.map((entry) => [entry.key, entry.versionId] as const));
}
