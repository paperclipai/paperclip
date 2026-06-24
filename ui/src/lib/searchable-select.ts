export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function fuzzyTokenMatchesText(text: string, token: string): boolean {
  if (!token) return true;
  if (text.includes(token)) return true;

  let tokenIndex = 0;
  for (const char of text) {
    if (char === token[tokenIndex]) tokenIndex += 1;
    if (tokenIndex === token.length) return true;
  }
  return false;
}

export function fuzzyTextMatchesQuery(text: string, query: string): boolean {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return true;

  return normalizedQuery.split(" ").every((token) => fuzzyTokenMatchesText(normalizedText, token));
}
