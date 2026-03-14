import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityExport,
  CompanyPortabilityExportResult,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewResult,
} from "@paperclipai/shared";
import { normalizeAgentUrlKey, portabilityManifestSchema } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { companyService } from "./companies.js";

const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
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
};

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
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

function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
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

export function companyPortabilityService(db: Db) {
  const companies = companyService(db);
  const agents = agentService(db);
  const access = accessService(db);

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return {
        manifest: portabilityManifestSchema.parse(source.manifest),
        files: source.files,
        warnings: [],
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
      requiredSecrets: [],
    };

    const allAgentRows = include.agents ? await agents.list(companyId, { includeTerminated: true }) : [];
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
    const existingSlugToAgent = new Map<string, { id: string; name: string }>();
    const existingSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
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
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
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

      // Apply reporting links once all imported agent ids are available.
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

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
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
