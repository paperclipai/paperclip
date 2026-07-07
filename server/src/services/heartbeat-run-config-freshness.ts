import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ExecutionWorkspaceConfig } from "@paperclipai/shared";
import { parseObject, asNumber } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import type { WorkspaceOperationRecorder } from "./workspace-operations.js";
import {
  createEffectiveRunConfigFingerprints,
  createEffectiveRunConfigSubcategoryFingerprints,
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
  type EffectiveRunConfigFingerprints,
  type EffectiveRunConfigSecretManifestEntry,
} from "./effective-run-config-fingerprints.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const SESSION_CONFIGURED_MODEL_KEY = "__paperclipConfiguredModel";
const SESSION_CONFIG_FINGERPRINT_KEY = "__paperclipConfigFingerprint";
const SESSION_CONFIG_FINGERPRINT_VERSION_KEY = "__paperclipConfigFingerprintVersion";
const SESSION_CONFIG_CATEGORIES_KEY = "__paperclipConfigCategories";
const SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY = "__paperclipConfigCategoryFingerprints";
const PAPERCLIP_SESSION_METADATA_KEYS = new Set([
  SESSION_CONFIGURED_MODEL_KEY,
  SESSION_CONFIG_FINGERPRINT_KEY,
  SESSION_CONFIG_FINGERPRINT_VERSION_KEY,
  SESSION_CONFIG_CATEGORIES_KEY,
  SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY,
]);
export const WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY = "configFingerprint";
const EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES = [
  "adapter",
  "adapterConfig",
  "agentRuntimeConfig",
  "modelProfile",
  "instructions",
  "issueOverrides",
  "workspaceConfig",
  "environment",
  "envBindings",
  "secrets",
  "runtimeSkills",
] as const;
const EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES = [
  "mode",
  "projectWorkspace",
  "strategy",
  "repo",
  "lifecycleCommands",
  "runtimeServices",
  "environment",
  "realization",
] as const;

type EffectiveRunSessionConfigCategory = (typeof EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES)[number];
type EffectiveRunWorkspaceConfigCategory = (typeof EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES)[number];

type EffectiveRunSessionConfigMetadata = {
  version: typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION;
  fingerprint: string;
  categories: EffectiveRunSessionConfigCategory[];
  categoryFingerprints: Record<EffectiveRunSessionConfigCategory, string>;
  fingerprints: EffectiveRunConfigFingerprints;
};

type TaskSessionConfigFreshnessDecision = {
  reset: boolean;
  reasons: string[];
  changedCategories: EffectiveRunSessionConfigCategory[];
  storedFingerprint: string | null;
  nextFingerprint: string | null;
};

export type EffectiveRunWorkspaceConfigMetadata = {
  version: typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION;
  fingerprint: string;
  categories: EffectiveRunWorkspaceConfigCategory[];
  categoryFingerprints: Record<EffectiveRunWorkspaceConfigCategory, string>;
  fingerprints: EffectiveRunConfigFingerprints;
  evaluatedAt: string;
};

type WorkspaceConfigFreshnessDecisionAction = "create" | "reuse" | "refresh" | "replace";

export type ExecutionWorkspaceConfigFreshnessDecision = {
  action: WorkspaceConfigFreshnessDecisionAction;
  shouldReuseExisting: boolean;
  shouldRefreshConfigSnapshot: boolean;
  reasons: string[];
  changedCategories: EffectiveRunWorkspaceConfigCategory[];
  storedFingerprint: string | null;
  inferredFingerprint: string | null;
  nextFingerprint: string | null;
  storedFingerprintPresent: boolean;
};

type WorkspaceConfigFreshnessOperationInput = {
  decision: ExecutionWorkspaceConfigFreshnessDecision;
  hasExistingWorkspace: boolean;
  reuseRequested: boolean;
  workspaceReused: boolean;
  configSnapshotRefreshed: boolean;
  previousWorkspaceId: string | null;
  activeWorkspaceId: string | null;
};

const EFFECTIVE_RUN_SESSION_CONFIG_CATEGORY_LABELS: Record<EffectiveRunSessionConfigCategory, string> = {
  adapter: "adapter",
  adapterConfig: "adapter config",
  agentRuntimeConfig: "agent runtime config",
  modelProfile: "model profile",
  instructions: "instructions",
  issueOverrides: "issue overrides",
  workspaceConfig: "workspace config",
  environment: "environment",
  envBindings: "env bindings",
  secrets: "secrets",
  runtimeSkills: "runtime skills",
};
const EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORY_LABELS: Record<EffectiveRunWorkspaceConfigCategory, string> = {
  mode: "workspace mode",
  projectWorkspace: "project workspace",
  strategy: "workspace strategy",
  repo: "repo/base ref",
  lifecycleCommands: "workspace lifecycle commands",
  runtimeServices: "runtime services",
  environment: "environment",
  realization: "workspace realization",
};
const WORKSPACE_REPLACEMENT_CONFIG_CATEGORIES = new Set<EffectiveRunWorkspaceConfigCategory>([
  "mode",
  "projectWorkspace",
  "strategy",
  "repo",
  "environment",
  "realization",
]);

function parseStoredConfigCategoryFingerprints(value: unknown) {
  const parsed = parseObject(value);
  const out: Partial<Record<EffectiveRunSessionConfigCategory, string>> = {};
  for (const category of EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES) {
    const fingerprint = readNonEmptyString(parsed[category]);
    if (fingerprint) out[category] = fingerprint;
  }
  return out;
}

function readConfigCategoriesFromSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
) {
  const rawCategories = Array.isArray(sessionParams?.[SESSION_CONFIG_CATEGORIES_KEY])
    ? sessionParams?.[SESSION_CONFIG_CATEGORIES_KEY]
    : [];
  return rawCategories.filter(
    (category): category is EffectiveRunSessionConfigCategory =>
      typeof category === "string" &&
      (EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES as readonly string[]).includes(category),
  );
}

function readConfigFingerprintFromSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
) {
  if (!sessionParams) return null;
  const fingerprint = readNonEmptyString(sessionParams[SESSION_CONFIG_FINGERPRINT_KEY]);
  const version = asNumber(sessionParams[SESSION_CONFIG_FINGERPRINT_VERSION_KEY], 0);
  if (!fingerprint || version <= 0) return null;
  return {
    fingerprint,
    version,
    categories: readConfigCategoriesFromSessionParams(sessionParams),
    categoryFingerprints: parseStoredConfigCategoryFingerprints(
      sessionParams[SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY],
    ),
  };
}

function describeEffectiveRunConfigCategories(categories: readonly EffectiveRunSessionConfigCategory[]) {
  return categories.map((category) => EFFECTIVE_RUN_SESSION_CONFIG_CATEGORY_LABELS[category]).join(", ");
}

function changedEffectiveRunSessionConfigCategories(input: {
  previous: Partial<Record<EffectiveRunSessionConfigCategory, string>>;
  next: Record<EffectiveRunSessionConfigCategory, string>;
}) {
  const changed = EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES.filter(
    (category) => input.previous[category] !== input.next[category],
  );
  return changed.length > 0 ? changed : [...EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES];
}

function parseStoredWorkspaceConfigCategoryFingerprints(value: unknown) {
  const parsed = parseObject(value);
  const out: Partial<Record<EffectiveRunWorkspaceConfigCategory, string>> = {};
  for (const category of EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES) {
    const fingerprint = readNonEmptyString(parsed[category]);
    if (fingerprint) out[category] = fingerprint;
  }
  return out;
}

function readWorkspaceConfigCategoriesFromMetadata(value: unknown) {
  const rawCategories = Array.isArray(value) ? value : [];
  return rawCategories.filter(
    (category): category is EffectiveRunWorkspaceConfigCategory =>
      typeof category === "string" &&
      (EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES as readonly string[]).includes(category),
  );
}

function readWorkspaceConfigFingerprintFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  const raw = parseObject(metadata?.[WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY]);
  const fingerprint = readNonEmptyString(raw.workspaceHash) ?? readNonEmptyString(raw.fingerprint);
  const version = asNumber(raw.version, 0);
  if (!fingerprint || version <= 0) return null;
  return {
    fingerprint,
    version,
    categories: readWorkspaceConfigCategoriesFromMetadata(raw.categories),
    categoryFingerprints: parseStoredWorkspaceConfigCategoryFingerprints(raw.categoryFingerprints),
  };
}

function describeEffectiveRunWorkspaceConfigCategories(
  categories: readonly EffectiveRunWorkspaceConfigCategory[],
) {
  return categories.map((category) => EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORY_LABELS[category]).join(", ");
}

function changedEffectiveRunWorkspaceConfigCategories(input: {
  previous: Partial<Record<EffectiveRunWorkspaceConfigCategory, string>>;
  next: Record<EffectiveRunWorkspaceConfigCategory, string>;
}) {
  const changed = EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES.filter(
    (category) => input.previous[category] !== input.next[category],
  );
  return changed.length > 0 ? changed : [...EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES];
}

function workspaceConfigFreshnessActionLabel(action: WorkspaceConfigFreshnessDecisionAction) {
  switch (action) {
    case "refresh":
      return "refreshed execution workspace config";
    case "replace":
      return "replaced execution workspace";
    case "reuse":
      return "updated execution workspace freshness metadata";
    case "create":
      return "created execution workspace";
  }
}

export function buildWorkspaceConfigFreshnessOperation(input: WorkspaceConfigFreshnessOperationInput) {
  if (!input.reuseRequested || !input.hasExistingWorkspace || input.decision.reasons.length === 0) {
    return null;
  }

  const changedCategoryLabels = input.decision.changedCategories.map(
    (category) => EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORY_LABELS[category],
  );
  const categorySummary =
    changedCategoryLabels.length > 0 ? ` (${changedCategoryLabels.join(", ")})` : "";
  const reasonSummary = input.decision.reasons.join("; ");

  return {
    metadata: {
      kind: "config_freshness",
      action: input.decision.action,
      changedCategories: input.decision.changedCategories,
      changedCategoryLabels,
      reasons: input.decision.reasons,
      reuseRequested: input.reuseRequested,
      workspaceReused: input.workspaceReused,
      configSnapshotRefreshed: input.configSnapshotRefreshed,
      storedFingerprintPresent: input.decision.storedFingerprintPresent,
      previousWorkspaceId: input.previousWorkspaceId,
      activeWorkspaceId: input.activeWorkspaceId,
    },
    system:
      `[paperclip] ${workspaceConfigFreshnessActionLabel(input.decision.action)} after config freshness check${categorySummary}: ${reasonSummary}\n`,
  };
}

export async function recordWorkspaceConfigFreshnessOperation(input: WorkspaceConfigFreshnessOperationInput & {
  recorder: WorkspaceOperationRecorder;
  runId: string;
}) {
  const operation = buildWorkspaceConfigFreshnessOperation(input);
  if (!operation) return;

  try {
    await input.recorder.recordOperation({
      phase: "workspace_config_freshness",
      metadata: operation.metadata,
      run: async () => ({
        status: "succeeded",
        system: operation.system,
      }),
    });
  } catch (error) {
    logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
        runId: input.runId,
        previousWorkspaceId: input.previousWorkspaceId,
        activeWorkspaceId: input.activeWorkspaceId,
        action: input.decision.action,
      },
      "failed to record workspace config freshness operation",
    );
  }
}

function sanitizeSecretManifestForConfigFingerprint(
  manifest: readonly EffectiveRunConfigSecretManifestEntry[],
) {
  return manifest.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      configPath: readNonEmptyString(record.configPath) ?? "",
      envKey: readNonEmptyString(record.envKey),
      secretId: readNonEmptyString(record.secretId) ?? "",
      bindingId: readNonEmptyString(record.bindingId),
      version: typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : readNonEmptyString(record.version),
      provider: readNonEmptyString(record.provider),
      providerVersionRef: readNonEmptyString(record.providerVersionRef),
      outcome: record.outcome === "success" || record.outcome === "failure" ? record.outcome : null,
    };
  });
}

async function hashFileContentsForConfigFingerprint(filePath: string) {
  const contents = await fs.readFile(filePath);
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function isPathInsideRoot(input: { rootPath: string; filePath: string }) {
  const relative = path.relative(input.rootPath, input.filePath);
  return relative === "" || (
    relative.length > 0
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
  );
}

function resolveRootBoundInstructionsFingerprintPath(input: {
  instructionsFilePath: string | null;
  instructionsRootPath: string | null;
  instructionsEntryFile: string | null;
}): { filePath: string; skippedReason: null } | { filePath: null; skippedReason: string | null } {
  if (!input.instructionsRootPath || !path.isAbsolute(input.instructionsRootPath)) {
    return {
      filePath: null,
      skippedReason: input.instructionsFilePath ? "missing_absolute_root" : null,
    };
  }

  const rootPath = path.resolve(input.instructionsRootPath);
  const candidatePath = input.instructionsEntryFile ?? input.instructionsFilePath;
  if (!candidatePath) return { filePath: null, skippedReason: "missing_entry_file" };

  const resolvedPath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(rootPath, candidatePath);

  if (!isPathInsideRoot({ rootPath, filePath: resolvedPath })) {
    return { filePath: null, skippedReason: "outside_root" };
  }

  return { filePath: resolvedPath, skippedReason: null };
}

async function resolveInstructionsConfigFingerprintMetadata(config: Record<string, unknown>) {
  const instructionsFilePath = readNonEmptyString(config.instructionsFilePath);
  const instructionsRootPath = readNonEmptyString(config.instructionsRootPath);
  const instructionsEntryFile = readNonEmptyString(config.instructionsEntryFile);
  const resolved = resolveRootBoundInstructionsFingerprintPath({
    instructionsFilePath,
    instructionsRootPath,
    instructionsEntryFile,
  });
  const configuredPath = resolved.filePath ?? instructionsFilePath ?? (
    instructionsRootPath && instructionsEntryFile
      ? path.resolve(instructionsRootPath, instructionsEntryFile)
      : null
  );
  if (!configuredPath && !instructionsRootPath && !instructionsEntryFile) return null;

  const metadata: Record<string, unknown> = {
    configured: true,
    bundleMode: readNonEmptyString(config.instructionsBundleMode),
    entryFile: instructionsEntryFile,
    pathKind: configuredPath ? (path.isAbsolute(configuredPath) ? "absolute" : "relative") : null,
    readPolicy: "root_bound",
  };
  if (resolved.skippedReason) metadata.readSkippedReason = resolved.skippedReason;
  if (resolved.filePath) {
    try {
      metadata.contentHash = await hashFileContentsForConfigFingerprint(resolved.filePath);
      metadata.readable = true;
    } catch {
      metadata.readable = false;
    }
  }
  return metadata;
}

function buildSessionConfigCategoryValues(input: {
  adapterType: string;
  effectiveAdapterConfig: Record<string, unknown>;
  agentRuntimeConfig: unknown;
  modelProfile: unknown;
  instructions: unknown;
  issueOverrides: unknown;
  workspaceConfig: unknown;
  environment: unknown;
  environmentEnv: unknown;
  projectEnv: unknown;
  routineEnv: unknown;
  secretManifest: readonly EffectiveRunConfigSecretManifestEntry[];
  runtimeSkills: unknown;
  agentConfigRevision: unknown;
}) {
  const sanitizedSecretManifest = sanitizeSecretManifestForConfigFingerprint(input.secretManifest);
  return {
    adapter: {
      adapterType: input.adapterType,
      agentConfigRevision: input.agentConfigRevision,
    },
    adapterConfig: input.effectiveAdapterConfig,
    agentRuntimeConfig: input.agentRuntimeConfig,
    modelProfile: input.modelProfile,
    instructions: input.instructions,
    issueOverrides: input.issueOverrides,
    workspaceConfig: input.workspaceConfig,
    environment: input.environment,
    envBindings: {
      environment: { env: input.environmentEnv },
      project: { env: input.projectEnv },
      routine: { env: input.routineEnv },
    },
    secrets: sanitizedSecretManifest,
    runtimeSkills: input.runtimeSkills,
  } satisfies Record<EffectiveRunSessionConfigCategory, unknown>;
}

export async function buildEffectiveRunSessionConfigMetadata(input: {
  adapterType: string;
  effectiveAdapterConfig: Record<string, unknown>;
  agentRuntimeConfig: unknown;
  modelProfile: unknown;
  issueOverrides: unknown;
  workspaceConfig: unknown;
  environment: unknown;
  environmentEnv: unknown;
  projectEnv: unknown;
  routineEnv: unknown;
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
  runtimeSkills: unknown;
  agentConfigRevision?: unknown;
}): Promise<EffectiveRunSessionConfigMetadata> {
  const secretManifest = input.secretManifest ?? [];
  const instructions = await resolveInstructionsConfigFingerprintMetadata(input.effectiveAdapterConfig);
  const categoryValues = buildSessionConfigCategoryValues({
    adapterType: input.adapterType,
    effectiveAdapterConfig: input.effectiveAdapterConfig,
    agentRuntimeConfig: input.agentRuntimeConfig,
    modelProfile: input.modelProfile,
    instructions,
    issueOverrides: input.issueOverrides,
    workspaceConfig: input.workspaceConfig,
    environment: input.environment,
    environmentEnv: input.environmentEnv,
    projectEnv: input.projectEnv,
    routineEnv: input.routineEnv,
    secretManifest,
    runtimeSkills: input.runtimeSkills,
    agentConfigRevision: input.agentConfigRevision ?? null,
  });
  const fingerprints = createEffectiveRunConfigFingerprints({
    session: categoryValues,
    secretManifest,
  });
  const categoryFingerprints = createEffectiveRunConfigSubcategoryFingerprints({
    category: "session",
    value: categoryValues,
    subcategories: EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES,
    secretManifest,
  });
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    fingerprint: fingerprints.sessionFingerprint.fingerprint,
    categories: [...EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES],
    categoryFingerprints,
    fingerprints,
  };
}

function buildWorkspaceConfigCategoryValues(input: {
  mode: unknown;
  projectId: unknown;
  projectWorkspaceId: unknown;
  strategyType: unknown;
  workspaceStrategy: unknown;
  repoUrl: unknown;
  repoRef: unknown;
  branchName: unknown;
  configSnapshot: Partial<ExecutionWorkspaceConfig> | null;
  environment: unknown;
  realization: unknown;
}) {
  const snapshot = input.configSnapshot ?? {};
  return {
    mode: {
      mode: input.mode ?? null,
    },
    projectWorkspace: {
      projectId: input.projectId ?? null,
      projectWorkspaceId: input.projectWorkspaceId ?? null,
    },
    strategy: {
      strategyType: input.strategyType ?? null,
      workspaceStrategy: input.workspaceStrategy ?? null,
    },
    repo: {
      repoUrl: input.repoUrl ?? null,
      repoRef: input.repoRef ?? null,
      branchName: input.branchName ?? null,
    },
    lifecycleCommands: {
      provisionCommand: snapshot.provisionCommand ?? null,
      teardownCommand: snapshot.teardownCommand ?? null,
      cleanupCommand: snapshot.cleanupCommand ?? null,
    },
    runtimeServices: {
      workspaceRuntime: snapshot.workspaceRuntime ?? null,
      desiredState: snapshot.desiredState ?? null,
      serviceStates: snapshot.serviceStates ?? null,
    },
    environment: input.environment ?? null,
    realization: input.realization ?? null,
  } satisfies Record<EffectiveRunWorkspaceConfigCategory, unknown>;
}

export function buildEffectiveRunWorkspaceConfigMetadata(input: {
  mode: unknown;
  projectId: unknown;
  projectWorkspaceId: unknown;
  strategyType: unknown;
  workspaceStrategy: unknown;
  repoUrl: unknown;
  repoRef: unknown;
  branchName?: unknown;
  configSnapshot: Partial<ExecutionWorkspaceConfig> | null;
  environment: unknown;
  realization: unknown;
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
  evaluatedAt?: string | Date | null;
}): EffectiveRunWorkspaceConfigMetadata {
  const secretManifest = input.secretManifest ?? [];
  const categoryValues = buildWorkspaceConfigCategoryValues({
    mode: input.mode,
    projectId: input.projectId,
    projectWorkspaceId: input.projectWorkspaceId,
    strategyType: input.strategyType,
    workspaceStrategy: input.workspaceStrategy,
    repoUrl: input.repoUrl,
    repoRef: input.repoRef,
    branchName: input.branchName ?? null,
    configSnapshot: input.configSnapshot,
    environment: input.environment,
    realization: input.realization,
  });
  const fingerprints = createEffectiveRunConfigFingerprints({
    workspace: categoryValues,
    secretManifest,
  });
  const categoryFingerprints = createEffectiveRunConfigSubcategoryFingerprints({
    category: "workspace",
    value: categoryValues,
    subcategories: EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES,
    secretManifest,
  });
  const evaluatedAt = input.evaluatedAt instanceof Date
    ? input.evaluatedAt.toISOString()
    : readNonEmptyString(input.evaluatedAt) ?? new Date().toISOString();
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    fingerprint: fingerprints.workspaceFingerprint.fingerprint,
    categories: [...EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES],
    categoryFingerprints,
    fingerprints,
    evaluatedAt,
  };
}

export function resolveExecutionWorkspaceConfigFreshness(input: {
  hasExistingWorkspace: boolean;
  existingWorkspaceMetadata: Record<string, unknown> | null | undefined;
  inferredMetadata?: EffectiveRunWorkspaceConfigMetadata | null;
  nextMetadata: EffectiveRunWorkspaceConfigMetadata | null;
}): ExecutionWorkspaceConfigFreshnessDecision {
  if (!input.hasExistingWorkspace) {
    return {
      action: "create",
      shouldReuseExisting: false,
      shouldRefreshConfigSnapshot: false,
      reasons: [],
      changedCategories: [],
      storedFingerprint: null,
      inferredFingerprint: null,
      nextFingerprint: input.nextMetadata?.fingerprint ?? null,
      storedFingerprintPresent: false,
    };
  }

  const stored = readWorkspaceConfigFingerprintFromMetadata(input.existingWorkspaceMetadata);
  const previous = stored
    ? {
        version: stored.version,
        fingerprint: stored.fingerprint,
        categoryFingerprints: stored.categoryFingerprints,
      }
    : input.inferredMetadata
      ? {
          version: input.inferredMetadata.version,
          fingerprint: input.inferredMetadata.fingerprint,
          categoryFingerprints: input.inferredMetadata.categoryFingerprints,
        }
      : null;

  if (!input.nextMetadata) {
    return {
      action: "reuse",
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: false,
      reasons: [],
      changedCategories: [],
      storedFingerprint: stored?.fingerprint ?? null,
      inferredFingerprint: stored ? null : input.inferredMetadata?.fingerprint ?? null,
      nextFingerprint: null,
      storedFingerprintPresent: Boolean(stored),
    };
  }

  if (!previous) {
    return {
      action: "replace",
      shouldReuseExisting: false,
      shouldRefreshConfigSnapshot: false,
      reasons: ["execution workspace configuration fingerprint metadata is missing"],
      changedCategories: [...input.nextMetadata.categories],
      storedFingerprint: null,
      inferredFingerprint: null,
      nextFingerprint: input.nextMetadata.fingerprint,
      storedFingerprintPresent: false,
    };
  }

  if (previous.version !== input.nextMetadata.version) {
    return {
      action: "replace",
      shouldReuseExisting: false,
      shouldRefreshConfigSnapshot: false,
      reasons: [
        `execution workspace configuration fingerprint version changed from ${previous.version} to ${input.nextMetadata.version}`,
      ],
      changedCategories: [...input.nextMetadata.categories],
      storedFingerprint: stored?.fingerprint ?? null,
      inferredFingerprint: stored ? null : input.inferredMetadata?.fingerprint ?? null,
      nextFingerprint: input.nextMetadata.fingerprint,
      storedFingerprintPresent: Boolean(stored),
    };
  }

  if (previous.fingerprint === input.nextMetadata.fingerprint) {
    return {
      action: "reuse",
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: !stored,
      reasons: stored ? [] : ["execution workspace configuration fingerprint metadata is missing"],
      changedCategories: [],
      storedFingerprint: stored?.fingerprint ?? null,
      inferredFingerprint: stored ? null : input.inferredMetadata?.fingerprint ?? null,
      nextFingerprint: input.nextMetadata.fingerprint,
      storedFingerprintPresent: Boolean(stored),
    };
  }

  const changedCategories = changedEffectiveRunWorkspaceConfigCategories({
    previous: previous.categoryFingerprints,
    next: input.nextMetadata.categoryFingerprints,
  });
  const replacementRequired = changedCategories.some((category) =>
    WORKSPACE_REPLACEMENT_CONFIG_CATEGORIES.has(category)
  );
  const action: WorkspaceConfigFreshnessDecisionAction = replacementRequired ? "replace" : "refresh";
  return {
    action,
    shouldReuseExisting: action !== "replace",
    shouldRefreshConfigSnapshot: action === "refresh",
    reasons: [
      `execution workspace configuration changed: ${describeEffectiveRunWorkspaceConfigCategories(changedCategories)}`,
    ],
    changedCategories,
    storedFingerprint: stored?.fingerprint ?? null,
    inferredFingerprint: stored ? null : input.inferredMetadata?.fingerprint ?? null,
    nextFingerprint: input.nextMetadata.fingerprint,
    storedFingerprintPresent: Boolean(stored),
  };
}

export function readConfiguredModelFromAdapterConfig(
  adapterConfig: Record<string, unknown> | null | undefined,
) {
  return readNonEmptyString(adapterConfig?.model);
}

export function attachPaperclipSessionMetadataToSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
  configuredModel: string | null,
  configMetadata?: EffectiveRunSessionConfigMetadata | null,
) {
  if (!configuredModel && !configMetadata) return sessionParams ?? null;
  const next = { ...(sessionParams ?? {}) };
  if (configuredModel) next[SESSION_CONFIGURED_MODEL_KEY] = configuredModel;
  if (configMetadata) {
    next[SESSION_CONFIG_FINGERPRINT_KEY] = configMetadata.fingerprint;
    next[SESSION_CONFIG_FINGERPRINT_VERSION_KEY] = configMetadata.version;
    next[SESSION_CONFIG_CATEGORIES_KEY] = configMetadata.categories;
    next[SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY] = configMetadata.categoryFingerprints;
  }
  return next;
}

function readConfiguredModelFromSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
) {
  return readNonEmptyString(sessionParams?.[SESSION_CONFIGURED_MODEL_KEY]);
}

export function shouldResetTaskSessionForModelChange(input: {
  configuredModel: string | null;
  taskSessionParams: Record<string, unknown> | null | undefined;
}) {
  const { configuredModel, taskSessionParams } = input;
  if (!configuredModel || !taskSessionParams) return false;
  const sessionModel = readConfiguredModelFromSessionParams(taskSessionParams);
  return !!sessionModel && sessionModel !== configuredModel;
}

export function stripConfiguredModelFromSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
) {
  if (!sessionParams) return null;
  const next = { ...sessionParams };
  delete next[SESSION_CONFIGURED_MODEL_KEY];
  return next;
}

export function stripPaperclipSessionMetadataFromSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
) {
  if (!sessionParams) return null;
  const next = { ...sessionParams };
  for (const key of PAPERCLIP_SESSION_METADATA_KEYS) {
    delete next[key];
  }
  return next;
}

export function resolveTaskSessionConfigFreshness(input: {
  hasTaskSession: boolean;
  configuredModel: string | null;
  taskSessionParams: Record<string, unknown> | null | undefined;
  configMetadata: EffectiveRunSessionConfigMetadata | null;
  wakeResetReason?: string | null;
  preserveLegacySessionWithoutConfigMetadata?: boolean;
}): TaskSessionConfigFreshnessDecision {
  if (!input.hasTaskSession) {
    return {
      reset: false,
      reasons: [],
      changedCategories: [],
      storedFingerprint: null,
      nextFingerprint: input.configMetadata?.fingerprint ?? null,
    };
  }

  const reasons: string[] = [];
  const storedConfig = readConfigFingerprintFromSessionParams(input.taskSessionParams);
  const taskSessionConfiguredModel = readConfiguredModelFromSessionParams(input.taskSessionParams);
  const modelChangedSinceTaskSession = shouldResetTaskSessionForModelChange({
    configuredModel: input.configuredModel,
    taskSessionParams: input.taskSessionParams,
  });
  if (modelChangedSinceTaskSession && taskSessionConfiguredModel) {
    reasons.push(`configured model changed from "${taskSessionConfiguredModel}" to "${input.configuredModel}"`);
  }

  let changedCategories: EffectiveRunSessionConfigCategory[] = [];
  if (input.configMetadata) {
    if (!storedConfig && !input.preserveLegacySessionWithoutConfigMetadata) {
      changedCategories = [...input.configMetadata.categories];
      reasons.push("effective run configuration fingerprint metadata is missing");
    } else if (storedConfig && storedConfig.version !== input.configMetadata.version) {
      changedCategories = [...input.configMetadata.categories];
      reasons.push(
        `effective run configuration fingerprint version changed from ${storedConfig.version} to ${input.configMetadata.version}`,
      );
    } else if (storedConfig && storedConfig.fingerprint !== input.configMetadata.fingerprint) {
      changedCategories = changedEffectiveRunSessionConfigCategories({
        previous: storedConfig.categoryFingerprints,
        next: input.configMetadata.categoryFingerprints,
      });
      reasons.push(
        `effective run configuration changed: ${describeEffectiveRunConfigCategories(changedCategories)}`,
      );
    }
  }

  if (input.wakeResetReason) reasons.push(input.wakeResetReason);

  return {
    reset: reasons.length > 0,
    reasons,
    changedCategories,
    storedFingerprint: storedConfig?.fingerprint ?? null,
    nextFingerprint: input.configMetadata?.fingerprint ?? null,
  };
}
