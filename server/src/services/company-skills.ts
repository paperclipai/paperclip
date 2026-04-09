import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import type {
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillCompatibility,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillImportResult,
  CompanySkillListItem,
  CompanySkillProjectScanConflict,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillProjectScanSkipped,
  CompanySkillSourceBadge,
  CompanySkillSourceType,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
  CompanySkillUsageAgent,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { findActiveServerAdapter } from "../adapters/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { secretService } from "./secrets.js";

type CompanySkillRow = typeof companySkills.$inferSelect;

type ImportedSkill = {
  key: string;
  slug: string;
  name: string;
  description: string | null;
  markdown: string;
  packageDir?: string | null;
  sourceType: CompanySkillSourceType;
  sourceLocator: string | null;
  sourceRef: string | null;
  trustLevel: CompanySkillTrustLevel;
  compatibility: CompanySkillCompatibility;
  fileInventory: CompanySkillFileInventoryEntry[];
  metadata: Record<string, unknown> | null;
};

type PackageSkillConflictStrategy = "replace" | "rename" | "skip";

export type ImportPackageSkillResult = {
  skill: CompanySkill;
  action: "created" | "updated" | "skipped";
  originalKey: string;
  originalSlug: string;
  requestedRefs: string[];
  reason: string | null;
};

type ParsedSkillImportSource = {
  resolvedSource: string;
  requestedSkillSlug: string | null;
  originalSkillsShUrl: string | null;
  warnings: string[];
};

type SkillSourceMeta = {
  skillKey?: string;
  sourceKind?: string;
  hostname?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  trackingRef?: string;
  repoSkillDir?: string;
  projectId?: string;
  projectName?: string;
  workspaceId?: string;
  workspaceName?: string;
  workspaceCwd?: string;
};

export type LocalSkillInventoryMode = "full" | "project_root";

export type ProjectSkillScanTarget = {
  projectId: string;
  projectName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceCwd: string;
};

type RuntimeSkillEntryOptions = {
  materializeMissing?: boolean;
};

const skillInventoryRefreshPromises = new Map<string, Promise<void>>();

const PROJECT_SCAN_DIRECTORY_ROOTS = [
  "skills",
  "skills/.curated",
  "skills/.experimental",
  "skills/.system",
  ".agents/skills",
  ".agent/skills",
  ".augment/skills",
  ".claude/skills",
  ".codebuddy/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cortex/skills",
  ".crush/skills",
  ".factory/skills",
  ".goose/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".kode/skills",
  ".mcpjam/skills",
  ".vibe/skills",
  ".mux/skills",
  ".openhands/skills",
  ".pi/skills",
  ".qoder/skills",
  ".qwen/skills",
  ".roo/skills",
  ".trae/skills",
  ".windsurf/skills",
  ".zencoder/skills",
  ".neovate/skills",
  ".pochi/skills",
  ".adal/skills",
] as const;

const PROJECT_ROOT_SKILL_SUBDIRECTORIES = [
  "references",
  "scripts",
  "assets",
] as const;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePortablePath(input: string) {
  const parts: string[] = [];
  for (const segment of input.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function normalizePackageFileMap(files: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const nextPath = normalizePortablePath(rawPath);
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

function normalizeSkillSlug(value: string | null | undefined) {
  return value ? normalizeAgentUrlKey(value) ?? null : null;
}

function normalizeSkillKey(value: string | null | undefined) {
  if (!value) return null;
  const segments = value
    .split("/")
    .map((segment) => normalizeSkillSlug(segment))
    .filter((segment): segment is string => Boolean(segment));
  return segments.length > 0 ? segments.join("/") : null;
}

export function normalizeGitHubSkillDirectory(
  value: string | null | undefined,
  fallback: string,
) {
  const normalized = normalizePortablePath(value ?? "");
  if (!normalized) return normalizePortablePath(fallback);
  if (path.posix.basename(normalized).toLowerCase() === "skill.md") {
    return normalizePortablePath(path.posix.dirname(normalized));
  }
  return normalized;
}

function hashSkillValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function uniqueSkillSlug(baseSlug: string, usedSlugs: Set<string>) {
  if (!usedSlugs.has(baseSlug)) return baseSlug;
  let attempt = 2;
  let candidate = `${baseSlug}-${attempt}`;
  while (usedSlugs.has(candidate)) {
    attempt += 1;
    candidate = `${baseSlug}-${attempt}`;
  }
  return candidate;
}

function uniqueImportedSkillKey(companyId: string, baseSlug: string, usedKeys: Set<string>) {
  const initial = `company/${companyId}/${baseSlug}`;
  if (!usedKeys.has(initial)) return initial;
  let attempt = 2;
  let candidate = `company/${companyId}/${baseSlug}-${attempt}`;
  while (usedKeys.has(candidate)) {
    attempt += 1;
    candidate = `company/${companyId}/${baseSlug}-${attempt}`;
  }
  return candidate;
}

function buildSkillRuntimeName(key: string, slug: string) {
  if (key.startsWith("paperclipai/paperclip/")) return slug;
  return `${slug}--${hashSkillValue(key)}`;
}

function readCanonicalSkillKey(frontmatter: Record<string, unknown>, metadata: Record<string, unknown> | null) {
  const direct = normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.paperclipSkillKey),
  );
  if (direct) return direct;
  const paperclip = isPlainRecord(metadata?.paperclip) ? metadata?.paperclip as Record<string, unknown> : null;
  return normalizeSkillKey(
    asString(paperclip?.skillKey)
    ?? asString(paperclip?.key),
  );
}

function deriveCanonicalSkillKey(
  companyId: string,
  input: Pick<ImportedSkill, "slug" | "sourceType" | "sourceLocator" | "metadata">,
) {
  const slug = normalizeSkillSlug(input.slug) ?? "skill";
  const metadata = isPlainRecord(input.metadata) ? input.metadata : null;
  const explicitKey = readCanonicalSkillKey({}, metadata);
  if (explicitKey) return explicitKey;

  const sourceKind = asString(metadata?.sourceKind);
  if (sourceKind === "paperclip_bundled") {
    return `paperclipai/paperclip/${slug}`;
  }

  const owner = normalizeSkillSlug(asString(metadata?.owner));
  const repo = normalizeSkillSlug(asString(metadata?.repo));
  if ((input.sourceType === "github" || input.sourceType === "skills_sh" || sourceKind === "github" || sourceKind === "skills_sh") && owner && repo) {
    return `${owner}/${repo}/${slug}`;
  }

  if (input.sourceType === "url" || sourceKind === "url") {
    const locator = asString(input.sourceLocator);
    if (locator) {
      try {
        const url = new URL(locator);
        const host = normalizeSkillSlug(url.host) ?? "url";
        return `url/${host}/${hashSkillValue(locator)}/${slug}`;
      } catch {
        return `url/unknown/${hashSkillValue(locator)}/${slug}`;
      }
    }
  }

  if (input.sourceType === "local_path") {
    if (sourceKind === "managed_local") {
      return `company/${companyId}/${slug}`;
    }
    const locator = asString(input.sourceLocator);
    if (locator) {
      return `local/${hashSkillValue(path.resolve(locator))}/${slug}`;
    }
  }

  return `company/${companyId}/${slug}`;
}

function classifyInventoryKind(relativePath: string): CompanySkillFileInventoryEntry["kind"] {
  const normalized = normalizePortablePath(relativePath).toLowerCase();
  if (normalized.endsWith("/skill.md") || normalized === "skill.md") return "skill";
  if (normalized.startsWith("references/")) return "reference";
  if (normalized.startsWith("scripts/")) return "script";
  if (normalized.startsWith("assets/")) return "asset";
  if (normalized.endsWith(".md")) return "markdown";
  const fileName = path.posix.basename(normalized);
  if (
    fileName.endsWith(".sh")
    || fileName.endsWith(".js")
    || fileName.endsWith(".mjs")
    || fileName.endsWith(".cjs")
    || fileName.endsWith(".ts")
    || fileName.endsWith(".py")
    || fileName.endsWith(".rb")
    || fileName.endsWith(".bash")
  ) {
    return "script";
  }
  if (
    fileName.endsWith(".png")
    || fileName.endsWith(".jpg")
    || fileName.endsWith(".jpeg")
    || fileName.endsWith(".gif")
    || fileName.endsWith(".svg")
    || fileName.endsWith(".webp")
    || fileName.endsWith(".pdf")
  ) {
    return "asset";
  }
  return "other";
}

function deriveTrustLevel(fileInventory: CompanySkillFileInventoryEntry[]): CompanySkillTrustLevel {
  if (fileInventory.some((entry) => entry.kind === "script")) return "scripts_executables";
  if (fileInventory.some((entry) => entry.kind === "asset" || entry.kind === "other")) return "assets";
  return "markdown_only";
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

function parseYamlScalar(rawValue: string): unknown {
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

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) index += 1;
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

function parseFrontmatterMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
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
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await ghFetch(url, {
    headers: {
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json() as Promise<T>;
}


async function resolveGitHubDefaultBranch(owner: string, repo: string, apiBase: string) {
  const response = await fetchJson<{ default_branch?: string }>(
    `${apiBase}/repos/${owner}/${repo}`,
  );
  return asString(response.default_branch) ?? "main";
}

async function resolveGitHubCommitSha(owner: string, repo: string, ref: string, apiBase: string) {
  const response = await fetchJson<{ sha?: string }>(
    `${apiBase}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  const sha = asString(response.sha);
  if (!sha) {
    throw unprocessable(`Failed to resolve GitHub ref ${ref}`);
  }
  return sha;
}

function parseGitHubSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw unprocessable("GitHub source URL must use HTTPS");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  let ref = "main";
  let basePath = "";
  let filePath: string | null = null;
  let explicitRef = false;
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
    explicitRef = true;
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    filePath = parts.slice(4).join("/");
    basePath = filePath ? path.posix.dirname(filePath) : "";
    explicitRef = true;
  }
  return { hostname: url.hostname, owner, repo, ref, basePath, filePath, explicitRef };
}

async function resolveGitHubPinnedRef(parsed: ReturnType<typeof parseGitHubSourceUrl>) {
  const apiBase = gitHubApiBase(parsed.hostname);
  if (/^[0-9a-f]{40}$/i.test(parsed.ref.trim())) {
    return {
      pinnedRef: parsed.ref,
      trackingRef: parsed.explicitRef ? parsed.ref : null,
    };
  }

  const trackingRef = parsed.explicitRef
    ? parsed.ref
    : await resolveGitHubDefaultBranch(parsed.owner, parsed.repo, apiBase);
  const pinnedRef = await resolveGitHubCommitSha(parsed.owner, parsed.repo, trackingRef, apiBase);
  return { pinnedRef, trackingRef };
}


function extractCommandTokens(raw: string) {
  const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function parseSkillImportSourceInput(rawInput: string): ParsedSkillImportSource {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw unprocessable("Skill source is required.");
  }

  const warnings: string[] = [];
  let source = trimmed;
  let requestedSkillSlug: string | null = null;

  if (/^npx\s+skills\s+add\s+/i.test(trimmed)) {
    const tokens = extractCommandTokens(trimmed);
    const addIndex = tokens.findIndex(
      (token, index) =>
        token === "add"
        && index > 0
        && tokens[index - 1]?.toLowerCase() === "skills",
    );
    if (addIndex >= 0) {
      source = tokens[addIndex + 1] ?? "";
      for (let index = addIndex + 2; index < tokens.length; index += 1) {
        const token = tokens[index]!;
        if (token === "--skill") {
          requestedSkillSlug = normalizeSkillSlug(tokens[index + 1] ?? null);
          index += 1;
          continue;
        }
        if (token.startsWith("--skill=")) {
          requestedSkillSlug = normalizeSkillSlug(token.slice("--skill=".length));
        }
      }
    }
  }

  const normalizedSource = source.trim();
  if (!normalizedSource) {
    throw unprocessable("Skill source is required.");
  }

  // Key-style imports (org/repo/skill) originate from the skills.sh registry
  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    const [owner, repo, skillSlugRaw] = normalizedSource.split("/");
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: normalizeSkillSlug(skillSlugRaw),
      originalSkillsShUrl: `https://skills.sh/${owner}/${repo}/${skillSlugRaw}`,
      warnings,
    };
  }

  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    return {
      resolvedSource: `https://github.com/${normalizedSource}`,
      requestedSkillSlug,
      originalSkillsShUrl: null,
      warnings,
    };
  }

  // Detect skills.sh URLs and resolve to GitHub: https://skills.sh/org/repo/skill → org/repo/skill key
  const skillsShMatch = normalizedSource.match(/^https?:\/\/(?:www\.)?skills\.sh\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?(?:[?#].*)?$/i);
  if (skillsShMatch) {
    const [, owner, repo, skillSlugRaw] = skillsShMatch;
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: skillSlugRaw ? normalizeSkillSlug(skillSlugRaw) : requestedSkillSlug,
      originalSkillsShUrl: normalizedSource,
      warnings,
    };
  }

  return {
    resolvedSource: normalizedSource,
    requestedSkillSlug,
    originalSkillsShUrl: null,
    warnings,
  };
}

function resolveBundledSkillsRoot() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "../../skills"),
    path.resolve(process.cwd(), "skills"),
    path.resolve(moduleDir, "../../../skills"),
  ];
}

function matchesRequestedSkill(relativeSkillPath: string, requestedSkillSlug: string | null) {
  if (!requestedSkillSlug) return true;
  const skillDir = path.posix.dirname(relativeSkillPath);
  return normalizeSkillSlug(path.posix.basename(skillDir)) === requestedSkillSlug;
}

function deriveImportedSkillSlug(frontmatter: Record<string, unknown>, fallback: string) {
  return normalizeSkillSlug(asString(frontmatter.slug))
    ?? normalizeSkillSlug(asString(frontmatter.name))
    ?? normalizeAgentUrlKey(fallback)
    ?? "skill";
}

function deriveImportedSkillSource(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
): Pick<ImportedSkill, "sourceType" | "sourceLocator" | "sourceRef" | "metadata"> {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const canonicalKey = readCanonicalSkillKey(frontmatter, metadata);
  const rawSources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
  const sourceEntry = rawSources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
  const kind = asString(sourceEntry?.kind);

  if (kind === "github-dir" || kind === "github-file") {
    const repo = asString(sourceEntry?.repo);
    const repoPath = asString(sourceEntry?.path);
    const commit = asString(sourceEntry?.commit);
    const trackingRef = asString(sourceEntry?.trackingRef);
    const sourceHostname = asString(sourceEntry?.hostname) || "github.com";
    const url = asString(sourceEntry?.url)
      ?? (repo
        ? `https://${sourceHostname}/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}`
        : null);
    const [owner, repoName] = (repo ?? "").split("/");
    if (repo && owner && repoName) {
      return {
        sourceType: "github",
        sourceLocator: url,
        sourceRef: commit,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind: "github",
          ...(sourceHostname !== "github.com" ? { hostname: sourceHostname } : {}),
          owner,
          repo: repoName,
          ref: commit,
          trackingRef,
          repoSkillDir: repoPath ?? `skills/${fallbackSlug}`,
        },
      };
    }
  }

  if (kind === "url") {
    const url = asString(sourceEntry?.url) ?? asString(sourceEntry?.rawUrl);
    if (url) {
      return {
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind: "url",
        },
      };
    }
  }

  return {
    sourceType: "catalog",
    sourceLocator: null,
    sourceRef: null,
    metadata: {
      ...(canonicalKey ? { skillKey: canonicalKey } : {}),
      sourceKind: "catalog",
    },
  };
}

function readInlineSkillImports(companyId: string, files: Record<string, string>): ImportedSkill[] {
  const normalizedFiles = normalizePackageFileMap(files);
  const skillPaths = Object.keys(normalizedFiles).filter(
    (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
  );
  const imports: ImportedSkill[] = [];

  for (const skillPath of skillPaths) {
    const dir = path.posix.dirname(skillPath);
    const skillDir = dir === "." ? "" : dir;
    const slugFallback = path.posix.basename(skillDir || path.posix.dirname(skillPath));
    const markdown = normalizedFiles[skillPath]!;
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, slugFallback);
    const source = deriveImportedSkillSource(parsed.frontmatter, slug);
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || (skillDir ? entry.startsWith(`${skillDir}/`) : false))
      .map((entry) => {
        const relative = entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1);
        return {
          path: normalizePortablePath(relative),
          kind: classifyInventoryKind(relative),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));

    imports.push({
      key: "",
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: asString(parsed.frontmatter.description),
      markdown,
      packageDir: skillDir,
      sourceType: source.sourceType,
      sourceLocator: source.sourceLocator,
      sourceRef: source.sourceRef,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: "compatible",
      fileInventory: inventory,
      metadata: source.metadata,
    });
    imports[imports.length - 1]!.key = deriveCanonicalSkillKey(companyId, imports[imports.length - 1]!);
  }

  return imports;
}

async function walkLocalFiles(root: string, current: string, out: string[]) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkLocalFiles(root, absolutePath, out);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(normalizePortablePath(path.relative(root, absolutePath)));
  }
}

async function statPath(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function collectLocalSkillInventory(
  skillDir: string,
  mode: LocalSkillInventoryMode = "full",
): Promise<CompanySkillFileInventoryEntry[]> {
  const skillFilePath = path.join(skillDir, "SKILL.md");
  const skillFileStat = await statPath(skillFilePath);
  if (!skillFileStat?.isFile()) {
    throw unprocessable(`No SKILL.md file was found in ${skillDir}.`);
  }

  const allFiles = new Set<string>(["SKILL.md"]);
  if (mode === "full") {
    const discoveredFiles: string[] = [];
    await walkLocalFiles(skillDir, skillDir, discoveredFiles);
    for (const relativePath of discoveredFiles) {
      allFiles.add(relativePath);
    }
  } else {
    for (const relativeDir of PROJECT_ROOT_SKILL_SUBDIRECTORIES) {
      const absoluteDir = path.join(skillDir, relativeDir);
      const dirStat = await statPath(absoluteDir);
      if (!dirStat?.isDirectory()) continue;
      const discoveredFiles: string[] = [];
      await walkLocalFiles(skillDir, absoluteDir, discoveredFiles);
      for (const relativePath of discoveredFiles) {
        allFiles.add(relativePath);
      }
    }
  }

  return Array.from(allFiles)
    .map((relativePath) => ({
      path: normalizePortablePath(relativePath),
      kind: classifyInventoryKind(relativePath),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export async function readLocalSkillImportFromDirectory(
  companyId: string,
  skillDir: string,
  options?: {
    inventoryMode?: LocalSkillInventoryMode;
    metadata?: Record<string, unknown> | null;
  },
): Promise<ImportedSkill> {
  const resolvedSkillDir = path.resolve(skillDir);
  const skillFilePath = path.join(resolvedSkillDir, "SKILL.md");
  const markdown = await fs.readFile(skillFilePath, "utf8");
  const parsed = parseFrontmatterMarkdown(markdown);
  const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(resolvedSkillDir));
  const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
  const skillKey = readCanonicalSkillKey(parsed.frontmatter, parsedMetadata);
  const metadata = {
    ...(skillKey ? { skillKey } : {}),
    ...(parsedMetadata ?? {}),
    sourceKind: "local_path",
    ...(options?.metadata ?? {}),
  };
  const inventory = await collectLocalSkillInventory(resolvedSkillDir, options?.inventoryMode ?? "full");

  return {
    key: deriveCanonicalSkillKey(companyId, {
      slug,
      sourceType: "local_path",
      sourceLocator: resolvedSkillDir,
      metadata,
    }),
    slug,
    name: asString(parsed.frontmatter.name) ?? slug,
    description: asString(parsed.frontmatter.description),
    markdown,
    packageDir: resolvedSkillDir,
    sourceType: "local_path",
    sourceLocator: resolvedSkillDir,
    sourceRef: null,
    trustLevel: deriveTrustLevel(inventory),
    compatibility: "compatible",
    fileInventory: inventory,
    metadata,
  };
}

export async function discoverProjectWorkspaceSkillDirectories(target: ProjectSkillScanTarget): Promise<Array<{
  skillDir: string;
  inventoryMode: LocalSkillInventoryMode;
}>> {
  const discovered = new Map<string, LocalSkillInventoryMode>();
  const rootSkillPath = path.join(target.workspaceCwd, "SKILL.md");
  if ((await statPath(rootSkillPath))?.isFile()) {
    discovered.set(path.resolve(target.workspaceCwd), "project_root");
  }

  for (const relativeRoot of PROJECT_SCAN_DIRECTORY_ROOTS) {
    const absoluteRoot = path.join(target.workspaceCwd, relativeRoot);
    const rootStat = await statPath(absoluteRoot);
    if (!rootStat?.isDirectory()) continue;

    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absoluteSkillDir = path.resolve(absoluteRoot, entry.name);
      if (!(await statPath(path.join(absoluteSkillDir, "SKILL.md")))?.isFile()) continue;
      discovered.set(absoluteSkillDir, "full");
    }
  }

  return Array.from(discovered.entries())
    .map(([skillDir, inventoryMode]) => ({ skillDir, inventoryMode }))
    .sort((left, right) => left.skillDir.localeCompare(right.skillDir));
}

async function readLocalSkillImports(companyId: string, sourcePath: string): Promise<ImportedSkill[]> {
  const resolvedPath = path.resolve(sourcePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    throw unprocessable(`Skill source path does not exist: ${sourcePath}`);
  }

  if (stat.isFile()) {
    const markdown = await fs.readFile(resolvedPath, "utf8");
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(path.dirname(resolvedPath)));
    const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
    const skillKey = readCanonicalSkillKey(parsed.frontmatter, parsedMetadata);
    const metadata = {
      ...(skillKey ? { skillKey } : {}),
      ...(parsedMetadata ?? {}),
      sourceKind: "local_path",
    };
    const inventory: CompanySkillFileInventoryEntry[] = [
      { path: "SKILL.md", kind: "skill" },
    ];
    return [{
      key: deriveCanonicalSkillKey(companyId, {
        slug,
        sourceType: "local_path",
        sourceLocator: path.dirname(resolvedPath),
        metadata,
      }),
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: asString(parsed.frontmatter.description),
      markdown,
      packageDir: path.dirname(resolvedPath),
      sourceType: "local_path",
      sourceLocator: path.dirname(resolvedPath),
      sourceRef: null,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: "compatible",
      fileInventory: inventory,
      metadata,
    }];
  }

  const root = resolvedPath;
  const allFiles: string[] = [];
  await walkLocalFiles(root, root, allFiles);
  const skillPaths = allFiles.filter((entry) => path.posix.basename(entry).toLowerCase() === "skill.md");
  if (skillPaths.length === 0) {
    throw unprocessable("No SKILL.md files were found in the provided path.");
  }

  const imports: ImportedSkill[] = [];
  for (const skillPath of skillPaths) {
    const skillDir = path.posix.dirname(skillPath);
    const inventory = allFiles
      .filter((entry) => entry === skillPath || entry.startsWith(`${skillDir}/`))
      .map((entry) => {
        const relative = entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1);
        return {
          path: normalizePortablePath(relative),
          kind: classifyInventoryKind(relative),
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path));
    const imported = await readLocalSkillImportFromDirectory(companyId, path.join(root, skillDir));
    imported.fileInventory = inventory;
    imported.trustLevel = deriveTrustLevel(inventory);
    imports.push(imported);
  }

  return imports;
}

async function readUrlSkillImports(
  companyId: string,
  sourceUrl: string,
  requestedSkillSlug: string | null = null,
): Promise<{ skills: ImportedSkill[]; warnings: string[] }> {
  const url = sourceUrl.trim();
  const warnings: string[] = [];
  const looksLikeRepoUrl = (() => { try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    if (h.endsWith(".githubusercontent.com") || h === "gist.github.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 2 && !parsed.pathname.endsWith(".md");
  } catch { return false; } })();
  if (looksLikeRepoUrl) {
    const parsed = parseGitHubSourceUrl(url);
    const apiBase = gitHubApiBase(parsed.hostname);
    const { pinnedRef, trackingRef } = await resolveGitHubPinnedRef(parsed);
    let ref = pinnedRef;
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => {
      throw unprocessable(`Failed to read GitHub tree for ${url}`);
    });
    const allPaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string");
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const scopedPaths = basePrefix
      ? allPaths.filter((entry) => entry.startsWith(basePrefix))
      : allPaths;
    const relativePaths = scopedPaths.map((entry) => basePrefix ? entry.slice(basePrefix.length) : entry);
    const filteredPaths = parsed.filePath
      ? relativePaths.filter((entry) => entry === path.posix.relative(parsed.basePath || ".", parsed.filePath!))
      : relativePaths;
    const skillPaths = filteredPaths.filter(
      (entry) => path.posix.basename(entry).toLowerCase() === "skill.md",
    );
    if (skillPaths.length === 0) {
      throw unprocessable(
        "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    const skills: ImportedSkill[] = [];
    for (const relativeSkillPath of skillPaths) {
      const repoSkillPath = basePrefix ? `${basePrefix}${relativeSkillPath}` : relativeSkillPath;
      const markdown = await fetchText(resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoSkillPath));
      const parsedMarkdown = parseFrontmatterMarkdown(markdown);
      const skillDir = path.posix.dirname(relativeSkillPath);
      const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, path.posix.basename(skillDir));
      const skillKey = readCanonicalSkillKey(
        parsedMarkdown.frontmatter,
        isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
      );
      if (requestedSkillSlug && !matchesRequestedSkill(relativeSkillPath, requestedSkillSlug) && slug !== requestedSkillSlug) {
        continue;
      }
      const metadata = {
        ...(skillKey ? { skillKey } : {}),
        sourceKind: "github",
        ...(parsed.hostname !== "github.com" ? { hostname: parsed.hostname } : {}),
        owner: parsed.owner,
        repo: parsed.repo,
        ref,
        trackingRef,
        repoSkillDir: normalizeGitHubSkillDirectory(
          basePrefix ? `${basePrefix}${skillDir}` : skillDir,
          slug,
        ),
      };
      const inventory = filteredPaths
        .filter((entry) => entry === relativeSkillPath || entry.startsWith(`${skillDir}/`))
        .map((entry) => ({
          path: entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
          kind: classifyInventoryKind(entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1)),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      skills.push({
        key: deriveCanonicalSkillKey(companyId, {
          slug,
          sourceType: "github",
          sourceLocator: sourceUrl,
          metadata,
        }),
        slug,
        name: asString(parsedMarkdown.frontmatter.name) ?? slug,
        description: asString(parsedMarkdown.frontmatter.description),
        markdown,
        sourceType: "github",
        sourceLocator: sourceUrl,
        sourceRef: ref,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      });
    }
    if (skills.length === 0) {
      throw unprocessable(
        requestedSkillSlug
          ? `Skill ${requestedSkillSlug} was not found in the provided GitHub source.`
          : "No SKILL.md files were found in the provided GitHub source.",
      );
    }
    return { skills, warnings };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    const markdown = await fetchText(url);
    const parsedMarkdown = parseFrontmatterMarkdown(markdown);
    const urlObj = new URL(url);
    const fileName = path.posix.basename(urlObj.pathname);
    const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, fileName.replace(/\.md$/i, ""));
    const skillKey = readCanonicalSkillKey(
      parsedMarkdown.frontmatter,
      isPlainRecord(parsedMarkdown.frontmatter.metadata) ? parsedMarkdown.frontmatter.metadata : null,
    );
    const metadata = {
      ...(skillKey ? { skillKey } : {}),
      sourceKind: "url",
    };
    const inventory: CompanySkillFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill" }];
    return {
      skills: [{
        key: deriveCanonicalSkillKey(companyId, {
          slug,
          sourceType: "url",
          sourceLocator: url,
          metadata,
        }),
        slug,
        name: asString(parsedMarkdown.frontmatter.name) ?? slug,
        description: asString(parsedMarkdown.frontmatter.description),
        markdown,
        sourceType: "url",
        sourceLocator: url,
        sourceRef: null,
        trustLevel: deriveTrustLevel(inventory),
        compatibility: "compatible",
        fileInventory: inventory,
        metadata,
      }],
      warnings,
    };
  }

  throw unprocessable("Unsupported skill source. Use a local path or URL.");
}

function toCompanySkill(row: CompanySkillRow): CompanySkill {
  return {
    ...row,
    description: row.description ?? null,
    sourceType: row.sourceType as CompanySkillSourceType,
    sourceLocator: row.sourceLocator ?? null,
    sourceRef: row.sourceRef ?? null,
    trustLevel: row.trustLevel as CompanySkillTrustLevel,
    compatibility: row.compatibility as CompanySkillCompatibility,
    fileInventory: Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
        if (!isPlainRecord(entry)) return [];
        return [{
          path: String(entry.path ?? ""),
          kind: (String(entry.kind ?? "other") as CompanySkillFileInventoryEntry["kind"]),
        }];
      })
      : [],
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
  };
}

function serializeFileInventory(
  fileInventory: CompanySkillFileInventoryEntry[],
): Array<Record<string, unknown>> {
  return fileInventory.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
  }));
}

function getSkillMeta(skill: CompanySkill): SkillSourceMeta {
  return isPlainRecord(skill.metadata) ? skill.metadata as SkillSourceMeta : {};
}

function resolveSkillReference(
  skills: CompanySkill[],
  reference: string,
): { skill: CompanySkill | null; ambiguous: boolean } {
  const trimmed = reference.trim();
  if (!trimmed) {
    return { skill: null, ambiguous: false };
  }

  const byId = skills.find((skill) => skill.id === trimmed);
  if (byId) {
    return { skill: byId, ambiguous: false };
  }

  const normalizedKey = normalizeSkillKey(trimmed);
  if (normalizedKey) {
    const byKey = skills.find((skill) => skill.key === normalizedKey);
    if (byKey) {
      return { skill: byKey, ambiguous: false };
    }
  }

  const normalizedSlug = normalizeSkillSlug(trimmed);
  if (!normalizedSlug) {
    return { skill: null, ambiguous: false };
  }

  const bySlug = skills.filter((skill) => skill.slug === normalizedSlug);
  if (bySlug.length === 1) {
    return { skill: bySlug[0] ?? null, ambiguous: false };
  }
  if (bySlug.length > 1) {
    return { skill: null, ambiguous: true };
  }

  return { skill: null, ambiguous: false };
}

function resolveRequestedSkillKeysOrThrow(
  skills: CompanySkill[],
  requestedReferences: string[],
) {
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const resolved = new Set<string>();

  for (const reference of requestedReferences) {
    const trimmed = reference.trim();
    if (!trimmed) continue;

    const match = resolveSkillReference(skills, trimmed);
    if (match.skill) {
      resolved.add(match.skill.key);
      continue;
    }

    if (match.ambiguous) {
      ambiguous.add(trimmed);
      continue;
    }

    missing.add(trimmed);
  }

  if (ambiguous.size > 0 || missing.size > 0) {
    const problems: string[] = [];
    if (ambiguous.size > 0) {
      problems.push(`ambiguous references: ${Array.from(ambiguous).sort().join(", ")}`);
    }
    if (missing.size > 0) {
      problems.push(`unknown references: ${Array.from(missing).sort().join(", ")}`);
    }
    throw unprocessable(`Invalid company skill selection (${problems.join("; ")}).`);
  }

  return Array.from(resolved);
}

function resolveDesiredSkillKeys(
  skills: CompanySkill[],
  config: Record<string, unknown>,
) {
  const preference = readPaperclipSkillSyncPreference(config);
  return Array.from(new Set(
    preference.desiredSkills
      .map((reference) => resolveSkillReference(skills, reference).skill?.key ?? normalizeSkillKey(reference))
      .filter((value): value is string => Boolean(value)),
  ));
}

function normalizeSkillDirectory(skill: CompanySkill) {
  if ((skill.sourceType !== "local_path" && skill.sourceType !== "catalog") || !skill.sourceLocator) return null;
  const resolved = path.resolve(skill.sourceLocator);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

function normalizeSourceLocatorDirectory(sourceLocator: string | null) {
  if (!sourceLocator) return null;
  const resolved = path.resolve(sourceLocator);
  return path.basename(resolved).toLowerCase() === "skill.md" ? path.dirname(resolved) : resolved;
}

export async function findMissingLocalSkillIds(
  skills: Array<Pick<CompanySkill, "id" | "sourceType" | "sourceLocator">>,
) {
  const missingIds: string[] = [];

  for (const skill of skills) {
    if (skill.sourceType !== "local_path") continue;
    const skillDir = normalizeSourceLocatorDirectory(skill.sourceLocator);
    if (!skillDir) {
      missingIds.push(skill.id);
      continue;
    }

    const skillDirStat = await statPath(skillDir);
    const skillFileStat = await statPath(path.join(skillDir, "SKILL.md"));
    if (!skillDirStat?.isDirectory() || !skillFileStat?.isFile()) {
      missingIds.push(skill.id);
    }
  }

  return missingIds;
}

function resolveManagedSkillsRoot(companyId: string) {
  return path.resolve(resolvePaperclipInstanceRoot(), "skills", companyId);
}

function resolveLocalSkillFilePath(skill: CompanySkill, relativePath: string) {
  const normalized = normalizePortablePath(relativePath);
  const skillDir = normalizeSkillDirectory(skill);
  if (skillDir) {
    return path.resolve(skillDir, normalized);
  }

  if (!skill.sourceLocator) return null;
  const fallbackRoot = path.resolve(skill.sourceLocator);
  const directPath = path.resolve(fallbackRoot, normalized);
  return directPath;
}

function inferLanguageFromPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  if (fileName === "skill.md" || fileName.endsWith(".md")) return "markdown";
  if (fileName.endsWith(".ts")) return "typescript";
  if (fileName.endsWith(".tsx")) return "tsx";
  if (fileName.endsWith(".js")) return "javascript";
  if (fileName.endsWith(".jsx")) return "jsx";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "yaml";
  if (fileName.endsWith(".sh")) return "bash";
  if (fileName.endsWith(".py")) return "python";
  if (fileName.endsWith(".html")) return "html";
  if (fileName.endsWith(".css")) return "css";
  return null;
}

function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "skill.md" || fileName.endsWith(".md");
}

function deriveSkillSourceInfo(skill: CompanySkill): {
  editable: boolean;
  editableReason: string | null;
  sourceLabel: string | null;
  sourceBadge: CompanySkillSourceBadge;
  sourcePath: string | null;
} {
  const metadata = getSkillMeta(skill);
  const localSkillDir = normalizeSkillDirectory(skill);
  if (metadata.sourceKind === "paperclip_bundled") {
    return {
      editable: false,
      editableReason: "Bundled Paperclip skills are read-only.",
      sourceLabel: "Paperclip bundled",
      sourceBadge: "paperclip",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "skills_sh") {
    const owner = asString(metadata.owner) ?? null;
    const repo = asString(metadata.repo) ?? null;
    return {
      editable: false,
      editableReason: "Skills.sh-managed skills are read-only.",
      sourceLabel: skill.sourceLocator ?? (owner && repo ? `${owner}/${repo}` : null),
      sourceBadge: "skills_sh",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "github") {
    const owner = asString(metadata.owner) ?? null;
    const repo = asString(metadata.repo) ?? null;
    return {
      editable: false,
      editableReason: "Remote GitHub skills are read-only. Fork or import locally to edit them.",
      sourceLabel: owner && repo ? `${owner}/${repo}` : skill.sourceLocator,
      sourceBadge: "github",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "url") {
    return {
      editable: false,
      editableReason: "URL-based skills are read-only. Save them locally to edit them.",
      sourceLabel: skill.sourceLocator,
      sourceBadge: "url",
      sourcePath: null,
    };
  }

  if (skill.sourceType === "local_path") {
    const managedRoot = resolveManagedSkillsRoot(skill.companyId);
    const projectName = asString(metadata.projectName);
    const workspaceName = asString(metadata.workspaceName);
    const isProjectScan = metadata.sourceKind === "project_scan";
    if (localSkillDir && localSkillDir.startsWith(managedRoot)) {
      return {
        editable: true,
        editableReason: null,
        sourceLabel: "Paperclip workspace",
        sourceBadge: "paperclip",
        sourcePath: managedRoot,
      };
    }

    return {
      editable: true,
      editableReason: null,
      sourceLabel: isProjectScan
        ? [projectName, workspaceName].filter((value): value is string => Boolean(value)).join(" / ")
          || skill.sourceLocator
        : skill.sourceLocator,
      sourceBadge: "local",
      sourcePath: null,
    };
  }

  return {
    editable: false,
    editableReason: "This skill source is read-only.",
    sourceLabel: skill.sourceLocator,
    sourceBadge: "catalog",
    sourcePath: null,
  };
}

function enrichSkill(skill: CompanySkill, attachedAgentCount: number, usedByAgents: CompanySkillUsageAgent[] = []) {
  const source = deriveSkillSourceInfo(skill);
  return {
    ...skill,
    attachedAgentCount,
    usedByAgents,
    ...source,
  };
}

function toCompanySkillListItem(skill: CompanySkill, attachedAgentCount: number): CompanySkillListItem {
  const source = deriveSkillSourceInfo(skill);
  return {
    id: skill.id,
    companyId: skill.companyId,
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    sourceType: skill.sourceType,
    sourceLocator: skill.sourceLocator,
    sourceRef: skill.sourceRef,
    trustLevel: skill.trustLevel,
    compatibility: skill.compatibility,
    fileInventory: skill.fileInventory,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    attachedAgentCount,
    editable: source.editable,
    editableReason: source.editableReason,
    sourceLabel: source.sourceLabel,
    sourceBadge: source.sourceBadge,
    sourcePath: source.sourcePath,
  };
}

export function companySkillService(db: Db) {
  const agents = agentService(db);
  const projects = projectService(db);
  const secretsSvc = secretService(db);

  async function ensureBundledSkills(companyId: string) {
    for (const skillsRoot of resolveBundledSkillsRoot()) {
      const stats = await fs.stat(skillsRoot).catch(() => null);
      if (!stats?.isDirectory()) continue;
      const bundledSkills = await readLocalSkillImports(companyId, skillsRoot)
        .then((skills) => skills.map((skill) => ({
          ...skill,
          key: deriveCanonicalSkillKey(companyId, {
            ...skill,
            metadata: {
              ...(skill.metadata ?? {}),
              sourceKind: "paperclip_bundled",
            },
          }),
          metadata: {
            ...(skill.metadata ?? {}),
            sourceKind: "paperclip_bundled",
          },
        })))
        .catch(() => [] as ImportedSkill[]);
      if (bundledSkills.length === 0) continue;
      return upsertImportedSkills(companyId, bundledSkills);
    }
    return [];
  }

  async function pruneMissingLocalPathSkills(companyId: string) {
    const rows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const skills = rows.map((row) => toCompanySkill(row));
    const missingIds = new Set(await findMissingLocalSkillIds(skills));
    if (missingIds.size === 0) return;

    for (const skill of skills) {
      if (!missingIds.has(skill.id)) continue;
      await db
        .delete(companySkills)
        .where(eq(companySkills.id, skill.id));
      await fs.rm(resolveRuntimeSkillMaterializedPath(companyId, skill), { recursive: true, force: true });
    }
  }

  async function ensureSkillInventoryCurrent(companyId: string) {
    const existingRefresh = skillInventoryRefreshPromises.get(companyId);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const refreshPromise = (async () => {
      await ensureBundledSkills(companyId);
      await pruneMissingLocalPathSkills(companyId);
    })();

    skillInventoryRefreshPromises.set(companyId, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      if (skillInventoryRefreshPromises.get(companyId) === refreshPromise) {
        skillInventoryRefreshPromises.delete(companyId);
      }
    }
  }

  async function list(companyId: string): Promise<CompanySkillListItem[]> {
    const rows = await listFull(companyId);
    const agentRows = await agents.list(companyId);
    return rows.map((skill) => {
      const attachedAgentCount = agentRows.filter((agent) => {
        const desiredSkills = resolveDesiredSkillKeys(rows, agent.adapterConfig as Record<string, unknown>);
        return desiredSkills.includes(skill.key);
      }).length;
      return toCompanySkillListItem(skill, attachedAgentCount);
    });
  }

  async function listFull(companyId: string): Promise<CompanySkill[]> {
    await ensureSkillInventoryCurrent(companyId);
    const rows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.key));
    return rows.map((row) => toCompanySkill(row));
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getByKey(companyId: string, key: string) {
    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function usage(companyId: string, key: string): Promise<CompanySkillUsageAgent[]> {
    const skills = await listFull(companyId);
    const agentRows = await agents.list(companyId);
    const desiredAgents = agentRows.filter((agent) => {
      const desiredSkills = resolveDesiredSkillKeys(skills, agent.adapterConfig as Record<string, unknown>);
      return desiredSkills.includes(key);
    });

    return Promise.all(
      desiredAgents.map(async (agent) => {
        const adapter = findActiveServerAdapter(agent.adapterType);
        let actualState: string | null = null;

        if (!adapter?.listSkills) {
          actualState = "unsupported";
        } else {
          try {
            const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
              agent.companyId,
              agent.adapterConfig as Record<string, unknown>,
            );
            const runtimeSkillEntries = await listRuntimeSkillEntries(agent.companyId);
            const snapshot = await adapter.listSkills({
              agentId: agent.id,
              companyId: agent.companyId,
              adapterType: agent.adapterType,
              config: {
                ...runtimeConfig,
                paperclipRuntimeSkills: runtimeSkillEntries,
              },
            });
            actualState = snapshot.entries.find((entry) => entry.key === key)?.state
              ?? (snapshot.supported ? "missing" : "unsupported");
          } catch {
            actualState = "unknown";
          }
        }

        return {
          id: agent.id,
          name: agent.name,
          urlKey: agent.urlKey,
          adapterType: agent.adapterType,
          desired: true,
          actualState,
        };
      }),
    );
  }

  async function detail(companyId: string, id: string): Promise<CompanySkillDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(id);
    if (!skill || skill.companyId !== companyId) return null;
    const usedByAgents = await usage(companyId, skill.key);
    return enrichSkill(skill, usedByAgents.length, usedByAgents);
  }

  async function updateStatus(companyId: string, skillId: string): Promise<CompanySkillUpdateStatus | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;

    if (skill.sourceType !== "github" && skill.sourceType !== "skills_sh") {
      return {
        supported: false,
        reason: "Only GitHub-managed skills support update checks.",
        trackingRef: null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const metadata = getSkillMeta(skill);
    const owner = asString(metadata.owner);
    const repo = asString(metadata.repo);
    const trackingRef = asString(metadata.trackingRef) ?? asString(metadata.ref);
    if (!owner || !repo || !trackingRef) {
      return {
        supported: false,
        reason: "This GitHub skill does not have enough metadata to track updates.",
        trackingRef: trackingRef ?? null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
      };
    }

    const hostname = asString(metadata.hostname) || "github.com";
    const apiBase = gitHubApiBase(hostname);
    const latestRef = await resolveGitHubCommitSha(owner, repo, trackingRef, apiBase);
    return {
      supported: true,
      reason: null,
      trackingRef,
      currentRef: skill.sourceRef ?? null,
      latestRef,
      hasUpdate: latestRef !== (skill.sourceRef ?? null),
    };
  }

  async function readFile(companyId: string, skillId: string, relativePath: string): Promise<CompanySkillFileDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;

    const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
    const fileEntry = skill.fileInventory.find((entry) => entry.path === normalizedPath);
    if (!fileEntry) {
      throw notFound("Skill file not found");
    }

    const source = deriveSkillSourceInfo(skill);
    let content = "";

    if (skill.sourceType === "local_path" || skill.sourceType === "catalog") {
      const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
      if (absolutePath) {
        content = await fs.readFile(absolutePath, "utf8");
      } else if (normalizedPath === "SKILL.md") {
        content = skill.markdown;
      } else {
        throw notFound("Skill file not found");
      }
    } else if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
      const metadata = getSkillMeta(skill);
      const owner = asString(metadata.owner);
      const repo = asString(metadata.repo);
      const hostname = asString(metadata.hostname) || "github.com";
      const ref = skill.sourceRef ?? asString(metadata.ref) ?? "main";
      const repoSkillDir = normalizeGitHubSkillDirectory(asString(metadata.repoSkillDir), skill.slug);
      if (!owner || !repo) {
        throw unprocessable("Skill source metadata is incomplete.");
      }
      const repoPath = normalizePortablePath(path.posix.join(repoSkillDir, normalizedPath));
      content = await fetchText(resolveRawGitHubUrl(hostname, owner, repo, ref, repoPath));
    } else if (skill.sourceType === "url") {
      if (normalizedPath !== "SKILL.md") {
        throw notFound("This skill source only exposes SKILL.md");
      }
      content = skill.markdown;
    } else {
      throw unprocessable("Unsupported skill source.");
    }

    return {
      skillId: skill.id,
      path: normalizedPath,
      kind: fileEntry.kind,
      content,
      language: inferLanguageFromPath(normalizedPath),
      markdown: isMarkdownPath(normalizedPath),
      editable: source.editable,
    };
  }

  async function createLocalSkill(companyId: string, input: CompanySkillCreateRequest): Promise<CompanySkill> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const managedRoot = resolveManagedSkillsRoot(companyId);
    const skillDir = path.resolve(managedRoot, slug);
    const skillFilePath = path.resolve(skillDir, "SKILL.md");

    await fs.mkdir(skillDir, { recursive: true });

    const markdown = (input.markdown?.trim().length
      ? input.markdown
      : [
        "---",
        `name: ${input.name}`,
        ...(input.description?.trim() ? [`description: ${input.description.trim()}`] : []),
        "---",
        "",
        `# ${input.name}`,
        "",
        input.description?.trim() ? input.description.trim() : "Describe what this skill does.",
        "",
      ].join("\n"));

    await fs.writeFile(skillFilePath, markdown, "utf8");

    const parsed = parseFrontmatterMarkdown(markdown);
    const imported = await upsertImportedSkills(companyId, [{
      key: `company/${companyId}/${slug}`,
      slug,
      name: asString(parsed.frontmatter.name) ?? input.name,
      description: asString(parsed.frontmatter.description) ?? input.description?.trim() ?? null,
      markdown,
      sourceType: "local_path",
      sourceLocator: skillDir,
      sourceRef: null,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "managed_local" },
    }]);

    return imported[0]!;
  }

  async function updateFile(companyId: string, skillId: string, relativePath: string, content: string): Promise<CompanySkillFileDetail> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) throw notFound("Skill not found");

    const source = deriveSkillSourceInfo(skill);
    if (!source.editable || skill.sourceType !== "local_path") {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }

    const normalizedPath = normalizePortablePath(relativePath);
    const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
    if (!absolutePath) throw notFound("Skill file not found");

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");

    if (normalizedPath === "SKILL.md") {
      const parsed = parseFrontmatterMarkdown(content);
      await db
        .update(companySkills)
        .set({
          name: asString(parsed.frontmatter.name) ?? skill.name,
          description: asString(parsed.frontmatter.description) ?? skill.description,
          markdown: content,
          updatedAt: new Date(),
        })
        .where(eq(companySkills.id, skill.id));
    } else {
      await db
        .update(companySkills)
        .set({ updatedAt: new Date() })
        .where(eq(companySkills.id, skill.id));
    }

    const detail = await readFile(companyId, skillId, normalizedPath);
    if (!detail) throw notFound("Skill file not found");
    return detail;
  }

  async function installUpdate(companyId: string, skillId: string): Promise<CompanySkill | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;

    const status = await updateStatus(companyId, skillId);
    if (!status?.supported) {
      throw unprocessable(status?.reason ?? "This skill does not support updates.");
    }
    if (!skill.sourceLocator) {
      throw unprocessable("Skill source locator is missing.");
    }

    const result = await readUrlSkillImports(companyId, skill.sourceLocator, skill.slug);
    const matching = result.skills.find((entry) => entry.key === skill.key) ?? result.skills[0] ?? null;
    if (!matching) {
      throw unprocessable(`Skill ${skill.key} could not be re-imported from its source.`);
    }

    const imported = await upsertImportedSkills(companyId, [matching]);
    return imported[0] ?? null;
  }

  async function scanProjectWorkspaces(
    companyId: string,
    input: CompanySkillProjectScanRequest = {},
  ): Promise<CompanySkillProjectScanResult> {
    await ensureSkillInventoryCurrent(companyId);
    const projectRows = input.projectIds?.length
      ? await projects.listByIds(companyId, input.projectIds)
      : await projects.list(companyId);
    const workspaceFilter = new Set(input.workspaceIds ?? []);
    const skipped: CompanySkillProjectScanSkipped[] = [];
    const conflicts: CompanySkillProjectScanConflict[] = [];
    const warnings: string[] = [];
    const imported: CompanySkill[] = [];
    const updated: CompanySkill[] = [];
    const availableSkills = await listFull(companyId);
    const acceptedSkills = [...availableSkills];
    const acceptedByKey = new Map(acceptedSkills.map((skill) => [skill.key, skill]));
    const scanTargets: ProjectSkillScanTarget[] = [];
    const scannedProjectIds = new Set<string>();
    let discovered = 0;

    const trackWarning = (message: string) => {
      warnings.push(message);
      return message;
    };
    const upsertAcceptedSkill = (skill: CompanySkill) => {
      const nextIndex = acceptedSkills.findIndex((entry) => entry.id === skill.id || entry.key === skill.key);
      if (nextIndex >= 0) acceptedSkills[nextIndex] = skill;
      else acceptedSkills.push(skill);
      acceptedByKey.set(skill.key, skill);
    };

    for (const project of projectRows) {
      for (const workspace of project.workspaces) {
        if (workspaceFilter.size > 0 && !workspaceFilter.has(workspace.id)) continue;
        const workspaceCwd = asString(workspace.cwd);
        if (!workspaceCwd) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            path: null,
            reason: trackWarning(`Skipped ${project.name} / ${workspace.name}: no local workspace path is configured.`),
          });
          continue;
        }

        const workspaceStat = await statPath(workspaceCwd);
        if (!workspaceStat?.isDirectory()) {
          skipped.push({
            projectId: project.id,
            projectName: project.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            path: workspaceCwd,
            reason: trackWarning(`Skipped ${project.name} / ${workspace.name}: local workspace path is not available at ${workspaceCwd}.`),
          });
          continue;
        }

        scanTargets.push({
          projectId: project.id,
          projectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceCwd,
        });
      }
    }

    for (const target of scanTargets) {
      scannedProjectIds.add(target.projectId);
      const directories = await discoverProjectWorkspaceSkillDirectories(target);

      for (const directory of directories) {
        discovered += 1;

        let nextSkill: ImportedSkill;
        try {
          nextSkill = await readLocalSkillImportFromDirectory(companyId, directory.skillDir, {
            inventoryMode: directory.inventoryMode,
            metadata: {
              sourceKind: "project_scan",
              projectId: target.projectId,
              projectName: target.projectName,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              workspaceCwd: target.workspaceCwd,
            },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            reason: trackWarning(`Skipped ${directory.skillDir}: ${message}`),
          });
          continue;
        }

        const normalizedSourceDir = normalizeSourceLocatorDirectory(nextSkill.sourceLocator);
        const existingByKey = acceptedByKey.get(nextSkill.key) ?? null;
        if (existingByKey) {
          const existingSourceDir = normalizeSkillDirectory(existingByKey);
          if (
            existingByKey.sourceType !== "local_path"
            || !existingSourceDir
            || !normalizedSourceDir
            || existingSourceDir !== normalizedSourceDir
          ) {
            conflicts.push({
              slug: nextSkill.slug,
              key: nextSkill.key,
              projectId: target.projectId,
              projectName: target.projectName,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              path: directory.skillDir,
              existingSkillId: existingByKey.id,
              existingSkillKey: existingByKey.key,
              existingSourceLocator: existingByKey.sourceLocator,
              reason: `Skill key ${nextSkill.key} already points at ${existingByKey.sourceLocator ?? "another source"}.`,
            });
            continue;
          }

          const persisted = (await upsertImportedSkills(companyId, [nextSkill]))[0];
          if (!persisted) continue;
          updated.push(persisted);
          upsertAcceptedSkill(persisted);
          continue;
        }

        const slugConflict = acceptedSkills.find((skill) => {
          if (skill.slug !== nextSkill.slug) return false;
          return normalizeSkillDirectory(skill) !== normalizedSourceDir;
        });
        if (slugConflict) {
          conflicts.push({
            slug: nextSkill.slug,
            key: nextSkill.key,
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            existingSkillId: slugConflict.id,
            existingSkillKey: slugConflict.key,
            existingSourceLocator: slugConflict.sourceLocator,
            reason: `Slug ${nextSkill.slug} is already in use by ${slugConflict.sourceLocator ?? slugConflict.key}.`,
          });
          continue;
        }

        const persisted = (await upsertImportedSkills(companyId, [nextSkill]))[0];
        if (!persisted) continue;
        imported.push(persisted);
        upsertAcceptedSkill(persisted);
      }
    }

    return {
      scannedProjects: scannedProjectIds.size,
      scannedWorkspaces: scanTargets.length,
      discovered,
      imported,
      updated,
      skipped,
      conflicts,
      warnings,
    };
  }

  async function materializeCatalogSkillFiles(
    companyId: string,
    skill: ImportedSkill,
    normalizedFiles: Record<string, string>,
  ) {
    const packageDir = skill.packageDir ? normalizePortablePath(skill.packageDir) : null;
    if (!packageDir) return null;
    const catalogRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__catalog__");
    const skillDir = path.resolve(catalogRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const sourcePath = entry.path === "SKILL.md"
        ? `${packageDir}/SKILL.md`
        : `${packageDir}/${entry.path}`;
      const content = normalizedFiles[sourcePath];
      if (typeof content !== "string") continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
    }

    return skillDir;
  }

  async function materializeRuntimeSkillFiles(companyId: string, skill: CompanySkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__runtime__");
    const skillDir = path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    for (const entry of skill.fileInventory) {
      const detail = await readFile(companyId, skill.id, entry.path).catch(() => null);
      if (!detail) continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, detail.content, "utf8");
    }

    return skillDir;
  }

  function resolveRuntimeSkillMaterializedPath(companyId: string, skill: CompanySkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__runtime__");
    return path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
  }

  async function listRuntimeSkillEntries(
    companyId: string,
    options: RuntimeSkillEntryOptions = {},
  ): Promise<PaperclipSkillEntry[]> {
    const skills = await listFull(companyId);

    const out: PaperclipSkillEntry[] = [];
    for (const skill of skills) {
      const sourceKind = asString(getSkillMeta(skill).sourceKind);
      let source = normalizeSkillDirectory(skill);
      if (!source) {
        source = options.materializeMissing === false
          ? resolveRuntimeSkillMaterializedPath(companyId, skill)
          : await materializeRuntimeSkillFiles(companyId, skill).catch(() => null);
      }
      if (!source) continue;

      const required = sourceKind === "paperclip_bundled";
      out.push({
        key: skill.key,
        runtimeName: buildSkillRuntimeName(skill.key, skill.slug),
        source,
        required,
        requiredReason: required
          ? "Bundled Paperclip skills are always available for local adapters."
          : null,
      });
    }

    out.sort((left, right) => left.key.localeCompare(right.key));
    return out;
  }

  async function importPackageFiles(
    companyId: string,
    files: Record<string, string>,
    options?: {
      onConflict?: PackageSkillConflictStrategy;
    },
  ): Promise<ImportPackageSkillResult[]> {
    await ensureSkillInventoryCurrent(companyId);
    const normalizedFiles = normalizePackageFileMap(files);
    const importedSkills = readInlineSkillImports(companyId, normalizedFiles);
    if (importedSkills.length === 0) return [];

    for (const skill of importedSkills) {
      if (skill.sourceType !== "catalog") continue;
      const materializedDir = await materializeCatalogSkillFiles(companyId, skill, normalizedFiles);
      if (materializedDir) {
        skill.sourceLocator = materializedDir;
      }
    }

    const conflictStrategy = options?.onConflict ?? "replace";
    const existingSkills = await listFull(companyId);
    const existingByKey = new Map(existingSkills.map((skill) => [skill.key, skill]));
    const existingBySlug = new Map(
      existingSkills.map((skill) => [normalizeSkillSlug(skill.slug) ?? skill.slug, skill]),
    );
    const usedSlugs = new Set(existingBySlug.keys());
    const usedKeys = new Set(existingByKey.keys());

    const toPersist: ImportedSkill[] = [];
    const prepared: Array<{
      skill: ImportedSkill;
      originalKey: string;
      originalSlug: string;
      existingBefore: CompanySkill | null;
      actionHint: "created" | "updated";
      reason: string | null;
    }> = [];
    const out: ImportPackageSkillResult[] = [];

    for (const importedSkill of importedSkills) {
      const originalKey = importedSkill.key;
      const originalSlug = importedSkill.slug;
      const normalizedSlug = normalizeSkillSlug(importedSkill.slug) ?? importedSkill.slug;
      const existingByIncomingKey = existingByKey.get(importedSkill.key) ?? null;
      const existingByIncomingSlug = existingBySlug.get(normalizedSlug) ?? null;
      const conflict = existingByIncomingKey ?? existingByIncomingSlug;

      if (!conflict || conflictStrategy === "replace") {
        toPersist.push(importedSkill);
        prepared.push({
          skill: importedSkill,
          originalKey,
          originalSlug,
          existingBefore: existingByIncomingKey,
          actionHint: existingByIncomingKey ? "updated" : "created",
          reason: existingByIncomingKey ? "Existing skill key matched; replace strategy." : null,
        });
        usedSlugs.add(normalizedSlug);
        usedKeys.add(importedSkill.key);
        continue;
      }

      if (conflictStrategy === "skip") {
        out.push({
          skill: conflict,
          action: "skipped",
          originalKey,
          originalSlug,
          requestedRefs: Array.from(new Set([originalKey, originalSlug])),
          reason: "Existing skill matched; skip strategy.",
        });
        continue;
      }

      const renamedSlug = uniqueSkillSlug(normalizedSlug || "skill", usedSlugs);
      const renamedKey = uniqueImportedSkillKey(companyId, renamedSlug, usedKeys);
      const renamedSkill: ImportedSkill = {
        ...importedSkill,
        slug: renamedSlug,
        key: renamedKey,
        metadata: {
          ...(importedSkill.metadata ?? {}),
          skillKey: renamedKey,
          importedFromSkillKey: originalKey,
          importedFromSkillSlug: originalSlug,
        },
      };
      toPersist.push(renamedSkill);
      prepared.push({
        skill: renamedSkill,
        originalKey,
        originalSlug,
        existingBefore: null,
        actionHint: "created",
        reason: `Existing skill matched; renamed to ${renamedSlug}.`,
      });
      usedSlugs.add(renamedSlug);
      usedKeys.add(renamedKey);
    }

    if (toPersist.length === 0) return out;

    const persisted = await upsertImportedSkills(companyId, toPersist);
    for (let index = 0; index < prepared.length; index += 1) {
      const persistedSkill = persisted[index];
      const preparedSkill = prepared[index];
      if (!persistedSkill || !preparedSkill) continue;
      out.push({
        skill: persistedSkill,
        action: preparedSkill.actionHint,
        originalKey: preparedSkill.originalKey,
        originalSlug: preparedSkill.originalSlug,
        requestedRefs: Array.from(new Set([preparedSkill.originalKey, preparedSkill.originalSlug])),
        reason: preparedSkill.reason,
      });
    }

    return out;
  }

  async function upsertImportedSkills(companyId: string, imported: ImportedSkill[]): Promise<CompanySkill[]> {
    const out: CompanySkill[] = [];
    for (const skill of imported) {
      const existing = await getByKey(companyId, skill.key);
      const existingMeta = existing ? getSkillMeta(existing) : {};
      const incomingMeta = skill.metadata && isPlainRecord(skill.metadata) ? skill.metadata : {};
      const incomingOwner = asString(incomingMeta.owner);
      const incomingRepo = asString(incomingMeta.repo);
      const incomingKind = asString(incomingMeta.sourceKind);
      if (
        existing
        && existingMeta.sourceKind === "paperclip_bundled"
        && incomingKind === "github"
        && incomingOwner === "paperclipai"
        && incomingRepo === "paperclip"
      ) {
        out.push(existing);
        continue;
      }

      const metadata = {
        ...(skill.metadata ?? {}),
        skillKey: skill.key,
      };
      const values = {
        companyId,
        key: skill.key,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        markdown: skill.markdown,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator,
        sourceRef: skill.sourceRef,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        fileInventory: serializeFileInventory(skill.fileInventory),
        metadata,
        updatedAt: new Date(),
      };
      const row = existing
        ? await db
          .update(companySkills)
          .set(values)
          .where(eq(companySkills.id, existing.id))
          .returning()
          .then((rows) => rows[0] ?? null)
        : await db
          .insert(companySkills)
          .values(values)
          .returning()
          .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Failed to persist company skill");
      out.push(toCompanySkill(row));
    }
    return out;
  }

  async function importFromSource(companyId: string, source: string): Promise<CompanySkillImportResult> {
    await ensureSkillInventoryCurrent(companyId);
    const parsed = parseSkillImportSourceInput(source);
    const local = !/^https?:\/\//i.test(parsed.resolvedSource);
    const { skills, warnings } = local
      ? {
        skills: (await readLocalSkillImports(companyId, parsed.resolvedSource))
          .filter((skill) => !parsed.requestedSkillSlug || skill.slug === parsed.requestedSkillSlug),
        warnings: parsed.warnings,
      }
      : await readUrlSkillImports(companyId, parsed.resolvedSource, parsed.requestedSkillSlug)
        .then((result) => ({
          skills: result.skills,
          warnings: [...parsed.warnings, ...result.warnings],
        }));
    const filteredSkills = parsed.requestedSkillSlug
      ? skills.filter((skill) => skill.slug === parsed.requestedSkillSlug)
      : skills;
    if (filteredSkills.length === 0) {
      throw unprocessable(
        parsed.requestedSkillSlug
          ? `Skill ${parsed.requestedSkillSlug} was not found in the provided source.`
          : "No skills were found in the provided source.",
      );
    }
    // Override sourceType/sourceLocator for skills imported via skills.sh
    if (parsed.originalSkillsShUrl) {
      for (const skill of filteredSkills) {
        skill.sourceType = "skills_sh";
        skill.sourceLocator = parsed.originalSkillsShUrl;
        if (skill.metadata) {
          (skill.metadata as Record<string, unknown>).sourceKind = "skills_sh";
        }
        skill.key = deriveCanonicalSkillKey(companyId, skill);
      }
    }
    const imported = await upsertImportedSkills(companyId, filteredSkills);
    return { imported, warnings };
  }

  async function deleteSkill(companyId: string, skillId: string): Promise<CompanySkill | null> {
    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;

    const skill = toCompanySkill(row);
    const usedByAgents = await usage(companyId, skill.key);

    if (usedByAgents.length > 0) {
      const agentNames = usedByAgents.map((agent) => agent.name).sort((left, right) => left.localeCompare(right));
      throw unprocessable(
        `Cannot delete skill "${skill.name}" while it is still used by ${agentNames.join(", ")}. Detach it from those agents first.`,
        {
          skillId: skill.id,
          skillKey: skill.key,
          usedByAgents: usedByAgents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            urlKey: agent.urlKey,
            adapterType: agent.adapterType,
          })),
        },
      );
    }

    // Delete DB row
    await db
      .delete(companySkills)
      .where(eq(companySkills.id, skillId));

    // Clean up materialized runtime files
    await fs.rm(resolveRuntimeSkillMaterializedPath(companyId, skill), { recursive: true, force: true });

    return skill;
  }

  return {
    list,
    listFull,
    getById,
    getByKey,
    resolveRequestedSkillKeys: async (companyId: string, requestedReferences: string[]) => {
      const skills = await listFull(companyId);
      return resolveRequestedSkillKeysOrThrow(skills, requestedReferences);
    },
    detail,
    updateStatus,
    readFile,
    updateFile,
    createLocalSkill,
    deleteSkill,
    importFromSource,
    scanProjectWorkspaces,
    importPackageFiles,
    installUpdate,
    listRuntimeSkillEntries,
  };
}
