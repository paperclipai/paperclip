function normalizeOrigin(origin: string): string | null {
  const trimmed = origin.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

interface CompiledPattern {
  protocol: "http:" | "https:";
  hostnameRegex: RegExp;
  port: string;
}

function compilePattern(pattern: string): CompiledPattern | null {
  const trimmed = pattern.trim().toLowerCase();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.replace("*.", "WILDCARD."));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostnameWithMarker = url.hostname;
    const hostnameRegexSource = hostnameWithMarker
      .split(".")
      .map((part) => (part === "wildcard" ? "[^.]+" : escapeRegex(part)))
      .join("\\.");
    return {
      protocol: url.protocol as "http:" | "https:",
      hostnameRegex: new RegExp(`^${hostnameRegexSource}$`),
      port: url.port,
    };
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface OriginMatcher {
  match(origin: string | undefined | null): string | null;
  configuredPatterns: string[];
}

export function buildOriginMatcher(patterns: string[]): OriginMatcher {
  const compiled = patterns
    .map((pattern) => ({ pattern, compiled: compilePattern(pattern) }))
    .filter((entry): entry is { pattern: string; compiled: CompiledPattern } => entry.compiled !== null);

  return {
    configuredPatterns: compiled.map((entry) => entry.pattern),
    match(origin) {
      if (!origin) return null;
      const normalized = normalizeOrigin(origin);
      if (!normalized) return null;
      let parsed: URL;
      try {
        parsed = new URL(normalized);
      } catch {
        return null;
      }
      for (const { compiled: pattern } of compiled) {
        if (pattern.protocol !== parsed.protocol) continue;
        if (pattern.port !== parsed.port) continue;
        if (!pattern.hostnameRegex.test(parsed.hostname)) continue;
        return normalized;
      }
      return null;
    },
  };
}

export function parseOriginAllowlistEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
