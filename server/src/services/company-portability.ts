import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityEnvInput,
  CompanyPortabilityExport,
  CompanyPortabilityExportResult,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityProjectManifestEntry,
  CompanyPortabilityIssueManifestEntry,
  CompanyPortabilitySkillManifestEntry,
  CompanySkill,
} from "@paperclipai/shared";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PROJECT_STATUSES,
  deriveProjectUrlKey,
  normalizeAgentUrlKey,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { companySkillService } from "./company-skills.js";
import { companyService } from "./companies.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";

const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: false,
  issues: false,
};

const DEFAULT_COLLISION_STRATEGY: CompanyPortabilityCollisionStrategy = "rename";
const execFileAsync = promisify(execFile);
let bundledSkillsCommitPromise: Promise<string | null> | null = null;

function isSensitiveEnvKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.includes("api_key") ||
    normalized.includes("api-key") ||
    normalized.includes("access_token") ||
    normalized.includes("access-token") ||
    normalized.includes("auth_token") ||
    normalized.includes("auth-token") ||
    normalized.includes("authorization") ||
    normalized.includes("bearer") ||
    normalized.includes("secret") ||
    normalized.includes("passwd") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("jwt") ||
    normalized.includes("private_key") ||
    normalized.includes("private-key") ||
    normalized.includes("cookie") ||
    normalized.includes("connectionstring")
  );
}

type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: string[];
};

type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type CompanyPackageIncludeEntry = {
  path: string;
};

type PaperclipExtensionDoc = {
  schema?: string;
  company?: Record<string, unknown> | null;
  agents?: Record<string, Record<string, unknown>> | null;
  projects?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
};

type ProjectLike = {
  id: string;
  name: string;
  description: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  status: string;
  executionWorkspacePolicy: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
};

type IssueLike = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  projectId: string | null;
  assigneeAgentId: string | null;
  status: string;
  priority: string;
  labelIds?: string[];
  billingCode: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  assigneeAdapterOverrides: Record<string, unknown> | null;
};

type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
};

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

type EnvInputRecord = {
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  default?: string | null;
  description?: string | null;
  portability?: "portable" | "system_dependent";
};

const RUNTIME_DEFAULT_RULES: Array<{ path: string[]; value: unknown }> = [
  { path: ["heartbeat", "cooldownSec"], value: 10 },
  { path: ["heartbeat", "intervalSec"], value: 3600 },
  { path: ["heartbeat", "wakeOnOnDemand"], value: true },
  { path: ["heartbeat", "wakeOnAssignment"], value: true },
  { path: ["heartbeat", "wakeOnAutomation"], value: true },
  { path: ["heartbeat", "wakeOnDemand"], value: true },
  { path: ["heartbeat", "maxConcurrentRuns"], value: 3 },
];

const ADAPTER_DEFAULT_RULES_BY_TYPE: Record<string, Array<{ path: string[]; value: unknown }>> = {
  codex_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  gemini_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  opencode_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  cursor: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  claude_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
    { path: ["maxTurnsPerRun"], value: 300 },
  ],
  openclaw_gateway: [
    { path: ["timeoutSec"], value: 120 },
    { path: ["waitTimeoutMs"], value: 120000 },
    { path: ["sessionKeyStrategy"], value: "fixed" },
    { path: ["sessionKey"], value: "paperclip" },
    { path: ["role"], value: "operator" },
    { path: ["scopes"], value: ["operator.admin"] },
  ],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toSafeSlug(input: string, fallback: string) {
  return normalizeAgentUrlKey(input) ?? fallback;
}

function uniqueSlug(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

function uniqueNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeAgentUrlKey(baseName) ?? "agent";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeAgentUrlKey(candidateName) ?? `agent-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function uniqueProjectName(baseName: string, existingProjectSlugs: Set<string>) {
  const baseSlug = deriveProjectUrlKey(baseName, baseName);
  if (!existingProjectSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = deriveProjectUrlKey(candidateName, candidateName);
    if (!existingProjectSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    issues: input?.issues ?? DEFAULT_INCLUDE.issues,
  };
}

function normalizePortablePath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function resolvePortablePath(fromPath: string, targetPath: string) {
  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
  return normalizePortablePath(path.posix.join(baseDir, targetPath.replace(/\\/g, "/")));
}

function normalizeFileMap(
  files: Record<string, string>,
  rootPath?: string | null,
): Record<string, string> {
  const normalizedRoot = rootPath ? normalizePortablePath(rootPath) : null;
  const out: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    let nextPath = normalizePortablePath(rawPath);
    if (normalizedRoot && nextPath === normalizedRoot) {
      continue;
    }
    if (normalizedRoot && nextPath.startsWith(`${normalizedRoot}/`)) {
      nextPath = nextPath.slice(normalizedRoot.length + 1);
    }
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

function findPaperclipExtensionPath(files: Record<string, string>) {
  if (typeof files[".paperclip.yaml"] === "string") return ".paperclip.yaml";
  if (typeof files[".paperclip.yml"] === "string") return ".paperclip.yml";
  return Object.keys(files).find((entry) => entry.endsWith("/.paperclip.yaml") || entry.endsWith("/.paperclip.yml")) ?? null;
}

function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

function normalizePortableConfig(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (key === "cwd" || key === "instructionsFilePath" || key === "promptTemplate") continue;
    if (key === "env") continue;
    next[key] = entry;
  }

  return next;
}

function isAbsoluteCommand(value: string) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function extractPortableEnvInputs(
  agentSlug: string,
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInput[] {
  if (!isPlainRecord(envValue)) return [];
  const env = envValue as Record<string, unknown>;
  const inputs: CompanyPortabilityEnvInput[] = [];

  for (const [key, binding] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      warnings.push(`Agent ${agentSlug} PATH override was omitted from export because it is system-dependent.`);
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "secret_ref") {
      inputs.push({
        key,
        description: `Provide ${key} for agent ${agentSlug}`,
        agentSlug,
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      });
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "plain") {
      const defaultValue = asString(binding.value);
      const portability = defaultValue && isAbsoluteCommand(defaultValue)
        ? "system_dependent"
        : "portable";
      if (portability === "system_dependent") {
        warnings.push(`Agent ${agentSlug} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on agent ${agentSlug}`,
        agentSlug,
        kind: "plain",
        requirement: "optional",
        defaultValue: defaultValue ?? "",
        portability,
      });
      continue;
    }

    if (typeof binding === "string") {
      const portability = isAbsoluteCommand(binding) ? "system_dependent" : "portable";
      if (portability === "system_dependent") {
        warnings.push(`Agent ${agentSlug} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on agent ${agentSlug}`,
        agentSlug,
        kind: isSensitiveEnvKey(key) ? "secret" : "plain",
        requirement: "optional",
        defaultValue: binding,
        portability,
      });
    }
  }

  return inputs;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPathDefault(pathSegments: string[], value: unknown, rules: Array<{ path: string[]; value: unknown }>) {
  return rules.some((rule) => jsonEqual(rule.path, pathSegments) && jsonEqual(rule.value, value));
}

function pruneDefaultLikeValue(
  value: unknown,
  opts: {
    dropFalseBooleans: boolean;
    path?: string[];
    defaultRules?: Array<{ path: string[]; value: unknown }>;
  },
): unknown {
  const pathSegments = opts.path ?? [];
  if (opts.defaultRules && isPathDefault(pathSegments, value, opts.defaultRules)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pruneDefaultLikeValue(entry, { ...opts, path: pathSegments }));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = pruneDefaultLikeValue(entry, {
        ...opts,
        path: [...pathSegments, key],
      });
      if (next === undefined) continue;
      out[key] = next;
    }
    return out;
  }
  if (value === undefined) return undefined;
  if (opts.dropFalseBooleans && value === false) return undefined;
  return value;
}

function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function stripEmptyValues(value: unknown, opts?: { preserveEmptyStrings?: boolean }): unknown {
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => stripEmptyValues(entry, opts))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripEmptyValues(entry, opts);
      if (cleaned === undefined) continue;
      next[key] = cleaned;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }
  if (
    value === undefined ||
    value === null ||
    (!opts?.preserveEmptyStrings && value === "") ||
    isEmptyArray(value) ||
    isEmptyObject(value)
  ) {
    return undefined;
  }
  return value;
}

const YAML_KEY_PRIORITY = [
  "name",
  "description",
  "title",
  "schema",
  "kind",
  "slug",
  "reportsTo",
  "skills",
  "owner",
  "assignee",
  "project",
  "schedule",
  "version",
  "license",
  "authors",
  "homepage",
  "tags",
  "includes",
  "requirements",
  "role",
  "icon",
  "capabilities",
  "brandColor",
  "adapter",
  "runtime",
  "permissions",
  "budgetMonthlyCents",
  "metadata",
] as const;

const YAML_KEY_PRIORITY_INDEX = new Map<string, number>(
  YAML_KEY_PRIORITY.map((key, index) => [key, index]),
);

function compareYamlKeys(left: string, right: string) {
  const leftPriority = YAML_KEY_PRIORITY_INDEX.get(left);
  const rightPriority = YAML_KEY_PRIORITY_INDEX.get(right);
  if (leftPriority !== undefined || rightPriority !== undefined) {
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  }
  return left.localeCompare(right);
}

function orderedYamlEntries(value: Record<string, unknown>) {
  return Object.entries(value).sort(([leftKey], [rightKey]) => compareYamlKeys(leftKey, rightKey));
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = orderedYamlEntries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${renderYamlScalar(value)}`];
}

function renderFrontmatter(frontmatter: Record<string, unknown>) {
  const lines: string[] = ["---"];
  for (const [key, value] of orderedYamlEntries(frontmatter)) {
    const scalar =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      Array.isArray(value) && value.length === 0 ||
      isEmptyObject(value);
    if (scalar) {
      lines.push(`${key}: ${renderYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(...renderYamlBlock(value, 1));
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const cleanBody = body.replace(/\r\n/g, "\n").trim();
  if (!cleanBody) {
    return `${renderFrontmatter(frontmatter)}\n`;
  }
  return `${renderFrontmatter(frontmatter)}\n${cleanBody}\n`;
}

async function resolveBundledSkillsCommit() {
  if (!bundledSkillsCommitPromise) {
    bundledSkillsCommitPromise = execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null);
  }
  return bundledSkillsCommitPromise;
}

async function buildSkillSourceEntry(skill: CompanySkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (asString(metadata?.sourceKind) === "paperclip_bundled") {
    const commit = await resolveBundledSkillsCommit();
    return {
      kind: "github-dir",
      repo: "paperclipai/paperclip",
      path: `skills/${skill.slug}`,
      commit,
      trackingRef: "master",
      url: `https://github.com/paperclipai/paperclip/tree/master/skills/${skill.slug}`,
    };
  }

  if (skill.sourceType === "github") {
    const owner = asString(metadata?.owner);
    const repo = asString(metadata?.repo);
    const repoSkillDir = asString(metadata?.repoSkillDir);
    if (!owner || !repo || !repoSkillDir) return null;
    return {
      kind: "github-dir",
      repo: `${owner}/${repo}`,
      path: repoSkillDir,
      commit: skill.sourceRef ?? null,
      trackingRef: asString(metadata?.trackingRef),
      url: skill.sourceLocator,
    };
  }

  if (skill.sourceType === "url" && skill.sourceLocator) {
    return {
      kind: "url",
      url: skill.sourceLocator,
    };
  }

  return null;
}

function shouldReferenceSkillOnExport(skill: CompanySkill, expandReferencedSkills: boolean) {
  if (expandReferencedSkills) return false;
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (asString(metadata?.sourceKind) === "paperclip_bundled") return true;
  return skill.sourceType === "github" || skill.sourceType === "url";
}

async function buildReferencedSkillMarkdown(skill: CompanySkill) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const frontmatter: Record<string, unknown> = {
    name: skill.name,
    description: skill.description ?? null,
  };
  if (sourceEntry) {
    frontmatter.metadata = {
      sources: [sourceEntry],
    };
  }
  return buildMarkdown(frontmatter, "");
}

async function withSkillSourceMetadata(skill: CompanySkill, markdown: string) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  if (!sourceEntry) return markdown;
  const parsed = parseFrontmatterMarkdown(markdown);
  const metadata = isPlainRecord(parsed.frontmatter.metadata)
    ? { ...parsed.frontmatter.metadata }
    : {};
  const existingSources = Array.isArray(metadata.sources)
    ? metadata.sources.filter((entry) => isPlainRecord(entry))
    : [];
  metadata.sources = [...existingSources, sourceEntry];
  const frontmatter = {
    ...parsed.frontmatter,
    metadata,
  };
  return buildMarkdown(frontmatter, parsed.body);
}

function renderCompanyAgentsSection(agentSummaries: Array<{ slug: string; name: string }>) {
  const lines = ["# Agents", ""];
  if (agentSummaries.length === 0) {
    lines.push("- _none_");
    return lines.join("\n");
  }
  for (const agent of agentSummaries) {
    lines.push(`- ${agent.slug} - ${agent.name}`);
  }
  return lines.join("\n");
}

function parseYamlScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (trimmed === "") return "";
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    trimmed.startsWith("\"") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function prepareYamlLines(raw: string) {
  return raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
}

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) {
    index += 1;
  }
  if (index >= lines.length || lines[index]!.indent < indentLevel) {
    return { value: {}, nextIndex: index };
  }

  const isArray = lines[index]!.indent === indentLevel && lines[index]!.content.startsWith("-");
  if (isArray) {
    const values: unknown[] = [];
    while (index < lines.length) {
      const line = lines[index]!;
      if (line.indent < indentLevel) break;
      if (line.indent !== indentLevel || !line.content.startsWith("-")) break;
      const remainder = line.content.slice(1).trim();
      index += 1;
      if (!remainder) {
        const nested = parseYamlBlock(lines, index, indentLevel + 2);
        values.push(nested.value);
        index = nested.nextIndex;
        continue;
      }
      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0 &&
        !remainder.startsWith("\"") &&
        !remainder.startsWith("{") &&
        !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
        continue;
      }
      values.push(parseYamlScalar(remainder));
    }
    return { value: values, nextIndex: index };
  }

  const record: Record<string, unknown> = {};
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.indent < indentLevel) break;
    if (line.indent !== indentLevel) {
      index += 1;
      continue;
    }
    const separatorIndex = line.content.indexOf(":");
    if (separatorIndex <= 0) {
      index += 1;
      continue;
    }
    const key = line.content.slice(0, separatorIndex).trim();
    const remainder = line.content.slice(separatorIndex + 1).trim();
    index += 1;
    if (!remainder) {
      const nested = parseYamlBlock(lines, index, indentLevel + 2);
      record[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    record[key] = parseYamlScalar(remainder);
  }

  return { value: record, nextIndex: index };
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const prepared = prepareYamlLines(raw);
  if (prepared.length === 0) return {};
  const parsed = parseYamlBlock(prepared, 0, prepared[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function parseYamlFile(raw: string): Record<string, unknown> {
  return parseYamlFrontmatter(raw);
}

function buildYamlFile(value: Record<string, unknown>, opts?: { preserveEmptyStrings?: boolean }) {
  const cleaned = stripEmptyValues(value, opts);
  if (!isPlainRecord(cleaned)) return "{}\n";
  return renderYamlBlock(cleaned, 0).join("\n") + "\n";
}

function parseFrontmatterMarkdown(raw: string): MarkdownDoc {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const closing = normalized.indexOf("\n---\n", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized.trim() };
  }
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchOptionalText(url: string) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function dedupeEnvInputs(values: CompanyPortabilityManifest["envInputs"]) {
  const seen = new Set<string>();
  const out: CompanyPortabilityManifest["envInputs"] = [];
  for (const value of values) {
    const key = `${value.agentSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function buildEnvInputMap(inputs: CompanyPortabilityEnvInput[]) {
  const env: Record<string, Record<string, unknown>> = {};
  for (const input of inputs) {
    const entry: Record<string, unknown> = {
      kind: input.kind,
      requirement: input.requirement,
    };
    if (input.defaultValue !== null) entry.default = input.defaultValue;
    if (input.description) entry.description = input.description;
    if (input.portability === "system_dependent") entry.portability = "system_dependent";
    env[input.key] = entry;
  }
  return env;
}

function readCompanyApprovalDefault(_frontmatter: Record<string, unknown>) {
  return true;
}

function readIncludeEntries(frontmatter: Record<string, unknown>): CompanyPackageIncludeEntry[] {
  const includes = frontmatter.includes;
  if (!Array.isArray(includes)) return [];
  return includes.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ path: entry }];
    }
    if (isPlainRecord(entry)) {
      const pathValue = asString(entry.path);
      return pathValue ? [{ path: pathValue }] : [];
    }
    return [];
  });
}

function readAgentEnvInputs(
  extension: Record<string, unknown>,
  agentSlug: string,
): CompanyPortabilityManifest["envInputs"] {
  const inputs = isPlainRecord(extension.inputs) ? extension.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    const record = value as EnvInputRecord;
    return [{
      key,
      description: asString(record.description) ?? null,
      agentSlug,
      kind: record.kind === "plain" ? "plain" : "secret",
      requirement: record.requirement === "required" ? "required" : "optional",
      defaultValue: typeof record.default === "string" ? record.default : null,
      portability: record.portability === "system_dependent" ? "system_dependent" : "portable",
    }];
  });
}

function readAgentSkillRefs(frontmatter: Record<string, unknown>) {
  const skills = frontmatter.skills;
  if (!Array.isArray(skills)) return [];
  return Array.from(new Set(
    skills
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeAgentUrlKey(entry) ?? entry.trim())
      .filter(Boolean),
  ));
}

function buildManifestFromPackageFiles(
  files: Record<string, string>,
  opts?: { sourceLabel?: { companyId: string; companyName: string } | null },
): ResolvedSource {
  const normalizedFiles = normalizeFileMap(files);
  const companyPath =
    normalizedFiles["COMPANY.md"]
    ?? undefined;
  const resolvedCompanyPath = companyPath !== undefined
    ? "COMPANY.md"
    : Object.keys(normalizedFiles).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md");
  if (!resolvedCompanyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyDoc = parseFrontmatterMarkdown(normalizedFiles[resolvedCompanyPath]!);
  const companyFrontmatter = companyDoc.frontmatter;
  const paperclipExtensionPath = findPaperclipExtensionPath(normalizedFiles);
  const paperclipExtension = paperclipExtensionPath
    ? parseYamlFile(normalizedFiles[paperclipExtensionPath] ?? "")
    : {};
  const paperclipCompany = isPlainRecord(paperclipExtension.company) ? paperclipExtension.company : {};
  const paperclipAgents = isPlainRecord(paperclipExtension.agents) ? paperclipExtension.agents : {};
  const paperclipProjects = isPlainRecord(paperclipExtension.projects) ? paperclipExtension.projects : {};
  const paperclipTasks = isPlainRecord(paperclipExtension.tasks) ? paperclipExtension.tasks : {};
  const companyName =
    asString(companyFrontmatter.name)
    ?? opts?.sourceLabel?.companyName
    ?? "Imported Company";
  const companySlug =
    asString(companyFrontmatter.slug)
    ?? normalizeAgentUrlKey(companyName)
    ?? "company";

  const includeEntries = readIncludeEntries(companyFrontmatter);
  const referencedAgentPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md");
  const referencedProjectPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md");
  const referencedTaskPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/TASK.md") || entry === "TASK.md");
  const referencedSkillPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md");
  const discoveredAgentPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md",
  );
  const discoveredProjectPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md",
  );
  const discoveredTaskPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/TASK.md") || entry === "TASK.md",
  );
  const discoveredSkillPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md",
  );
  const agentPaths = Array.from(new Set([...referencedAgentPaths, ...discoveredAgentPaths])).sort();
  const projectPaths = Array.from(new Set([...referencedProjectPaths, ...discoveredProjectPaths])).sort();
  const taskPaths = Array.from(new Set([...referencedTaskPaths, ...discoveredTaskPaths])).sort();
  const skillPaths = Array.from(new Set([...referencedSkillPaths, ...discoveredSkillPaths])).sort();

  const manifest: CompanyPortabilityManifest = {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    source: opts?.sourceLabel ?? null,
    includes: {
      company: true,
      agents: true,
      projects: projectPaths.length > 0,
      issues: taskPaths.length > 0,
    },
    company: {
      path: resolvedCompanyPath,
      name: companyName,
      description: asString(companyFrontmatter.description),
      brandColor: asString(paperclipCompany.brandColor),
      requireBoardApprovalForNewAgents:
        typeof paperclipCompany.requireBoardApprovalForNewAgents === "boolean"
          ? paperclipCompany.requireBoardApprovalForNewAgents
          : readCompanyApprovalDefault(companyFrontmatter),
    },
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    envInputs: [],
  };

  const warnings: string[] = [];
  for (const agentPath of agentPaths) {
    const markdownRaw = normalizedFiles[agentPath];
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced agent file is missing from package: ${agentPath}`);
      continue;
    }
    const agentDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = agentDoc.frontmatter;
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(agentPath))) ?? "agent";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipAgents[slug]) ? paperclipAgents[slug] : {};
    const extensionAdapter = isPlainRecord(extension.adapter) ? extension.adapter : null;
    const extensionRuntime = isPlainRecord(extension.runtime) ? extension.runtime : null;
    const extensionPermissions = isPlainRecord(extension.permissions) ? extension.permissions : null;
    const extensionMetadata = isPlainRecord(extension.metadata) ? extension.metadata : null;
    const adapterConfig = isPlainRecord(extensionAdapter?.config)
      ? extensionAdapter.config
      : {};
    const runtimeConfig = extensionRuntime ?? {};
    const title = asString(frontmatter.title);

    manifest.agents.push({
      slug,
      name: asString(frontmatter.name) ?? title ?? slug,
      path: agentPath,
      skills: readAgentSkillRefs(frontmatter),
      role: asString(extension.role) ?? "agent",
      title,
      icon: asString(extension.icon),
      capabilities: asString(extension.capabilities),
      reportsToSlug: asString(frontmatter.reportsTo) ?? asString(extension.reportsTo),
      adapterType: asString(extensionAdapter?.type) ?? "process",
      adapterConfig,
      runtimeConfig,
      permissions: extensionPermissions ?? {},
      budgetMonthlyCents:
        typeof extension.budgetMonthlyCents === "number" && Number.isFinite(extension.budgetMonthlyCents)
          ? Math.max(0, Math.floor(extension.budgetMonthlyCents))
          : 0,
      metadata: extensionMetadata,
    });

    manifest.envInputs.push(...readAgentEnvInputs(extension, slug));

    if (frontmatter.kind && frontmatter.kind !== "agent") {
      warnings.push(`Agent markdown ${agentPath} does not declare kind: agent in frontmatter.`);
    }
  }

  for (const skillPath of skillPaths) {
    const markdownRaw = normalizedFiles[skillPath];
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced skill file is missing from package: ${skillPath}`);
      continue;
    }
    const skillDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = skillDoc.frontmatter;
    const skillDir = path.posix.dirname(skillPath);
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(skillDir)) ?? "skill";
    const slug = asString(frontmatter.slug) ?? normalizeAgentUrlKey(asString(frontmatter.name) ?? "") ?? fallbackSlug;
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || entry.startsWith(`${skillDir}/`))
      .map((entry) => ({
        path: entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
        kind: entry === skillPath
          ? "skill"
          : entry.startsWith(`${skillDir}/references/`)
            ? "reference"
            : entry.startsWith(`${skillDir}/scripts/`)
              ? "script"
              : entry.startsWith(`${skillDir}/assets/`)
                ? "asset"
                : entry.endsWith(".md")
                  ? "markdown"
                  : "other",
      }));
    const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
    const sources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
    const primarySource = sources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
    const sourceKind = asString(primarySource?.kind);
    let sourceType = "catalog";
    let sourceLocator: string | null = null;
    let sourceRef: string | null = null;
    let normalizedMetadata: Record<string, unknown> | null = null;

    if (sourceKind === "github-dir" || sourceKind === "github-file") {
      const repo = asString(primarySource?.repo);
      const repoPath = asString(primarySource?.path);
      const commit = asString(primarySource?.commit);
      const trackingRef = asString(primarySource?.trackingRef);
      const [owner, repoName] = (repo ?? "").split("/");
      sourceType = "github";
      sourceLocator = asString(primarySource?.url)
        ?? (repo ? `https://github.com/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}` : null);
      sourceRef = commit;
      normalizedMetadata = owner && repoName
        ? {
            sourceKind: "github",
            owner,
            repo: repoName,
            ref: commit,
            trackingRef,
            repoSkillDir: repoPath ?? `skills/${slug}`,
          }
        : null;
    } else if (sourceKind === "url") {
      sourceType = "url";
      sourceLocator = asString(primarySource?.url) ?? asString(primarySource?.rawUrl);
      normalizedMetadata = {
        sourceKind: "url",
      };
    } else if (metadata) {
      normalizedMetadata = {
        sourceKind: "catalog",
      };
    }

    manifest.skills.push({
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: skillPath,
      description: asString(frontmatter.description),
      sourceType,
      sourceLocator,
      sourceRef,
      trustLevel: null,
      compatibility: "compatible",
      metadata: normalizedMetadata,
      fileInventory: inventory,
    });
  }

  for (const projectPath of projectPaths) {
    const markdownRaw = normalizedFiles[projectPath];
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced project file is missing from package: ${projectPath}`);
      continue;
    }
    const projectDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = projectDoc.frontmatter;
    const fallbackSlug = deriveProjectUrlKey(
      asString(frontmatter.name) ?? path.posix.basename(path.posix.dirname(projectPath)) ?? "project",
      projectPath,
    );
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipProjects[slug]) ? paperclipProjects[slug] : {};
    manifest.projects.push({
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: projectPath,
      description: asString(frontmatter.description),
      ownerAgentSlug: asString(frontmatter.owner),
      leadAgentSlug: asString(extension.leadAgentSlug),
      targetDate: asString(extension.targetDate),
      color: asString(extension.color),
      status: asString(extension.status),
      executionWorkspacePolicy: isPlainRecord(extension.executionWorkspacePolicy)
        ? extension.executionWorkspacePolicy
        : null,
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    if (frontmatter.kind && frontmatter.kind !== "project") {
      warnings.push(`Project markdown ${projectPath} does not declare kind: project in frontmatter.`);
    }
  }

  for (const taskPath of taskPaths) {
    const markdownRaw = normalizedFiles[taskPath];
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced task file is missing from package: ${taskPath}`);
      continue;
    }
    const taskDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = taskDoc.frontmatter;
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(taskPath))) ?? "task";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipTasks[slug]) ? paperclipTasks[slug] : {};
    const schedule = isPlainRecord(frontmatter.schedule) ? frontmatter.schedule : null;
    const recurrence = schedule && isPlainRecord(schedule.recurrence)
      ? schedule.recurrence
      : isPlainRecord(extension.recurrence)
        ? extension.recurrence
        : null;
    manifest.issues.push({
      slug,
      identifier: asString(extension.identifier),
      title: asString(frontmatter.name) ?? asString(frontmatter.title) ?? slug,
      path: taskPath,
      projectSlug: asString(frontmatter.project),
      assigneeAgentSlug: asString(frontmatter.assignee),
      description: taskDoc.body || asString(frontmatter.description),
      recurrence,
      status: asString(extension.status),
      priority: asString(extension.priority),
      labelIds: Array.isArray(extension.labelIds)
        ? extension.labelIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      billingCode: asString(extension.billingCode),
      executionWorkspaceSettings: isPlainRecord(extension.executionWorkspaceSettings)
        ? extension.executionWorkspaceSettings
        : null,
      assigneeAdapterOverrides: isPlainRecord(extension.assigneeAdapterOverrides)
        ? extension.assigneeAdapterOverrides
        : null,
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    if (frontmatter.kind && frontmatter.kind !== "task") {
      warnings.push(`Task markdown ${taskPath} does not declare kind: task in frontmatter.`);
    }
  }

  manifest.envInputs = dedupeEnvInputs(manifest.envInputs);
  return {
    manifest,
    files: normalizedFiles,
    warnings,
  };
}

function isGitCommitRef(value: string) {
  return /^[0-9a-f]{40}$/i.test(value.trim());
}

function parseGitHubSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.hostname !== "github.com") {
    throw unprocessable("GitHub source must use github.com URL");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  let ref = "main";
  let basePath = "";
  let companyPath = "COMPANY.md";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    const blobPath = parts.slice(4).join("/");
    if (!blobPath) {
      throw unprocessable("Invalid GitHub blob URL");
    }
    companyPath = blobPath;
    basePath = path.posix.dirname(blobPath);
    if (basePath === ".") basePath = "";
  }
  return { owner, repo, ref, basePath, companyPath };
}

function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  const normalizedFilePath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${normalizedFilePath}`;
}

async function readAgentInstructions(agent: AgentLike): Promise<{ body: string; warning: string | null }> {
  const config = agent.adapterConfig as Record<string, unknown>;
  const instructionsFilePath = asString(config.instructionsFilePath);
  if (instructionsFilePath) {
    const workspaceCwd = asString(process.env.PAPERCLIP_WORKSPACE_CWD);
    const candidates = new Set<string>();
    if (path.isAbsolute(instructionsFilePath)) {
      candidates.add(instructionsFilePath);
    } else {
      if (workspaceCwd) candidates.add(path.resolve(workspaceCwd, instructionsFilePath));
      candidates.add(path.resolve(process.cwd(), instructionsFilePath));
    }

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const body = await Promise.race([
          fs.readFile(candidate, "utf8"),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("timed out reading instructions file")), 1500);
          }),
        ]);
        return { body, warning: null };
      } catch {
        // try next candidate
      }
    }
  }
  const promptTemplate = asString(config.promptTemplate);
  if (promptTemplate) {
    const warning = instructionsFilePath
      ? `Agent ${agent.name} instructionsFilePath was not readable; fell back to promptTemplate.`
      : null;
    return {
      body: promptTemplate,
      warning,
    };
  }
  return {
    body: "_No AGENTS instructions were resolved from current agent config._",
    warning: `Agent ${agent.name} has no resolvable instructionsFilePath/promptTemplate; exported placeholder AGENTS.md.`,
  };
}

export function companyPortabilityService(db: Db) {
  const companies = companyService(db);
  const agents = agentService(db);
  const access = accessService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const companySkills = companySkillService(db);

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return buildManifestFromPackageFiles(
        normalizeFileMap(source.files, source.rootPath),
      );
    }

    if (source.type === "url") {
      const normalizedUrl = source.url.trim();
      const companyUrl = normalizedUrl.endsWith(".md")
        ? normalizedUrl
        : new URL("COMPANY.md", normalizedUrl.endsWith("/") ? normalizedUrl : `${normalizedUrl}/`).toString();
      const companyMarkdown = await fetchText(companyUrl);
      const files: Record<string, string> = {
        "COMPANY.md": companyMarkdown,
      };
      const paperclipYaml = await fetchOptionalText(
        new URL(".paperclip.yaml", companyUrl).toString(),
      ).catch(() => null);
      if (paperclipYaml) {
        files[".paperclip.yaml"] = paperclipYaml;
      }
      const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
      const includeEntries = readIncludeEntries(companyDoc.frontmatter);

      for (const includeEntry of includeEntries) {
        const includePath = normalizePortablePath(includeEntry.path);
        if (!includePath.endsWith(".md")) continue;
        const includeUrl = new URL(includeEntry.path, companyUrl).toString();
        files[includePath] = await fetchText(includeUrl);
      }
      return buildManifestFromPackageFiles(files);
    }

    const parsed = parseGitHubSourceUrl(source.url);
    let ref = parsed.ref;
    const warnings: string[] = [];
    if (!isGitCommitRef(ref)) {
      warnings.push("GitHub source is not pinned to a commit SHA; imports may drift if the ref changes.");
    }
    const companyRelativePath = parsed.companyPath === "COMPANY.md"
      ? [parsed.basePath, "COMPANY.md"].filter(Boolean).join("/")
      : parsed.companyPath;
    let companyMarkdown: string | null = null;
    try {
      companyMarkdown = await fetchOptionalText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, companyRelativePath),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        companyMarkdown = await fetchOptionalText(
          resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, companyRelativePath),
        );
      } else {
        throw err;
      }
    }
    if (!companyMarkdown) {
      throw unprocessable("GitHub company package is missing COMPANY.md");
    }

    const companyPath = parsed.companyPath === "COMPANY.md"
      ? "COMPANY.md"
      : normalizePortablePath(path.posix.relative(parsed.basePath || ".", parsed.companyPath));
    const files: Record<string, string> = {
      [companyPath]: companyMarkdown,
    };
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => ({ tree: [] }));
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const candidatePaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        if (basePrefix && !entry.startsWith(basePrefix)) return false;
        const relative = basePrefix ? entry.slice(basePrefix.length) : entry;
        return (
          relative.endsWith(".md") ||
          relative.startsWith("skills/") ||
          relative === ".paperclip.yaml" ||
          relative === ".paperclip.yml"
        );
      });
    for (const repoPath of candidatePaths) {
      const relativePath = basePrefix ? repoPath.slice(basePrefix.length) : repoPath;
      if (files[relativePath] !== undefined) continue;
      files[normalizePortablePath(relativePath)] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
      );
    }
    const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
    const includeEntries = readIncludeEntries(companyDoc.frontmatter);
    for (const includeEntry of includeEntries) {
      const repoPath = [parsed.basePath, includeEntry.path].filter(Boolean).join("/");
      const relativePath = normalizePortablePath(includeEntry.path);
      if (files[relativePath] !== undefined) continue;
      if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
      files[relativePath] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoPath),
      );
    }

    const resolved = buildManifestFromPackageFiles(files);
    resolved.warnings.unshift(...warnings);
    return resolved;
  }

  async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude({
      ...input.include,
      projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
      issues:
        (input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0)
          ? true
          : input.include?.issues,
    });
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, string> = {};
    const warnings: string[] = [];
    const envInputs: CompanyPortabilityManifest["envInputs"] = [];
    const rootPath = normalizeAgentUrlKey(company.name) ?? "company-package";

    const allAgentRows = include.agents ? await agents.list(companyId, { includeTerminated: true }) : [];
    const agentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    const companySkillRows = await companySkills.list(companyId);
    if (include.agents) {
      const skipped = allAgentRows.length - agentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    const projectsSvc = projectService(db);
    const issuesSvc = issueService(db);
    const allProjects = include.projects || include.issues ? await projectsSvc.list(companyId) : [];
    const projectById = new Map(allProjects.map((project) => [project.id, project]));
    const projectByReference = new Map<string, typeof allProjects[number]>();
    for (const project of allProjects) {
      projectByReference.set(project.id, project);
      projectByReference.set(project.urlKey, project);
    }

    const selectedProjects = new Map<string, typeof allProjects[number]>();
    const normalizeProjectSelector = (selector: string) => selector.trim().toLowerCase();
    for (const selector of input.projects ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
    }

    const selectedIssues = new Map<string, Awaited<ReturnType<typeof issuesSvc.getById>>>();
    const resolveIssueBySelector = async (selector: string) => {
      const trimmed = selector.trim();
      if (!trimmed) return null;
      return trimmed.includes("-")
        ? issuesSvc.getByIdentifier(trimmed)
        : issuesSvc.getById(trimmed);
    };
    for (const selector of input.issues ?? []) {
      const issue = await resolveIssueBySelector(selector);
      if (!issue || issue.companyId !== companyId) {
        warnings.push(`Issue selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedIssues.set(issue.id, issue);
      if (issue.projectId) {
        const parentProject = projectById.get(issue.projectId);
        if (parentProject) selectedProjects.set(parentProject.id, parentProject);
      }
    }

    for (const selector of input.projectIssues ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project-issues selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
      const projectIssues = await issuesSvc.list(companyId, { projectId: match.id });
      for (const issue of projectIssues) {
        selectedIssues.set(issue.id, issue);
      }
    }

    if (include.projects && selectedProjects.size === 0) {
      for (const project of allProjects) {
        selectedProjects.set(project.id, project);
      }
    }

    if (include.issues && selectedIssues.size === 0) {
      const allIssues = await issuesSvc.list(companyId);
      for (const issue of allIssues) {
        selectedIssues.set(issue.id, issue);
        if (issue.projectId) {
          const parentProject = projectById.get(issue.projectId);
          if (parentProject) selectedProjects.set(parentProject.id, parentProject);
        }
      }
    }

    const selectedProjectRows = Array.from(selectedProjects.values())
      .sort((left, right) => left.name.localeCompare(right.name));
    const selectedIssueRows = Array.from(selectedIssues.values())
      .filter((issue): issue is NonNullable<typeof issue> => issue != null)
      .sort((left, right) => (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title));

    const taskSlugByIssueId = new Map<string, string>();
    const usedTaskSlugs = new Set<string>();
    for (const issue of selectedIssueRows) {
      const baseSlug = normalizeAgentUrlKey(issue.identifier ?? issue.title) ?? "task";
      taskSlugByIssueId.set(issue.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }

    const projectSlugById = new Map<string, string>();
    const usedProjectSlugs = new Set<string>();
    for (const project of selectedProjectRows) {
      const baseSlug = deriveProjectUrlKey(project.name, project.name);
      projectSlugById.set(project.id, uniqueSlug(baseSlug, usedProjectSlugs));
    }

    const companyPath = "COMPANY.md";
    const companyBodySections: string[] = [];
    if (include.agents) {
      const companyAgentSummaries = agentRows.map((agent) => ({
        slug: idToSlug.get(agent.id) ?? "agent",
        name: agent.name,
      }));
      companyBodySections.push(renderCompanyAgentsSection(companyAgentSummaries));
    }
    if (selectedProjectRows.length > 0) {
      companyBodySections.push(
        ["# Projects", "", ...selectedProjectRows.map((project) => `- ${projectSlugById.get(project.id) ?? project.id} - ${project.name}`)].join("\n"),
      );
    }
    files[companyPath] = buildMarkdown(
      {
        name: company.name,
        description: company.description ?? null,
        schema: "agentcompanies/v1",
        slug: rootPath,
      },
      companyBodySections.join("\n\n").trim(),
    );

    const paperclipAgentsOut: Record<string, Record<string, unknown>> = {};
    const paperclipProjectsOut: Record<string, Record<string, unknown>> = {};
    const paperclipTasksOut: Record<string, Record<string, unknown>> = {};

    for (const skill of companySkillRows) {
      if (shouldReferenceSkillOnExport(skill, Boolean(input.expandReferencedSkills))) {
        files[`skills/${skill.slug}/SKILL.md`] = await buildReferencedSkillMarkdown(skill);
        continue;
      }

      for (const inventoryEntry of skill.fileInventory) {
        const fileDetail = await companySkills.readFile(companyId, skill.id, inventoryEntry.path).catch(() => null);
        if (!fileDetail) continue;
        const filePath = `skills/${skill.slug}/${inventoryEntry.path}`;
        files[filePath] = inventoryEntry.path === "SKILL.md"
          ? await withSkillSourceMetadata(skill, fileDetail.content)
          : fileDetail.content;
      }
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const instructions = await readAgentInstructions(agent);
        if (instructions.warning) warnings.push(instructions.warning);
        const agentPath = `agents/${slug}/AGENTS.md`;

        const envInputsStart = envInputs.length;
        const exportedEnvInputs = extractPortableEnvInputs(
          slug,
          (agent.adapterConfig as Record<string, unknown>).env,
          warnings,
        );
        envInputs.push(...exportedEnvInputs);
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.adapterConfig),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
        const agentEnvInputs = dedupeEnvInputs(
          envInputs
            .slice(envInputsStart)
            .filter((inputValue) => inputValue.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
        const desiredSkills = readPaperclipSkillSyncPreference(
          (agent.adapterConfig as Record<string, unknown>) ?? {},
        ).desiredSkills;

        const commandValue = asString(portableAdapterConfig.command);
        if (commandValue && isAbsoluteCommand(commandValue)) {
          warnings.push(`Agent ${slug} command ${commandValue} was omitted from export because it is system-dependent.`);
          delete portableAdapterConfig.command;
        }

        files[agentPath] = buildMarkdown(
          stripEmptyValues({
            name: agent.name,
            title: agent.title ?? null,
            reportsTo: reportsToSlug,
            skills: desiredSkills.length > 0 ? desiredSkills : undefined,
          }) as Record<string, unknown>,
          instructions.body,
        );

        const extension = stripEmptyValues({
          role: agent.role !== "agent" ? agent.role : undefined,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          adapter: {
            type: agent.adapterType,
            config: portableAdapterConfig,
          },
          runtime: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: (agent.budgetMonthlyCents ?? 0) > 0 ? agent.budgetMonthlyCents : undefined,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        });
        if (isPlainRecord(extension) && agentEnvInputs.length > 0) {
          extension.inputs = {
            env: buildEnvInputMap(agentEnvInputs),
          };
        }
        paperclipAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
      }
    }

    for (const project of selectedProjectRows) {
      const slug = projectSlugById.get(project.id)!;
      const projectPath = `projects/${slug}/PROJECT.md`;
      files[projectPath] = buildMarkdown(
        {
          name: project.name,
          description: project.description ?? null,
          owner: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        },
        project.description ?? "",
      );
      const extension = stripEmptyValues({
        leadAgentSlug: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        targetDate: project.targetDate ?? null,
        color: project.color ?? null,
        status: project.status,
        executionWorkspacePolicy: project.executionWorkspacePolicy ?? undefined,
      });
      paperclipProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
    }

    for (const issue of selectedIssueRows) {
      const taskSlug = taskSlugByIssueId.get(issue.id)!;
      const projectSlug = issue.projectId ? (projectSlugById.get(issue.projectId) ?? null) : null;
      const taskPath = projectSlug
        ? `projects/${projectSlug}/tasks/${taskSlug}/TASK.md`
        : `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = issue.assigneeAgentId ? (idToSlug.get(issue.assigneeAgentId) ?? null) : null;
      files[taskPath] = buildMarkdown(
        {
          name: issue.title,
          project: projectSlug,
          assignee: assigneeSlug,
        },
        issue.description ?? "",
      );
      const extension = stripEmptyValues({
        identifier: issue.identifier,
        status: issue.status,
        priority: issue.priority,
        labelIds: issue.labelIds ?? undefined,
        billingCode: issue.billingCode ?? null,
        executionWorkspaceSettings: issue.executionWorkspaceSettings ?? undefined,
        assigneeAdapterOverrides: issue.assigneeAdapterOverrides ?? undefined,
      });
      paperclipTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    const paperclipExtensionPath = ".paperclip.yaml";
    const paperclipAgents = Object.fromEntries(
      Object.entries(paperclipAgentsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipProjects = Object.fromEntries(
      Object.entries(paperclipProjectsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipTasks = Object.fromEntries(
      Object.entries(paperclipTasksOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    files[paperclipExtensionPath] = buildYamlFile(
      {
        schema: "paperclip/v1",
        company: stripEmptyValues({
          brandColor: company.brandColor ?? null,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents ? undefined : false,
        }),
        agents: Object.keys(paperclipAgents).length > 0 ? paperclipAgents : undefined,
        projects: Object.keys(paperclipProjects).length > 0 ? paperclipProjects : undefined,
        tasks: Object.keys(paperclipTasks).length > 0 ? paperclipTasks : undefined,
      },
      { preserveEmptyStrings: true },
    );

    const resolved = buildManifestFromPackageFiles(files, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = include;
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);
    return {
      rootPath,
      manifest: resolved.manifest,
      files,
      warnings: resolved.warnings,
      paperclipExtensionPath,
    };
  }

  async function buildPreview(input: CompanyPortabilityPreview): Promise<ImportPlanInternal> {
    const include = normalizeInclude(input.include);
    const source = await resolveSource(input.source);
    const manifest = source.manifest;
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }

    const selectedSlugs = include.agents
      ? (
          input.agents && input.agents !== "all"
            ? Array.from(new Set(input.agents))
            : manifest.agents.map((agent) => agent.slug)
        )
      : [];

    const selectedAgents = include.agents
      ? manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug))
      : [];
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    const availableSkillSlugs = new Set(source.manifest.skills.map((skill) => skill.slug));

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = source.files[filePath];
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
      for (const skillSlug of agent.skills) {
        if (!availableSkillSlugs.has(skillSlug)) {
          warnings.push(`Agent ${agent.slug} references skill ${skillSlug}, but that skill is not present in the package.`);
        }
      }
    }

    if (include.projects) {
      for (const project of manifest.projects) {
        const markdown = source.files[ensureMarkdownPath(project.path)];
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
          warnings.push(`Project markdown ${project.path} does not declare kind: project in frontmatter.`);
        }
      }
    }

    if (include.issues) {
      for (const issue of manifest.issues) {
        const markdown = source.files[ensureMarkdownPath(issue.path)];
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for task ${issue.slug}: ${issue.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
          warnings.push(`Task markdown ${issue.path} does not declare kind: task in frontmatter.`);
        }
        if (issue.recurrence) {
          warnings.push(`Task ${issue.slug} has recurrence metadata; Paperclip will import it as a one-time issue for now.`);
        }
      }
    }

    for (const envInput of manifest.envInputs) {
      if (envInput.portability === "system_dependent") {
        warnings.push(`Environment input ${envInput.key}${envInput.agentSlug ? ` for ${envInput.agentSlug}` : ""} is system-dependent and may need manual adjustment after import.`);
      }
    }

    let targetCompanyId: string | null = null;
    let targetCompanyName: string | null = null;

    if (input.target.mode === "existing_company") {
      const targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      targetCompanyId = targetCompany.id;
      targetCompanyName = targetCompany.name;
    }

    const agentPlans: CompanyPortabilityPreviewAgentPlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();
    const projectPlans: CompanyPortabilityPreviewResult["plan"]["projectPlans"] = [];
    const issuePlans: CompanyPortabilityPreviewResult["plan"]["issuePlans"] = [];
    const existingProjectSlugToProject = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
      const existingProjects = await projects.list(input.target.companyId);
      for (const existing of existingProjects) {
        if (!existingProjectSlugToProject.has(existing.urlKey)) {
          existingProjectSlugToProject.set(existing.urlKey, { id: existing.id, name: existing.name });
        }
        existingProjectSlugs.add(existing.urlKey);
      }
    }

    for (const manifestAgent of selectedAgents) {
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    if (include.projects) {
      for (const manifestProject of manifest.projects) {
        const existing = existingProjectSlugToProject.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        const renamed = uniqueProjectName(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(deriveProjectUrlKey(renamed, renamed));
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    if (include.issues) {
      for (const manifestIssue of manifest.issues) {
        issuePlans.push({
          slug: manifestIssue.slug,
          action: "create",
          plannedTitle: manifestIssue.title,
          reason: manifestIssue.recurrence ? "Recurrence will not be activated on import." : null,
        });
      }
    }

    const preview: CompanyPortabilityPreviewResult = {
      include,
      targetCompanyId,
      targetCompanyName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        companyAction: input.target.mode === "new_company"
          ? "create"
          : include.company
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        issuePlans,
      },
      envInputs: manifest.envInputs ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
    };
  }

  async function previewImport(input: CompanyPortabilityPreview): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
  ): Promise<CompanyPortabilityImportResult> {
    const plan = await buildPreview(input);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      const created = await companies.create({
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
          : true,
      });
      await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company) {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }
    const importedSlugToProjectId = new Map<string, string>();
    const existingProjectSlugToId = new Map<string, string>();
    const existingProjects = await projects.list(targetCompany.id);
    for (const existing of existingProjects) {
      existingProjectSlugToId.set(existing.urlKey, existing.id);
    }

    await companySkills.importPackageFiles(targetCompany.id, plan.source.files);

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const markdownRaw = plan.source.files[manifestAgent.path];
        if (!markdownRaw) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported without prompt template.`);
        }
        const markdown = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : { frontmatter: {}, body: "" };
        const adapterConfig = {
          ...manifestAgent.adapterConfig,
          promptTemplate: markdown.body || asString((manifestAgent.adapterConfig as Record<string, unknown>).promptTemplate) || "",
        } as Record<string, unknown>;
        const desiredSkills = manifestAgent.skills ?? [];
        const adapterConfigWithSkills = writePaperclipSkillSyncPreference(
          adapterConfig,
          desiredSkills,
        );
        delete adapterConfig.instructionsFilePath;
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          adapterType: manifestAgent.adapterType,
          adapterConfig: adapterConfigWithSkills,
          runtimeConfig: manifestAgent.runtimeConfig,
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          const updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing agent ${planAgent.existingAgentId}.`);
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        const created = await agents.create(targetCompany.id, patch);
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      // Apply reporting links once all imported agent ids are available.
      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, { reportsTo: managerId });
        } catch {
          warnings.push(`Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`);
        }
      }
    }

    if (include.projects) {
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = sourceManifest.projects.find((project) => project.slug === planProject.slug);
        if (!manifestProject) continue;
        if (planProject.action === "skip") continue;

        const projectLeadAgentId = manifestProject.leadAgentSlug
          ? importedSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? existingSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? null
          : null;
        const projectPatch = {
          name: planProject.plannedName,
          description: manifestProject.description,
          leadAgentId: projectLeadAgentId,
          targetDate: manifestProject.targetDate,
          color: manifestProject.color,
          status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
            ? manifestProject.status as typeof PROJECT_STATUSES[number]
            : "backlog",
          executionWorkspacePolicy: manifestProject.executionWorkspacePolicy,
        };

        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projects.update(planProject.existingProjectId, projectPatch);
          if (!updated) {
            warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
            continue;
          }
          importedSlugToProjectId.set(planProject.slug, updated.id);
          existingProjectSlugToId.set(updated.urlKey, updated.id);
          continue;
        }

        const created = await projects.create(targetCompany.id, projectPatch);
        importedSlugToProjectId.set(planProject.slug, created.id);
        existingProjectSlugToId.set(created.urlKey, created.id);
      }
    }

    if (include.issues) {
      for (const manifestIssue of sourceManifest.issues) {
        const markdownRaw = plan.source.files[manifestIssue.path];
        const parsed = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : null;
        const description = parsed?.body || manifestIssue.description || null;
        const assigneeAgentId = manifestIssue.assigneeAgentSlug
          ? importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? null
          : null;
        const projectId = manifestIssue.projectSlug
          ? importedSlugToProjectId.get(manifestIssue.projectSlug)
            ?? existingProjectSlugToId.get(manifestIssue.projectSlug)
            ?? null
          : null;
        await issues.create(targetCompany.id, {
          projectId,
          title: manifestIssue.title,
          description,
          assigneeAgentId,
          status: manifestIssue.status && ISSUE_STATUSES.includes(manifestIssue.status as any)
            ? manifestIssue.status as typeof ISSUE_STATUSES[number]
            : "backlog",
          priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
            ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
            : "medium",
          billingCode: manifestIssue.billingCode,
          assigneeAdapterOverrides: manifestIssue.assigneeAdapterOverrides,
          executionWorkspaceSettings: manifestIssue.executionWorkspaceSettings,
          labelIds: [],
        });
        if (manifestIssue.recurrence) {
          warnings.push(`Imported task ${manifestIssue.slug} as a one-time issue; recurrence metadata was not activated.`);
        }
      }
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      envInputs: sourceManifest.envInputs ?? [],
      warnings,
    };
  }

  return {
    exportBundle,
    previewImport,
    importBundle,
  };
}
