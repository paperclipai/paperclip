export const PLACEHOLDER_ANCHOR_SENTINEL =
  "Placeholder anchor — DO NOT manually start.";

const PLACEHOLDER_ANCHOR_RE =
  /placeholder\s+anchor\s*[—\-]\s*do\s+not\s+manually\s+start\./i;

export function hasPlaceholderAnchorMarker(
  description: string | null | undefined,
): boolean {
  if (!description) return false;
  return PLACEHOLDER_ANCHOR_RE.test(description);
}
