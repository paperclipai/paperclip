import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents as agentsTable,
  assets,
  authUsers,
  companies,
  companySkillComments,
  companySkillStars,
  companySkillTestInputs,
  companySkillTestRunTemplates,
  companySkillTestRuns,
  companySkillVersions,
  companySkills,
  costEvents,
  documents,
  issueAttachments,
  issueDocuments,
  issues,
  issueThreadInteractions,
  issueWorkProducts,
} from "@paperclipai/db";
import { readPaperclipSkillSyncPreference, writePaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
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
  CompanySkillFileDeleteRequest,
  CompanySkillFileDeleteResult,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillForkPrecheckResult,
  CompanySkillForkRequest,
  CompanySkillForkResult,
  CompanySkillForkReassignment,
  CompanySkillForkSummary,
  CompanySkillImportResult,
  CompanySkillInstallCatalogRequest,
  CompanySkillInstallCatalogResult,
  CompanySkillListQuery,
  CompanySkillListItem,
  CompanySkillLastEditor,
  CompanySkillOriginalSummary,
  CompanySkillProjectScanConflict,
  CompanySkillProjectScanCandidate,
  CompanySkillProjectScanRequest,
  CompanySkillProjectScanResult,
  CompanySkillProjectScanSkipped,
  CompanySkillSharingScope,
  CompanySkillSourceBadge,
  CompanySkillSourceType,
  CompanySkillTestInput,
  CompanySkillTestInputCreateRequest,
  CompanySkillTestInputUpdateRequest,
  CompanySkillTestRun,
  CompanySkillTestRunCreateRequest,
  CompanySkillTestRunDetail,
  CompanySkillTestRunHarnessContent,
  CompanySkillTestRunListQuery,
  CompanySkillTestRunTemplate,
  CompanySkillTestRunTemplateCreateRequest,
  CompanySkillTestRunTemplateSnapshot,
  CompanySkillTestRunTemplateUpdateRequest,
  CompanySkillTestRunStatus,
  CompanySkillTrustLevel,
  CompanySkillUpdateRequest,
  CompanySkillUpdateStatus,
  CompanySkillUpdateHoldReason,
  CompanySkillUsageAgent,
  CompanySkillVersion,
  CompanySkillVersionCreateRequest,
  CompanySkillVersionFileInventoryEntry,
  IssueAttachment,
  IssueDocument,
} from "@paperclipai/shared";
import { isUuidLike, normalizeAgentUrlKey, parseFrontmatterMarkdown } from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import { agentService } from "./agents.js";
import { issueDocumentSelect, mapIssueDocumentRow } from "./documents.js";
import { toIssueWorkProduct } from "./work-products.js";
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
type CompanySkillTestInputRow = typeof companySkillTestInputs.$inferSelect;
type CompanySkillTestRunTemplateRow = typeof companySkillTestRunTemplates.$inferSelect;
type CompanySkillTestRunRow = typeof companySkillTestRuns.$inferSelect;
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

type ImportedSkillPersistValues = Pick<
  CompanySkill,
  | "companyId"
  | "key"
  | "slug"
  | "name"
  | "description"
  | "markdown"
  | "sourceType"
  | "sourceLocator"
  | "sourceRef"
  | "trustLevel"
  | "compatibility"
  | "iconUrl"
  | "color"
  | "tagline"
  | "authorName"
  | "homepageUrl"
  | "categories"
  | "sharingScope"
  | "installCount"
> & {
  fileInventory: Array<Record<string, unknown>>;
  metadata: Record<string, unknown>;
  updatedAt: Date;
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
  forkedByAgentId?: string | null;
  forkedByUserId?: string | null;
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

type PlannedSkillReassignment = {
  agentId: string;
  reassignment: CompanySkillForkReassignment;
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
  ".codex/skills",
  ".codebuddy/skills",
  ".commandcode/skills",
  ".continue/skills",
  ".cursor/skills",
  ".cortex/skills",
  ".crush/skills",
  ".factory/skills",
  ".goose/skills",
  ".gemini/skills",
  ".junie/skills",
  ".iflow/skills",
  ".kilocode/skills",
  ".kiro/skills",
  ".kode/skills",
  ".mcpjam/skills",
  ".vibe/skills",
  ".mux/skills",
  ".openhands/skills",
  ".opencode/skills",
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
  const url = parseRemoteSkillImportUrl(rawUrl);
  if (url.protocol !== "https:") {
    throw unprocessable("GitHub source URL must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw unprocessable("Remote skill source URLs cannot include credentials, query parameters, or fragments.");
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

function parseRemoteSkillImportUrl(rawUrl: string) {
  try {
    return new URL(rawUrl);
  } catch {
    throw unprocessable("Invalid remote skill source URL.");
  }
}

function normalizeRemoteSkillImportSource(rawUrl: string) {
  const url = parseRemoteSkillImportUrl(rawUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw unprocessable("Remote skill source URLs cannot include credentials, query parameters, or fragments.");
  }
  if (isGitRepoSkillImportSource(rawUrl)) {
    const hostname = url.hostname.toLowerCase() === "www.github.com" ? "github.com" : url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const owner = segments[0]!.toLowerCase();
      const repo = segments[1]!.replace(/\.git$/i, "").toLowerCase();
      const suffix = segments.slice(2).join("/");
      return `https://${hostname}/${owner}/${repo}${suffix ? `/${suffix}` : ""}`;
    }
  }
  return url.toString();
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
  const normalizedRemoteSource = /^https?:\/\//i.test(normalizedSource)
    ? normalizeRemoteSkillImportSource(normalizedSource)
    : null;
  const canonicalSource = normalizedRemoteSource ?? normalizedSource;

  // Key-style imports (org/repo/skill) originate from the skills.sh registry
  if (!/^https?:\/\//i.test(canonicalSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(canonicalSource)) {
    const [owner, repo, skillSlugRaw] = canonicalSource.split("/");
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: normalizeSkillSlug(skillSlugRaw),
      originalSkillsShUrl: `https://skills.sh/${owner}/${repo}/${skillSlugRaw}`,
      warnings,
    };
  }

  if (!/^https?:\/\//i.test(canonicalSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(canonicalSource)) {
    return {
      resolvedSource: `https://github.com/${canonicalSource}`,
      requestedSkillSlug,
      originalSkillsShUrl: null,
      warnings,
    };
  }

  // Detect skills.sh URLs and resolve to GitHub: https://skills.sh/org/repo/skill → org/repo/skill key
  const skillsShMatch = canonicalSource.match(/^https?:\/\/(?:www\.)?skills\.sh\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?$/i);
  if (skillsShMatch) {
    const [, owner, repo, skillSlugRaw] = skillsShMatch;
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: skillSlugRaw ? normalizeSkillSlug(skillSlugRaw) : requestedSkillSlug,
      originalSkillsShUrl: canonicalSource,
      warnings,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(canonicalSource) && !/^https:\/\//i.test(canonicalSource)) {
    throw unprocessable("Remote skill sources must use HTTPS", {
      code: "skill_source_validation_failed",
    });
  }

  return {
    resolvedSource: canonicalSource,
    requestedSkillSlug,
    originalSkillsShUrl: null,
    warnings,
  };
}

export function isGitRepoSkillImportSource(source: string) {
  try {
    const parsed = new URL(source.trim());
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.endsWith(".githubusercontent.com") || hostname === "gist.github.com") return false;
    const segments = parsed.pathname.split("/").filter(Boolean);
    return segments.length >= 2 && !parsed.pathname.endsWith(".md");
  } catch {
    return false;
  }
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

function pathIsContained(rootPath: string, candidatePath: string) {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`));
}

async function assertNoSymlinksInLocalTree(currentPath: string): Promise<void> {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolutePath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw unprocessable(`Project skill candidate contains a symbolic link at ${absolutePath}.`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinksInLocalTree(absolutePath);
    }
  }
}

async function validateProjectSkillImportPath(
  skillDir: string,
  workspaceRoot: string,
  inventoryMode: LocalSkillInventoryMode,
) {
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const resolvedSkillDir = path.resolve(skillDir);
  if (!pathIsContained(resolvedWorkspaceRoot, resolvedSkillDir)) {
    throw unprocessable(`Project skill candidate ${resolvedSkillDir} is outside workspace root ${resolvedWorkspaceRoot}.`);
  }

  const canonicalWorkspaceRoot = await fs.realpath(resolvedWorkspaceRoot);
  let currentPath = resolvedWorkspaceRoot;
  const relativeSkillDir = path.relative(resolvedWorkspaceRoot, resolvedSkillDir);
  for (const segment of relativeSkillDir.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const segmentStat = await fs.lstat(currentPath);
    if (segmentStat.isSymbolicLink()) {
      throw unprocessable(`Project skill candidate contains a symbolic link at ${currentPath}.`);
    }
  }

  const canonicalSkillDir = await fs.realpath(resolvedSkillDir);
  if (!pathIsContained(canonicalWorkspaceRoot, canonicalSkillDir)) {
    throw unprocessable(`Project skill candidate ${resolvedSkillDir} resolves outside workspace root ${resolvedWorkspaceRoot}.`);
  }

  const skillFilePath = path.join(resolvedSkillDir, "SKILL.md");
  const skillFileStat = await fs.lstat(skillFilePath);
  if (skillFileStat.isSymbolicLink()) {
    throw unprocessable(`Project skill candidate contains a symbolic link at ${skillFilePath}.`);
  }
  if (!skillFileStat.isFile()) {
    throw unprocessable(`No SKILL.md file was found in ${resolvedSkillDir}.`);
  }
  const canonicalSkillFilePath = await fs.realpath(skillFilePath);
  if (!pathIsContained(canonicalWorkspaceRoot, canonicalSkillFilePath)) {
    throw unprocessable(`Project skill file ${skillFilePath} resolves outside workspace root ${resolvedWorkspaceRoot}.`);
  }

  if (inventoryMode === "full") {
    await assertNoSymlinksInLocalTree(resolvedSkillDir);
    return;
  }
  for (const relativeDir of PROJECT_ROOT_SKILL_SUBDIRECTORIES) {
    const absoluteDir = path.join(resolvedSkillDir, relativeDir);
    const dirStat = await fs.lstat(absoluteDir).catch(() => null);
    if (!dirStat) continue;
    if (dirStat.isSymbolicLink()) {
      throw unprocessable(`Project skill candidate contains a symbolic link at ${absoluteDir}.`);
    }
    if (dirStat.isDirectory()) {
      await assertNoSymlinksInLocalTree(absoluteDir);
    }
  }
}

function projectSkillImportFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("symbolic link")) {
    return "Skipped because symbolic links can point outside the project workspace. Replace the link with a real file or directory to import this skill.";
  }
  if (message.includes("outside workspace root")) return "Project skill candidate resolves outside the workspace.";
  if (message.includes("No SKILL.md file")) return "Project skill candidate does not contain a readable SKILL.md file.";
  return "Project skill candidate could not be read.";
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

function stableJsonComparable(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonComparable(entry) ?? null);
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const normalized = stableJsonComparable(value[key]);
      if (normalized !== undefined) out[key] = normalized ?? null;
    }
    return out;
  }
  return value;
}

function stableJsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(stableJsonComparable(left)) === JSON.stringify(stableJsonComparable(right));
}

function isPaperclipBundledSkillKey(key: string) {
  return key.startsWith("paperclipai/paperclip/");
}

function stripDerivedPaperclipBundledMetadata(key: string, metadata: unknown): unknown {
  if (metadata === null || metadata === undefined) return {};
  const comparable = stableJsonComparable(metadata);
  if (!isPlainRecord(comparable)) return comparable;

  const out = { ...comparable };
  if (out.skillKey === key) delete out.skillKey;
  if (out.sourceKind === "paperclip_bundled") delete out.sourceKind;
  delete out.missingSource;
  return out;
}

function importedSkillMetadataEqual(existing: CompanySkill, values: ImportedSkillPersistValues) {
  const incomingMetadata = isPlainRecord(values.metadata) ? values.metadata : null;
  if (isPaperclipBundledSkillKey(values.key) && asString(incomingMetadata?.sourceKind) === "paperclip_bundled") {
    return JSON.stringify(stripDerivedPaperclipBundledMetadata(existing.key, existing.metadata))
      === JSON.stringify(stripDerivedPaperclipBundledMetadata(values.key, values.metadata));
  }
  return stableJsonEqual(existing.metadata ?? null, values.metadata);
}

function stringArraysEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => entry === right[index]);
}

function importedSkillPersistValuesMatchExisting(
  existing: CompanySkill,
  values: ImportedSkillPersistValues,
) {
  return existing.companyId === values.companyId
    && existing.key === values.key
    && existing.slug === values.slug
    && existing.name === values.name
    && existing.description === values.description
    && existing.markdown === values.markdown
    && existing.sourceType === values.sourceType
    && existing.sourceLocator === values.sourceLocator
    && existing.sourceRef === values.sourceRef
    && existing.trustLevel === values.trustLevel
    && existing.compatibility === values.compatibility
    && inventoryEntriesEqual(
      existing.fileInventory,
      normalizeFileInventory({ fileInventory: values.fileInventory }),
    )
    && existing.iconUrl === values.iconUrl
    && existing.color === values.color
    && existing.tagline === values.tagline
    && existing.authorName === values.authorName
    && existing.homepageUrl === values.homepageUrl
    && stringArraysEqual(existing.categories, normalizeCategoryList(values.categories))
    && existing.sharingScope === values.sharingScope
    && existing.installCount === values.installCount
    && importedSkillMetadataEqual(existing, values);
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
    workspaceRoot?: string;
  },
): Promise<ImportedSkill> {
  const resolvedSkillDir = path.resolve(skillDir);
  const inventoryMode = options?.inventoryMode ?? "full";
  if (options?.workspaceRoot) {
    await validateProjectSkillImportPath(resolvedSkillDir, options.workspaceRoot, inventoryMode);
  }
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
  const inventory = await collectLocalSkillInventory(resolvedSkillDir, inventoryMode);

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
  directoryRoot: string;
  relativePath: string;
  inventoryMode: LocalSkillInventoryMode;
}>> {
  const discovered = new Map<string, {
    directoryRoot: string;
    relativePath: string;
    inventoryMode: LocalSkillInventoryMode;
  }>();
  const rootSkillPath = path.join(target.workspaceCwd, "SKILL.md");
  if ((await statPath(rootSkillPath))?.isFile()) {
    discovered.set(path.resolve(target.workspaceCwd), {
      directoryRoot: ".",
      relativePath: ".",
      inventoryMode: "project_root",
    });
  }

  for (const relativeRoot of PROJECT_SCAN_DIRECTORY_ROOTS) {
    const absoluteRoot = path.join(target.workspaceCwd, relativeRoot);
    const rootStat = await statPath(absoluteRoot);
    if (!rootStat?.isDirectory()) continue;

    const entries = await fs.readdir(absoluteRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absoluteSkillDir = path.resolve(absoluteRoot, entry.name);
      const entryStat = entry.isSymbolicLink() ? await statPath(absoluteSkillDir) : null;
      if (!entry.isDirectory() && !entryStat?.isDirectory()) continue;
      if (!(await statPath(path.join(absoluteSkillDir, "SKILL.md")))?.isFile()) continue;
      discovered.set(absoluteSkillDir, {
        directoryRoot: relativeRoot,
        relativePath: normalizePortablePath(path.relative(target.workspaceCwd, absoluteSkillDir)),
        inventoryMode: "full",
      });
    }
  }

  return Array.from(discovered.entries())
    .map(([skillDir, details]) => ({ skillDir, ...details }))
    .sort((left, right) => left.skillDir.localeCompare(right.skillDir));
}

function normalizeProjectScanSelectionPath(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed === ".") return ".";
  if (!trimmed || trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed)) return null;
  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function projectScanSelectionKey(workspaceId: string, relativePath: string) {
  return `${workspaceId}\u0000${relativePath}`;
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
  const looksLikeRepoUrl = isGitRepoSkillImportSource(url);
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

function normalizeCategoryName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function categoryLookupKey(value: string) {
  return value.toLocaleLowerCase();
}

function normalizeCategoryList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const value of values) {
    const category = normalizeCategoryName(value);
    if (!category) continue;
    const key = categoryLookupKey(category);
    if (seen.has(key)) continue;
    seen.add(key);
    categories.push(category);
  }
  return categories;
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

function toCompanySkillTestInput(row: CompanySkillTestInputRow): CompanySkillTestInput {
  return {
    ...row,
    deletedAt: row.deletedAt ?? null,
  };
}

const BUILT_IN_SKILL_TEST_RUN_TEMPLATE_ID = "built-in:default-test-template";
const BUILT_IN_SKILL_TEST_RUN_TEMPLATE_DATE = new Date("2026-01-01T00:00:00.000Z");
const BUILT_IN_SKILL_TEST_RUN_TEMPLATE_BODY = [
  "You are running a Skills Studio test for `{{skillName}}` (`{{skillKey}}`), skill version v{{skillVersion}}.",
  "",
  "Invoke and use the selected skill under test: `{{skillInvocation}}`. Use the pinned skill revision supplied by Paperclip as the source of truth, regardless of any other runtime skills.",
  "",
  "This is a test run. Do not make durable changes outside this test task. Do not mutate unrelated issues, push, publish, send external messages, or affect real work.",
  "",
  "If the skill would create documents, images, videos, files, or other assets, create test versions in an obviously test-scoped location when applicable, then post the results back to this task as issue documents, attachments, or work products.",
  "",
  "Write the final result to issue document `{{outputDocumentKey}}`, then mark this test task done.",
].join("\n");

function builtInSkillTestRunTemplate(companyId: string): CompanySkillTestRunTemplate {
  return {
    id: BUILT_IN_SKILL_TEST_RUN_TEMPLATE_ID,
    companyId,
    name: "Default test template",
    description: "Paperclip's read-only default harness instructions for Skills Studio runs.",
    body: BUILT_IN_SKILL_TEST_RUN_TEMPLATE_BODY,
    builtIn: true,
    createdByAgentId: null,
    createdByUserId: null,
    updatedByAgentId: null,
    updatedByUserId: null,
    deletedAt: null,
    createdAt: BUILT_IN_SKILL_TEST_RUN_TEMPLATE_DATE,
    updatedAt: BUILT_IN_SKILL_TEST_RUN_TEMPLATE_DATE,
  };
}

function toCompanySkillTestRunTemplate(row: CompanySkillTestRunTemplateRow): CompanySkillTestRunTemplate {
  return {
    ...row,
    description: row.description ?? null,
    builtIn: false,
    createdByAgentId: row.createdByAgentId ?? null,
    createdByUserId: row.createdByUserId ?? null,
    updatedByAgentId: row.updatedByAgentId ?? null,
    updatedByUserId: row.updatedByUserId ?? null,
    deletedAt: row.deletedAt ?? null,
  };
}

const ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS = new Set([
  "skillName",
  "skillKey",
  "skillInvocation",
  "skillVersion",
  "runId",
  "issueId",
  "outputDocumentKey",
]);

function validateSkillTestTemplatePlaceholders(body: string) {
  const unknown = new Set<string>();
  const recognized = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
  for (const match of body.matchAll(recognized)) {
    const key = match[1] ?? "";
    if (!ALLOWED_SKILL_TEST_TEMPLATE_PLACEHOLDERS.has(key)) {
      unknown.add(key);
    }
  }
  if (body.replace(recognized, "").includes("{{") || body.replace(recognized, "").includes("}}")) {
    throw unprocessable("Malformed template placeholder. Use explicit placeholders like {{skillName}}.");
  }
  if (unknown.size > 0) {
    throw unprocessable(`Unknown template placeholder${unknown.size === 1 ? "" : "s"}: ${Array.from(unknown).sort().join(", ")}`);
  }
}

function renderSkillTestTemplate(body: string, values: Record<string, string>) {
  validateSkillTestTemplatePlaceholders(body);
  return body.replace(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g, (_match, rawKey: string) => values[rawKey] ?? "");
}

function buildHarnessIssueDescription(inputSnapshot: string, renderedTemplateBody: string | null) {
  const trimmedInput = inputSnapshot.trim();
  const trimmedTemplate = renderedTemplateBody?.trim() ?? "";
  return trimmedTemplate ? `${trimmedInput}\n\n---\n\n${trimmedTemplate}` : trimmedInput;
}

function normalizeTestRunStatus(value: string): CompanySkillTestRunStatus {
  return value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
    ? value
    : "queued";
}

function emptyTestRunCost() {
  return {
    costCents: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
}

function toCompanySkillTestRun(
  row: CompanySkillTestRunRow,
  cost = emptyTestRunCost(),
  taskExpired = false,
): CompanySkillTestRun {
  return {
    ...row,
    inputId: row.inputId ?? null,
    agentConfigSnapshot: isPlainRecord(row.agentConfigSnapshot) ? row.agentConfigSnapshot : {},
    templateId: row.templateId ?? null,
    templateName: row.templateName ?? null,
    templateBody: row.templateBody ?? null,
    renderedTemplateBody: row.renderedTemplateBody ?? null,
    harnessIssueDescription: row.harnessIssueDescription || row.inputSnapshot,
    status: normalizeTestRunStatus(row.status),
    outputDocumentKey: row.outputDocumentKey || "output",
    outputSnapshot: row.outputSnapshot ?? "",
    error: row.error ?? null,
    deletedAt: row.deletedAt ?? null,
    supersededAt: row.supersededAt ?? null,
    harnessIssueExpiresAt: row.harnessIssueExpiresAt ?? null,
    harnessIssueDeletedAt: row.harnessIssueDeletedAt ?? null,
    cost,
    taskExpired,
  };
}

function versionInventorySnapshotEqual(
  left: CompanySkillVersionFileInventoryEntry[],
  right: CompanySkillVersionFileInventoryEntry[],
) {
  const normalize = (entries: CompanySkillVersionFileInventoryEntry[]) =>
    JSON.stringify([...entries].sort((a, b) => a.path.localeCompare(b.path)));
  return normalize(left) === normalize(right);
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

export interface ResolvedRequestedSkillEntries {
  /** References that resolved to a company-library skill. */
  resolved: PaperclipDesiredSkillEntry[];
  /**
   * References that could not be resolved to a company-library skill, returned
   * in first-seen order. Only populated when `tolerateUnknownReferences` is set;
   * otherwise unknown references throw. Callers preserve these so stale desired
   * keys stay visible (and removable) instead of silently 422-ing a whole save.
   */
  unresolved: string[];
}

async function resolveRequestedSkillEntriesOrThrow(
  db: Db,
  companyId: string,
  skills: CompanySkill[],
  requestedSelections: Array<string | AgentDesiredSkillEntry>,
  options: { tolerateUnknownReferences?: boolean } = {},
): Promise<ResolvedRequestedSkillEntries> {
  const missing = new Set<string>();
  const ambiguous = new Set<string>();
  const resolved = new Map<string, PaperclipDesiredSkillEntry>();
  const unresolved: string[] = [];
  const seenUnresolved = new Set<string>();

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

    // Unknown / stale reference (no longer in the company library).
    if (options.tolerateUnknownReferences) {
      if (!seenUnresolved.has(selection.key)) {
        seenUnresolved.add(selection.key);
        unresolved.push(selection.key);
      }
      continue;
    }
    missing.add(selection.key);
  }

  // Ambiguous references are always a hard error — they signal a genuine
  // conflict the caller must disambiguate. Unknown references are only fatal
  // when the caller has not opted into tolerating (and preserving) stale keys.
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

  return { resolved: Array.from(resolved.values()), unresolved };
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
  existingForks: CompanySkillForkSummary[] = [],
) {
  const source = deriveSkillSourceInfo(skill);
  return {
    ...skill,
    attachedAgentCount,
    usedByAgents,
    existingForks,
    currentVersion,
    starredByCurrentActor,
    ...source,
  };
}

function summarizeOriginalSkill(skill: CompanySkill): CompanySkillOriginalSummary {
  return {
    id: skill.id,
    name: skill.name,
    slug: skill.slug,
    sourceType: skill.sourceType,
    sourceLocator: skill.sourceLocator,
    sourceRef: skill.sourceRef,
  };
}

function forkCreatedByActor(skill: CompanySkill, actor?: SkillActor | null) {
  const metadata = getSkillMeta(skill);
  if (actor?.type === "agent" && actor.agentId) {
    return asString(metadata.forkedByAgentId) === actor.agentId;
  }
  if (actor?.type === "user" && actor.userId) {
    return asString(metadata.forkedByUserId) === actor.userId;
  }
  return false;
}

function summarizeForkSkill(
  skill: CompanySkill,
  actor: SkillActor | null | undefined,
  versionCount: number,
): CompanySkillForkSummary {
  const metadata = getSkillMeta(skill);
  return {
    ...summarizeOriginalSkill(skill),
    key: skill.key,
    forkedFromSkillId: skill.forkedFromSkillId,
    forkedFromCompanyId: skill.forkedFromCompanyId,
    currentVersionId: skill.currentVersionId,
    createdByCurrentActor: forkCreatedByActor(skill, actor),
    diverged: versionCount > 1 || Boolean(asString(metadata.userModifiedAt)),
    createdAt: skill.createdAt,
    updatedAt: skill.updatedAt,
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

async function listLastEditorsBySkillId(
  db: Db,
  companyId: string,
  skillIds: string[],
): Promise<Map<string, CompanySkillLastEditor | null>> {
  if (skillIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([companySkillVersions.companySkillId], {
      companySkillId: companySkillVersions.companySkillId,
      authorAgentId: companySkillVersions.authorAgentId,
      authorUserId: companySkillVersions.authorUserId,
      userName: authUsers.name,
      userImage: authUsers.image,
      agentName: agentsTable.name,
    })
    .from(companySkillVersions)
    .leftJoin(authUsers, eq(authUsers.id, companySkillVersions.authorUserId))
    .leftJoin(
      agentsTable,
      and(
        eq(agentsTable.companyId, companyId),
        eq(agentsTable.id, companySkillVersions.authorAgentId),
      ),
    )
    .where(and(
      eq(companySkillVersions.companyId, companyId),
      inArray(companySkillVersions.companySkillId, skillIds),
    ))
    .orderBy(
      companySkillVersions.companySkillId,
      desc(companySkillVersions.createdAt),
      desc(companySkillVersions.revisionNumber),
      desc(companySkillVersions.id),
    );

  const editors = new Map<string, CompanySkillLastEditor | null>();
  for (const row of rows) {
    if (row.authorUserId) {
      editors.set(row.companySkillId, {
        kind: "user",
        id: row.authorUserId,
        name: row.userName ?? null,
        imageUrl: row.userImage ?? null,
      });
      continue;
    }
    if (row.authorAgentId) {
      editors.set(row.companySkillId, {
        kind: "agent",
        id: row.authorAgentId,
        name: row.agentName ?? null,
        imageUrl: null,
      });
      continue;
    }
    editors.set(row.companySkillId, null);
  }
  return editors;
}

export function companySkillService(db: Db) {
  const agents = agentService(db);
  const projects = projectService(db);

  async function assertLocalImportSourceAllowed(companyId: string, source: string) {
    const sourceRealPath = await fs.realpath(path.resolve(source)).catch(() => null);
    if (!sourceRealPath) {
      throw unprocessable("Local skill source is not available", {
        code: "skill_source_validation_failed",
      });
    }
    const projectRows = await projects.list(companyId);
    const configuredRoots = [
      resolveManagedSkillsRoot(companyId),
      ...projectRows.flatMap((project) => project.workspaces.map((workspace) => workspace.cwd)),
    ].filter((root): root is string => typeof root === "string" && root.trim().length > 0);
    const approvedRoots = (await Promise.all(
      configuredRoots.map((root) => fs.realpath(path.resolve(root)).catch(() => null)),
    )).filter((root): root is string => Boolean(root));
    const allowed = approvedRoots.some(
      (root) => sourceRealPath === root || sourceRealPath.startsWith(`${root}${path.sep}`),
    );
    if (!allowed) {
      throw forbidden("Local skill source is outside approved company workspace roots", {
        code: "skill_workspace_boundary_denied",
        remediation: "Import from a configured Paperclip workspace or the company managed-skill directory.",
      });
    }
  }

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
      if (isPaperclipBundledSkillKey(skill.key) || asString(skill.metadata?.sourceKind) === "paperclip_bundled") continue;

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
        const metadataChanged = !stableJsonEqual(metadata ?? {}, skill.metadata ?? {});
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
        if (!stableJsonEqual(metadata, skill.metadata ?? {})) {
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
    const categories = new Set(
      (query.categories ?? [])
        .map(normalizeCategoryName)
        .filter((value): value is string => Boolean(value))
        .map(categoryLookupKey),
    );
    const filtered = rows.filter((skill) => {
      if (query.scope && skill.sharingScope !== query.scope) return false;
      if (categories.size > 0 && !skill.categories.some((category) => categories.has(categoryLookupKey(category)))) return false;
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
    if (query.include?.includes("lastEditor")) {
      const lastEditors = await listLastEditorsBySkillId(db, companyId, items.map((item) => item.id));
      return items.map((item) => ({
        ...item,
        lastEditor: lastEditors.get(item.id) ?? null,
      }));
    }
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

  async function getBySlugIfUnique(companyId: string, slug: string) {
    const rows = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.slug, slug)));
    return rows.length === 1 ? toCompanySkill(rows[0]!) : null;
  }

  async function getByRouteRef(companyId: string, ref: string) {
    return (isUuidLike(ref) ? await getById(companyId, ref) : null)
      ?? await getBySlugIfUnique(companyId, ref)
      ?? await getByKey(companyId, ref);
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

  async function versionCount(companyId: string, skillId: string) {
    const [{ value }] = await db
      .select({ value: sql<number>`count(*)::int` })
      .from(companySkillVersions)
      .where(and(eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.companySkillId, skillId)));
    return Number(value ?? 0);
  }

  async function existingForkSummaries(
    companyId: string,
    sourceSkillId: string,
    actor?: SkillActor | null,
  ): Promise<CompanySkillForkSummary[]> {
    const rows = await db
      .select(selectCompanySkillColumns())
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.forkedFromSkillId, sourceSkillId)))
      .orderBy(desc(companySkills.updatedAt), asc(companySkills.name));
    const summaries: CompanySkillForkSummary[] = [];
    for (const row of rows) {
      const skill = toCompanySkill(row);
      summaries.push(summarizeForkSkill(skill, actor, await versionCount(companyId, skill.id)));
    }
    return summaries;
  }

  async function detail(companyId: string, id: string, actor?: SkillActor | null): Promise<CompanySkillDetail | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getByRouteRef(companyId, id);
    if (!skill) return null;
    const usedByAgents = await usage(companyId, skill.key);
    const existingForks = await existingForkSummaries(companyId, skill.id, actor);
    return enrichSkill(
      skill,
      usedByAgents.length,
      usedByAgents,
      await getCurrentVersion(skill),
      await isStarredByActor(companyId, skill.id, actor),
      existingForks,
    );
  }

  async function forkPrecheck(
    companyId: string,
    skillId: string,
    actor?: SkillActor | null,
  ): Promise<CompanySkillForkPrecheckResult | null> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) return null;
    const usedByAgents = await usage(companyId, skill.key);
    return {
      skillId: skill.id,
      original: summarizeOriginalSkill(skill),
      agentUsageCount: usedByAgents.length,
      usedByAgents,
      existingForks: await existingForkSummaries(companyId, skill.id, actor),
    };
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

  async function planSkillReassignments(
    companyId: string,
    source: CompanySkill,
    forkKey: string,
    reassignAgentIds: string[] | undefined,
  ): Promise<PlannedSkillReassignment[]> {
    const requestedAgentIds = Array.from(new Set(reassignAgentIds ?? []));
    if (requestedAgentIds.length === 0) return [];

    const skills = await listReferenceTargets(companyId);
    const agentRows = await agents.list(companyId, { includeTerminated: true });
    const byId = new Map(agentRows.map((agent) => [agent.id, agent]));
    const missingAgentIds = requestedAgentIds.filter((agentId) => !byId.has(agentId));
    if (missingAgentIds.length > 0) {
      throw notFound(`Agent not found for skill reassignment: ${missingAgentIds.join(", ")}`);
    }

    return requestedAgentIds.map((agentId) => {
      const agent = byId.get(agentId)!;
      if (agent.companyId !== companyId) {
        throw unprocessable("Cannot reassign a skill for an agent in another company.", { agentId });
      }
      const adapterConfig = agent.adapterConfig as Record<string, unknown>;
      const desiredEntries = resolveDesiredSkillEntries(skills, adapterConfig);
      const hasSource = desiredEntries.some((entry) => entry.key === source.key);
      if (!hasSource) {
        throw unprocessable(`Agent "${agent.name}" does not currently use skill "${source.name}".`, {
          agentId,
          skillId: source.id,
          skillKey: source.key,
        });
      }
      return {
        agentId,
        reassignment: {
          agentId,
          previousSkillKey: source.key,
          nextSkillKey: forkKey,
        },
      };
    });
  }

  async function applySkillReassignments(
    companyId: string,
    source: CompanySkill,
    forkKey: string,
    planned: PlannedSkillReassignment[],
  ): Promise<CompanySkillForkReassignment[]> {
    if (planned.length === 0) return [];
    const skills = await listReferenceTargets(companyId);
    await db.transaction(async (tx) => {
      for (const item of planned) {
        const row = await tx
          .select({
            id: agentsTable.id,
            name: agentsTable.name,
            adapterConfig: agentsTable.adapterConfig,
          })
          .from(agentsTable)
          .where(and(eq(agentsTable.companyId, companyId), eq(agentsTable.id, item.agentId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!row) throw notFound(`Agent not found for skill reassignment: ${item.agentId}`);
        const adapterConfig = row.adapterConfig as Record<string, unknown>;
        const desiredEntries = resolveDesiredSkillEntries(skills, adapterConfig);
        const hasSource = desiredEntries.some((entry) => entry.key === source.key);
        if (!hasSource) {
          throw unprocessable(`Agent "${row.name}" does not currently use skill "${source.name}".`, {
            agentId: item.agentId,
            skillId: source.id,
            skillKey: source.key,
          });
        }
        const nextEntries = desiredEntries.map((entry) =>
          entry.key === source.key
            ? { key: forkKey, versionId: null }
            : entry
        );
        const updated = await tx
          .update(agentsTable)
          .set({
            adapterConfig: writePaperclipSkillSyncPreference(adapterConfig, nextEntries),
            updatedAt: new Date(),
          })
          .where(and(eq(agentsTable.companyId, companyId), eq(agentsTable.id, item.agentId)))
          .returning({ id: agentsTable.id })
          .then((rows) => rows[0] ?? null);
        if (!updated) throw notFound(`Agent not found for skill reassignment: ${item.agentId}`);
      }
    });
    return planned.map((item) => item.reassignment);
  }

  async function cleanupFailedFork(companyId: string, sourceSkillId: string, forkSkillId: string, forkDir: string) {
    await db.transaction(async (tx) => {
      await tx
        .update(companySkills)
        .set({ currentVersionId: null, updatedAt: new Date() })
        .where(and(eq(companySkills.id, forkSkillId), eq(companySkills.companyId, companyId)));
      await tx
        .delete(companySkillComments)
        .where(and(eq(companySkillComments.companyId, companyId), eq(companySkillComments.companySkillId, forkSkillId)));
      await tx
        .delete(companySkillStars)
        .where(and(eq(companySkillStars.companyId, companyId), eq(companySkillStars.companySkillId, forkSkillId)));
      await tx
        .delete(companySkillVersions)
        .where(and(eq(companySkillVersions.companyId, companyId), eq(companySkillVersions.companySkillId, forkSkillId)));
      await tx
        .delete(companySkills)
        .where(and(eq(companySkills.id, forkSkillId), eq(companySkills.companyId, companyId)));
      await tx
        .update(companySkills)
        .set({
          forkCount: sql`greatest(${companySkills.forkCount} - 1, 0)`,
          installCount: sql`greatest(${companySkills.installCount} - 1, 0)`,
          updatedAt: new Date(),
        })
        .where(and(eq(companySkills.id, sourceSkillId), eq(companySkills.companyId, companyId)));
    });
    await fs.rm(forkDir, { recursive: true, force: true });
  }

  async function forkSkill(
    companyId: string,
    skillId: string,
    input: CompanySkillForkRequest = {},
    actor: SkillActor | null = null,
  ): Promise<CompanySkillForkResult> {
    await ensureSkillInventoryCurrent(companyId);
    const source = await getById(companyId, skillId);
    if (!source) throw notFound("Skill not found");
    const existing = await listFull(companyId);
    const usedSlugs = new Set(existing.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
    const forkSlug = uniqueSkillSlug(normalizeSkillSlug(input.slug ?? `${source.slug}-fork`) ?? `${source.slug}-fork`, usedSlugs);
    const forkName = input.name?.trim() || `${source.name} Fork`;
    const forkKey = `company/${companyId}/${forkSlug}`;
    const plannedReassignments = await planSkillReassignments(companyId, source, forkKey, input.reassignAgentIds);
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
      key: forkKey,
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
    const persistedFork = await getById(companyId, forked.id).then((skill) => {
      if (!skill) throw notFound("Forked skill not found");
      return skill;
    });
    let reassignments: CompanySkillForkReassignment[];
    try {
      reassignments = await applySkillReassignments(companyId, source, forkKey, plannedReassignments);
    } catch (error) {
      await cleanupFailedFork(companyId, source.id, forked.id, forkDir);
      throw error;
    }
    return {
      skill: persistedFork,
      original: summarizeOriginalSkill(source),
      reassignments,
    };
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

  async function deleteFile(
    companyId: string,
    skillId: string,
    input: CompanySkillFileDeleteRequest,
    actor: SkillActor | null = null,
  ): Promise<CompanySkillFileDeleteResult> {
    await ensureSkillInventoryCurrent(companyId);
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");

    const source = deriveSkillSourceInfo(skill);
    if (!source.editable || skill.sourceType !== "local_path") {
      throw unprocessable(source.editableReason ?? "This skill cannot be edited.");
    }

    const normalizedPath = normalizePortablePath(input.path);
    if (!normalizedPath) {
      throw unprocessable("Skill file path is required.");
    }

    const deletedPaths = input.target === "folder"
      ? skill.fileInventory
        .map((entry) => normalizePortablePath(entry.path))
        .filter((entryPath) => entryPath.startsWith(`${normalizedPath}/`))
      : skill.fileInventory
        .map((entry) => normalizePortablePath(entry.path))
        .filter((entryPath) => entryPath === normalizedPath);

    if (deletedPaths.length === 0) {
      throw notFound(input.target === "folder" ? "Skill folder not found" : "Skill file not found");
    }
    if (deletedPaths.includes("SKILL.md")) {
      throw unprocessable("SKILL.md cannot be deleted.");
    }

    const absolutePath = resolveLocalSkillFilePath(skill, normalizedPath);
    if (!absolutePath) throw notFound("Skill file not found");

    await fs.rm(absolutePath, {
      recursive: input.target === "folder",
      force: false,
    }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw notFound(input.target === "folder" ? "Skill folder not found" : "Skill file not found");
      }
      throw error;
    });

    await db
      .update(companySkills)
      .set({ updatedAt: new Date() })
      .where(eq(companySkills.id, skill.id));

    await createVersion(companyId, skillId, {
      label: input.target === "folder" ? `Deleted ${normalizedPath}/` : `Deleted ${normalizedPath}`,
    }, actor);

    return {
      skillId: skill.id,
      path: normalizedPath,
      target: input.target,
      deletedPaths,
    };
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
    const mode = input.mode ?? "import";
    const selectiveImport = mode === "import" && input.selection !== undefined;
    const projectRows = input.projectIds?.length
      ? await projects.listByIds(companyId, input.projectIds)
      : await projects.list(companyId);
    const workspaceFilter = new Set(input.workspaceIds ?? []);
    const skipped: CompanySkillProjectScanSkipped[] = [];
    const conflicts: CompanySkillProjectScanConflict[] = [];
    const candidates: CompanySkillProjectScanCandidate[] = [];
    const warnings: string[] = [];
    const imported: CompanySkill[] = [];
    const updated: CompanySkill[] = [];
    const availableSkills = await listFull(companyId);
    const acceptedSkills = [...availableSkills];
    const acceptedByKey = new Map(acceptedSkills.map((skill) => [skill.key, skill]));
    const scanTargets: ProjectSkillScanTarget[] = [];
    const workspaceContexts = new Map<string, {
      projectId: string;
      projectName: string;
      workspaceId: string;
      workspaceName: string;
    }>();
    const selectedPaths = new Map<string, { workspaceId: string; path: string; slug?: string }>();
    const invalidSelections: Array<{ workspaceId: string; path: string; slug?: string }> = [];
    const rediscoveredSelections = new Set<string>();
    const scannedProjectIds = new Set<string>();
    let discovered = 0;

    for (const selection of input.selection ?? []) {
      const normalizedPath = normalizeProjectScanSelectionPath(selection.path);
      if (!normalizedPath) {
        invalidSelections.push(selection);
        continue;
      }
      const renamedSlug = selection.slug === undefined
        ? undefined
        : normalizeSkillSlug(selection.slug);
      if (selection.slug !== undefined && !renamedSlug) {
        invalidSelections.push(selection);
        continue;
      }
      selectedPaths.set(projectScanSelectionKey(selection.workspaceId, normalizedPath), {
        workspaceId: selection.workspaceId,
        path: normalizedPath,
        ...(renamedSlug ? { slug: renamedSlug } : {}),
      });
    }
    const selectedWorkspaceIds = new Set(
      Array.from(selectedPaths.values()).map((selection) => selection.workspaceId),
    );

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
        workspaceContexts.set(workspace.id, {
          projectId: project.id,
          projectName: project.name,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        });
        if (workspaceFilter.size > 0 && !workspaceFilter.has(workspace.id)) continue;
        if (selectiveImport && !selectedWorkspaceIds.has(workspace.id)) continue;
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
        const selectionKey = projectScanSelectionKey(target.workspaceId, directory.relativePath);
        const selected = !selectiveImport || selectedPaths.has(selectionKey);
        const selectedRename = selectedPaths.get(selectionKey)?.slug;
        if (selectedPaths.has(selectionKey)) rediscoveredSelections.add(selectionKey);
        if (selectiveImport && !selected) continue;

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
            workspaceRoot: target.workspaceCwd,
          });
        } catch (error) {
          const message = projectSkillImportFailureReason(error);
          candidates.push({
            slug: path.basename(directory.skillDir),
            name: path.basename(directory.skillDir),
            description: null,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            projectId: target.projectId,
            projectName: target.projectName,
            directoryRoot: directory.directoryRoot,
            relativePath: directory.relativePath,
            status: "skipped",
            reason: message,
          });
          skipped.push({
            projectId: target.projectId,
            projectName: target.projectName,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            path: directory.skillDir,
            reason: trackWarning(
              `Skipped ${target.projectName} / ${target.workspaceName} / ${directory.relativePath}: ${message}`,
            ),
          });
          continue;
        }

        const normalizedSourceDir = normalizeSourceLocatorDirectory(nextSkill.sourceLocator);
        const existingBySource = normalizedSourceDir
          ? acceptedSkills.find((skill) => normalizeSkillDirectory(skill) === normalizedSourceDir) ?? null
          : null;
        if (existingBySource) {
          candidates.push({
            slug: nextSkill.slug,
            name: nextSkill.name,
            description: nextSkill.description,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            projectId: target.projectId,
            projectName: target.projectName,
            directoryRoot: directory.directoryRoot,
            relativePath: directory.relativePath,
            status: "already_imported",
            existingSkillId: existingBySource.id,
            reason: "This skill is already installed from the same path.",
          });
          continue;
        }

        const existingBundledBySlug = acceptedSkills.find((skill) => (
          skill.slug === nextSkill.slug
          && (isPaperclipBundledSkillKey(skill.key) || asString(skill.metadata?.sourceKind) === "paperclip_bundled")
        )) ?? null;
        if (existingBundledBySlug) {
          candidates.push({
            slug: nextSkill.slug,
            name: nextSkill.name,
            description: nextSkill.description,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            projectId: target.projectId,
            projectName: target.projectName,
            directoryRoot: directory.directoryRoot,
            relativePath: directory.relativePath,
            status: "already_imported",
            existingSkillId: existingBundledBySlug.id,
            reason: "This skill is already available as a built-in.",
          });
          continue;
        }

        if (selectedRename) {
          const renamedKey = `local/${hashSkillValue(path.resolve(nextSkill.sourceLocator ?? directory.skillDir))}/${selectedRename}`;
          nextSkill = {
            ...nextSkill,
            key: renamedKey,
            slug: selectedRename,
            metadata: {
              ...(isPlainRecord(nextSkill.metadata) ? nextSkill.metadata : {}),
              skillKey: renamedKey,
            },
          };
        }

        const existingByKey = acceptedByKey.get(nextSkill.key) ?? null;
        if (existingByKey) {
          const existingSourceDir = normalizeSkillDirectory(existingByKey);
          if (
            existingByKey.sourceType !== "local_path"
            || !existingSourceDir
            || !normalizedSourceDir
            || existingSourceDir !== normalizedSourceDir
          ) {
            const reason = `Skill key ${nextSkill.key} already points at ${existingByKey.sourceLocator ?? "another source"}.`;
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
              reason,
            });
            candidates.push({
              slug: nextSkill.slug,
              name: nextSkill.name,
              description: nextSkill.description,
              workspaceId: target.workspaceId,
              workspaceName: target.workspaceName,
              projectId: target.projectId,
              projectName: target.projectName,
              directoryRoot: directory.directoryRoot,
              relativePath: directory.relativePath,
              status: "conflict",
              existingSkillId: existingByKey.id,
              reason,
            });
            continue;
          }

          candidates.push({
            slug: nextSkill.slug,
            name: nextSkill.name,
            description: nextSkill.description,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            projectId: target.projectId,
            projectName: target.projectName,
            directoryRoot: directory.directoryRoot,
            relativePath: directory.relativePath,
            status: "already_imported",
            existingSkillId: existingByKey.id,
            ...(selectiveImport && !selected ? { reason: "Not selected for import." } : {}),
          });
          if (mode === "preview" || !selected) continue;
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
          const reason = `Slug ${nextSkill.slug} is already in use by ${slugConflict.sourceLocator ?? slugConflict.key}.`;
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
            reason,
          });
          candidates.push({
            slug: nextSkill.slug,
            name: nextSkill.name,
            description: nextSkill.description,
            workspaceId: target.workspaceId,
            workspaceName: target.workspaceName,
            projectId: target.projectId,
            projectName: target.projectName,
            directoryRoot: directory.directoryRoot,
            relativePath: directory.relativePath,
            status: "conflict",
            existingSkillId: slugConflict.id,
            reason,
          });
          continue;
        }

        candidates.push({
          slug: nextSkill.slug,
          name: nextSkill.name,
          description: nextSkill.description,
          workspaceId: target.workspaceId,
          workspaceName: target.workspaceName,
          projectId: target.projectId,
          projectName: target.projectName,
          directoryRoot: directory.directoryRoot,
          relativePath: directory.relativePath,
          status: selected ? "new" : "skipped",
          ...(!selected ? { reason: "Not selected for import." } : {}),
        });
        if (mode === "preview" || !selected) continue;
        const persisted = (await upsertImportedSkills(companyId, [nextSkill]))[0];
        if (!persisted) continue;
        imported.push(persisted);
        upsertAcceptedSkill(persisted);
      }
    }

    if (selectiveImport) {
      const unmatchedSelections = [
        ...invalidSelections,
        ...Array.from(selectedPaths.entries())
          .filter(([key]) => !rediscoveredSelections.has(key))
          .map(([, selection]) => selection),
      ];
      for (const selection of unmatchedSelections) {
        const context = workspaceContexts.get(selection.workspaceId) ?? null;
        skipped.push({
          projectId: context?.projectId ?? null,
          projectName: context?.projectName ?? null,
          workspaceId: selection.workspaceId,
          workspaceName: context?.workspaceName ?? null,
          path: selection.path,
          reason: trackWarning(
            `Skipped selection ${selection.workspaceId}:${selection.path}: the path was not rediscovered in the project workspace scan.`,
          ),
        });
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
      candidates,
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
      const values: ImportedSkillPersistValues = {
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
      if (existing && importedSkillPersistValuesMatchExisting(existing, values)) {
        out.push(existing);
        continue;
      }
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
    if (local) {
      await assertLocalImportSourceAllowed(companyId, parsed.resolvedSource);
    }
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

  async function listTestInputs(companyId: string, skillId: string): Promise<CompanySkillTestInput[]> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const rows = await db
      .select()
      .from(companySkillTestInputs)
      .where(and(
        eq(companySkillTestInputs.companyId, companyId),
        eq(companySkillTestInputs.skillId, skillId),
        isNull(companySkillTestInputs.deletedAt),
      ))
      .orderBy(asc(companySkillTestInputs.name), asc(companySkillTestInputs.createdAt));
    return rows.map(toCompanySkillTestInput);
  }

  async function createTestInput(
    companyId: string,
    skillId: string,
    input: CompanySkillTestInputCreateRequest,
    actor: SkillActor | null = null,
  ): Promise<CompanySkillTestInput> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const row = await db
      .insert(companySkillTestInputs)
      .values({
        companyId,
        skillId,
        name: input.name.trim(),
        content: input.content,
        createdBy: actor?.type === "agent"
          ? actor.agentId ?? null
          : actor?.type === "user"
            ? actor.userId ?? null
            : null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Failed to persist test input");
    return toCompanySkillTestInput(row);
  }

  async function updateTestInput(
    companyId: string,
    skillId: string,
    inputId: string,
    input: CompanySkillTestInputUpdateRequest,
  ): Promise<CompanySkillTestInput | null> {
    const patch: Partial<typeof companySkillTestInputs.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.content !== undefined) patch.content = input.content;
    const row = await db
      .update(companySkillTestInputs)
      .set(patch)
      .where(and(
        eq(companySkillTestInputs.companyId, companyId),
        eq(companySkillTestInputs.skillId, skillId),
        eq(companySkillTestInputs.id, inputId),
        isNull(companySkillTestInputs.deletedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkillTestInput(row) : null;
  }

  async function deleteTestInput(companyId: string, skillId: string, inputId: string): Promise<CompanySkillTestInput | null> {
    const row = await db
      .update(companySkillTestInputs)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(companySkillTestInputs.companyId, companyId),
        eq(companySkillTestInputs.skillId, skillId),
        eq(companySkillTestInputs.id, inputId),
        isNull(companySkillTestInputs.deletedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkillTestInput(row) : null;
  }

  async function listTestRunTemplates(companyId: string): Promise<CompanySkillTestRunTemplate[]> {
    const rows = await db
      .select()
      .from(companySkillTestRunTemplates)
      .where(and(eq(companySkillTestRunTemplates.companyId, companyId), isNull(companySkillTestRunTemplates.deletedAt)))
      .orderBy(asc(companySkillTestRunTemplates.name), asc(companySkillTestRunTemplates.createdAt));
    return [
      builtInSkillTestRunTemplate(companyId),
      ...rows.map(toCompanySkillTestRunTemplate),
    ];
  }

  async function createTestRunTemplate(
    companyId: string,
    input: CompanySkillTestRunTemplateCreateRequest,
    actor: SkillActor | null = null,
  ): Promise<CompanySkillTestRunTemplate> {
    validateSkillTestTemplatePlaceholders(input.body);
    const row = await db
      .insert(companySkillTestRunTemplates)
      .values({
        companyId,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        body: input.body,
        createdByAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
        createdByUserId: actor?.type === "user" ? actor.userId ?? null : null,
        updatedByAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
        updatedByUserId: actor?.type === "user" ? actor.userId ?? null : null,
      })
      .returning()
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Failed to persist test run template");
    return toCompanySkillTestRunTemplate(row);
  }

  async function updateTestRunTemplate(
    companyId: string,
    templateId: string,
    input: CompanySkillTestRunTemplateUpdateRequest,
    actor: SkillActor | null = null,
  ): Promise<CompanySkillTestRunTemplate | null> {
    if (templateId === BUILT_IN_SKILL_TEST_RUN_TEMPLATE_ID) {
      throw unprocessable("Built-in test run templates are read-only.");
    }
    if (input.body !== undefined) {
      validateSkillTestTemplatePlaceholders(input.body);
    }
    const patch: Partial<typeof companySkillTestRunTemplates.$inferInsert> = {
      updatedAt: new Date(),
      updatedByAgentId: actor?.type === "agent" ? actor.agentId ?? null : null,
      updatedByUserId: actor?.type === "user" ? actor.userId ?? null : null,
    };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.body !== undefined) patch.body = input.body;
    const row = await db
      .update(companySkillTestRunTemplates)
      .set(patch)
      .where(and(
        eq(companySkillTestRunTemplates.companyId, companyId),
        eq(companySkillTestRunTemplates.id, templateId),
        isNull(companySkillTestRunTemplates.deletedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkillTestRunTemplate(row) : null;
  }

  async function deleteTestRunTemplate(companyId: string, templateId: string): Promise<CompanySkillTestRunTemplate | null> {
    if (templateId === BUILT_IN_SKILL_TEST_RUN_TEMPLATE_ID) {
      throw unprocessable("Built-in test run templates are read-only.");
    }
    const row = await db
      .update(companySkillTestRunTemplates)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(companySkillTestRunTemplates.companyId, companyId),
        eq(companySkillTestRunTemplates.id, templateId),
        isNull(companySkillTestRunTemplates.deletedAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkillTestRunTemplate(row) : null;
  }

  async function resolveTestRunTemplateSnapshot(
    companyId: string,
    input: CompanySkillTestRunCreateRequest,
  ): Promise<CompanySkillTestRunTemplateSnapshot | null> {
    if (input.templateSnapshot !== undefined) {
      const snapshot = input.templateSnapshot;
      if (!snapshot || snapshot.templateId === null) return null;
      validateSkillTestTemplatePlaceholders(snapshot.templateBody ?? "");
      return {
        templateId: snapshot.templateId,
        templateName: snapshot.templateName,
        templateBody: snapshot.templateBody,
      };
    }

    const templateId = input.templateId === undefined ? BUILT_IN_SKILL_TEST_RUN_TEMPLATE_ID : input.templateId;
    if (templateId === null) return null;
    if (templateId === BUILT_IN_SKILL_TEST_RUN_TEMPLATE_ID) {
      const template = builtInSkillTestRunTemplate(companyId);
      return {
        templateId: template.id,
        templateName: template.name,
        templateBody: template.body,
      };
    }
    const row = await db
      .select()
      .from(companySkillTestRunTemplates)
      .where(and(
        eq(companySkillTestRunTemplates.companyId, companyId),
        eq(companySkillTestRunTemplates.id, templateId),
        isNull(companySkillTestRunTemplates.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Test run template not found");
    return {
      templateId: row.id,
      templateName: row.name,
      templateBody: row.body,
    };
  }

  async function ensureRunSkillVersion(
    companyId: string,
    skill: CompanySkill,
    actor: SkillActor | null,
  ): Promise<CompanySkillVersion> {
    const currentSnapshot = serializeVersionFileInventory(await collectVersionFileInventory(companyId, skill));
    if (currentSnapshot.length === 0) {
      throw unprocessable("Cannot run a skill test for a skill with zero files.");
    }

    const currentVersion = await getCurrentVersion(skill);
    if (!currentVersion || !versionInventorySnapshotEqual(currentVersion.fileInventory, currentSnapshot)) {
      return createVersion(companyId, skill.id, { label: "Auto version for test run" }, actor);
    }
    return currentVersion;
  }

  function snapshotAgentConfig(agent: Awaited<ReturnType<typeof agents.getById>>) {
    if (!agent) return {};
    const adapterConfig = isPlainRecord(agent.adapterConfig) ? agent.adapterConfig : {};
    const runtimeConfig = isPlainRecord(agent.runtimeConfig) ? agent.runtimeConfig : {};
    return {
      agentId: agent.id,
      name: agent.name,
      role: agent.role,
      adapterType: agent.adapterType,
      model: asString(adapterConfig.model) ?? asString(runtimeConfig.model) ?? null,
      adapterConfig,
      runtimeConfig,
      assignedSkills: isPlainRecord(adapterConfig.paperclipSkillSync)
        ? adapterConfig.paperclipSkillSync
        : null,
      instructionsRef:
        asString(adapterConfig.instructionsFilePath) ??
        asString(adapterConfig.instructionsPath) ??
        asString(adapterConfig.instructionsRef) ??
        null,
    };
  }

  async function testRunCostByIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return new Map<string, ReturnType<typeof emptyTestRunCost>>();
    const rows = await db
      .select({
        issueId: costEvents.issueId,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
        cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), inArray(costEvents.issueId, issueIds)))
      .groupBy(costEvents.issueId);
    return new Map(rows.flatMap((row) => row.issueId
      ? [[row.issueId, {
        costCents: Number(row.costCents ?? 0),
        inputTokens: Number(row.inputTokens ?? 0),
        cachedInputTokens: Number(row.cachedInputTokens ?? 0),
        outputTokens: Number(row.outputTokens ?? 0),
      }]]
      : []));
  }

  async function hydrateTestRuns(companyId: string, rows: CompanySkillTestRunRow[]): Promise<CompanySkillTestRun[]> {
    const costByIssueId = await testRunCostByIssueIds(companyId, rows.map((row) => row.issueId));
    return rows.map((row) => toCompanySkillTestRun(
      row,
      costByIssueId.get(row.issueId) ?? emptyTestRunCost(),
      Boolean(row.harnessIssueDeletedAt),
    ));
  }

  async function createTestRun(
    companyId: string,
    skillId: string,
    input: CompanySkillTestRunCreateRequest,
    actor: SkillActor | null,
    deps: {
      createHarnessIssue: (issue: {
        id: string;
        title: string;
        description: string;
        assigneeAgentId: string;
        harnessKind: "skill_test";
        workMode: "skill_test";
        status: "todo";
        originKind: "skill_test";
        originId: string;
        originFingerprint: string;
      }) => Promise<{ id: string }>;
      wakeHarnessIssue: (issueId: string, agentId: string) => Promise<unknown>;
      cleanupHarnessIssue?: (issueId: string) => Promise<unknown>;
      retentionDays?: number;
    },
  ): Promise<CompanySkillTestRun> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const agent = await agents.getById(input.agentId);
    if (!agent || agent.companyId !== companyId) throw notFound("Agent not found");
    if (agent.status === "paused") throw unprocessable("Paused agents cannot run skill tests.");

    const sourceInput = input.inputId
      ? await db
        .select()
        .from(companySkillTestInputs)
        .where(and(
          eq(companySkillTestInputs.companyId, companyId),
          eq(companySkillTestInputs.skillId, skillId),
          eq(companySkillTestInputs.id, input.inputId),
          isNull(companySkillTestInputs.deletedAt),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    if (input.inputId && !sourceInput) throw notFound("Test input not found");
    const inputSnapshot = (sourceInput?.content ?? input.content ?? "").trim();
    if (!inputSnapshot) throw unprocessable("Test input content cannot be empty.");

    // Re-run pins the viewed run's version so the new run reproduces the same
    // snapshots; a plain run auto-snapshots the live head.
    const version = input.skillVersionId
      ? await getVersion(companyId, skillId, input.skillVersionId)
      : await ensureRunSkillVersion(companyId, skill, actor);
    if (!version) throw notFound("Skill version not found");
    const runId = randomUUID();
    const issueId = randomUUID();
    const outputDocumentKey = "output";
    const templateSnapshot = await resolveTestRunTemplateSnapshot(companyId, input);
    const renderedTemplateBody = templateSnapshot?.templateBody
      ? renderSkillTestTemplate(templateSnapshot.templateBody, {
        skillName: skill.name,
        skillKey: skill.key,
        skillInvocation: skill.key,
        skillVersion: String(version.revisionNumber),
        runId,
        issueId,
        outputDocumentKey,
      }).trim()
      : null;
    const harnessIssueDescription = buildHarnessIssueDescription(inputSnapshot, renderedTemplateBody);
    await deps.createHarnessIssue({
      id: issueId,
      title: `Skill test: ${skill.name}`,
      description: harnessIssueDescription,
      assigneeAgentId: agent.id,
      harnessKind: "skill_test",
      workMode: "skill_test",
      status: "todo",
      originKind: "skill_test",
      originId: runId,
      originFingerprint: `skill_test:${runId}`,
    });

    const now = new Date();
    const retentionDays = Math.max(0, deps.retentionDays ?? 7);
    const previousExpiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);
    const cleanupCreatedHarnessIssue = async () => {
      await deps.cleanupHarnessIssue?.(issueId).catch(() => {});
    };
    const row = await db.transaction(async (tx) => {
      await tx
        .update(companySkillTestRuns)
        .set({
          supersededAt: now,
          status: sql`
            case when ${companySkillTestRuns.status} in ('queued', 'running')
              then 'cancelled'
              else ${companySkillTestRuns.status}
            end
          `,
          error: sql`
            case when ${companySkillTestRuns.status} in ('queued', 'running')
              then coalesce(${companySkillTestRuns.error}, 'Superseded by newer run')
              else ${companySkillTestRuns.error}
            end
          `,
          harnessIssueExpiresAt: previousExpiresAt,
          updatedAt: now,
        })
        .where(and(
          eq(companySkillTestRuns.companyId, companyId),
          eq(companySkillTestRuns.skillId, skillId),
          sourceInput?.id
            ? eq(companySkillTestRuns.inputId, sourceInput.id)
            : isNull(companySkillTestRuns.inputId),
          isNull(companySkillTestRuns.supersededAt),
        ));
      return await tx
        .insert(companySkillTestRuns)
        .values({
          id: runId,
          companyId,
          skillId,
          inputId: sourceInput?.id ?? null,
          inputSnapshot,
          skillVersionId: version.id,
          agentId: agent.id,
          agentConfigSnapshot: snapshotAgentConfig(agent),
          issueId,
          templateId: templateSnapshot?.templateId ?? null,
          templateName: templateSnapshot?.templateName ?? null,
          templateBody: templateSnapshot?.templateBody ?? null,
          renderedTemplateBody,
          harnessIssueDescription,
          status: "queued",
          outputDocumentKey,
        })
        .returning()
        .then((rows) => rows[0] ?? null);
    }).catch(async (error) => {
      await cleanupCreatedHarnessIssue();
      throw error;
    });
    if (!row) {
      await cleanupCreatedHarnessIssue();
      throw notFound("Failed to persist skill test run");
    }
    await deps.wakeHarnessIssue(issueId, agent.id);
    return (await hydrateTestRuns(companyId, [row]))[0]!;
  }

  async function listTestRuns(
    companyId: string,
    skillId: string,
    query: CompanySkillTestRunListQuery = {},
  ): Promise<CompanySkillTestRun[]> {
    const skill = await getById(companyId, skillId);
    if (!skill) throw notFound("Skill not found");
    const conditions = [
      eq(companySkillTestRuns.companyId, companyId),
      eq(companySkillTestRuns.skillId, skillId),
      isNull(companySkillTestRuns.deletedAt),
    ];
    if (query.inputId) conditions.push(eq(companySkillTestRuns.inputId, query.inputId));
    const rows = await db
      .select()
      .from(companySkillTestRuns)
      .where(and(...conditions))
      .orderBy(desc(companySkillTestRuns.createdAt), desc(companySkillTestRuns.id));
    return hydrateTestRuns(companyId, rows);
  }

  async function getTestRunDetail(companyId: string, skillId: string, runId: string): Promise<CompanySkillTestRunDetail | null> {
    const row = await db
      .select()
      .from(companySkillTestRuns)
      .where(and(
        eq(companySkillTestRuns.companyId, companyId),
        eq(companySkillTestRuns.skillId, skillId),
        eq(companySkillTestRuns.id, runId),
        isNull(companySkillTestRuns.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row) return null;
    const [run] = await hydrateTestRuns(companyId, [row]);
    if (!run) return null;
    const harnessIssueGone = Boolean(row.harnessIssueDeletedAt);
    const [version, issue, documentRows, interactionRows, attachmentRows, workProductRows] = await Promise.all([
      getVersion(companyId, skillId, row.skillVersionId),
      harnessIssueGone
        ? Promise.resolve(null)
        : db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            hiddenAt: issues.hiddenAt,
          })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), eq(issues.id, row.issueId)))
          .then((rows) => rows[0] ?? null),
      harnessIssueGone
        ? Promise.resolve([])
        : db
          .select(issueDocumentSelect)
          .from(issueDocuments)
          .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
          .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, row.issueId)))
          .orderBy(asc(issueDocuments.key)),
      harnessIssueGone
        ? Promise.resolve([])
        : db
          .select({
            id: issueThreadInteractions.id,
            kind: issueThreadInteractions.kind,
            status: issueThreadInteractions.status,
            title: issueThreadInteractions.title,
            createdAt: issueThreadInteractions.createdAt,
            updatedAt: issueThreadInteractions.updatedAt,
          })
          .from(issueThreadInteractions)
          .where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, row.issueId)))
          .orderBy(desc(issueThreadInteractions.createdAt)),
      harnessIssueGone
        ? Promise.resolve([])
        : db
          .select({
            id: issueAttachments.id,
            companyId: issueAttachments.companyId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.issueId, row.issueId)))
          .orderBy(desc(issueAttachments.createdAt)),
      harnessIssueGone
        ? Promise.resolve([])
        : db
          .select()
          .from(issueWorkProducts)
          .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.issueId, row.issueId)))
          .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt)),
    ]);
    if (!version) throw notFound("Skill version not found");
    const harnessAvailable = !harnessIssueGone && issue !== null;
    const harnessDocuments: IssueDocument[] = harnessAvailable
      ? documentRows.map((doc) => ({
        ...mapIssueDocumentRow(doc, false),
        format: doc.format as IssueDocument["format"],
        body: doc.latestBody,
      }))
      : [];
    const harnessAttachments: IssueAttachment[] = harnessAvailable
      ? attachmentRows.map((attachment) => ({
        ...attachment,
        contentPath: `/api/attachments/${attachment.id}/content`,
        openPath: `/api/attachments/${attachment.id}/content`,
        downloadPath: `/api/attachments/${attachment.id}/content?download=1`,
      }))
      : [];
    const harnessWorkProducts = harnessAvailable ? workProductRows.map(toIssueWorkProduct) : [];
    const harnessContent: CompanySkillTestRunHarnessContent = {
      available: harnessAvailable,
      unavailableReason: harnessAvailable
        ? null
        : harnessIssueGone
          ? (row.harnessIssueExpiresAt && row.harnessIssueDeletedAt && row.harnessIssueExpiresAt <= row.harnessIssueDeletedAt
            ? "expired"
            : "deleted")
          : "missing",
      documents: harnessDocuments,
      attachments: harnessAttachments,
      workProducts: harnessWorkProducts,
    };
    return {
      ...run,
      skillVersion: version,
      outputBody: run.outputSnapshot,
      harnessContent,
      harnessIssue: issue ? {
        id: issue.id,
        identifier: issue.identifier ?? null,
        title: issue.title,
        status: issue.status,
        hiddenAt: issue.hiddenAt ?? null,
      } : null,
      documents: harnessDocuments.map((doc) => ({
        key: doc.key,
        title: doc.title ?? null,
        updatedAt: doc.updatedAt,
        body: doc.body,
      })),
      interactions: interactionRows.map((interaction) => ({
        id: interaction.id,
        kind: interaction.kind,
        status: interaction.status,
        title: interaction.title ?? interaction.kind,
        createdAt: interaction.createdAt,
        updatedAt: interaction.updatedAt,
      })),
      artifacts: [
        ...harnessAttachments.map((attachment) => ({
          id: attachment.id,
          kind: "attachment" as const,
          title: attachment.originalFilename ?? "Attachment",
          summary: null,
          createdAt: attachment.createdAt,
        })),
        ...harnessWorkProducts.map((product) => ({
          id: product.id,
          kind: "work_product" as const,
          title: product.title,
          summary: product.summary ?? null,
          createdAt: product.createdAt,
        })),
      ].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()),
    };
  }

  async function completeTestRunForIssue(input: {
    companyId: string;
    issueId: string;
    outcome: "succeeded" | "failed" | "cancelled";
    error?: string | null;
  }): Promise<CompanySkillTestRun | null> {
    const row = await db
      .select()
      .from(companySkillTestRuns)
      .where(and(
        eq(companySkillTestRuns.companyId, input.companyId),
        eq(companySkillTestRuns.issueId, input.issueId),
        isNull(companySkillTestRuns.deletedAt),
        isNull(companySkillTestRuns.supersededAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!row || ["succeeded", "failed", "cancelled"].includes(row.status)) return row
      ? (await hydrateTestRuns(input.companyId, [row]))[0] ?? null
      : null;

    const outputDocumentKey = row.outputDocumentKey || "output";
    const outputDocument = await db
      .select({ body: documents.latestBody })
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(
        eq(issueDocuments.companyId, input.companyId),
        eq(issueDocuments.issueId, input.issueId),
        eq(issueDocuments.key, outputDocumentKey),
      ))
      .then((rows) => rows[0] ?? null);
    const updated = await db
      .update(companySkillTestRuns)
      .set({
        status: input.outcome,
        outputSnapshot: outputDocument?.body ?? row.outputSnapshot ?? "",
        error: input.error ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(companySkillTestRuns.companyId, input.companyId), eq(companySkillTestRuns.id, row.id)))
      .returning()
      .then((rows) => rows[0] ?? null);
    return updated ? (await hydrateTestRuns(input.companyId, [updated]))[0] ?? null : null;
  }

  async function markTestRunRunning(companyId: string, issueId: string): Promise<CompanySkillTestRun | null> {
    const row = await db
      .update(companySkillTestRuns)
      .set({ status: "running", updatedAt: new Date() })
      .where(and(
        eq(companySkillTestRuns.companyId, companyId),
        eq(companySkillTestRuns.issueId, issueId),
        eq(companySkillTestRuns.status, "queued"),
        isNull(companySkillTestRuns.deletedAt),
        isNull(companySkillTestRuns.supersededAt),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);
    return row ? (await hydrateTestRuns(companyId, [row]))[0] ?? null : null;
  }

  async function cancelTestRun(
    companyId: string,
    skillId: string,
    runId: string,
    deps: { cancelHarnessIssue: (issueId: string) => Promise<unknown> },
  ): Promise<CompanySkillTestRun | null> {
    const existing = await db
      .select()
      .from(companySkillTestRuns)
      .where(and(
        eq(companySkillTestRuns.companyId, companyId),
        eq(companySkillTestRuns.skillId, skillId),
        eq(companySkillTestRuns.id, runId),
        isNull(companySkillTestRuns.deletedAt),
        isNull(companySkillTestRuns.supersededAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    if (["succeeded", "failed", "cancelled"].includes(existing.status)) {
      return (await hydrateTestRuns(companyId, [existing]))[0] ?? null;
    }
    await deps.cancelHarnessIssue(existing.issueId);
    return completeTestRunForIssue({
      companyId,
      issueId: existing.issueId,
      outcome: "cancelled",
      error: "Cancelled by operator",
    });
  }

  async function deleteTestRun(
    companyId: string,
    skillId: string,
    runId: string,
    deps: { hideHarnessIssue: (issueId: string) => Promise<unknown> },
  ): Promise<CompanySkillTestRun | null> {
    const existing = await db
      .select()
      .from(companySkillTestRuns)
      .where(and(
        eq(companySkillTestRuns.companyId, companyId),
        eq(companySkillTestRuns.skillId, skillId),
        eq(companySkillTestRuns.id, runId),
        isNull(companySkillTestRuns.deletedAt),
      ))
      .then((rows) => rows[0] ?? null);
    if (!existing) return null;
    // Only terminal runs are deletable — an in-flight run must be cancelled first
    // so we never orphan a live harness task.
    if (!["succeeded", "failed", "cancelled"].includes(existing.status)) {
      throw unprocessable("Cancel the run before deleting it.");
    }
    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      return await tx
        .update(companySkillTestRuns)
        .set({ deletedAt: now, harnessIssueDeletedAt: existing.harnessIssueDeletedAt ?? now, updatedAt: now })
        .where(and(
          eq(companySkillTestRuns.companyId, companyId),
          eq(companySkillTestRuns.id, runId),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
    // Hide the (already-terminal) harness task so the deleted run leaves nothing
    // dangling on the board; best-effort, run row is the source of truth.
    if (!existing.harnessIssueDeletedAt) {
      await deps.hideHarnessIssue(existing.issueId).catch(() => {});
    }
    return updated ? (await hydrateTestRuns(companyId, [updated]))[0] ?? null : null;
  }

  async function pruneExpiredTestHarnessIssues(companyId: string, now = new Date()): Promise<{ pruned: number }> {
    const rows = await db
      .select({
        id: companySkillTestRuns.id,
        issueId: companySkillTestRuns.issueId,
      })
      .from(companySkillTestRuns)
      .where(and(
        eq(companySkillTestRuns.companyId, companyId),
        lt(companySkillTestRuns.harnessIssueExpiresAt, now),
        isNull(companySkillTestRuns.harnessIssueDeletedAt),
      ));
    for (const row of rows) {
      await db.transaction(async (tx) => {
        await tx
          .update(issues)
          .set({ hiddenAt: now, updatedAt: now })
          .where(and(eq(issues.companyId, companyId), eq(issues.id, row.issueId), eq(issues.harnessKind, "skill_test")));
        await tx
          .update(companySkillTestRuns)
          .set({ harnessIssueDeletedAt: now, updatedAt: now })
          .where(and(eq(companySkillTestRuns.companyId, companyId), eq(companySkillTestRuns.id, row.id)));
      });
    }
    return { pruned: rows.length };
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
    getByRouteRef,
    resolveRequestedSkillKeys: async (companyId: string, requestedReferences: string[]) => {
      const skills = await listFull(companyId);
      return resolveRequestedSkillKeysOrThrow(skills, requestedReferences);
    },
    resolveRequestedSkillEntries: async (
      companyId: string,
      requestedSelections: Array<string | AgentDesiredSkillEntry>,
      options?: { tolerateUnknownReferences?: boolean },
    ) => {
      const skills = await listFull(companyId);
      return resolveRequestedSkillEntriesOrThrow(db, companyId, skills, requestedSelections, options);
    },
    categoryCounts,
    detail,
    forkPrecheck,
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
    deleteFile,
    createLocalSkill,
    deleteSkill,
    listTestInputs,
    createTestInput,
    updateTestInput,
    deleteTestInput,
    listTestRunTemplates,
    createTestRunTemplate,
    updateTestRunTemplate,
    deleteTestRunTemplate,
    createTestRun,
    listTestRuns,
    getTestRunDetail,
    completeTestRunForIssue,
    markTestRunRunning,
    cancelTestRun,
    deleteTestRun,
    pruneExpiredTestHarnessIssues,
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
