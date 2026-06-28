import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, companySkillComments, companySkillStars, companySkillVersions, companySkills } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import type { PaperclipDesiredSkillEntry, PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import type {
  AgentDesiredSkillEntry,
  CatalogSkill,
  CompanySkill,
  CompanySkillAuditFinding,
  CompanySkillAuditResult,
  CompanySkillAuditVerdict,
  CompanySkillCategoryCount,
  CompanySkillComment,
  CompanySkillCommentCreateRequest,
  CompanySkillCommentUpdateRequest,
  CompanySkillCreateRequest,
  CompanySkillCompatibility,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillForkRequest,
  CompanySkillImportResult,
  CompanySkillInstallCatalogRequest,
  CompanySkillInstallCatalogResult,
  CompanySkillListQuery,
  CompanySkillListItem,
  CompanySkillProjectScanConflict,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillProjectScanSkipped,
  CompanySkillSharingScope,
  CompanySkillSourceBadge,
  CompanySkillSourceType,
  CompanySkillTrustLevel,
  CompanySkillUpdateRequest,
  CompanySkillUpdateStatus,
  CompanySkillUpdateHoldReason,
  CompanySkillUsageAgent,
  CompanySkillVersion,
  CompanySkillVersionCreateRequest,
  CompanySkillVersionFileInventoryEntry,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey, parseFrontmatterMarkdown } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import { agentService } from "./agents.js";
import { projectService } from "./projects.js";
import { normalizePortablePath } from "./portable-path.js";
import {
  copyCatalogSkillFile,
  getCatalogPackageMetadata,
  getCatalogSkillOrThrow,
  resolveCatalogSkillReference,
} from "./skills-catalog.js";
import {
  PORTABLE_CATALOG_PROVENANCE_STRING_KEYS,
  readCatalogStringList,
  readPortableCatalogProvenance,
} from "./catalog-provenance.js";

type CompanySkillRow = typeof companySkills.$inferSelect;
type CompanySkillVersionRow = typeof companySkillVersions.$inferSelect;
type CompanySkillCommentRow = typeof companySkillComments.$inferSelect;
type CompanySkillListDbRow = Pick<
  CompanySkillRow,
  | "id"
  | "companyId"
  | "key"
  | "slug"
  | "name"
  | "description"
  | "sourceType"
  | "sourceLocator"
  | "sourceRef"
  | "trustLevel"
  | "compatibility"
  | "fileInventory"
  | "iconUrl"
  | "color"
  | "tagline"
  | "authorName"
  | "homepageUrl"
  | "categories"
  | "sharingScope"
  | "publicShareToken"
  | "forkedFromSkillId"
  | "forkedFromCompanyId"
  | "starCount"
  | "installCount"
  | "forkCount"
  | "currentVersionId"
  | "metadata"
  | "createdAt"
  | "updatedAt"
>;
type CompanySkillListRow = Pick<
  CompanySkill,
  | "id"
  | "companyId"
  | "key"
  | "slug"
  | "name"
  | "description"
  | "sourceType"
  | "sourceLocator"
  | "sourceRef"
  | "trustLevel"
  | "compatibility"
  | "fileInventory"
  | "iconUrl"
  | "color"
  | "tagline"
  | "authorName"
  | "homepageUrl"
  | "categories"
  | "sharingScope"
  | "publicShareToken"
  | "forkedFromSkillId"
  | "forkedFromCompanyId"
  | "starCount"
  | "installCount"
  | "forkCount"
  | "currentVersionId"
  | "metadata"
  | "createdAt"
  | "updatedAt"
>;
type CompanySkillReferenceRow = Pick<
  CompanySkillRow,
  | "id"
  | "key"
  | "slug"
>;
type SkillReferenceTarget = Pick<CompanySkill, "id" | "key" | "slug">;
type SkillSourceInfoTarget = Pick<
  CompanySkill,
  | "companyId"
  | "sourceType"
  | "sourceLocator"
  | "metadata"
>;

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

const EXTERNAL_SKILL_SOURCE_TYPES = new Set<CompanySkillSourceType>(["github", "skills_sh", "url"]);

function isPinnedCommitRef(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{40}$/i.test(value.trim()));
}

function assertImportedSkillSourceAllowed(skill: ImportedSkill) {
  if (!EXTERNAL_SKILL_SOURCE_TYPES.has(skill.sourceType)) return;
  if (skill.trustLevel === "scripts_executables") {
    throw unprocessable(
      `External skill source "${skill.slug}" contains executable scripts and cannot be imported.`,
      {
        sourceType: skill.sourceType,
        trustLevel: skill.trustLevel,
        reason: "scripts_executables_blocked",
      },
    );
  }
  if ((skill.sourceType === "github" || skill.sourceType === "skills_sh") && !isPinnedCommitRef(skill.sourceRef)) {
    throw unprocessable(
      `External skill source "${skill.slug}" must resolve to a pinned Git commit before import.`,
      {
        sourceType: skill.sourceType,
        trustLevel: skill.trustLevel,
        reason: "unpinned_external_source",
      },
    );
  }
}

function assertImportedSkillKeyAllowed(skill: ImportedSkill) {
  if (!skill.key.startsWith("paperclipai/paperclip/")) return;
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const sourceKind = asString(metadata?.sourceKind);
  if (sourceKind === "paperclip_bundled") return;
  throw unprocessable(
    `Reserved Paperclip skill key "${skill.key}" cannot be imported from unbundled sources.`,
    {
      skillKey: skill.key,
      sourceKind: sourceKind ?? skill.sourceType,
    },
  );
}

type SkillSourceMeta = {
  skillKey?: string;
  sourceKind?: string;
  missingSource?: SkillMissingSourceMarker;
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
  catalogId?: string;
  catalogKind?: string;
  originHash?: string;
  packageName?: string;
  packageVersion?: string;
  originVersion?: string;
  originSnapshotLocator?: string;
  installedHash?: string;
  userModifiedAt?: string | null;
  updateHoldReason?: CompanySkillUpdateHoldReason | null;
  auditVerdict?: CompanySkillAuditVerdict;
  auditCodes?: string[];
  auditScannedAt?: string;
  auditScanVersion?: string;
};

type SkillMissingSourceMarker = {
  reason: "local_source_missing";
  sourceType: "local_path";
  sourceLocator: string | null;
  sourcePath: string | null;
  detectedAt: string;
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
  versionSelections?: Map<string, string | null>;
};

type SkillActor = {
  type: "agent" | "user" | "system";
  agentId?: string | null;
  userId?: string | null;
};

type RuntimeSkillSourceResolution =
  | { status: "available"; source: string }
  | { status: "missing"; source: string; detail: string };

const skillInventoryRefreshPromises = new Map<string, Promise<void>>();

function selectCompanySkillColumns() {
  return {
    id: companySkills.id,
    companyId: companySkills.companyId,
    key: companySkills.key,
    slug: companySkills.slug,
    name: companySkills.name,
    description: companySkills.description,
    markdown: companySkills.markdown,
    sourceType: companySkills.sourceType,
    sourceLocator: companySkills.sourceLocator,
    sourceRef: companySkills.sourceRef,
    trustLevel: companySkills.trustLevel,
    compatibility: companySkills.compatibility,
    fileInventory: companySkills.fileInventory,
    iconUrl: companySkills.iconUrl,
    color: companySkills.color,
    tagline: companySkills.tagline,
    authorName: companySkills.authorName,
    homepageUrl: companySkills.homepageUrl,
    categories: companySkills.categories,
    sharingScope: companySkills.sharingScope,
    publicShareToken: companySkills.publicShareToken,
    forkedFromSkillId: companySkills.forkedFromSkillId,
    forkedFromCompanyId: companySkills.forkedFromCompanyId,
    starCount: companySkills.starCount,
    installCount: companySkills.installCount,
    forkCount: companySkills.forkCount,
    currentVersionId: companySkills.currentVersionId,
    metadata: companySkills.metadata,
    createdAt: companySkills.createdAt,
    updatedAt: companySkills.updatedAt,
  };
}

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

const SKILL_AUDIT_SCAN_VERSION = "skills-audit-v1";
const MAX_CATALOG_FILE_BYTES = 1024 * 1024;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function sha256Buffer(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function buildInventoryContentHash(entries: Array<{ path: string; sha256: string }>) {
  const hashInput = entries
    .map((entry) => ({ path: normalizePortablePath(entry.path), sha256: entry.sha256 }))
    .sort((left, right) => {
      if (left.path === "SKILL.md") return -1;
      if (right.path === "SKILL.md") return 1;
      return left.path.localeCompare(right.path);
    });
  return `sha256:${sha256Buffer(Buffer.from(JSON.stringify(hashInput)))}`;
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
      const sourceKind = owner === "paperclipai"
        && repoName === "paperclip"
        && canonicalKey?.startsWith("paperclipai/paperclip/")
        ? "paperclip_bundled"
        : "github";
      return {
        sourceType: "github",
        sourceLocator: url,
        sourceRef: commit,
        metadata: {
          ...(canonicalKey ? { skillKey: canonicalKey } : {}),
          sourceKind,
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

  const catalogProvenance = readPortableCatalogProvenance(metadata, canonicalKey);
  if (catalogProvenance) {
    return {
      sourceType: "catalog",
      sourceLocator: null,
      sourceRef: catalogProvenance.sourceRef,
      metadata: catalogProvenance.metadata,
    };
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

function inventoryEntriesEqual(
  left: CompanySkillFileInventoryEntry[],
  right: CompanySkillFileInventoryEntry[],
) {
  if (left.length !== right.length) return false;
  const normalize = (entries: CompanySkillFileInventoryEntry[]) =>
    entries
      .map((entry) => ({
        path: normalizePortablePath(entry.path),
        kind: entry.kind,
      }))
      .sort((leftEntry, rightEntry) => leftEntry.path.localeCompare(rightEntry.path));
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft.every((entry, index) => {
    const other = normalizedRight[index];
    return other?.path === entry.path && other.kind === entry.kind;
  });
}

function inferLocalSkillInventoryMode(
  skill: Pick<CompanySkillRow, "sourceLocator" | "metadata">,
): LocalSkillInventoryMode {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const sourceKind = asString(metadata?.sourceKind);
  const workspaceCwd = asString(metadata?.workspaceCwd);
  if (sourceKind === "project_scan" && workspaceCwd && skill.sourceLocator === workspaceCwd) {
    return "project_root";
  }
  return "full";
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
    const sourceDir = path.dirname(resolvedPath);
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(sourceDir));
    const parsedMetadata = isPlainRecord(parsed.frontmatter.metadata) ? parsed.frontmatter.metadata : null;
    const skillKey = readCanonicalSkillKey(parsed.frontmatter, parsedMetadata);
    const metadata = {
      ...(skillKey ? { skillKey } : {}),
      ...(parsedMetadata ?? {}),
      sourceKind: "local_path",
    };
    const inventory = await collectLocalSkillInventory(sourceDir, "project_root");
    return [{
      key: deriveCanonicalSkillKey(companyId, {
        slug,
        sourceType: "local_path",
        sourceLocator: sourceDir,
        metadata,
      }),
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: asString(parsed.frontmatter.description),
      markdown,
      packageDir: path.dirname(resolvedPath),
      sourceType: "local_path",
      sourceLocator: sourceDir,
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

function normalizeFileInventory(row: { fileInventory: unknown }): CompanySkillFileInventoryEntry[] {
  return Array.isArray(row.fileInventory)
    ? row.fileInventory.flatMap((entry) => {
      if (!isPlainRecord(entry)) return [];
      return [{
        path: String(entry.path ?? ""),
        kind: (String(entry.kind ?? "other") as CompanySkillFileInventoryEntry["kind"]),
      }];
    })
    : [];
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
    fileInventory: normalizeFileInventory(row),
    iconUrl: row.iconUrl ?? null,
    color: row.color ?? null,
    tagline: row.tagline ?? null,
    authorName: row.authorName ?? null,
    homepageUrl: row.homepageUrl ?? null,
    categories: normalizeCategoryList(row.categories),
    sharingScope: normalizeSharingScope(row.sharingScope),
    publicShareToken: row.publicShareToken ?? null,
    forkedFromSkillId: row.forkedFromSkillId ?? null,
    forkedFromCompanyId: row.forkedFromCompanyId ?? null,
    starCount: Math.max(0, row.starCount ?? 0),
    installCount: Math.max(0, row.installCount ?? 0),
    forkCount: Math.max(0, row.forkCount ?? 0),
    currentVersionId: row.currentVersionId ?? null,
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
  };
}

function toCompanySkillListRow(row: CompanySkillListDbRow): CompanySkillListRow {
  return {
    ...row,
    description: row.description ?? null,
    sourceType: row.sourceType as CompanySkillSourceType,
    sourceLocator: row.sourceLocator ?? null,
    sourceRef: row.sourceRef ?? null,
    trustLevel: row.trustLevel as CompanySkillTrustLevel,
    compatibility: row.compatibility as CompanySkillCompatibility,
    fileInventory: normalizeFileInventory(row),
    iconUrl: row.iconUrl ?? null,
    color: row.color ?? null,
    tagline: row.tagline ?? null,
    authorName: row.authorName ?? null,
    homepageUrl: row.homepageUrl ?? null,
    categories: normalizeCategoryList(row.categories),
    sharingScope: normalizeSharingScope(row.sharingScope),
    publicShareToken: row.publicShareToken ?? null,
    forkedFromSkillId: row.forkedFromSkillId ?? null,
    forkedFromCompanyId: row.forkedFromCompanyId ?? null,
    starCount: Math.max(0, row.starCount ?? 0),
    installCount: Math.max(0, row.installCount ?? 0),
    forkCount: Math.max(0, row.forkCount ?? 0),
    currentVersionId: row.currentVersionId ?? null,
    metadata: isPlainRecord(row.metadata) ? row.metadata : null,
  };
}

function normalizeSharingScope(value: unknown): CompanySkillSharingScope {
  return value === "private" || value === "public_link" || value === "company" ? value : "company";
}

function normalizeMutableSharingScope(value: unknown): CompanySkillSharingScope | null {
  if (value === undefined || value === null) return null;
  if (value === "private" || value === "company") return value;
  if (value === "public_link") {
    throw unprocessable("Public skill sharing is not available in this version.");
  }
  throw unprocessable("Invalid skill sharing scope.");
}

function normalizeCategorySlug(value: unknown) {
  if (typeof value !== "string") return null;
  return normalizeSkillSlug(value);
}

function normalizeCategoryList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map(normalizeCategorySlug).filter((value): value is string => Boolean(value))));
}

function normalizeStoreText(value: unknown, maxLength = 500) {
  const text = asString(value);
  return text ? text.slice(0, maxLength) : null;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((entry): entry is string => Boolean(entry))
    : [];
}

function readSkillStoreMetadata(frontmatter: Record<string, unknown>, metadata: Record<string, unknown> | null) {
  const categories = normalizeCategoryList([
    ...readStringList(frontmatter.categories),
    ...readStringList(frontmatter.tags),
    ...readStringList(metadata?.categories),
    ...readStringList(metadata?.tags),
  ]);
  return {
    iconUrl: normalizeStoreText(frontmatter.iconUrl ?? frontmatter.icon ?? metadata?.iconUrl ?? metadata?.icon, 2000),
    color: normalizeStoreText(frontmatter.color ?? metadata?.color, 64),
    tagline: normalizeStoreText(frontmatter.tagline ?? frontmatter.summary ?? metadata?.tagline, 120),
    authorName: normalizeStoreText(frontmatter.author ?? frontmatter.authorName ?? metadata?.authorName, 200),
    homepageUrl: normalizeStoreText(frontmatter.homepage ?? frontmatter.homepageUrl ?? metadata?.homepageUrl, 2000),
    categories,
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

function serializeVersionFileInventory(
  fileInventory: CompanySkillVersionFileInventoryEntry[],
): CompanySkillVersionFileInventoryEntry[] {
  return fileInventory.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    content: entry.content,
  }));
}

function toCompanySkillVersion(row: CompanySkillVersionRow): CompanySkillVersion {
  return {
    ...row,
    label: row.label ?? null,
    fileInventory: Array.isArray(row.fileInventory)
      ? row.fileInventory.flatMap((entry) => {
        if (!isPlainRecord(entry)) return [];
        return [{
          path: String(entry.path ?? ""),
          kind: (String(entry.kind ?? "other") as CompanySkillFileInventoryEntry["kind"]),
          content: String(entry.content ?? ""),
        }];
      })
      : [],
    authorAgentId: row.authorAgentId ?? null,
    authorUserId: row.authorUserId ?? null,
  };
}

function toCompanySkillComment(row: CompanySkillCommentRow): CompanySkillComment {
  return {
    ...row,
    parentCommentId: row.parentCommentId ?? null,
    authorAgentId: row.authorAgentId ?? null,
    authorUserId: row.authorUserId ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

function getSkillMeta(skill: Pick<CompanySkill, "metadata">): SkillSourceMeta {
  return isPlainRecord(skill.metadata) ? skill.metadata as SkillSourceMeta : {};
}

function resolveCatalogSkillIfPresent(reference: string): CatalogSkill | null {
  const result = resolveCatalogSkillReference(reference);
  if (result.ambiguous) {
    throw conflict(`Catalog skill slug "${reference}" is ambiguous. Use an id or key.`);
  }
  return result.skill;
}

function getMissingSourceMarker(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!isPlainRecord(metadata)) return null;
  return isPlainRecord(metadata.missingSource) ? metadata.missingSource : null;
}

function buildMissingLocalSourceMarker(
  skill: Pick<CompanySkill, "sourceLocator" | "metadata">,
): SkillMissingSourceMarker {
  const existing = getMissingSourceMarker(skill.metadata);
  return {
    reason: "local_source_missing",
    sourceType: "local_path",
    sourceLocator: skill.sourceLocator ?? null,
    sourcePath: normalizeSourceLocatorDirectory(skill.sourceLocator),
    detectedAt: asString(existing?.detectedAt) ?? new Date().toISOString(),
  };
}

function withMissingSourceMarker(
  metadata: Record<string, unknown> | null,
  marker: SkillMissingSourceMarker,
) {
  return {
    ...(isPlainRecord(metadata) ? metadata : {}),
    missingSource: marker,
  };
}

function withoutMissingSourceMarker(metadata: Record<string, unknown> | null) {
  if (!isPlainRecord(metadata) || !isPlainRecord(metadata.missingSource)) return metadata;
  const next = { ...metadata };
  delete next.missingSource;
  return next;
}

function resolveSkillReference(
  skills: SkillReferenceTarget[],
  reference: string,
): { skill: SkillReferenceTarget | null; ambiguous: boolean } {
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

function normalizeRequestedDesiredSkillSelection(value: string | AgentDesiredSkillEntry): PaperclipDesiredSkillEntry {
  if (typeof value === "string") {
    return { key: value.trim(), versionId: null };
  }
  return {
    key: value.key.trim(),
    versionId: value.versionId ?? null,
  };
}

async function assertVersionMatchesSkill(
  db: Db,
  companyId: string,
  skillId: string,
  versionId: string | null,
) {
  if (!versionId) return;
  const row = await db
    .select({ id: companySkillVersions.id })
    .from(companySkillVersions)
    .where(and(
      eq(companySkillVersions.companyId, companyId),
      eq(companySkillVersions.companySkillId, skillId),
      eq(companySkillVersions.id, versionId),
    ))
    .then((rows) => rows[0] ?? null);
  if (!row) {
    throw unprocessable("Selected skill version does not belong to the requested company skill.", {
      versionId,
      skillId,
    });
  }
}

async function resolveRequestedSkillEntriesOrThrow(
  db: Db,
  companyId: string,
  skills: CompanySkill[],
  requestedSelections: Array<string | AgentDesiredSkillEntry>,
) {
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const resolved = new Map<string, PaperclipDesiredSkillEntry>();

  for (const rawSelection of requestedSelections) {
    const selection = normalizeRequestedDesiredSkillSelection(rawSelection);
    if (!selection.key) continue;

    const match = resolveSkillReference(skills, selection.key);
    if (match.skill) {
      const skill = skills.find((candidate) => candidate.id === match.skill?.id);
      if (!skill) {
        missing.add(selection.key);
        continue;
      }
      const selectedVersionId = selection.versionId ?? null;
      await assertVersionMatchesSkill(db, companyId, skill.id, selectedVersionId);
      if (!resolved.has(skill.key)) {
        resolved.set(skill.key, { key: skill.key, versionId: selectedVersionId });
      }
      continue;
    }

    if (match.ambiguous) {
      ambiguous.add(selection.key);
      continue;
    }

    missing.add(selection.key);
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

  return Array.from(resolved.values());
}

function resolveDesiredSkillKeys(
  skills: SkillReferenceTarget[],
  config: Record<string, unknown>,
) {
  const preference = readPaperclipSkillSyncPreference(config);
  return Array.from(new Set(
    preference.desiredSkills
      .map((reference) => resolveSkillReference(skills, reference).skill?.key ?? normalizeSkillKey(reference))
      .filter((value): value is string => Boolean(value)),
  ));
}

function resolveDesiredSkillEntries(
  skills: SkillReferenceTarget[],
  config: Record<string, unknown>,
) {
  const preference = readPaperclipSkillSyncPreference(config);
  const out = new Map<string, PaperclipDesiredSkillEntry>();
  for (const entry of preference.desiredSkillEntries) {
    const key = resolveSkillReference(skills, entry.key).skill?.key ?? normalizeSkillKey(entry.key);
    if (!key || out.has(key)) continue;
    out.set(key, { key, versionId: entry.versionId ?? null });
  }
  return Array.from(out.values());
}

function normalizeSkillDirectory(skill: SkillSourceInfoTarget) {
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

async function resolveExistingSkillDirectory(skillDir: string | null) {
  if (!skillDir) return null;
  const dirStat = await statPath(skillDir);
  const skillFileStat = await statPath(path.join(skillDir, "SKILL.md"));
  return dirStat?.isDirectory() && skillFileStat?.isFile() ? skillDir : null;
}

function buildMissingRuntimeSourceDetail(skill: Pick<CompanySkill, "name" | "sourceLocator" | "metadata">) {
  const marker = getMissingSourceMarker(skill.metadata);
  const sourcePath = asString(marker?.sourcePath) ?? normalizeSourceLocatorDirectory(skill.sourceLocator);
  if (sourcePath) {
    return `Company skill "${skill.name}" is in the library, but Paperclip cannot find its local source at ${sourcePath}.`;
  }
  return `Company skill "${skill.name}" is in the library, but Paperclip cannot find a valid local runtime source for it.`;
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

async function collectSkillFileBytes(skillDir: string): Promise<{
  files: Array<{ path: string; bytes: Buffer; sizeBytes: number; kind: CompanySkillFileInventoryEntry["kind"] }>;
  findings: CompanySkillAuditFinding[];
}> {
  const files: Array<{ path: string; bytes: Buffer; sizeBytes: number; kind: CompanySkillFileInventoryEntry["kind"] }> = [];
  const findings: CompanySkillAuditFinding[] = [];
  const root = path.resolve(skillDir);

  async function visit(current: string) {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.resolve(current, entry.name);
      const relativePath = normalizePortablePath(path.relative(root, absolutePath));
      if (!relativePath || relativePath.split("/").includes("..") || path.isAbsolute(relativePath)) {
        findings.push({
          code: "path_out_of_tree",
          severity: "error",
          message: "Resolved file path is outside the skill directory.",
          path: relativePath || null,
        });
        continue;
      }

      const lstat = await fs.lstat(absolutePath).catch(() => null);
      if (!lstat) continue;
      if (lstat.isSymbolicLink()) {
        findings.push({
          code: "symlink",
          severity: "error",
          message: "Skill files must not be symlinks.",
          path: relativePath,
        });
        continue;
      }
      if (lstat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!lstat.isFile()) continue;
      const bytes = await fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        bytes,
        sizeBytes: lstat.size,
        kind: classifyInventoryKind(relativePath),
      });
    }
  }

  await visit(root);
  files.sort((left, right) => {
    if (left.path === "SKILL.md") return -1;
    if (right.path === "SKILL.md") return 1;
    return left.path.localeCompare(right.path);
  });
  return { files, findings };
}

function contentLooksBinary(bytes: Buffer) {
  if (bytes.includes(0)) return true;
  const text = bytes.toString("utf8");
  return text.includes("\uFFFD");
}

function extractMarkdownLinks(markdown: string) {
  const links: string[] = [];
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const link = match[1]?.trim();
    if (link) links.push(link);
  }
  return links;
}

function pushFinding(
  findings: CompanySkillAuditFinding[],
  code: string,
  severity: CompanySkillAuditFinding["severity"],
  message: string,
  filePath: string | null,
) {
  findings.push({ code, severity, message, path: filePath });
}

async function auditInstalledSkillBytes(skill: CompanySkill): Promise<CompanySkillAuditResult> {
  const skillDir = normalizeSkillDirectory(skill);
  const scannedAt = new Date().toISOString();
  const originHash = asString(getSkillMeta(skill).originHash);
  if (!skillDir) {
    return {
      skillId: skill.id,
      installedHash: null,
      originHash,
      verdict: "fail",
      codes: ["origin_unavailable"],
      findings: [{
        code: "origin_unavailable",
        severity: "error",
        message: "Skill files are not available on disk for audit.",
        path: null,
      }],
      scannedAt,
      scanVersion: SKILL_AUDIT_SCAN_VERSION,
    };
  }

  const { files, findings } = await collectSkillFileBytes(skillDir);
  const actualPaths = files.map((file) => file.path).sort((left, right) => left.localeCompare(right));
  const expectedPaths = skill.fileInventory.map((entry) => normalizePortablePath(entry.path)).sort((left, right) => left.localeCompare(right));
  const installedHash = buildInventoryContentHash(files.map((file) => ({
    path: file.path,
    sha256: sha256Buffer(file.bytes),
  })));

  if (!actualPaths.includes("SKILL.md")) {
    pushFinding(findings, "missing_skill_md", "error", "Skill inventory does not contain SKILL.md.", "SKILL.md");
  }

  const actualSet = new Set(actualPaths);
  const expectedSet = new Set(expectedPaths);
  for (const expected of expectedPaths) {
    if (!actualSet.has(expected)) {
      if (expected === "SKILL.md") continue;
      pushFinding(findings, "inventory_mismatch", "error", "Expected inventory file is missing on disk.", expected);
    }
  }
  for (const actual of actualPaths) {
    if (!expectedSet.has(actual)) {
      pushFinding(findings, "inventory_mismatch", "error", "Installed file is not present in recorded inventory.", actual);
    }
  }

  const fileMap = new Map(files.map((file) => [file.path, file]));
  const skillFile = fileMap.get("SKILL.md");
  if (skillFile) {
    const markdown = skillFile.bytes.toString("utf8");
    const parsed = parseFrontmatterMarkdown(markdown);
    if (!markdown.startsWith("---\n") || !asString(parsed.frontmatter.name)) {
      pushFinding(findings, "invalid_frontmatter", "error", "SKILL.md must contain valid frontmatter with a name.", "SKILL.md");
    }
  }

  const remoteExecPattern = /\b(?:curl|wget)\b[\s\S]{0,160}\|\s*(?:sh|bash)|\b(?:bash|sh)\s+-c\b|\beval\b|\bpython\s+-c\b|\bnode\s+-e\b/i;
  const secretExfilPattern = /\b(?:cat|printenv|env|grep)\b[\s\S]{0,160}(?:\.aws\/credentials|\.ssh\/|\.npmrc|id_rsa|OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY|TOKEN|SECRET)[\s\S]{0,160}\b(?:curl|wget|nc|netcat|scp)\b/i;
  const networkPattern = /\b(?:curl|wget|fetch|httpie|nc|netcat|scp|ssh)\b|https?:\/\//i;
  const secretReferencePattern = /\b(?:process\.env|printenv|\$[A-Z][A-Z0-9_]{2,}|API_KEY|TOKEN|SECRET|PASSWORD|\.env)\b/i;

  for (const file of files) {
    if (file.sizeBytes > MAX_CATALOG_FILE_BYTES) {
      pushFinding(findings, "oversized_file", "error", `Skill file exceeds ${MAX_CATALOG_FILE_BYTES} bytes.`, file.path);
    }
    if (file.kind !== "asset" && contentLooksBinary(file.bytes)) {
      pushFinding(findings, "non_text_file", "error", "Non-asset skill files must be UTF-8 text.", file.path);
      continue;
    }
    if (file.kind === "asset" || file.kind === "script" || file.kind === "other") {
      pushFinding(findings, `${file.kind}_trust`, "warning", `Skill includes a ${file.kind} file.`, file.path);
    }
    if (file.kind === "asset") continue;

    const text = file.bytes.toString("utf8");
    if (remoteExecPattern.test(text)) {
      pushFinding(findings, "remote_fetch_exec", "error", "Remote-fetch or dynamic execution pattern is not allowed.", file.path);
    }
    if (secretExfilPattern.test(text)) {
      pushFinding(findings, "secret_exfiltration", "error", "Secret exfiltration pattern is not allowed.", file.path);
    }
    if (networkPattern.test(text)) {
      pushFinding(findings, "network_reference", "warning", "Skill content references network-capable commands or URLs.", file.path);
    }
    if (secretReferencePattern.test(text)) {
      pushFinding(findings, "secret_reference", "warning", "Skill content references environment variables or secret-like values.", file.path);
    }
    if (isMarkdownPath(file.path)) {
      for (const link of extractMarkdownLinks(text)) {
        if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
        const linkTarget = normalizePortablePath(path.posix.join(path.posix.dirname(file.path), link.split("#")[0] ?? ""));
        if (linkTarget && !actualSet.has(linkTarget)) {
          pushFinding(findings, "broken_internal_link", "warning", `Markdown link target is missing: ${link}`, file.path);
        }
      }
    }
  }

  if (originHash && installedHash !== originHash) {
    pushFinding(findings, "local_modifications", "warning", "Installed catalog bytes differ from the pinned origin hash.", null);
  }

  findings.sort((left, right) => `${left.severity}:${left.code}:${left.path ?? ""}`.localeCompare(`${right.severity}:${right.code}:${right.path ?? ""}`));
  const verdict: CompanySkillAuditVerdict = findings.some((finding) => finding.severity === "error")
    ? "fail"
    : findings.length > 0 ? "warning" : "pass";
  return {
    skillId: skill.id,
    installedHash,
    originHash,
    verdict,
    codes: Array.from(new Set(findings.map((finding) => finding.code))).sort(),
    findings,
    scannedAt,
    scanVersion: SKILL_AUDIT_SCAN_VERSION,
  };
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

function deriveSkillSourceInfo(skill: SkillSourceInfoTarget): {
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

function enrichSkill(
  skill: CompanySkill,
  attachedAgentCount: number,
  usedByAgents: CompanySkillUsageAgent[] = [],
  currentVersion: CompanySkillVersion | null = null,
  starredByCurrentActor = false,
) {
  const source = deriveSkillSourceInfo(skill);
  return {
    ...skill,
    attachedAgentCount,
    usedByAgents,
    currentVersion,
    starredByCurrentActor,
    ...source,
  };
}

function toCompanySkillListItem(skill: CompanySkillListRow, attachedAgentCount: number): CompanySkillListItem {
  const source = deriveSkillSourceInfo(skill);
  const metadata = getSkillMeta(skill);
  const catalogKind = skill.sourceType === "catalog" && (metadata.catalogKind === "bundled" || metadata.catalogKind === "optional")
    ? metadata.catalogKind
    : null;
  const originHash = skill.sourceType === "catalog" ? asString(metadata.originHash) : null;
  const packageName = skill.sourceType === "catalog" ? asString(metadata.packageName) : null;
  const packageVersion = skill.sourceType === "catalog" ? asString(metadata.packageVersion) : null;
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
    iconUrl: skill.iconUrl,
    color: skill.color,
    tagline: skill.tagline,
    authorName: skill.authorName,
    homepageUrl: skill.homepageUrl,
    categories: skill.categories,
    sharingScope: skill.sharingScope,
    publicShareToken: skill.publicShareToken,
    forkedFromSkillId: skill.forkedFromSkillId,
    forkedFromCompanyId: skill.forkedFromCompanyId,
    starCount: skill.starCount,
    installCount: skill.installCount,
    forkCount: skill.forkCount,
    currentVersionId: skill.currentVersionId,
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
    attachedAgentCount,
    editable: source.editable,
    editableReason: source.editableReason,
    sourceLabel: source.sourceLabel,
    sourceBadge: source.sourceBadge,
    sourcePath: source.sourcePath,
    catalogKind,
    originHash,
    packageName,
    packageVersion,
  };
}

export function companySkillService(db: Db) {
  const agents = agentService(db);
  const projects = projectService(db);

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

  async function reconcileLocalPathSkillSources(companyId: string) {
    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        slug: companySkills.slug,
        sourceType: companySkills.sourceType,
        sourceLocator: companySkills.sourceLocator,
        trustLevel: companySkills.trustLevel,
        fileInventory: companySkills.fileInventory,
        metadata: companySkills.metadata,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    const skills = rows.map((row) => ({
      ...row,
      sourceType: row.sourceType as CompanySkillSourceType,
      trustLevel: row.trustLevel as CompanySkillTrustLevel,
      fileInventory: normalizeFileInventory(row),
      metadata: isPlainRecord(row.metadata) ? row.metadata : null,
    }));
    const missingIds = new Set(await findMissingLocalSkillIds(skills));

    for (const skill of skills) {
      if (skill.sourceType !== "local_path") continue;

      if (!missingIds.has(skill.id)) {
        const metadata = getMissingSourceMarker(skill.metadata)
          ? withoutMissingSourceMarker(skill.metadata)
          : skill.metadata;
        const sourceLocator = asString(skill.sourceLocator);
        const nextInventory = sourceLocator
          ? await collectLocalSkillInventory(sourceLocator, inferLocalSkillInventoryMode(skill)).catch(() => null)
          : null;
        const nextTrustLevel = nextInventory ? deriveTrustLevel(nextInventory) : skill.trustLevel;
        const inventoryChanged = nextInventory ? !inventoryEntriesEqual(skill.fileInventory, nextInventory) : false;
        const metadataChanged = JSON.stringify(metadata ?? {}) !== JSON.stringify(skill.metadata ?? {});
        if (inventoryChanged || metadataChanged || nextTrustLevel !== skill.trustLevel) {
          await db
            .update(companySkills)
            .set({
              ...(nextInventory ? { fileInventory: serializeFileInventory(nextInventory) } : {}),
              trustLevel: nextTrustLevel,
              metadata,
              updatedAt: new Date(),
            })
            .where(eq(companySkills.id, skill.id));
        }
        continue;
      }

      const usedByAgents = await usage(companyId, skill.key);
      if (usedByAgents.length > 0) {
        const metadata = withMissingSourceMarker(
          skill.metadata,
          buildMissingLocalSourceMarker(skill),
        );
        if (JSON.stringify(metadata) !== JSON.stringify(skill.metadata ?? {})) {
          await db
            .update(companySkills)
            .set({ metadata, updatedAt: new Date() })
            .where(eq(companySkills.id, skill.id));
        }
        continue;
      }

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
      const companyExists = await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.id, companyId))
        .then((rows) => rows.length > 0);
      if (!companyExists) {
        throw notFound("Company not found");
      }
      await ensureBundledSkills(companyId);
      await reconcileLocalPathSkillSources(companyId);
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

  async function list(companyId: string, query: CompanySkillListQuery = {}): Promise<CompanySkillListItem[]> {
    await ensureSkillInventoryCurrent(companyId);
    const rows = await db
      .select({
        id: companySkills.id,
        companyId: companySkills.companyId,
        key: companySkills.key,
        slug: companySkills.slug,
        name: companySkills.name,
        description: companySkills.description,
        sourceType: companySkills.sourceType,
        sourceLocator: companySkills.sourceLocator,
        sourceRef: companySkills.sourceRef,
        trustLevel: companySkills.trustLevel,
        compatibility: companySkills.compatibility,
        fileInventory: companySkills.fileInventory,
        iconUrl: companySkills.iconUrl,
        color: companySkills.color,
        tagline: companySkills.tagline,
        authorName: companySkills.authorName,
        homepageUrl: companySkills.homepageUrl,
        categories: companySkills.categories,
        sharingScope: companySkills.sharingScope,
        publicShareToken: companySkills.publicShareToken,
        forkedFromSkillId: companySkills.forkedFromSkillId,
        forkedFromCompanyId: companySkills.forkedFromCompanyId,
        starCount: companySkills.starCount,
        installCount: companySkills.installCount,
        forkCount: companySkills.forkCount,
        currentVersionId: companySkills.currentVersionId,
        metadata: companySkills.metadata,
        createdAt: companySkills.createdAt,
        updatedAt: companySkills.updatedAt,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.key))
      .then((entries) => entries.map((entry) => toCompanySkillListRow(entry as CompanySkillListDbRow)));
    const agentRows = await agents.list(companyId);
    const q = query.q?.trim().toLowerCase() ?? "";
    const categories = new Set((query.categories ?? []).map(normalizeCategorySlug).filter((value): value is string => Boolean(value)));
    const filtered = rows.filter((skill) => {
      if (query.scope && skill.sharingScope !== query.scope) return false;
      if (categories.size > 0 && !skill.categories.some((category) => categories.has(category))) return false;
      if (q) {
        const haystack = [
          skill.name,
          skill.slug,
          skill.key,
          skill.description,
          skill.tagline,
          skill.authorName,
          ...skill.categories,
        ].filter(Boolean).join("\n").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
    const items = filtered.map((skill) => {
      const attachedAgentCount = agentRows.filter((agent) => {
        const desiredSkills = resolveDesiredSkillKeys(rows, agent.adapterConfig as Record<string, unknown>);
        return desiredSkills.includes(skill.key);
      }).length;
      return toCompanySkillListItem(skill, attachedAgentCount);
    });
    const sort = query.sort ?? "alphabetical";
    items.sort((left, right) => {
      if (sort === "recent") return right.updatedAt.getTime() - left.updatedAt.getTime() || left.name.localeCompare(right.name);
      if (sort === "installs") return right.installCount - left.installCount || left.name.localeCompare(right.name);
      if (sort === "stars") return right.starCount - left.starCount || left.name.localeCompare(right.name);
      if (sort === "agents") return right.attachedAgentCount - left.attachedAgentCount || left.name.localeCompare(right.name);
      if (sort === "forks") return right.forkCount - left.forkCount || left.name.localeCompare(right.name);
      return left.name.localeCompare(right.name) || left.key.localeCompare(right.key);
    });
    return items;
  }

  async function listFull(companyId: string): Promise<CompanySkill[]> {
    await ensureSkillInventoryCurrent(companyId);
    const rows = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.key));
    return rows.map((row) => toCompanySkill(row));
  }

  async function categoryCounts(companyId: string): Promise<CompanySkillCategoryCount[]> {
    const rows = await listFull(companyId);
    const counts = new Map<string, number>();
    for (const skill of rows) {
      for (const category of skill.categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([slug, count]) => ({ slug, count }))
      .sort((left, right) => right.count - left.count || left.slug.localeCompare(right.slug));
  }

  async function listReferenceTargets(companyId: string): Promise<SkillReferenceTarget[]> {
    const rows = await db
      .select({
        id: companySkills.id,
        key: companySkills.key,
        slug: companySkills.slug,
      })
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId));
    return rows as CompanySkillReferenceRow[];
  }

  async function getById(companyId: string, id: string) {
    const row = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.id, id)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getByKey(companyId: string, key: string) {
    const row = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.key, key)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getVersion(companyId: string, skillId: string, versionId: string): Promise<CompanySkillVersion | null> {
    const row = await db
      .select()
      .from(companySkillVersions)
      .where(and(
        eq(companySkillVersions.companyId, companyId),
        eq(companySkillVersions.companySkillId, skillId),
        eq(companySkillVersions.id, versionId),
      ))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkillVersion(row) : null;
  }

  async function getCurrentVersion(skill: CompanySkill): Promise<CompanySkillVersion | null> {
    return skill.currentVersionId ? getVersion(skill.companyId, skill.id, skill.currentVersionId) : null;
  }

  async function isStarredByActor(companyId: string, skillId: string, actor: SkillActor | null | undefined) {
    if (!actor || actor.type === "system") return false;
    const clause = actor.type === "agent" && actor.agentId
      ? eq(companySkillStars.agentId, actor.agentId)
      : actor.type === "user" && actor.userId
        ? eq(companySkillStars.userId, actor.userId)
        : null;
    if (!clause) return false;
    const row = await db
      .select({ id: companySkillStars.id })
      .from(companySkillStars)
      .where(and(
        eq(companySkillStars.companyId, companyId),
        eq(companySkillStars.companySkillId, skillId),
        clause,
      ))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function updateSkillMetadata(
    skill: CompanySkill,
    metadataPatch: Record<string, unknown>,
  ): Promise<CompanySkill> {
    const metadata = {
      ...(isPlainRecord(skill.metadata) ? skill.metadata : {}),
      ...metadataPatch,
    };
    const row = await db
      .update(companySkills)
      .set({ metadata, updatedAt: new Date() })
      .where(eq(companySkills.id, skill.id))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Skill not found");
    return toCompanySkill(row);
  }

  async function persistAuditMetadata(skill: CompanySkill, audit: CompanySkillAuditResult): Promise<CompanySkill> {
    const userModifiedAt = audit.originHash && audit.installedHash !== audit.originHash
      ? asString(getSkillMeta(skill).userModifiedAt) ?? audit.scannedAt
      : null;
    const updateHoldReason: CompanySkillUpdateHoldReason | null = audit.verdict === "fail"
      ? "audit_hard_stop"
      : userModifiedAt ? "local_modifications" : null;
    return updateSkillMetadata(skill, {
      installedHash: audit.installedHash,
      userModifiedAt,
      updateHoldReason,
      auditVerdict: audit.verdict,
      auditCodes: audit.codes,
      auditScannedAt: audit.scannedAt,
      auditScanVersion: audit.scanVersion,
    });
  }

  async function auditSkill(companyId: string, skillId: string): Promise<CompanySkillAuditResult | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;
    if (skill.sourceType !== "catalog" && skill.sourceType !== "local_path") {
      throw unprocessable("Only local-path and catalog-managed company skills support audit.");
    }
    const audit = await auditInstalledSkillBytes(skill);
    await persistAuditMetadata(skill, audit);
    return audit;
  }

  async function usage(companyId: string, key: string): Promise<CompanySkillUsageAgent[]> {
    const skills = await listReferenceTargets(companyId);
    const agentRows = await agents.list(companyId);
    const desiredAgents = agentRows.flatMap((agent) => {
      const desiredEntries = resolveDesiredSkillEntries(skills, agent.adapterConfig as Record<string, unknown>);
      const desiredEntry = desiredEntries.find((entry) => entry.key === key);
      return desiredEntry ? [{ agent, desiredEntry }] : [];
    });

    return desiredAgents.map(({ agent, desiredEntry }) => ({
      id: agent.id,
      name: agent.name,
      urlKey: agent.urlKey,
      adapterType: agent.adapterType,
      desired: true,
      // Runtime adapter state is intentionally omitted from this bounded metadata read.
      actualState: null,
      versionId: desiredEntry.versionId ?? null,
    }));
  }

  async function detail(companyId: string, id: string, actor?: SkillActor | null): Promise<CompanySkillDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, id);
    if (!skill) return null;
    const usedByAgents = await usage(companyId, skill.key);
    return enrichSkill(
      skill,
      usedByAgents.length,
      usedByAgents,
      await getCurrentVersion(skill),
      await isStarredByActor(companyId, id, actor),
    );
  }

  async function collectVersionFileInventory(
    companyId: string,
    skill: CompanySkill,
  ): Promise<CompanySkillVersionFileInventoryEntry[]> {
    const out: CompanySkillVersionFileInventoryEntry[] = [];
    for (const entry of skill.fileInventory) {
      const detail = await readFile(companyId, skill.id, entry.path);
      if (!detail) continue;
      out.push({
        path: detail.path,
        kind: detail.kind,
        content: detail.content,
      });
    }
    return out;
  }

  async function listVersions(companyId: string, skillId: string): Promise<CompanySkillVersion[]> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const rows = await db
      .select()
      .from(companySkillVersions)
      .where(and(eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.companySkillId, skillId)))
      .orderBy(desc(companySkillVersions.revisionNumber));
    return rows.map((row) => toCompanySkillVersion(row));
  }

  async function createVersion(
    companyId: string,
    skillId: string,
    input: CompanySkillVersionCreateRequest = {},
    actor: SkillActor | null = null,
  ): Promise<CompanySkillVersion> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const fileInventory = serializeVersionFileInventory(await collectVersionFileInventory(companyId, skill));
    const versionRow = await db.transaction(async (tx) => {
      await tx.execute(sql`
        select ${companySkills.id}
        from ${companySkills}
        where ${companySkills.id} = ${skillId}
          and ${companySkills.companyId} = ${companyId}
        for update
      `);
      const [{ nextRevision }] = await tx
        .select({
          nextRevision: sql<number>`coalesce(max(${companySkillVersions.revisionNumber}), 0) + 1`,
        })
        .from(companySkillVersions)
        .where(and(eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.companySkillId, skillId)));
      const row = await tx
        .insert(companySkillVersions)
        .values({
          companyId,
          companySkillId: skillId,
          revisionNumber: Number(nextRevision ?? 1),
          label: input.label?.trim() || null,
          fileInventory,
          authorAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
          authorUserId: actor?.type === "user" ? actor.userId ?? null : null,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) return null;
      await tx
        .update(companySkills)
        .set({ currentVersionId: row.id, updatedAt: new Date() })
        .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)));
      return row;
    });
    if (!versionRow) throw notFound("Failed to persist skill version");
    return toCompanySkillVersion(versionRow);
  }

  async function refreshStarCount(companyId: string, skillId: string) {
    const [{ value }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(companySkillStars)
      .where(and(eq(companySkillStars.companyId, companyId), eq(companySkillStars.companySkillId, skillId)));
    const starCount = Number(value ?? 0);
    await db
      .update(companySkills)
      .set({ starCount, updatedAt: new Date() })
      .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)));
    return starCount;
  }

  function actorStarClause(actor: SkillActor) {
    if (actor.type === "agent" && actor.agentId) return eq(companySkillStars.agentId, actor.agentId);
    if (actor.type === "user" && actor.userId) return eq(companySkillStars.userId, actor.userId);
    throw unprocessable("Skill stars require an agent or board user actor.");
  }

  async function starSkill(companyId: string, skillId: string, actor: SkillActor) {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const existing = await db
      .select({ id: companySkillStars.id })
      .from(companySkillStars)
      .where(and(eq(companySkillStars.companyId, companyId), eq(companySkillStars.companySkillId, skillId), actorStarClause(actor)))
      .then((rows) => rows[0] ?? null);
    if (!existing) {
      await db.insert(companySkillStars).values({
        companyId,
        companySkillId: skillId,
        agentId: actor.type === "agent" ? actor.agentId ?? null : null,
        userId: actor.type === "user" ? actor.userId ?? null : null,
      });
    }
    return { skillId, starred: true, starCount: await refreshStarCount(companyId, skillId) };
  }

  async function unstarSkill(companyId: string, skillId: string, actor: SkillActor) {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    await db
      .delete(companySkillStars)
      .where(and(eq(companySkillStars.companyId, companyId), eq(companySkillStars.companySkillId, skillId), actorStarClause(actor)));
    return { skillId, starred: false, starCount: await refreshStarCount(companyId, skillId) };
  }

  async function listComments(companyId: string, skillId: string): Promise<CompanySkillComment[]> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const rows = await db
      .select()
      .from(companySkillComments)
      .where(and(
        eq(companySkillComments.companyId, companyId),
        eq(companySkillComments.companySkillId, skillId),
        isNull(companySkillComments.deletedAt),
      ))
      .orderBy(asc(companySkillComments.createdAt));
    return rows.map((row) => toCompanySkillComment(row));
  }

  async function createComment(
    companyId: string,
    skillId: string,
    input: CompanySkillCommentCreateRequest,
    actor: SkillActor,
  ): Promise<CompanySkillComment> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    if (input.parentCommentId) {
      const parent = await db
        .select({ id: companySkillComments.id })
        .from(companySkillComments)
        .where(and(
          eq(companySkillComments.companyId, companyId),
          eq(companySkillComments.companySkillId, skillId),
          eq(companySkillComments.id, input.parentCommentId),
          isNull(companySkillComments.deletedAt),
        ))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Parent comment not found");
    }
    const row = await db
      .insert(companySkillComments)
      .values({
        companyId,
        companySkillId: skillId,
        parentCommentId: input.parentCommentId ?? null,
        authorAgentId: actor.type === "agent" ? actor.agentId ?? null : null,
        authorUserId: actor.type === "user" ? actor.userId ?? null : null,
        body: input.body,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Failed to persist skill comment");
    return toCompanySkillComment(row);
  }

  function assertCanMutateComment(comment: CompanySkillComment, actor: SkillActor) {
    if (actor.type === "user") return;
    if (actor.type === "agent" && actor.agentId && comment.authorAgentId === actor.agentId) return;
    throw unprocessable("Only the comment author or a board user can modify this skill comment.");
  }

  async function updateComment(
    companyId: string,
    skillId: string,
    commentId: string,
    input: CompanySkillCommentUpdateRequest,
    actor: SkillActor,
  ): Promise<CompanySkillComment> {
    const existing = await db
      .select()
      .from(companySkillComments)
      .where(and(
        eq(companySkillComments.companyId, companyId),
        eq(companySkillComments.companySkillId, skillId),
        eq(companySkillComments.id, commentId),
        isNull(companySkillComments.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Skill comment not found");
    const comment = toCompanySkillComment(existing);
    assertCanMutateComment(comment, actor);
    const row = await db
      .update(companySkillComments)
      .set({ body: input.body, updatedAt: new Date() })
      .where(and(
        eq(companySkillComments.companyId, companyId),
        eq(companySkillComments.companySkillId, skillId),
        eq(companySkillComments.id, commentId),
        isNull(companySkillComments.deletedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Skill comment not found");
    return toCompanySkillComment(row);
  }

  async function deleteComment(
    companyId: string,
    skillId: string,
    commentId: string,
    actor: SkillActor,
  ): Promise<CompanySkillComment> {
    const existing = await db
      .select()
      .from(companySkillComments)
      .where(and(
        eq(companySkillComments.companyId, companyId),
        eq(companySkillComments.companySkillId, skillId),
        eq(companySkillComments.id, commentId),
        isNull(companySkillComments.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) throw notFound("Skill comment not found");
    const comment = toCompanySkillComment(existing);
    assertCanMutateComment(comment, actor);
    const row = await db
      .update(companySkillComments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(companySkillComments.companyId, companyId),
        eq(companySkillComments.companySkillId, skillId),
        eq(companySkillComments.id, commentId),
        isNull(companySkillComments.deletedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Skill comment not found");
    return toCompanySkillComment(row);
  }

  async function forkSkill(
    companyId: string,
    skillId: string,
    input: CompanySkillForkRequest = {},
    actor: SkillActor | null = null,
  ): Promise<CompanySkill> {
    await ensureSkillInventoryCurrent(companyId);
    const source = await getById(companyId, skillId);
    if (!source) throw notFound("Skill not found");
    const existing = await listFull(companyId);
    const usedSlugs = new Set(existing.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
    const forkSlug = uniqueSkillSlug(normalizeSkillSlug(input.slug ?? `${source.slug}-fork`) ?? `${source.slug}-fork`, usedSlugs);
    const forkName = input.name?.trim() || `${source.name} Fork`;
    const managedRoot = resolveManagedSkillsRoot(companyId);
    const forkDir = path.resolve(managedRoot, forkSlug);
    await fs.rm(forkDir, { recursive: true, force: true });
    await fs.mkdir(forkDir, { recursive: true });
    for (const entry of source.fileInventory) {
      const detail = await readFile(companyId, source.id, entry.path);
      if (!detail) continue;
      const targetPath = path.resolve(forkDir, detail.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, detail.content, "utf8");
    }
    const skillFilePath = path.join(forkDir, "SKILL.md");
    const markdown = await fs.readFile(skillFilePath, "utf8").catch(() => source.markdown);
    if (!(await statPath(skillFilePath))?.isFile()) {
      await fs.writeFile(skillFilePath, markdown, "utf8");
    }
    const inventory = await collectLocalSkillInventory(forkDir);
    const parsed = parseFrontmatterMarkdown(markdown);
    const metadata = {
      sourceKind: "managed_local",
      forkedFromSkillId: source.id,
      forkedFromCompanyId: source.companyId,
      forkedByAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
      forkedByUserId: actor?.type === "user" ? actor.userId ?? null : null,
    };
    const imported = await upsertImportedSkills(companyId, [{
      key: `company/${companyId}/${forkSlug}`,
      slug: forkSlug,
      name: asString(parsed.frontmatter.name) ?? forkName,
      description: asString(parsed.frontmatter.description) ?? source.description,
      markdown,
      sourceType: "local_path",
      sourceLocator: forkDir,
      sourceRef: null,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: source.compatibility,
      fileInventory: inventory,
      metadata,
    }]);
    const forked = imported[0]!;
    await db
      .update(companySkills)
      .set({
        iconUrl: source.iconUrl,
        color: source.color,
        tagline: source.tagline,
        authorName: source.authorName,
        homepageUrl: source.homepageUrl,
        categories: source.categories,
        sharingScope: input.sharingScope ?? "company",
        forkedFromSkillId: source.id,
        forkedFromCompanyId: source.companyId,
        updatedAt: new Date(),
      })
      .where(and(eq(companySkills.id, forked.id), eq(companySkills.companyId, companyId)));
    await db
      .update(companySkills)
      .set({
        forkCount: sql`${companySkills.forkCount} + 1`,
        installCount: sql`${companySkills.installCount} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(companySkills.id, source.id), eq(companySkills.companyId, companyId)));
    await createVersion(companyId, forked.id, { label: "Initial version" }, actor);
    return getById(companyId, forked.id).then((skill) => {
      if (!skill) throw notFound("Forked skill not found");
      return skill;
    });
  }

  async function updateStatus(companyId: string, skillId: string): Promise<CompanySkillUpdateStatus | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;
    const audit = skill.sourceType === "catalog" || skill.sourceType === "local_path"
      ? await auditInstalledSkillBytes(skill)
      : null;
    const metadata = getSkillMeta(skill);
    const statusMeta = {
      installedHash: audit?.installedHash ?? asString(metadata.installedHash),
      originHash: audit?.originHash ?? asString(metadata.originHash),
      userModifiedAt: audit && audit.originHash && audit.installedHash !== audit.originHash
        ? asString(metadata.userModifiedAt) ?? audit.scannedAt
        : audit && audit.originHash
          ? null
        : asString(metadata.userModifiedAt),
      updateHoldReason: (audit?.verdict === "fail"
        ? "audit_hard_stop"
        : audit && audit.originHash && audit.installedHash !== audit.originHash
          ? "local_modifications"
          : audit && audit.originHash
            ? null
          : asString(metadata.updateHoldReason)) as CompanySkillUpdateHoldReason | null,
      auditVerdict: audit?.verdict ?? (asString(metadata.auditVerdict) as CompanySkillAuditVerdict | null),
      auditCodes: audit?.codes ?? (Array.isArray(metadata.auditCodes) ? metadata.auditCodes.map(String) : []),
    };

    if (skill.sourceType === "catalog") {
      const catalogId = asString(metadata.catalogId);
      if (!catalogId) {
        return {
          supported: false,
          reason: "This catalog skill does not have enough metadata to track updates.",
          trackingRef: null,
          currentRef: skill.sourceRef ?? statusMeta.originHash,
          latestRef: null,
          hasUpdate: false,
          ...statusMeta,
        };
      }
      const catalogSkill = resolveCatalogSkillIfPresent(catalogId);
      if (!catalogSkill) {
        return {
          supported: false,
          reason: "Catalog entry is no longer available in the shipped manifest.",
          trackingRef: catalogId,
          currentRef: skill.sourceRef ?? statusMeta.originHash,
          latestRef: null,
          hasUpdate: false,
          ...statusMeta,
        };
      }
      return {
        supported: true,
        reason: null,
        trackingRef: catalogSkill.id,
        currentRef: skill.sourceRef ?? statusMeta.originHash,
        latestRef: catalogSkill.contentHash,
        hasUpdate: catalogSkill.contentHash !== (skill.sourceRef ?? statusMeta.originHash),
        ...statusMeta,
      };
    }

    if (skill.sourceType !== "github" && skill.sourceType !== "skills_sh") {
      return {
        supported: false,
        reason: "Only GitHub-managed skills support update checks.",
        trackingRef: null,
        currentRef: skill.sourceRef ?? null,
        latestRef: null,
        hasUpdate: false,
        ...statusMeta,
      };
    }

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
        ...statusMeta,
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
      ...statusMeta,
    };
  }

  async function readFile(companyId: string, skillId: string, relativePath: string): Promise<CompanySkillFileDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;

    const normalizedPath = normalizePortablePath(relativePath || "SKILL.md");
    const fileEntry = skill.fileInventory.find((entry) => entry.path === normalizedPath);
    if (!fileEntry) {
      throw notFound("Skill file not found");
    }

    const source = deriveSkillSourceInfo(skill);
    let content = "";

    if (skill.sourceType === "local_path" || skill.sourceType === "catalog") {
      const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
      const diskContent = absolutePath
        ? await fs.readFile(absolutePath, "utf8").catch(() => null)
        : null;
      if (diskContent !== null) {
        content = diskContent;
      } else if (normalizedPath === "SKILL.md") {
        content = skill.markdown;
      } else {
        throw notFound("Skill file is unavailable: the skill source directory is missing.");
      }
    } else if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
      const metadata = getSkillMeta(skill);
      const owner = asString(metadata.owner);
      const repo = asString(metadata.repo);
      const hostname = asString(metadata.hostname) || "github.com";
      const ref = skill.sourceRef ?? asString(metadata.ref) ?? "main";
      const rawRepoSkillDir = typeof metadata.repoSkillDir === "string" ? metadata.repoSkillDir.trim() : null;
      // An explicit "."/"" repoSkillDir means SKILL.md lives at the repo root;
      // only fall back to the slug subdirectory when metadata is absent.
      const repoSkillDir = typeof metadata.repoSkillDir === "string"
        ? normalizeGitHubSkillDirectory(rawRepoSkillDir, "")
        : normalizeGitHubSkillDirectory(rawRepoSkillDir, skill.slug);
      if (!owner || !repo) {
        throw unprocessable("Skill source metadata is incomplete.");
      }
      const repoPath = normalizePortablePath(path.posix.join(repoSkillDir, normalizedPath));
      try {
        content = await fetchText(resolveRawGitHubUrl(hostname, owner, repo, ref, repoPath));
      } catch (error) {
        if (normalizedPath === "SKILL.md" && skill.markdown) {
          content = skill.markdown;
        } else {
          throw error;
        }
      }
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

  async function updateSkill(
    companyId: string,
    skillId: string,
    input: CompanySkillUpdateRequest = {},
  ): Promise<CompanySkill> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");

    const sharingScope = Object.prototype.hasOwnProperty.call(input, "sharingScope")
      ? normalizeMutableSharingScope(input.sharingScope)
      : null;
    const values: Partial<typeof companySkills.$inferInsert> = {
      updatedAt: new Date(),
    };

    if (Object.prototype.hasOwnProperty.call(input, "description")) {
      values.description = normalizeStoreText(input.description, 2000);
    }
    if (Object.prototype.hasOwnProperty.call(input, "iconUrl")) {
      values.iconUrl = normalizeStoreText(input.iconUrl, 2000);
    }
    if (Object.prototype.hasOwnProperty.call(input, "color")) {
      values.color = normalizeStoreText(input.color, 64);
    }
    if (Object.prototype.hasOwnProperty.call(input, "tagline")) {
      values.tagline = normalizeStoreText(input.tagline, 120);
    }
    if (Object.prototype.hasOwnProperty.call(input, "authorName")) {
      values.authorName = normalizeStoreText(input.authorName, 200);
    }
    if (Object.prototype.hasOwnProperty.call(input, "homepageUrl")) {
      values.homepageUrl = normalizeStoreText(input.homepageUrl, 2000);
    }
    if (Object.prototype.hasOwnProperty.call(input, "categories")) {
      values.categories = normalizeCategoryList(input.categories);
    }
    if (sharingScope) {
      values.sharingScope = sharingScope;
      values.publicShareToken = null;
    }

    const row = await db
      .update(companySkills)
      .set(values)
      .where(and(eq(companySkills.id, skillId), eq(companySkills.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Skill not found");
    return toCompanySkill(row);
  }

  async function createLocalSkill(
    companyId: string,
    input: CompanySkillCreateRequest,
    actor: SkillActor | null = null,
  ): Promise<CompanySkill> {
    const slug = normalizeSkillSlug(input.slug ?? input.name) ?? "skill";
    const key = `company/${companyId}/${slug}`;
    const existing = await getByKey(companyId, key);
    if (existing) {
      throw conflict(`A company skill with slug "${slug}" already exists.`);
    }

    const forkSource = input.forkedFromSkillId
      ? await getById(companyId, input.forkedFromSkillId)
      : null;
    if (input.forkedFromSkillId && !forkSource) {
      throw notFound("Fork source skill not found");
    }
    const sharingScope = normalizeMutableSharingScope(input.sharingScope) ?? "company";
    const managedRoot = resolveManagedSkillsRoot(companyId);
    const skillDir = path.resolve(managedRoot, slug);
    const skillFilePath = path.resolve(skillDir, "SKILL.md");

    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    if (forkSource) {
      for (const entry of forkSource.fileInventory) {
        const detail = await readFile(companyId, forkSource.id, entry.path);
        if (!detail) continue;
        const targetPath = path.resolve(skillDir, detail.path);
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, detail.content, "utf8");
      }
    }

    const fallbackMarkdown = [
        "---",
        `name: ${input.name}`,
        ...(input.description?.trim() ? [`description: ${input.description.trim()}`] : []),
        "---",
        "",
        `# ${input.name}`,
        "",
        input.description?.trim() ? input.description.trim() : "Describe what this skill does.",
        "",
      ].join("\n");
    const markdown = input.markdown?.trim().length
      ? input.markdown
      : forkSource?.markdown ?? fallbackMarkdown;

    await fs.writeFile(skillFilePath, markdown, "utf8");

    const inventory = forkSource
      ? await collectLocalSkillInventory(skillDir)
      : [{ path: "SKILL.md", kind: "skill" as const }];
    const parsed = parseFrontmatterMarkdown(markdown);
    const metadata = {
      sourceKind: "managed_local",
      ...(forkSource ? {
        forkedFromSkillId: forkSource.id,
        forkedFromCompanyId: forkSource.companyId,
        forkedByAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
        forkedByUserId: actor?.type === "user" ? actor.userId ?? null : null,
      } : {}),
    };
    const imported = await upsertImportedSkills(companyId, [{
      key,
      slug,
      name: asString(parsed.frontmatter.name) ?? input.name,
      description: asString(parsed.frontmatter.description) ?? input.description?.trim() ?? forkSource?.description ?? null,
      markdown,
      sourceType: "local_path",
      sourceLocator: skillDir,
      sourceRef: null,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: forkSource?.compatibility ?? "compatible",
      fileInventory: inventory,
      metadata,
    }]);

    const created = imported[0]!;
    const row = await db
      .update(companySkills)
      .set({
        iconUrl: normalizeStoreText(input.iconUrl, 2000) ?? forkSource?.iconUrl ?? created.iconUrl,
        color: normalizeStoreText(input.color, 64) ?? forkSource?.color ?? created.color,
        tagline: normalizeStoreText(input.tagline, 120) ?? forkSource?.tagline ?? created.tagline,
        authorName: normalizeStoreText(input.authorName, 200) ?? forkSource?.authorName ?? created.authorName,
        homepageUrl: normalizeStoreText(input.homepageUrl, 2000) ?? forkSource?.homepageUrl ?? created.homepageUrl,
        categories: input.categories ? normalizeCategoryList(input.categories) : forkSource?.categories ?? created.categories,
        sharingScope,
        forkedFromSkillId: forkSource?.id ?? null,
        forkedFromCompanyId: forkSource?.companyId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(companySkills.id, created.id), eq(companySkills.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (forkSource) {
      await db
        .update(companySkills)
        .set({
          forkCount: sql`${companySkills.forkCount} + 1`,
          installCount: sql`${companySkills.installCount} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(companySkills.id, forkSource.id), eq(companySkills.companyId, companyId)));
    }
    await createVersion(companyId, created.id, { label: "Initial version" }, actor);
    return (await getById(companyId, created.id)) ?? (row ? toCompanySkill(row) : created);
  }

  async function updateFile(
    companyId: string,
    skillId: string,
    relativePath: string,
    content: string,
    actor: SkillActor | null = null,
  ): Promise<CompanySkillFileDetail> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");

    const source = deriveSkillSourceInfo(skill);
    if (!source.editable || skill.sourceType !== "local_path") {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }

    const normalizedPath = normalizePortablePath(relativePath);
    const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
    if (!absolutePath) throw notFound("Skill file not found");

    const previousContent = await fs.readFile(absolutePath, "utf8").catch(() => null);
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
          ...readSkillStoreMetadata(parsed.frontmatter, skill.metadata),
          updatedAt: new Date(),
        })
        .where(eq(companySkills.id, skill.id));
    } else {
      await db
        .update(companySkills)
        .set({ updatedAt: new Date() })
        .where(eq(companySkills.id, skill.id));
    }

    if (previousContent !== content) {
      await createVersion(companyId, skillId, {}, actor);
    }

    const detail = await readFile(companyId, skillId, normalizedPath);
    if (!detail) throw notFound("Skill file not found");
    return detail;
  }

  async function installUpdate(companyId: string, skillId: string, options: { force?: boolean } = {}): Promise<CompanySkill | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;

    const status = await updateStatus(companyId, skillId);
    if (!status?.supported) {
      throw unprocessable(status?.reason ?? "This skill does not support updates.");
    }
    if (skill.sourceType === "catalog" || skill.sourceType === "local_path") {
      const audit = await auditInstalledSkillBytes(skill);
      await persistAuditMetadata(skill, audit);
      if (audit.verdict === "fail") {
        throw unprocessable("Skill update is blocked by hard-stop audit findings.", {
          updateHoldReason: "audit_hard_stop",
          audit,
        });
      }
      if (audit.originHash && audit.installedHash !== audit.originHash && !options.force) {
        throw unprocessable("Skill update is held because local modifications were detected; rerun with --force to discard them.", {
          updateHoldReason: "local_modifications",
          audit,
        });
      }
    }

    if (skill.sourceType === "catalog") {
      const catalogId = asString(getSkillMeta(skill).catalogId);
      if (!catalogId) {
        throw unprocessable("Catalog skill metadata is incomplete.");
      }
      const catalogSkill = resolveCatalogSkillIfPresent(catalogId);
      if (!catalogSkill) {
        throw unprocessable("Catalog entry is no longer available in the shipped manifest.", {
          updateHoldReason: "origin_unavailable",
        });
      }
      assertCatalogSkillInstallable(catalogSkill);
      const originSnapshotLocator = await materializeCatalogOriginSnapshot(companyId, catalogSkill, skill.slug);
      const snapshotSkill = {
        ...skill,
        sourceLocator: originSnapshotLocator,
        sourceRef: catalogSkill.contentHash,
        fileInventory: catalogSkill.files.map((entry) => ({ path: entry.path, kind: entry.kind })),
        metadata: {
          ...(isPlainRecord(skill.metadata) ? skill.metadata : {}),
          originHash: catalogSkill.contentHash,
        },
      };
      const candidateAudit = await auditInstalledSkillBytes(snapshotSkill);
      if (candidateAudit.verdict === "fail") {
        throw unprocessable("Catalog update is blocked by hard-stop audit findings.", {
          updateHoldReason: "audit_hard_stop",
          audit: candidateAudit,
        });
      }
      const materializedDir = path.resolve(
        resolveManagedSkillsRoot(companyId),
        "__catalog__",
        buildSkillRuntimeName(catalogSkill.key, skill.slug),
      );
      await copySkillDirectory(originSnapshotLocator, materializedDir);
      const markdown = await fs.readFile(path.join(originSnapshotLocator, catalogSkill.entrypoint), "utf8");
      const nextMetadata = buildCatalogSkillMetadata(catalogSkill, skill, originSnapshotLocator);
      const nextValues = {
        name: catalogSkill.name,
        description: catalogSkill.description,
        markdown,
        sourceLocator: materializedDir,
        sourceRef: catalogSkill.contentHash,
        trustLevel: catalogSkill.trustLevel,
        compatibility: catalogSkill.compatibility,
        fileInventory: serializeFileInventory(catalogSkill.files.map((entry) => ({
          path: entry.path,
          kind: entry.kind,
        }))),
        metadata: {
          ...nextMetadata,
          installedHash: catalogSkill.contentHash,
          userModifiedAt: null,
          updateHoldReason: null,
          auditVerdict: "pass",
          auditCodes: [],
          auditScannedAt: new Date().toISOString(),
          auditScanVersion: SKILL_AUDIT_SCAN_VERSION,
        },
        updatedAt: new Date(),
      };
      const row = await db
        .update(companySkills)
        .set(nextValues)
        .where(and(eq(companySkills.id, skill.id), eq(companySkills.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (!row) throw notFound("Skill not found");
      const updated = toCompanySkill(row);
      const postAudit = await auditInstalledSkillBytes(updated);
      if (postAudit.verdict === "fail") {
        await persistAuditMetadata(updated, postAudit);
        throw unprocessable("Catalog update produced hard-stop audit findings.", {
          updateHoldReason: "audit_hard_stop",
          audit: postAudit,
        });
      }
      return persistAuditMetadata(updated, postAudit);
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

  async function resetSkill(companyId: string, skillId: string, options: { force?: boolean } = {}): Promise<CompanySkill | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;
    if (skill.sourceType !== "catalog") {
      throw unprocessable("Only catalog-managed company skills support reset.");
    }

    const metadata = getSkillMeta(skill);
    const originHash = asString(metadata.originHash);
    const snapshotLocator = asString(metadata.originSnapshotLocator);
    const targetDir = normalizeSkillDirectory(skill);
    if (!originHash || !targetDir) {
      throw unprocessable("Catalog skill origin metadata is incomplete.", {
        updateHoldReason: "origin_unavailable",
      });
    }

    let sourceDir = snapshotLocator && (await statPath(path.join(snapshotLocator, "SKILL.md")))?.isFile()
      ? snapshotLocator
      : null;
    if (!sourceDir) {
      const catalogId = asString(metadata.catalogId);
      const catalogSkill = catalogId ? resolveCatalogSkillIfPresent(catalogId) : null;
      if (catalogSkill?.contentHash === originHash) {
        sourceDir = await materializeCatalogOriginSnapshot(companyId, catalogSkill, skill.slug);
      }
    }
    if (!sourceDir) {
      throw conflict("Pinned catalog origin bytes are unavailable; run skills update explicitly instead.", {
        updateHoldReason: "origin_unavailable",
      });
    }

    const originAudit = await auditInstalledSkillBytes({
      ...skill,
      sourceLocator: sourceDir,
      metadata: {
        ...(isPlainRecord(skill.metadata) ? skill.metadata : {}),
        originHash,
      },
    });
    if (originAudit.installedHash !== originHash || originAudit.verdict === "fail") {
      throw unprocessable("Pinned catalog origin failed audit and cannot be restored.", {
        updateHoldReason: originAudit.verdict === "fail" ? "audit_hard_stop" : "origin_unavailable",
        audit: originAudit,
      });
    }

    const preAudit = await auditInstalledSkillBytes(skill);
    await persistAuditMetadata(skill, preAudit);
    if (preAudit.installedHash !== originHash && !options.force) {
      throw unprocessable("Skill reset would discard local modifications; rerun with --force after confirming reset.", {
        updateHoldReason: "local_modifications",
        audit: preAudit,
      });
    }

    await copySkillDirectory(sourceDir, targetDir);
    const markdown = await fs.readFile(path.join(targetDir, "SKILL.md"), "utf8");
    const inventory = await collectLocalSkillInventory(targetDir);
    const trustLevel = deriveTrustLevel(inventory);
    const row = await db
      .update(companySkills)
      .set({
        markdown,
        sourceRef: originHash,
        trustLevel,
        compatibility: "compatible",
        fileInventory: serializeFileInventory(inventory),
        metadata: {
          ...(isPlainRecord(skill.metadata) ? skill.metadata : {}),
          originSnapshotLocator: sourceDir,
          installedHash: originHash,
          userModifiedAt: null,
          updateHoldReason: null,
          auditVerdict: "pass",
          auditCodes: [],
          auditScannedAt: new Date().toISOString(),
          auditScanVersion: SKILL_AUDIT_SCAN_VERSION,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(companySkills.id, skill.id), eq(companySkills.companyId, companyId)))
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Skill not found");
    const reset = toCompanySkill(row);
    const postAudit = await auditInstalledSkillBytes(reset);
    if (postAudit.installedHash !== originHash || postAudit.verdict === "fail") {
      await persistAuditMetadata(reset, postAudit);
      throw unprocessable("Catalog reset did not restore a passing pinned origin.", {
        updateHoldReason: postAudit.verdict === "fail" ? "audit_hard_stop" : "origin_unavailable",
        audit: postAudit,
      });
    }
    return persistAuditMetadata(reset, postAudit);
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

  async function createDirectoryReplacement(targetDir: string) {
    const parentDir = path.dirname(targetDir);
    const baseName = path.basename(targetDir);
    await fs.mkdir(parentDir, { recursive: true });
    const stagingDir = path.join(parentDir, `.${baseName}.tmp-${randomUUID()}`);
    const previousDir = path.join(parentDir, `.${baseName}.old-${randomUUID()}`);
    await fs.rm(stagingDir, { recursive: true, force: true });
    await fs.mkdir(stagingDir, { recursive: true });

    return {
      stagingDir,
      async commit() {
        let hasPrevious = false;
        try {
          await fs.rename(targetDir, previousDir);
          hasPrevious = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        try {
          await fs.rename(stagingDir, targetDir);
        } catch (error) {
          if (hasPrevious) {
            await fs.rename(previousDir, targetDir).catch(() => undefined);
          }
          throw error;
        }

        if (hasPrevious) {
          await fs.rm(previousDir, { recursive: true, force: true });
        }
      },
      async cleanup() {
        await fs.rm(stagingDir, { recursive: true, force: true });
      },
    };
  }

  async function materializeCatalogManifestSkillFiles(
    companyId: string,
    catalogSkill: CatalogSkill,
    slug: string,
  ) {
    const catalogRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__catalog__");
    const skillDir = path.resolve(catalogRoot, buildSkillRuntimeName(catalogSkill.key, slug));
    const replacement = await createDirectoryReplacement(skillDir);
    try {
      for (const entry of catalogSkill.files) {
        const targetPath = path.resolve(replacement.stagingDir, entry.path);
        if (targetPath !== replacement.stagingDir && !targetPath.startsWith(`${replacement.stagingDir}${path.sep}`)) {
          throw unprocessable(`Catalog file path is invalid: ${entry.path}`);
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await copyCatalogSkillFile(catalogSkill.id, entry.path, targetPath);
      }
      await replacement.commit();
    } catch (error) {
      await replacement.cleanup();
      throw error;
    }

    return skillDir;
  }

  async function materializeCatalogOriginSnapshot(
    companyId: string,
    catalogSkill: CatalogSkill,
    slug: string,
  ) {
    const originsRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__catalog_origins__");
    const snapshotDir = path.resolve(
      originsRoot,
      buildSkillRuntimeName(catalogSkill.key, slug),
      catalogSkill.contentHash.replace(/^sha256:/, ""),
    );
    const replacement = await createDirectoryReplacement(snapshotDir);
    try {
      for (const entry of catalogSkill.files) {
        const targetPath = path.resolve(replacement.stagingDir, entry.path);
        if (targetPath !== replacement.stagingDir && !targetPath.startsWith(`${replacement.stagingDir}${path.sep}`)) {
          throw unprocessable(`Catalog file path is invalid: ${entry.path}`);
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await copyCatalogSkillFile(catalogSkill.id, entry.path, targetPath);
      }
      await replacement.commit();
    } catch (error) {
      await replacement.cleanup();
      throw error;
    }

    return snapshotDir;
  }

  async function copySkillDirectory(sourceDir: string, targetDir: string) {
    const { files } = await collectSkillFileBytes(sourceDir);
    const replacement = await createDirectoryReplacement(targetDir);
    try {
      for (const file of files) {
        const targetPath = path.resolve(replacement.stagingDir, file.path);
        if (targetPath !== replacement.stagingDir && !targetPath.startsWith(`${replacement.stagingDir}${path.sep}`)) {
          throw unprocessable(`Skill file path is invalid: ${file.path}`);
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, file.bytes);
      }
      await replacement.commit();
    } catch (error) {
      await replacement.cleanup();
      throw error;
    }
  }

  function buildCatalogSkillMetadata(
    catalogSkill: CatalogSkill,
    existing: CompanySkill | null,
    originSnapshotLocator: string,
  ) {
    const packageMetadata = getCatalogPackageMetadata();
    const existingMetadata = existing && isPlainRecord(existing.metadata) ? existing.metadata : {};
    return {
      ...existingMetadata,
      skillKey: catalogSkill.key,
      sourceKind: "catalog",
      catalogId: catalogSkill.id,
      catalogKey: catalogSkill.key,
      catalogKind: catalogSkill.kind,
      catalogCategory: catalogSkill.category,
      catalogPath: catalogSkill.path,
      catalogSource: catalogSkill.source ?? null,
      packageName: packageMetadata.packageName,
      packageVersion: packageMetadata.packageVersion,
      originHash: catalogSkill.contentHash,
      originVersion: packageMetadata.packageVersion,
      originSnapshotLocator,
      userModifiedAt: existingMetadata.userModifiedAt ?? null,
      updateHoldReason: existingMetadata.updateHoldReason ?? null,
    };
  }

  function assertCatalogSkillInstallable(catalogSkill: CatalogSkill) {
    if (catalogSkill.compatibility !== "compatible") {
      throw unprocessable(`Catalog skill ${catalogSkill.id} is not compatible.`);
    }
  }

  async function auditCatalogSkillSnapshot(
    companyId: string,
    catalogSkill: CatalogSkill,
    slug: string,
    sourceDir: string,
  ) {
    return auditInstalledSkillBytes({
      id: randomUUID(),
      companyId,
      key: catalogSkill.key,
      slug,
      name: catalogSkill.name,
      description: catalogSkill.description,
      markdown: "",
      sourceType: "catalog",
      sourceLocator: sourceDir,
      sourceRef: catalogSkill.contentHash,
      trustLevel: catalogSkill.trustLevel,
      compatibility: catalogSkill.compatibility,
      fileInventory: catalogSkill.files.map((entry) => ({ path: entry.path, kind: entry.kind })),
      iconUrl: null,
      color: null,
      tagline: null,
      authorName: null,
      homepageUrl: null,
      categories: normalizeCategoryList([catalogSkill.category, ...catalogSkill.tags]),
      sharingScope: "company",
      publicShareToken: null,
      forkedFromSkillId: null,
      forkedFromCompanyId: null,
      starCount: 0,
      installCount: 0,
      forkCount: 0,
      currentVersionId: null,
      metadata: {
        sourceKind: "catalog",
        catalogId: catalogSkill.id,
        originHash: catalogSkill.contentHash,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async function installFromCatalog(
    companyId: string,
    input: CompanySkillInstallCatalogRequest,
  ): Promise<CompanySkillInstallCatalogResult> {
    await ensureSkillInventoryCurrent(companyId);
    const catalogSkill = getCatalogSkillOrThrow(input.catalogSkillId);
    assertCatalogSkillInstallable(catalogSkill);

    const slug = normalizeSkillSlug(input.slug ?? catalogSkill.slug);
    if (!slug) {
      throw unprocessable("Catalog skill slug is invalid.");
    }

    const existingSkills = await listFull(companyId);
    const existingByKey = existingSkills.find((skill) => skill.key === catalogSkill.key) ?? null;
    const slugConflict = existingSkills.find((skill) => skill.slug === slug && skill.id !== existingByKey?.id) ?? null;
    if (slugConflict) {
      throw conflict(`Skill slug "${slug}" is already used by ${slugConflict.key}.`);
    }

    if (existingByKey) {
      const metadata = getSkillMeta(existingByKey);
      const existingCatalogId = asString(metadata.catalogId);
      const sameCatalog = existingByKey.sourceType === "catalog" && existingCatalogId === catalogSkill.id;
      const catalogManaged = existingByKey.sourceType === "catalog";
      if (!sameCatalog && (!catalogManaged || !input.force)) {
        throw conflict(
          `Skill key "${catalogSkill.key}" is already used by ${existingByKey.sourceLocator ?? existingByKey.slug}.`,
        );
      }
      if (
        sameCatalog
        && existingByKey.slug === slug
        && asString(metadata.originHash) === catalogSkill.contentHash
      ) {
        const audit = await auditInstalledSkillBytes(existingByKey);
        const audited = await persistAuditMetadata(existingByKey, audit);
        if (audit.installedHash === catalogSkill.contentHash && audit.verdict !== "fail") {
          return {
            action: "unchanged",
            skill: audited,
            catalogSkill,
            warnings: audit.findings.map((finding) => finding.message),
          };
        }
        if (!input.force) {
          const holdReason = audit.verdict === "fail" ? "audit_hard_stop" : "local_modifications";
          const message = audit.verdict === "fail"
            ? "Catalog skill has hard-stop audit findings; rerun with --force to replace it."
            : "Catalog skill has local modifications; rerun with --force to replace it.";
          throw unprocessable(message, {
            updateHoldReason: holdReason,
            audit,
          });
        }
      }
    }

    let materializedDir: string | null = null;
    let originSnapshotLocator: string | null = null;
    let candidateMaterializedDir: string | null = null;
    try {
      originSnapshotLocator = await materializeCatalogOriginSnapshot(companyId, catalogSkill, slug);
      const candidateAudit = await auditCatalogSkillSnapshot(companyId, catalogSkill, slug, originSnapshotLocator);
      if (candidateAudit.verdict === "fail") {
        throw unprocessable("Catalog install is blocked by hard-stop audit findings.", {
          updateHoldReason: "audit_hard_stop",
          audit: candidateAudit,
        });
      }
      candidateMaterializedDir = await materializeCatalogManifestSkillFiles(companyId, catalogSkill, slug);
      materializedDir = candidateMaterializedDir;
    } catch (error) {
      if (candidateMaterializedDir) {
        await fs.rm(candidateMaterializedDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (originSnapshotLocator) await fs.rm(originSnapshotLocator, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    if (!materializedDir || !originSnapshotLocator) {
      throw unprocessable("Catalog install did not materialize pinned files.");
    }
    const markdown = await fs.readFile(path.join(originSnapshotLocator, catalogSkill.entrypoint), "utf8");
    const metadata = buildCatalogSkillMetadata(catalogSkill, existingByKey, originSnapshotLocator);
    const parsed = parseFrontmatterMarkdown(markdown);
    const storeMetadata = readSkillStoreMetadata(parsed.frontmatter, {
      ...metadata,
      categories: [catalogSkill.category, ...catalogSkill.tags],
    });
    const values = {
      companyId,
      key: catalogSkill.key,
      slug,
      name: catalogSkill.name,
      description: catalogSkill.description,
      markdown,
      sourceType: "catalog",
      sourceLocator: materializedDir,
      sourceRef: catalogSkill.contentHash,
      trustLevel: catalogSkill.trustLevel,
      compatibility: catalogSkill.compatibility,
      fileInventory: serializeFileInventory(catalogSkill.files.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
      }))),
      iconUrl: storeMetadata.iconUrl ?? existingByKey?.iconUrl ?? null,
      color: storeMetadata.color ?? existingByKey?.color ?? null,
      tagline: storeMetadata.tagline ?? existingByKey?.tagline ?? catalogSkill.description.slice(0, 120),
      authorName: storeMetadata.authorName ?? existingByKey?.authorName ?? "Paperclip",
      homepageUrl: storeMetadata.homepageUrl ?? existingByKey?.homepageUrl ?? catalogSkill.source?.url ?? null,
      categories: storeMetadata.categories.length > 0 ? storeMetadata.categories : normalizeCategoryList([catalogSkill.category, ...catalogSkill.tags]),
      sharingScope: existingByKey?.sharingScope ?? "company",
      installCount: existingByKey?.installCount ?? 1,
      metadata,
      updatedAt: new Date(),
    };

    const row = existingByKey
      ? await db
        .update(companySkills)
        .set(values)
        .where(eq(companySkills.id, existingByKey.id))
        .returning()
        .then((rows) => rows[0] ?? null)
      : await db
        .insert(companySkills)
        .values(values)
        .returning()
        .then((rows) => rows[0] ?? null);

    if (!row) throw notFound("Failed to persist company skill");
    const installed = toCompanySkill(row);
    const postAudit = await auditInstalledSkillBytes(installed);
    if (postAudit.verdict === "fail") {
      await persistAuditMetadata(installed, postAudit);
      throw unprocessable("Catalog install produced hard-stop audit findings.", {
        updateHoldReason: "audit_hard_stop",
        audit: postAudit,
      });
    }
    const audited = await persistAuditMetadata(installed, postAudit);
    return {
      action: existingByKey ? "updated" : "created",
      skill: audited,
      catalogSkill,
      warnings: postAudit.findings.map((finding) => finding.message),
    };
  }

  async function materializeRuntimeSkillFiles(companyId: string, skill: CompanySkill) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__runtime__");
    const skillDir = path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    let wroteSkillFile = false;
    for (const entry of skill.fileInventory) {
      const normalizedPath = normalizePortablePath(entry.path);
      const detail = await readFile(companyId, skill.id, normalizedPath).catch(() => null);
      const content = detail?.content ?? (normalizedPath === "SKILL.md" ? skill.markdown : null);
      if (content === null) continue;
      const targetPath = path.resolve(skillDir, entry.path);
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, content, "utf8");
      if (normalizedPath === "SKILL.md") wroteSkillFile = true;
    }

    if (!wroteSkillFile) {
      await fs.rm(skillDir, { recursive: true, force: true });
      throw unprocessable("Company skill could not be materialized because its stored SKILL.md copy is missing.");
    }

    return skillDir;
  }

  function resolveVersionSnapshotPath(skillDir: string, relativePath: string) {
    const normalizedPath = normalizePortablePath(relativePath);
    if (!normalizedPath) return null;
    const targetPath = path.resolve(skillDir, normalizedPath);
    if (targetPath !== skillDir && !targetPath.startsWith(`${skillDir}${path.sep}`)) {
      throw unprocessable(`Skill version file path is invalid: ${relativePath}`);
    }
    return { normalizedPath, targetPath };
  }

  async function listMaterializedFiles(root: string): Promise<string[] | null> {
    async function walk(dir: string, base: string): Promise<string[]> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        const relativePath = base ? path.posix.join(base, entry.name) : entry.name;
        const absolutePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...await walk(absolutePath, relativePath));
        } else if (entry.isFile()) {
          out.push(normalizePortablePath(relativePath));
        } else {
          out.push(normalizePortablePath(relativePath));
        }
      }
      return out;
    }

    try {
      return await walk(root, "");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async function materializedVersionSnapshotMatches(skillDir: string, version: CompanySkillVersion) {
    const expected = new Map<string, string>();
    let sawSkillFile = false;
    for (const entry of version.fileInventory) {
      const resolved = resolveVersionSnapshotPath(skillDir, entry.path);
      if (!resolved) continue;
      expected.set(resolved.normalizedPath, entry.content);
      if (resolved.normalizedPath === "SKILL.md") sawSkillFile = true;
    }
    if (!sawSkillFile) {
      throw unprocessable("Company skill version could not be materialized because its SKILL.md snapshot is missing.");
    }

    const existingFiles = await listMaterializedFiles(skillDir);
    if (!existingFiles || existingFiles.length !== expected.size) return false;
    for (const relativePath of existingFiles) {
      if (!expected.has(relativePath)) return false;
    }
    for (const [relativePath, content] of expected.entries()) {
      const existingContent = await fs.readFile(path.resolve(skillDir, relativePath), "utf8").catch(() => null);
      if (existingContent !== content) return false;
    }
    return true;
  }

  async function materializeVersionSnapshot(companyId: string, skill: CompanySkill, version: CompanySkillVersion) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__versions__");
    const skillDir = path.resolve(runtimeRoot, skill.id, version.id);
    if (await materializedVersionSnapshotMatches(skillDir, version)) {
      return skillDir;
    }
    await fs.rm(skillDir, { recursive: true, force: true });
    await fs.mkdir(skillDir, { recursive: true });

    let wroteSkillFile = false;
    for (const entry of version.fileInventory) {
      const resolved = resolveVersionSnapshotPath(skillDir, entry.path);
      if (!resolved) continue;
      const { normalizedPath, targetPath } = resolved;
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, entry.content, "utf8");
      if (normalizedPath === "SKILL.md") wroteSkillFile = true;
    }

    if (!wroteSkillFile) {
      await fs.rm(skillDir, { recursive: true, force: true });
      throw unprocessable("Company skill version could not be materialized because its SKILL.md snapshot is missing.");
    }

    return skillDir;
  }

  function resolveRuntimeSkillMaterializedPath(companyId: string, skill: Pick<CompanySkill, "key" | "slug">) {
    const runtimeRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__runtime__");
    return path.resolve(runtimeRoot, buildSkillRuntimeName(skill.key, skill.slug));
  }

  async function resolveRuntimeSkillSource(
    companyId: string,
    skill: CompanySkill,
    options: RuntimeSkillEntryOptions,
  ): Promise<RuntimeSkillSourceResolution | null> {
    const selectedVersionId = options.versionSelections?.get(skill.key) ?? null;
    if (selectedVersionId) {
      const version = await getVersion(companyId, skill.id, selectedVersionId);
      if (!version) {
        return {
          status: "missing",
          source: path.resolve(resolveManagedSkillsRoot(companyId), "__versions__", skill.id, selectedVersionId),
          detail: "The selected skill version no longer exists.",
        };
      }
      const versionSource = await materializeVersionSnapshot(companyId, skill, version).catch(() => null);
      return versionSource ? { status: "available", source: versionSource } : null;
    }

    const source = await resolveExistingSkillDirectory(normalizeSkillDirectory(skill));
    if (source) return { status: "available", source };

    if (options.materializeMissing === false) {
      const materializedPath = resolveRuntimeSkillMaterializedPath(companyId, skill);
      const materializedSource = await resolveExistingSkillDirectory(materializedPath);
      if (materializedSource) return { status: "available", source: materializedSource };
      return {
        status: "missing",
        source: materializedPath,
        detail: buildMissingRuntimeSourceDetail(skill),
      };
    }

    const materializedSource = await materializeRuntimeSkillFiles(companyId, skill).catch(() => null);
    return materializedSource ? { status: "available", source: materializedSource } : null;
  }

  async function listRuntimeSkillEntries(
    companyId: string,
    options: RuntimeSkillEntryOptions = {},
  ): Promise<PaperclipSkillEntry[]> {
    const skills = await listFull(companyId);

    const out: PaperclipSkillEntry[] = [];
    for (const skill of skills) {
      const sourceResolution = await resolveRuntimeSkillSource(companyId, skill, options);
      if (!sourceResolution) continue;

      out.push({
        key: skill.key,
        runtimeName: buildSkillRuntimeName(skill.key, skill.slug),
        source: sourceResolution.source,
        versionId: options.versionSelections?.get(skill.key) ?? null,
        currentVersionId: skill.currentVersionId,
        sourceStatus: sourceResolution.status,
        missingDetail: sourceResolution.status === "missing" ? sourceResolution.detail : null,
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
      assertImportedSkillKeyAllowed(skill);
      assertImportedSkillSourceAllowed(skill);
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
      const parsed = parseFrontmatterMarkdown(skill.markdown);
      const storeMetadata = readSkillStoreMetadata(parsed.frontmatter, metadata);
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
        iconUrl: storeMetadata.iconUrl ?? existing?.iconUrl ?? null,
        color: storeMetadata.color ?? existing?.color ?? null,
        tagline: storeMetadata.tagline ?? existing?.tagline ?? null,
        authorName: storeMetadata.authorName ?? existing?.authorName ?? null,
        homepageUrl: storeMetadata.homepageUrl ?? existing?.homepageUrl ?? null,
        categories: storeMetadata.categories.length > 0 ? storeMetadata.categories : existing?.categories ?? [],
        sharingScope: existing?.sharingScope ?? "company",
        installCount: existing?.installCount ?? 1,
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
    resolveRequestedSkillEntries: async (companyId: string, requestedSelections: Array<string | AgentDesiredSkillEntry>) => {
      const skills = await listFull(companyId);
      return resolveRequestedSkillEntriesOrThrow(db, companyId, skills, requestedSelections);
    },
    categoryCounts,
    detail,
    listVersions,
    getVersion,
    createVersion,
    starSkill,
    unstarSkill,
    listComments,
    createComment,
    updateComment,
    deleteComment,
    forkSkill,
    updateStatus,
    readFile,
    updateSkill,
    updateFile,
    createLocalSkill,
    deleteSkill,
    importFromSource,
    installFromCatalog,
    scanProjectWorkspaces,
    importPackageFiles,
    auditSkill,
    installUpdate,
    resetSkill,
    listRuntimeSkillEntries,
  };
}
