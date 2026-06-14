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
 * Falls back to an empty array if the key is absent or the content is malformed.
 */
function extractYamlList(content: string, key: string): string[] {
  const result: string[] = [];
  const lines = content.split("\n");
  let inBlock = false;
  let currentParts: string[] = [];

  const flush = () => {
    if (currentParts.length > 0) {
      // Join continuation parts, collapse interior whitespace
      const joined = currentParts.join(" ").trim();
      // Strip surrounding single or double quotes (yaml stringify may add them)
      const stripped =
        (joined.startsWith('"') && joined.endsWith('"')) ||
        (joined.startsWith("'") && joined.endsWith("'"))
          ? joined.slice(1, -1)
          : joined;
      if (stripped.length > 0) result.push(stripped);
      currentParts = [];
    }
  };

  for (const line of lines) {
    if (!inBlock) {
      if (line === `${key}:`) {
        inBlock = true;
      }
      continue;
    }

    // Blank line inside the block: end-of-item separator, keep in block
    if (line.trim() === "") continue;

    // Non-indented line = new root key, end the block
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      break;
    }

    const itemMatch = line.match(/^  - (.*)/);
    if (itemMatch) {
      flush();
      // Value may be empty on this line if it continues on next
      currentParts.push(itemMatch[1]);
    } else if (/^    /.test(line) && currentParts.length > 0) {
      // Continuation of the current list item (4-space indent)
      currentParts.push(line.trim());
    }
  }

  flush();
  return result;
}

function readYamlListField(yamlPath: string, field: string): string[] {
  if (!fs.existsSync(yamlPath)) return [];
  try {
    const content = fs.readFileSync(yamlPath, "utf8");
    return extractYamlList(content, field);
  } catch {
    return [];
  }
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
    const decisions = readYamlListField(yamlPath, "decisions");
    return {
      taskId: row.task_id,
      summary: row.summary,
      antiPatterns: row.anti_patterns ?? [],
      decisions,
      link: entryLink(row.identifier),
    };
  });
}
