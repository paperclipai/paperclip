import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityExport,
  CompanyPortabilityExportResult,
  CompanyPortabilityGoalManifestEntry,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityIssueManifestEntry,
  CompanyPortabilityManifest,
  CompanyPortabilityPreviewGoalPlan,
  CompanyPortabilityPreviewIssuePlan,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewProjectPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityProjectManifestEntry,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey, portabilityManifestSchema } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { loadBuiltInTemplateBundle } from "../templates/registry.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";
import { goalService } from "./goals.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";

const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  goals: false,
  projects: false,
  issues: false,
};

const DEFAULT_COLLISION_STRATEGY: CompanyPortabilityCollisionStrategy = "rename";

const SENSITIVE_ENV_KEY_RE =
  /(api[-_]?key|access[-_]?token|auth(?:_?token)?|authorization|bearer|secret|passwd|password|credential|jwt|private[-_]?key|cookie|connectionstring)/i;

type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, string>;
  warnings: string[];
};

type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
  selectedGoals: CompanyPortabilityGoalManifestEntry[];
  selectedProjects: CompanyPortabilityProjectManifestEntry[];
  selectedIssues: CompanyPortabilityIssueManifestEntry[];
};

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

type CompanyPortabilityServiceOptions = {
  templatesRoot?: string;
};

const RUNTIME_DEFAULT_RULES: Array<{ path: string[]; value: unknown }> = [
  { path: ["heartbeat", "cooldownSec"], value: 10 },
  { path: ["heartbeat", "intervalSec"], value: 3600 },
  { path: ["heartbeat", "wakeOnOnDemand"], value: true },
  { path: ["heartbeat", "wakeOnAssignment"], value: true },
  { path: ["heartbeat", "wakeOnAutomation"], value: true },
  { path: ["heartbeat", "wakeOnDemand"], value: true },
  { path: ["heartbeat", "maxConcurrentRuns"], value: 3 },
];

const ADAPTER_DEFAULT_RULES_BY_TYPE: Record<string, Array<{ path: string[]; value: unknown }>> = {
  codex_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  gemini_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  opencode_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  cursor: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
  ],
  claude_local: [
    { path: ["timeoutSec"], value: 0 },
    { path: ["graceSec"], value: 15 },
    { path: ["maxTurnsPerRun"], value: 300 },
  ],
  openclaw_gateway: [
    { path: ["timeoutSec"], value: 120 },
    { path: ["waitTimeoutMs"], value: 120000 },
    { path: ["sessionKeyStrategy"], value: "fixed" },
    { path: ["sessionKey"], value: "paperclip" },
    { path: ["role"], value: "operator" },
    { path: ["scopes"], value: ["operator.admin"] },
  ],
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toSafeSlug(input: string, fallback: string) {
  return normalizeAgentUrlKey(input) ?? fallback;
}

function uniqueSlug(base: string, used: Set<string>) {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let idx = 2;
  while (true) {
    const candidate = `${base}-${idx}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    idx += 1;
  }
}

function uniqueNameBySlug(baseName: string, existingSlugs: Set<string>) {
  const baseSlug = normalizeAgentUrlKey(baseName) ?? "agent";
  if (!existingSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = normalizeAgentUrlKey(candidateName) ?? `agent-${idx}`;
    if (!existingSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function entityKeyForText(value: string, fallback: string) {
  return normalizeAgentUrlKey(value) ?? fallback;
}

function compareByCreatedAt<T extends { createdAt: Date; id: string }>(a: T, b: T) {
  return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

function buildEntityKeyMap<T extends { id: string; createdAt: Date }>(
  rows: T[],
  getLabel: (row: T) => string,
  fallbackPrefix: string,
) {
  const usedKeys = new Set<string>();
  const keyById = new Map<string, string>();
  for (const row of [...rows].sort(compareByCreatedAt)) {
    const key = uniqueSlug(toSafeSlug(getLabel(row), fallbackPrefix), usedKeys);
    keyById.set(row.id, key);
  }
  return keyById;
}

function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    goals: input?.goals ?? DEFAULT_INCLUDE.goals,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    issues: input?.issues ?? DEFAULT_INCLUDE.issues,
  };
}

function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

function normalizePortableEnv(
  agentSlug: string,
  envValue: unknown,
  requiredSecrets: CompanyPortabilityManifest["requiredSecrets"],
) {
  if (typeof envValue !== "object" || envValue === null || Array.isArray(envValue)) return {};
  const env = envValue as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, binding] of Object.entries(env)) {
    if (SENSITIVE_ENV_KEY_RE.test(key)) {
      requiredSecrets.push({
        key,
        description: `Set ${key} for agent ${agentSlug}`,
        agentSlug,
        providerHint: null,
      });
      continue;
    }
    next[key] = binding;
  }
  return next;
}

function normalizePortableConfig(
  value: unknown,
  agentSlug: string,
  requiredSecrets: CompanyPortabilityManifest["requiredSecrets"],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (key === "cwd" || key === "instructionsFilePath") continue;
    if (key === "env") {
      next[key] = normalizePortableEnv(agentSlug, entry, requiredSecrets);
      continue;
    }
    next[key] = entry;
  }

  return next;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPathDefault(pathSegments: string[], value: unknown, rules: Array<{ path: string[]; value: unknown }>) {
  return rules.some((rule) => jsonEqual(rule.path, pathSegments) && jsonEqual(rule.value, value));
}

function pruneDefaultLikeValue(
  value: unknown,
  opts: {
    dropFalseBooleans: boolean;
    path?: string[];
    defaultRules?: Array<{ path: string[]; value: unknown }>;
  },
): unknown {
  const pathSegments = opts.path ?? [];
  if (opts.defaultRules && isPathDefault(pathSegments, value, opts.defaultRules)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => pruneDefaultLikeValue(entry, { ...opts, path: pathSegments }));
  }
  if (isPlainRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const next = pruneDefaultLikeValue(entry, {
        ...opts,
        path: [...pathSegments, key],
      });
      if (next === undefined) continue;
      out[key] = next;
    }
    return out;
  }
  if (value === undefined) return undefined;
  if (opts.dropFalseBooleans && value === false) return undefined;
  return value;
}

function renderYamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function isEmptyObject(value: unknown): boolean {
  return isPlainRecord(value) && Object.keys(value).length === 0;
}

function renderYamlBlock(value: unknown, indentLevel: number): string[] {
  const indent = "  ".repeat(indentLevel);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    const lines: string[] = [];
    for (const entry of value) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}- ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}-`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return [`${indent}{}`];
    const lines: string[] = [];
    for (const [key, entry] of entries) {
      const scalar =
        entry === null ||
        typeof entry === "string" ||
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        Array.isArray(entry) && entry.length === 0 ||
        isEmptyObject(entry);
      if (scalar) {
        lines.push(`${indent}${key}: ${renderYamlScalar(entry)}`);
        continue;
      }
      lines.push(`${indent}${key}:`);
      lines.push(...renderYamlBlock(entry, indentLevel + 1));
    }
    return lines;
  }

  return [`${indent}${renderYamlScalar(value)}`];
}

function renderFrontmatter(frontmatter: Record<string, unknown>) {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(frontmatter)) {
    const scalar =
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      typeof value === "number" ||
      Array.isArray(value) && value.length === 0 ||
      isEmptyObject(value);
    if (scalar) {
      lines.push(`${key}: ${renderYamlScalar(value)}`);
      continue;
    }
    lines.push(`${key}:`);
    lines.push(...renderYamlBlock(value, 1));
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

function buildMarkdown(frontmatter: Record<string, unknown>, body: string) {
  const cleanBody = body.replace(/\r\n/g, "\n").trim();
  if (!cleanBody) {
    return `${renderFrontmatter(frontmatter)}\n`;
  }
  return `${renderFrontmatter(frontmatter)}\n${cleanBody}\n`;
}

function renderCompanyAgentsSection(agentSummaries: Array<{ slug: string; name: string }>) {
  const lines = ["# Agents", ""];
  if (agentSummaries.length === 0) {
    lines.push("- _none_");
    return lines.join("\n");
  }
  for (const agent of agentSummaries) {
    lines.push(`- ${agent.slug} - ${agent.name}`);
  }
  return lines.join("\n");
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
  const frontmatterRaw = normalized.slice(4, closing).trim();
  const body = normalized.slice(closing + 5).trim();
  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterRaw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const rawValue = line.slice(idx + 1).trim();
    if (!key) continue;
    if (rawValue === "null") {
      frontmatter[key] = null;
      continue;
    }
    if (rawValue === "true" || rawValue === "false") {
      frontmatter[key] = rawValue === "true";
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) {
      frontmatter[key] = Number(rawValue);
      continue;
    }
    try {
      frontmatter[key] = JSON.parse(rawValue);
      continue;
    } catch {
      frontmatter[key] = rawValue;
    }
  }
  return { frontmatter, body };
}

async function fetchJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function dedupeRequiredSecrets(values: CompanyPortabilityManifest["requiredSecrets"]) {
  const seen = new Set<string>();
  const out: CompanyPortabilityManifest["requiredSecrets"] = [];
  for (const value of values) {
    const key = `${value.agentSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function parseGitHubTreeUrl(rawUrl: string) {
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
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  }
  return { owner, repo, ref, basePath };
}

function resolveRawGitHubUrl(owner: string, repo: string, ref: string, filePath: string) {
  const normalizedFilePath = filePath.replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${normalizedFilePath}`;
}

async function readAgentInstructions(agent: AgentLike): Promise<{ body: string; warning: string | null }> {
  const config = agent.adapterConfig as Record<string, unknown>;
  const instructionsFilePath = asString(config.instructionsFilePath);
  if (instructionsFilePath) {
    const workspaceCwd = asString(process.env.PAPERCLIP_WORKSPACE_CWD);
    const candidates = new Set<string>();
    if (path.isAbsolute(instructionsFilePath)) {
      candidates.add(instructionsFilePath);
    } else {
      if (workspaceCwd) candidates.add(path.resolve(workspaceCwd, instructionsFilePath));
      candidates.add(path.resolve(process.cwd(), instructionsFilePath));
    }

    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile() || stat.size > 1024 * 1024) continue;
        const body = await Promise.race([
          fs.readFile(candidate, "utf8"),
          new Promise<string>((_, reject) => {
            setTimeout(() => reject(new Error("timed out reading instructions file")), 1500);
          }),
        ]);
        return { body, warning: null };
      } catch {
        // try next candidate
      }
    }
  }
  const promptTemplate = asString(config.promptTemplate);
  if (promptTemplate) {
    const warning = instructionsFilePath
      ? `Agent ${agent.name} instructionsFilePath was not readable; fell back to promptTemplate.`
      : null;
    return {
      body: promptTemplate,
      warning,
    };
  }
  return {
    body: "_No AGENTS instructions were resolved from current agent config._",
    warning: `Agent ${agent.name} has no resolvable instructionsFilePath/promptTemplate; exported placeholder AGENTS.md.`,
  };
}

export function companyPortabilityService(db: Db, opts?: CompanyPortabilityServiceOptions) {
  const companies = companyService(db);
  const agents = agentService(db);
  const access = accessService(db);
  const goalsSvc = goalService(db);
  const projectsSvc = projectService(db);
  const issuesSvc = issueService(db);

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return {
        manifest: portabilityManifestSchema.parse(source.manifest),
        files: source.files,
        warnings: [],
      };
    }

    if (source.type === "builtin") {
      const bundle = await loadBuiltInTemplateBundle(source.templateId, {
        templatesRoot: opts?.templatesRoot,
      });
      return {
        manifest: portabilityManifestSchema.parse(bundle.manifest),
        files: bundle.files,
        warnings: bundle.warnings,
      };
    }

    if (source.type === "url") {
      const manifestJson = await fetchJson(source.url);
      const manifest = portabilityManifestSchema.parse(manifestJson);
      const base = new URL(".", source.url);
      const files: Record<string, string> = {};
      const warnings: string[] = [];

      if (manifest.company?.path) {
        const companyPath = ensureMarkdownPath(manifest.company.path);
        files[companyPath] = await fetchText(new URL(companyPath, base).toString());
      }
      for (const agent of manifest.agents) {
        const filePath = ensureMarkdownPath(agent.path);
        files[filePath] = await fetchText(new URL(filePath, base).toString());
      }

      return { manifest, files, warnings };
    }

    const parsed = parseGitHubTreeUrl(source.url);
    let ref = parsed.ref;
    const manifestRelativePath = [parsed.basePath, "paperclip.manifest.json"].filter(Boolean).join("/");
    let manifest: CompanyPortabilityManifest | null = null;
    const warnings: string[] = [];
    try {
      manifest = portabilityManifestSchema.parse(
        await fetchJson(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, manifestRelativePath)),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        manifest = portabilityManifestSchema.parse(
          await fetchJson(resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, manifestRelativePath)),
        );
      } else {
        throw err;
      }
    }

    const files: Record<string, string> = {};
    if (manifest.company?.path) {
      files[manifest.company.path] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, [parsed.basePath, manifest.company.path].filter(Boolean).join("/")),
      );
    }
    for (const agent of manifest.agents) {
      files[agent.path] = await fetchText(
        resolveRawGitHubUrl(parsed.owner, parsed.repo, ref, [parsed.basePath, agent.path].filter(Boolean).join("/")),
      );
    }
    return { manifest, files, warnings };
  }

  async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude(input.include);
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, string> = {};
    const warnings: string[] = [];
    const requiredSecrets: CompanyPortabilityManifest["requiredSecrets"] = [];
    const generatedAt = new Date().toISOString();

    const manifest: CompanyPortabilityManifest = {
      schemaVersion: 1,
      generatedAt,
      source: {
        companyId: company.id,
        companyName: company.name,
      },
      includes: include,
      company: null,
      agents: [],
      goals: [],
      projects: [],
      issues: [],
      requiredSecrets: [],
    };

    const allAgentRows =
      include.agents || include.goals || include.projects || include.issues
        ? await agents.list(companyId, { includeTerminated: true })
        : [];
    const agentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    if (include.agents) {
      const skipped = allAgentRows.length - agentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    const goalRows = include.goals || include.projects || include.issues
      ? await goalsSvc.list(companyId)
      : [];
    const goalIdToKey = buildEntityKeyMap(goalRows, (goal) => goal.title, "goal");

    const projectRows = include.projects || include.issues
      ? await projectsSvc.list(companyId)
      : [];
    const projectIdToKey = buildEntityKeyMap(projectRows, (project) => project.name, "project");

    const issueRows = include.issues
      ? await issuesSvc.list(companyId)
      : [];
    const issueIdToKey = buildEntityKeyMap(issueRows, (issue) => issue.title, "issue");

    if (include.company) {
      const companyPath = "COMPANY.md";
      const companyAgentSummaries = agentRows.map((agent) => ({
        slug: idToSlug.get(agent.id) ?? "agent",
        name: agent.name,
      }));
      files[companyPath] = buildMarkdown(
        {
          kind: "company",
          name: company.name,
          description: company.description ?? null,
          brandColor: company.brandColor ?? null,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents,
        },
        renderCompanyAgentsSection(companyAgentSummaries),
      );
      manifest.company = {
        path: companyPath,
        name: company.name,
        description: company.description ?? null,
        brandColor: company.brandColor ?? null,
        requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents,
      };
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const instructions = await readAgentInstructions(agent);
        if (instructions.warning) warnings.push(instructions.warning);
        const agentPath = `agents/${slug}/AGENTS.md`;

        const secretStart = requiredSecrets.length;
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.adapterConfig, slug, requiredSecrets),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig, slug, requiredSecrets),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
        const agentRequiredSecrets = dedupeRequiredSecrets(
          requiredSecrets
            .slice(secretStart)
            .filter((requirement) => requirement.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;

        files[agentPath] = buildMarkdown(
          {
            name: agent.name,
            slug,
            role: agent.role,
            adapterType: agent.adapterType,
            kind: "agent",
            icon: agent.icon ?? null,
            capabilities: agent.capabilities ?? null,
            reportsTo: reportsToSlug,
            runtimeConfig: portableRuntimeConfig,
            permissions: portablePermissions,
            adapterConfig: portableAdapterConfig,
            requiredSecrets: agentRequiredSecrets,
          },
          instructions.body,
        );

        manifest.agents.push({
          slug,
          name: agent.name,
          path: agentPath,
          role: agent.role,
          title: agent.title ?? null,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          reportsToSlug,
          adapterType: agent.adapterType,
          adapterConfig: portableAdapterConfig,
          runtimeConfig: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        });
      }
    }

    let warnedAgentRefsWithoutAgents = false;
    let warnedGoalRefsWithoutGoals = false;
    let warnedProjectRefsWithoutProjects = false;
    let warnedArchivedProjectState = false;
    let warnedIssuePortableMetadata = false;

    if (include.goals) {
      for (const goal of [...goalRows].sort(compareByCreatedAt)) {
        const ownerAgentSlug = goal.ownerAgentId ? (idToSlug.get(goal.ownerAgentId) ?? null) : null;
        if (goal.ownerAgentId && !ownerAgentSlug && include.agents) {
          warnings.push(`Skipped owner agent reference for goal ${goal.title}; agent was not exportable.`);
        }
        if (goal.ownerAgentId && !include.agents && !warnedAgentRefsWithoutAgents) {
          warnings.push("Exported goals/projects/issues include agent references, but agents were not included; those links may not resolve on import.");
          warnedAgentRefsWithoutAgents = true;
        }
        manifest.goals.push({
          key: goalIdToKey.get(goal.id)!,
          title: goal.title,
          description: goal.description,
          level: goal.level as CompanyPortabilityGoalManifestEntry["level"],
          status: goal.status as CompanyPortabilityGoalManifestEntry["status"],
          parentKey: goal.parentId ? (goalIdToKey.get(goal.parentId) ?? null) : null,
          ownerAgentSlug,
        });
      }
    }

    if (include.projects) {
      for (const project of [...projectRows].sort(compareByCreatedAt)) {
        const goalKeys = (project.goalIds ?? [])
          .map((goalId) => goalIdToKey.get(goalId) ?? null)
          .filter((value): value is string => Boolean(value));
        const leadAgentSlug = project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null;

        if ((project.goalIds?.length ?? 0) > 0 && !include.goals && !warnedGoalRefsWithoutGoals) {
          warnings.push("Exported projects/issues include goal references, but goals were not included; those links may not resolve on import.");
          warnedGoalRefsWithoutGoals = true;
        }
        if (project.leadAgentId && !include.agents && !warnedAgentRefsWithoutAgents) {
          warnings.push("Exported goals/projects/issues include agent references, but agents were not included; those links may not resolve on import.");
          warnedAgentRefsWithoutAgents = true;
        }
        if (project.leadAgentId && !leadAgentSlug && include.agents) {
          warnings.push(`Skipped lead agent reference for project ${project.name}; agent was not exportable.`);
        }
        if (project.archivedAt && !warnedArchivedProjectState) {
          warnings.push("Project archived timestamps are not preserved by portability export.");
          warnedArchivedProjectState = true;
        }

        manifest.projects.push({
          key: projectIdToKey.get(project.id)!,
          name: project.name,
          description: project.description,
          status: project.status as CompanyPortabilityProjectManifestEntry["status"],
          goalKeys,
          leadAgentSlug,
          targetDate: project.targetDate,
          color: project.color,
          workspaces: (project.workspaces ?? []).map((workspace) => ({
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            metadata: workspace.metadata ?? null,
            isPrimary: workspace.isPrimary,
          })),
        });
      }
    }

    if (include.issues) {
      for (const issue of [...issueRows].sort(compareByCreatedAt)) {
        const projectKey = issue.projectId ? (projectIdToKey.get(issue.projectId) ?? null) : null;
        const goalKey = issue.goalId ? (goalIdToKey.get(issue.goalId) ?? null) : null;
        const parentKey = issue.parentId ? (issueIdToKey.get(issue.parentId) ?? null) : null;
        const assigneeAgentSlug = issue.assigneeAgentId ? (idToSlug.get(issue.assigneeAgentId) ?? null) : null;

        if (issue.projectId && !include.projects && !warnedProjectRefsWithoutProjects) {
          warnings.push("Exported issues include project references, but projects were not included; those links may not resolve on import.");
          warnedProjectRefsWithoutProjects = true;
        }
        if (issue.goalId && !include.goals && !warnedGoalRefsWithoutGoals) {
          warnings.push("Exported projects/issues include goal references, but goals were not included; those links may not resolve on import.");
          warnedGoalRefsWithoutGoals = true;
        }
        if (issue.assigneeAgentId && !include.agents && !warnedAgentRefsWithoutAgents) {
          warnings.push("Exported goals/projects/issues include agent references, but agents were not included; those links may not resolve on import.");
          warnedAgentRefsWithoutAgents = true;
        }
        if (
          (issue.assigneeAgentId && !assigneeAgentSlug && include.agents) ||
          (issue.projectId && !projectKey && include.projects) ||
          (issue.goalId && !goalKey && include.goals) ||
          (issue.parentId && !parentKey)
        ) {
          warnings.push(`Some references on issue ${issue.title} could not be exported and were omitted.`);
        }
        if (
          issue.assigneeUserId ||
          (issue.labels?.length ?? 0) > 0 ||
          issue.assigneeAdapterOverrides ||
          issue.startedAt ||
          issue.completedAt ||
          issue.cancelledAt ||
          issue.hiddenAt
        ) {
          if (!warnedIssuePortableMetadata) {
            warnings.push(
              "Issue user assignees, labels, adapter overrides, visibility flags, and status timestamps are not preserved by portability export.",
            );
            warnedIssuePortableMetadata = true;
          }
        }

        manifest.issues.push({
          key: issueIdToKey.get(issue.id)!,
          title: issue.title,
          description: issue.description,
          status: issue.status as CompanyPortabilityIssueManifestEntry["status"],
          priority: issue.priority as CompanyPortabilityIssueManifestEntry["priority"],
          projectKey,
          goalKey,
          parentKey,
          assigneeAgentSlug,
          requestDepth: issue.requestDepth,
          billingCode: issue.billingCode,
        });
      }
    }

    manifest.requiredSecrets = dedupeRequiredSecrets(requiredSecrets);
    return {
      manifest,
      files,
      warnings,
    };
  }

  async function buildPreview(input: CompanyPortabilityPreview): Promise<ImportPlanInternal> {
    const include = normalizeInclude(input.include);
    const source = await resolveSource(input.source);
    const manifest = source.manifest;
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }

    const selectedSlugs = input.agents && input.agents !== "all"
      ? Array.from(new Set(input.agents))
      : manifest.agents.map((agent) => agent.slug);

    const selectedAgents = manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug));
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }
    const selectedGoals = include.goals ? manifest.goals : [];
    const selectedProjects = include.projects ? manifest.projects : [];
    const selectedIssues = include.issues ? manifest.issues : [];

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = source.files[filePath];
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
    }

    let targetCompanyId: string | null = null;
    let targetCompanyName: string | null = null;

    if (input.target.mode === "existing_company") {
      const targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      targetCompanyId = targetCompany.id;
      targetCompanyName = targetCompany.name;
    }

    const agentPlans: CompanyPortabilityPreviewAgentPlan[] = [];
    const goalPlans: CompanyPortabilityPreviewGoalPlan[] = [];
    const projectPlans: CompanyPortabilityPreviewProjectPlan[] = [];
    const issuePlans: CompanyPortabilityPreviewIssuePlan[] = [];
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();
    const existingKeyToGoal = new Map<string, { id: string; title: string }>();
    const existingGoalKeys = new Set<string>();
    const existingKeyToProject = new Map<string, { id: string; name: string }>();
    const existingProjectKeys = new Set<string>();
    const existingKeyToIssue = new Map<string, { id: string; title: string }>();
    const existingIssueKeys = new Set<string>();

    if (input.target.mode === "existing_company" && targetCompanyId) {
      const existingAgents = await agents.list(targetCompanyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
      if (include.goals || include.projects || include.issues) {
        const existingGoals = await goalsSvc.list(targetCompanyId);
        for (const existing of existingGoals) {
          const key = entityKeyForText(existing.title, existing.id);
          if (!existingKeyToGoal.has(key)) existingKeyToGoal.set(key, existing);
          existingGoalKeys.add(key);
        }
      }
      if (include.projects || include.issues) {
        const existingProjects = await projectsSvc.list(targetCompanyId);
        for (const existing of existingProjects) {
          const key = entityKeyForText(existing.name, existing.id);
          if (!existingKeyToProject.has(key)) existingKeyToProject.set(key, existing);
          existingProjectKeys.add(key);
        }
      }
      if (include.issues) {
        const existingIssues = await issuesSvc.list(targetCompanyId);
        for (const existing of existingIssues) {
          const key = entityKeyForText(existing.title, existing.id);
          if (!existingKeyToIssue.has(key)) existingKeyToIssue.set(key, existing);
          existingIssueKeys.add(key);
        }
      }
    }

    for (const manifestAgent of selectedAgents) {
      const existing = existingSlugToAgent.get(manifestAgent.slug) ?? null;
      if (!existing) {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "create",
          plannedName: manifestAgent.name,
          existingAgentId: null,
          reason: null,
        });
        continue;
      }

      if (collisionStrategy === "replace") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "update",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; replace strategy.",
        });
        continue;
      }

      if (collisionStrategy === "skip") {
        agentPlans.push({
          slug: manifestAgent.slug,
          action: "skip",
          plannedName: existing.name,
          existingAgentId: existing.id,
          reason: "Existing slug matched; skip strategy.",
        });
        continue;
      }

      const renamed = uniqueNameBySlug(manifestAgent.name, existingSlugs);
      existingSlugs.add(normalizeAgentUrlKey(renamed) ?? manifestAgent.slug);
      agentPlans.push({
        slug: manifestAgent.slug,
        action: "create",
        plannedName: renamed,
        existingAgentId: existing.id,
        reason: "Existing slug matched; rename strategy.",
      });
    }

    for (const manifestGoal of selectedGoals) {
      const existing = existingKeyToGoal.get(manifestGoal.key) ?? null;
      if (!existing) {
        goalPlans.push({
          key: manifestGoal.key,
          action: "create",
          plannedTitle: manifestGoal.title,
          existingGoalId: null,
          reason: null,
        });
      } else if (collisionStrategy === "replace") {
        goalPlans.push({
          key: manifestGoal.key,
          action: "update",
          plannedTitle: existing.title,
          existingGoalId: existing.id,
          reason: "Existing goal key matched; replace strategy.",
        });
      } else if (collisionStrategy === "skip") {
        goalPlans.push({
          key: manifestGoal.key,
          action: "skip",
          plannedTitle: existing.title,
          existingGoalId: existing.id,
          reason: "Existing goal key matched; skip strategy.",
        });
      } else {
        const renamed = uniqueNameBySlug(manifestGoal.title, existingGoalKeys);
        existingGoalKeys.add(entityKeyForText(renamed, manifestGoal.key));
        goalPlans.push({
          key: manifestGoal.key,
          action: "create",
          plannedTitle: renamed,
          existingGoalId: existing.id,
          reason: "Existing goal key matched; rename strategy.",
        });
      }
    }

    for (const manifestProject of selectedProjects) {
      const existing = existingKeyToProject.get(manifestProject.key) ?? null;
      if (!existing) {
        projectPlans.push({
          key: manifestProject.key,
          action: "create",
          plannedName: manifestProject.name,
          existingProjectId: null,
          reason: null,
        });
      } else if (collisionStrategy === "replace") {
        projectPlans.push({
          key: manifestProject.key,
          action: "update",
          plannedName: existing.name,
          existingProjectId: existing.id,
          reason: "Existing project key matched; replace strategy.",
        });
      } else if (collisionStrategy === "skip") {
        projectPlans.push({
          key: manifestProject.key,
          action: "skip",
          plannedName: existing.name,
          existingProjectId: existing.id,
          reason: "Existing project key matched; skip strategy.",
        });
      } else {
        const renamed = uniqueNameBySlug(manifestProject.name, existingProjectKeys);
        existingProjectKeys.add(entityKeyForText(renamed, manifestProject.key));
        projectPlans.push({
          key: manifestProject.key,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing project key matched; rename strategy.",
        });
      }
    }

    for (const manifestIssue of selectedIssues) {
      const existing = existingKeyToIssue.get(manifestIssue.key) ?? null;
      if (!existing) {
        issuePlans.push({
          key: manifestIssue.key,
          action: "create",
          plannedTitle: manifestIssue.title,
          existingIssueId: null,
          reason: null,
        });
      } else if (collisionStrategy === "replace") {
        issuePlans.push({
          key: manifestIssue.key,
          action: "update",
          plannedTitle: existing.title,
          existingIssueId: existing.id,
          reason: "Existing issue key matched; replace strategy.",
        });
      } else if (collisionStrategy === "skip") {
        issuePlans.push({
          key: manifestIssue.key,
          action: "skip",
          plannedTitle: existing.title,
          existingIssueId: existing.id,
          reason: "Existing issue key matched; skip strategy.",
        });
      } else {
        const renamed = uniqueNameBySlug(manifestIssue.title, existingIssueKeys);
        existingIssueKeys.add(entityKeyForText(renamed, manifestIssue.key));
        issuePlans.push({
          key: manifestIssue.key,
          action: "create",
          plannedTitle: renamed,
          existingIssueId: existing.id,
          reason: "Existing issue key matched; rename strategy.",
        });
      }
    }

    const selectedGoalKeys = new Set(selectedGoals.map((goal) => goal.key));
    const selectedProjectKeys = new Set(selectedProjects.map((project) => project.key));
    const selectedIssueKeys = new Set(selectedIssues.map((issue) => issue.key));
    const selectedAgentKeys = new Set(selectedAgents.map((agent) => agent.slug));

    for (const goal of selectedGoals) {
      if (
        goal.parentKey &&
        !selectedGoalKeys.has(goal.parentKey) &&
        !existingGoalKeys.has(goal.parentKey)
      ) {
        warnings.push(`Goal ${goal.key} references missing parent goal ${goal.parentKey}; parent link will be skipped.`);
      }
      if (
        goal.ownerAgentSlug &&
        !selectedAgentKeys.has(goal.ownerAgentSlug) &&
        !existingSlugToAgent.has(goal.ownerAgentSlug)
      ) {
        warnings.push(`Goal ${goal.key} references missing owner agent ${goal.ownerAgentSlug}; owner link will be skipped.`);
      }
    }

    for (const project of selectedProjects) {
      for (const goalKey of project.goalKeys) {
        if (!selectedGoalKeys.has(goalKey) && !existingGoalKeys.has(goalKey)) {
          warnings.push(`Project ${project.key} references missing goal ${goalKey}; goal links will be skipped.`);
        }
      }
      if (
        project.leadAgentSlug &&
        !selectedAgentKeys.has(project.leadAgentSlug) &&
        !existingSlugToAgent.has(project.leadAgentSlug)
      ) {
        warnings.push(`Project ${project.key} references missing lead agent ${project.leadAgentSlug}; lead link will be skipped.`);
      }
    }

    for (const issue of selectedIssues) {
      if (
        issue.projectKey &&
        !selectedProjectKeys.has(issue.projectKey) &&
        !existingProjectKeys.has(issue.projectKey)
      ) {
        warnings.push(`Issue ${issue.key} references missing project ${issue.projectKey}; project link will be skipped.`);
      }
      if (
        issue.goalKey &&
        !selectedGoalKeys.has(issue.goalKey) &&
        !existingGoalKeys.has(issue.goalKey)
      ) {
        warnings.push(`Issue ${issue.key} references missing goal ${issue.goalKey}; goal link will be skipped.`);
      }
      if (
        issue.parentKey &&
        !selectedIssueKeys.has(issue.parentKey) &&
        !existingIssueKeys.has(issue.parentKey)
      ) {
        warnings.push(`Issue ${issue.key} references missing parent issue ${issue.parentKey}; parent link will be skipped.`);
      }
      if (
        issue.assigneeAgentSlug &&
        !selectedAgentKeys.has(issue.assigneeAgentSlug) &&
        !existingSlugToAgent.has(issue.assigneeAgentSlug)
      ) {
        warnings.push(`Issue ${issue.key} references missing assignee agent ${issue.assigneeAgentSlug}; assignee link will be skipped.`);
      }
    }

    const preview: CompanyPortabilityPreviewResult = {
      include,
      targetCompanyId,
      targetCompanyName,
      collisionStrategy,
      selectedAgentSlugs: selectedAgents.map((agent) => agent.slug),
      plan: {
        companyAction: input.target.mode === "new_company"
          ? "create"
          : include.company
            ? "update"
            : "none",
        agentPlans,
        goalPlans,
        projectPlans,
        issuePlans,
      },
      requiredSecrets: manifest.requiredSecrets ?? [],
      warnings,
      errors,
    };

    return {
      preview,
      source,
      include,
      collisionStrategy,
      selectedAgents,
      selectedGoals,
      selectedProjects,
      selectedIssues,
    };
  }

  async function previewImport(input: CompanyPortabilityPreview): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
  ): Promise<CompanyPortabilityImportResult> {
    const plan = await buildPreview(input);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      const companyName =
        asString(input.target.newCompanyName) ??
        sourceManifest.company?.name ??
        sourceManifest.source?.companyName ??
        "Imported Company";
      const created = await companies.create({
        name: companyName,
        description: include.company ? (sourceManifest.company?.description ?? null) : null,
        brandColor: include.company ? (sourceManifest.company?.brandColor ?? null) : null,
        requireBoardApprovalForNewAgents: include.company
          ? (sourceManifest.company?.requireBoardApprovalForNewAgents ?? true)
          : true,
      });
      await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company) {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const resultGoals: CompanyPortabilityImportResult["goals"] = [];
    const resultProjects: CompanyPortabilityImportResult["projects"] = [];
    const resultIssues: CompanyPortabilityImportResult["issues"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const importedGoalKeyToId = new Map<string, string>();
    const existingGoalKeyToId = new Map<string, string>();
    const importedProjectKeyToId = new Map<string, string>();
    const existingProjectKeyToId = new Map<string, string>();
    const importedIssueKeyToId = new Map<string, string>();
    const existingIssueKeyToId = new Map<string, string>();

    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }
    if (include.goals || include.projects || include.issues) {
      const existingGoals = await goalsSvc.list(targetCompany.id);
      for (const existing of existingGoals) {
        existingGoalKeyToId.set(entityKeyForText(existing.title, existing.id), existing.id);
      }
    }
    if (include.projects || include.issues) {
      const existingProjects = await projectsSvc.list(targetCompany.id);
      for (const existing of existingProjects) {
        existingProjectKeyToId.set(entityKeyForText(existing.name, existing.id), existing.id);
      }
    }
    if (include.issues) {
      const existingIssues = await issuesSvc.list(targetCompany.id);
      for (const existing of existingIssues) {
        existingIssueKeyToId.set(entityKeyForText(existing.title, existing.id), existing.id);
      }
    }

    if (include.agents) {
      for (const planAgent of plan.preview.plan.agentPlans) {
        const manifestAgent = plan.selectedAgents.find((agent) => agent.slug === planAgent.slug);
        if (!manifestAgent) continue;
        if (planAgent.action === "skip") {
          resultAgents.push({
            slug: planAgent.slug,
            id: planAgent.existingAgentId,
            action: "skipped",
            name: planAgent.plannedName,
            reason: planAgent.reason,
          });
          continue;
        }

        const markdownRaw = plan.source.files[manifestAgent.path];
        if (!markdownRaw) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported without prompt template.`);
        }
        const markdown = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : { frontmatter: {}, body: "" };
        const adapterConfig = {
          ...manifestAgent.adapterConfig,
          promptTemplate: markdown.body || asString((manifestAgent.adapterConfig as Record<string, unknown>).promptTemplate) || "",
        } as Record<string, unknown>;
        delete adapterConfig.instructionsFilePath;
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          adapterType: manifestAgent.adapterType,
          adapterConfig,
          runtimeConfig: manifestAgent.runtimeConfig,
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          const updated = await agents.update(planAgent.existingAgentId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing agent ${planAgent.existingAgentId}.`);
            resultAgents.push({
              slug: planAgent.slug,
              id: null,
              action: "skipped",
              name: planAgent.plannedName,
              reason: "Existing target agent not found.",
            });
            continue;
          }
          importedSlugToAgentId.set(planAgent.slug, updated.id);
          existingSlugToAgentId.set(normalizeAgentUrlKey(updated.name) ?? updated.id, updated.id);
          resultAgents.push({
            slug: planAgent.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planAgent.reason,
          });
          continue;
        }

        const created = await agents.create(targetCompany.id, patch);
        importedSlugToAgentId.set(planAgent.slug, created.id);
        existingSlugToAgentId.set(normalizeAgentUrlKey(created.name) ?? created.id, created.id);
        resultAgents.push({
          slug: planAgent.slug,
          id: created.id,
          action: "created",
          name: created.name,
          reason: planAgent.reason,
        });
      }

      for (const manifestAgent of plan.selectedAgents) {
        const agentId = importedSlugToAgentId.get(manifestAgent.slug);
        if (!agentId) continue;
        const managerSlug = manifestAgent.reportsToSlug;
        if (!managerSlug) continue;
        const managerId = importedSlugToAgentId.get(managerSlug) ?? existingSlugToAgentId.get(managerSlug) ?? null;
        if (!managerId || managerId === agentId) continue;
        try {
          await agents.update(agentId, { reportsTo: managerId });
        } catch {
          warnings.push(`Could not assign manager ${managerSlug} for imported agent ${manifestAgent.slug}.`);
        }
      }
    }

    if (include.goals) {
      for (const planGoal of plan.preview.plan.goalPlans) {
        const manifestGoal = plan.selectedGoals.find((goal) => goal.key === planGoal.key);
        if (!manifestGoal) continue;
        if (planGoal.action === "skip") {
          resultGoals.push({
            key: planGoal.key,
            id: planGoal.existingGoalId,
            action: "skipped",
            title: planGoal.plannedTitle,
            reason: planGoal.reason,
          });
          continue;
        }
        const patch = {
          title: planGoal.plannedTitle,
          description: manifestGoal.description,
          level: manifestGoal.level,
          status: manifestGoal.status,
          parentId: null,
          ownerAgentId: null,
        };
        if (planGoal.action === "update" && planGoal.existingGoalId) {
          const updated = await goalsSvc.update(planGoal.existingGoalId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing goal ${planGoal.existingGoalId}.`);
            resultGoals.push({
              key: planGoal.key,
              id: null,
              action: "skipped",
              title: planGoal.plannedTitle,
              reason: "Existing target goal not found.",
            });
            continue;
          }
          importedGoalKeyToId.set(planGoal.key, updated.id);
          existingGoalKeyToId.set(entityKeyForText(updated.title, updated.id), updated.id);
          resultGoals.push({
            key: planGoal.key,
            id: updated.id,
            action: "updated",
            title: updated.title,
            reason: planGoal.reason,
          });
          continue;
        }
        const created = await goalsSvc.create(targetCompany.id, patch);
        importedGoalKeyToId.set(planGoal.key, created.id);
        existingGoalKeyToId.set(entityKeyForText(created.title, created.id), created.id);
        resultGoals.push({
          key: planGoal.key,
          id: created.id,
          action: "created",
          title: created.title,
          reason: planGoal.reason,
        });
      }

      for (const manifestGoal of plan.selectedGoals) {
        const goalId = importedGoalKeyToId.get(manifestGoal.key);
        if (!goalId) continue;
        const parentId = manifestGoal.parentKey
          ? importedGoalKeyToId.get(manifestGoal.parentKey) ?? existingGoalKeyToId.get(manifestGoal.parentKey) ?? null
          : null;
        const ownerAgentId = manifestGoal.ownerAgentSlug
          ? importedSlugToAgentId.get(manifestGoal.ownerAgentSlug) ??
            existingSlugToAgentId.get(manifestGoal.ownerAgentSlug) ??
            null
          : null;
        await goalsSvc.update(goalId, {
          parentId,
          ownerAgentId,
        });
      }
    }

    if (include.projects) {
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = plan.selectedProjects.find((project) => project.key === planProject.key);
        if (!manifestProject) continue;
        if (planProject.action === "skip") {
          resultProjects.push({
            key: planProject.key,
            id: planProject.existingProjectId,
            action: "skipped",
            name: planProject.plannedName,
            reason: planProject.reason,
          });
          continue;
        }

        const goalIds = manifestProject.goalKeys
          .map((goalKey) => importedGoalKeyToId.get(goalKey) ?? existingGoalKeyToId.get(goalKey) ?? null)
          .filter((value): value is string => Boolean(value));
        const leadAgentId = manifestProject.leadAgentSlug
          ? importedSlugToAgentId.get(manifestProject.leadAgentSlug) ??
            existingSlugToAgentId.get(manifestProject.leadAgentSlug) ??
            null
          : null;
        const patch = {
          name: planProject.plannedName,
          description: manifestProject.description,
          status: manifestProject.status,
          leadAgentId,
          targetDate: manifestProject.targetDate,
          color: manifestProject.color,
          goalIds,
        };

        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projectsSvc.update(planProject.existingProjectId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
            resultProjects.push({
              key: planProject.key,
              id: null,
              action: "skipped",
              name: planProject.plannedName,
              reason: "Existing target project not found.",
            });
            continue;
          }
          importedProjectKeyToId.set(planProject.key, updated.id);
          existingProjectKeyToId.set(entityKeyForText(updated.name, updated.id), updated.id);
          resultProjects.push({
            key: planProject.key,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planProject.reason,
          });
        } else {
          const created = await projectsSvc.create(targetCompany.id, patch);
          importedProjectKeyToId.set(planProject.key, created.id);
          existingProjectKeyToId.set(entityKeyForText(created.name, created.id), created.id);
          resultProjects.push({
            key: planProject.key,
            id: created.id,
            action: "created",
            name: created.name,
            reason: planProject.reason,
          });
        }

        const projectId =
          importedProjectKeyToId.get(planProject.key) ??
          (planProject.existingProjectId ? planProject.existingProjectId : null);
        if (!projectId) continue;
        const existingWorkspaces = await projectsSvc.listWorkspaces(projectId);
        const existingWorkspaceKeys = new Set(
          existingWorkspaces.map((workspace) =>
            `${workspace.name}:${workspace.cwd ?? ""}:${workspace.repoUrl ?? ""}`,
          ),
        );
        for (const workspace of manifestProject.workspaces) {
          const workspaceKey = `${workspace.name}:${workspace.cwd ?? ""}:${workspace.repoUrl ?? ""}`;
          if (existingWorkspaceKeys.has(workspaceKey)) continue;
          const createdWorkspace = await projectsSvc.createWorkspace(projectId, {
            name: workspace.name,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            metadata: workspace.metadata,
            isPrimary: workspace.isPrimary,
          });
          if (createdWorkspace) {
            existingWorkspaceKeys.add(workspaceKey);
          } else {
            warnings.push(`Could not create workspace ${workspace.name} for imported project ${manifestProject.key}.`);
          }
        }
      }
    }

    if (include.issues) {
      for (const planIssue of plan.preview.plan.issuePlans) {
        const manifestIssue = plan.selectedIssues.find((issue) => issue.key === planIssue.key);
        if (!manifestIssue) continue;
        if (planIssue.action === "skip") {
          resultIssues.push({
            key: planIssue.key,
            id: planIssue.existingIssueId,
            action: "skipped",
            title: planIssue.plannedTitle,
            reason: planIssue.reason,
          });
          continue;
        }

        const projectId = manifestIssue.projectKey
          ? importedProjectKeyToId.get(manifestIssue.projectKey) ??
            existingProjectKeyToId.get(manifestIssue.projectKey) ??
            null
          : null;
        const goalId = manifestIssue.goalKey
          ? importedGoalKeyToId.get(manifestIssue.goalKey) ??
            existingGoalKeyToId.get(manifestIssue.goalKey) ??
            null
          : null;
        const assigneeAgentId = manifestIssue.assigneeAgentSlug
          ? importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug) ??
            existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug) ??
            null
          : null;
        const patch = {
          projectId,
          goalId,
          parentId: null,
          title: planIssue.plannedTitle,
          description: manifestIssue.description,
          status: manifestIssue.status,
          priority: manifestIssue.priority,
          assigneeAgentId,
          requestDepth: manifestIssue.requestDepth,
          billingCode: manifestIssue.billingCode,
          createdByAgentId: null,
          createdByUserId: actorUserId ?? null,
        };

        if (planIssue.action === "update" && planIssue.existingIssueId) {
          const updated = await issuesSvc.update(planIssue.existingIssueId, patch);
          if (!updated) {
            warnings.push(`Skipped update for missing issue ${planIssue.existingIssueId}.`);
            resultIssues.push({
              key: planIssue.key,
              id: null,
              action: "skipped",
              title: planIssue.plannedTitle,
              reason: "Existing target issue not found.",
            });
            continue;
          }
          importedIssueKeyToId.set(planIssue.key, updated.id);
          existingIssueKeyToId.set(entityKeyForText(updated.title, updated.id), updated.id);
          resultIssues.push({
            key: planIssue.key,
            id: updated.id,
            action: "updated",
            title: updated.title,
            reason: planIssue.reason,
          });
        } else {
          const created = await issuesSvc.create(targetCompany.id, patch);
          importedIssueKeyToId.set(planIssue.key, created.id);
          existingIssueKeyToId.set(entityKeyForText(created.title, created.id), created.id);
          resultIssues.push({
            key: planIssue.key,
            id: created.id,
            action: "created",
            title: created.title,
            reason: planIssue.reason,
          });
        }
      }

      for (const manifestIssue of plan.selectedIssues) {
        const issueId = importedIssueKeyToId.get(manifestIssue.key);
        if (!issueId || !manifestIssue.parentKey) continue;
        const parentId =
          importedIssueKeyToId.get(manifestIssue.parentKey) ??
          existingIssueKeyToId.get(manifestIssue.parentKey) ??
          null;
        if (!parentId || parentId === issueId) continue;
        await issuesSvc.update(issueId, { parentId });
      }
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      goals: resultGoals,
      projects: resultProjects,
      issues: resultIssues,
      requiredSecrets: sourceManifest.requiredSecrets ?? [],
      warnings,
    };
  }

  return {
    exportBundle,
    previewImport,
    importBundle,
  };
}
