/** Public product identity only: never include company, user, run, or credential data. */
export const OPENROUTER_ATTRIBUTION_HEADERS = Object.freeze({
  "HTTP-Referer": "https://paperclip.ing",
  "X-Title": "Paperclip",
  "X-OpenRouter-Title": "Paperclip",
  "X-OpenRouter-Categories": "cloud-agent,programming-app",
});

export function isOpenRouterUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["openrouter.ai", "eu.openrouter.ai", "us.openrouter.ai"].includes(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Replace attribution case-insensitively while preserving authentication and routing. */
export function openRouterAttributionHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const replaced = new Set(Object.keys(OPENROUTER_ATTRIBUTION_HEADERS).map(key => key.toLowerCase()));
  return {
    ...Object.fromEntries(Object.entries(headers).filter(([key]) => !replaced.has(key.toLowerCase()))),
    ...OPENROUTER_ATTRIBUTION_HEADERS,
  };
}

export function openRouterClaudeHeaders(existing = ""): string {
  const headers: Record<string, string> = {};
  for (const line of existing.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return Object.entries(openRouterAttributionHeaders(headers)).map(([name, value]) => `${name}: ${value}`).join("\n");
}

export function openRouterCodexHeaders(): string {
  return `http_headers = { ${Object.entries(OPENROUTER_ATTRIBUTION_HEADERS).map(([key, value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)}`).join(", ")} }\n`;
}
