import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  asBoolean,
  isPlainRecord,
  asString,
  asStringArray,
  parseFrontmatterMarkdown,
} from "./frontmatter.js";
import type {
  CatalogManifest,
  CatalogSkill,
  CatalogSkillFile,
  CatalogSkillFileKind,
  CatalogSkillKind,
  CatalogSkillSource,
  CatalogTrustLevel,
} from "./types.js";

const CATALOG_PACKAGE_NAME = "@paperclipai/skills-catalog";
const CATALOG_SCHEMA_VERSION = 1;
const SKILL_ENTRYPOINT = "SKILL.md";
const CATALOG_REFERENCE_FILE = "catalog-ref.json";
const MAX_CATALOG_FILE_BYTES = 1024 * 1024;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CATALOG_KINDS = new Set<CatalogSkillKind>(["bundled", "optional"]);

interface BaseSkillCandidate {
  kind: CatalogSkillKind;
  category: string;
  slug: string;
  absolutePath: string;
}

type SkillCandidate =
  | (BaseSkillCandidate & { source: "local" })
  | (BaseSkillCandidate & { source: "reference"; descriptorPath: string });

interface ReferencedGitHubSourceDescriptor {
  type: "github";
  hostname?: string;
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  path: string;
}

interface ReferencedSkillDescriptor {
  source: ReferencedGitHubSourceDescriptor;
  files?: string[];
  defaultInstall?: boolean;
  recommendedForRoles?: string[];
  requires?: string[];
  tags?: string[];
}

interface GitHubTreeEntry {
  path: string;
  type: "blob" | "tree" | string;
  size?: number;
}

interface BuildCatalogManifestOptions {
  packageDir: string;
  generatedAt?: string;
}

interface BuildCatalogManifestResult {
  manifest: CatalogManifest;
  errors: string[];
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
  const existingManifest = await readExistingManifest(packageDir);
  const existingSkillsById = new Map(existingManifest?.skills.map((skill) => [skill.id, skill]) ?? []);
  const errors: string[] = [];
  const candidates = await discoverSkillCandidates(packageDir, errors);
  const skills: CatalogSkill[] = [];

  collectCandidateUniquenessErrors(candidates, errors);

  for (const candidate of candidates) {
    const skill = await buildCatalogSkill(
      packageDir,
      candidate,
      errors,
      existingSkillsById.get(skillIdForCandidate(candidate)) ?? null,
    );
    if (skill) skills.push(skill);
  }

  skills.sort((a, b) => a.id.localeCompare(b.id));
  collectUniquenessErrors(skills, errors);

  return {
    manifest: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      packageName: CATALOG_PACKAGE_NAME,
      packageVersion: packageJson.version,
      generatedAt: options.generatedAt ?? new Date().toISOString(),
      skills,
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
      errors.push("generated/catalog.json is stale. Run pnpm --filter @paperclipai/skills-catalog build:manifest.");
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

async function discoverSkillCandidates(packageDir: string, errors: string[]) {
  const catalogDir = path.join(packageDir, "catalog");
  const candidates: SkillCandidate[] = [];

  if (!existsSync(catalogDir)) {
    errors.push("catalog directory is missing.");
    return candidates;
  }

  await collectMisplacedSkillFiles(catalogDir, errors);

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
        const skillDir = path.join(categoryDir, slug);
        const hasLocalSkill = existsSync(path.join(skillDir, SKILL_ENTRYPOINT));
        const descriptorPath = path.join(skillDir, CATALOG_REFERENCE_FILE);
        const hasReference = existsSync(descriptorPath);

        if (hasLocalSkill && hasReference) {
          errors.push(`${relativePackagePath(packageDir, skillDir)} must contain either SKILL.md or ${CATALOG_REFERENCE_FILE}, not both.`);
          continue;
        }
        if (!hasLocalSkill && !hasReference) {
          errors.push(`${relativePackagePath(packageDir, skillDir)} is missing SKILL.md or ${CATALOG_REFERENCE_FILE}.`);
          continue;
        }
        candidates.push(
          hasReference
            ? { kind, category, slug, absolutePath: skillDir, source: "reference", descriptorPath }
            : { kind, category, slug, absolutePath: skillDir, source: "local" },
        );
      }
    }
  }

  return candidates;
}

async function collectMisplacedSkillFiles(catalogDir: string, errors: string[]) {
  async function visit(dir: string) {
    for (const entry of await sortedDirEntries(dir)) {
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (entry.name !== SKILL_ENTRYPOINT && entry.name !== CATALOG_REFERENCE_FILE) continue;

      const relativePath = toPosixPath(path.relative(catalogDir, absolutePath));
      const parts = relativePath.split("/");
      const kind = parts[0];
      if (parts.length !== 4 || !CATALOG_KINDS.has(kind as CatalogSkillKind)) {
        errors.push(`catalog/${relativePath} is not under catalog/<bundled|optional>/<category>/<slug>/{SKILL.md,${CATALOG_REFERENCE_FILE}}.`);
      }
    }
  }

  await visit(catalogDir);
}

async function buildCatalogSkill(
  packageDir: string,
  candidate: SkillCandidate,
  errors: string[],
  existingSkill: CatalogSkill | null,
): Promise<CatalogSkill | null> {
  if (candidate.source === "reference") {
    return buildReferencedCatalogSkill(packageDir, candidate, errors, existingSkill);
  }

  const prefix = relativePackagePath(packageDir, candidate.absolutePath);
  validateSlug("category", candidate.category, prefix, errors);
  validateSlug("slug", candidate.slug, prefix, errors);

  const id = `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
  const key = `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`;
  const skillMarkdownPath = path.join(candidate.absolutePath, SKILL_ENTRYPOINT);
  const parsed = parseFrontmatterMarkdown(await fs.readFile(skillMarkdownPath, "utf8"));

  if (!parsed.hasFrontmatter) {
    errors.push(`${prefix}/SKILL.md must start with YAML frontmatter.`);
  }

  const name = asString(parsed.frontmatter.name);
  if (!name) errors.push(`${prefix}/SKILL.md frontmatter must include name.`);

  const description = asString(parsed.frontmatter.description);
  if (!description) errors.push(`${prefix}/SKILL.md frontmatter must include description.`);

  const explicitKey = asString(parsed.frontmatter.key);
  if (explicitKey && explicitKey !== key) {
    errors.push(`${prefix}/SKILL.md key must be ${key}.`);
  }

  const explicitSlug = asString(parsed.frontmatter.slug);
  if (explicitSlug && explicitSlug !== candidate.slug) {
    errors.push(`${prefix}/SKILL.md slug must be ${candidate.slug}.`);
  }

  const defaultInstall = asBoolean(parsed.frontmatter.defaultInstall) ?? false;
  const recommendedForRoles = readStringArrayField(parsed.frontmatter.recommendedForRoles, "recommendedForRoles", prefix, errors);
  const requires = readStringArrayField(parsed.frontmatter.requires, "requires", prefix, errors);
  const tags = readStringArrayField(parsed.frontmatter.tags, "tags", prefix, errors);
  const files = await collectSkillFiles(packageDir, candidate.absolutePath, prefix, errors);

  if (!name || !description) return null;

  return {
    id,
    key,
    kind: candidate.kind,
    category: candidate.category,
    slug: candidate.slug,
    name,
    description,
    path: toPosixPath(path.relative(packageDir, candidate.absolutePath)),
    entrypoint: SKILL_ENTRYPOINT,
    trustLevel: deriveTrustLevel(files),
    compatibility: "compatible",
    defaultInstall,
    recommendedForRoles,
    requires,
    tags,
    files,
    contentHash: buildContentHash(files),
  };
}

function skillIdForCandidate(candidate: BaseSkillCandidate) {
  return `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
}

async function buildReferencedCatalogSkill(
  packageDir: string,
  candidate: Extract<SkillCandidate, { source: "reference" }>,
  errors: string[],
  existingSkill: CatalogSkill | null,
): Promise<CatalogSkill | null> {
  const prefix = relativePackagePath(packageDir, candidate.absolutePath);
  validateSlug("category", candidate.category, prefix, errors);
  validateSlug("slug", candidate.slug, prefix, errors);

  const descriptor = await readReferencedSkillDescriptor(candidate.descriptorPath, prefix, errors);
  if (!descriptor) return null;

  const id = `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`;
  const key = `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`;
  const source = buildCatalogSkillSource(descriptor.source, errors, `${prefix}/${CATALOG_REFERENCE_FILE}`);
  if (!source) return null;
  const fallbackSkill = canReuseExistingReferencedSkill(
    existingSkill,
    candidate,
    source,
    toPosixPath(path.relative(packageDir, candidate.absolutePath)),
  )
    ? existingSkill
    : null;
  const errorStart = errors.length;

  const files = await collectReferencedSkillFiles(source, descriptor.files ?? [SKILL_ENTRYPOINT], prefix, errors);
  const skillMarkdown = await readReferencedFileText(source, SKILL_ENTRYPOINT, prefix, errors);
  if (!skillMarkdown) {
    const nextErrors = errors.slice(errorStart);
    if (fallbackSkill && canFallbackToExistingReferencedSkill(nextErrors)) {
      errors.splice(errorStart, nextErrors.length);
      return fallbackSkill;
    }
    return null;
  }

  const parsed = parseFrontmatterMarkdown(skillMarkdown);
  if (!parsed.hasFrontmatter) {
    errors.push(`${source.url}/${SKILL_ENTRYPOINT} must start with YAML frontmatter.`);
  }

  const name = asString(parsed.frontmatter.name);
  if (!name) errors.push(`${source.url}/${SKILL_ENTRYPOINT} frontmatter must include name.`);

  const description = asString(parsed.frontmatter.description);
  if (!description) errors.push(`${source.url}/${SKILL_ENTRYPOINT} frontmatter must include description.`);

  const explicitKey = asString(parsed.frontmatter.key);
  if (explicitKey && explicitKey !== key) {
    errors.push(`${source.url}/${SKILL_ENTRYPOINT} key must be ${key}.`);
  }

  const explicitSlug = asString(parsed.frontmatter.slug);
  if (explicitSlug && explicitSlug !== candidate.slug) {
    errors.push(`${source.url}/${SKILL_ENTRYPOINT} slug must be ${candidate.slug}.`);
  }

  const defaultInstall = asBoolean(descriptor.defaultInstall) ?? false;
  const recommendedForRoles = readStringArrayField(descriptor.recommendedForRoles, "recommendedForRoles", prefix, errors);
  const requires = readStringArrayField(descriptor.requires, "requires", prefix, errors);
  const tags = readStringArrayField(descriptor.tags, "tags", prefix, errors);

  if (!files.some((file) => file.path === SKILL_ENTRYPOINT && file.kind === "skill")) {
    errors.push(`${prefix} referenced inventory does not contain SKILL.md.`);
  }
  if (!name || !description) {
    const nextErrors = errors.slice(errorStart);
    if (fallbackSkill && canFallbackToExistingReferencedSkill(nextErrors)) {
      errors.splice(errorStart, nextErrors.length);
      return fallbackSkill;
    }
    return null;
  }

  return {
    id,
    key,
    kind: candidate.kind,
    category: candidate.category,
    slug: candidate.slug,
    name,
    description,
    path: toPosixPath(path.relative(packageDir, candidate.absolutePath)),
    entrypoint: SKILL_ENTRYPOINT,
    trustLevel: deriveTrustLevel(files),
    compatibility: "compatible",
    defaultInstall,
    recommendedForRoles,
    requires,
    tags,
    files,
    contentHash: buildContentHash(files),
    source,
  };
}

function canReuseExistingReferencedSkill(
  existingSkill: CatalogSkill | null,
  candidate: Extract<SkillCandidate, { source: "reference" }>,
  source: CatalogSkillSource,
  expectedPath: string,
) {
  if (!existingSkill || existingSkill.source?.type !== "github") return false;
  const existingSource = existingSkill.source;
  return (
    existingSkill.id === skillIdForCandidate(candidate) &&
    existingSkill.path === expectedPath &&
    existingSource.hostname === source.hostname &&
    existingSource.owner === source.owner &&
    existingSource.repo === source.repo &&
    existingSource.ref === source.ref &&
    existingSource.commit === source.commit &&
    existingSource.path === source.path
  );
}

function canFallbackToExistingReferencedSkill(errors: string[]) {
  if (errors.length === 0) return false;
  const hasRecoverableFetchError = errors.some((error) => isRecoverableReferencedFetchError(error));
  return (
    hasRecoverableFetchError &&
    errors.every((error) =>
      isReferencedFetchError(error) ||
      error.includes("referenced inventory does not contain SKILL.md."),
    )
  );
}

function isReferencedFetchError(error: string) {
  return error.includes("failed to fetch GitHub tree:") || error.includes("failed to fetch pinned GitHub file:");
}

function isRecoverableReferencedFetchError(error: string) {
  if (!isReferencedFetchError(error)) return false;
  const statusMatch = /HTTP (\d+)/.exec(error);
  if (!statusMatch) return true;
  const status = Number(statusMatch[1]);
  return status === 403 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function readReferencedSkillDescriptor(
  descriptorPath: string,
  prefix: string,
  errors: string[],
): Promise<ReferencedSkillDescriptor | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
  } catch (error) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} is missing or invalid JSON: ${errorMessage(error)}`);
    return null;
  }

  if (!isPlainRecord(raw) || !isPlainRecord(raw.source)) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} must include a source object.`);
    return null;
  }
  const sourceRaw = raw.source;
  if (asString(sourceRaw.type) !== "github") {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} source.type must be "github".`);
    return null;
  }

  const owner = asString(sourceRaw.owner);
  const repo = asString(sourceRaw.repo);
  const ref = asString(sourceRaw.ref);
  const commit = asString(sourceRaw.commit);
  const sourcePath = asString(sourceRaw.path);
  if (!owner || !repo || !ref || !commit || sourcePath === null) {
    errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} GitHub source must include owner, repo, ref, commit, and path.`);
    return null;
  }

  const descriptor: ReferencedSkillDescriptor = {
    source: {
      type: "github",
      hostname: asString(sourceRaw.hostname) ?? "github.com",
      owner,
      repo,
      ref,
      commit,
      path: sourcePath,
    },
    defaultInstall: asBoolean(raw.defaultInstall) ?? false,
    files: asStringArray(raw.files ?? undefined) ?? undefined,
    recommendedForRoles: asStringArray(raw.recommendedForRoles ?? undefined) ?? undefined,
    requires: asStringArray(raw.requires ?? undefined) ?? undefined,
    tags: asStringArray(raw.tags ?? undefined) ?? undefined,
  };

  if (raw.files !== undefined && !descriptor.files) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} files must be an array of strings.`);
  if (raw.recommendedForRoles !== undefined && !descriptor.recommendedForRoles) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} recommendedForRoles must be an array of strings.`);
  if (raw.requires !== undefined && !descriptor.requires) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} requires must be an array of strings.`);
  if (raw.tags !== undefined && !descriptor.tags) errors.push(`${prefix}/${CATALOG_REFERENCE_FILE} tags must be an array of strings.`);

  return descriptor;
}

function buildCatalogSkillSource(
  descriptor: ReferencedGitHubSourceDescriptor,
  errors: string[],
  prefix: string,
): CatalogSkillSource | null {
  if (!/^[0-9a-f]{40}$/i.test(descriptor.commit)) {
    errors.push(`${prefix} source.commit must be a 40-character Git commit SHA.`);
  }
  const sourcePath = normalizeReferencedPath(descriptor.path);
  if (sourcePath === null) {
    errors.push(`${prefix} source.path must be a portable path within the repository.`);
  }
  const hostname = descriptor.hostname ?? "github.com";
  const url = `https://${hostname}/${descriptor.owner}/${descriptor.repo}/tree/${descriptor.ref}/${sourcePath ?? ""}`.replace(/\/$/, "");
  if (!/^[0-9a-f]{40}$/i.test(descriptor.commit) || sourcePath === null) return null;
  return {
    type: "github",
    hostname,
    owner: descriptor.owner,
    repo: descriptor.repo,
    ref: descriptor.ref,
    commit: descriptor.commit,
    path: sourcePath ?? "",
    url,
  };
}

async function collectReferencedSkillFiles(
  source: CatalogSkillSource,
  includePatterns: string[],
  prefix: string,
  errors: string[],
): Promise<CatalogSkillFile[]> {
  const tree = await fetchGitHubTree(source, prefix, errors);
  const sourceRoot = source.path ? `${source.path}/` : "";
  const normalizedPatterns: string[] = [];
  for (const pattern of includePatterns) {
    const normalizedPattern = normalizeReferencedPath(pattern);
    if (normalizedPattern === null) {
      errors.push(`${prefix} referenced include path is invalid: ${pattern}`);
      continue;
    }
    if (normalizedPattern) normalizedPatterns.push(normalizedPattern);
  }
  const files: CatalogSkillFile[] = [];

  for (const entry of tree) {
    if (entry.type !== "blob") continue;
    if (!entry.path.startsWith(sourceRoot)) continue;
    const relativePath = entry.path.slice(sourceRoot.length);
    if (!normalizedPatterns.some((pattern) => referencedPathMatches(relativePath, pattern))) continue;
    if ((entry.size ?? 0) > MAX_CATALOG_FILE_BYTES) {
      errors.push(`${prefix}/${relativePath} exceeds ${MAX_CATALOG_FILE_BYTES} bytes.`);
      continue;
    }

    const bytes = await fetchReferencedFileBytes(source, relativePath, prefix, errors);
    if (!bytes) continue;
    files.push({
      path: relativePath,
      kind: classifyCatalogFile(relativePath),
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }

  files.sort((a, b) => {
    if (a.path === SKILL_ENTRYPOINT) return -1;
    if (b.path === SKILL_ENTRYPOINT) return 1;
    return a.path.localeCompare(b.path);
  });
  return files;
}

async function fetchGitHubTree(
  source: CatalogSkillSource,
  prefix: string,
  errors: string[],
): Promise<GitHubTreeEntry[]> {
  const url = `${githubApiBase(source.hostname)}/repos/${source.owner}/${source.repo}/git/trees/${source.commit}?recursive=1`;
  try {
    const response = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
    if (!response.ok) {
      errors.push(`${prefix} failed to fetch GitHub tree: HTTP ${response.status}.`);
      return [];
    }
    const body = await response.json() as { tree?: GitHubTreeEntry[]; truncated?: boolean };
    if (body.truncated) errors.push(`${prefix} GitHub tree response was truncated.`);
    return Array.isArray(body.tree) ? body.tree : [];
  } catch (error) {
    errors.push(`${prefix} failed to fetch GitHub tree: ${errorMessage(error)}.`);
    return [];
  }
}

async function readReferencedFileText(
  source: CatalogSkillSource,
  relativePath: string,
  prefix: string,
  errors: string[],
) {
  const bytes = await fetchReferencedFileBytes(source, relativePath, prefix, errors);
  return bytes ? bytes.toString("utf8") : null;
}

async function fetchReferencedFileBytes(
  source: CatalogSkillSource,
  relativePath: string,
  prefix: string,
  errors: string[],
): Promise<Buffer | null> {
  const normalizedPath = normalizeReferencedPath(relativePath);
  if (!normalizedPath) {
    errors.push(`${prefix} referenced file path is invalid: ${relativePath}`);
    return null;
  }
  const url = rawGitHubUrl(source, normalizedPath);
  try {
    const response = await fetch(url);
    if (!response.ok) {
      errors.push(`${prefix}/${normalizedPath} failed to fetch pinned GitHub file: HTTP ${response.status}.`);
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    errors.push(`${prefix}/${normalizedPath} failed to fetch pinned GitHub file: ${errorMessage(error)}.`);
    return null;
  }
}

async function collectSkillFiles(
  packageDir: string,
  skillDir: string,
  prefix: string,
  errors: string[],
): Promise<CatalogSkillFile[]> {
  const files: CatalogSkillFile[] = [];
  const skillRoot = await fs.realpath(skillDir);

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
        if (!isPathInside(skillRoot, realPath)) {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} points outside its skill directory.`);
          continue;
        }
        if (stat.isDirectory()) {
          errors.push(`${relativePackagePath(packageDir, absolutePath)} is a directory symlink; copy files into the skill directory instead.`);
          continue;
        }
      }

      if (stat.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) continue;

      const relativePath = toPosixPath(path.relative(skillDir, absolutePath));
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

  await visit(skillDir);
  files.sort((a, b) => {
    if (a.path === SKILL_ENTRYPOINT) return -1;
    if (b.path === SKILL_ENTRYPOINT) return 1;
    return a.path.localeCompare(b.path);
  });

  if (!files.some((file) => file.path === SKILL_ENTRYPOINT && file.kind === "skill")) {
    errors.push(`${prefix} inventory does not contain SKILL.md.`);
  }

  return files;
}

function readStringArrayField(
  value: unknown,
  field: string,
  prefix: string,
  errors: string[],
) {
  const parsed = asStringArray(value);
  if (!parsed) {
    errors.push(`${prefix}/SKILL.md frontmatter field ${field} must be an array of strings.`);
    return [];
  }
  return parsed;
}

function classifyCatalogFile(relativePath: string): CatalogSkillFileKind {
  if (relativePath === SKILL_ENTRYPOINT) return "skill";
  if (relativePath.startsWith("references/")) return "reference";
  if (relativePath.startsWith("scripts/")) return "script";
  if (relativePath.startsWith("assets/")) return "asset";
  if (relativePath.endsWith(".md") || relativePath.endsWith(".mdx")) return "markdown";
  return "other";
}

function deriveTrustLevel(files: CatalogSkillFile[]): CatalogTrustLevel {
  if (files.some((file) => file.kind === "script")) return "scripts_executables";
  if (files.some((file) => file.kind === "asset" || file.kind === "other")) return "assets";
  return "markdown_only";
}

function buildContentHash(files: CatalogSkillFile[]) {
  const hashInput = files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
  }));
  return `sha256:${sha256(Buffer.from(JSON.stringify(hashInput)))}`;
}

function collectUniquenessErrors(skills: CatalogSkill[], errors: string[]) {
  collectDuplicateErrors(skills, "id", errors);
  collectDuplicateErrors(skills, "key", errors);
  collectDuplicateErrors(skills, "slug", errors);
}

function collectCandidateUniquenessErrors(candidates: SkillCandidate[], errors: string[]) {
  const projected = candidates.map((candidate) => ({
    id: `paperclipai:${candidate.kind}:${candidate.category}:${candidate.slug}`,
    key: `paperclipai/${candidate.kind}/${candidate.category}/${candidate.slug}`,
    slug: candidate.slug,
    path: toPosixPath(path.join("catalog", candidate.kind, candidate.category, candidate.slug)),
  })) as CatalogSkill[];
  collectUniquenessErrors(projected, errors);
}

function collectDuplicateErrors(fieldSkills: CatalogSkill[], field: "id" | "key" | "slug", errors: string[]) {
  const seen = new Map<string, string>();
  for (const skill of fieldSkills) {
    const value = skill[field];
    const first = seen.get(value);
    if (first) {
      errors.push(`Duplicate catalog ${field} "${value}" in ${first} and ${skill.path}.`);
      continue;
    }
    seen.set(value, skill.path);
  }
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

function normalizeReferencedPath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalized === "") return "";
  const parts = normalized.split("/");
  if (parts.includes("") || parts.includes(".") || parts.includes("..") || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function referencedPathMatches(relativePath: string, pattern: string) {
  if (pattern.endsWith("/**")) {
    const directory = pattern.slice(0, -3);
    return relativePath === directory || relativePath.startsWith(`${directory}/`);
  }
  return relativePath === pattern;
}

function githubApiBase(hostname: string) {
  const normalized = hostname.toLowerCase();
  return normalized === "github.com" || normalized === "www.github.com"
    ? "https://api.github.com"
    : `https://${hostname}/api/v3`;
}

function rawGitHubUrl(source: CatalogSkillSource, relativePath: string) {
  const fullPath = source.path ? `${source.path}/${relativePath}` : relativePath;
  const encodedPath = fullPath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  const normalized = source.hostname.toLowerCase();
  return normalized === "github.com" || normalized === "www.github.com"
    ? `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.commit}/${encodedPath}`
    : `https://${source.hostname}/raw/${source.owner}/${source.repo}/${source.commit}/${encodedPath}`;
}

function isPathInside(parent: string, child: string) {
  const relativePath = path.relative(parent, child);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
