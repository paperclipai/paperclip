import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Db } from "@paperclipai/db";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityCollisionStrategy,
  CompanyPortabilityEnvInput,
  CompanyPortabilityExport,
  CompanyPortabilityFileEntry,
  CompanyPortabilityExportPreviewResult,
  CompanyPortabilityExportResult,
  CompanyPortabilityImport,
  CompanyPortabilityImportResult,
  CompanyPortabilityInclude,
  CompanyPortabilityManifest,
  CompanyPortabilityPreview,
  CompanyPortabilityPreviewAgentPlan,
  CompanyPortabilityPreviewResult,
  CompanyPortabilityProjectManifestEntry,
  CompanyPortabilityProjectWorkspaceManifestEntry,
  CompanyPortabilityIssueRoutineManifestEntry,
  CompanyPortabilityIssueRoutineTriggerManifestEntry,
  CompanyPortabilityIssueManifestEntry,
  CompanyPortabilitySidebarOrder,
  CompanyPortabilitySkillManifestEntry,
  CompanySkill,
  AgentEnvConfig,
  RoutineVariable,
} from "@paperclipai/shared";
import {
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  PROJECT_STATUSES,
  ROUTINE_CATCH_UP_POLICIES,
  ROUTINE_CONCURRENCY_POLICIES,
  ROUTINE_STATUSES,
  ROUTINE_TRIGGER_KINDS,
  ROUTINE_TRIGGER_SIGNING_MODES,
  deriveProjectUrlKey,
  envConfigSchema,
  normalizeAgentUrlKey,
} from "@paperclipai/shared";
import {
  readPaperclipSkillSyncPreference,
  writePaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { notFound, unprocessable } from "../errors.js";
import { ghFetch, gitHubApiBase, resolveRawGitHubUrl } from "./github-fetch.js";
import type { StorageService } from "../storage/types.js";
import { accessService } from "./access.js";
import { agentService } from "./agents.js";
import { agentInstructionsService } from "./agent-instructions.js";
import { assetService } from "./assets.js";
import { generateReadme } from "./company-export-readme.js";
import { renderOrgChartPng, type OrgNode } from "../routes/org-chart-svg.js";
import { companySkillService } from "./company-skills.js";
import { companyService } from "./companies.js";
import { validateCron } from "./cron.js";
import { issueService } from "./issues.js";
import { projectService } from "./projects.js";
import { routineService } from "./routines.js";

/** Build OrgNode tree from manifest agent list (slug + reportsToSlug). */
function buildOrgTreeFromManifest(agents: CompanyPortabilityManifest["agents"]): OrgNode[] {
  const ROLE_LABELS: Record<string, string> = {
    ceo: "Chief Executive", cto: "Technology", cmo: "Marketing",
    cfo: "Finance", coo: "Operations", vp: "VP", manager: "Manager",
    engineer: "Engineer", agent: "Agent",
  };
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const childrenOf = new Map<string | null, typeof agents>();
  for (const a of agents) {
    const parent = a.reportsToSlug ?? null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const build = (parentSlug: string | null): OrgNode[] => {
    const members = childrenOf.get(parentSlug) ?? [];
    return members.map((m) => ({
      id: m.slug,
      name: m.name,
      role: ROLE_LABELS[m.role] ?? m.role,
      status: "active",
      reports: build(m.slug),
    }));
  };
  // Find roots: agents whose reportsToSlug is null or points to a non-existent slug
  const roots = agents.filter((a) => !a.reportsToSlug || !bySlug.has(a.reportsToSlug));
  const rootSlugs = new Set(roots.map((r) => r.slug));
  // Start from null parent, but also include orphans
  const tree = build(null);
  for (const root of roots) {
    if (root.reportsToSlug && !bySlug.has(root.reportsToSlug)) {
      // Orphan root (parent slug doesn't exist)
      tree.push({
        id: root.slug,
        name: root.name,
        role: ROLE_LABELS[root.role] ?? root.role,
        status: "active",
        reports: build(root.slug),
      });
    }
  }
  return tree;
}

const DEFAULT_INCLUDE: CompanyPortabilityInclude = {
  company: true,
  agents: true,
  projects: false,
  issues: false,
  skills: false,
};

const DEFAULT_COLLISION_STRATEGY: CompanyPortabilityCollisionStrategy = "rename";
const execFileAsync = promisify(execFile);
let bundledSkillsCommitPromise: Promise<string | null> | null = null;

function resolveImportMode(options?: ImportBehaviorOptions): ImportMode {
  return options?.mode ?? "board_full";
}

function resolveSkillConflictStrategy(mode: ImportMode, collisionStrategy: CompanyPortabilityCollisionStrategy) {
  if (mode === "board_full") return "replace" as const;
  return collisionStrategy === "skip" ? "skip" as const : "rename" as const;
}

function classifyPortableFileKind(pathValue: string): CompanyPortabilityExportPreviewResult["fileInventory"][number]["kind"] {
  const normalized = normalizePortablePath(pathValue);
  if (normalized === "COMPANY.md") return "company";
  if (normalized === ".paperclip.yaml" || normalized === ".paperclip.yml") return "extension";
  if (normalized === "README.md") return "readme";
  if (normalized.startsWith("agents/")) return "agent";
  if (normalized.startsWith("skills/")) return "skill";
  if (normalized.startsWith("projects/")) return "project";
  if (normalized.startsWith("tasks/")) return "issue";
  return "other";
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

function readSkillKey(frontmatter: Record<string, unknown>) {
  const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
  const paperclip = isPlainRecord(metadata?.paperclip) ? metadata?.paperclip as Record<string, unknown> : null;
  return normalizeSkillKey(
    asString(frontmatter.key)
    ?? asString(frontmatter.skillKey)
    ?? asString(metadata?.skillKey)
    ?? asString(metadata?.canonicalKey)
    ?? asString(metadata?.paperclipSkillKey)
    ?? asString(paperclip?.skillKey)
    ?? asString(paperclip?.key),
  );
}

function deriveManifestSkillKey(
  frontmatter: Record<string, unknown>,
  fallbackSlug: string,
  metadata: Record<string, unknown> | null,
  sourceType: string,
  sourceLocator: string | null,
) {
  const explicit = readSkillKey(frontmatter);
  if (explicit) return explicit;
  const slug = normalizeSkillSlug(asString(frontmatter.slug) ?? fallbackSlug) ?? "skill";
  const sourceKind = asString(metadata?.sourceKind);
  const owner = normalizeSkillSlug(asString(metadata?.owner));
  const repo = normalizeSkillSlug(asString(metadata?.repo));
  if ((sourceType === "github" || sourceType === "skills_sh" || sourceKind === "github" || sourceKind === "skills_sh") && owner && repo) {
    return `${owner}/${repo}/${slug}`;
  }
  if (sourceKind === "paperclip_bundled") {
    return `paperclipai/paperclip/${slug}`;
  }
  if (sourceType === "url" || sourceKind === "url") {
    try {
      const host = normalizeSkillSlug(sourceLocator ? new URL(sourceLocator).host : null) ?? "url";
      return `url/${host}/${slug}`;
    } catch {
      return `url/unknown/${slug}`;
    }
  }
  return slug;
}

function hashSkillValue(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function normalizeExportPathSegment(value: string | null | undefined, preserveCase = false) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return null;
  return preserveCase ? normalized : normalized.toLowerCase();
}

function readSkillSourceKind(skill: CompanySkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  return asString(metadata?.sourceKind);
}

function deriveLocalExportNamespace(skill: CompanySkill, slug: string) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const candidates = [
    asString(metadata?.projectName),
    asString(metadata?.workspaceName),
  ];

  if (skill.sourceLocator) {
    const basename = path.basename(skill.sourceLocator);
    candidates.push(basename.toLowerCase() === "skill.md" ? path.basename(path.dirname(skill.sourceLocator)) : basename);
  }

  for (const value of candidates) {
    const normalized = normalizeSkillSlug(value);
    if (normalized && normalized !== slug) return normalized;
  }

  return null;
}

function derivePrimarySkillExportDir(
  skill: CompanySkill,
  slug: string,
  companyIssuePrefix: string | null | undefined,
) {
  const normalizedKey = normalizeSkillKey(skill.key);
  const keySegments = normalizedKey?.split("/") ?? [];
  const primaryNamespace = keySegments[0] ?? null;

  if (primaryNamespace === "company") {
    const companySegment = normalizeExportPathSegment(companyIssuePrefix, true)
      ?? normalizeExportPathSegment(keySegments[1], true)
      ?? "company";
    return `skills/company/${companySegment}/${slug}`;
  }

  if (primaryNamespace === "local") {
    const localNamespace = deriveLocalExportNamespace(skill, slug);
    return localNamespace
      ? `skills/local/${localNamespace}/${slug}`
      : `skills/local/${slug}`;
  }

  if (primaryNamespace === "url") {
    let derivedHost: string | null = keySegments[1] ?? null;
    if (!derivedHost) {
      try {
        derivedHost = normalizeSkillSlug(skill.sourceLocator ? new URL(skill.sourceLocator).host : null);
      } catch {
        derivedHost = null;
      }
    }
    const host = derivedHost ?? "url";
    return `skills/url/${host}/${slug}`;
  }

  if (keySegments.length > 1) {
    return `skills/${keySegments.join("/")}`;
  }

  return `skills/${slug}`;
}

function appendSkillExportDirSuffix(packageDir: string, suffix: string) {
  const lastSeparator = packageDir.lastIndexOf("/");
  if (lastSeparator < 0) return `${packageDir}--${suffix}`;
  return `${packageDir.slice(0, lastSeparator + 1)}${packageDir.slice(lastSeparator + 1)}--${suffix}`;
}

function deriveSkillExportDirCandidates(
  skill: CompanySkill,
  slug: string,
  companyIssuePrefix: string | null | undefined,
) {
  const primaryDir = derivePrimarySkillExportDir(skill, slug, companyIssuePrefix);
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  const sourceKind = readSkillSourceKind(skill);
  const suffixes = new Set<string>();
  const pushSuffix = (value: string | null | undefined, preserveCase = false) => {
    const normalized = normalizeExportPathSegment(value, preserveCase);
    if (normalized && normalized !== slug) {
      suffixes.add(normalized);
    }
  };

  if (sourceKind === "paperclip_bundled") {
    pushSuffix("paperclip");
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    pushSuffix(asString(metadata?.repo));
    pushSuffix(asString(metadata?.owner));
    pushSuffix(skill.sourceType === "skills_sh" ? "skills_sh" : "github");
  } else if (skill.sourceType === "url") {
    try {
      pushSuffix(skill.sourceLocator ? new URL(skill.sourceLocator).host : null);
    } catch {
      // Ignore URL parse failures and fall through to generic suffixes.
    }
    pushSuffix("url");
  } else if (skill.sourceType === "local_path") {
    pushSuffix(asString(metadata?.projectName));
    pushSuffix(asString(metadata?.workspaceName));
    pushSuffix(deriveLocalExportNamespace(skill, slug));
    if (sourceKind === "managed_local") pushSuffix("company");
    if (sourceKind === "project_scan") pushSuffix("project");
    pushSuffix("local");
  } else {
    pushSuffix(sourceKind);
    pushSuffix("skill");
  }

  return [primaryDir, ...Array.from(suffixes, (suffix) => appendSkillExportDirSuffix(primaryDir, suffix))];
}

function buildSkillExportDirMap(skills: CompanySkill[], companyIssuePrefix: string | null | undefined) {
  const usedDirs = new Set<string>();
  const keyToDir = new Map<string, string>();
  const orderedSkills = [...skills].sort((left, right) => left.key.localeCompare(right.key));
  for (const skill of orderedSkills) {
    const slug = normalizeSkillSlug(skill.slug) ?? "skill";
    const candidates = deriveSkillExportDirCandidates(skill, slug, companyIssuePrefix);

    let packageDir = candidates.find((candidate) => !usedDirs.has(candidate)) ?? null;
    if (!packageDir) {
      packageDir = appendSkillExportDirSuffix(candidates[0] ?? `skills/${slug}`, hashSkillValue(skill.key));
      while (usedDirs.has(packageDir)) {
        packageDir = appendSkillExportDirSuffix(
          candidates[0] ?? `skills/${slug}`,
          hashSkillValue(`${skill.key}:${packageDir}`),
        );
      }
    }

    usedDirs.add(packageDir);
    keyToDir.set(skill.key, packageDir);
  }

  return keyToDir;
}

function isSensitiveEnvKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.includes("apikey") ||
    normalized.includes("api_key") ||
    normalized.includes("api-key") ||
    normalized.includes("access_token") ||
    normalized.includes("access-token") ||
    normalized.includes("auth") ||
    normalized.includes("auth_token") ||
    normalized.includes("auth-token") ||
    normalized.includes("authorization") ||
    normalized.includes("bearer") ||
    normalized.includes("secret") ||
    normalized.includes("passwd") ||
    normalized.includes("password") ||
    normalized.includes("credential") ||
    normalized.includes("jwt") ||
    normalized.includes("privatekey") ||
    normalized.includes("private_key") ||
    normalized.includes("private-key") ||
    normalized.includes("cookie") ||
    normalized.includes("connectionstring")
  );
}

function normalizePortableProjectEnv(value: unknown): AgentEnvConfig | null {
  const parsed = envConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function extractPortableScopedEnvInputs(
  scope: {
    label: string;
    warningPrefix: string;
    agentSlug: string | null;
    projectSlug: string | null;
  },
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInput[] {
  if (!isPlainRecord(envValue)) return [];
  const env = envValue as Record<string, unknown>;
  const inputs: CompanyPortabilityEnvInput[] = [];

  for (const [key, binding] of Object.entries(env)) {
    if (key.toUpperCase() === "PATH") {
      warnings.push(`${scope.warningPrefix} PATH override was omitted from export because it is system-dependent.`);
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "secret_ref") {
      inputs.push({
        key,
        description: `Provide ${key} for ${scope.label}`,
        agentSlug: scope.agentSlug,
        projectSlug: scope.projectSlug,
        kind: "secret",
        requirement: "optional",
        defaultValue: "",
        portability: "portable",
      });
      continue;
    }

    if (isPlainRecord(binding) && binding.type === "plain") {
      const defaultValue = asString(binding.value);
      const isSensitive = isSensitiveEnvKey(key);
      const portability = defaultValue && isAbsoluteCommand(defaultValue)
        ? "system_dependent"
        : "portable";
      if (portability === "system_dependent") {
        warnings.push(`${scope.warningPrefix} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on ${scope.label}`,
        agentSlug: scope.agentSlug,
        projectSlug: scope.projectSlug,
        kind: isSensitive ? "secret" : "plain",
        requirement: "optional",
        defaultValue: isSensitive ? "" : defaultValue ?? "",
        portability,
      });
      continue;
    }

    if (typeof binding === "string") {
      const portability = isAbsoluteCommand(binding) ? "system_dependent" : "portable";
      if (portability === "system_dependent") {
        warnings.push(`${scope.warningPrefix} env ${key} default was exported as system-dependent.`);
      }
      inputs.push({
        key,
        description: `Optional default for ${key} on ${scope.label}`,
        agentSlug: scope.agentSlug,
        projectSlug: scope.projectSlug,
        kind: isSensitiveEnvKey(key) ? "secret" : "plain",
        requirement: "optional",
        defaultValue: isSensitiveEnvKey(key) ? "" : binding,
        portability,
      });
    }
  }

  return inputs;
}

type ResolvedSource = {
  manifest: CompanyPortabilityManifest;
  files: Record<string, CompanyPortabilityFileEntry>;
  warnings: string[];
};

type MarkdownDoc = {
  frontmatter: Record<string, unknown>;
  body: string;
};

type CompanyPackageIncludeEntry = {
  path: string;
};

type PaperclipExtensionDoc = {
  schema?: string;
  company?: Record<string, unknown> | null;
  agents?: Record<string, Record<string, unknown>> | null;
  projects?: Record<string, Record<string, unknown>> | null;
  tasks?: Record<string, Record<string, unknown>> | null;
  routines?: Record<string, Record<string, unknown>> | null;
};

type ProjectLike = {
  id: string;
  name: string;
  description: string | null;
  leadAgentId: string | null;
  targetDate: string | null;
  color: string | null;
  status: string;
  env: Record<string, unknown> | null;
  executionWorkspacePolicy: Record<string, unknown> | null;
  workspaces?: Array<{
    id: string;
    name: string;
    sourceType: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
    defaultRef: string | null;
    visibility: string;
    setupCommand: string | null;
    cleanupCommand: string | null;
    metadata?: Record<string, unknown> | null;
    isPrimary: boolean;
  }>;
  metadata?: Record<string, unknown> | null;
};

type IssueLike = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  projectId: string | null;
  projectWorkspaceId: string | null;
  assigneeAgentId: string | null;
  status: string;
  priority: string;
  labelIds?: string[];
  billingCode: string | null;
  executionWorkspaceSettings: Record<string, unknown> | null;
  assigneeAdapterOverrides: Record<string, unknown> | null;
};

type RoutineLike = NonNullable<Awaited<ReturnType<ReturnType<typeof routineService>["getDetail"]>>>;

type ImportPlanInternal = {
  preview: CompanyPortabilityPreviewResult;
  source: ResolvedSource;
  include: CompanyPortabilityInclude;
  collisionStrategy: CompanyPortabilityCollisionStrategy;
  selectedAgents: CompanyPortabilityAgentManifestEntry[];
};

type ImportMode = "board_full" | "agent_safe";

type ImportBehaviorOptions = {
  mode?: ImportMode;
  sourceCompanyId?: string | null;
};

type AgentLike = {
  id: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

type EnvInputRecord = {
  kind: "secret" | "plain";
  requirement: "required" | "optional";
  default?: string | null;
  description?: string | null;
  portability?: "portable" | "system_dependent";
};

const COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
};

const COMPANY_LOGO_FILE_NAME = "company-logo";

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
    { path: ["maxTurnsPerRun"], value: 1000 },
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

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function normalizeRoutineTriggerExtension(value: unknown): CompanyPortabilityIssueRoutineTriggerManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const kind = asString(value.kind);
  if (!kind) return null;
  return {
    kind,
    label: asString(value.label),
    enabled: asBoolean(value.enabled) ?? true,
    cronExpression: asString(value.cronExpression),
    timezone: asString(value.timezone),
    signingMode: asString(value.signingMode),
    replayWindowSec: asInteger(value.replayWindowSec),
  };
}

function normalizeRoutineVariableExtension(value: unknown): RoutineVariable | null {
  if (!isPlainRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  const type = asString(value.type) ?? "text";
  if (!["text", "textarea", "number", "boolean", "select"].includes(type)) return null;
  const options = Array.isArray(value.options)
    ? value.options.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry))
    : [];
  const defaultValue =
    typeof value.defaultValue === "string" || typeof value.defaultValue === "number" || typeof value.defaultValue === "boolean"
      ? value.defaultValue
      : null;
  return {
    name,
    label: asString(value.label),
    type: type as RoutineVariable["type"],
    defaultValue,
    required: asBoolean(value.required) ?? true,
    options,
  };
}

function normalizeRoutineExtension(value: unknown): CompanyPortabilityIssueRoutineManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const triggers = Array.isArray(value.triggers)
    ? value.triggers
      .map((entry) => normalizeRoutineTriggerExtension(entry))
      .filter((entry): entry is CompanyPortabilityIssueRoutineTriggerManifestEntry => entry !== null)
    : [];
  const variables = Array.isArray(value.variables)
    ? value.variables
      .map((entry) => normalizeRoutineVariableExtension(entry))
      .filter((entry): entry is RoutineVariable => entry !== null)
    : null;
  const routine = {
    concurrencyPolicy: asString(value.concurrencyPolicy),
    catchUpPolicy: asString(value.catchUpPolicy),
    variables,
    triggers,
  };
  return stripEmptyValues(routine) ? routine : null;
}

function buildRoutineManifestFromLiveRoutine(routine: RoutineLike): CompanyPortabilityIssueRoutineManifestEntry {
  return {
    concurrencyPolicy: routine.concurrencyPolicy,
    catchUpPolicy: routine.catchUpPolicy,
    variables: routine.variables,
    triggers: routine.triggers.map((trigger) => ({
      kind: trigger.kind,
      label: trigger.label ?? null,
      enabled: Boolean(trigger.enabled),
      cronExpression: trigger.kind === "schedule" ? trigger.cronExpression ?? null : null,
      timezone: trigger.kind === "schedule" ? trigger.timezone ?? null : null,
      signingMode: trigger.kind === "webhook" ? trigger.signingMode ?? null : null,
      replayWindowSec: trigger.kind === "webhook" ? trigger.replayWindowSec ?? null : null,
    })),
  };
}

function containsAbsolutePathFragment(value: string) {
  return /(^|\s)(\/[^/\s]|[A-Za-z]:[\\/])/.test(value);
}

function containsSystemDependentPathValue(value: unknown): boolean {
  if (typeof value === "string") {
    return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || containsAbsolutePathFragment(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSystemDependentPathValue(entry));
  }
  if (isPlainRecord(value)) {
    return Object.values(value).some((entry) => containsSystemDependentPathValue(entry));
  }
  return false;
}

function clonePortableRecord(value: unknown) {
  if (!isPlainRecord(value)) return null;
  return structuredClone(value) as Record<string, unknown>;
}

function disableImportedTimerHeartbeat(runtimeConfig: unknown) {
  const next = clonePortableRecord(runtimeConfig) ?? {};
  const heartbeat = isPlainRecord(next.heartbeat) ? { ...next.heartbeat } : {};
  heartbeat.enabled = false;
  next.heartbeat = heartbeat;
  return next;
}

function normalizePortableProjectWorkspaceExtension(
  workspaceKey: string,
  value: unknown,
): CompanyPortabilityProjectWorkspaceManifestEntry | null {
  if (!isPlainRecord(value)) return null;
  const normalizedKey = normalizeAgentUrlKey(workspaceKey) ?? workspaceKey.trim();
  if (!normalizedKey) return null;
  return {
    key: normalizedKey,
    name: asString(value.name) ?? normalizedKey,
    sourceType: asString(value.sourceType),
    repoUrl: asString(value.repoUrl),
    repoRef: asString(value.repoRef),
    defaultRef: asString(value.defaultRef),
    visibility: asString(value.visibility),
    setupCommand: asString(value.setupCommand),
    cleanupCommand: asString(value.cleanupCommand),
    metadata: isPlainRecord(value.metadata) ? value.metadata : null,
    isPrimary: asBoolean(value.isPrimary) ?? false,
  };
}

function derivePortableProjectWorkspaceKey(
  workspace: NonNullable<ProjectLike["workspaces"]>[number],
  usedKeys: Set<string>,
) {
  const baseKey =
    normalizeAgentUrlKey(workspace.name)
    ?? normalizeAgentUrlKey(asString(workspace.repoUrl)?.split("/").pop()?.replace(/\.git$/i, "") ?? "")
    ?? "workspace";
  return uniqueSlug(baseKey, usedKeys);
}

function exportPortableProjectExecutionWorkspacePolicy(
  projectSlug: string,
  policy: unknown,
  workspaceKeyById: Map<string, string>,
  warnings: string[],
) {
  const next = clonePortableRecord(policy);
  if (!next) return null;
  const defaultWorkspaceId = asString(next.defaultProjectWorkspaceId);
  if (defaultWorkspaceId) {
    const defaultWorkspaceKey = workspaceKeyById.get(defaultWorkspaceId);
    if (defaultWorkspaceKey) {
      next.defaultProjectWorkspaceKey = defaultWorkspaceKey;
    } else {
      warnings.push(`Project ${projectSlug} default workspace ${defaultWorkspaceId} was omitted from export because that workspace is not portable.`);
    }
    delete next.defaultProjectWorkspaceId;
  }
  const cleaned = stripEmptyValues(next);
  return isPlainRecord(cleaned) ? cleaned : null;
}

function importPortableProjectExecutionWorkspacePolicy(
  projectSlug: string,
  policy: Record<string, unknown> | null | undefined,
  workspaceIdByKey: Map<string, string>,
  warnings: string[],
) {
  const next = clonePortableRecord(policy);
  if (!next) return null;
  const defaultWorkspaceKey = asString(next.defaultProjectWorkspaceKey);
  if (defaultWorkspaceKey) {
    const defaultWorkspaceId = workspaceIdByKey.get(defaultWorkspaceKey);
    if (defaultWorkspaceId) {
      next.defaultProjectWorkspaceId = defaultWorkspaceId;
    } else {
      warnings.push(`Project ${projectSlug} references missing workspace key ${defaultWorkspaceKey}; imported execution workspace policy without a default workspace.`);
    }
  }
  delete next.defaultProjectWorkspaceKey;
  const cleaned = stripEmptyValues(next);
  return isPlainRecord(cleaned) ? cleaned : null;
}

function stripPortableProjectExecutionWorkspaceRefs(policy: Record<string, unknown> | null | undefined) {
  const next = clonePortableRecord(policy);
  if (!next) return null;
  delete next.defaultProjectWorkspaceId;
  delete next.defaultProjectWorkspaceKey;
  const cleaned = stripEmptyValues(next);
  return isPlainRecord(cleaned) ? cleaned : null;
}

async function readGitOutput(cwd: string, args: string[]) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  const trimmed = stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function inferPortableWorkspaceGitMetadata(workspace: NonNullable<ProjectLike["workspaces"]>[number]) {
  const cwd = asString(workspace.cwd);
  if (!cwd) {
    return {
      repoUrl: null,
      repoRef: null,
      defaultRef: null,
    };
  }

  let repoUrl: string | null = null;
  try {
    repoUrl = await readGitOutput(cwd, ["remote", "get-url", "origin"]);
  } catch {
    try {
      const firstRemote = await readGitOutput(cwd, ["remote"]);
      const remoteName = firstRemote?.split("\n").map((entry) => entry.trim()).find(Boolean) ?? null;
      if (remoteName) {
        repoUrl = await readGitOutput(cwd, ["remote", "get-url", remoteName]);
      }
    } catch {
      repoUrl = null;
    }
  }

  let repoRef: string | null = null;
  try {
    repoRef = await readGitOutput(cwd, ["branch", "--show-current"]);
  } catch {
    repoRef = null;
  }

  let defaultRef: string | null = null;
  try {
    const remoteHead = await readGitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    defaultRef = remoteHead?.startsWith("origin/") ? remoteHead.slice("origin/".length) : remoteHead;
  } catch {
    defaultRef = null;
  }

  return {
    repoUrl,
    repoRef,
    defaultRef,
  };
}

async function buildPortableProjectWorkspaces(
  projectSlug: string,
  workspaces: ProjectLike["workspaces"] | undefined,
  warnings: string[],
) {
  const exportedWorkspaces: Record<string, Record<string, unknown>> = {};
  const manifestWorkspaces: CompanyPortabilityProjectWorkspaceManifestEntry[] = [];
  const workspaceKeyById = new Map<string, string>();
  const workspaceKeyBySignature = new Map<string, string>();
  const manifestWorkspaceByKey = new Map<string, CompanyPortabilityProjectWorkspaceManifestEntry>();
  const usedKeys = new Set<string>();

  for (const workspace of workspaces ?? []) {
    const inferredGitMetadata =
      !asString(workspace.repoUrl) || !asString(workspace.repoRef) || !asString(workspace.defaultRef)
        ? await inferPortableWorkspaceGitMetadata(workspace)
        : { repoUrl: null, repoRef: null, defaultRef: null };
    const repoUrl = asString(workspace.repoUrl) ?? inferredGitMetadata.repoUrl;
    if (!repoUrl) {
      warnings.push(`Project ${projectSlug} workspace ${workspace.name} was omitted from export because it does not have a portable repoUrl.`);
      continue;
    }
    const repoRef = asString(workspace.repoRef) ?? inferredGitMetadata.repoRef;
    const defaultRef = asString(workspace.defaultRef) ?? inferredGitMetadata.defaultRef ?? repoRef;
    const workspaceSignature = JSON.stringify({
      name: workspace.name,
      repoUrl,
      repoRef,
      defaultRef,
    });
    const existingWorkspaceKey = workspaceKeyBySignature.get(workspaceSignature);
    if (existingWorkspaceKey) {
      workspaceKeyById.set(workspace.id, existingWorkspaceKey);
      const existingManifestWorkspace = manifestWorkspaceByKey.get(existingWorkspaceKey);
      if (existingManifestWorkspace && workspace.isPrimary) {
        existingManifestWorkspace.isPrimary = true;
        const existingExtensionWorkspace = exportedWorkspaces[existingWorkspaceKey];
        if (isPlainRecord(existingExtensionWorkspace)) existingExtensionWorkspace.isPrimary = true;
      }
      continue;
    }

    const workspaceKey = derivePortableProjectWorkspaceKey(workspace, usedKeys);
    workspaceKeyById.set(workspace.id, workspaceKey);
    workspaceKeyBySignature.set(workspaceSignature, workspaceKey);

    let setupCommand = asString(workspace.setupCommand);
    if (setupCommand && containsAbsolutePathFragment(setupCommand)) {
      warnings.push(`Project ${projectSlug} workspace ${workspaceKey} setupCommand was omitted from export because it is system-dependent.`);
      setupCommand = null;
    }

    let cleanupCommand = asString(workspace.cleanupCommand);
    if (cleanupCommand && containsAbsolutePathFragment(cleanupCommand)) {
      warnings.push(`Project ${projectSlug} workspace ${workspaceKey} cleanupCommand was omitted from export because it is system-dependent.`);
      cleanupCommand = null;
    }

    const metadata = isPlainRecord(workspace.metadata) && !containsSystemDependentPathValue(workspace.metadata)
      ? workspace.metadata
      : null;
    if (isPlainRecord(workspace.metadata) && metadata == null) {
      warnings.push(`Project ${projectSlug} workspace ${workspaceKey} metadata was omitted from export because it contains system-dependent paths.`);
    }

    const portableWorkspace = stripEmptyValues({
      name: workspace.name,
      sourceType: workspace.sourceType,
      repoUrl,
      repoRef,
      defaultRef,
      visibility: asString(workspace.visibility),
      setupCommand,
      cleanupCommand,
      metadata,
      isPrimary: workspace.isPrimary ? true : undefined,
    });
    if (!isPlainRecord(portableWorkspace)) continue;

    exportedWorkspaces[workspaceKey] = portableWorkspace;
    const manifestWorkspace = {
      key: workspaceKey,
      name: workspace.name,
      sourceType: asString(workspace.sourceType),
      repoUrl,
      repoRef,
      defaultRef,
      visibility: asString(workspace.visibility),
      setupCommand,
      cleanupCommand,
      metadata,
      isPrimary: workspace.isPrimary,
    };
    manifestWorkspaces.push(manifestWorkspace);
    manifestWorkspaceByKey.set(workspaceKey, manifestWorkspace);
  }

  return {
    extension: Object.keys(exportedWorkspaces).length > 0 ? exportedWorkspaces : undefined,
    manifest: manifestWorkspaces,
    workspaceKeyById,
  };
}

const WEEKDAY_TO_CRON: Record<string, string> = {
  sunday: "0",
  monday: "1",
  tuesday: "2",
  wednesday: "3",
  thursday: "4",
  friday: "5",
  saturday: "6",
};

function readZonedDateParts(startsAt: string, timeZone: string) {
  try {
    const date = new Date(startsAt);
    if (Number.isNaN(date.getTime())) return null;
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      weekday: "long",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((entry) => entry.type !== "literal")
        .map((entry) => [entry.type, entry.value]),
    ) as Record<string, string>;
    const weekday = WEEKDAY_TO_CRON[parts.weekday?.toLowerCase() ?? ""];
    const month = Number(parts.month);
    const day = Number(parts.day);
    const hour = Number(parts.hour);
    const minute = Number(parts.minute);
    if (!weekday || !Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return { weekday, month, day, hour, minute };
  } catch {
    return null;
  }
}

function normalizeCronList(values: string[]) {
  return Array.from(new Set(values)).sort((left, right) => Number(left) - Number(right)).join(",");
}

function buildLegacyRoutineTriggerFromRecurrence(
  issue: Pick<CompanyPortabilityIssueManifestEntry, "slug" | "legacyRecurrence">,
  scheduleValue: unknown,
) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!issue.legacyRecurrence || !isPlainRecord(issue.legacyRecurrence)) {
    return { trigger: null, warnings, errors };
  }

  const schedule = isPlainRecord(scheduleValue) ? scheduleValue : null;
  const frequency = asString(issue.legacyRecurrence.frequency);
  const interval = asInteger(issue.legacyRecurrence.interval) ?? 1;
  if (!frequency) {
    errors.push(`Recurring task ${issue.slug} uses legacy recurrence without frequency; add .paperclip.yaml routines.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }
  if (interval < 1) {
    errors.push(`Recurring task ${issue.slug} uses legacy recurrence with an invalid interval; add .paperclip.yaml routines.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  const timezone = asString(schedule?.timezone) ?? "UTC";
  const startsAt = asString(schedule?.startsAt);
  const zonedStartsAt = startsAt ? readZonedDateParts(startsAt, timezone) : null;
  if (startsAt && !zonedStartsAt) {
    errors.push(`Recurring task ${issue.slug} has an invalid legacy startsAt/timezone combination; add .paperclip.yaml routines.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  const time = isPlainRecord(issue.legacyRecurrence.time) ? issue.legacyRecurrence.time : null;
  const hour = asInteger(time?.hour) ?? zonedStartsAt?.hour ?? 0;
  const minute = asInteger(time?.minute) ?? zonedStartsAt?.minute ?? 0;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    errors.push(`Recurring task ${issue.slug} uses legacy recurrence with an invalid time; add .paperclip.yaml routines.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  if (issue.legacyRecurrence.until != null || issue.legacyRecurrence.count != null) {
    warnings.push(`Recurring task ${issue.slug} uses legacy recurrence end bounds; Paperclip will import the routine trigger without those limits.`);
  }

  let cronExpression: string | null = null;

  if (frequency === "hourly") {
    const hourField = interval === 1
      ? "*"
      : zonedStartsAt
        ? `${zonedStartsAt.hour}-23/${interval}`
        : `*/${interval}`;
    cronExpression = `${minute} ${hourField} * * *`;
  } else if (frequency === "daily") {
    if (Array.isArray(issue.legacyRecurrence.weekdays) || Array.isArray(issue.legacyRecurrence.monthDays) || Array.isArray(issue.legacyRecurrence.months)) {
      errors.push(`Recurring task ${issue.slug} uses unsupported legacy daily recurrence constraints; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const dayField = interval === 1 ? "*" : `*/${interval}`;
    cronExpression = `${minute} ${hour} ${dayField} * *`;
  } else if (frequency === "weekly") {
    if (interval !== 1) {
      errors.push(`Recurring task ${issue.slug} uses legacy weekly recurrence with interval > 1; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const weekdays = Array.isArray(issue.legacyRecurrence.weekdays)
      ? issue.legacyRecurrence.weekdays
        .map((entry) => asString(entry))
        .filter((entry): entry is string => Boolean(entry))
      : [];
    const cronWeekdays = weekdays
      .map((entry) => WEEKDAY_TO_CRON[entry.toLowerCase()])
      .filter((entry): entry is string => Boolean(entry));
    if (cronWeekdays.length === 0 && zonedStartsAt?.weekday) {
      cronWeekdays.push(zonedStartsAt.weekday);
    }
    if (cronWeekdays.length === 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy weekly recurrence without weekdays; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    cronExpression = `${minute} ${hour} * * ${normalizeCronList(cronWeekdays)}`;
  } else if (frequency === "monthly") {
    if (interval !== 1) {
      errors.push(`Recurring task ${issue.slug} uses legacy monthly recurrence with interval > 1; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    if (Array.isArray(issue.legacyRecurrence.ordinalWeekdays) && issue.legacyRecurrence.ordinalWeekdays.length > 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy ordinal monthly recurrence; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const monthDays = Array.isArray(issue.legacyRecurrence.monthDays)
      ? issue.legacyRecurrence.monthDays
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 31)
      : [];
    if (monthDays.length === 0 && zonedStartsAt?.day) {
      monthDays.push(zonedStartsAt.day);
    }
    if (monthDays.length === 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy monthly recurrence without monthDays; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const months = Array.isArray(issue.legacyRecurrence.months)
      ? issue.legacyRecurrence.months
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 12)
      : [];
    const monthField = months.length > 0 ? normalizeCronList(months.map(String)) : "*";
    cronExpression = `${minute} ${hour} ${normalizeCronList(monthDays.map(String))} ${monthField} *`;
  } else if (frequency === "yearly") {
    if (interval !== 1) {
      errors.push(`Recurring task ${issue.slug} uses legacy yearly recurrence with interval > 1; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    const months = Array.isArray(issue.legacyRecurrence.months)
      ? issue.legacyRecurrence.months
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 12)
      : [];
    if (months.length === 0 && zonedStartsAt?.month) {
      months.push(zonedStartsAt.month);
    }
    const monthDays = Array.isArray(issue.legacyRecurrence.monthDays)
      ? issue.legacyRecurrence.monthDays
        .map((entry) => asInteger(entry))
        .filter((entry): entry is number => entry != null && entry >= 1 && entry <= 31)
      : [];
    if (monthDays.length === 0 && zonedStartsAt?.day) {
      monthDays.push(zonedStartsAt.day);
    }
    if (months.length === 0 || monthDays.length === 0) {
      errors.push(`Recurring task ${issue.slug} uses legacy yearly recurrence without month/monthDay anchors; add .paperclip.yaml routines.${issue.slug}.triggers.`);
      return { trigger: null, warnings, errors };
    }
    cronExpression = `${minute} ${hour} ${normalizeCronList(monthDays.map(String))} ${normalizeCronList(months.map(String))} *`;
  } else {
    errors.push(`Recurring task ${issue.slug} uses unsupported legacy recurrence frequency "${frequency}"; add .paperclip.yaml routines.${issue.slug}.triggers.`);
    return { trigger: null, warnings, errors };
  }

  return {
    trigger: {
      kind: "schedule",
      label: "Migrated legacy recurrence",
      enabled: true,
      cronExpression,
      timezone,
      signingMode: null,
      replayWindowSec: null,
    } satisfies CompanyPortabilityIssueRoutineTriggerManifestEntry,
    warnings,
    errors,
  };
}

function resolvePortableRoutineDefinition(
  issue: Pick<CompanyPortabilityIssueManifestEntry, "slug" | "recurring" | "routine" | "legacyRecurrence">,
  scheduleValue: unknown,
) {
  const warnings: string[] = [];
  const errors: string[] = [];
  if (!issue.recurring) {
    return { routine: null, warnings, errors };
  }

  const routine = issue.routine
    ? {
      concurrencyPolicy: issue.routine.concurrencyPolicy,
      catchUpPolicy: issue.routine.catchUpPolicy,
      variables: issue.routine.variables ?? null,
      triggers: [...issue.routine.triggers],
    }
    : {
      concurrencyPolicy: null,
      catchUpPolicy: null,
      variables: null,
      triggers: [] as CompanyPortabilityIssueRoutineTriggerManifestEntry[],
    };

  if (routine.concurrencyPolicy && !ROUTINE_CONCURRENCY_POLICIES.includes(routine.concurrencyPolicy as any)) {
    errors.push(`Recurring task ${issue.slug} uses unsupported routine concurrencyPolicy "${routine.concurrencyPolicy}".`);
  }
  if (routine.catchUpPolicy && !ROUTINE_CATCH_UP_POLICIES.includes(routine.catchUpPolicy as any)) {
    errors.push(`Recurring task ${issue.slug} uses unsupported routine catchUpPolicy "${routine.catchUpPolicy}".`);
  }

  for (const trigger of routine.triggers) {
    if (!ROUTINE_TRIGGER_KINDS.includes(trigger.kind as any)) {
      errors.push(`Recurring task ${issue.slug} uses unsupported trigger kind "${trigger.kind}".`);
      continue;
    }
    if (trigger.kind === "schedule") {
      if (!trigger.cronExpression || !trigger.timezone) {
        errors.push(`Recurring task ${issue.slug} has a schedule trigger missing cronExpression/timezone.`);
        continue;
      }
      const cronError = validateCron(trigger.cronExpression);
      if (cronError) {
        errors.push(`Recurring task ${issue.slug} has an invalid schedule trigger: ${cronError}`);
      }
      continue;
    }
    if (trigger.kind === "webhook" && trigger.signingMode && !ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)) {
      errors.push(`Recurring task ${issue.slug} uses unsupported webhook signingMode "${trigger.signingMode}".`);
    }
  }

  if (routine.triggers.length === 0 && issue.legacyRecurrence) {
    const migrated = buildLegacyRoutineTriggerFromRecurrence(issue, scheduleValue);
    warnings.push(...migrated.warnings);
    errors.push(...migrated.errors);
    if (migrated.trigger) {
      routine.triggers.push(migrated.trigger);
    }
  }

  return { routine, warnings, errors };
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

function uniqueProjectName(baseName: string, existingProjectSlugs: Set<string>) {
  const baseSlug = deriveProjectUrlKey(baseName, baseName);
  if (!existingProjectSlugs.has(baseSlug)) return baseName;
  let idx = 2;
  while (true) {
    const candidateName = `${baseName} ${idx}`;
    const candidateSlug = deriveProjectUrlKey(candidateName, candidateName);
    if (!existingProjectSlugs.has(candidateSlug)) return candidateName;
    idx += 1;
  }
}

function normalizeInclude(input?: Partial<CompanyPortabilityInclude>): CompanyPortabilityInclude {
  return {
    company: input?.company ?? DEFAULT_INCLUDE.company,
    agents: input?.agents ?? DEFAULT_INCLUDE.agents,
    projects: input?.projects ?? DEFAULT_INCLUDE.projects,
    issues: input?.issues ?? DEFAULT_INCLUDE.issues,
    skills: input?.skills ?? DEFAULT_INCLUDE.skills,
  };
}

function normalizePortablePath(input: string) {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

function resolvePortablePath(fromPath: string, targetPath: string) {
  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
  return normalizePortablePath(path.posix.join(baseDir, targetPath.replace(/\\/g, "/")));
}

function isPortableBinaryFile(
  value: CompanyPortabilityFileEntry,
): value is Extract<CompanyPortabilityFileEntry, { encoding: "base64" }> {
  return typeof value === "object" && value !== null && value.encoding === "base64" && typeof value.data === "string";
}

function readPortableTextFile(
  files: Record<string, CompanyPortabilityFileEntry>,
  filePath: string,
) {
  const value = files[filePath];
  return typeof value === "string" ? value : null;
}

function inferContentTypeFromPath(filePath: string) {
  const extension = path.posix.extname(filePath).toLowerCase();
  switch (extension) {
    case ".gif":
      return "image/gif";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    default:
      return null;
  }
}

function resolveCompanyLogoExtension(contentType: string | null | undefined, originalFilename: string | null | undefined) {
  const fromContentType = contentType ? COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase()] : null;
  if (fromContentType) return fromContentType;

  const extension = originalFilename ? path.extname(originalFilename).toLowerCase() : "";
  return extension || ".png";
}

function portableBinaryFileToBuffer(entry: Extract<CompanyPortabilityFileEntry, { encoding: "base64" }>) {
  return Buffer.from(entry.data, "base64");
}

function portableFileToBuffer(entry: CompanyPortabilityFileEntry, filePath: string) {
  if (typeof entry === "string") {
    return Buffer.from(entry, "utf8");
  }
  if (isPortableBinaryFile(entry)) {
    return portableBinaryFileToBuffer(entry);
  }
  throw unprocessable(`Unsupported file entry encoding for ${filePath}`);
}

function bufferToPortableBinaryFile(buffer: Buffer, contentType: string | null): CompanyPortabilityFileEntry {
  return {
    encoding: "base64",
    data: buffer.toString("base64"),
    contentType,
  };
}

async function streamToBuffer(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function normalizeFileMap(
  files: Record<string, CompanyPortabilityFileEntry>,
  rootPath?: string | null,
): Record<string, CompanyPortabilityFileEntry> {
  const normalizedRoot = rootPath ? normalizePortablePath(rootPath) : null;
  const out: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    let nextPath = normalizePortablePath(rawPath);
    if (normalizedRoot && nextPath === normalizedRoot) {
      continue;
    }
    if (normalizedRoot && nextPath.startsWith(`${normalizedRoot}/`)) {
      nextPath = nextPath.slice(normalizedRoot.length + 1);
    }
    if (!nextPath) continue;
    out[nextPath] = content;
  }
  return out;
}

function pickTextFiles(files: Record<string, CompanyPortabilityFileEntry>) {
  const out: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (typeof content === "string") {
      out[filePath] = content;
    }
  }
  return out;
}

function collectSelectedExportSlugs(selectedFiles: Set<string>) {
  const agents = new Set<string>();
  const projects = new Set<string>();
  const tasks = new Set<string>();
  for (const filePath of selectedFiles) {
    const agentMatch = filePath.match(/^agents\/([^/]+)\//);
    if (agentMatch) agents.add(agentMatch[1]!);
    const projectMatch = filePath.match(/^projects\/([^/]+)\//);
    if (projectMatch) projects.add(projectMatch[1]!);
    const taskMatch = filePath.match(/^tasks\/([^/]+)\//);
    if (taskMatch) tasks.add(taskMatch[1]!);
  }
  return { agents, projects, tasks, routines: new Set(tasks) };
}

function normalizePortableSlugList(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizePortableSidebarOrder(value: unknown): CompanyPortabilitySidebarOrder | null {
  if (!isPlainRecord(value)) return null;
  const sidebar = {
    agents: normalizePortableSlugList(value.agents),
    projects: normalizePortableSlugList(value.projects),
  };
  return sidebar.agents.length > 0 || sidebar.projects.length > 0 ? sidebar : null;
}

function sortAgentsBySidebarOrder<T extends { id: string; name: string; reportsTo: string | null }>(agents: T[]) {
  if (agents.length === 0) return [];

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const childrenOf = new Map<string | null, T[]>();
  for (const agent of agents) {
    const parentId = agent.reportsTo && byId.has(agent.reportsTo) ? agent.reportsTo : null;
    const siblings = childrenOf.get(parentId) ?? [];
    siblings.push(agent);
    childrenOf.set(parentId, siblings);
  }

  for (const siblings of childrenOf.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }

  const sorted: T[] = [];
  const queue = [...(childrenOf.get(null) ?? [])];
  while (queue.length > 0) {
    const agent = queue.shift();
    if (!agent) continue;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }

  return sorted;
}

function filterPortableExtensionYaml(yaml: string, selectedFiles: Set<string>) {
  const selected = collectSelectedExportSlugs(selectedFiles);
  const parsed = parseYamlFile(yaml);
  for (const section of ["agents", "projects", "tasks", "routines"] as const) {
    const sectionValue = parsed[section];
    if (!isPlainRecord(sectionValue)) continue;
    const sectionSlugs = selected[section];
    const filteredEntries = Object.fromEntries(
      Object.entries(sectionValue).filter(([slug]) => sectionSlugs.has(slug)),
    );
    if (Object.keys(filteredEntries).length > 0) {
      parsed[section] = filteredEntries;
    } else {
      delete parsed[section];
    }
  }

  const companySection = parsed.company;
  if (isPlainRecord(companySection)) {
    const logoPath = asString(companySection.logoPath) ?? asString(companySection.logo);
    if (logoPath && !selectedFiles.has(logoPath)) {
      delete companySection.logoPath;
      delete companySection.logo;
    }
  }

  const sidebarOrder = normalizePortableSidebarOrder(parsed.sidebar);
  if (sidebarOrder) {
    const filteredSidebar = stripEmptyValues({
      agents: sidebarOrder.agents.filter((slug) => selected.agents.has(slug)),
      projects: sidebarOrder.projects.filter((slug) => selected.projects.has(slug)),
    });
    if (isPlainRecord(filteredSidebar)) {
      parsed.sidebar = filteredSidebar;
    } else {
      delete parsed.sidebar;
    }
  } else {
    delete parsed.sidebar;
  }

  return buildYamlFile(parsed, { preserveEmptyStrings: true });
}

function filterExportFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  selectedFilesInput: string[] | undefined,
  paperclipExtensionPath: string,
) {
  if (!selectedFilesInput || selectedFilesInput.length === 0) {
    return files;
  }

  const selectedFiles = new Set(
    selectedFilesInput
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
  const filtered: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(files)) {
    if (!selectedFiles.has(filePath)) continue;
    filtered[filePath] = content;
  }

  const extensionEntry = filtered[paperclipExtensionPath];
  if (selectedFiles.has(paperclipExtensionPath) && typeof extensionEntry === "string") {
    filtered[paperclipExtensionPath] = filterPortableExtensionYaml(extensionEntry, selectedFiles);
  }

  return filtered;
}

function findPaperclipExtensionPath(files: Record<string, CompanyPortabilityFileEntry>) {
  if (typeof files[".paperclip.yaml"] === "string") return ".paperclip.yaml";
  if (typeof files[".paperclip.yml"] === "string") return ".paperclip.yml";
  return Object.keys(files).find((entry) => entry.endsWith("/.paperclip.yaml") || entry.endsWith("/.paperclip.yml")) ?? null;
}

function ensureMarkdownPath(pathValue: string) {
  const normalized = pathValue.replace(/\\/g, "/");
  if (!normalized.endsWith(".md")) {
    throw unprocessable(`Manifest file path must end in .md: ${pathValue}`);
  }
  return normalized;
}

function normalizePortableConfig(
  value: unknown,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(input)) {
    if (
      key === "cwd" ||
      key === "instructionsFilePath" ||
      key === "instructionsBundleMode" ||
      key === "instructionsRootPath" ||
      key === "instructionsEntryFile" ||
      key === "promptTemplate" ||
      key === "bootstrapPromptTemplate" || // deprecated — kept for backward compat
      key === "paperclipSkillSync"
    ) continue;
    if (key === "env") continue;
    next[key] = entry;
  }

  return next;
}

function isAbsoluteCommand(value: string) {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function extractPortableEnvInputs(
  agentSlug: string,
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInput[] {
  return extractPortableScopedEnvInputs(
    {
      label: `agent ${agentSlug}`,
      warningPrefix: `Agent ${agentSlug}`,
      agentSlug,
      projectSlug: null,
    },
    envValue,
    warnings,
  );
}

function extractPortableProjectEnvInputs(
  projectSlug: string,
  envValue: unknown,
  warnings: string[],
): CompanyPortabilityEnvInput[] {
  return extractPortableScopedEnvInputs(
    {
      label: `project ${projectSlug}`,
      warningPrefix: `Project ${projectSlug}`,
      agentSlug: null,
      projectSlug,
    },
    envValue,
    warnings,
  );
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

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function stripEmptyValues(value: unknown, opts?: { preserveEmptyStrings?: boolean }): unknown {
  if (Array.isArray(value)) {
    const next = value
      .map((entry) => stripEmptyValues(entry, opts))
      .filter((entry) => entry !== undefined);
    return next.length > 0 ? next : undefined;
  }
  if (isPlainRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = stripEmptyValues(entry, opts);
      if (cleaned === undefined) continue;
      next[key] = cleaned;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  }
  if (
    value === undefined ||
    value === null ||
    (!opts?.preserveEmptyStrings && value === "") ||
    isEmptyArray(value) ||
    isEmptyObject(value)
  ) {
    return undefined;
  }
  return value;
}

const YAML_KEY_PRIORITY = [
  "name",
  "description",
  "title",
  "schema",
  "kind",
  "slug",
  "reportsTo",
  "skills",
  "owner",
  "assignee",
  "project",
  "schedule",
  "version",
  "license",
  "authors",
  "homepage",
  "tags",
  "includes",
  "requirements",
  "role",
  "icon",
  "capabilities",
  "brandColor",
  "logoPath",
  "adapter",
  "runtime",
  "permissions",
  "budgetMonthlyCents",
  "metadata",
] as const;

const YAML_KEY_PRIORITY_INDEX = new Map<string, number>(
  YAML_KEY_PRIORITY.map((key, index) => [key, index]),
);

function compareYamlKeys(left: string, right: string) {
  const leftPriority = YAML_KEY_PRIORITY_INDEX.get(left);
  const rightPriority = YAML_KEY_PRIORITY_INDEX.get(right);
  if (leftPriority !== undefined || rightPriority !== undefined) {
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  }
  return left.localeCompare(right);
}

function orderedYamlEntries(value: Record<string, unknown>) {
  return Object.entries(value).sort(([leftKey], [rightKey]) => compareYamlKeys(leftKey, rightKey));
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
    const entries = orderedYamlEntries(value);
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
  for (const [key, value] of orderedYamlEntries(frontmatter)) {
    // Skip null/undefined values — don't export empty fields
    if (value === null || value === undefined) continue;
    const scalar =
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

function normalizeSelectedFiles(selectedFiles?: string[]) {
  if (!selectedFiles) return null;
  return new Set(
    selectedFiles
      .map((entry) => normalizePortablePath(entry))
      .filter((entry) => entry.length > 0),
  );
}

function filterCompanyMarkdownIncludes(
  companyPath: string,
  markdown: string,
  selectedFiles: Set<string>,
) {
  const parsed = parseFrontmatterMarkdown(markdown);
  const includeEntries = readIncludeEntries(parsed.frontmatter);
  const filteredIncludes = includeEntries.filter((entry) =>
    selectedFiles.has(resolvePortablePath(companyPath, entry.path)),
  );
  const nextFrontmatter: Record<string, unknown> = { ...parsed.frontmatter };
  if (filteredIncludes.length > 0) {
    nextFrontmatter.includes = filteredIncludes.map((entry) => entry.path);
  } else {
    delete nextFrontmatter.includes;
  }
  return buildMarkdown(nextFrontmatter, parsed.body);
}

function applySelectedFilesToSource(source: ResolvedSource, selectedFiles?: string[]): ResolvedSource {
  const normalizedSelection = normalizeSelectedFiles(selectedFiles);
  if (!normalizedSelection) return source;

  const companyPath = source.manifest.company
    ? ensureMarkdownPath(source.manifest.company.path)
    : Object.keys(source.files).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md") ?? null;
  if (!companyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyMarkdown = source.files[companyPath];
  if (typeof companyMarkdown !== "string") {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const effectiveFiles: Record<string, CompanyPortabilityFileEntry> = {};
  for (const [filePath, content] of Object.entries(source.files)) {
    const normalizedPath = normalizePortablePath(filePath);
    if (!normalizedSelection.has(normalizedPath)) continue;
    effectiveFiles[normalizedPath] = content;
  }

  effectiveFiles[companyPath] = filterCompanyMarkdownIncludes(
    companyPath,
    companyMarkdown,
    normalizedSelection,
  );

  const filtered = buildManifestFromPackageFiles(effectiveFiles, {
    sourceLabel: source.manifest.source,
  });

  if (!normalizedSelection.has(companyPath)) {
    filtered.manifest.company = null;
  }

  filtered.manifest.includes = {
    company: filtered.manifest.company !== null,
    agents: filtered.manifest.agents.length > 0,
    projects: filtered.manifest.projects.length > 0,
    issues: filtered.manifest.issues.length > 0,
    skills: filtered.manifest.skills.length > 0,
  };

  return filtered;
}

async function resolveBundledSkillsCommit() {
  if (!bundledSkillsCommitPromise) {
    bundledSkillsCommitPromise = execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    })
      .then(({ stdout }) => stdout.trim() || null)
      .catch(() => null);
  }
  return bundledSkillsCommitPromise;
}

async function buildSkillSourceEntry(skill: CompanySkill) {
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (asString(metadata?.sourceKind) === "paperclip_bundled") {
    const commit = await resolveBundledSkillsCommit();
    return {
      kind: "github-dir",
      repo: "paperclipai/paperclip",
      path: `skills/${skill.slug}`,
      commit,
      trackingRef: "master",
      url: `https://github.com/paperclipai/paperclip/tree/master/skills/${skill.slug}`,
    };
  }

  if (skill.sourceType === "github" || skill.sourceType === "skills_sh") {
    const owner = asString(metadata?.owner);
    const repo = asString(metadata?.repo);
    const repoSkillDir = asString(metadata?.repoSkillDir);
    if (!owner || !repo || !repoSkillDir) return null;
    return {
      kind: "github-dir",
      repo: `${owner}/${repo}`,
      path: repoSkillDir,
      commit: skill.sourceRef ?? null,
      trackingRef: asString(metadata?.trackingRef),
      url: skill.sourceLocator,
    };
  }

  if (skill.sourceType === "url" && skill.sourceLocator) {
    return {
      kind: "url",
      url: skill.sourceLocator,
    };
  }

  return null;
}

function shouldReferenceSkillOnExport(skill: CompanySkill, expandReferencedSkills: boolean) {
  if (expandReferencedSkills) return false;
  const metadata = isPlainRecord(skill.metadata) ? skill.metadata : null;
  if (asString(metadata?.sourceKind) === "paperclip_bundled") return true;
  return skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url";
}

async function buildReferencedSkillMarkdown(skill: CompanySkill) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const frontmatter: Record<string, unknown> = {
    key: skill.key,
    slug: skill.slug,
    name: skill.name,
    description: skill.description ?? null,
  };
  if (sourceEntry) {
    frontmatter.metadata = {
      sources: [sourceEntry],
    };
  }
  return buildMarkdown(frontmatter, "");
}

async function withSkillSourceMetadata(skill: CompanySkill, markdown: string) {
  const sourceEntry = await buildSkillSourceEntry(skill);
  const parsed = parseFrontmatterMarkdown(markdown);
  const metadata = isPlainRecord(parsed.frontmatter.metadata)
    ? { ...parsed.frontmatter.metadata }
    : {};
  const existingSources = Array.isArray(metadata.sources)
    ? metadata.sources.filter((entry) => isPlainRecord(entry))
    : [];
  if (sourceEntry) {
    metadata.sources = [...existingSources, sourceEntry];
  }
  metadata.skillKey = skill.key;
  metadata.paperclipSkillKey = skill.key;
  metadata.paperclip = {
    ...(isPlainRecord(metadata.paperclip) ? metadata.paperclip : {}),
    skillKey: skill.key,
    slug: skill.slug,
  };
  const frontmatter = {
    ...parsed.frontmatter,
    key: skill.key,
    slug: skill.slug,
    metadata,
  };
  return buildMarkdown(frontmatter, parsed.body);
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
  if (
    trimmed.startsWith("\"") ||
    trimmed.startsWith("[") ||
    trimmed.startsWith("{")
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
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

function parseYamlBlock(
  lines: Array<{ indent: number; content: string }>,
  startIndex: number,
  indentLevel: number,
): { value: unknown; nextIndex: number } {
  let index = startIndex;
  while (index < lines.length && lines[index]!.content.length === 0) {
    index += 1;
  }
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
      const inlineObjectSeparator = remainder.indexOf(":");
      if (
        inlineObjectSeparator > 0 &&
        !remainder.startsWith("\"") &&
        !remainder.startsWith("{") &&
        !remainder.startsWith("[")
      ) {
        const key = remainder.slice(0, inlineObjectSeparator).trim();
        const rawValue = remainder.slice(inlineObjectSeparator + 1).trim();
        const nextObject: Record<string, unknown> = {
          [key]: parseYamlScalar(rawValue),
        };
        if (index < lines.length && lines[index]!.indent > indentLevel) {
          const nested = parseYamlBlock(lines, index, indentLevel + 2);
          if (isPlainRecord(nested.value)) {
            Object.assign(nextObject, nested.value);
          }
          index = nested.nextIndex;
        }
        values.push(nextObject);
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

function parseYamlFile(raw: string): Record<string, unknown> {
  return parseYamlFrontmatter(raw);
}

function buildYamlFile(value: Record<string, unknown>, opts?: { preserveEmptyStrings?: boolean }) {
  const cleaned = stripEmptyValues(value, opts);
  if (!isPlainRecord(cleaned)) return "{}\n";
  return renderYamlBlock(cleaned, 0).join("\n") + "\n";
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
  return {
    frontmatter: parseYamlFrontmatter(frontmatterRaw),
    body,
  };
}

async function fetchText(url: string) {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchOptionalText(url: string) {
  const response = await ghFetch(url);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

async function fetchBinary(url: string) {
  const response = await ghFetch(url);
  if (!response.ok) {
    throw unprocessable(`Failed to fetch ${url}: ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
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

function dedupeEnvInputs(values: CompanyPortabilityManifest["envInputs"]) {
  const seen = new Set<string>();
  const out: CompanyPortabilityManifest["envInputs"] = [];
  for (const value of values) {
    const key = `${value.agentSlug ?? ""}:${value.projectSlug ?? ""}:${value.key.toUpperCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function buildEnvInputMap(inputs: CompanyPortabilityEnvInput[]) {
  const env: Record<string, Record<string, unknown>> = {};
  for (const input of inputs) {
    const entry: Record<string, unknown> = {
      kind: input.kind,
      requirement: input.requirement,
    };
    if (input.defaultValue !== null) entry.default = input.defaultValue;
    if (input.description) entry.description = input.description;
    if (input.portability === "system_dependent") entry.portability = "system_dependent";
    env[input.key] = entry;
  }
  return env;
}

function readCompanyApprovalDefault(_frontmatter: Record<string, unknown>) {
  return true;
}

function readIncludeEntries(frontmatter: Record<string, unknown>): CompanyPackageIncludeEntry[] {
  const includes = frontmatter.includes;
  if (!Array.isArray(includes)) return [];
  return includes.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ path: entry }];
    }
    if (isPlainRecord(entry)) {
      const pathValue = asString(entry.path);
      return pathValue ? [{ path: pathValue }] : [];
    }
    return [];
  });
}

function readAgentEnvInputs(
  extension: Record<string, unknown>,
  agentSlug: string,
): CompanyPortabilityManifest["envInputs"] {
  const inputs = isPlainRecord(extension.inputs) ? extension.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    const record = value as EnvInputRecord;
    return [{
      key,
      description: asString(record.description) ?? null,
      agentSlug,
      projectSlug: null,
      kind: record.kind === "plain" ? "plain" : "secret",
      requirement: record.requirement === "required" ? "required" : "optional",
      defaultValue: typeof record.default === "string" ? record.default : null,
      portability: record.portability === "system_dependent" ? "system_dependent" : "portable",
    }];
  });
}

function readProjectEnvInputs(
  extension: Record<string, unknown>,
  projectSlug: string,
): CompanyPortabilityManifest["envInputs"] {
  const inputs = isPlainRecord(extension.inputs) ? extension.inputs : null;
  const env = inputs && isPlainRecord(inputs.env) ? inputs.env : null;
  if (!env) return [];

  return Object.entries(env).flatMap(([key, value]) => {
    if (!isPlainRecord(value)) return [];
    const record = value as EnvInputRecord;
    return [{
      key,
      description: asString(record.description) ?? null,
      agentSlug: null,
      projectSlug,
      kind: record.kind === "plain" ? "plain" : "secret",
      requirement: record.requirement === "required" ? "required" : "optional",
      defaultValue: typeof record.default === "string" ? record.default : null,
      portability: record.portability === "system_dependent" ? "system_dependent" : "portable",
    }];
  });
}

function readAgentSkillRefs(frontmatter: Record<string, unknown>) {
  const skills = frontmatter.skills;
  if (!Array.isArray(skills)) return [];
  return Array.from(new Set(
    skills
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => normalizeSkillKey(entry) ?? entry.trim())
      .filter(Boolean),
  ));
}

function buildManifestFromPackageFiles(
  files: Record<string, CompanyPortabilityFileEntry>,
  opts?: { sourceLabel?: { companyId: string; companyName: string } | null },
): ResolvedSource {
  const normalizedFiles = normalizeFileMap(files);
  const companyPath = typeof normalizedFiles["COMPANY.md"] === "string"
    ? normalizedFiles["COMPANY.md"]
    : undefined;
  const resolvedCompanyPath = companyPath !== undefined
    ? "COMPANY.md"
    : Object.keys(normalizedFiles).find((entry) => entry.endsWith("/COMPANY.md") || entry === "COMPANY.md");
  if (!resolvedCompanyPath) {
    throw unprocessable("Company package is missing COMPANY.md");
  }

  const companyMarkdown = readPortableTextFile(normalizedFiles, resolvedCompanyPath);
  if (typeof companyMarkdown !== "string") {
    throw unprocessable(`Company package file is not readable as text: ${resolvedCompanyPath}`);
  }
  const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
  const companyFrontmatter = companyDoc.frontmatter;
  const paperclipExtensionPath = findPaperclipExtensionPath(normalizedFiles);
  const paperclipExtension = paperclipExtensionPath
    ? parseYamlFile(readPortableTextFile(normalizedFiles, paperclipExtensionPath) ?? "")
    : {};
  const paperclipCompany = isPlainRecord(paperclipExtension.company) ? paperclipExtension.company : {};
  const paperclipSidebar = normalizePortableSidebarOrder(paperclipExtension.sidebar);
  const paperclipAgents = isPlainRecord(paperclipExtension.agents) ? paperclipExtension.agents : {};
  const paperclipProjects = isPlainRecord(paperclipExtension.projects) ? paperclipExtension.projects : {};
  const paperclipTasks = isPlainRecord(paperclipExtension.tasks) ? paperclipExtension.tasks : {};
  const paperclipRoutines = isPlainRecord(paperclipExtension.routines) ? paperclipExtension.routines : {};
  const companyName =
    asString(companyFrontmatter.name)
    ?? opts?.sourceLabel?.companyName
    ?? "Imported Company";
  const companySlug =
    asString(companyFrontmatter.slug)
    ?? normalizeAgentUrlKey(companyName)
    ?? "company";

  const includeEntries = readIncludeEntries(companyFrontmatter);
  const referencedAgentPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md");
  const referencedProjectPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md");
  const referencedTaskPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/TASK.md") || entry === "TASK.md");
  const referencedSkillPaths = includeEntries
    .map((entry) => resolvePortablePath(resolvedCompanyPath, entry.path))
    .filter((entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md");
  const discoveredAgentPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/AGENTS.md") || entry === "AGENTS.md",
  );
  const discoveredProjectPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/PROJECT.md") || entry === "PROJECT.md",
  );
  const discoveredTaskPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/TASK.md") || entry === "TASK.md",
  );
  const discoveredSkillPaths = Object.keys(normalizedFiles).filter(
    (entry) => entry.endsWith("/SKILL.md") || entry === "SKILL.md",
  );
  const agentPaths = Array.from(new Set([...referencedAgentPaths, ...discoveredAgentPaths])).sort();
  const projectPaths = Array.from(new Set([...referencedProjectPaths, ...discoveredProjectPaths])).sort();
  const taskPaths = Array.from(new Set([...referencedTaskPaths, ...discoveredTaskPaths])).sort();
  const skillPaths = Array.from(new Set([...referencedSkillPaths, ...discoveredSkillPaths])).sort();

  const manifest: CompanyPortabilityManifest = {
    schemaVersion: 5,
    generatedAt: new Date().toISOString(),
    source: opts?.sourceLabel ?? null,
    includes: {
      company: true,
      agents: true,
      projects: projectPaths.length > 0,
      issues: taskPaths.length > 0,
      skills: skillPaths.length > 0,
    },
    company: {
      path: resolvedCompanyPath,
      name: companyName,
      description: asString(companyFrontmatter.description),
      brandColor: asString(paperclipCompany.brandColor),
      logoPath: asString(paperclipCompany.logoPath) ?? asString(paperclipCompany.logo),
      requireBoardApprovalForNewAgents:
        typeof paperclipCompany.requireBoardApprovalForNewAgents === "boolean"
          ? paperclipCompany.requireBoardApprovalForNewAgents
          : readCompanyApprovalDefault(companyFrontmatter),
      feedbackDataSharingEnabled:
        typeof paperclipCompany.feedbackDataSharingEnabled === "boolean"
          ? paperclipCompany.feedbackDataSharingEnabled
          : false,
      feedbackDataSharingConsentAt:
        typeof paperclipCompany.feedbackDataSharingConsentAt === "string"
          ? paperclipCompany.feedbackDataSharingConsentAt
          : null,
      feedbackDataSharingConsentByUserId:
        asString(paperclipCompany.feedbackDataSharingConsentByUserId),
      feedbackDataSharingTermsVersion:
        asString(paperclipCompany.feedbackDataSharingTermsVersion),
    },
    sidebar: paperclipSidebar,
    agents: [],
    skills: [],
    projects: [],
    issues: [],
    envInputs: [],
  };

  const warnings: string[] = [];
  if (manifest.company?.logoPath && !normalizedFiles[manifest.company.logoPath]) {
    warnings.push(`Referenced company logo file is missing from package: ${manifest.company.logoPath}`);
  }
  for (const agentPath of agentPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, agentPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced agent file is missing from package: ${agentPath}`);
      continue;
    }
    const agentDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = agentDoc.frontmatter;
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(agentPath))) ?? "agent";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipAgents[slug]) ? paperclipAgents[slug] : {};
    const extensionAdapter = isPlainRecord(extension.adapter) ? extension.adapter : null;
    const extensionRuntime = isPlainRecord(extension.runtime) ? extension.runtime : null;
    const extensionPermissions = isPlainRecord(extension.permissions) ? extension.permissions : null;
    const extensionMetadata = isPlainRecord(extension.metadata) ? extension.metadata : null;
    const adapterConfig = isPlainRecord(extensionAdapter?.config)
      ? extensionAdapter.config
      : {};
    const runtimeConfig = extensionRuntime ?? {};
    const title = asString(frontmatter.title);

    manifest.agents.push({
      slug,
      name: asString(frontmatter.name) ?? title ?? slug,
      path: agentPath,
      skills: readAgentSkillRefs(frontmatter),
      role: asString(extension.role) ?? asString(frontmatter.role) ?? "agent",
      title,
      icon: asString(extension.icon),
      capabilities: asString(extension.capabilities),
      reportsToSlug: asString(frontmatter.reportsTo) ?? asString(extension.reportsTo),
      adapterType: asString(extensionAdapter?.type) ?? "process",
      adapterConfig,
      runtimeConfig,
      permissions: extensionPermissions ?? {},
      budgetMonthlyCents:
        typeof extension.budgetMonthlyCents === "number" && Number.isFinite(extension.budgetMonthlyCents)
          ? Math.max(0, Math.floor(extension.budgetMonthlyCents))
          : 0,
      metadata: extensionMetadata,
    });

    manifest.envInputs.push(...readAgentEnvInputs(extension, slug));

    if (frontmatter.kind && frontmatter.kind !== "agent") {
      warnings.push(`Agent markdown ${agentPath} does not declare kind: agent in frontmatter.`);
    }
  }

  for (const skillPath of skillPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, skillPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced skill file is missing from package: ${skillPath}`);
      continue;
    }
    const skillDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = skillDoc.frontmatter;
    const skillDir = path.posix.dirname(skillPath);
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(skillDir)) ?? "skill";
    const slug = asString(frontmatter.slug) ?? normalizeAgentUrlKey(asString(frontmatter.name) ?? "") ?? fallbackSlug;
    const inventory = Object.keys(normalizedFiles)
      .filter((entry) => entry === skillPath || entry.startsWith(`${skillDir}/`))
      .map((entry) => ({
        path: entry === skillPath ? "SKILL.md" : entry.slice(skillDir.length + 1),
        kind: entry === skillPath
          ? "skill"
          : entry.startsWith(`${skillDir}/references/`)
            ? "reference"
            : entry.startsWith(`${skillDir}/scripts/`)
              ? "script"
              : entry.startsWith(`${skillDir}/assets/`)
                ? "asset"
                : entry.endsWith(".md")
                  ? "markdown"
                  : "other",
      }));
    const metadata = isPlainRecord(frontmatter.metadata) ? frontmatter.metadata : null;
    const sources = metadata && Array.isArray(metadata.sources) ? metadata.sources : [];
    const primarySource = sources.find((entry) => isPlainRecord(entry)) as Record<string, unknown> | undefined;
    const sourceKind = asString(primarySource?.kind);
    let sourceType = "catalog";
    let sourceLocator: string | null = null;
    let sourceRef: string | null = null;
    let normalizedMetadata: Record<string, unknown> | null = null;

    if (sourceKind === "github-dir" || sourceKind === "github-file") {
      const repo = asString(primarySource?.repo);
      const repoPath = asString(primarySource?.path);
      const commit = asString(primarySource?.commit);
      const trackingRef = asString(primarySource?.trackingRef);
      const sourceHostname = asString(primarySource?.hostname) || "github.com";
      const [owner, repoName] = (repo ?? "").split("/");
      sourceType = "github";
      sourceLocator = asString(primarySource?.url)
        ?? (repo ? `https://${sourceHostname}/${repo}${repoPath ? `/tree/${trackingRef ?? commit ?? "main"}/${repoPath}` : ""}` : null);
      sourceRef = commit;
      normalizedMetadata = owner && repoName
        ? {
            sourceKind: "github",
            ...(sourceHostname !== "github.com" ? { hostname: sourceHostname } : {}),
            owner,
            repo: repoName,
            ref: commit,
            trackingRef,
            repoSkillDir: repoPath ?? `skills/${slug}`,
          }
        : null;
    } else if (sourceKind === "url") {
      sourceType = "url";
      sourceLocator = asString(primarySource?.url) ?? asString(primarySource?.rawUrl);
      normalizedMetadata = {
        sourceKind: "url",
      };
    } else if (metadata) {
      normalizedMetadata = {
        sourceKind: "catalog",
      };
    }
    const key = deriveManifestSkillKey(frontmatter, slug, normalizedMetadata, sourceType, sourceLocator);

    manifest.skills.push({
      key,
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: skillPath,
      description: asString(frontmatter.description),
      sourceType,
      sourceLocator,
      sourceRef,
      trustLevel: null,
      compatibility: "compatible",
      metadata: normalizedMetadata,
      fileInventory: inventory,
    });
  }

  for (const projectPath of projectPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, projectPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced project file is missing from package: ${projectPath}`);
      continue;
    }
    const projectDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = projectDoc.frontmatter;
    const fallbackSlug = deriveProjectUrlKey(
      asString(frontmatter.name) ?? path.posix.basename(path.posix.dirname(projectPath)) ?? "project",
      projectPath,
    );
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipProjects[slug]) ? paperclipProjects[slug] : {};
    const workspaceExtensions = isPlainRecord(extension.workspaces) ? extension.workspaces : {};
    const workspaces = Object.entries(workspaceExtensions)
      .map(([workspaceKey, entry]) => normalizePortableProjectWorkspaceExtension(workspaceKey, entry))
      .filter((entry): entry is CompanyPortabilityProjectWorkspaceManifestEntry => entry !== null);
    manifest.projects.push({
      slug,
      name: asString(frontmatter.name) ?? slug,
      path: projectPath,
      description: asString(frontmatter.description),
      ownerAgentSlug: asString(frontmatter.owner),
      leadAgentSlug: asString(extension.leadAgentSlug),
      targetDate: asString(extension.targetDate),
      color: asString(extension.color),
      status: asString(extension.status),
      env: normalizePortableProjectEnv(extension.env),
      executionWorkspacePolicy: isPlainRecord(extension.executionWorkspacePolicy)
        ? extension.executionWorkspacePolicy
        : null,
      workspaces,
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    manifest.envInputs.push(...readProjectEnvInputs(extension, slug));
    if (frontmatter.kind && frontmatter.kind !== "project") {
      warnings.push(`Project markdown ${projectPath} does not declare kind: project in frontmatter.`);
    }
  }

  for (const taskPath of taskPaths) {
    const markdownRaw = readPortableTextFile(normalizedFiles, taskPath);
    if (typeof markdownRaw !== "string") {
      warnings.push(`Referenced task file is missing from package: ${taskPath}`);
      continue;
    }
    const taskDoc = parseFrontmatterMarkdown(markdownRaw);
    const frontmatter = taskDoc.frontmatter;
    const fallbackSlug = normalizeAgentUrlKey(path.posix.basename(path.posix.dirname(taskPath))) ?? "task";
    const slug = asString(frontmatter.slug) ?? fallbackSlug;
    const extension = isPlainRecord(paperclipTasks[slug]) ? paperclipTasks[slug] : {};
    const routineExtension = normalizeRoutineExtension(paperclipRoutines[slug]);
    const routineExtensionRaw = isPlainRecord(paperclipRoutines[slug]) ? paperclipRoutines[slug] : {};
    const schedule = isPlainRecord(frontmatter.schedule) ? frontmatter.schedule : null;
    const legacyRecurrence = schedule && isPlainRecord(schedule.recurrence)
      ? schedule.recurrence
      : isPlainRecord(extension.recurrence)
        ? extension.recurrence
        : null;
    const recurring =
      asBoolean(frontmatter.recurring) === true
      || routineExtension !== null
      || legacyRecurrence !== null;
    manifest.issues.push({
      slug,
      identifier: asString(extension.identifier),
      title: asString(frontmatter.name) ?? asString(frontmatter.title) ?? slug,
      path: taskPath,
      projectSlug: asString(frontmatter.project),
      projectWorkspaceKey: asString(extension.projectWorkspaceKey),
      assigneeAgentSlug: asString(frontmatter.assignee),
      description: taskDoc.body || asString(frontmatter.description),
      recurring,
      routine: routineExtension,
      legacyRecurrence,
      status: asString(extension.status) ?? asString(routineExtensionRaw.status),
      priority: asString(extension.priority) ?? asString(routineExtensionRaw.priority),
      labelIds: Array.isArray(extension.labelIds)
        ? extension.labelIds.filter((entry): entry is string => typeof entry === "string")
        : [],
      billingCode: asString(extension.billingCode),
      executionWorkspaceSettings: isPlainRecord(extension.executionWorkspaceSettings)
        ? extension.executionWorkspaceSettings
        : null,
      assigneeAdapterOverrides: isPlainRecord(extension.assigneeAdapterOverrides)
        ? extension.assigneeAdapterOverrides
        : null,
      metadata: isPlainRecord(extension.metadata) ? extension.metadata : null,
    });
    if (frontmatter.kind && frontmatter.kind !== "task") {
      warnings.push(`Task markdown ${taskPath} does not declare kind: task in frontmatter.`);
    }
  }

  manifest.envInputs = dedupeEnvInputs(manifest.envInputs);
  return {
    manifest,
    files: normalizedFiles,
    warnings,
  };
}


function normalizeGitHubSourcePath(value: string | null | undefined) {
  if (!value) return "";
  return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function parseGitHubSourceUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw unprocessable("GitHub source URL must use HTTPS");
  }
  const hostname = url.hostname;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    throw unprocessable("Invalid GitHub URL");
  }
  const owner = parts[0]!;
  const repo = parts[1]!.replace(/\.git$/i, "");
  const queryRef = url.searchParams.get("ref")?.trim();
  const queryPath = normalizeGitHubSourcePath(url.searchParams.get("path"));
  const queryCompanyPath = normalizeGitHubSourcePath(url.searchParams.get("companyPath"));
  if (queryRef || queryPath || queryCompanyPath) {
    const companyPath = queryCompanyPath || [queryPath, "COMPANY.md"].filter(Boolean).join("/") || "COMPANY.md";
    let basePath = queryPath;
    if (!basePath && companyPath !== "COMPANY.md") {
      basePath = path.posix.dirname(companyPath);
      if (basePath === ".") basePath = "";
    }
    return {
      hostname,
      owner,
      repo,
      ref: queryRef || "main",
      basePath,
      companyPath,
    };
  }
  let ref = "main";
  let basePath = "";
  let companyPath = "COMPANY.md";
  if (parts[2] === "tree") {
    ref = parts[3] ?? "main";
    basePath = parts.slice(4).join("/");
  } else if (parts[2] === "blob") {
    ref = parts[3] ?? "main";
    const blobPath = parts.slice(4).join("/");
    if (!blobPath) {
      throw unprocessable("Invalid GitHub blob URL");
    }
    companyPath = blobPath;
    basePath = path.posix.dirname(blobPath);
    if (basePath === ".") basePath = "";
  }
  return { hostname, owner, repo, ref, basePath, companyPath };
}


export function companyPortabilityService(db: Db, storage?: StorageService) {
  const companies = companyService(db);
  const agents = agentService(db);
  const assetRecords = assetService(db);
  const instructions = agentInstructionsService();
  const access = accessService(db);
  const projects = projectService(db);
  const issues = issueService(db);
  const companySkills = companySkillService(db);

  async function resolveSource(source: CompanyPortabilityPreview["source"]): Promise<ResolvedSource> {
    if (source.type === "inline") {
      return buildManifestFromPackageFiles(
        normalizeFileMap(source.files, source.rootPath),
      );
    }

    const parsed = parseGitHubSourceUrl(source.url);
    let ref = parsed.ref;
    const warnings: string[] = [];
    const companyRelativePath = parsed.companyPath === "COMPANY.md"
      ? [parsed.basePath, "COMPANY.md"].filter(Boolean).join("/")
      : parsed.companyPath;
    let companyMarkdown: string | null = null;
    try {
      companyMarkdown = await fetchOptionalText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, companyRelativePath),
      );
    } catch (err) {
      if (ref === "main") {
        ref = "master";
        warnings.push("GitHub ref main not found; falling back to master.");
        companyMarkdown = await fetchOptionalText(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, companyRelativePath),
        );
      } else {
        throw err;
      }
    }
    if (!companyMarkdown) {
      throw unprocessable("GitHub company package is missing COMPANY.md");
    }

    const companyPath = parsed.companyPath === "COMPANY.md"
      ? "COMPANY.md"
      : normalizePortablePath(path.posix.relative(parsed.basePath || ".", parsed.companyPath));
    const files: Record<string, CompanyPortabilityFileEntry> = {
      [companyPath]: companyMarkdown,
    };
    const apiBase = gitHubApiBase(parsed.hostname);
    const tree = await fetchJson<{ tree?: Array<{ path: string; type: string }> }>(
      `${apiBase}/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    ).catch(() => ({ tree: [] }));
    const basePrefix = parsed.basePath ? `${parsed.basePath.replace(/^\/+|\/+$/g, "")}/` : "";
    const candidatePaths = (tree.tree ?? [])
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path)
      .filter((entry): entry is string => typeof entry === "string")
      .filter((entry) => {
        if (basePrefix && !entry.startsWith(basePrefix)) return false;
        const relative = basePrefix ? entry.slice(basePrefix.length) : entry;
        return (
          relative.endsWith(".md") ||
          relative.startsWith("skills/") ||
          relative === ".paperclip.yaml" ||
          relative === ".paperclip.yml"
        );
      });
    for (const repoPath of candidatePaths) {
      const relativePath = basePrefix ? repoPath.slice(basePrefix.length) : repoPath;
      if (files[relativePath] !== undefined) continue;
      files[normalizePortablePath(relativePath)] = await fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }
    const companyDoc = parseFrontmatterMarkdown(companyMarkdown);
    const includeEntries = readIncludeEntries(companyDoc.frontmatter);
    for (const includeEntry of includeEntries) {
      const repoPath = [parsed.basePath, includeEntry.path].filter(Boolean).join("/");
      const relativePath = normalizePortablePath(includeEntry.path);
      if (files[relativePath] !== undefined) continue;
      if (!(repoPath.endsWith(".md") || repoPath.endsWith(".yaml") || repoPath.endsWith(".yml"))) continue;
      files[relativePath] = await fetchText(
        resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
      );
    }

    const resolved = buildManifestFromPackageFiles(files);
    const companyLogoPath = resolved.manifest.company?.logoPath;
    if (companyLogoPath && !resolved.files[companyLogoPath]) {
      const repoPath = [parsed.basePath, companyLogoPath].filter(Boolean).join("/");
      try {
        const binary = await fetchBinary(
          resolveRawGitHubUrl(parsed.hostname, parsed.owner, parsed.repo, ref, repoPath),
        );
        resolved.files[companyLogoPath] = bufferToPortableBinaryFile(binary, inferContentTypeFromPath(companyLogoPath));
      } catch (err) {
        warnings.push(`Failed to fetch company logo ${companyLogoPath} from GitHub: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resolved.warnings.unshift(...warnings);
    return resolved;
  }

  async function exportBundle(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportResult> {
    const include = normalizeInclude({
      ...input.include,
      agents: input.agents && input.agents.length > 0 ? true : input.include?.agents,
      projects: input.projects && input.projects.length > 0 ? true : input.include?.projects,
      issues:
        (input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0)
          ? true
          : input.include?.issues,
      skills: input.skills && input.skills.length > 0 ? true : input.include?.skills,
    });
    const company = await companies.getById(companyId);
    if (!company) throw notFound("Company not found");

    const files: Record<string, CompanyPortabilityFileEntry> = {};
    const warnings: string[] = [];
    const envInputs: CompanyPortabilityManifest["envInputs"] = [];
    const requestedSidebarOrder = normalizePortableSidebarOrder(input.sidebarOrder);
    const rootPath = normalizeAgentUrlKey(company.name) ?? "company-package";
    let companyLogoPath: string | null = null;

    const allAgentRows = include.agents ? await agents.list(companyId, { includeTerminated: true }) : [];
    const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
    const companySkillRows = include.skills || include.agents ? await companySkills.listFull(companyId) : [];
    if (include.agents) {
      const skipped = allAgentRows.length - liveAgentRows.length;
      if (skipped > 0) {
        warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
      }
    }

    const agentByReference = new Map<string, typeof liveAgentRows[number]>();
    for (const agent of liveAgentRows) {
      agentByReference.set(agent.id, agent);
      agentByReference.set(agent.name, agent);
      const normalizedName = normalizeAgentUrlKey(agent.name);
      if (normalizedName) {
        agentByReference.set(normalizedName, agent);
      }
    }

    const selectedAgents = new Map<string, typeof liveAgentRows[number]>();
    for (const selector of input.agents ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeAgentUrlKey(trimmed) ?? trimmed;
      const match = agentByReference.get(trimmed) ?? agentByReference.get(normalized);
      if (!match) {
        warnings.push(`Agent selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedAgents.set(match.id, match);
    }

    if (include.agents && selectedAgents.size === 0) {
      for (const agent of liveAgentRows) {
        selectedAgents.set(agent.id, agent);
      }
    }

    const agentRows = Array.from(selectedAgents.values())
      .sort((left, right) => left.name.localeCompare(right.name));

    const usedSlugs = new Set<string>();
    const idToSlug = new Map<string, string>();
    for (const agent of agentRows) {
      const baseSlug = toSafeSlug(agent.name, "agent");
      const slug = uniqueSlug(baseSlug, usedSlugs);
      idToSlug.set(agent.id, slug);
    }

    const projectsSvc = projectService(db);
    const issuesSvc = issueService(db);
    const routinesSvc = routineService(db);
    const allProjectsRaw = include.projects || include.issues ? await projectsSvc.list(companyId) : [];
    const allProjects = allProjectsRaw.filter((project) => !project.archivedAt);
    const allRoutines = include.issues ? await routinesSvc.list(companyId) : [];
    const projectById = new Map(allProjects.map((project) => [project.id, project]));
    const projectByReference = new Map<string, typeof allProjects[number]>();
    for (const project of allProjects) {
      projectByReference.set(project.id, project);
      projectByReference.set(project.urlKey, project);
    }

    const selectedProjects = new Map<string, typeof allProjects[number]>();
    const normalizeProjectSelector = (selector: string) => selector.trim().toLowerCase();
    for (const selector of input.projects ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
    }

    const selectedIssues = new Map<string, Awaited<ReturnType<typeof issuesSvc.getById>>>();
    const selectedRoutines = new Map<string, typeof allRoutines[number]>();
    const routineById = new Map(allRoutines.map((routine) => [routine.id, routine]));
    const resolveIssueBySelector = async (selector: string) => {
      const trimmed = selector.trim();
      if (!trimmed) return null;
      return trimmed.includes("-")
        ? issuesSvc.getByIdentifier(trimmed)
        : issuesSvc.getById(trimmed);
    };
    for (const selector of input.issues ?? []) {
      const issue = await resolveIssueBySelector(selector);
      if (!issue || issue.companyId !== companyId) {
        const routine = routineById.get(selector.trim());
        if (routine) {
          selectedRoutines.set(routine.id, routine);
          if (routine.projectId) {
            const parentProject = projectById.get(routine.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
          continue;
        }
        warnings.push(`Issue selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedIssues.set(issue.id, issue);
      if (issue.projectId) {
        const parentProject = projectById.get(issue.projectId);
        if (parentProject) selectedProjects.set(parentProject.id, parentProject);
      }
    }

    for (const selector of input.projectIssues ?? []) {
      const match = projectByReference.get(selector) ?? projectByReference.get(normalizeProjectSelector(selector));
      if (!match) {
        warnings.push(`Project-issues selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedProjects.set(match.id, match);
      const projectIssues = await issuesSvc.list(companyId, { projectId: match.id });
      for (const issue of projectIssues) {
        selectedIssues.set(issue.id, issue);
      }
      for (const routine of allRoutines.filter((entry) => entry.projectId === match.id)) {
        selectedRoutines.set(routine.id, routine);
      }
    }

    if (include.projects && selectedProjects.size === 0) {
      for (const project of allProjects) {
        selectedProjects.set(project.id, project);
      }
    }

    if (include.issues && selectedIssues.size === 0) {
      const allIssues = await issuesSvc.list(companyId);
      for (const issue of allIssues) {
        selectedIssues.set(issue.id, issue);
        if (issue.projectId) {
          const parentProject = projectById.get(issue.projectId);
          if (parentProject) selectedProjects.set(parentProject.id, parentProject);
        }
      }
      if (selectedRoutines.size === 0) {
        for (const routine of allRoutines) {
          selectedRoutines.set(routine.id, routine);
          if (routine.projectId) {
            const parentProject = projectById.get(routine.projectId);
            if (parentProject) selectedProjects.set(parentProject.id, parentProject);
          }
        }
      }
    }

    const selectedProjectRows = Array.from(selectedProjects.values())
      .sort((left, right) => left.name.localeCompare(right.name));
    const selectedIssueRows = Array.from(selectedIssues.values())
      .filter((issue): issue is NonNullable<typeof issue> => issue != null)
      .sort((left, right) => (left.identifier ?? left.title).localeCompare(right.identifier ?? right.title));
    const selectedRoutineSummaries = Array.from(selectedRoutines.values())
      .sort((left, right) => left.title.localeCompare(right.title));
    const selectedRoutineRows = (
      await Promise.all(selectedRoutineSummaries.map((routine) => routinesSvc.getDetail(routine.id)))
    ).filter((routine): routine is RoutineLike => routine !== null);

    const taskSlugByIssueId = new Map<string, string>();
    const taskSlugByRoutineId = new Map<string, string>();
    const usedTaskSlugs = new Set<string>();
    for (const issue of selectedIssueRows) {
      const baseSlug = normalizeAgentUrlKey(issue.identifier ?? issue.title) ?? "task";
      taskSlugByIssueId.set(issue.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }
    for (const routine of selectedRoutineRows) {
      const baseSlug = normalizeAgentUrlKey(routine.title) ?? "task";
      taskSlugByRoutineId.set(routine.id, uniqueSlug(baseSlug, usedTaskSlugs));
    }

    const projectSlugById = new Map<string, string>();
    const projectWorkspaceKeyByProjectId = new Map<string, Map<string, string>>();
    const usedProjectSlugs = new Set<string>();
    for (const project of selectedProjectRows) {
      const baseSlug = deriveProjectUrlKey(project.name, project.name);
      projectSlugById.set(project.id, uniqueSlug(baseSlug, usedProjectSlugs));
    }
    const sidebarOrder = requestedSidebarOrder ?? stripEmptyValues({
      agents: sortAgentsBySidebarOrder(Array.from(selectedAgents.values()))
        .map((agent) => idToSlug.get(agent.id))
        .filter((slug): slug is string => Boolean(slug)),
      projects: selectedProjectRows
        .map((project) => projectSlugById.get(project.id))
        .filter((slug): slug is string => Boolean(slug)),
    });

    const companyPath = "COMPANY.md";
    files[companyPath] = buildMarkdown(
      {
        name: company.name,
        description: company.description ?? null,
        schema: "agentcompanies/v1",
        slug: rootPath,
      },
      "",
    );

    if (include.company && company.logoAssetId) {
      if (!storage) {
        warnings.push("Skipped company logo from export because storage is unavailable.");
      } else {
        const logoAsset = await assetRecords.getById(company.logoAssetId);
        if (!logoAsset) {
          warnings.push(`Skipped company logo ${company.logoAssetId} because the asset record was not found.`);
        } else {
          try {
            const object = await storage.getObject(company.id, logoAsset.objectKey);
            const body = await streamToBuffer(object.stream);
            companyLogoPath = `images/${COMPANY_LOGO_FILE_NAME}${resolveCompanyLogoExtension(logoAsset.contentType, logoAsset.originalFilename)}`;
            files[companyLogoPath] = bufferToPortableBinaryFile(body, logoAsset.contentType);
          } catch (err) {
            warnings.push(`Failed to export company logo ${company.logoAssetId}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    const paperclipAgentsOut: Record<string, Record<string, unknown>> = {};
    const paperclipProjectsOut: Record<string, Record<string, unknown>> = {};
    const paperclipTasksOut: Record<string, Record<string, unknown>> = {};
    const unportableTaskWorkspaceRefs = new Map<string, { workspaceId: string; taskSlugs: string[] }>();
    const paperclipRoutinesOut: Record<string, Record<string, unknown>> = {};

    const skillByReference = new Map<string, typeof companySkillRows[number]>();
    for (const skill of companySkillRows) {
      skillByReference.set(skill.id, skill);
      skillByReference.set(skill.key, skill);
      skillByReference.set(skill.slug, skill);
      skillByReference.set(skill.name, skill);
    }
    const selectedSkills = new Map<string, typeof companySkillRows[number]>();
    for (const selector of input.skills ?? []) {
      const trimmed = selector.trim();
      if (!trimmed) continue;
      const normalized = normalizeSkillKey(trimmed) ?? normalizeSkillSlug(trimmed) ?? trimmed;
      const match = skillByReference.get(trimmed) ?? skillByReference.get(normalized);
      if (!match) {
        warnings.push(`Skill selector "${selector}" was not found and was skipped.`);
        continue;
      }
      selectedSkills.set(match.id, match);
    }
    if (selectedSkills.size === 0) {
      for (const skill of companySkillRows) {
        selectedSkills.set(skill.id, skill);
      }
    }
    const selectedSkillRows = Array.from(selectedSkills.values())
      .sort((left, right) => left.key.localeCompare(right.key));

    const skillExportDirs = buildSkillExportDirMap(selectedSkillRows, company.issuePrefix);
    for (const skill of selectedSkillRows) {
      const packageDir = skillExportDirs.get(skill.key) ?? `skills/${normalizeSkillSlug(skill.slug) ?? "skill"}`;
      if (shouldReferenceSkillOnExport(skill, Boolean(input.expandReferencedSkills))) {
        files[`${packageDir}/SKILL.md`] = await buildReferencedSkillMarkdown(skill);
        continue;
      }

      for (const inventoryEntry of skill.fileInventory) {
        const fileDetail = await companySkills.readFile(companyId, skill.id, inventoryEntry.path).catch(() => null);
        if (!fileDetail) continue;
        const filePath = `${packageDir}/${inventoryEntry.path}`;
        files[filePath] = inventoryEntry.path === "SKILL.md"
          ? await withSkillSourceMetadata(skill, fileDetail.content)
          : fileDetail.content;
      }
    }

    if (include.agents) {
      for (const agent of agentRows) {
        const slug = idToSlug.get(agent.id)!;
        const exportedInstructions = await instructions.exportFiles(agent);
        warnings.push(...exportedInstructions.warnings);

        const envInputsStart = envInputs.length;
        const exportedEnvInputs = extractPortableEnvInputs(
          slug,
          (agent.adapterConfig as Record<string, unknown>).env,
          warnings,
        );
        envInputs.push(...exportedEnvInputs);
        const adapterDefaultRules = ADAPTER_DEFAULT_RULES_BY_TYPE[agent.adapterType] ?? [];
        const portableAdapterConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.adapterConfig),
          {
            dropFalseBooleans: true,
            defaultRules: adapterDefaultRules,
          },
        ) as Record<string, unknown>;
        const portableRuntimeConfig = pruneDefaultLikeValue(
          normalizePortableConfig(agent.runtimeConfig),
          {
            dropFalseBooleans: true,
            defaultRules: RUNTIME_DEFAULT_RULES,
          },
        ) as Record<string, unknown>;
        const portablePermissions = pruneDefaultLikeValue(agent.permissions ?? {}, { dropFalseBooleans: true }) as Record<string, unknown>;
        const agentEnvInputs = dedupeEnvInputs(
          envInputs
            .slice(envInputsStart)
            .filter((inputValue) => inputValue.agentSlug === slug),
        );
        const reportsToSlug = agent.reportsTo ? (idToSlug.get(agent.reportsTo) ?? null) : null;
        const desiredSkills = readPaperclipSkillSyncPreference(
          (agent.adapterConfig as Record<string, unknown>) ?? {},
        ).desiredSkills;

        const commandValue = asString(portableAdapterConfig.command);
        if (commandValue && isAbsoluteCommand(commandValue)) {
          warnings.push(`Agent ${slug} command ${commandValue} was omitted from export because it is system-dependent.`);
          delete portableAdapterConfig.command;
        }
        for (const [relativePath, content] of Object.entries(exportedInstructions.files)) {
          const targetPath = `agents/${slug}/${relativePath}`;
          if (relativePath === exportedInstructions.entryFile) {
            files[targetPath] = buildMarkdown(
              stripEmptyValues({
                name: agent.name,
                title: agent.title ?? null,
                reportsTo: reportsToSlug,
                skills: desiredSkills.length > 0 ? desiredSkills : undefined,
              }) as Record<string, unknown>,
              content,
            );
          } else {
            files[targetPath] = content;
          }
        }

        const extension = stripEmptyValues({
          role: agent.role !== "agent" ? agent.role : undefined,
          icon: agent.icon ?? null,
          capabilities: agent.capabilities ?? null,
          adapter: {
            type: agent.adapterType,
            config: portableAdapterConfig,
          },
          runtime: portableRuntimeConfig,
          permissions: portablePermissions,
          budgetMonthlyCents: (agent.budgetMonthlyCents ?? 0) > 0 ? agent.budgetMonthlyCents : undefined,
          metadata: (agent.metadata as Record<string, unknown> | null) ?? null,
        });
        if (isPlainRecord(extension) && agentEnvInputs.length > 0) {
          extension.inputs = {
            env: buildEnvInputMap(agentEnvInputs),
          };
        }
        paperclipAgentsOut[slug] = isPlainRecord(extension) ? extension : {};
      }
    }

    for (const project of selectedProjectRows) {
      const slug = projectSlugById.get(project.id)!;
      const projectPath = `projects/${slug}/PROJECT.md`;
      const envInputsStart = envInputs.length;
      const exportedEnvInputs = extractPortableProjectEnvInputs(slug, project.env, warnings);
      envInputs.push(...exportedEnvInputs);
      const projectEnvInputs = dedupeEnvInputs(
        envInputs
          .slice(envInputsStart)
          .filter((inputValue) => inputValue.projectSlug === slug),
      );
      const portableWorkspaces = await buildPortableProjectWorkspaces(slug, project.workspaces, warnings);
      projectWorkspaceKeyByProjectId.set(project.id, portableWorkspaces.workspaceKeyById);
      files[projectPath] = buildMarkdown(
        {
          name: project.name,
          description: project.description ?? null,
          owner: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        },
        project.description ?? "",
      );
      const extension = stripEmptyValues({
        leadAgentSlug: project.leadAgentId ? (idToSlug.get(project.leadAgentId) ?? null) : null,
        targetDate: project.targetDate ?? null,
        color: project.color ?? null,
        status: project.status,
        executionWorkspacePolicy: exportPortableProjectExecutionWorkspacePolicy(
          slug,
          project.executionWorkspacePolicy,
          portableWorkspaces.workspaceKeyById,
          warnings,
        ) ?? undefined,
        workspaces: portableWorkspaces.extension,
      });
      if (isPlainRecord(extension) && projectEnvInputs.length > 0) {
        extension.inputs = {
          env: buildEnvInputMap(projectEnvInputs),
        };
      }
      paperclipProjectsOut[slug] = isPlainRecord(extension) ? extension : {};
    }

    for (const issue of selectedIssueRows) {
      const taskSlug = taskSlugByIssueId.get(issue.id)!;
      const projectSlug = issue.projectId ? (projectSlugById.get(issue.projectId) ?? null) : null;
      // All tasks go in top-level tasks/ folder, never nested under projects/
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = issue.assigneeAgentId ? (idToSlug.get(issue.assigneeAgentId) ?? null) : null;
      const projectWorkspaceKey = issue.projectId && issue.projectWorkspaceId
        ? projectWorkspaceKeyByProjectId.get(issue.projectId)?.get(issue.projectWorkspaceId) ?? null
        : null;
      if (issue.projectWorkspaceId && !projectWorkspaceKey) {
        const aggregateKey = `${issue.projectId ?? "no-project"}:${issue.projectWorkspaceId}`;
        const existing = unportableTaskWorkspaceRefs.get(aggregateKey);
        if (existing) {
          existing.taskSlugs.push(taskSlug);
        } else {
          unportableTaskWorkspaceRefs.set(aggregateKey, {
            workspaceId: issue.projectWorkspaceId,
            taskSlugs: [taskSlug],
          });
        }
      }
      files[taskPath] = buildMarkdown(
        {
          name: issue.title,
          project: projectSlug,
          assignee: assigneeSlug,
        },
        issue.description ?? "",
      );
      const extension = stripEmptyValues({
        identifier: issue.identifier,
        status: issue.status,
        priority: issue.priority,
        labelIds: issue.labelIds ?? undefined,
        billingCode: issue.billingCode ?? null,
        projectWorkspaceKey: projectWorkspaceKey ?? undefined,
        executionWorkspaceSettings: issue.executionWorkspaceSettings ?? undefined,
        assigneeAdapterOverrides: issue.assigneeAdapterOverrides ?? undefined,
      });
      paperclipTasksOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    for (const { workspaceId, taskSlugs } of unportableTaskWorkspaceRefs.values()) {
      const preview = taskSlugs.slice(0, 4).join(", ");
      const remainder = taskSlugs.length > 4 ? ` and ${taskSlugs.length - 4} more` : "";
      warnings.push(`Tasks ${preview}${remainder} reference workspace ${workspaceId}, but that workspace could not be exported portably.`);
    }

    for (const routine of selectedRoutineRows) {
      const taskSlug = taskSlugByRoutineId.get(routine.id)!;
      const projectSlug = routine.projectId ? (projectSlugById.get(routine.projectId) ?? null) : null;
      const taskPath = `tasks/${taskSlug}/TASK.md`;
      const assigneeSlug = routine.assigneeAgentId ? (idToSlug.get(routine.assigneeAgentId) ?? null) : null;
      files[taskPath] = buildMarkdown(
        {
          name: routine.title,
          project: projectSlug,
          assignee: assigneeSlug,
          recurring: true,
        },
        routine.description ?? "",
      );
      const extension = stripEmptyValues({
        status: routine.status !== "active" ? routine.status : undefined,
        priority: routine.priority !== "medium" ? routine.priority : undefined,
        concurrencyPolicy: routine.concurrencyPolicy !== "coalesce_if_active" ? routine.concurrencyPolicy : undefined,
        catchUpPolicy: routine.catchUpPolicy !== "skip_missed" ? routine.catchUpPolicy : undefined,
        variables: (routine.variables ?? []).length > 0 ? routine.variables : undefined,
        triggers: routine.triggers.map((trigger) => stripEmptyValues({
          kind: trigger.kind,
          label: trigger.label ?? null,
          enabled: trigger.enabled ? undefined : false,
          cronExpression: trigger.kind === "schedule" ? trigger.cronExpression ?? null : undefined,
          timezone: trigger.kind === "schedule" ? trigger.timezone ?? null : undefined,
          signingMode: trigger.kind === "webhook" && trigger.signingMode !== "bearer" ? trigger.signingMode ?? null : undefined,
          replayWindowSec: trigger.kind === "webhook" && trigger.replayWindowSec !== 300
            ? trigger.replayWindowSec ?? null
            : undefined,
        })),
      });
      paperclipRoutinesOut[taskSlug] = isPlainRecord(extension) ? extension : {};
    }

    const paperclipExtensionPath = ".paperclip.yaml";
    const paperclipAgents = Object.fromEntries(
      Object.entries(paperclipAgentsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipProjects = Object.fromEntries(
      Object.entries(paperclipProjectsOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipTasks = Object.fromEntries(
      Object.entries(paperclipTasksOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    const paperclipRoutines = Object.fromEntries(
      Object.entries(paperclipRoutinesOut).filter(([, value]) => isPlainRecord(value) && Object.keys(value).length > 0),
    );
    files[paperclipExtensionPath] = buildYamlFile(
      {
        schema: "paperclip/v1",
        company: stripEmptyValues({
          brandColor: company.brandColor ?? null,
          logoPath: companyLogoPath,
          requireBoardApprovalForNewAgents: company.requireBoardApprovalForNewAgents ? undefined : false,
          feedbackDataSharingEnabled: company.feedbackDataSharingEnabled ? true : undefined,
          feedbackDataSharingConsentAt: company.feedbackDataSharingConsentAt?.toISOString() ?? null,
          feedbackDataSharingConsentByUserId: company.feedbackDataSharingConsentByUserId ?? null,
          feedbackDataSharingTermsVersion: company.feedbackDataSharingTermsVersion ?? null,
        }),
        sidebar: stripEmptyValues(sidebarOrder),
        agents: Object.keys(paperclipAgents).length > 0 ? paperclipAgents : undefined,
        projects: Object.keys(paperclipProjects).length > 0 ? paperclipProjects : undefined,
        tasks: Object.keys(paperclipTasks).length > 0 ? paperclipTasks : undefined,
        routines: Object.keys(paperclipRoutines).length > 0 ? paperclipRoutines : undefined,
      },
      { preserveEmptyStrings: true },
    );

    let finalFiles = filterExportFiles(files, input.selectedFiles, paperclipExtensionPath);
    let resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = {
      company: resolved.manifest.company !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      issues: resolved.manifest.issues.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    // Generate org chart PNG from manifest agents
    if (resolved.manifest.agents.length > 0) {
      try {
        const orgNodes = buildOrgTreeFromManifest(resolved.manifest.agents);
        const pngBuffer = await renderOrgChartPng(orgNodes);
        finalFiles["images/org-chart.png"] = bufferToPortableBinaryFile(pngBuffer, "image/png");
      } catch {
        // Non-fatal: export still works without the org chart image
      }
    }

    if (!input.selectedFiles || input.selectedFiles.some((entry) => normalizePortablePath(entry) === "README.md")) {
      finalFiles["README.md"] = generateReadme(resolved.manifest, {
        companyName: company.name,
        companyDescription: company.description ?? null,
      });
    }

    resolved = buildManifestFromPackageFiles(finalFiles, {
      sourceLabel: {
        companyId: company.id,
        companyName: company.name,
      },
    });
    resolved.manifest.includes = {
      company: resolved.manifest.company !== null,
      agents: resolved.manifest.agents.length > 0,
      projects: resolved.manifest.projects.length > 0,
      issues: resolved.manifest.issues.length > 0,
      skills: resolved.manifest.skills.length > 0,
    };
    resolved.manifest.envInputs = dedupeEnvInputs(envInputs);
    resolved.warnings.unshift(...warnings);

    return {
      rootPath,
      manifest: resolved.manifest,
      files: finalFiles,
      warnings: resolved.warnings,
      paperclipExtensionPath,
    };
  }

  async function previewExport(
    companyId: string,
    input: CompanyPortabilityExport,
  ): Promise<CompanyPortabilityExportPreviewResult> {
    const previewInput: CompanyPortabilityExport = {
      ...input,
      include: {
        ...input.include,
        issues:
          input.include?.issues
          ?? Boolean((input.issues && input.issues.length > 0) || (input.projectIssues && input.projectIssues.length > 0))
          ?? false,
      },
    };
    if (previewInput.include && previewInput.include.issues === undefined) {
      previewInput.include.issues = false;
    }
    const exported = await exportBundle(companyId, previewInput);
    return {
      ...exported,
      fileInventory: Object.keys(exported.files)
        .sort((left, right) => left.localeCompare(right))
        .map((filePath) => ({
          path: filePath,
          kind: classifyPortableFileKind(filePath),
        })),
      counts: {
        files: Object.keys(exported.files).length,
        agents: exported.manifest.agents.length,
        skills: exported.manifest.skills.length,
        projects: exported.manifest.projects.length,
        issues: exported.manifest.issues.length,
      },
    };
  }

  async function buildPreview(
    input: CompanyPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<ImportPlanInternal> {
    const mode = resolveImportMode(options);
    const requestedInclude = normalizeInclude(input.include);
    const source = applySelectedFilesToSource(await resolveSource(input.source), input.selectedFiles);
    const manifest = source.manifest;
    const include: CompanyPortabilityInclude = {
      company: requestedInclude.company && manifest.company !== null,
      agents: requestedInclude.agents && manifest.agents.length > 0,
      projects: requestedInclude.projects && manifest.projects.length > 0,
      issues: requestedInclude.issues && manifest.issues.length > 0,
      skills: requestedInclude.skills && manifest.skills.length > 0,
    };
    const collisionStrategy = input.collisionStrategy ?? DEFAULT_COLLISION_STRATEGY;
    if (mode === "agent_safe" && collisionStrategy === "replace") {
      throw unprocessable("Safe import routes do not allow replace collision strategy.");
    }
    const warnings = [...source.warnings];
    const errors: string[] = [];

    if (include.company && !manifest.company) {
      errors.push("Manifest does not include company metadata.");
    }

    const selectedSlugs = include.agents
      ? (
          input.agents && input.agents !== "all"
            ? Array.from(new Set(input.agents))
            : manifest.agents.map((agent) => agent.slug)
        )
      : [];

    const selectedAgents = include.agents
      ? manifest.agents.filter((agent) => selectedSlugs.includes(agent.slug))
      : [];
    const selectedMissing = selectedSlugs.filter((slug) => !manifest.agents.some((agent) => agent.slug === slug));
    for (const missing of selectedMissing) {
      errors.push(`Selected agent slug not found in manifest: ${missing}`);
    }

    if (include.agents && selectedAgents.length === 0) {
      warnings.push("No agents selected for import.");
    }

    const availableSkillKeys = new Set(source.manifest.skills.map((skill) => skill.key));
    const availableSkillSlugs = new Map<string, CompanyPortabilitySkillManifestEntry[]>();
    for (const skill of source.manifest.skills) {
      const existing = availableSkillSlugs.get(skill.slug) ?? [];
      existing.push(skill);
      availableSkillSlugs.set(skill.slug, existing);
    }

    for (const agent of selectedAgents) {
      const filePath = ensureMarkdownPath(agent.path);
      const markdown = readPortableTextFile(source.files, filePath);
      if (typeof markdown !== "string") {
        errors.push(`Missing markdown file for agent ${agent.slug}: ${filePath}`);
        continue;
      }
      const parsed = parseFrontmatterMarkdown(markdown);
      if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "agent") {
        warnings.push(`Agent markdown ${filePath} does not declare kind: agent in frontmatter.`);
      }
      for (const skillRef of agent.skills) {
        const slugMatches = availableSkillSlugs.get(skillRef) ?? [];
        if (!availableSkillKeys.has(skillRef) && slugMatches.length !== 1) {
          warnings.push(`Agent ${agent.slug} references skill ${skillRef}, but that skill is not present in the package.`);
        }
      }
    }

    if (include.projects) {
      for (const project of manifest.projects) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(project.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for project ${project.slug}: ${project.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "project") {
          warnings.push(`Project markdown ${project.path} does not declare kind: project in frontmatter.`);
        }
      }
    }

    if (include.issues) {
      const projectBySlug = new Map(manifest.projects.map((project) => [project.slug, project]));
      for (const issue of manifest.issues) {
        const markdown = readPortableTextFile(source.files, ensureMarkdownPath(issue.path));
        if (typeof markdown !== "string") {
          errors.push(`Missing markdown file for task ${issue.slug}: ${issue.path}`);
          continue;
        }
        const parsed = parseFrontmatterMarkdown(markdown);
        if (parsed.frontmatter.kind && parsed.frontmatter.kind !== "task") {
          warnings.push(`Task markdown ${issue.path} does not declare kind: task in frontmatter.`);
        }
        if (issue.projectWorkspaceKey) {
          const project = issue.projectSlug ? projectBySlug.get(issue.projectSlug) ?? null : null;
          if (!project) {
            warnings.push(`Task ${issue.slug} references workspace key ${issue.projectWorkspaceKey}, but its project is not present in the package.`);
          } else if (!project.workspaces.some((workspace) => workspace.key === issue.projectWorkspaceKey)) {
            warnings.push(`Task ${issue.slug} references missing project workspace key ${issue.projectWorkspaceKey}.`);
          }
        }
        if (issue.recurring) {
          if (!issue.projectSlug) {
            errors.push(`Recurring task ${issue.slug} must declare a project to import as a routine.`);
          }
          if (!issue.assigneeAgentSlug) {
            errors.push(`Recurring task ${issue.slug} must declare an assignee to import as a routine.`);
          }
          const resolvedRoutine = resolvePortableRoutineDefinition(issue, parsed.frontmatter.schedule);
          warnings.push(...resolvedRoutine.warnings);
          errors.push(...resolvedRoutine.errors);
        }
      }
    }

    for (const envInput of manifest.envInputs) {
      if (envInput.portability === "system_dependent") {
        const scope = envInput.agentSlug
          ? ` for agent ${envInput.agentSlug}`
          : envInput.projectSlug
            ? ` for project ${envInput.projectSlug}`
            : "";
        warnings.push(`Environment input ${envInput.key}${scope} is system-dependent and may need manual adjustment after import.`);
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
    const projectPlans: CompanyPortabilityPreviewResult["plan"]["projectPlans"] = [];
    const issuePlans: CompanyPortabilityPreviewResult["plan"]["issuePlans"] = [];
    const existingProjectSlugToProject = new Map<string, { id: string; name: string }>();
    const existingProjectSlugs = new Set<string>();

    if (input.target.mode === "existing_company") {
      const existingAgents = await agents.list(input.target.companyId);
      for (const existing of existingAgents) {
        const slug = normalizeAgentUrlKey(existing.name) ?? existing.id;
        if (!existingSlugToAgent.has(slug)) existingSlugToAgent.set(slug, existing);
        existingSlugs.add(slug);
      }
      const existingProjects = await projects.list(input.target.companyId);
      for (const existing of existingProjects) {
        if (!existingProjectSlugToProject.has(existing.urlKey)) {
          existingProjectSlugToProject.set(existing.urlKey, { id: existing.id, name: existing.name });
        }
        existingProjectSlugs.add(existing.urlKey);
      }

      const existingSkills = await companySkills.listFull(input.target.companyId);
      const existingSkillKeys = new Set(existingSkills.map((skill) => skill.key));
      const existingSkillSlugs = new Set(existingSkills.map((skill) => normalizeSkillSlug(skill.slug) ?? skill.slug));
      for (const skill of manifest.skills) {
        const skillSlug = normalizeSkillSlug(skill.slug) ?? skill.slug;
        if (existingSkillKeys.has(skill.key) || existingSkillSlugs.has(skillSlug)) {
          if (mode === "agent_safe") {
            warnings.push(`Existing skill "${skill.slug}" matched during safe import and will ${collisionStrategy === "skip" ? "be skipped" : "be renamed"} instead of overwritten.`);
          } else if (collisionStrategy === "replace") {
            warnings.push(`Existing skill "${skill.slug}" (${skill.key}) will be overwritten by import.`);
          }
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

      if (mode === "board_full" && collisionStrategy === "replace") {
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

    if (include.projects) {
      for (const manifestProject of manifest.projects) {
        const existing = existingProjectSlugToProject.get(manifestProject.slug) ?? null;
        if (!existing) {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "create",
            plannedName: manifestProject.name,
            existingProjectId: null,
            reason: null,
          });
          continue;
        }
        if (mode === "board_full" && collisionStrategy === "replace") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "update",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; replace strategy.",
          });
          continue;
        }
        if (collisionStrategy === "skip") {
          projectPlans.push({
            slug: manifestProject.slug,
            action: "skip",
            plannedName: existing.name,
            existingProjectId: existing.id,
            reason: "Existing slug matched; skip strategy.",
          });
          continue;
        }
        const renamed = uniqueProjectName(manifestProject.name, existingProjectSlugs);
        existingProjectSlugs.add(deriveProjectUrlKey(renamed, renamed));
        projectPlans.push({
          slug: manifestProject.slug,
          action: "create",
          plannedName: renamed,
          existingProjectId: existing.id,
          reason: "Existing slug matched; rename strategy.",
        });
      }
    }

    // Apply user-specified name overrides (keyed by slug)
    if (input.nameOverrides) {
      for (const ap of agentPlans) {
        const override = input.nameOverrides[ap.slug];
        if (override) {
          ap.plannedName = override;
        }
      }
      for (const pp of projectPlans) {
        const override = input.nameOverrides[pp.slug];
        if (override) {
          pp.plannedName = override;
        }
      }
      for (const ip of issuePlans) {
        const override = input.nameOverrides[ip.slug];
        if (override) {
          ip.plannedTitle = override;
        }
      }
    }

    // Warn about agents that will be overwritten/updated
    for (const ap of agentPlans) {
      if (ap.action === "update") {
        warnings.push(`Existing agent "${ap.plannedName}" (${ap.slug}) will be overwritten by import.`);
      }
    }

    // Warn about projects that will be overwritten/updated
    for (const pp of projectPlans) {
      if (pp.action === "update") {
        warnings.push(`Existing project "${pp.plannedName}" (${pp.slug}) will be overwritten by import.`);
      }
    }

    if (include.issues) {
      for (const manifestIssue of manifest.issues) {
        issuePlans.push({
          slug: manifestIssue.slug,
          action: "create",
          plannedTitle: manifestIssue.title,
          reason: manifestIssue.recurring ? "Recurring task will be imported as a routine." : null,
        });
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
          : include.company && mode === "board_full"
            ? "update"
            : "none",
        agentPlans,
        projectPlans,
        issuePlans,
      },
      manifest,
      files: source.files,
      envInputs: manifest.envInputs ?? [],
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

  async function previewImport(
    input: CompanyPortabilityPreview,
    options?: ImportBehaviorOptions,
  ): Promise<CompanyPortabilityPreviewResult> {
    const plan = await buildPreview(input, options);
    return plan.preview;
  }

  async function importBundle(
    input: CompanyPortabilityImport,
    actorUserId: string | null | undefined,
    options?: ImportBehaviorOptions,
  ): Promise<CompanyPortabilityImportResult> {
    const mode = resolveImportMode(options);
    const plan = await buildPreview(input, options);
    if (plan.preview.errors.length > 0) {
      throw unprocessable(`Import preview has errors: ${plan.preview.errors.join("; ")}`);
    }
    if (
      mode === "agent_safe"
      && (
        plan.preview.plan.companyAction === "update"
        || plan.preview.plan.agentPlans.some((entry) => entry.action === "update")
        || plan.preview.plan.projectPlans.some((entry) => entry.action === "update")
      )
    ) {
      throw unprocessable("Safe import routes only allow create or skip actions.");
    }

    const sourceManifest = plan.source.manifest;
    const warnings = [...plan.preview.warnings];
    const include = plan.include;

    let targetCompany: { id: string; name: string } | null = null;
    let companyAction: "created" | "updated" | "unchanged" = "unchanged";

    if (input.target.mode === "new_company") {
      if (mode === "agent_safe" && !options?.sourceCompanyId) {
        throw unprocessable("Safe new-company imports require a source company context.");
      }
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        const sourceMemberships = await access.listActiveUserMemberships(options.sourceCompanyId);
        if (sourceMemberships.length === 0) {
          throw unprocessable("Safe new-company import requires at least one active user membership on the source company.");
        }
      }
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
        feedbackDataSharingEnabled: include.company
          ? (sourceManifest.company?.feedbackDataSharingEnabled ?? false)
          : false,
        feedbackDataSharingConsentAt: include.company && sourceManifest.company?.feedbackDataSharingConsentAt
          ? new Date(sourceManifest.company.feedbackDataSharingConsentAt)
          : null,
        feedbackDataSharingConsentByUserId: include.company
          ? (sourceManifest.company?.feedbackDataSharingConsentByUserId ?? null)
          : null,
        feedbackDataSharingTermsVersion: include.company
          ? (sourceManifest.company?.feedbackDataSharingTermsVersion ?? null)
          : null,
      });
      if (mode === "agent_safe" && options?.sourceCompanyId) {
        await access.copyActiveUserMemberships(options.sourceCompanyId, created.id);
      } else {
        await access.ensureMembership(created.id, "user", actorUserId ?? "board", "owner", "active");
      }
      targetCompany = created;
      companyAction = "created";
    } else {
      targetCompany = await companies.getById(input.target.companyId);
      if (!targetCompany) throw notFound("Target company not found");
      if (include.company && sourceManifest.company && mode === "board_full") {
        const updated = await companies.update(targetCompany.id, {
          name: sourceManifest.company.name,
          description: sourceManifest.company.description,
          brandColor: sourceManifest.company.brandColor,
          requireBoardApprovalForNewAgents: sourceManifest.company.requireBoardApprovalForNewAgents,
          feedbackDataSharingEnabled: sourceManifest.company.feedbackDataSharingEnabled,
          feedbackDataSharingConsentAt: sourceManifest.company.feedbackDataSharingConsentAt
            ? new Date(sourceManifest.company.feedbackDataSharingConsentAt)
            : null,
          feedbackDataSharingConsentByUserId: sourceManifest.company.feedbackDataSharingConsentByUserId,
          feedbackDataSharingTermsVersion: sourceManifest.company.feedbackDataSharingTermsVersion,
        });
        targetCompany = updated ?? targetCompany;
        companyAction = "updated";
      }
    }

    if (!targetCompany) throw notFound("Target company not found");

    if (include.company) {
      const logoPath = sourceManifest.company?.logoPath ?? null;
      if (!logoPath) {
        const cleared = await companies.update(targetCompany.id, { logoAssetId: null });
        targetCompany = cleared ?? targetCompany;
      } else {
        const logoFile = plan.source.files[logoPath];
        if (!logoFile) {
          warnings.push(`Skipped company logo import because ${logoPath} is missing from the package.`);
        } else if (!storage) {
          warnings.push("Skipped company logo import because storage is unavailable.");
        } else {
          const contentType = isPortableBinaryFile(logoFile)
            ? (logoFile.contentType ?? inferContentTypeFromPath(logoPath))
            : inferContentTypeFromPath(logoPath);
          if (!contentType || !COMPANY_LOGO_CONTENT_TYPE_EXTENSIONS[contentType]) {
            warnings.push(`Skipped company logo import for ${logoPath} because the file type is unsupported.`);
          } else {
            try {
              const body = portableFileToBuffer(logoFile, logoPath);
              const stored = await storage.putFile({
                companyId: targetCompany.id,
                namespace: "assets/companies",
                originalFilename: path.posix.basename(logoPath),
                contentType,
                body,
              });
              const createdAsset = await assetRecords.create(targetCompany.id, {
                provider: stored.provider,
                objectKey: stored.objectKey,
                contentType: stored.contentType,
                byteSize: stored.byteSize,
                sha256: stored.sha256,
                originalFilename: stored.originalFilename,
                createdByAgentId: null,
                createdByUserId: actorUserId ?? null,
              });
              const updated = await companies.update(targetCompany.id, {
                logoAssetId: createdAsset.id,
              });
              targetCompany = updated ?? targetCompany;
            } catch (err) {
              warnings.push(`Failed to import company logo ${logoPath}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
    }

    const resultAgents: CompanyPortabilityImportResult["agents"] = [];
    const resultProjects: CompanyPortabilityImportResult["projects"] = [];
    const importedSlugToAgentId = new Map<string, string>();
    const existingSlugToAgentId = new Map<string, string>();
    const existingAgents = await agents.list(targetCompany.id);
    for (const existing of existingAgents) {
      existingSlugToAgentId.set(normalizeAgentUrlKey(existing.name) ?? existing.id, existing.id);
    }
    const importedSlugToProjectId = new Map<string, string>();
    const importedProjectWorkspaceIdByProjectSlug = new Map<string, Map<string, string>>();
    const existingProjectSlugToId = new Map<string, string>();
    const existingProjects = await projects.list(targetCompany.id);
    for (const existing of existingProjects) {
      existingProjectSlugToId.set(existing.urlKey, existing.id);
    }

    const importedSkills = include.skills || include.agents
      ? await companySkills.importPackageFiles(targetCompany.id, pickTextFiles(plan.source.files), {
          onConflict: resolveSkillConflictStrategy(mode, plan.collisionStrategy),
        })
      : [];
    const desiredSkillRefMap = new Map<string, string>();
    for (const importedSkill of importedSkills) {
      desiredSkillRefMap.set(importedSkill.originalKey, importedSkill.skill.key);
      desiredSkillRefMap.set(importedSkill.originalSlug, importedSkill.skill.key);
      if (importedSkill.action === "skipped") {
        warnings.push(`Skipped skill ${importedSkill.originalSlug}; existing skill ${importedSkill.skill.slug} was kept.`);
      } else if (importedSkill.originalKey !== importedSkill.skill.key) {
        warnings.push(`Imported skill ${importedSkill.originalSlug} as ${importedSkill.skill.slug} to avoid overwriting an existing skill.`);
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

        const bundlePrefix = `agents/${manifestAgent.slug}/`;
        const bundleFiles = Object.fromEntries(
          Object.entries(plan.source.files)
            .filter(([filePath]) => filePath.startsWith(bundlePrefix))
            .flatMap(([filePath, content]) => typeof content === "string"
              ? [[normalizePortablePath(filePath.slice(bundlePrefix.length)), content] as const]
              : []),
        );
        const markdownRaw = bundleFiles["AGENTS.md"] ?? readPortableTextFile(plan.source.files, manifestAgent.path);
        const entryRelativePath = normalizePortablePath(manifestAgent.path).startsWith(bundlePrefix)
          ? normalizePortablePath(manifestAgent.path).slice(bundlePrefix.length)
          : "AGENTS.md";
        if (typeof markdownRaw === "string") {
          const importedInstructionsBody = parseFrontmatterMarkdown(markdownRaw).body;
          bundleFiles[entryRelativePath] = importedInstructionsBody;
          if (entryRelativePath !== "AGENTS.md") {
            bundleFiles["AGENTS.md"] = importedInstructionsBody;
          }
        }
        const fallbackPromptTemplate = asString((manifestAgent.adapterConfig as Record<string, unknown>).promptTemplate) || "";
        if (!markdownRaw && fallbackPromptTemplate) {
          bundleFiles["AGENTS.md"] = fallbackPromptTemplate;
        }
        if (!markdownRaw && !fallbackPromptTemplate) {
          warnings.push(`Missing AGENTS markdown for ${manifestAgent.slug}; imported with an empty managed bundle.`);
        }

        // Apply adapter overrides from request if present
        const adapterOverride = input.adapterOverrides?.[planAgent.slug];
        const effectiveAdapterType = adapterOverride?.adapterType ?? manifestAgent.adapterType;
        const baseAdapterConfig = adapterOverride?.adapterConfig
          ? { ...adapterOverride.adapterConfig }
          : { ...manifestAgent.adapterConfig } as Record<string, unknown>;

        const desiredSkills = (manifestAgent.skills ?? []).map((skillRef) => desiredSkillRefMap.get(skillRef) ?? skillRef);
        const adapterConfigWithSkills = writePaperclipSkillSyncPreference(
          baseAdapterConfig,
          desiredSkills,
        );
        delete adapterConfigWithSkills.promptTemplate;
        delete adapterConfigWithSkills.bootstrapPromptTemplate; // deprecated
        delete adapterConfigWithSkills.instructionsFilePath;
        delete adapterConfigWithSkills.instructionsBundleMode;
        delete adapterConfigWithSkills.instructionsRootPath;
        delete adapterConfigWithSkills.instructionsEntryFile;
        const patch = {
          name: planAgent.plannedName,
          role: manifestAgent.role,
          title: manifestAgent.title,
          icon: manifestAgent.icon,
          capabilities: manifestAgent.capabilities,
          reportsTo: null,
          adapterType: effectiveAdapterType,
          adapterConfig: adapterConfigWithSkills,
          runtimeConfig: disableImportedTimerHeartbeat(manifestAgent.runtimeConfig),
          budgetMonthlyCents: manifestAgent.budgetMonthlyCents,
          permissions: manifestAgent.permissions,
          metadata: manifestAgent.metadata,
        };

        if (planAgent.action === "update" && planAgent.existingAgentId) {
          let updated = await agents.update(planAgent.existingAgentId, patch);
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
          try {
            const materialized = await instructions.materializeManagedBundle(updated, bundleFiles, {
              clearLegacyPromptTemplate: true,
              replaceExisting: true,
            });
            updated = await agents.update(updated.id, { adapterConfig: materialized.adapterConfig }) ?? updated;
          } catch (err) {
            warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
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

        let created = await agents.create(targetCompany.id, patch);
        await access.ensureMembership(targetCompany.id, "agent", created.id, "member", "active");
        await access.setPrincipalPermission(
          targetCompany.id,
          "agent",
          created.id,
          "tasks:assign",
          true,
          actorUserId ?? null,
        );
        try {
          const materialized = await instructions.materializeManagedBundle(created, bundleFiles, {
            clearLegacyPromptTemplate: true,
            replaceExisting: true,
          });
          created = await agents.update(created.id, { adapterConfig: materialized.adapterConfig }) ?? created;
        } catch (err) {
          warnings.push(`Failed to materialize instructions bundle for ${manifestAgent.slug}: ${err instanceof Error ? err.message : String(err)}`);
        }
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

    if (include.projects) {
      for (const planProject of plan.preview.plan.projectPlans) {
        const manifestProject = sourceManifest.projects.find((project) => project.slug === planProject.slug);
        if (!manifestProject) continue;
        if (planProject.action === "skip") {
          resultProjects.push({
            slug: planProject.slug,
            id: planProject.existingProjectId,
            action: "skipped",
            name: planProject.plannedName,
            reason: planProject.reason,
          });
          continue;
        }

        const projectLeadAgentId = manifestProject.leadAgentSlug
          ? importedSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? existingSlugToAgentId.get(manifestProject.leadAgentSlug)
            ?? null
          : null;
        const projectWorkspaceIdByKey = new Map<string, string>();
        const projectPatch = {
          name: planProject.plannedName,
          description: manifestProject.description,
          leadAgentId: projectLeadAgentId,
          targetDate: manifestProject.targetDate,
          color: manifestProject.color,
          status: manifestProject.status && PROJECT_STATUSES.includes(manifestProject.status as any)
            ? manifestProject.status as typeof PROJECT_STATUSES[number]
            : "backlog",
          env: manifestProject.env,
          executionWorkspacePolicy: stripPortableProjectExecutionWorkspaceRefs(manifestProject.executionWorkspacePolicy),
        };

        let projectId: string | null = null;
        if (planProject.action === "update" && planProject.existingProjectId) {
          const updated = await projects.update(planProject.existingProjectId, projectPatch);
          if (!updated) {
            warnings.push(`Skipped update for missing project ${planProject.existingProjectId}.`);
            resultProjects.push({
              slug: planProject.slug,
              id: null,
              action: "skipped",
              name: planProject.plannedName,
              reason: "Existing target project not found.",
            });
            continue;
          }
          projectId = updated.id;
          importedSlugToProjectId.set(planProject.slug, updated.id);
          existingProjectSlugToId.set(updated.urlKey, updated.id);
          resultProjects.push({
            slug: planProject.slug,
            id: updated.id,
            action: "updated",
            name: updated.name,
            reason: planProject.reason,
          });
        } else {
          const created = await projects.create(targetCompany.id, projectPatch);
          projectId = created.id;
          importedSlugToProjectId.set(planProject.slug, created.id);
          existingProjectSlugToId.set(created.urlKey, created.id);
          resultProjects.push({
            slug: planProject.slug,
            id: created.id,
            action: "created",
            name: created.name,
            reason: planProject.reason,
          });
        }

        if (!projectId) continue;

        for (const workspace of manifestProject.workspaces) {
          const createdWorkspace = await projects.createWorkspace(projectId, {
            name: workspace.name,
            sourceType: workspace.sourceType ?? undefined,
            repoUrl: workspace.repoUrl ?? undefined,
            repoRef: workspace.repoRef ?? undefined,
            defaultRef: workspace.defaultRef ?? undefined,
            visibility: workspace.visibility ?? undefined,
            setupCommand: workspace.setupCommand ?? undefined,
            cleanupCommand: workspace.cleanupCommand ?? undefined,
            metadata: workspace.metadata ?? undefined,
            isPrimary: workspace.isPrimary,
          });
          if (!createdWorkspace) {
            warnings.push(`Project ${planProject.slug} workspace ${workspace.key} could not be created during import.`);
            continue;
          }
          projectWorkspaceIdByKey.set(workspace.key, createdWorkspace.id);
        }
        importedProjectWorkspaceIdByProjectSlug.set(planProject.slug, projectWorkspaceIdByKey);

        const hydratedProjectExecutionWorkspacePolicy = importPortableProjectExecutionWorkspacePolicy(
          planProject.slug,
          manifestProject.executionWorkspacePolicy,
          projectWorkspaceIdByKey,
          warnings,
        );
        if (hydratedProjectExecutionWorkspacePolicy) {
          await projects.update(projectId, {
            executionWorkspacePolicy: hydratedProjectExecutionWorkspacePolicy,
          });
        }
      }
    }

    if (include.issues) {
      const routines = routineService(db);
      for (const manifestIssue of sourceManifest.issues) {
        const markdownRaw = readPortableTextFile(plan.source.files, manifestIssue.path);
        const parsed = markdownRaw ? parseFrontmatterMarkdown(markdownRaw) : null;
        const description = parsed?.body || manifestIssue.description || null;
        const assigneeAgentId = manifestIssue.assigneeAgentSlug
          ? importedSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? existingSlugToAgentId.get(manifestIssue.assigneeAgentSlug)
            ?? null
          : null;
        const projectId = manifestIssue.projectSlug
          ? importedSlugToProjectId.get(manifestIssue.projectSlug)
            ?? existingProjectSlugToId.get(manifestIssue.projectSlug)
            ?? null
          : null;
        const projectWorkspaceId = manifestIssue.projectSlug && manifestIssue.projectWorkspaceKey
          ? importedProjectWorkspaceIdByProjectSlug.get(manifestIssue.projectSlug)?.get(manifestIssue.projectWorkspaceKey) ?? null
          : null;
        if (manifestIssue.projectWorkspaceKey && !projectWorkspaceId) {
          warnings.push(`Task ${manifestIssue.slug} references workspace key ${manifestIssue.projectWorkspaceKey}, but that workspace was not imported.`);
        }
        if (manifestIssue.recurring) {
          if (!projectId || !assigneeAgentId) {
            throw unprocessable(`Recurring task ${manifestIssue.slug} is missing the project or assignee required to create a routine.`);
          }
          const resolvedRoutine = resolvePortableRoutineDefinition(manifestIssue, parsed?.frontmatter.schedule);
          if (resolvedRoutine.errors.length > 0) {
            throw unprocessable(`Recurring task ${manifestIssue.slug} could not be imported as a routine: ${resolvedRoutine.errors.join("; ")}`);
          }
          warnings.push(...resolvedRoutine.warnings);
          const routineDefinition = resolvedRoutine.routine ?? {
            concurrencyPolicy: null,
            catchUpPolicy: null,
            variables: null,
            triggers: [],
          };
          const createdRoutine = await routines.create(targetCompany.id, {
            projectId,
            goalId: null,
            parentIssueId: null,
            title: manifestIssue.title,
            description,
            assigneeAgentId,
            priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
              ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
              : "medium",
            status: manifestIssue.status && ROUTINE_STATUSES.includes(manifestIssue.status as any)
              ? manifestIssue.status as typeof ROUTINE_STATUSES[number]
              : "active",
            concurrencyPolicy:
              routineDefinition.concurrencyPolicy && ROUTINE_CONCURRENCY_POLICIES.includes(routineDefinition.concurrencyPolicy as any)
                ? routineDefinition.concurrencyPolicy as typeof ROUTINE_CONCURRENCY_POLICIES[number]
                : "coalesce_if_active",
            catchUpPolicy:
              routineDefinition.catchUpPolicy && ROUTINE_CATCH_UP_POLICIES.includes(routineDefinition.catchUpPolicy as any)
                ? routineDefinition.catchUpPolicy as typeof ROUTINE_CATCH_UP_POLICIES[number]
                : "skip_missed",
            variables: routineDefinition.variables ?? [],
            executionMode: "agent",
            scriptTimeoutSec: 60,
          }, {
            agentId: null,
            userId: actorUserId ?? null,
          });
          for (const trigger of routineDefinition.triggers) {
            if (trigger.kind === "schedule") {
              await routines.createTrigger(createdRoutine.id, {
                kind: "schedule",
                label: trigger.label,
                enabled: trigger.enabled,
                cronExpression: trigger.cronExpression!,
                timezone: trigger.timezone!,
              }, {
                agentId: null,
                userId: actorUserId ?? null,
              });
              continue;
            }
            if (trigger.kind === "webhook") {
              await routines.createTrigger(createdRoutine.id, {
                kind: "webhook",
                label: trigger.label,
                enabled: trigger.enabled,
                signingMode:
                  trigger.signingMode && ROUTINE_TRIGGER_SIGNING_MODES.includes(trigger.signingMode as any)
                    ? trigger.signingMode as typeof ROUTINE_TRIGGER_SIGNING_MODES[number]
                    : "bearer",
                replayWindowSec: trigger.replayWindowSec ?? 300,
              }, {
                agentId: null,
                userId: actorUserId ?? null,
              });
              continue;
            }
            await routines.createTrigger(createdRoutine.id, {
              kind: "api",
              label: trigger.label,
              enabled: trigger.enabled,
            }, {
              agentId: null,
              userId: actorUserId ?? null,
            });
          }
          continue;
        }
        await issues.create(targetCompany.id, {
          projectId,
          projectWorkspaceId,
          title: manifestIssue.title,
          description,
          assigneeAgentId,
          status: manifestIssue.status && ISSUE_STATUSES.includes(manifestIssue.status as any)
            ? manifestIssue.status as typeof ISSUE_STATUSES[number]
            : "backlog",
          priority: manifestIssue.priority && ISSUE_PRIORITIES.includes(manifestIssue.priority as any)
            ? manifestIssue.priority as typeof ISSUE_PRIORITIES[number]
            : "medium",
          billingCode: manifestIssue.billingCode,
          assigneeAdapterOverrides: manifestIssue.assigneeAdapterOverrides,
          executionWorkspaceSettings: manifestIssue.executionWorkspaceSettings,
          labelIds: [],
        });
      }
    }

    return {
      company: {
        id: targetCompany.id,
        name: targetCompany.name,
        action: companyAction,
      },
      agents: resultAgents,
      projects: resultProjects,
      envInputs: sourceManifest.envInputs ?? [],
      warnings,
    };
  }

  return {
    exportBundle,
    previewExport,
    previewImport,
    importBundle,
  };
}
