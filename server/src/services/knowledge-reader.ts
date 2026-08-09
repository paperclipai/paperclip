import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const SSI_DIRECTOR_AGENT_ID = "7cc4dafd-b41f-469c-b8ea-7b4110a11fe8";

// MVP-hardcoded project-name → domain mapping.
// Phase 2: digester sets the domain richer per issue.
const PROJECT_NAME_TO_DOMAIN: Record<string, string> = {
  "organizational development": "governance",
  "security": "security",
  "pricing": "pricing",
  "operations": "ops",
  "hiring": "hiring",
  "marketing": "marketing",
  "business development": "bd-intel",
  "runtime": "runtime",
  "ssi": "ssi-hp",
};

export type KnowledgeDomain =
  | "ssi-hp"
  | "bd-intel"
  | "governance"
  | "runtime"
  | "pricing"
  | "ops"
  | "hiring"
  | "security"
  | "marketing";

export interface PriorRunKnowledgeEntry {
  taskId: string;
  summary: string;
  antiPatterns: string[];
  decisions: string[];
  link: string;
}

interface IndexPointerRow {
  task_id: string;
  identifier: string;
  specialty: string;
  domain: string;
  summary: string;
  anti_patterns?: string[];
  decided_at: string;
}

export function isSSIDirector(agentId: string | null | undefined): boolean {
  return agentId === SSI_DIRECTOR_AGENT_ID;
}

export function resolveProjectDomain(projectName: string | null | undefined): KnowledgeDomain {
  if (!projectName) return "ssi-hp";
  const key = projectName.toLowerCase().trim();
  return (PROJECT_NAME_TO_DOMAIN[key] as KnowledgeDomain | undefined) ?? "ssi-hp";
}

function companyKnowledgeDir(instanceRoot: string, companyId: string): string {
  return path.join(instanceRoot, "companies", companyId, "knowledge");
}

function specialtyIndexPath(knowledgeDir: string, specialty: string): string {
  return path.join(knowledgeDir, "index", "by_specialty", `${specialty}.jsonl`);
}

function readJsonlRows(filePath: string): IndexPointerRow[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as IndexPointerRow];
      } catch {
        return [];
      }
    });
}

/**
 * Extract a YAML block-sequence from raw YAML text for a given key.
 * Handles the format produced by the `yaml` npm package's stringify().
 * Returns undefined when the key is absent, preserving JSONL fallback semantics.
 */
function parseYamlBlockScalar(
  lines: string[],
  startIndex: number,
  marker: string,
  parentIndent: number,
): { value: string; nextIndex: number } {
  const contentLines: string[] = [];
  let index = startIndex;
  let contentIndent: number | undefined;

  while (index < lines.length) {
    const line = lines[index]!;
    const indent = line.match(/^ */)?.[0].length ?? 0;
    if (line.trim() !== "" && indent <= parentIndent) break;
    if (line.trim() !== "") contentIndent = Math.min(contentIndent ?? indent, indent);
    contentLines.push(line);
    index += 1;
  }

  const stripped = contentLines.map((line) => {
    if (line.trim() === "") return "";
    return line.slice(contentIndent ?? parentIndent + 1);
  });
  const folded = marker.startsWith(">");
  let value = folded
    ? stripped.reduce((result, line, lineIndex) => {
        if (line === "" || stripped[lineIndex + 1] === "") return `${result}${line}\n`;
        return `${result}${line}${lineIndex === stripped.length - 1 ? "" : " "}`;
      }, "")
    : stripped.join("\n");

  const chomping = marker.slice(1);
  if (chomping === "-") value = value.replace(/\n+$/, "");
  else if (chomping !== "+") value = `${value.replace(/\n*$/, "")}\n`;
  return { value, nextIndex: index };
}

function extractYamlList(content: string, key: string): string[] | undefined {
  const result: string[] = [];
  const lines = content.split("\n");

  const keyIndex = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (keyIndex < 0) return undefined;
  const inlineValue = lines[keyIndex]!.slice(key.length + 1).trim();
  if (inlineValue) return inlineValue === "[]" ? [] : undefined;

  let index = keyIndex + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === "") { index += 1; continue; }
    const itemMatch = line.match(/^(\s*)-\s?(.*)$/);
    if (!itemMatch || itemMatch[1]!.length !== 2) break;
    const remainder = itemMatch[2]!;
    index += 1;
    if (/^[|>][+-]?$/.test(remainder)) {
      const block = parseYamlBlockScalar(lines, index, remainder, 2);
      result.push(block.value);
      index = block.nextIndex;
      continue;
    }
    const stripped = parseYamlScalar(remainder);
    if (stripped.length > 0) result.push(stripped);
  }
  return result;
}

function parseYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string; } catch { return trimmed.slice(1, -1); }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function readYamlScalarField(content: string, key: string): string | undefined {
  const lines = content.split("\n");
  const lineIndex = lines.findIndex((candidate) => candidate.startsWith(`${key}:`));
  if (lineIndex < 0) return undefined;
  const line = lines[lineIndex]!;
  const value = line.slice(key.length + 1).trim();
  if (/^[|>][+-]?$/.test(value)) {
    return parseYamlBlockScalar(lines, lineIndex + 1, value, line.match(/^ */)?.[0].length ?? 0).value;
  }
  return value ? parseYamlScalar(value) : undefined;
}

interface ParsedYamlEntry {
  taskId?: string;
  identifier?: string;
  summary?: string;
  antiPatterns?: string[];
  decisions?: string[];
}

function readYamlEntry(yamlPath: string): ParsedYamlEntry | null {
  if (!fs.existsSync(yamlPath)) return null;
  try {
    const content = fs.readFileSync(yamlPath, "utf8");
    return {
      taskId: readYamlScalarField(content, "task_id"),
      identifier: readYamlScalarField(content, "identifier"),
      summary: readYamlScalarField(content, "summary"),
      antiPatterns: extractYamlList(content, "anti_patterns"),
      decisions: extractYamlList(content, "decisions"),
    };
  } catch { return null; }
}

function yamlPathForEntry(knowledgeDir: string, identifier: string, decidedAt: string): string {
  const dt = new Date(decidedAt);
  const yyyy = dt.getUTCFullYear().toString();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return path.join(knowledgeDir, "tasks", yyyy, mm, `${identifier}.yaml`);
}

function entryLink(identifier: string): string {
  const prefix = identifier.includes("-") ? identifier.split("-")[0] : "SAG";
  return `/${prefix}/issues/${identifier}`;
}

export function readPriorRunKnowledge(
  companyId: string,
  specialty: string,
  domain: string,
  currentIdentifier: string,
  {
    limit = 5,
    knowledgeDir: knowledgeDirOverride,
  }: { limit?: number; knowledgeDir?: string } = {},
): PriorRunKnowledgeEntry[] {
  const knowledgeDir =
    knowledgeDirOverride ?? companyKnowledgeDir(resolvePaperclipInstanceRoot(), companyId);

  const rows = readJsonlRows(specialtyIndexPath(knowledgeDir, specialty))
    .filter((r) => r.domain === domain && r.identifier !== currentIdentifier)
    .sort((a, b) => new Date(b.decided_at).getTime() - new Date(a.decided_at).getTime())
    .slice(0, limit);

  return rows.map((row) => {
    const yamlPath = yamlPathForEntry(knowledgeDir, row.identifier, row.decided_at);
    const yamlEntry = readYamlEntry(yamlPath);
    return {
      // JSONL is the selection index; project the complete response from YAML.
      taskId: yamlEntry?.identifier ?? row.identifier,
      summary: yamlEntry?.summary ?? row.summary,
      antiPatterns: yamlEntry?.antiPatterns ?? row.anti_patterns ?? [],
      decisions: yamlEntry?.decisions ?? [],
      link: entryLink(row.identifier),
    };
  });
}
