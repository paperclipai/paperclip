import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CompanyPortabilityManifest,
  CompanyPortabilityGoalManifestEntry,
  CompanyTemplateCatalogEntry,
  CompanyTemplateDetail,
} from "@paperclipai/shared";
import {
  normalizeAgentUrlKey,
  portabilityManifestSchema,
} from "@paperclipai/shared";
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

type NormalizedGoalEntry = CompanyPortabilityGoalManifestEntry;

const legacyIncludeSchema = z.object({
  company: z.boolean(),
  agents: z.boolean(),
  goals: z.boolean().default(false),
  projects: z.boolean().default(false),
  issues: z.boolean().default(false),
});

const legacySecretRequirementSchema = z.object({
  key: z.string().min(1),
  description: z.string().nullable().optional().default(null),
  agentSlug: z.string().min(1).nullable().optional().default(null),
  providerHint: z.string().nullable().optional().default(null),
});

const legacyManifestSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  source: z
    .object({
      companyId: z.string().uuid(),
      companyName: z.string().min(1),
    })
    .nullable(),
  includes: legacyIncludeSchema,
  company: z.object({
    path: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional().default(null),
    brandColor: z.string().nullable().optional().default(null),
    requireBoardApprovalForNewAgents: z.boolean(),
  }).nullable(),
  agents: z.array(z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    path: z.string().min(1),
    role: z.string().min(1),
    title: z.string().nullable().optional().default(null),
    icon: z.string().nullable().optional().default(null),
    capabilities: z.string().nullable().optional().default(null),
    reportsToSlug: z.string().min(1).nullable().optional().default(null),
    adapterType: z.string().min(1),
    adapterConfig: z.record(z.unknown()),
    runtimeConfig: z.record(z.unknown()),
    permissions: z.record(z.unknown()),
    budgetMonthlyCents: z.number().int().nonnegative(),
    metadata: z.record(z.unknown()).nullable().optional().default(null),
  })),
  goals: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional().default(null),
    level: z.string().min(1),
    status: z.string().min(1),
    parentKey: z.string().min(1).nullable().optional().default(null),
    ownerAgentSlug: z.string().min(1).nullable().optional().default(null),
  })).default([]),
  projects: z.array(z.object({
    key: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional().default(null),
    status: z.string().min(1),
    goalKeys: z.array(z.string().min(1)).default([]),
    leadAgentSlug: z.string().min(1).nullable().optional().default(null),
    targetDate: z.string().nullable().optional().default(null),
    color: z.string().nullable().optional().default(null),
    workspaces: z.array(z.object({
      name: z.string().min(1),
      cwd: z.string().nullable().optional().default(null),
      repoUrl: z.string().nullable().optional().default(null),
      repoRef: z.string().nullable().optional().default(null),
      metadata: z.record(z.unknown()).nullable().optional().default(null),
      isPrimary: z.boolean(),
    })).default([]),
  })).default([]),
  issues: z.array(z.object({
    key: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable().optional().default(null),
    status: z.string().min(1),
    priority: z.string().min(1),
    projectKey: z.string().min(1).nullable().optional().default(null),
    goalKey: z.string().min(1).nullable().optional().default(null),
    parentKey: z.string().min(1).nullable().optional().default(null),
    assigneeAgentSlug: z.string().min(1).nullable().optional().default(null),
    requestDepth: z.number().int().nonnegative().optional().default(0),
    billingCode: z.string().nullable().optional().default(null),
  })).default([]),
  requiredSecrets: z.array(legacySecretRequirementSchema).default([]),
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
  const raw = await readJsonFile(manifestPath);
  const parsed = portabilityManifestSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data as CompanyPortabilityManifest;
  }
  return normalizeLegacyTemplateManifest(raw, manifestPath);
}

function uniqueSlug(base: string, used: Set<string>, fallback: string) {
  const normalizedBase = normalizeAgentUrlKey(base) ?? fallback;
  if (!used.has(normalizedBase)) {
    used.add(normalizedBase);
    return normalizedBase;
  }
  let index = 2;
  while (true) {
    const candidate = `${normalizedBase}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    index += 1;
  }
}

function normalizeLegacyTemplateManifest(raw: unknown, manifestPath: string): CompanyPortabilityManifest {
  const parsed = legacyManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable(`Invalid built-in template manifest at ${manifestPath}`);
  }

  const projectSlugs = new Map<string, string>();
  const usedProjectSlugs = new Set<string>();
  for (const project of parsed.data.projects) {
    projectSlugs.set(
      project.key,
      uniqueSlug(project.key || project.name, usedProjectSlugs, "project"),
    );
  }

  const issueSlugs = new Map<string, string>();
  const usedIssueSlugs = new Set<string>();
  for (const issue of parsed.data.issues) {
    issueSlugs.set(
      issue.key,
      uniqueSlug(issue.key || issue.title, usedIssueSlugs, "task"),
    );
  }

  return {
    schemaVersion: parsed.data.schemaVersion,
    generatedAt: parsed.data.generatedAt,
    source: parsed.data.source,
    includes: {
      company: parsed.data.includes.company,
      agents: parsed.data.includes.agents,
      projects: parsed.data.includes.projects,
      issues: parsed.data.includes.issues,
      skills: false,
      goals: parsed.data.includes.goals,
    },
    company: parsed.data.company
      ? {
          path: parsed.data.company.path,
          name: parsed.data.company.name,
          description: parsed.data.company.description,
          brandColor: parsed.data.company.brandColor,
          logoPath: null,
          requireBoardApprovalForNewAgents:
            parsed.data.company.requireBoardApprovalForNewAgents,
          feedbackDataSharingEnabled: false,
          feedbackDataSharingConsentAt: null,
          feedbackDataSharingConsentByUserId: null,
          feedbackDataSharingTermsVersion: null,
        }
      : null,
    sidebar: null,
    agents: parsed.data.agents.map((agent) => ({
      ...agent,
      skills: [],
    })),
    goals: parsed.data.goals.map((goal) => ({
      key: goal.key,
      title: goal.title,
      description: goal.description,
      level: goal.level as NormalizedGoalEntry["level"],
      status: goal.status as NormalizedGoalEntry["status"],
      parentKey: goal.parentKey,
      ownerAgentSlug: goal.ownerAgentSlug,
    })),
    skills: [],
    projects: parsed.data.projects.map((project) => {
      const slug = projectSlugs.get(project.key) ?? uniqueSlug(project.name, new Set<string>(), "project");
      const workspaceKeys = new Set<string>();
      return {
        slug,
        name: project.name,
        path: `projects/${slug}/PROJECT.md`,
        description: project.description,
        ownerAgentSlug: null,
        leadAgentSlug: project.leadAgentSlug,
        targetDate: project.targetDate,
        color: project.color,
        status: project.status,
        goalKeys: project.goalKeys,
        executionWorkspacePolicy: null,
        workspaces: project.workspaces.map((workspace) => ({
          key: uniqueSlug(
            workspace.name || workspace.repoUrl || "workspace",
            workspaceKeys,
            "workspace",
          ),
          name: workspace.name,
          sourceType: null,
          repoUrl: workspace.repoUrl,
          repoRef: workspace.repoRef,
          defaultRef: null,
          visibility: null,
          setupCommand: null,
          cleanupCommand: null,
          metadata: workspace.metadata,
          isPrimary: workspace.isPrimary,
        })),
        metadata: null,
      };
    }),
    issues: parsed.data.issues.map((issue) => {
      const slug = issueSlugs.get(issue.key) ?? uniqueSlug(issue.title, new Set<string>(), "task");
      return {
        slug,
        identifier: null,
        title: issue.title,
        path: `tasks/${slug}/TASK.md`,
        projectSlug: issue.projectKey ? (projectSlugs.get(issue.projectKey) ?? null) : null,
        goalKey: issue.goalKey,
        parentKey: issue.parentKey,
        projectWorkspaceKey: null,
        assigneeAgentSlug: issue.assigneeAgentSlug,
        description: issue.description,
        recurring: false,
        routine: null,
        legacyRecurrence: null,
        status: issue.status,
        priority: issue.priority,
        requestDepth: issue.requestDepth,
        labelIds: [],
        billingCode: issue.billingCode,
        executionWorkspaceSettings: null,
        assigneeAdapterOverrides: null,
        metadata: null,
      };
    }),
    requiredSecrets: parsed.data.requiredSecrets,
    envInputs: [],
  };
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

  for (const project of manifest.projects) {
    if (files[project.path] !== undefined) continue;
    files[project.path] = buildSyntheticMarkdown(
      {
        kind: "project",
        name: project.name,
        owner: project.ownerAgentSlug,
        description: project.description,
      },
      project.description ?? "",
    );
  }

  for (const issue of manifest.issues) {
    if (files[issue.path] !== undefined) continue;
    files[issue.path] = buildSyntheticMarkdown(
      {
        kind: "task",
        name: issue.title,
        project: issue.projectSlug,
        assignee: issue.assigneeAgentSlug,
        description: issue.description,
      },
      issue.description ?? "",
    );
  }

  return files;
}

function buildSyntheticMarkdown(
  frontmatter: Record<string, string | boolean | null | undefined>,
  body: string,
) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") {
      lines.push(`${key}: ${value ? "true" : "false"}`);
      continue;
    }
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "", body);
  return lines.join("\n");
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
