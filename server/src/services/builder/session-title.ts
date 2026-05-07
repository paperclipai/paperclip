const MAX_SESSION_TITLE_LENGTH = 80;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function hasMeaningfulBuilderSessionTitle(title: string | null | undefined): boolean {
  const normalized = normalizeWhitespace(title ?? "");
  if (!normalized) return false;
  return normalized.toLowerCase() !== "new session";
}

export function buildBuilderSessionTitleFromPrompt(prompt: string): string {
  const normalized = normalizeWhitespace(prompt);
  if (!normalized) return "";

  const sentence = normalized.match(/^(.+?[.!?])(?:\s|$)/)?.[1]?.trim() ?? normalized;
  if (sentence.length <= MAX_SESSION_TITLE_LENGTH) return sentence;

  return `${sentence.slice(0, MAX_SESSION_TITLE_LENGTH - 3).trimEnd()}...`;
}
