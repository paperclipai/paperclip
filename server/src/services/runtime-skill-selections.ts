export function skillVersionSelectionMap(
  entries: Array<{ key: string; versionId: string | null }>,
  options: { versionPinsEnabled?: boolean } = {},
) {
  const versionPinsEnabled = options.versionPinsEnabled ?? true;
  return new Map(entries.map((entry) => [entry.key, versionPinsEnabled ? entry.versionId : null] as const));
}
