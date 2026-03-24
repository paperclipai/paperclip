/**
 * Auto-Research Service
 *
 * Automatically discovers relevant skills from the skill-zeka registry
 * when agents are assigned tasks. Matches issue keywords against skill
 * metadata and injects matched skills into the agent's allowlist.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegistrySkill {
  name: string;
  description: string;
  category: string;
  categories: string[];
  technologies: string[];
  actions: string[];
  tags: string[];
  risk: string;
  source: string;
  specificity: number;
  location: string;
  has_scripts: boolean;
  has_references: boolean;
}

interface RegistryFile {
  generated_at: string;
  total: number;
  skills: RegistrySkill[];
}

export interface AutoResearchResult {
  matchedSkills: Array<{ name: string; score: number; path: string }>;
  addedSkillKeys: string[];
  knowledgeEntries: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Stopwords (EN + TR)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "to", "of", "in", "for", "on",
  "with", "at", "by", "from", "as", "into", "through", "and", "or",
  "but", "if", "then", "else", "when", "up", "out", "no", "not",
  // Turkish
  "bir", "ve", "ile", "icin", "bu", "de", "da", "den", "dan", "ne",
  "mi", "mu", "var", "yok", "daha", "cok", "en", "gibi", "her", "ama",
  "veya", "ya", "olan", "olarak", "uzerinde", "hakkinda", "sonra",
  "once", "kadar",
]);

// ---------------------------------------------------------------------------
// Registry cache (5-min TTL)
// ---------------------------------------------------------------------------

const REGISTRY_PATH = join(
  homedir(),
  ".claude",
  "skills",
  "skill-zeka",
  "data",
  "registry.json",
);

let cachedRegistry: RegistryFile | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function loadRegistry(): Promise<RegistryFile> {
  const now = Date.now();
  if (cachedRegistry && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedRegistry;
  }

  const raw = await readFile(REGISTRY_PATH, "utf-8");
  cachedRegistry = JSON.parse(raw) as RegistryFile;
  cacheTimestamp = now;
  return cachedRegistry;
}

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/**
 * Extract meaningful keywords from text. Lowercases, strips punctuation,
 * removes stopwords, and deduplicates.
 */
function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\u00e7\u011f\u0131\u00f6\u015f\u00fc\-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

  return [...new Set(tokens)];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a single registry skill against the extracted keywords.
 * Counts how many keywords appear in the skill's name, description,
 * tags, categories, technologies, or actions. Normalizes by keyword count.
 */
function scoreSkill(skill: RegistrySkill, keywords: string[]): number {
  if (keywords.length === 0) return 0;

  // Build a single searchable blob from the skill metadata
  const blob = [
    skill.name,
    skill.description,
    ...skill.tags,
    ...skill.categories,
    ...skill.technologies,
    ...skill.actions,
  ]
    .join(" ")
    .toLowerCase();

  let hits = 0;
  for (const kw of keywords) {
    if (blob.includes(kw)) {
      hits++;
    }
  }

  return hits / keywords.length;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function autoResearchSkills(opts: {
  issueTitle: string;
  issueDescription: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  companyId: string;
  db: Db;
}): Promise<AutoResearchResult> {
  const start = Date.now();
  const { db, agentId } = opts;

  // 1. Extract keywords from issue
  const combinedText = `${opts.issueTitle} ${opts.issueDescription}`;
  const keywords = extractKeywords(combinedText);

  if (keywords.length === 0) {
    return {
      matchedSkills: [],
      addedSkillKeys: [],
      knowledgeEntries: 0,
      durationMs: Date.now() - start,
    };
  }

  // 2. Load registry
  const registry = await loadRegistry();

  // 3. Score all skills and pick top 5 with score > 0.2
  const scored = registry.skills
    .map((skill) => ({
      name: skill.name,
      score: scoreSkill(skill, keywords),
      path: skill.location,
    }))
    .filter((s) => s.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    return {
      matchedSkills: [],
      addedSkillKeys: [],
      knowledgeEntries: 0,
      durationMs: Date.now() - start,
    };
  }

  // 4. Read the agent's current runtimeConfig
  const [agentRow] = await db.execute<{
    runtime_config: Record<string, unknown> | null;
  }>(
    sql`SELECT runtime_config FROM agents WHERE id = ${agentId} LIMIT 1`,
  );

  if (!agentRow) {
    console.warn(`[autoresearch] Agent ${agentId} not found`);
    return {
      matchedSkills: scored,
      addedSkillKeys: [],
      knowledgeEntries: 0,
      durationMs: Date.now() - start,
    };
  }

  const runtimeConfig =
    (agentRow.runtime_config as Record<string, unknown>) ?? {};
  const skillAllowlist =
    (runtimeConfig.skillAllowlist as Record<string, unknown>) ?? {};
  const currentAllowed = Array.isArray(skillAllowlist.allowed)
    ? (skillAllowlist.allowed as string[])
    : [];

  // 5. Determine which skills need to be added
  const existingSet = new Set(currentAllowed);
  const newSkillKeys = scored
    .map((s) => s.name)
    .filter((name) => !existingSet.has(name));

  // 6. Update agent's allowlist if there are new skills
  if (newSkillKeys.length > 0) {
    const updatedAllowed = [...currentAllowed, ...newSkillKeys];
    const updatedConfig = {
      ...runtimeConfig,
      skillAllowlist: {
        ...skillAllowlist,
        enabled:
          typeof skillAllowlist.enabled === "boolean"
            ? skillAllowlist.enabled
            : true,
        allowed: updatedAllowed,
      },
    };

    await db.execute(
      sql`UPDATE agents
          SET runtime_config = ${JSON.stringify(updatedConfig)}::jsonb,
              updated_at = now()
          WHERE id = ${agentId}`,
    );

    console.log(
      `[autoresearch] Agent ${opts.agentName}: added ${newSkillKeys.length} skills → [${newSkillKeys.join(", ")}]`,
    );
  }

  const result: AutoResearchResult = {
    matchedSkills: scored,
    addedSkillKeys: newSkillKeys,
    knowledgeEntries: scored.length,
    durationMs: Date.now() - start,
  };

  console.log(
    `[autoresearch] Completed in ${result.durationMs}ms: ` +
      `${scored.length} matches, ${newSkillKeys.length} new skills for ${opts.agentName}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Context enrichment builder
// ---------------------------------------------------------------------------

/**
 * Build a markdown summary of auto-research results, suitable for
 * injection into an agent's context window.
 */
export function buildAutoResearchContext(result: AutoResearchResult): string {
  if (result.matchedSkills.length === 0) {
    return "";
  }

  const lines: string[] = [
    "## Auto-Research: Skill Discovery",
    "",
    `Found ${result.matchedSkills.length} relevant skill(s) in ${result.durationMs}ms:`,
    "",
  ];

  for (const skill of result.matchedSkills) {
    const badge = result.addedSkillKeys.includes(skill.name)
      ? " (NEW)"
      : " (already allowed)";
    lines.push(
      `- **${skill.name}** — score ${skill.score.toFixed(2)}${badge}`,
    );
    lines.push(`  Path: \`${skill.path}\``);
  }

  if (result.addedSkillKeys.length > 0) {
    lines.push("");
    lines.push(
      `> ${result.addedSkillKeys.length} skill(s) were automatically added to your allowlist.`,
    );
  }

  return lines.join("\n");
}
