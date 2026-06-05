import { existsSync, readFileSync, statSync } from "node:fs";
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
const repoRoot = path.resolve(serviceDir, "../../..");
const catalogPackageRoot = path.join(repoRoot, "packages/teams-catalog");
const catalogManifestPath = path.join(catalogPackageRoot, "generated/catalog.json");
let cachedCatalogManifest: {
  manifest: CatalogManifestFile;
  mtimeMs: number;
  size: number;
} | null = null;

function loadCatalogManifest(): CatalogManifestFile {
  if (!existsSync(catalogManifestPath)) {
    throw new Error(
      `Teams catalog manifest not found at ${catalogManifestPath}. Run pnpm --filter @paperclipai/teams-catalog build:manifest.`,
    );
  }
  return JSON.parse(readFileSync(catalogManifestPath, "utf8")) as CatalogManifestFile;
}

function getCatalogManifest() {
  if (!existsSync(catalogManifestPath)) {
    throw new Error(
      `Teams catalog manifest not found at ${catalogManifestPath}. Run pnpm --filter @paperclipai/teams-catalog build:manifest.`,
    );
  }
  const stats = statSync(catalogManifestPath);
  if (
    cachedCatalogManifest
    && cachedCatalogManifest.mtimeMs === stats.mtimeMs
    && cachedCatalogManifest.size === stats.size
  ) {
    return cachedCatalogManifest.manifest;
  }

  const manifest = loadCatalogManifest();
  cachedCatalogManifest = {
    manifest,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  return manifest;
}

function getCatalogTeams() {
  const manifest = getCatalogManifest();
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

export function listCatalogTeams(query: CatalogTeamListQuery = {}): CatalogTeam[] {
  const normalizedQuery = query.q?.trim().toLowerCase() ?? "";
  return getCatalogTeams()
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

export function resolveCatalogTeamReference(reference: string): { team: CatalogTeam | null; ambiguous: boolean } {
  const trimmed = reference.trim();
  if (!trimmed) return { team: null, ambiguous: false };
  const teams = getCatalogTeams();

  const exact = teams.find((team) => team.id === trimmed || team.key === trimmed);
  if (exact) return { team: exact, ambiguous: false };

  const slugMatches = teams.filter((team) => team.slug === trimmed);
  if (slugMatches.length === 1) return { team: slugMatches[0]!, ambiguous: false };
  if (slugMatches.length > 1) return { team: null, ambiguous: true };
  return { team: null, ambiguous: false };
}

export function getCatalogTeamOrThrow(reference: string): CatalogTeam {
  const result = resolveCatalogTeamReference(reference);
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
  const team = getCatalogTeamOrThrow(reference);
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

function catalogProvenance(team: CatalogTeam) {
  const manifest = getCatalogManifest();
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

function renderCatalogProvenanceYaml(team: CatalogTeam, targetManager: CatalogTargetManagerReference | null) {
  const provenance = catalogProvenance(team);
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

interface MarkdownDoc {
  frontmatter: Record<string, unknown>;
  body: string;
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

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const lines = raw
    .split("\n")
    .map((line) => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      content: line.trim(),
    }))
    .filter((line) => line.content.length > 0 && !line.content.startsWith("#"));
  if (lines.length === 0) return {};
  const parsed = parseYamlBlock(lines, 0, lines[0]!.indent);
  return isPlainRecord(parsed.value) ? parsed.value : {};
}

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
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
    if (remainder) {
      record[key] = parseYamlScalar(remainder);
      continue;
    }
    const nested = parseYamlBlock(lines, index, indentLevel + 2);
    record[key] = nested.value;
    index = nested.nextIndex;
  }
  return { value: record, nextIndex: index };
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
  return {
    frontmatter: parseYamlFrontmatter(normalized.slice(4, closing).trim()),
    body: normalized.slice(closing + 5).trim(),
  };
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
const DEFAULT_SAFE_CATALOG_ADAPTER_TYPE = "claude_local";

/**
 * Bundled catalog agents declare no adapter in their `AGENTS.md` frontmatter, so
 * `parsePortableAgentFrontmatter` defaults them to `process` — which the
 * `agent_safe` importer rejects (see `IMPORT_FORBIDDEN_ADAPTER_TYPES` in
 * `company-portability`). Inject a safe per-agent adapter default for every
 * catalog agent the caller did not explicitly override so default-trust teams
 * install without manual adapter flags. Explicit caller overrides win and are
 * left untouched (both `adapterType` and `adapterConfig`). This is scoped to the
 * catalog install path; the generic portability fallback is unchanged.
 */
function withSafeCatalogAdapterDefaults(
  agentSlugs: string[],
  callerOverrides: CompanyPortabilityImport["adapterOverrides"],
): Record<string, CompanyPortabilityAdapterOverride> {
  const merged: Record<string, CompanyPortabilityAdapterOverride> = { ...(callerOverrides ?? {}) };
  for (const slug of agentSlugs) {
    if (merged[slug]) continue;
    merged[slug] = { adapterType: DEFAULT_SAFE_CATALOG_ADAPTER_TYPE };
  }
  return merged;
}

function buildPortabilityInput(
  companyId: string,
  source: CompanyPortabilitySource,
  options: CatalogTeamImportOptions,
): CompanyPortabilityPreview {
  return {
    source,
    include: {
      company: false,
      agents: true,
      projects: true,
      issues: true,
      skills: true,
      ...(options.include ?? {}),
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
    const team = getCatalogTeamOrThrow(catalogRef);
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
        ? parseYamlFrontmatter(files[".paperclip.yaml"])
        : {};
    const generatedExtension = parseYamlFrontmatter(renderCatalogProvenanceYaml(team, targetManager));
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
        throw unprocessable(skill.reason ?? `Catalog team skill source ${skill.ref} is blocked.`);
      }
      if (skill.action === "catalog_install_required") {
        if (!skill.catalogSkillId) throw unprocessable(`Catalog skill requirement ${skill.ref} is missing catalogSkillId.`);
        const result = await companySkills.installFromCatalog(companyId, {
          catalogSkillId: skill.catalogSkillId,
        });
        warnings.push(...result.warnings);
        continue;
      }
      if (skill.action === "external_import_required") {
        const source = skill.sourceLocator ?? skill.ref;
        const result = await companySkills.importFromSource(companyId, source);
        warnings.push(...result.warnings);
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

    const warnings = [
      ...prepared.warnings,
      ...await prepareSkillInstalls(companyId, prepared),
    ];
    const importInput: CompanyPortabilityImport = {
      ...buildPortabilityInput(companyId, prepared.source, options),
      adapterOverrides: withSafeCatalogAdapterDefaults(
        prepared.team.agentSlugs,
        options.adapterOverrides,
      ),
      secretValues: options.secretValues,
    };
    const result = await portability.importBundle(
      importInput,
      options.actor?.userId ?? (options.actor?.actorType === "user" ? options.actor.actorId : null),
      {
        mode: "agent_safe",
        sourceCompanyId: companyId,
      },
    );
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
    const currentTeams = getCatalogTeams();
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
