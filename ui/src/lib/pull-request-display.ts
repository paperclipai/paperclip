const mergeLabels = new Map<unknown, string>([
  ["clean", "Mergeable"],
  ["blocked", "Merge blocked"],
  ["behind", "Behind base"],
  ["dirty", "Has conflicts"],
  ["unstable", "Checks not passing"],
  ["has_hooks", "Mergeable with hooks"],
]);

export function pullRequestDisplayParts(metadata: Record<string, unknown> | null, open: boolean): string[] {
  if (!open || !metadata) return [];
  const parts: string[] = [];
  const headSha = metadata.headSha;
  if (typeof headSha === "string" && /^[a-f0-9]{7,64}$/i.test(headSha)) {
    parts.push(`head ${headSha.slice(0, 7)}`);
  }
  const mergeLabel = mergeLabels.get(metadata.mergeableState);
  if (mergeLabel) parts.push(mergeLabel);
  return parts;
}
