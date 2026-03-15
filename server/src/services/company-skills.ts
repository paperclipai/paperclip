import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySkills } from "@paperclipai/db";
import type {
  CompanySkill,
  CompanySkillCreateRequest,
  CompanySkillCompatibility,
  CompanySkillDetail,
  CompanySkillFileDetail,
  CompanySkillFileInventoryEntry,
  CompanySkillImportResult,
  CompanySkillListItem,
  CompanySkillSourceBadge,
  CompanySkillSourceType,
  CompanySkillTrustLevel,
  CompanySkillUpdateStatus,
  CompanySkillUsageAgent,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { findServerAdapter } from "../adapters/index.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { notFound, unprocessable } from "../errors.js";
import { agentService } from "./agents.js";
import { secretService } from "./secrets.js";

type CompanySkillRow = typeof companySkills.$inferSelect;

type ImportedSkill = {
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

type ParsedSkillImportSource = {
  resolvedSource: string;
  requestedSkillSlug: string | null;
  warnings: string[];
};

type SkillSourceMeta = {
  sourceKind?: string;
  owner?: string;
  repo?: string;
  ref?: string;
  trackingRef?: string;
  repoSkillDir?: string;
};

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
  const response = await fetch(url);
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

async function resolveGitHubDefaultBranch(owner: string, repo: string) {
  const response = await fetchJson<{ default_branch?: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
  );
  return asString(response.default_branch) ?? "main";
}

async function resolveGitHubCommitSha(owner: string, repo: string, ref: string) {
  const response = await fetchJson<{ sha?: string }>(
    `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
  );
  const sha = asString(response.sha);
  if (!sha) {
    throw unprocessable(`Failed to resolve GitHub ref ${ref}`);
  }
  return sha;
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
  return { owner, repo, ref, basePath, filePath, explicitRef };
}

async function resolveGitHubPinnedRef(parsed: ReturnType<typeof parseGitHubSourceUrl>) {
  if (/^[0-9a-f]{40}$/i.test(parsed.ref.trim())) {
    return {
      pinnedRef: parsed.ref,
      trackingRef: parsed.explicitRef ? parsed.ref : null,
    };
  }

  const trackingRef = parsed.explicitRef
    ? parsed.ref
    : await resolveGitHubDefaultBranch(parsed.owner, parsed.repo);
  const pinnedRef = await resolveGitHubCommitSha(parsed.owner, parsed.repo, trackingRef);
  return { pinnedRef, trackingRef };
}

function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.replace(/^\/+/, "")}`;
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

  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    const [owner, repo, skillSlugRaw] = normalizedSource.split("/");
    return {
      resolvedSource: `https://github.com/${owner}/${repo}`,
      requestedSkillSlug: normalizeSkillSlug(skillSlugRaw),
      warnings,
    };
  }

  if (!/^https?:\/\//i.test(normalizedSource) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedSource)) {
    return {
      resolvedSource: `https://github.com/${normalizedSource}`,
      requestedSkillSlug,
      warnings,
    };
  }

  return {
    resolvedSource: normalizedSource,
    requestedSkillSlug,
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
  return normalizeSkillSlug(asString(frontmatter.name)) ?? normalizeAgentUrlKey(fallback) ?? "skill";
}

function deriveImportedSkillSource(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
): Pick<ImportedSkill, "sourceType" | "sourceLocator" | "sourceRef" | "metadata"> {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const rawSources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
  const sourceEntry = rawSources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
  const kind = asString(sourceEntry?.kind);

  if (kind === "github-dir" || kind === "github-file") {
    const repo = asString(sourceEntry?.repo);
    const repoPath = asString(sourceEntry?.path);
    const commit = asString(sourceEntry?.commit);
    const trackingRef = asString(sourceEntry?.trackingRef);
    const url = asString(sourceEntry?.url)
      ?? (repo
        ? `https://github.com/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}`
        : null);
    const [owner, repoName] = (repo ?? "").split("/");
    if (repo && owner && repoName) {
      return {
        sourceType: "github",
        sourceLocator: url,
        sourceRef: commit,
        metadata: {
          sourceKind: "github",
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
      sourceKind: "catalog",
    },
  };
}

function readInlineSkillImports(files: Record<string, string>): ImportedSkill[] {
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

async function readLocalSkillImports(sourcePath: string): Promise<ImportedSkill[]> {
  const resolvedPath = path.resolve(sourcePath);
  const stat = await fs.stat(resolvedPath).catch(() => null);
  if (!stat) {
    throw unprocessable(`Skill source path does not exist: ${sourcePath}`);
  }

  if (stat.isFile()) {
    const markdown = await fs.readFile(resolvedPath, "utf8");
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, path.basename(path.dirname(resolvedPath)));
    const inventory: CompanySkillFileInventoryEntry[] = [
      { path: "SKILL.md", kind: "skill" },
    ];
    return [{
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
      metadata: { sourceKind: "local_path" },
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
    const markdown = await fs.readFile(path.join(root, skillPath), "utf8");
    const parsed = parseFrontmatterMarkdown(markdown);
    const slug = deriveImportedSkillSlug(parsed.frontmatter, path.posix.basename(skillDir));
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
    imports.push({
      slug,
      name: asString(parsed.frontmatter.name) ?? slug,
      description: asString(parsed.frontmatter.description),
      markdown,
      packageDir: path.join(root, skillDir),
      sourceType: "local_path",
      sourceLocator: path.join(root, skillDir),
      sourceRef: null,
      trustLevel: deriveTrustLevel(inventory),
      compatibility: "compatible",
      fileInventory: inventory,
      metadata: { sourceKind: "local_path" },
    });
  }

  return imports;
}

async function readUrlSkillImports(
  sourceUrl: string,
  requestedSkillSlug: string | null = null,
): Promise<{ skills: ImportedSkill[]; warnings: string[] }> {
  const url = sourceUrl.trim();
  const warnings: string[] = [];
  if (url.includes("github.com/")) {
    const parsed = parseGitHubSourceUrl(url);
    const { pinnedRef, trackingRef } = await resolveGitHubPinnedRef(parsed);
    let ref = pinnedRef;
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
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
      const markdown = await fetchText(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, repoSkillPath));
      const parsedMarkdown = parseFrontmatterMarkdown(markdown);
      const skillDir = path.posix.dirname(relativeSkillPath);
      const slug = deriveImportedSkillSlug(parsedMarkdown.frontmatter, path.posix.basename(skillDir));
      if (requestedSkillSlug && !matchesRequestedSkill(relativeSkillPath, requestedSkillSlug) && slug !== requestedSkillSlug) {
        continue;
      }
      const inventory = filteredPaths
        .filter((entry) => entry === relativeSkillPath || entry.startsWith(`${skillDir}/`))
        .map((entry) => ({
          path: entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
          kind: classifyInventoryKind(entry === relativeSkillPath ? "SKILL.md" : entry.slice(skillDir.length + 1)),
        }))
        .sort((left, right) => left.path.localeCompare(right.path));
      skills.push({
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
        metadata: {
          sourceKind: "github",
          owner: parsed.owner,
          repo: parsed.repo,
          ref: ref,
          trackingRef,
          repoSkillDir: basePrefix ? `${basePrefix}${skillDir}` : skillDir,
        },
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
    const inventory: CompanySkillFileInventoryEntry[] = [{ path: "SKILL.md", kind: "skill" }];
    return {
      skills: [{
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
        metadata: {
          sourceKind: "url",
        },
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

function normalizeSkillDirectory(skill: CompanySkill) {
  if ((skill.sourceType !== "local_path" && skill.sourceType !== "catalog") || !skill.sourceLocator) return null;
  const resolved = path.resolve(skill.sourceLocator);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
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
} {
  const metadata = getSkillMeta(skill);
  const localSkillDir = normalizeSkillDirectory(skill);
  if (metadata.sourceKind === "paperclip_bundled") {
    return {
      editable: false,
      editableReason: "Bundled Paperclip skills are read-only.",
      sourceLabel: "Paperclip bundled",
      sourceBadge: "paperclip",
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
    };
  }

  if (skill.sourceType === "url") {
    return {
      editable: false,
      editableReason: "URL-based skills are read-only. Save them locally to edit them.",
      sourceLabel: skill.sourceLocator,
      sourceBadge: "url",
    };
  }

  if (skill.sourceType === "local_path") {
    const managedRoot = resolveManagedSkillsRoot(skill.companyId);
    if (localSkillDir && localSkillDir.startsWith(managedRoot)) {
      return {
        editable: true,
        editableReason: null,
        sourceLabel: "Paperclip workspace",
        sourceBadge: "paperclip",
      };
    }

    return {
      editable: true,
      editableReason: null,
      sourceLabel: skill.sourceLocator,
      sourceBadge: "local",
    };
  }

  return {
    editable: false,
    editableReason: "This skill source is read-only.",
    sourceLabel: skill.sourceLocator,
    sourceBadge: "catalog",
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

export function companySkillService(db: Db) {
  const agents = agentService(db);
  const secretsSvc = secretService(db);

  async function ensureBundledSkills(companyId: string) {
    for (const skillsRoot of resolveBundledSkillsRoot()) {
      const stats = await fs.stat(skillsRoot).catch(() => null);
      if (!stats?.isDirectory()) continue;
      const bundledSkills = await readLocalSkillImports(skillsRoot)
        .then((skills) => skills.map((skill) => ({
          ...skill,
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

  async function list(companyId: string): Promise<CompanySkillListItem[]> {
    await ensureBundledSkills(companyId);
    const rows = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.companyId, companyId))
      .orderBy(asc(companySkills.name), asc(companySkills.slug));
    const agentRows = await agents.list(companyId);
    return rows.map((row) => {
      const skill = toCompanySkill(row);
      const attachedAgentCount = agentRows.filter((agent) => {
        const preference = readPaperclipSkillSyncPreference(agent.adapterConfig as Record<string, unknown>);
        return preference.desiredSkills.includes(skill.slug);
      }).length;
      return enrichSkill(skill, attachedAgentCount);
    });
  }

  async function getById(id: string) {
    const row = await db
      .select()
      .from(companySkills)
      .where(eq(companySkills.id, id))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function getBySlug(companyId: string, slug: string) {
    const row = await db
      .select()
      .from(companySkills)
      .where(and(eq(companySkills.companyId, companyId), eq(companySkills.slug, slug)))
      .then((rows) => rows[0] ?? null);
    return row ? toCompanySkill(row) : null;
  }

  async function usage(companyId: string, slug: string): Promise<CompanySkillUsageAgent[]> {
    const agentRows = await agents.list(companyId);
    const desiredAgents = agentRows.filter((agent) => {
      const preference = readPaperclipSkillSyncPreference(agent.adapterConfig as Record<string, unknown>);
      return preference.desiredSkills.includes(slug);
    });

    return Promise.all(
      desiredAgents.map(async (agent) => {
        const adapter = findServerAdapter(agent.adapterType);
        let actualState: string | null = null;

        if (!adapter?.listSkills) {
          actualState = "unsupported";
        } else {
          try {
            const { config: runtimeConfig } = await secretsSvc.resolveAdapterConfigForRuntime(
              agent.companyId,
              agent.adapterConfig as Record<string, unknown>,
            );
            const snapshot = await adapter.listSkills({
              agentId: agent.id,
              companyId: agent.companyId,
              adapterType: agent.adapterType,
              config: runtimeConfig,
            });
            actualState = snapshot.entries.find((entry) => entry.name === slug)?.state
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
    await ensureBundledSkills(companyId);
    const skill = await getById(id);
    if (!skill || skill.companyId !== companyId) return null;
    const usedByAgents = await usage(companyId, skill.slug);
    return enrichSkill(skill, usedByAgents.length, usedByAgents);
  }

  async function updateStatus(companyId: string, skillId: string): Promise<CompanySkillUpdateStatus | null> {
    await ensureBundledSkills(companyId);
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;

    if (skill.sourceType !== "github") {
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

    const latestRef = await resolveGitHubCommitSha(owner, repo, trackingRef);
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
    await ensureBundledSkills(companyId);
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
    } else if (skill.sourceType === "github") {
      const metadata = getSkillMeta(skill);
      const owner = asString(metadata.owner);
      const repo = asString(metadata.repo);
      const ref = skill.sourceRef ?? asString(metadata.ref) ?? "main";
      const repoSkillDir = normalizePortablePath(asString(metadata.repoSkillDir) ?? skill.slug);
      if (!owner || !repo) {
        throw unprocessable("Skill source metadata is incomplete.");
      }
      const repoPath = normalizePortablePath(path.posix.join(repoSkillDir, normalizedPath));
      content = await fetchText(resolveRawGitHubUrl(owner, repo, ref, repoPath));
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
    await ensureBundledSkills(companyId);
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
    await ensureBundledSkills(companyId);
    const skill = await getById(skillId);
    if (!skill || skill.companyId !== companyId) return null;

    const status = await updateStatus(companyId, skillId);
    if (!status?.supported) {
      throw unprocessable(status?.reason ?? "This skill does not support updates.");
    }
    if (!skill.sourceLocator) {
      throw unprocessable("Skill source locator is missing.");
    }

    const result = await readUrlSkillImports(skill.sourceLocator, skill.slug);
    const matching = result.skills.find((entry) => entry.slug === skill.slug) ?? result.skills[0] ?? null;
    if (!matching) {
      throw unprocessable(`Skill ${skill.slug} could not be re-imported from its source.`);
    }

    const imported = await upsertImportedSkills(companyId, [matching]);
    return imported[0] ?? null;
  }

  async function materializeCatalogSkillFiles(
    companyId: string,
    skill: ImportedSkill,
    normalizedFiles: Record<string, string>,
  ) {
    const packageDir = skill.packageDir ? normalizePortablePath(skill.packageDir) : null;
    if (!packageDir) return null;
    const catalogRoot = path.resolve(resolveManagedSkillsRoot(companyId), "__catalog__");
    const skillDir = path.resolve(catalogRoot, skill.slug);
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

  async function importPackageFiles(companyId: string, files: Record<string, string>): Promise<CompanySkill[]> {
    await ensureBundledSkills(companyId);
    const normalizedFiles = normalizePackageFileMap(files);
    const importedSkills = readInlineSkillImports(normalizedFiles);
    if (importedSkills.length === 0) return [];

    for (const skill of importedSkills) {
      if (skill.sourceType !== "catalog") continue;
      const materializedDir = await materializeCatalogSkillFiles(companyId, skill, normalizedFiles);
      if (materializedDir) {
        skill.sourceLocator = materializedDir;
      }
    }

    return upsertImportedSkills(companyId, importedSkills);
  }

  async function upsertImportedSkills(companyId: string, imported: ImportedSkill[]): Promise<CompanySkill[]> {
    const out: CompanySkill[] = [];
    for (const skill of imported) {
      const existing = await getBySlug(companyId, skill.slug);
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

      const values = {
        companyId,
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
        metadata: skill.metadata,
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
    await ensureBundledSkills(companyId);
    const parsed = parseSkillImportSourceInput(source);
    const local = !/^https?:\/\//i.test(parsed.resolvedSource);
    const { skills, warnings } = local
      ? {
        skills: (await readLocalSkillImports(parsed.resolvedSource))
          .filter((skill) => !parsed.requestedSkillSlug || skill.slug === parsed.requestedSkillSlug),
        warnings: parsed.warnings,
      }
      : await readUrlSkillImports(parsed.resolvedSource, parsed.requestedSkillSlug)
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
    const imported = await upsertImportedSkills(companyId, filteredSkills);
    return { imported, warnings };
  }

  return {
    list,
    getById,
    getBySlug,
    detail,
    updateStatus,
    readFile,
    updateFile,
    createLocalSkill,
    importFromSource,
    importPackageFiles,
    installUpdate,
  };
}
