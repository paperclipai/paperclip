const DEFAULT_PREVIEW_LENGTH = 280;

export function buildKnowledgePreview(
  body: string | null | undefined,
  maxLength: number = DEFAULT_PREVIEW_LENGTH,
): string | null {
  if (!body) return null;

  const trimmed = body.trim();
  if (!trimmed) return null;

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}
