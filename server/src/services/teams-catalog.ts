import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type {
  CatalogManifest,
  CatalogTeam,
  CatalogTeamFileKind,
  CatalogTeamKind,
  CatalogTeamSkillRequirement,
  CatalogTeamSkillRequirementType,
  CompanyPortabilityAdapterOverride,
  CompanyPortabilityAgentSelection,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityFileEntry,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewResult,
  CompanyPortabilitySource,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { asString, parseFrontmatterMarkdown } from "@paperclipai/shared/frontmatter";
import { conflict, forbidden, HttpError, notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { companyPortabilityService } from "./company-portability.js";
import { companySkillService } from "./company-skills.js";
import { logActivity } from "./activity-log.js";
import { normalizePortablePath } from "./portable-path.js";

type CatalogManifestFile = CatalogManifest;

export interface CatalogTeamListQuery {
  kind?: CatalogTeamKind;
  category?: string;
  q?: string;
}

export interface CatalogTeamSourcePolicy {
  allowExternalSources?: boolean;
  allowUnpinnedOptionalSources?: boolean;
  allowLocalPathSources?: boolean;
}

export interface CatalogTeamActorContext {
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
}

export interface CatalogTeamImportOptions {
  targetManagerAgentId?: string | null;
  targetManagerSlug?: string | null;
  include?: Partial<CompanyPortabilityInclude>;
  agents?: CompanyPortabilityAgentSelection;
  collisionStrategy?: CompanyPortabilityCollisionStrategy;
  nameOverrides?: Record<string, string>;
  selectedFiles?: string[];
  adapterOverrides?: CompanyPortabilityImport["adapterOverrides"];
  secretValues?: CompanyPortabilityImport["secretValues"];
  sourcePolicy?: CatalogTeamSourcePolicy;
  actor?: CatalogTeamActorContext | null;
}

export type CatalogTeamSkillPreparationAction =
  | "already_in_package"
  | "catalog_install_required"
  | "external_import_required"
  | "blocked";

export interface CatalogTeamSkillPreparation {
  type: CatalogTeamSkillRequirementType;
  ref: string;
  agentSlugs: string[];
  action: CatalogTeamSkillPreparationAction;
  catalogSkillId: string | null;
  catalogSkillKey: string | null;
  sourceLocator: string | null;
  sourceRef: string | null;
  reason: string | null;
}

export interface CatalogTeamPreparedSource {
  team: CatalogTeam;
  source: CompanyPortabilitySource & { type: "inline" };
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
  errors: string[];
}

interface CatalogTargetManagerReference {
  agentId: string;
  slug: string;
}

export interface CatalogTeamImportPreviewResult {
  team: CatalogTeam;
  portabilityPreview: CompanyPortabilityPreviewResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
  errors: string[];
}

export interface CatalogTeamInstallResult {
  team: CatalogTeam;
  portabilityImport: CompanyPortabilityImportResult;
  skillPreparations: CatalogTeamSkillPreparation[];
  warnings: string[];
}

export interface InstalledCatalogTeam {
  catalogId: string;
  catalogKey: string | null;
  present: boolean;
  currentContentHash: string | null;
  installedOriginHashes: string[];
  agentCount: number;
  outOfDate: boolean;
}

export interface CatalogTeamFileDetail {
  catalogTeamId: string;
  path: string;
  kind: CatalogTeamFileKind;
  content: string;
  language: string | null;
  markdown: boolean;
}

const serviceDir = path.dirname(fileURLToPath(import.meta.url));
const catalogPackageRootCandidates = buildCatalogPackageRootCandidates();
let catalogPackageRoot = catalogPackageRootCandidates[0]!;
let catalogManifestPath = path.join(catalogPackageRoot, "generated/catalog.json");
let cachedCatalogManifest: {
  manifest: CatalogManifestFile;
  manifestPath: string;
  mtimeMs: number;
  size: number;
} | null = null;

function buildCatalogPackageRootCandidates() {
  const configuredRoot = process.env.PAPERCLIP_TEAMS_CATALOG_DIR?.trim();
  const candidates = [
    ...(configuredRoot ? [path.resolve(configuredRoot)] : []),
    path.resolve(process.cwd(), "packages/teams-catalog"),
    path.resolve(serviceDir, "../../..", "packages/teams-catalog"),
  ];
  return Array.from(new Set(candidates));
}

async function statCatalogManifest() {
  for (const candidateRoot of catalogPackageRootCandidates) {
    const candidateManifestPath = path.join(candidateRoot, "generated/catalog.json");
    try {
      const stats = await fs.stat(candidateManifestPath);
      catalogPackageRoot = candidateRoot;
      catalogManifestPath = candidateManifestPath;
      return { stats, manifestPath: candidateManifestPath };
    } catch {
      // Try the next known runtime layout before reporting all checked paths.
    }
  }
  throw new Error(
    `Teams catalog manifest not found. Checked: ${catalogPackageRootCandidates.map((root) => path.join(root, "generated/catalog.json")).join(", ")}. Run pnpm --filter @paperclipai/teams-catalog build:manifest.`,
  );
}

async function getCatalogManifest() {
  const { stats, manifestPath } = await statCatalogManifest();
  if (
    cachedCatalogManifest
    && cachedCatalogManifest.manifestPath === manifestPath
    && cachedCatalogManifest.mtimeMs === stats.mtimeMs
    && cachedCatalogManifest.size === stats.size
  ) {
    return cachedCatalogManifest.manifest;
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CatalogManifestFile;
  cachedCatalogManifest = {
    manifest,
    manifestPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  return manifest;
}

async function getCatalogTeams() {
  const manifest = await getCatalogManifest();
  return manifest.teams.map((team) => ({
    ...team,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
  }));
}

function searchText(team: CatalogTeam) {
  return [
    team.id,
    team.key,
    team.slug,
    team.name,
    team.description,
    team.category,
    team.kind,
    ...team.recommendedForCompanyTypes,
    ...team.tags,
  ].join("\n").toLowerCase();
}

export async function listCatalogTeams(query: CatalogTeamListQuery = {}): Promise<CatalogTeam[]> {
  const normalizedQuery = query.q?.trim().toLowerCase() ?? "";
  return (await getCatalogTeams())
    .filter((team) => !query.kind || team.kind === query.kind)
    .filter((team) => !query.category || team.category === query.category)
    .filter((team) => !normalizedQuery || searchText(team).includes(normalizedQuery))
    .sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

interface CatalogTeamProvenance {
  catalogId: string;
  catalogKey: string | null;
  originHash: string | null;
}

/**
 * Extract `metadata.paperclip.catalogTeam` provenance written by the team
 * importer (see `renderCatalogProvenanceYaml`). Returns null when the agent was
 * not installed from a catalog team.
 */
export function readCatalogTeamProvenance(
  metadata: Record<string, unknown> | null | undefined,
): CatalogTeamProvenance | null {
  if (!isPlainRecord(metadata)) return null;
  const paperclip = isPlainRecord(metadata.paperclip) ? metadata.paperclip : null;
  const catalogTeam = paperclip && isPlainRecord(paperclip.catalogTeam) ? paperclip.catalogTeam : null;
  if (!catalogTeam) return null;
  const catalogId = readNonEmptyString(catalogTeam.catalogId);
  if (!catalogId) return null;
  return {
    catalogId,
    catalogKey: readNonEmptyString(catalogTeam.catalogKey),
    originHash: readNonEmptyString(catalogTeam.originHash),
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveCatalogTeamReference(reference: string): Promise<{ team: CatalogTeam | null; ambiguous: boolean }> {
  const trimmed = reference.trim();
  if (!trimmed) return { team: null, ambiguous: false };
  const teams = await getCatalogTeams();

  const exact = teams.find((team) => team.id === trimmed || team.key === trimmed);
  if (exact) return { team: exact, ambiguous: false };

  const slugMatches = teams.filter((team) => team.slug === trimmed);
  if (slugMatches.length === 1) return { team: slugMatches[0]!, ambiguous: false };
  if (slugMatches.length > 1) return { team: null, ambiguous: true };
  return { team: null, ambiguous: false };
}

export async function getCatalogTeamOrThrow(reference: string): Promise<CatalogTeam> {
  const result = await resolveCatalogTeamReference(reference);
  if (result.ambiguous) {
    throw conflict(`Catalog team slug "${reference}" is ambiguous. Use an id or key.`);
  }
  if (!result.team) {
    throw notFound("Catalog team not found");
  }
  return result.team;
}

function isMarkdownPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  return fileName === "team.md" || fileName.endsWith(".md");
}

function inferLanguageFromPath(filePath: string) {
  const fileName = path.posix.basename(filePath).toLowerCase();
  if (fileName.endsWith(".md")) return "markdown";
  if (fileName.endsWith(".json")) return "json";
  if (fileName.endsWith(".yml") || fileName.endsWith(".yaml")) return "yaml";
  if (fileName.endsWith(".sh")) return "bash";
  if (fileName.endsWith(".ts")) return "typescript";
  if (fileName.endsWith(".tsx")) return "tsx";
  if (fileName.endsWith(".js")) return "javascript";
  if (fileName.endsWith(".jsx")) return "jsx";
  if (fileName.endsWith(".py")) return "python";
  return null;
}

function catalogTeamRoot(team: CatalogTeam) {
  return path.resolve(catalogPackageRoot, team.path);
}

function resolveCatalogTeamFile(team: CatalogTeam, relativePath: string) {
  const normalizedPath = normalizePortablePath(relativePath || team.entrypoint);
  const fileEntry = team.files.find((entry) => entry.path === normalizedPath);
  if (!fileEntry) {
    throw notFound("Catalog team file not found");
  }

  const teamRoot = catalogTeamRoot(team);
  const absolutePath = path.resolve(teamRoot, normalizedPath);
  if (absolutePath !== teamRoot && !absolutePath.startsWith(`${teamRoot}${path.sep}`)) {
    throw notFound("Catalog team file not found");
  }

  return { normalizedPath, fileEntry, absolutePath };
}

export async function readCatalogTeamFile(
  reference: string,
  relativePath = "TEAM.md",
): Promise<CatalogTeamFileDetail> {
  const team = await getCatalogTeamOrThrow(reference);
  const resolved = resolveCatalogTeamFile(team, relativePath);

  if (resolved.fileEntry.kind === "asset") {
    throw new HttpError(415, "Catalog team asset previews are not supported.");
  }

  const content = await fs.readFile(resolved.absolutePath, "utf8");
  return {
    catalogTeamId: team.id,
    path: resolved.normalizedPath,
    kind: resolved.fileEntry.kind,
    content,
    language: inferLanguageFromPath(resolved.normalizedPath),
    markdown: isMarkdownPath(resolved.normalizedPath),
  };
}

function yamlScalar(value: string | number | boolean | null) {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function renderStringArrayYaml(key: string, values: string[]) {
  if (values.length === 0) return [];
  return [
    `${key}:`,
    ...values.map((value) => `  - ${yamlScalar(value)}`),
  ];
}

function renderYamlBlock(value: unknown, indentLevel = 0): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        (Array.isArray(entry) && entry.length === 0) ||
        (isPlainRecord(entry) && Object.keys(entry).length === 0)
      ) {
        lines.push(`${indent}- ${yamlScalar(entry as string | number | boolean | null)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      if (
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        (Array.isArray(entry) && entry.length === 0) ||
        (isPlainRecord(entry) && Object.keys(entry).length === 0)
      ) {
        lines.push(`${indent}${key}: ${yamlScalar(entry as string | number | boolean | null)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${yamlScalar(String(value))}`];
}

function renderYamlFile(value: Record<string, unknown>) {
  return `${renderYamlBlock(value).join("\n")}\n`;
}

function renderSyntheticCompanyMarkdown(team: CatalogTeam) {
  const lines = [
    "---",
    `name: ${yamlScalar(team.name)}`,
    `description: ${yamlScalar(team.description)}`,
    "schema: agentcompanies/v1",
    `slug: ${yamlScalar(team.slug)}`,
    "includes:",
    "  - TEAM.md",
    "---",
    "",
    `# ${team.name}`,
    "",
    team.description,
    "",
  ];
  return lines.join("\n");
}

async function catalogProvenance(team: CatalogTeam) {
  const manifest = await getCatalogManifest();
  return {
    catalogId: team.id,
    catalogKey: team.key,
    catalogKind: team.kind,
    catalogCategory: team.category,
    catalogSlug: team.slug,
    packageName: manifest.packageName,
    packageVersion: manifest.packageVersion,
    originHash: team.contentHash,
  };
}

async function renderCatalogProvenanceYaml(team: CatalogTeam, targetManager: CatalogTargetManagerReference | null) {
  const provenance = await catalogProvenance(team);
  const agentSlugs = Array.from(new Set(team.agentSlugs)).sort();
  const projectSlugs = Array.from(new Set(team.projectSlugs)).sort();
  const taskSlugs = team.files
    .filter((file) => file.kind === "task")
    .map((file) => normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(file.path))))
    .filter((slug): slug is string => Boolean(slug));

  const renderEntity = (slug: string, opts?: { reparentRoot?: boolean }) => ({
    ...(opts?.reparentRoot && targetManager
      ? {
          reportsToExistingAgentId: targetManager.agentId,
          reportsToExistingAgentSlug: targetManager.slug,
        }
      : {}),
    metadata: {
      paperclip: {
        catalogTeam: {
          catalogId: provenance.catalogId,
          catalogKey: provenance.catalogKey,
          catalogKind: provenance.catalogKind,
          catalogCategory: provenance.catalogCategory,
          catalogSlug: provenance.catalogSlug,
          packageName: provenance.packageName,
          packageVersion: provenance.packageVersion,
          originHash: provenance.originHash,
        },
      },
    },
  });

  const extension: Record<string, unknown> = {
    schema: "paperclip/v1",
    agents: Object.fromEntries(agentSlugs.map((slug) => [
      slug,
      renderEntity(slug, {
        reparentRoot: Boolean(targetManager && team.rootAgentSlugs.includes(slug)),
      }),
    ])),
  };
  if (projectSlugs.length > 0) {
    extension.projects = Object.fromEntries(projectSlugs.map((slug) => [slug, renderEntity(slug)]));
  }
  if (taskSlugs.length > 0) {
    extension.tasks = Object.fromEntries(Array.from(new Set(taskSlugs)).sort().map((slug) => [slug, renderEntity(slug)]));
  }
  return renderYamlFile(extension);
}

function mergePlainRecords(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      merged[key] = mergePlainRecords(existing, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function parseYamlDocument(raw: string): Record<string, unknown> {
  return parseFrontmatterMarkdown(`---\n${raw.trim()}\n---\n`).frontmatter;
}

function renderSimpleMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(...renderStringArrayYaml(key, value.filter((entry): entry is string => typeof entry === "string")));
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null) {
      lines.push(`${key}: ${yamlScalar(value)}`);
    }
  }
  lines.push("---", "");
  const cleanBody = body.trim();
  if (cleanBody) lines.push(cleanBody, "");
  return lines.join("\n");
}

function collectCatalogSkillKeyMap(team: CatalogTeam) {
  const map = new Map<string, string>();
  for (const requirement of team.requiredSkills) {
    if (requirement.type !== "catalog" || !requirement.catalogSkillKey) continue;
    map.set(requirement.ref, requirement.catalogSkillKey);
    if (requirement.catalogSkillId) map.set(requirement.catalogSkillId, requirement.catalogSkillKey);
    map.set(requirement.catalogSkillKey, requirement.catalogSkillKey);
    const slug = requirement.catalogSkillKey.split("/").at(-1);
    if (slug) map.set(slug, requirement.catalogSkillKey);
  }
  return map;
}

function rewriteAgentCatalogSkillRefs(team: CatalogTeam, files: Record<string, CompanyPortabilityFileEntry>) {
  const keyMap = collectCatalogSkillKeyMap(team);
  if (keyMap.size === 0) return;
  for (const agentPath of Object.keys(files).filter((filePath) => filePath.endsWith("/AGENTS.md") || filePath === "AGENTS.md")) {
    const content = files[agentPath];
    if (typeof content !== "string") continue;
    const parsed = parseFrontmatterMarkdown(content);
    const skills = Array.isArray(parsed.frontmatter.skills)
      ? parsed.frontmatter.skills.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (skills.length === 0) continue;
    const rewritten = skills.map((skill) => keyMap.get(skill) ?? skill);
    if (rewritten.every((skill, index) => skill === skills[index])) continue;
    files[agentPath] = renderSimpleMarkdown({ ...parsed.frontmatter, skills: rewritten }, parsed.body);
  }
}

function preparation(
  requirement: CatalogTeamSkillRequirement,
  action: CatalogTeamSkillPreparationAction,
  reason: string | null = null,
): CatalogTeamSkillPreparation {
  return {
    type: requirement.type,
    ref: requirement.ref,
    agentSlugs: requirement.agentSlugs,
    action,
    catalogSkillId: requirement.catalogSkillId ?? null,
    catalogSkillKey: requirement.catalogSkillKey ?? null,
    sourceLocator: requirement.sourceLocator ?? null,
    sourceRef: requirement.sourceRef ?? null,
    reason,
  };
}

function isPinnedSourceRef(value: string | null | undefined) {
  return Boolean(value && /^[0-9a-f]{40}$/i.test(value.trim()));
}

export function collectCatalogTeamSkillPreparations(
  team: CatalogTeam,
  sourcePolicy: CatalogTeamSourcePolicy = {},
): { preparations: CatalogTeamSkillPreparation[]; warnings: string[]; errors: string[] } {
  const preparations: CatalogTeamSkillPreparation[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const requirement of team.requiredSkills) {
    if (!requirement.resolved) {
      const reason = `Skill requirement "${requirement.ref}" is unresolved in catalog manifest.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (requirement.type === "catalog") {
      preparations.push(preparation(requirement, "catalog_install_required"));
      continue;
    }

    if (requirement.type === "local") {
      preparations.push(preparation(requirement, "already_in_package"));
      continue;
    }

    if (requirement.type === "local_path" && !sourcePolicy.allowLocalPathSources) {
      const reason = `Local path skill source "${requirement.ref}" is development-only and is not allowed for catalog team install.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (requirement.type === "agent_package") {
      const reason = `Agent package skill source "${requirement.ref}" is declared but no safe resolver is available yet.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (!sourcePolicy.allowExternalSources) {
      const reason = `External skill source "${requirement.ref}" requires explicit source policy approval.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (team.kind === "bundled" && (requirement.type === "github" || requirement.type === "skills_sh") && !isPinnedSourceRef(requirement.sourceRef)) {
      const reason = `Bundled catalog team external skill source "${requirement.ref}" must be pinned to a commit.`;
      preparations.push(preparation(requirement, "blocked", reason));
      errors.push(reason);
      continue;
    }

    if (team.kind === "optional" && (requirement.type === "github" || requirement.type === "skills_sh") && !isPinnedSourceRef(requirement.sourceRef)) {
      const reason = `Optional catalog team external skill source "${requirement.ref}" is not pinned to a commit.`;
      if (!sourcePolicy.allowUnpinnedOptionalSources) {
        preparations.push(preparation(requirement, "blocked", reason));
        errors.push(reason);
        continue;
      }
      warnings.push(reason);
    }

    preparations.push(preparation(requirement, "external_import_required"));
  }

  return { preparations, warnings, errors };
}

async function readCatalogTeamSourceFiles(team: CatalogTeam): Promise<Record<string, CompanyPortabilityFileEntry>> {
  const files: Record<string, CompanyPortabilityFileEntry> = {
    "COMPANY.md": renderSyntheticCompanyMarkdown(team),
  };
  for (const file of team.files) {
    const resolved = resolveCatalogTeamFile(team, file.path);
    const normalizedPath = normalizePortablePath(file.path);
    if (file.kind === "asset") {
      const data = await fs.readFile(resolved.absolutePath);
      files[normalizedPath] = {
        encoding: "base64",
        data: data.toString("base64"),
      };
      continue;
    }
    files[normalizedPath] = await fs.readFile(resolved.absolutePath, "utf8");
  }
  return files;
}

/**
 * Default safe adapter for catalog agents imported through the agent-safe path.
 */
const FALLBACK_SAFE_CATALOG_ADAPTER_TYPE = "claude_local";

function defaultSafeCatalogAdapterType() {
  return process.env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE?.trim() || FALLBACK_SAFE_CATALOG_ADAPTER_TYPE;
}

/**
 * Maps short model aliases used in catalog AGENTS.md frontmatter (`model: opus`, `model: sonnet`)
 * to canonical `claude_local` adapter model IDs. These are only injected when the default adapter
 * type is `claude_local` — opencode_local uses a different model ID format.
 */
const CATALOG_MODEL_ALIAS: Record<string, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
};

/**
 * Reads the `model` frontmatter field from each agent's `AGENTS.md` in the catalog source files
 * and resolves it to a `claude_local` model ID via `CATALOG_MODEL_ALIAS`. Slugs without a
 * recognized alias are omitted from the result.
 */
function readCatalogAgentModelHints(
  files: Record<string, CompanyPortabilityFileEntry>,
  agentSlugs: string[],
): Record<string, string> {
  const hints: Record<string, string> = {};
  for (const slug of agentSlugs) {
    const content = files[`agents/${slug}/AGENTS.md`];
    if (typeof content !== "string") continue;
    const modelAlias = asString(parseFrontmatterMarkdown(content).frontmatter.model);
    if (!modelAlias) continue;
    const resolved = CATALOG_MODEL_ALIAS[modelAlias];
    if (resolved) hints[slug] = resolved;
  }
  return hints;
}

/**
 * Bundled catalog agents declare no adapter in their `AGENTS.md` frontmatter, so
 * `parsePortableAgentFrontmatter` defaults them to `process` — which the
 * `agent_safe` importer rejects (see `IMPORT_FORBIDDEN_ADAPTER_TYPES` in
 * `company-portability`). Inject a safe per-agent adapter default for every
 * catalog agent the caller did not explicitly override so default-trust teams
 * install without manual adapter flags. Explicit caller overrides win and are
 * left untouched (both `adapterType` and `adapterConfig`). This is scoped to the
 * catalog install path; the generic portability fallback is unchanged.
 *
 * When `catalogModelHints` is supplied and the default adapter is `claude_local`,
 * model IDs from the catalog's `AGENTS.md` frontmatter are included in the
 * generated `adapterConfig` so each role runs on its declared model tier.
 */
function withSafeCatalogAdapterDefaults(
  agentSlugs: string[],
  callerOverrides: CompanyPortabilityImport["adapterOverrides"],
  defaultAdapterType: string,
  catalogModelHints: Record<string, string> = {},
): Record<string, CompanyPortabilityAdapterOverride> {
  const merged: Record<string, CompanyPortabilityAdapterOverride> = { ...(callerOverrides ?? {}) };
  for (const slug of agentSlugs) {
    if (merged[slug]) continue;
    const modelId = defaultAdapterType === "claude_local" ? catalogModelHints[slug] : undefined;
    merged[slug] = modelId
      ? { adapterType: defaultAdapterType, adapterConfig: { model: modelId } }
      : { adapterType: defaultAdapterType };
  }
  return merged;
}

function buildPortabilityInput(
  companyId: string,
  source: CompanyPortabilitySource,
  options: CatalogTeamImportOptions,
): CompanyPortabilityPreview {
  const requestedInclude = options.include ?? {};
  return {
    source,
    include: {
      agents: true,
      projects: true,
      issues: true,
      skills: true,
      ...requestedInclude,
      company: false,
    },
    target: {
      mode: "existing_company",
      companyId,
    },
    agents: options.agents,
    collisionStrategy: options.collisionStrategy ?? "rename",
    nameOverrides: options.nameOverrides,
    selectedFiles: options.selectedFiles,
  };
}

export function teamsCatalogService(db: Db) {
  const portability = companyPortabilityService(db);
  const companySkills = companySkillService(db);
  const agents = agentService(db);

  async function resolveTargetManagerReference(
    companyId: string,
    options: CatalogTeamImportOptions,
  ): Promise<CatalogTargetManagerReference | null> {
    if (options.targetManagerSlug) {
      const slug = normalizeAgentUrlKey(options.targetManagerSlug);
      if (!slug) throw unprocessable("Target manager slug is invalid.");
      const managers = await agents.list(companyId);
      const manager = managers.find((candidate) => normalizeAgentUrlKey(candidate.name) === slug);
      if (!manager) throw notFound("Target manager agent not found");
      return { agentId: manager.id, slug };
    }
    if (!options.targetManagerAgentId) return null;
    const manager = await agents.getById(options.targetManagerAgentId);
    if (!manager) throw notFound("Target manager agent not found");
    if (manager.companyId !== companyId) {
      throw forbidden("Target manager agent must belong to the target company.");
    }
    return {
      agentId: manager.id,
      slug: normalizeAgentUrlKey(manager.name) ?? manager.id,
    };
  }

  async function prepareCatalogTeamSource(
    companyId: string,
    catalogRef: string,
    options: CatalogTeamImportOptions = {},
  ): Promise<CatalogTeamPreparedSource> {
    const team = await getCatalogTeamOrThrow(catalogRef);
    const warnings: string[] = [];
    const errors: string[] = [];

    if (team.compatibility !== "compatible") {
      errors.push(`Catalog team ${team.id} is not compatible.`);
    }
    if (team.trustLevel === "scripts_executables") {
      errors.push(`Catalog team ${team.id} contains executable scripts and cannot be installed by the safe team importer.`);
    }
    if (team.trustLevel === "external_sources" && !options.sourcePolicy?.allowExternalSources) {
      errors.push(`Catalog team ${team.id} declares external sources and requires explicit source policy approval.`);
    }

    const skillPrep = collectCatalogTeamSkillPreparations(team, options.sourcePolicy);
    warnings.push(...skillPrep.warnings);
    errors.push(...skillPrep.errors);

    const targetManager = await resolveTargetManagerReference(companyId, options);
    const files = await readCatalogTeamSourceFiles(team);
    const existingExtension =
      typeof files[".paperclip.yaml"] === "string"
        ? parseYamlDocument(files[".paperclip.yaml"])
        : {};
    const generatedExtension = parseYamlDocument(await renderCatalogProvenanceYaml(team, targetManager));
    files[".paperclip.yaml"] = renderYamlFile(mergePlainRecords(existingExtension, generatedExtension));
    rewriteAgentCatalogSkillRefs(team, files);

    return {
      team,
      source: {
        type: "inline",
        files,
      },
      skillPreparations: skillPrep.preparations,
      warnings,
      errors,
    };
  }

  async function logCatalogEvent(
    action: string,
    companyId: string,
    team: CatalogTeam,
    actor: CatalogTeamActorContext | null | undefined,
    details: Record<string, unknown>,
  ) {
    if (!actor) return;
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId ?? null,
      runId: actor.runId ?? null,
      action,
      entityType: "company",
      entityId: companyId,
      details: {
        catalogId: team.id,
        catalogKey: team.key,
        catalogKind: team.kind,
        originHash: team.contentHash,
        ...details,
      },
    });
  }

  async function previewCatalogTeamImport(
    companyId: string,
    catalogRef: string,
    options: CatalogTeamImportOptions = {},
  ): Promise<CatalogTeamImportPreviewResult> {
    const prepared = await prepareCatalogTeamSource(companyId, catalogRef, options);
    const previewInput = buildPortabilityInput(companyId, prepared.source, options);
    const portabilityPreview = await portability.previewImport(previewInput, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    portabilityPreview.warnings.push(...prepared.warnings);
    portabilityPreview.errors.push(...prepared.errors);
    await logCatalogEvent("company.team_catalog_previewed", companyId, prepared.team, options.actor, {
      warningCount: portabilityPreview.warnings.length,
      errorCount: portabilityPreview.errors.length,
    });
    return {
      team: prepared.team,
      portabilityPreview,
      skillPreparations: prepared.skillPreparations,
      warnings: portabilityPreview.warnings,
      errors: portabilityPreview.errors,
    };
  }

  async function prepareSkillInstalls(companyId: string, prepared: CatalogTeamPreparedSource) {
    const warnings: string[] = [];
    for (const skill of prepared.skillPreparations) {
      if (skill.action === "blocked") {
        warnings.push(skill.reason ?? `Catalog team skill source ${skill.ref} is blocked.`);
        continue;
      }
      if (skill.action === "catalog_install_required") {
        if (!skill.catalogSkillId) {
          warnings.push(`Catalog skill requirement ${skill.ref} is missing catalogSkillId.`);
          continue;
        }
        try {
          const result = await companySkills.installFromCatalog(companyId, {
            catalogSkillId: skill.catalogSkillId,
          });
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`Catalog skill requirement ${skill.ref} could not be installed after team import: ${formatError(error)}`);
        }
        continue;
      }
      if (skill.action === "external_import_required") {
        const source = skill.sourceLocator ?? skill.ref;
        try {
          const result = await companySkills.importFromSource(companyId, source);
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`External skill source ${source} could not be imported after team import: ${formatError(error)}`);
        }
      }
    }
    return warnings;
  }

  async function installCatalogTeam(
    companyId: string,
    catalogRef: string,
    options: CatalogTeamImportOptions = {},
  ): Promise<CatalogTeamInstallResult> {
    const prepared = await prepareCatalogTeamSource(companyId, catalogRef, options);
    if (prepared.errors.length > 0) {
      throw unprocessable(`Catalog team source preparation failed: ${prepared.errors.join("; ")}`);
    }

    const defaultAdapterType = defaultSafeCatalogAdapterType();
    const catalogModelHints = readCatalogAgentModelHints(
      prepared.source.files,
      prepared.team.agentSlugs,
    );
    const importInput: CompanyPortabilityImport = {
      ...buildPortabilityInput(companyId, prepared.source, options),
      adapterOverrides: withSafeCatalogAdapterDefaults(
        prepared.team.agentSlugs,
        options.adapterOverrides,
        defaultAdapterType,
        catalogModelHints,
      ),
      secretValues: options.secretValues,
    };
    const importPreview = await portability.previewImport(importInput, {
      mode: "agent_safe",
      sourceCompanyId: companyId,
    });
    if (importPreview.errors.length > 0) {
      throw unprocessable(`Catalog team import preview has errors: ${importPreview.errors.join("; ")}`);
    }
    const defaultedAdapterSlugs = prepared.team.agentSlugs.filter(
      (slug) => !options.adapterOverrides?.[slug],
    );
    const warnings = [
      ...prepared.warnings,
      ...importPreview.warnings,
      ...(defaultedAdapterSlugs.length > 0
        ? [
            `Catalog agents without explicit overrides (${defaultedAdapterSlugs.join(", ")}) default to ${defaultAdapterType}. Pass adapterOverrides or PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE to use a different supported adapter.`,
          ]
        : []),
    ];
    const result = await portability.importBundle(
      importInput,
      options.actor?.userId ?? (options.actor?.actorType === "user" ? options.actor.actorId : null),
      {
        mode: "agent_safe",
        sourceCompanyId: companyId,
      },
    );
    warnings.push(...await prepareSkillInstalls(companyId, prepared));
    result.warnings.push(...warnings);
    await logCatalogEvent("company.team_catalog_installed", companyId, prepared.team, options.actor, {
      warningCount: result.warnings.length,
      agentCount: result.agents.length,
      projectCount: result.projects.length,
      skillPreparationCount: prepared.skillPreparations.length,
    });
    return {
      team: prepared.team,
      portabilityImport: result,
      skillPreparations: prepared.skillPreparations,
      warnings: result.warnings,
    };
  }

  /**
   * Compare each company agent's installed catalog-team provenance against the
   * live catalog. Drives the Team Catalog `INSTALLED · N` group and the
   * out-of-date badge from a real server signal (design
   * [PAP-10238 §3.2 + §5]).
   */
  async function listInstalledCatalogTeams(companyId: string): Promise<InstalledCatalogTeam[]> {
    const companyAgents = await agents.list(companyId);
    const currentTeams = await getCatalogTeams();
    const currentById = new Map(currentTeams.map((team) => [team.id, team]));

    type Aggregate = {
      catalogId: string;
      catalogKey: string | null;
      originHashes: Set<string>;
      agentCount: number;
    };
    const byCatalogId = new Map<string, Aggregate>();

    for (const agent of companyAgents) {
      const provenance = readCatalogTeamProvenance(
        agent.metadata as Record<string, unknown> | null,
      );
      if (!provenance) continue;
      let entry = byCatalogId.get(provenance.catalogId);
      if (!entry) {
        entry = {
          catalogId: provenance.catalogId,
          catalogKey: provenance.catalogKey,
          originHashes: new Set<string>(),
          agentCount: 0,
        };
        byCatalogId.set(provenance.catalogId, entry);
      }
      entry.agentCount += 1;
      if (!entry.catalogKey && provenance.catalogKey) entry.catalogKey = provenance.catalogKey;
      if (provenance.originHash) entry.originHashes.add(provenance.originHash);
    }

    return Array.from(byCatalogId.values())
      .map((entry) => {
        const current = currentById.get(entry.catalogId) ?? null;
        const currentContentHash = current?.contentHash ?? null;
        const installedOriginHashes = Array.from(entry.originHashes).sort();
        const present = Boolean(current);
        const outOfDate = present
          && currentContentHash !== null
          && installedOriginHashes.length > 0
          && installedOriginHashes.some((hash) => hash !== currentContentHash);
        return {
          catalogId: entry.catalogId,
          catalogKey: entry.catalogKey ?? current?.key ?? null,
          present,
          currentContentHash,
          installedOriginHashes,
          agentCount: entry.agentCount,
          outOfDate,
        } satisfies InstalledCatalogTeam;
      })
      .sort((left, right) => left.catalogId.localeCompare(right.catalogId));
  }

  return {
    listCatalogTeams,
    getCatalogTeamOrThrow,
    readCatalogTeamFile,
    prepareCatalogTeamSource,
    previewCatalogTeamImport,
    installCatalogTeam,
    listInstalledCatalogTeams,
  };
}
