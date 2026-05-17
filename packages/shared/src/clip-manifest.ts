import { z } from "zod";
import type {
  CompanyPortabilityAgentManifestEntry,
  CompanyPortabilityFileEntry,
  CompanyPortabilityManifest,
  CompanyPortabilitySkillManifestEntry,
} from "./types/company-portability.js";

export const CLIP_MANIFEST_SCHEMA = "paperclip.clip/v1" as const;
export const CLIP_MANIFEST_VERSION = 1 as const;
export const CLIP_ARTIFACT_FORMAT = "agentcompanies" as const;
export const CLIP_ARTIFACT_VERSION = "agentcompanies/v1-draft" as const;

const SECRET_KEY_PATTERN = /(?:api[_-]?key|auth|authorization|bearer|cookie|credential|dsn|oauth|password|private[_-]?key|secret|signing[_-]?secret|token|webhook[_-]?secret)/i;
const LOCAL_PATH_PATTERN = /(?:^|["'\s])(?:\/Users\/|\/home\/|\/var\/folders\/|[A-Za-z]:\\)/;
const PRIVATE_URL_PATTERN = /\b(?:https?:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|[^/\s]+\.local|[^/\s]+\.internal|[^/\s]+\.test)(?::\d+)?(?:[/?#][^\s]*)?/i;
const SECRET_VALUE_PATTERN = /(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/;

export type ClipManifestType = "team" | "agent" | "skill" | "routine" | "bundle";
export type ClipManifestVisibility = "private_share" | "unlisted" | "public";
export type ClipReviewState = "unreviewed" | "automated_checked" | "security_reviewed" | "blocked";
export type ClipValidationStatus = "not_run" | "passed" | "failed" | "stale";
export type ClipRedactionOutcome = "allow" | "redact" | "summarize" | "omit";
export type ClipRuntimeFilesystem = "none" | "declared" | "broad";

export interface ClipManifestCreator {
  profileId: string | null;
  handle: string | null;
  displayName: string | null;
}

export interface ClipManifestClip {
  id: string;
  slug: string;
  type: ClipManifestType;
  revisionId: string;
  revisionNumber: number;
  manifestVersion: typeof CLIP_MANIFEST_VERSION;
  title: string;
  summary: string;
  visibility: ClipManifestVisibility;
  creator: ClipManifestCreator | null;
}

export interface ClipDependencyGraph {
  adapters: Array<{ type: string; required: boolean; sourceRefs: string[]; note: string | null }>;
  plugins: Array<{ key: string; requirement: "required" | "optional"; sourceRefs: string[]; note: string | null }>;
  skills: Array<{ key: string; slug: string; requirement: "required" | "optional"; sourceRefs: string[] }>;
  secrets: Array<{ key: string; kind: "secret"; requirement: "required" | "optional"; description: string | null; sourceRefs: string[] }>;
  permissions: Array<{ capability: string; reason: string | null; sourceRefs: string[] }>;
  runtime: {
    localShell: boolean;
    browser: boolean;
    filesystem: ClipRuntimeFilesystem;
    webhooks: boolean;
    recurringRoutines: boolean;
  };
  workspaces: Array<{ key: string; repoUrlRequired: boolean; pinnedRefRecommended: boolean; sourceRefs: string[] }>;
  budgetHints: {
    monthlyCents: number;
    sourceRefs: string[];
  };
}

export interface ClipRedactionReportEntry {
  path: string;
  outcome: ClipRedactionOutcome;
  reason: string;
}

export interface ClipRedactionReport {
  schema: "paperclip.clip.redaction/v1";
  generatedAt: string;
  entries: ClipRedactionReportEntry[];
  summary: {
    allowed: number;
    redacted: number;
    summarized: number;
    omitted: number;
  };
}

export interface ClipManifest {
  schema: typeof CLIP_MANIFEST_SCHEMA;
  clip: ClipManifestClip;
  publication: {
    source: {
      kind: "paperclip_company_object";
      objectType: ClipManifestType;
      exportedAt: string;
    };
    compatibility: {
      paperclip: string | null;
      manifest: typeof CLIP_ARTIFACT_VERSION;
    };
  };
  artifact: {
    format: typeof CLIP_ARTIFACT_FORMAT;
    version: typeof CLIP_ARTIFACT_VERSION;
    checksum: string;
    entrypoint: "COMPANY.md" | "TEAM.md" | "AGENTS.md" | "TASK.md" | "SKILL.md";
    paperclipExtension: ".paperclip.yaml";
    payload: {
      manifest: CompanyPortabilityManifest;
    };
  };
  dependencies: ClipDependencyGraph;
  security: {
    redactionReport: ClipRedactionReport;
    dangerousCapabilities: string[];
    routinePolicy: {
      importedTriggersEnabledByDefault: false;
      webhookSecretsRegenerated: true;
    };
    reviewState: ClipReviewState;
  };
  verification: {
    expectedFirstRun: Record<string, unknown> | null;
    sampleOutputs: Array<Record<string, unknown>>;
    validationStatus: ClipValidationStatus;
  };
  social: {
    sourceUrl: string | null;
    revisionUrl: string | null;
  };
  provenance: {
    publishedByProfileId: string | null;
    revisionPublishedAt: string;
    previousRevisionId: string | null;
  };
  checksums: {
    artifact: string;
    redactionReport: string;
    manifest: string;
  };
}

export interface ClipSnapshotBuilderInput {
  clip: {
    id?: string | null;
    slug: string;
    revisionNumber: number;
    title: string;
    summary: string;
    visibility?: ClipManifestVisibility | null;
    creator?: ClipManifestCreator | null;
    previousRevisionId?: string | null;
  };
  artifact: {
    manifest: CompanyPortabilityManifest;
    files?: Record<string, CompanyPortabilityFileEntry>;
  };
  source?: {
    exportedAt?: string | null;
    paperclipCompatibility?: string | null;
  } | null;
  social?: {
    sourceUrl?: string | null;
    revisionUrl?: string | null;
  } | null;
}

export interface ClipScopedSnapshotBuilderInput extends ClipSnapshotBuilderInput {
  agentSlug?: string;
  teamRootAgentSlug?: string;
  skillKey?: string;
  skillSlug?: string;
  routineSlug?: string;
}

export const clipTypeSchema = z.enum(["team", "agent", "skill", "routine", "bundle"]);
export const clipManifestCreatorSchema = z.object({
  profileId: z.string().min(1).nullable(),
  handle: z.string().min(1).nullable(),
  displayName: z.string().min(1).nullable(),
});

export const clipRedactionReportSchema = z.object({
  schema: z.literal("paperclip.clip.redaction/v1"),
  generatedAt: z.string().datetime(),
  entries: z.array(z.object({
    path: z.string().min(1),
    outcome: z.enum(["allow", "redact", "summarize", "omit"]),
    reason: z.string().min(1),
  })),
  summary: z.object({
    allowed: z.number().int().nonnegative(),
    redacted: z.number().int().nonnegative(),
    summarized: z.number().int().nonnegative(),
    omitted: z.number().int().nonnegative(),
  }),
});

export const clipDependencyGraphSchema = z.object({
  adapters: z.array(z.object({
    type: z.string().min(1),
    required: z.boolean(),
    sourceRefs: z.array(z.string().min(1)),
    note: z.string().nullable(),
  })),
  plugins: z.array(z.object({
    key: z.string().min(1),
    requirement: z.enum(["required", "optional"]),
    sourceRefs: z.array(z.string().min(1)),
    note: z.string().nullable(),
  })),
  skills: z.array(z.object({
    key: z.string().min(1),
    slug: z.string().min(1),
    requirement: z.enum(["required", "optional"]),
    sourceRefs: z.array(z.string().min(1)),
  })),
  secrets: z.array(z.object({
    key: z.string().min(1),
    kind: z.literal("secret"),
    requirement: z.enum(["required", "optional"]),
    description: z.string().nullable(),
    sourceRefs: z.array(z.string().min(1)),
  })),
  permissions: z.array(z.object({
    capability: z.string().min(1),
    reason: z.string().nullable(),
    sourceRefs: z.array(z.string().min(1)),
  })),
  runtime: z.object({
    localShell: z.boolean(),
    browser: z.boolean(),
    filesystem: z.enum(["none", "declared", "broad"]),
    webhooks: z.boolean(),
    recurringRoutines: z.boolean(),
  }),
  workspaces: z.array(z.object({
    key: z.string().min(1),
    repoUrlRequired: z.boolean(),
    pinnedRefRecommended: z.boolean(),
    sourceRefs: z.array(z.string().min(1)),
  })),
  budgetHints: z.object({
    monthlyCents: z.number().int().nonnegative(),
    sourceRefs: z.array(z.string().min(1)),
  }),
});

export const clipManifestSchema = z.object({
  schema: z.literal(CLIP_MANIFEST_SCHEMA),
  clip: z.object({
    id: z.string().min(1),
    slug: z.string().min(1),
    type: clipTypeSchema,
    revisionId: z.string().min(1),
    revisionNumber: z.number().int().positive(),
    manifestVersion: z.literal(CLIP_MANIFEST_VERSION),
    title: z.string().min(1),
    summary: z.string(),
    visibility: z.enum(["private_share", "unlisted", "public"]),
    creator: clipManifestCreatorSchema.nullable(),
  }),
  publication: z.object({
    source: z.object({
      kind: z.literal("paperclip_company_object"),
      objectType: clipTypeSchema,
      exportedAt: z.string().datetime(),
    }),
    compatibility: z.object({
      paperclip: z.string().nullable(),
      manifest: z.literal(CLIP_ARTIFACT_VERSION),
    }),
  }),
  artifact: z.object({
    format: z.literal(CLIP_ARTIFACT_FORMAT),
    version: z.literal(CLIP_ARTIFACT_VERSION),
    checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    entrypoint: z.enum(["COMPANY.md", "TEAM.md", "AGENTS.md", "TASK.md", "SKILL.md"]),
    paperclipExtension: z.literal(".paperclip.yaml"),
    payload: z.object({
      manifest: z.custom<CompanyPortabilityManifest>(),
    }),
  }),
  dependencies: clipDependencyGraphSchema,
  security: z.object({
    redactionReport: clipRedactionReportSchema,
    dangerousCapabilities: z.array(z.string().min(1)),
    routinePolicy: z.object({
      importedTriggersEnabledByDefault: z.literal(false),
      webhookSecretsRegenerated: z.literal(true),
    }),
    reviewState: z.enum(["unreviewed", "automated_checked", "security_reviewed", "blocked"]),
  }),
  verification: z.object({
    expectedFirstRun: z.record(z.string(), z.unknown()).nullable(),
    sampleOutputs: z.array(z.record(z.string(), z.unknown())),
    validationStatus: z.enum(["not_run", "passed", "failed", "stale"]),
  }),
  social: z.object({
    sourceUrl: z.string().url().nullable(),
    revisionUrl: z.string().url().nullable(),
  }),
  provenance: z.object({
    publishedByProfileId: z.string().min(1).nullable(),
    revisionPublishedAt: z.string().datetime(),
    previousRevisionId: z.string().min(1).nullable(),
  }),
  checksums: z.object({
    artifact: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    redactionReport: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    manifest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
});

export function buildBundleClipSnapshot(input: ClipSnapshotBuilderInput): ClipManifest {
  return buildClipSnapshot("bundle", input);
}

export function buildAgentClipSnapshot(input: ClipScopedSnapshotBuilderInput): ClipManifest {
  const agentSlug = input.agentSlug ?? input.artifact.manifest.agents[0]?.slug;
  const manifest = agentSlug ? scopeManifestToAgents(input.artifact.manifest, [agentSlug]) : input.artifact.manifest;
  return buildClipSnapshot("agent", { ...input, artifact: { ...input.artifact, manifest } });
}

export function buildTeamClipSnapshot(input: ClipScopedSnapshotBuilderInput): ClipManifest {
  const rootSlug = input.teamRootAgentSlug ?? input.agentSlug ?? input.artifact.manifest.agents.find((agent) => !agent.reportsToSlug)?.slug;
  const agentSlugs = rootSlug ? collectAgentSubtreeSlugs(input.artifact.manifest.agents, rootSlug) : [];
  const manifest = agentSlugs.length > 0 ? scopeManifestToAgents(input.artifact.manifest, agentSlugs) : input.artifact.manifest;
  return buildClipSnapshot("team", { ...input, artifact: { ...input.artifact, manifest } });
}

export function buildSkillClipSnapshot(input: ClipScopedSnapshotBuilderInput): ClipManifest {
  const manifest = cloneManifest(input.artifact.manifest);
  const skill = findSkill(manifest.skills, input.skillKey, input.skillSlug) ?? manifest.skills[0] ?? null;
  manifest.agents = [];
  manifest.projects = [];
  manifest.issues = [];
  manifest.skills = skill ? [skill] : [];
  manifest.includes = { company: false, agents: false, projects: false, issues: false, skills: manifest.skills.length > 0 };
  return buildClipSnapshot("skill", { ...input, artifact: { ...input.artifact, manifest } });
}

export function buildRoutineClipSnapshot(input: ClipScopedSnapshotBuilderInput): ClipManifest {
  const manifest = cloneManifest(input.artifact.manifest);
  const routine = manifest.issues.find((issue) => (
    issue.slug === input.routineSlug
    || issue.identifier === input.routineSlug
    || (!input.routineSlug && (issue.recurring || issue.routine))
  ));
  const assigneeSlug = routine?.assigneeAgentSlug ?? null;
  manifest.issues = routine ? [routine] : [];
  manifest.agents = assigneeSlug ? manifest.agents.filter((agent) => agent.slug === assigneeSlug) : [];
  manifest.projects = [];
  manifest.skills = filterSkillsForAgents(manifest.skills, manifest.agents);
  manifest.includes = {
    company: false,
    agents: manifest.agents.length > 0,
    projects: false,
    issues: manifest.issues.length > 0,
    skills: manifest.skills.length > 0,
  };
  return buildClipSnapshot("routine", { ...input, artifact: { ...input.artifact, manifest } });
}

export function buildClipSnapshot(type: ClipManifestType, input: ClipSnapshotBuilderInput): ClipManifest {
  const exportedAt = input.source?.exportedAt ?? new Date(0).toISOString();
  const sanitized = sanitizeManifest(input.artifact.manifest, exportedAt);
  const dependencyGraph = buildDependencyGraph(input.artifact.manifest);
  const dangerousCapabilities = buildDangerousCapabilities(dependencyGraph);
  const artifactChecksum = sha256Stable({
    manifest: sanitized.manifest,
    files: normalizeFilesForChecksum(input.artifact.files ?? {}),
  });
  const redactionReportChecksum = sha256Stable(sanitized.redactionReport);
  const revisionSeed = sha256Stable({
    schema: CLIP_MANIFEST_SCHEMA,
    slug: input.clip.slug,
    type,
    revisionNumber: input.clip.revisionNumber,
    artifactChecksum,
    redactionReportChecksum,
  });
  const revisionId = `cliprev_${revisionSeed.slice("sha256:".length, "sha256:".length + 16)}`;

  const withoutManifestChecksum: ClipManifest = {
    schema: CLIP_MANIFEST_SCHEMA,
    clip: {
      id: input.clip.id ?? `clip_${normalizeSlug(input.clip.slug)}`,
      slug: normalizeSlug(input.clip.slug),
      type,
      revisionId,
      revisionNumber: input.clip.revisionNumber,
      manifestVersion: CLIP_MANIFEST_VERSION,
      title: input.clip.title,
      summary: input.clip.summary,
      visibility: input.clip.visibility ?? "unlisted",
      creator: input.clip.creator ?? null,
    },
    publication: {
      source: {
        kind: "paperclip_company_object",
        objectType: type,
        exportedAt,
      },
      compatibility: {
        paperclip: input.source?.paperclipCompatibility ?? null,
        manifest: CLIP_ARTIFACT_VERSION,
      },
    },
    artifact: {
      format: CLIP_ARTIFACT_FORMAT,
      version: CLIP_ARTIFACT_VERSION,
      checksum: artifactChecksum,
      entrypoint: entrypointForClipType(type),
      paperclipExtension: ".paperclip.yaml",
      payload: {
        manifest: sanitized.manifest,
      },
    },
    dependencies: dependencyGraph,
    security: {
      redactionReport: sanitized.redactionReport,
      dangerousCapabilities,
      routinePolicy: {
        importedTriggersEnabledByDefault: false,
        webhookSecretsRegenerated: true,
      },
      reviewState: "unreviewed",
    },
    verification: {
      expectedFirstRun: null,
      sampleOutputs: [],
      validationStatus: "not_run",
    },
    social: {
      sourceUrl: input.social?.sourceUrl ?? null,
      revisionUrl: input.social?.revisionUrl ?? null,
    },
    provenance: {
      publishedByProfileId: input.clip.creator?.profileId ?? null,
      revisionPublishedAt: exportedAt,
      previousRevisionId: input.clip.previousRevisionId ?? null,
    },
    checksums: {
      artifact: artifactChecksum,
      redactionReport: redactionReportChecksum,
      manifest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  };

  const manifestChecksum = sha256Stable(withoutManifestChecksum);
  const result = {
    ...withoutManifestChecksum,
    checksums: {
      ...withoutManifestChecksum.checksums,
      manifest: manifestChecksum,
    },
  };
  clipManifestSchema.parse(result);
  return result;
}

function sanitizeManifest(source: CompanyPortabilityManifest, generatedAt: string) {
  const entries: ClipRedactionReportEntry[] = [];
  const manifest = cloneManifest(source);
  manifest.generatedAt = generatedAt;
  manifest.source = null;
  manifest.envInputs = manifest.envInputs.map((envInput, index) => {
    if (envInput.defaultValue !== null) {
      entries.push({
        path: `envInputs[${index}].defaultValue`,
        outcome: "omit",
        reason: "environment default values are not published in clip manifests",
      });
    }
    return {
      ...envInput,
      defaultValue: null,
      description: sanitizeText(envInput.description, `envInputs[${index}].description`, entries),
    };
  });
  manifest.company = manifest.company
    ? {
        ...manifest.company,
        name: sanitizeText(manifest.company.name, "company.name", entries) ?? manifest.company.name,
        description: sanitizeText(manifest.company.description, "company.description", entries),
      }
    : null;
  manifest.agents = manifest.agents.map((agent, index) => ({
    ...agent,
    capabilities: sanitizeText(agent.capabilities, `agents[${index}].capabilities`, entries),
    adapterConfig: sanitizeValue(agent.adapterConfig, `agents[${index}].adapterConfig`, entries) as Record<string, unknown>,
    runtimeConfig: sanitizeValue(agent.runtimeConfig, `agents[${index}].runtimeConfig`, entries) as Record<string, unknown>,
    permissions: sanitizeValue(agent.permissions, `agents[${index}].permissions`, entries) as Record<string, unknown>,
    metadata: sanitizeNullableRecord(agent.metadata, `agents[${index}].metadata`, entries),
  }));
  manifest.projects = manifest.projects.map((project, index) => ({
    ...project,
    description: sanitizeText(project.description, `projects[${index}].description`, entries),
    env: sanitizeValue(project.env, `projects[${index}].env`, entries) as typeof project.env,
    executionWorkspacePolicy: sanitizeNullableRecord(project.executionWorkspacePolicy, `projects[${index}].executionWorkspacePolicy`, entries),
    workspaces: project.workspaces.map((workspace, workspaceIndex) => ({
      ...workspace,
      repoUrl: shouldOmitString(workspace.repoUrl)
        ? recordOmission(`projects[${index}].workspaces[${workspaceIndex}].repoUrl`, "private workspace URLs are not published", entries)
        : workspace.repoUrl,
      setupCommand: sanitizeText(workspace.setupCommand, `projects[${index}].workspaces[${workspaceIndex}].setupCommand`, entries),
      cleanupCommand: sanitizeText(workspace.cleanupCommand, `projects[${index}].workspaces[${workspaceIndex}].cleanupCommand`, entries),
      metadata: sanitizeNullableRecord(workspace.metadata, `projects[${index}].workspaces[${workspaceIndex}].metadata`, entries),
    })),
    metadata: sanitizeNullableRecord(project.metadata, `projects[${index}].metadata`, entries),
  }));
  manifest.issues = manifest.issues.map((issue, index) => ({
    ...issue,
    description: sanitizeText(issue.description, `issues[${index}].description`, entries),
    routine: issue.routine
      ? {
          ...issue.routine,
          variables: issue.routine.variables?.map((variable, variableIndex) => (
            sanitizeValue(variable, `issues[${index}].routine.variables[${variableIndex}]`, entries)
          )) as typeof issue.routine.variables,
          triggers: issue.routine.triggers.map((trigger, triggerIndex) => ({
            ...trigger,
            enabled: false,
            signingMode: trigger.kind === "webhook" ? null : trigger.signingMode,
            replayWindowSec: trigger.kind === "webhook" ? null : trigger.replayWindowSec,
          })),
        }
      : null,
    executionWorkspaceSettings: sanitizeNullableRecord(issue.executionWorkspaceSettings, `issues[${index}].executionWorkspaceSettings`, entries),
    assigneeAdapterOverrides: sanitizeNullableRecord(issue.assigneeAdapterOverrides, `issues[${index}].assigneeAdapterOverrides`, entries),
    comments: [],
    metadata: sanitizeNullableRecord(issue.metadata, `issues[${index}].metadata`, entries),
  }));
  for (const [index, issue] of source.issues.entries()) {
    if (issue.comments.length > 0) {
      entries.push({
        path: `issues[${index}].comments`,
        outcome: "omit",
        reason: "raw issue comments are private source-company state",
      });
    }
    issue.routine?.triggers.forEach((trigger, triggerIndex) => {
      if (trigger.enabled) {
        entries.push({
          path: `issues[${index}].routine.triggers[${triggerIndex}].enabled`,
          outcome: "redact",
          reason: "imported routine triggers are disabled by default",
        });
      }
      if (trigger.kind === "webhook" && (trigger.signingMode || trigger.replayWindowSec !== null)) {
        entries.push({
          path: `issues[${index}].routine.triggers[${triggerIndex}]`,
          outcome: "omit",
          reason: "webhook signing details are regenerated on import",
        });
      }
    });
  }

  const redactionReport = buildRedactionReport(entries, generatedAt);
  return { manifest: sortManifest(manifest), redactionReport };
}

function buildDependencyGraph(manifest: CompanyPortabilityManifest): ClipDependencyGraph {
  const adapters = new Map<string, { type: string; required: boolean; sourceRefs: Set<string>; note: string | null }>();
  const plugins = new Map<string, { key: string; requirement: "required" | "optional"; sourceRefs: Set<string>; note: string | null }>();
  const skills = new Map<string, { key: string; slug: string; requirement: "required" | "optional"; sourceRefs: Set<string> }>();
  const secrets = new Map<string, { key: string; kind: "secret"; requirement: "required" | "optional"; description: string | null; sourceRefs: Set<string> }>();
  const permissions = new Map<string, { capability: string; reason: string | null; sourceRefs: Set<string> }>();
  const workspaces = new Map<string, { key: string; repoUrlRequired: boolean; pinnedRefRecommended: boolean; sourceRefs: Set<string> }>();
  const runtime = {
    localShell: false,
    browser: false,
    filesystem: "none" as ClipRuntimeFilesystem,
    webhooks: false,
    recurringRoutines: false,
  };
  let monthlyCents = 0;
  const budgetRefs = new Set<string>();

  for (const [index, agent] of manifest.agents.entries()) {
    const sourceRef = `agents.${agent.slug || index}`;
    addMapEntry(adapters, agent.adapterType, {
      type: agent.adapterType,
      required: true,
      sourceRefs: new Set([sourceRef]),
      note: null,
    });
    monthlyCents += agent.budgetMonthlyCents;
    if (agent.budgetMonthlyCents > 0) budgetRefs.add(sourceRef);
    for (const skillRef of agent.skills) {
      addSkill(skills, skillRef, skillRef, sourceRef);
    }
    for (const key of collectSecretKeys(agent.adapterConfig)) {
      addSecret(secrets, key, "optional", null, sourceRef);
    }
    for (const permission of collectPermissionCapabilities(agent.permissions)) {
      addPermission(permissions, permission, null, sourceRef);
    }
    if (agent.adapterType === "process" || hasAnyKey(agent.adapterConfig, ["command", "shell", "cwd"])) {
      runtime.localShell = true;
    }
    if (hasAnyKey(agent.permissions, ["browser", "browserAutomation"])) {
      runtime.browser = true;
    }
    if (hasAnyKey(agent.adapterConfig, ["cwd", "workspace", "filesystem", "path"])) {
      runtime.filesystem = "declared";
    }
  }

  for (const skill of manifest.skills) {
    addSkill(skills, skill.key, skill.slug, `skills.${skill.slug}`);
  }

  for (const [index, envInput] of manifest.envInputs.entries()) {
    if (envInput.kind === "secret") {
      addSecret(secrets, envInput.key, envInput.requirement, envInput.description, `envInputs.${index}`);
    }
  }

  for (const project of manifest.projects) {
    for (const key of collectSecretKeys(project.env)) {
      addSecret(secrets, key, "optional", null, `projects.${project.slug}.env`);
    }
    for (const workspace of project.workspaces) {
      addMapEntry(workspaces, workspace.key, {
        key: workspace.key,
        repoUrlRequired: Boolean(workspace.repoUrl),
        pinnedRefRecommended: Boolean(workspace.repoUrl && !workspace.repoRef),
        sourceRefs: new Set([`projects.${project.slug}.workspaces.${workspace.key}`]),
      });
    }
  }

  for (const issue of manifest.issues) {
    if (issue.recurring || issue.routine) {
      runtime.recurringRoutines = true;
    }
    if (issue.routine?.triggers.some((trigger) => trigger.kind === "webhook")) {
      runtime.webhooks = true;
      addPermission(permissions, "webhook.receive", "Routine has a webhook trigger placeholder.", `issues.${issue.slug}.routine`);
    }
    for (const trigger of issue.routine?.triggers ?? []) {
      if (trigger.kind === "schedule") {
        addPermission(permissions, "routine.schedule", "Routine has a recurring schedule.", `issues.${issue.slug}.routine`);
      }
    }
  }

  return {
    adapters: finalizeMap(adapters),
    plugins: finalizeMap(plugins),
    skills: finalizeMap(skills),
    secrets: finalizeMap(secrets),
    permissions: finalizeMap(permissions),
    runtime,
    workspaces: finalizeMap(workspaces),
    budgetHints: {
      monthlyCents,
      sourceRefs: Array.from(budgetRefs).sort(),
    },
  };
}

function buildDangerousCapabilities(graph: ClipDependencyGraph) {
  const capabilities = new Set<string>();
  if (graph.runtime.browser) capabilities.add("browser");
  if (graph.runtime.localShell) capabilities.add("shell");
  if (graph.runtime.filesystem !== "none") capabilities.add("filesystem");
  if (graph.runtime.webhooks) capabilities.add("webhook");
  if (graph.runtime.recurringRoutines) capabilities.add("recurring_routine");
  for (const permission of graph.permissions) {
    const root = permission.capability.split(".")[0];
    if (["calendar", "drive", "email", "filesystem", "github", "slack"].includes(root)) {
      capabilities.add(root);
    }
  }
  return Array.from(capabilities).sort();
}

function sanitizeValue(value: unknown, path: string, entries: ClipRedactionReportEntry[]): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return sanitizeText(value, path, entries);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, `${path}[${index}]`, entries));
  }
  const record = value as Record<string, unknown>;
  if (record.type === "secret_ref") {
    entries.push({ path, outcome: "omit", reason: "source secret references are replaced with setup inputs" });
    return { type: "secret_input" };
  }
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const childPath = `${path}.${key}`;
    const child = record[key];
    if (SECRET_KEY_PATTERN.test(key) && child !== null && child !== undefined) {
      entries.push({ path: childPath, outcome: "omit", reason: "secret-like fields are not published" });
      continue;
    }
    if (typeof child === "string" && shouldOmitString(child)) {
      entries.push({ path: childPath, outcome: "omit", reason: "private local paths, URLs, or credentials are not published" });
      continue;
    }
    next[key] = sanitizeValue(child, childPath, entries);
  }
  return next;
}

function sanitizeText(value: string | null, path: string, entries: ClipRedactionReportEntry[]) {
  if (value === null) return null;
  if (shouldOmitString(value)) {
    entries.push({ path, outcome: "redact", reason: "text contained private paths, URLs, or secret-looking values" });
    return "[redacted]";
  }
  return value;
}

function sanitizeNullableRecord(value: Record<string, unknown> | null, path: string, entries: ClipRedactionReportEntry[]) {
  return value === null ? null : sanitizeValue(value, path, entries) as Record<string, unknown>;
}

function shouldOmitString(value: string | null) {
  return Boolean(value && (SECRET_VALUE_PATTERN.test(value) || LOCAL_PATH_PATTERN.test(value) || PRIVATE_URL_PATTERN.test(value)));
}

function recordOmission(path: string, reason: string, entries: ClipRedactionReportEntry[]) {
  entries.push({ path, outcome: "omit", reason });
  return null;
}

function buildRedactionReport(entries: ClipRedactionReportEntry[], generatedAt: string): ClipRedactionReport {
  const sortedEntries = [...entries].sort((left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason));
  return {
    schema: "paperclip.clip.redaction/v1",
    generatedAt,
    entries: sortedEntries,
    summary: {
      allowed: 0,
      redacted: sortedEntries.filter((entry) => entry.outcome === "redact").length,
      summarized: sortedEntries.filter((entry) => entry.outcome === "summarize").length,
      omitted: sortedEntries.filter((entry) => entry.outcome === "omit").length,
    },
  };
}

function scopeManifestToAgents(source: CompanyPortabilityManifest, agentSlugs: string[]) {
  const selected = new Set(agentSlugs);
  const manifest = cloneManifest(source);
  manifest.agents = manifest.agents.filter((agent) => selected.has(agent.slug));
  manifest.skills = filterSkillsForAgents(manifest.skills, manifest.agents);
  manifest.projects = [];
  manifest.issues = manifest.issues.filter((issue) => issue.assigneeAgentSlug ? selected.has(issue.assigneeAgentSlug) : false);
  manifest.includes = {
    company: false,
    agents: manifest.agents.length > 0,
    projects: false,
    issues: manifest.issues.length > 0,
    skills: manifest.skills.length > 0,
  };
  return manifest;
}

function collectAgentSubtreeSlugs(agents: CompanyPortabilityAgentManifestEntry[], rootSlug: string) {
  const result = new Set<string>();
  const visit = (slug: string) => {
    if (result.has(slug)) return;
    result.add(slug);
    for (const child of agents.filter((agent) => agent.reportsToSlug === slug)) {
      visit(child.slug);
    }
  };
  visit(rootSlug);
  return Array.from(result).sort();
}

function filterSkillsForAgents(skills: CompanyPortabilitySkillManifestEntry[], agents: CompanyPortabilityAgentManifestEntry[]) {
  const refs = new Set(agents.flatMap((agent) => agent.skills));
  return skills.filter((skill) => refs.has(skill.key) || refs.has(skill.slug));
}

function findSkill(skills: CompanyPortabilitySkillManifestEntry[], key?: string, slug?: string) {
  return skills.find((skill) => (key && skill.key === key) || (slug && skill.slug === slug)) ?? null;
}

function sortManifest(manifest: CompanyPortabilityManifest): CompanyPortabilityManifest {
  return {
    ...manifest,
    agents: [...manifest.agents].sort(bySlug),
    skills: [...manifest.skills].sort((left, right) => left.key.localeCompare(right.key) || left.slug.localeCompare(right.slug)),
    projects: [...manifest.projects].sort(bySlug),
    issues: [...manifest.issues].sort(bySlug),
    envInputs: [...manifest.envInputs].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

function normalizeFilesForChecksum(files: Record<string, CompanyPortabilityFileEntry>) {
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function entrypointForClipType(type: ClipManifestType) {
  if (type === "agent") return "AGENTS.md";
  if (type === "skill") return "SKILL.md";
  if (type === "routine") return "TASK.md";
  if (type === "team") return "TEAM.md";
  return "COMPANY.md";
}

function collectSecretKeys(value: unknown): string[] {
  const keys = new Set<string>();
  const visit = (entry: unknown, keyHint: string | null) => {
    if (entry === null || entry === undefined) return;
    if (typeof entry !== "object") {
      if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) keys.add(keyHint);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item, keyHint));
      return;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === "secret_ref") {
      if (keyHint) keys.add(keyHint);
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (SECRET_KEY_PATTERN.test(key)) keys.add(key);
      visit(child, key);
    }
  };
  visit(value, null);
  return Array.from(keys).sort();
}

function collectPermissionCapabilities(value: unknown): string[] {
  const capabilities = new Set<string>();
  const visit = (entry: unknown, path: string[]) => {
    if (entry === null || entry === undefined) return;
    if (typeof entry === "boolean") {
      if (entry && path.length > 0) capabilities.add(path.join("."));
      return;
    }
    if (typeof entry === "string") {
      if (entry === "true" || entry === "allow" || entry === "write") capabilities.add(path.join("."));
      return;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) return;
    for (const [key, child] of Object.entries(entry as Record<string, unknown>)) {
      visit(child, [...path, key]);
    }
  };
  visit(value, []);
  return Array.from(capabilities).sort();
}

function hasAnyKey(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object") return false;
  const wanted = new Set(keys);
  const visit = (entry: unknown): boolean => {
    if (!entry || typeof entry !== "object") return false;
    if (Array.isArray(entry)) return entry.some(visit);
    return Object.entries(entry as Record<string, unknown>).some(([key, child]) => wanted.has(key) || visit(child));
  };
  return visit(value);
}

function addSecret(
  secrets: Map<string, { key: string; kind: "secret"; requirement: "required" | "optional"; description: string | null; sourceRefs: Set<string> }>,
  key: string,
  requirement: "required" | "optional",
  description: string | null,
  sourceRef: string,
) {
  addMapEntry(secrets, key, { key, kind: "secret", requirement, description, sourceRefs: new Set([sourceRef]) });
}

function addSkill(
  skills: Map<string, { key: string; slug: string; requirement: "required" | "optional"; sourceRefs: Set<string> }>,
  key: string,
  slug: string,
  sourceRef: string,
) {
  addMapEntry(skills, key, { key, slug, requirement: "required", sourceRefs: new Set([sourceRef]) });
}

function addPermission(
  permissions: Map<string, { capability: string; reason: string | null; sourceRefs: Set<string> }>,
  capability: string,
  reason: string | null,
  sourceRef: string,
) {
  addMapEntry(permissions, capability, { capability, reason, sourceRefs: new Set([sourceRef]) });
}

function addMapEntry<T extends { sourceRefs: Set<string> }>(map: Map<string, T>, key: string, value: T) {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, value);
    return;
  }
  for (const sourceRef of value.sourceRefs) {
    existing.sourceRefs.add(sourceRef);
  }
}

function finalizeMap<T extends { sourceRefs: Set<string> }>(map: Map<string, T>) {
  return Array.from(map.values())
    .map((entry) => ({ ...entry, sourceRefs: Array.from(entry.sourceRefs).sort() }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}

function bySlug<T extends { slug: string }>(left: T, right: T) {
  return left.slug.localeCompare(right.slug);
}

function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "clip";
}

function cloneManifest(manifest: CompanyPortabilityManifest): CompanyPortabilityManifest {
  return JSON.parse(JSON.stringify(manifest)) as CompanyPortabilityManifest;
}

function sha256Stable(value: unknown) {
  return `sha256:${sha256Hex(stableStringify(value))}`;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const bitLengthHigh = Math.floor((bytes.length * 8) / 0x100000000);
  const bitLengthLow = (bytes.length * 8) >>> 0;
  const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  padded[paddedLength - 8] = bitLengthHigh >>> 24;
  padded[paddedLength - 7] = bitLengthHigh >>> 16;
  padded[paddedLength - 6] = bitLengthHigh >>> 8;
  padded[paddedLength - 5] = bitLengthHigh;
  padded[paddedLength - 4] = bitLengthLow >>> 24;
  padded[paddedLength - 3] = bitLengthLow >>> 16;
  padded[paddedLength - 2] = bitLengthLow >>> 8;
  padded[paddedLength - 1] = bitLengthLow;

  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] =
        ((padded[wordOffset] << 24) |
          (padded[wordOffset + 1] << 16) |
          (padded[wordOffset + 2] << 8) |
          padded[wordOffset + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[index] + words[index]) >>> 0;
      const s0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, bits: number) {
  return (value >>> bits) | (value << (32 - bits));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
