import path from "node:path";

export interface InstructionsMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatterValue(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("\"") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function splitInstructionsMarkdown(markdown: string): InstructionsMarkdown {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return {
      frontmatter: {},
      body: normalized,
    };
  }

  const frontmatter: Record<string, unknown> = {};
  const rawFrontmatter = match[1];
  const body = match[2].trimStart();

  let currentKey: string | null = null;
  let currentList: unknown[] | null = null;

  for (const line of rawFrontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("- ") && currentKey) {
      if (!currentList) currentList = [];
      currentList.push(parseFrontmatterValue(trimmed.slice(2).trim()));
      continue;
    }

    if (currentKey && currentList) {
      frontmatter[currentKey] = currentList;
      currentList = null;
      currentKey = null;
    }

    const kvMatch = trimmed.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    if (rawValue.length === 0) {
      currentKey = key;
      continue;
    }

    frontmatter[key] = parseFrontmatterValue(rawValue);
    currentKey = null;
  }

  if (currentKey && currentList) {
    frontmatter[currentKey] = currentList;
  }

  return {
    frontmatter,
    body,
  };
}

export function buildInstructionsPrefix(body: string, instructionsFilePath: string): string {
  const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
  return [body, `The above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsDir}.`]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}
