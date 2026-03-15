import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CompanyPortabilityManifest,
  CompanyTemplateCatalogEntry,
  CompanyTemplateDetail,
} from "@paperclipai/shared";
import { portabilityManifestSchema } from "@paperclipai/shared";
import { z } from "zod";
import { notFound, unprocessable } from "../errors.js";
import type {
  BuiltInTemplateBundle,
  BuiltInTemplateMetadata,
  TemplateRegistryOptions,
} from "./types.js";

const templateMetadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1).nullable().optional().default(null),
  maturity: z.string().min(1).nullable().optional().default(null),
  riskProfile: z.string().min(1).nullable().optional().default(null),
  tags: z.array(z.string().min(1)).default([]),
  useCases: z.array(z.string().min(1)).default([]),
  recommendedFor: z.array(z.string().min(1)).default([]),
  recommended: z.boolean().default(false),
  icon: z.string().min(1).nullable().optional().default(null),
});

function normalizeTemplateId(templateId: string): string {
  const parsed = templateMetadataSchema.shape.id.safeParse(templateId);
  if (!parsed.success) {
    throw unprocessable(`Invalid built-in template id: ${templateId}`);
  }
  return parsed.data;
}

function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Template manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

function isDirectoryError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function templatesRootCandidates() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.PAPERCLIP_TEMPLATES_DIR?.trim() || null,
    path.resolve(moduleDir, "../../../templates"),
    path.resolve(moduleDir, "../../templates"),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

async function resolveTemplatesRoot(opts?: TemplateRegistryOptions) {
  if (opts?.templatesRoot) {
    return path.resolve(opts.templatesRoot);
  }

  for (const candidate of templatesRootCandidates()) {
    const stats = await fs.stat(candidate).catch(() => null);
    if (stats?.isDirectory()) return candidate;
  }

  return path.resolve(templatesRootCandidates()[0] ?? process.cwd(), ".");
}

function resolveTemplateDir(templatesRoot: string, templateId: string) {
  const normalizedId = normalizeTemplateId(templateId);
  const root = path.resolve(templatesRoot);
  const resolved = path.resolve(root, normalizedId);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unprocessable(`Invalid built-in template path: ${templateId}`);
  }
  return resolved;
}

async function readJsonFile(filePath: string) {
  const raw = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw unprocessable(`Invalid JSON file ${filePath}: ${message}`);
  }
}

async function readTemplateMetadata(templateDir: string): Promise<BuiltInTemplateMetadata> {
  const metadataPath = path.join(templateDir, "template.json");
  const parsed = templateMetadataSchema.safeParse(await readJsonFile(metadataPath));
  if (!parsed.success) {
    throw unprocessable(`Invalid built-in template metadata at ${metadataPath}`);
  }
  return parsed.data;
}

async function readTemplateManifest(templateDir: string): Promise<CompanyPortabilityManifest> {
  const manifestPath = path.join(templateDir, "paperclip.manifest.json");
  return portabilityManifestSchema.parse(await readJsonFile(manifestPath));
}

function buildCatalogEntry(
  metadata: BuiltInTemplateMetadata,
  manifest: CompanyPortabilityManifest,
): CompanyTemplateCatalogEntry {
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    category: metadata.category,
    maturity: metadata.maturity,
    riskProfile: metadata.riskProfile,
    tags: metadata.tags,
    useCases: metadata.useCases,
    recommendedFor: metadata.recommendedFor,
    recommended: metadata.recommended,
    icon: metadata.icon,
    agentCount: manifest.agents.length,
    includes: manifest.includes,
    companyName: manifest.company?.name ?? null,
  };
}

async function readTemplateFile(templateDir: string, relativePath: string) {
  const normalizedPath = ensureMarkdownPath(relativePath);
  const resolved = path.resolve(templateDir, normalizedPath);
  const relative = path.relative(templateDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw unprocessable(`Invalid built-in template file path: ${relativePath}`);
  }
  return fs.readFile(resolved, "utf8");
}

async function readOptionalTemplateFile(templateDir: string, relativePath: string) {
  try {
    return await readTemplateFile(templateDir, relativePath);
  } catch (err) {
    if (isDirectoryError(err)) return null;
    throw err;
  }
}

async function readTemplateFiles(
  templateDir: string,
  manifest: CompanyPortabilityManifest,
) {
  const files: Record<string, string> = {};

  if (manifest.company?.path) {
    files[manifest.company.path] = await readTemplateFile(templateDir, manifest.company.path);
  }

  for (const agent of manifest.agents) {
    files[agent.path] = await readTemplateFile(templateDir, agent.path);
  }

  return files;
}

let catalogCache: CompanyTemplateCatalogEntry[] | null = null;
let catalogCacheRoot: string | null = null;

export async function listBuiltInTemplates(
  opts?: TemplateRegistryOptions,
): Promise<CompanyTemplateCatalogEntry[]> {
  const templatesRoot = await resolveTemplatesRoot(opts);
  if (catalogCache && catalogCacheRoot === templatesRoot) {
    return catalogCache;
  }

  const entries = await fs.readdir(templatesRoot, { withFileTypes: true }).catch((err) => {
    if (isDirectoryError(err)) return [] as Array<import("node:fs").Dirent>;
    throw err;
  });

  const templates: CompanyTemplateCatalogEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const templateDir = path.join(templatesRoot, entry.name);
    try {
      const metadata = await readTemplateMetadata(templateDir);
      const manifest = await readTemplateManifest(templateDir);
      templates.push(buildCatalogEntry(metadata, manifest));
    } catch (err) {
      if (isDirectoryError(err)) continue;
      throw err;
    }
  }

  const sorted = templates.sort((left, right) => {
    if (left.recommended !== right.recommended) {
      return left.recommended ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  catalogCache = sorted;
  catalogCacheRoot = templatesRoot;
  return sorted;
}

const detailCache = new Map<string, CompanyTemplateDetail>();

export async function getBuiltInTemplate(
  templateId: string,
  opts?: TemplateRegistryOptions,
): Promise<CompanyTemplateDetail> {
  const cacheKey = `${opts?.templatesRoot ?? ""}:${templateId}`;
  const cached = detailCache.get(cacheKey);
  if (cached) return cached;

  const templatesRoot = await resolveTemplatesRoot(opts);
  const templateDir = resolveTemplateDir(templatesRoot, templateId);

  try {
    const metadata = await readTemplateMetadata(templateDir);
    const manifest = await readTemplateManifest(templateDir);
    const setupMarkdown = await readOptionalTemplateFile(templateDir, "SETUP.md");
    const detail: CompanyTemplateDetail = {
      ...buildCatalogEntry(metadata, manifest),
      manifest,
      setupMarkdown,
    };
    detailCache.set(cacheKey, detail);
    return detail;
  } catch (err) {
    if (isDirectoryError(err)) {
      throw notFound(`Built-in template not found: ${templateId}`);
    }
    throw err;
  }
}

const bundleCache = new Map<string, BuiltInTemplateBundle>();

export async function loadBuiltInTemplateBundle(
  templateId: string,
  opts?: TemplateRegistryOptions,
): Promise<BuiltInTemplateBundle> {
  const cacheKey = `${opts?.templatesRoot ?? ""}:${templateId}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;

  const templatesRoot = await resolveTemplatesRoot(opts);
  const templateDir = resolveTemplateDir(templatesRoot, templateId);

  try {
    const metadata = await readTemplateMetadata(templateDir);
    const manifest = await readTemplateManifest(templateDir);
    const files = await readTemplateFiles(templateDir, manifest);
    const bundle: BuiltInTemplateBundle = {
      template: buildCatalogEntry(metadata, manifest),
      manifest,
      files,
      warnings: [],
    };
    bundleCache.set(cacheKey, bundle);
    return bundle;
  } catch (err) {
    if (isDirectoryError(err)) {
      throw notFound(`Built-in template not found: ${templateId}`);
    }
    throw err;
  }
}
