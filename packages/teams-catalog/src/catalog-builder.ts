import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  asBoolean,
  asString,
  asStringArray,
  isPlainRecord,
  parseFrontmatterMarkdown,
} from "./frontmatter.js";
import type {
  CatalogManifest,
  CatalogTeam,
  CatalogTeamEnvInputSummary,
  CatalogTeamFile,
  CatalogTeamFileKind,
  CatalogTeamKind,
  CatalogTeamSkillRequirement,
  CatalogTeamSkillRequirementType,
  CatalogTeamSourceRef,
  CatalogTeamTrustLevel,
} from "./types.js";

const CATALOG_PACKAGE_NAME = "@paperclipai/teams-catalog";
const CATALOG_SCHEMA_VERSION = 1;
const TEAM_ENTRYPOINT = "TEAM.md";
const MAX_CATALOG_FILE_BYTES = 1024 * 1024;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_KINDS = new Set<CatalogTeamKind>(["bundled", "optional"]);
const TEAM_SCHEMA = "agentcompanies/v1";
const LOCAL_PATH_SOURCE_TYPES = new Set(["local_path"]);
const EXTERNAL_SOURCE_TYPES = new Set(["skills_sh", "github", "url", "agent_package"]);

interface TeamCandidate {
  kind: CatalogTeamKind;
  category: string;
  slug: string;
  absolutePath: string;
}

interface CatalogSkillSummary {
  id: string;
  key: string;
  slug: string;
}

interface BuildCatalogManifestOptions {
  packageDir: string;
  generatedAt?: string;
  catalogSkills?: CatalogSkillSummary[];
}

interface BuildCatalogManifestResult {
  manifest: CatalogManifest;
  errors: string[];
}

interface ParsedTeamFile {
  relativePath: string;
  frontmatter: Record<string, unknown>;
  hasFrontmatter: boolean;
}

interface TeamPackageGraph {
  agents: ParsedTeamFile[];
  projects: ParsedTeamFile[];
  tasks: ParsedTeamFile[];
  skills: ParsedTeamFile[];
}

export function formatCatalogManifest(manifest: CatalogManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function buildExpectedCatalogManifest(
  packageDir: string,
): Promise<BuildCatalogManifestResult> {
  const existing = await readExistingManifest(packageDir);
  const firstPass = await buildCatalogManifest({
    packageDir,
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
  });

  if (existing && sameManifestExceptGeneratedAt(existing, firstPass.manifest)) {
    return firstPass;
  }

  return buildCatalogManifest({
    packageDir,
    generatedAt: new Date().toISOString(),
  });
}

export async function buildCatalogManifest(
  options: BuildCatalogManifestOptions,
): Promise<BuildCatalogManifestResult> {
  const packageDir = path.resolve(options.packageDir);
  const packageJson = await readPackageJson(packageDir);
  const errors: string[] = [];
  const catalogSkills = options.catalogSkills ?? await loadCatalogSkills(packageDir, errors);
  const candidates = await discoverTeamCandidates(packageDir, errors);
  const teams: CatalogTeam[] = [];

  collectCandidateUniquenessErrors(candidates, errors);

  for (const candidate of candidates) {
    const team = await buildCatalogTeam(packageDir, candidate, catalogSkills, errors);
    if (team) teams.push(team);
  }

  teams.sort((a, b) => a.id.localeCompare(b.id));
  collectUniquenessErrors(teams, errors);

  return {
    manifest: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageName: CATALOG_PACKAGE_NAME,
      packageVersion: packageJson.version,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      teams,
    },
    errors,
  };
}

export async function validateCatalog(packageDir: string): Promise<BuildCatalogManifestResult> {
  const expected = await buildExpectedCatalogManifest(packageDir);
  const generatedPath = path.join(packageDir, "generated", "catalog.json");
  const errors = [...expected.errors];

  let generatedText: string | null = null;
  try {
    generatedText = await fs.readFile(generatedPath, "utf8");
    JSON.parse(generatedText);
  } catch (error) {
    errors.push(`generated/catalog.json is missing or invalid: ${errorMessage(error)}`);
  }

  if (generatedText !== null) {
    const expectedText = formatCatalogManifest(expected.manifest);
    if (generatedText !== expectedText) {
      errors.push("generated/catalog.json is stale. Run pnpm --filter @paperclipai/teams-catalog build:manifest.");
    }
  }

  return {
    manifest: expected.manifest,
    errors,
  };
}

export async function writeCatalogManifest(packageDir: string) {
  const result = await buildExpectedCatalogManifest(packageDir);
  if (result.errors.length > 0) return result;

  const generatedDir = path.join(packageDir, "generated");
  await fs.mkdir(generatedDir, { recursive: true });
  await fs.writeFile(path.join(generatedDir, "catalog.json"), formatCatalogManifest(result.manifest), "utf8");
  return result;
}

async function readPackageJson(packageDir: string) {
  const packageJsonPath = path.join(packageDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as { version?: unknown };
  const version = asString(packageJson.version);
  if (!version) throw new Error(`${packageJsonPath} must declare a package version.`);
  return { version };
}

async function readExistingManifest(packageDir: string): Promise<CatalogManifest | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(packageDir, "generated", "catalog.json"), "utf8")) as CatalogManifest;
  } catch {
    return null;
  }
}

async function loadCatalogSkills(packageDir: string, errors: string[]): Promise<CatalogSkillSummary[]> {
  try {
    const catalogPackageName = "@paperclipai/skills-catalog";
    const catalog = await import(catalogPackageName) as { catalogSkills: CatalogSkillSummary[] };
    const skills = catalog.catalogSkills as CatalogSkillSummary[];
    return skills.map((skill) => ({ id: skill.id, key: skill.key, slug: skill.slug }));
  } catch {
    const siblingManifestPath = path.resolve(packageDir, "..", "skills-catalog", "generated", "catalog.json");
    try {
      const manifest = JSON.parse(await fs.readFile(siblingManifestPath, "utf8")) as { skills?: CatalogSkillSummary[] };
      return (manifest.skills ?? []).map((skill) => ({ id: skill.id, key: skill.key, slug: skill.slug }));
    } catch (error) {
      errors.push(`Could not load @paperclipai/skills-catalog for skill requirement validation: ${errorMessage(error)}`);
      return [];
    }
  }
}

async function discoverTeamCandidates(packageDir: string, errors: string[]) {
  const catalogDir = path.join(packageDir, "catalog");
  const candidates: TeamCandidate[] = [];

  if (!existsSync(catalogDir)) {
    errors.push("catalog directory is missing.");
    return candidates;
  }

  await collectMisplacedTeamFiles(catalogDir, errors);

  for (const kind of ["bundled", "optional"] as const) {
    const kindDir = path.join(catalogDir, kind);
    if (!existsSync(kindDir)) continue;

    for (const categoryEntry of await sortedDirEntries(kindDir)) {
      if (!categoryEntry.isDirectory()) continue;
      const category = categoryEntry.name;
      const categoryDir = path.join(kindDir, category);

      for (const slugEntry of await sortedDirEntries(categoryDir)) {
        if (!slugEntry.isDirectory()) continue;
        const slug = slugEntry.name;
        const teamDir = path.join(categoryDir, slug);
        if (!existsSync(path.join(teamDir, TEAM_ENTRYPOINT))) {
          errors.push(`${relativePackagePath(packageDir, teamDir)} is missing TEAM.md.`);
          continue;
        }
        candidates.push({ kind, category, slug, absolutePath: teamDir });
      }
    }
  }

  return candidates;
}

async function collectMisplacedTeamFiles(catalogDir: string, errors: string[]) {
  async function visit(dir: string) {
    for (const entry of await sortedDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.name !== TEAM_ENTRYPOINT) continue;

      const relativePath = toPosixPath(path.relative(catalogDir, absolutePath));
      const parts = relativePath.split("/");
      const kind = parts[0];
      if (parts.length !== 4 || !CATALOG_KINDS.has(kind as CatalogTeamKind)) {
        errors.push(`catalog/${relativePath} is not under catalog/<bundled|optional>/<category>/<slug>/TEAM.md.`);
      }
    }
  }

  await visit(catalogDir);
}

async function buildCatalogTeam(
  packageDir: string,
  candidate: TeamCandidate,
  catalogSkills: CatalogSkillSummary[],
  errors: string[],
): Promise<CatalogTeam | null> {
  const prefix = relativePackagePath(packageDir, candidate.absolutePath);
  validateSlug("category", candidate.category, prefix, errors);
  validateSlug("slug", candidate.slug, prefix, errors);

  const id = `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
  const key = `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`;
  const teamMarkdownPath = path.join(candidate.absolutePath, TEAM_ENTRYPOINT);
  const parsed = parseFrontmatterMarkdown(await fs.readFile(teamMarkdownPath, "utf8"));

  if (!parsed.hasFrontmatter) {
    errors.push(`${prefix}/TEAM.md must start with YAML frontmatter.`);
  }

  const name = asString(parsed.frontmatter.name);
  if (!name) errors.push(`${prefix}/TEAM.md frontmatter must include name.`);

  const description = asString(parsed.frontmatter.description);
  if (!description) errors.push(`${prefix}/TEAM.md frontmatter must include description.`);

  const schema = asString(parsed.frontmatter.schema);
  if (schema !== TEAM_SCHEMA) {
    errors.push(`${prefix}/TEAM.md schema must be ${TEAM_SCHEMA}.`);
  }

  const explicitKey = asString(parsed.frontmatter.key);
  if (explicitKey && explicitKey !== key) {
    errors.push(`${prefix}/TEAM.md key must be ${key}.`);
  }

  const explicitSlug = asString(parsed.frontmatter.slug);
  if (explicitSlug && explicitSlug !== candidate.slug) {
    errors.push(`${prefix}/TEAM.md slug must be ${candidate.slug}.`);
  }

  const explicitCategory = asString(parsed.frontmatter.category);
  if (explicitCategory && explicitCategory !== candidate.category) {
    errors.push(`${prefix}/TEAM.md category must be ${candidate.category}.`);
  }

  const defaultInstall = asBoolean(parsed.frontmatter.defaultInstall) ?? false;
  const recommendedForCompanyTypes = readStringArrayField(
    parsed.frontmatter.recommendedForCompanyTypes,
    "recommendedForCompanyTypes",
    prefix,
    errors,
  );
  const tags = readStringArrayField(parsed.frontmatter.tags, "tags", prefix, errors);
  const files = await collectTeamFiles(packageDir, candidate.absolutePath, prefix, errors);
  const graph = await readTeamPackageGraph(candidate.absolutePath, errors);
  const agentSlugs = collectSlugs(graph.agents, "agent", errors);
  const projectSlugs = collectSlugs(graph.projects, "project", errors);
  const taskRecords = graph.tasks.map((task) => ({
    slug: readSlug(task, "task", errors),
    recurring: asBoolean(task.frontmatter.recurring) ?? false,
    assignee: asString(task.frontmatter.assignee),
    project: asString(task.frontmatter.project),
    path: task.relativePath,
  }));
  const localSkillSlugs = collectSlugs(graph.skills, "skill", errors);
  const rootAgentSlugs = validateLocalReferences(candidate.absolutePath, parsed.frontmatter, graph, agentSlugs, projectSlugs, errors);
  const requiredSkills = collectRequiredSkills(candidate.absolutePath, parsed.frontmatter, graph, catalogSkills, agentSlugs, localSkillSlugs, errors);
  const envInputs = collectEnvInputs(graph);
  const sourceRefs = collectSourceRefs(parsed.frontmatter, requiredSkills);
  const catalogSkillCount = new Set(requiredSkills.filter((skill) => skill.type === "catalog").map((skill) => skill.catalogSkillId ?? skill.ref)).size;

  if (!name || !description || schema !== TEAM_SCHEMA) return null;

  return {
    id,
    key,
    kind: candidate.kind,
    category: candidate.category,
    slug: candidate.slug,
    name,
    description,
    path: toPosixPath(path.relative(packageDir, candidate.absolutePath)),
    entrypoint: TEAM_ENTRYPOINT,
    schema: TEAM_SCHEMA,
    defaultInstall,
    recommendedForCompanyTypes,
    tags,
    counts: {
      agents: graph.agents.length,
      projects: graph.projects.length,
      tasks: taskRecords.filter((task) => !task.recurring).length,
      routines: taskRecords.filter((task) => task.recurring).length,
      localSkills: graph.skills.length,
      catalogSkills: catalogSkillCount,
      externalSkillSources: sourceRefs.filter((ref) => ref.type !== "include").length,
    },
    rootAgentSlugs,
    agentSlugs: agentSlugs.sort(),
    projectSlugs: projectSlugs.sort(),
    requiredSkills,
    envInputs,
    sourceRefs,
    files,
    trustLevel: deriveTrustLevel(files, sourceRefs),
    compatibility: "compatible",
    contentHash: buildContentHash(files),
  };
}

async function collectTeamFiles(
  packageDir: string,
  teamDir: string,
  prefix: string,
  errors: string[],
): Promise<CatalogTeamFile[]> {
  const files: CatalogTeamFile[] = [];
  const teamRoot = await fs.realpath(teamDir);

  async function visit(dir: string) {
    for (const entry of await sortedDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name);
      const lstat = await fs.lstat(absolutePath);
      let stat = lstat;
      let realPath = absolutePath;

      if (lstat.isSymbolicLink()) {
        try {
          realPath = await fs.realpath(absolutePath);
          stat = await fs.stat(absolutePath);
        } catch {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} is a broken symlink.`);
          continue;
        }
        if (!isPathInside(teamRoot, realPath)) {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} points outside its team directory.`);
          continue;
        }
        if (stat.isDirectory()) {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} is a directory symlink; copy files into the team directory instead.`);
          continue;
        }
      }

      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const relativePath = toPosixPath(path.relative(teamDir, absolutePath));
      if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
        errors.push(`${prefix}/${relativePath} has an invalid inventory path.`);
        continue;
      }
      if (stat.size > MAX_CATALOG_FILE_BYTES) {
        errors.push(`${prefix}/${relativePath} exceeds ${MAX_CATALOG_FILE_BYTES} bytes.`);
      }

      const contents = await fs.readFile(absolutePath);
      files.push({
        path: relativePath,
        kind: classifyCatalogFile(relativePath),
        sizeBytes: stat.size,
        sha256: sha256(contents),
      });
    }
  }

  await visit(teamDir);
  files.sort((a, b) => {
    if (a.path === TEAM_ENTRYPOINT) return -1;
    if (b.path === TEAM_ENTRYPOINT) return 1;
    return a.path.localeCompare(b.path);
  });

  if (!files.some((file) => file.path === TEAM_ENTRYPOINT && file.kind === "team")) {
    errors.push(`${prefix} inventory does not contain TEAM.md.`);
  }

  return files;
}

async function readTeamPackageGraph(teamDir: string, errors: string[]): Promise<TeamPackageGraph> {
  const graph: TeamPackageGraph = {
    agents: [],
    projects: [],
    tasks: [],
    skills: [],
  };

  async function visit(dir: string) {
    for (const entry of await sortedDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const relativePath = toPosixPath(path.relative(teamDir, absolutePath));
      const bucket = graphBucketForFile(relativePath);
      if (!bucket) continue;
      const doc = parseFrontmatterMarkdown(await fs.readFile(absolutePath, "utf8"));
      if (!doc.hasFrontmatter) errors.push(`${relativePath} must start with YAML frontmatter.`);
      graph[bucket].push({
        relativePath,
        frontmatter: doc.frontmatter,
        hasFrontmatter: doc.hasFrontmatter,
      });
    }
  }

  await visit(teamDir);
  return graph;
}

function graphBucketForFile(relativePath: string): keyof TeamPackageGraph | null {
  if (relativePath.endsWith("/AGENTS.md") || relativePath === "AGENTS.md") return "agents";
  if (relativePath.endsWith("/PROJECT.md") || relativePath === "PROJECT.md") return "projects";
  if (relativePath.endsWith("/TASK.md") || relativePath === "TASK.md") return "tasks";
  if (relativePath.endsWith("/SKILL.md") || relativePath === "SKILL.md") return "skills";
  return null;
}

function validateLocalReferences(
  teamDir: string,
  teamFrontmatter: Record<string, unknown>,
  graph: TeamPackageGraph,
  agentSlugs: string[],
  projectSlugs: string[],
  errors: string[],
) {
  const manager = asString(teamFrontmatter.manager);
  const rootAgentSlugs: string[] = [];

  if (!manager) {
    errors.push(`${TEAM_ENTRYPOINT} frontmatter must include manager.`);
  } else {
    const managerPath = resolveTeamReference(teamDir, TEAM_ENTRYPOINT, manager, errors);
    const managerAgent = managerPath ? graph.agents.find((agent) => agent.relativePath === managerPath) : null;
    if (!managerAgent) {
      errors.push(`${TEAM_ENTRYPOINT} manager must resolve to an AGENTS.md file inside the team package: ${manager}.`);
    } else {
      rootAgentSlugs.push(readSlug(managerAgent, "agent", errors));
    }
  }

  for (const include of readIncludeEntries(teamFrontmatter)) {
    if (isExternalRef(include)) continue;
    const resolved = resolveTeamReference(teamDir, TEAM_ENTRYPOINT, include, errors);
    if (resolved && !existsSync(path.join(teamDir, resolved))) {
      errors.push(`${TEAM_ENTRYPOINT} include does not exist: ${include}.`);
    }
  }

  for (const agent of graph.agents) {
    const reportsTo = asString(agent.frontmatter.reportsTo);
    if (reportsTo && reportsTo !== "null" && !agentSlugs.includes(reportsTo)) {
      errors.push(`${agent.relativePath} reportsTo references unknown agent slug "${reportsTo}".`);
    }
  }

  for (const project of graph.projects) {
    const owner = asString(project.frontmatter.owner) ?? asString(project.frontmatter.leadAgent);
    if (owner && !agentSlugs.includes(owner)) {
      errors.push(`${project.relativePath} owner references unknown agent slug "${owner}".`);
    }
  }

  for (const task of graph.tasks) {
    const assignee = asString(task.frontmatter.assignee);
    if (assignee && !agentSlugs.includes(assignee)) {
      errors.push(`${task.relativePath} assignee references unknown agent slug "${assignee}".`);
    }
    const project = asString(task.frontmatter.project);
    if (project && !projectSlugs.includes(project)) {
      errors.push(`${task.relativePath} project references unknown project slug "${project}".`);
    }
  }

  return Array.from(new Set(rootAgentSlugs.filter(Boolean))).sort();
}

function collectRequiredSkills(
  teamDir: string,
  teamFrontmatter: Record<string, unknown>,
  graph: TeamPackageGraph,
  catalogSkills: CatalogSkillSummary[],
  agentSlugs: string[],
  localSkillSlugs: string[],
  errors: string[],
) {
  const requirements = new Map<string, CatalogTeamSkillRequirement>();

  function upsert(requirement: CatalogTeamSkillRequirement) {
    const key = requirementIdentity(requirement);
    const existing = requirements.get(key);
    if (!existing) {
      requirements.set(key, requirement);
      return;
    }
    existing.agentSlugs = Array.from(new Set([...existing.agentSlugs, ...requirement.agentSlugs])).sort();
  }

  for (const agent of graph.agents) {
    const agentSlug = readSlug(agent, "agent", errors);
    const skills = readStringArrayField(agent.frontmatter.skills, "skills", agent.relativePath, errors);
    for (const skillRef of skills) {
      upsert(resolveSkillRequirement(skillRef, [agentSlug], catalogSkills, localSkillSlugs, errors, agent.relativePath));
    }
  }

  for (const declared of readRequiredSkillEntries(teamFrontmatter, errors)) {
    upsert(resolveDeclaredSkillRequirement(teamDir, declared, catalogSkills, localSkillSlugs, agentSlugs, errors));
  }

  return Array.from(requirements.values()).sort((a, b) => `${a.type}:${a.ref}`.localeCompare(`${b.type}:${b.ref}`));
}

function requirementIdentity(requirement: CatalogTeamSkillRequirement) {
  if (requirement.type === "catalog") return `catalog:${requirement.catalogSkillId ?? requirement.catalogSkillKey ?? requirement.ref}`;
  if (requirement.type === "local") return `local:${requirement.localPath ?? requirement.ref}`;
  return `${requirement.type}:${requirement.sourceLocator ?? requirement.ref}`;
}

function resolveSkillRequirement(
  ref: string,
  agentSlugs: string[],
  catalogSkills: CatalogSkillSummary[],
  localSkillSlugs: string[],
  errors: string[],
  prefix: string,
): CatalogTeamSkillRequirement {
  if (localSkillSlugs.includes(ref)) {
    return {
      type: "local",
      ref,
      agentSlugs: agentSlugs.sort(),
      resolved: true,
      localPath: `skills/${ref}/SKILL.md`,
    };
  }

  const catalogSkill = resolveCatalogSkill(ref, catalogSkills);
  if (catalogSkill) {
    return {
      type: "catalog",
      ref,
      agentSlugs: agentSlugs.sort(),
      resolved: true,
      catalogSkillId: catalogSkill.id,
      catalogSkillKey: catalogSkill.key,
    };
  }

  errors.push(`${prefix} skill reference "${ref}" does not resolve to a local team skill or @paperclipai/skills-catalog skill.`);
  return {
    type: "catalog",
    ref,
    agentSlugs: agentSlugs.sort(),
    resolved: false,
  };
}

function resolveDeclaredSkillRequirement(
  teamDir: string,
  declared: unknown,
  catalogSkills: CatalogSkillSummary[],
  localSkillSlugs: string[],
  agentSlugs: string[],
  errors: string[],
): CatalogTeamSkillRequirement {
  if (typeof declared === "string") {
    return resolveSkillRequirement(declared.trim(), [], catalogSkills, localSkillSlugs, errors, TEAM_ENTRYPOINT);
  }

  if (!isPlainRecord(declared)) {
    errors.push(`${TEAM_ENTRYPOINT} requiredSkills entries must be strings or objects.`);
    return { type: "catalog", ref: "", agentSlugs: [], resolved: false };
  }

  const type = asString(declared.type) ?? asString(declared.sourceType) ?? "catalog";
  const ref = asString(declared.ref)
    ?? asString(declared.catalogSkillId)
    ?? asString(declared.key)
    ?? asString(declared.slug)
    ?? asString(declared.url)
    ?? asString(declared.path)
    ?? "";
  const requirementAgentSlugs = readStringArrayLoose(declared.agentSlugs).filter((slug) => agentSlugs.includes(slug)).sort();

  if (!isSkillRequirementType(type)) {
    errors.push(`${TEAM_ENTRYPOINT} requiredSkills type "${type}" is not supported.`);
    return { type: "catalog", ref, agentSlugs: requirementAgentSlugs, resolved: false };
  }

  if (!ref) {
    errors.push(`${TEAM_ENTRYPOINT} requiredSkills ${type} entry must include a ref, key, slug, url, or path.`);
    return { type, ref, agentSlugs: requirementAgentSlugs, resolved: false };
  }

  if (type === "catalog") {
    return resolveSkillRequirement(ref, requirementAgentSlugs, catalogSkills, localSkillSlugs, errors, TEAM_ENTRYPOINT);
  }

  if (type === "local") {
    const localPath = ref.endsWith("/SKILL.md") ? ref : `skills/${ref}/SKILL.md`;
    const normalized = resolveTeamReference(teamDir, TEAM_ENTRYPOINT, localPath, errors);
    const localSlug = path.posix.basename(path.posix.dirname(localPath));
    const resolved = Boolean(normalized && localSkillSlugs.includes(localSlug));
    if (!resolved) errors.push(`${TEAM_ENTRYPOINT} required local skill "${ref}" does not resolve to skills/<slug>/SKILL.md.`);
    return {
      type: "local",
      ref,
      agentSlugs: requirementAgentSlugs,
      resolved,
      localPath,
    };
  }

  return {
    type,
    ref,
    agentSlugs: requirementAgentSlugs,
    resolved: true,
    sourceLocator: ref,
    sourceRef: asString(declared.sourceRef) ?? asString(declared.commit) ?? undefined,
  };
}

function readRequiredSkillEntries(frontmatter: Record<string, unknown>, errors: string[]) {
  const value = frontmatter.requiredSkills;
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${TEAM_ENTRYPOINT} frontmatter field requiredSkills must be an array.`);
    return [];
  }
  return value;
}

function collectEnvInputs(graph: TeamPackageGraph): CatalogTeamEnvInputSummary[] {
  const out: CatalogTeamEnvInputSummary[] = [];

  for (const agent of graph.agents) {
    const agentSlug = asString(agent.frontmatter.slug) ?? slugFromEntityPath(agent.relativePath);
    out.push(...readEnvInputs(agent.frontmatter, agentSlug, null));
  }

  for (const project of graph.projects) {
    const projectSlug = asString(project.frontmatter.slug) ?? slugFromEntityPath(project.relativePath);
    out.push(...readEnvInputs(project.frontmatter, null, projectSlug));
  }

  const seen = new Set<string>();
  return out.filter((input) => {
    const key = `${input.agentSlug ?? ""}:${input.projectSlug ?? ""}:${input.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => `${a.agentSlug ?? ""}:${a.projectSlug ?? ""}:${a.key}`.localeCompare(`${b.agentSlug ?? ""}:${b.projectSlug ?? ""}:${b.key}`));
}

function readEnvInputs(
  frontmatter: Record<string, unknown>,
  agentSlug: string | null,
  projectSlug: string | null,
): CatalogTeamEnvInputSummary[] {
  const inputs = isPlainRecord(frontmatter.inputs) ? frontmatter.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    return [{
      key,
      agentSlug,
      projectSlug,
      kind: value.kind === "plain" ? "plain" : "secret",
      requirement: value.requirement === "required" ? "required" : "optional",
    } satisfies CatalogTeamEnvInputSummary];
  });
}

function collectSourceRefs(
  teamFrontmatter: Record<string, unknown>,
  requiredSkills: CatalogTeamSkillRequirement[],
): CatalogTeamSourceRef[] {
  const refs: CatalogTeamSourceRef[] = [];

  for (const include of readIncludeEntries(teamFrontmatter)) {
    if (isExternalRef(include)) {
      refs.push({ type: "include", ref: include, pinned: isPinnedExternalRef(include) });
    }
  }

  for (const skill of requiredSkills) {
    if (skill.type === "catalog" || skill.type === "local") continue;
    refs.push({
      type: skill.type,
      ref: skill.sourceLocator ?? skill.ref,
      pinned: isPinnedExternalRef(skill.sourceRef ?? skill.sourceLocator ?? skill.ref),
    });
  }

  refs.sort((a, b) => `${a.type}:${a.ref}`.localeCompare(`${b.type}:${b.ref}`));
  return refs;
}

function readIncludeEntries(frontmatter: Record<string, unknown>) {
  const includes = frontmatter.includes;
  if (!Array.isArray(includes)) return [];
  return includes.flatMap((entry) => {
    if (typeof entry === "string") return [entry.trim()].filter(Boolean);
    if (isPlainRecord(entry)) {
      const pathValue = asString(entry.path);
      return pathValue ? [pathValue] : [];
    }
    return [];
  });
}

function resolveTeamReference(teamDir: string, fromPath: string, ref: string, errors: string[]) {
  if (isExternalRef(ref)) return null;
  const normalizedRef = ref.replace(/\\/g, "/");
  if (path.posix.isAbsolute(normalizedRef)) {
    errors.push(`${fromPath} reference must be relative, not absolute: ${ref}.`);
    return null;
  }

  const absolute = path.resolve(teamDir, path.dirname(fromPath), normalizedRef);
  const relative = toPosixPath(path.relative(teamDir, absolute));
  if (path.isAbsolute(relative) || relative.split("/").includes("..")) {
    errors.push(`${fromPath} reference escapes the team package: ${ref}.`);
    return null;
  }
  return relative;
}

function readStringArrayField(
  value: unknown,
  field: string,
  prefix: string,
  errors: string[],
) {
  const parsed = asStringArray(value);
  if (!parsed) {
    errors.push(`${prefix} frontmatter field ${field} must be an array of strings.`);
    return [];
  }
  return parsed;
}

function readStringArrayLoose(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean)
    : [];
}

function collectSlugs(files: ParsedTeamFile[], label: string, errors: string[]) {
  const slugs = files.map((file) => readSlug(file, label, errors)).filter(Boolean);
  collectDuplicateValues(slugs, label, errors);
  return slugs;
}

function readSlug(file: ParsedTeamFile, label: string, errors: string[]) {
  const slug = asString(file.frontmatter.slug) ?? slugFromEntityPath(file.relativePath);
  validateSlug(`${label} slug`, slug, file.relativePath, errors);
  return slug;
}

function slugFromEntityPath(relativePath: string) {
  return path.posix.basename(path.posix.dirname(relativePath));
}

function classifyCatalogFile(relativePath: string): CatalogTeamFileKind {
  if (relativePath === TEAM_ENTRYPOINT) return "team";
  if (relativePath.endsWith("/AGENTS.md") || relativePath === "AGENTS.md") return "agent";
  if (relativePath.endsWith("/PROJECT.md") || relativePath === "PROJECT.md") return "project";
  if (relativePath.endsWith("/TASK.md") || relativePath === "TASK.md") return "task";
  if (relativePath.endsWith("/SKILL.md") || relativePath === "SKILL.md") return "skill";
  if (relativePath === ".paperclip.yaml") return "extension";
  if (relativePath === "README.md") return "readme";
  if (relativePath.startsWith("references/")) return "reference";
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.startsWith("assets/")) return "asset";
  if (relativePath.endsWith(".md") || relativePath.endsWith(".mdx")) return "markdown";
  return "other";
}

function deriveTrustLevel(files: CatalogTeamFile[], sourceRefs: CatalogTeamSourceRef[]): CatalogTeamTrustLevel {
  if (sourceRefs.length > 0) return "external_sources";
  if (files.some((file) => file.kind === "script")) return "scripts_executables";
  if (files.some((file) => file.kind === "asset" || file.kind === "other" || file.kind === "extension")) return "assets";
  return "markdown_only";
}

function buildContentHash(files: CatalogTeamFile[]) {
  const hashInput = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
  }));
  return `sha256:${sha256(Buffer.from(JSON.stringify(hashInput)))}`;
}

function collectUniquenessErrors(teams: CatalogTeam[], errors: string[]) {
  collectDuplicateErrors(teams, "id", errors);
  collectDuplicateErrors(teams, "key", errors);
  collectDuplicateErrors(teams, "slug", errors);
}

function collectCandidateUniquenessErrors(candidates: TeamCandidate[], errors: string[]) {
  const projected = candidates.map((candidate) => ({
    id: `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`,
    key: `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`,
    slug: candidate.slug,
    path: toPosixPath(path.join("catalog", candidate.kind, candidate.category, candidate.slug)),
  })) as CatalogTeam[];
  collectUniquenessErrors(projected, errors);
}

function collectDuplicateErrors(teams: CatalogTeam[], field: "id" | "key" | "slug", errors: string[]) {
  const seen = new Map<string, string>();
  for (const team of teams) {
    const value = team[field];
    const first = seen.get(value);
    if (first) {
      errors.push(`Duplicate catalog ${field} "${value}" in ${first} and ${team.path}.`);
      continue;
    }
    seen.set(value, team.path);
  }
}

function collectDuplicateValues(values: string[], label: string, errors: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      errors.push(`Duplicate ${label} "${value}" in team package.`);
    }
    seen.add(value);
  }
}

function resolveCatalogSkill(ref: string, catalogSkills: CatalogSkillSummary[]) {
  const exact = catalogSkills.find((skill) => skill.id === ref || skill.key === ref);
  if (exact) return exact;
  const slugMatches = catalogSkills.filter((skill) => skill.slug === ref);
  return slugMatches.length === 1 ? slugMatches[0]! : null;
}

function isSkillRequirementType(value: string): value is CatalogTeamSkillRequirementType {
  return value === "catalog"
    || value === "local"
    || value === "skills_sh"
    || value === "github"
    || value === "url"
    || value === "local_path"
    || value === "agent_package";
}

function validateSlug(label: string, value: string, prefix: string, errors: string[]) {
  if (!SLUG_PATTERN.test(value)) {
    errors.push(`${prefix} has invalid ${label} "${value}"; use lowercase URL slugs.`);
  }
}

async function sortedDirEntries(dir: string) {
  return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
}

function sameManifestExceptGeneratedAt(a: CatalogManifest, b: CatalogManifest) {
  return JSON.stringify({ ...a, generatedAt: "" }) === JSON.stringify({ ...b, generatedAt: "" });
}

function sha256(contents: Buffer) {
  return createHash("sha256").update(contents).digest("hex");
}

function relativePackagePath(packageDir: string, absolutePath: string) {
  return toPosixPath(path.relative(packageDir, absolutePath));
}

function toPosixPath(input: string) {
  return input.split(path.sep).join("/");
}

function isPathInside(parent: string, child: string) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isExternalRef(ref: string) {
  return /^https?:\/\//.test(ref) || EXTERNAL_SOURCE_TYPES.has(ref.split(":")[0] ?? "") || LOCAL_PATH_SOURCE_TYPES.has(ref.split(":")[0] ?? "");
}

function isPinnedExternalRef(ref: string) {
  return /[a-f0-9]{40}/i.test(ref) || /^sha256:[a-f0-9]{64}$/i.test(ref);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
