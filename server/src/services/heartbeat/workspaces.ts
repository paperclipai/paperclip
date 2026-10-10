import { readGitConnectionFailure } from "../git-connection-failure.js";
import { materializeManagedProjectWorkspace, ensureManagedRepositoriesIgnored } from "../managed-repository-checkout.js";
export { materializeManagedProjectWorkspace } from "../managed-repository-checkout.js";
import { sql } from "drizzle-orm";
import { materializeIsolatedTaskDirectory } from "../isolated-task-directory.js";
import { readConnectionFailure, type GitConnectionFailure } from "@paperclipai/adapter-utils/connection-failure";
import { managedAiSessionFingerprintConfig } from "../ai-connection-runtime.js";
import {
  PROJECT_REPOSITORIES_DIR,
  readGitWorkspaceSnapshot,
} from "@paperclipai/adapter-utils/git-workspace-sync";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  createHash,
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  eq,
} from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  type ExecutionWorkspace,
  type ExecutionWorkspaceConfig,
} from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import {
  createGitRemoteAuthProvider,
  scrubGitCredentialText,
  type GitRemoteAuthProvider,
} from "../git-credentials.js";
import {
  parseObject,
  asNumber,
} from "../../adapters/utils.js";
import {
  resolveDefaultAgentWorkspaceDir,
  resolveManagedProjectWorkspaceDir,
  resolvePaperclipInstanceRoot,
} from "../../home-paths.js";
import {
  formatManagedGitWorktreeBranchInspection,
  inspectManagedGitWorktreeBranch,
  type ExecutionWorkspaceInput,
  type RealizedExecutionWorkspace,
} from "../workspace-runtime.js";
import { resolvePersistedGitWorkspaceSource } from "../persisted-workspace-source.js";
import { issueService } from "../issues.js";
import { projectService } from "../projects.js";
import {
  authorizationService,
  type AuthorizationActor,
} from "../authorization.js";
import { mergeExecutionWorkspaceConfig } from "../execution-workspaces.js";
import {
  type WorkspaceOperationRecorder,
} from "../workspace-operations.js";
import {
  GIT_BRANCH_OWNERSHIP_METADATA_KEY,
  GIT_BRANCH_OWNERSHIP_METADATA_VERSION,
} from "../execution-workspace-branch-ownership.js";
import {
  resolveEffectiveWorkspaceStrategyType,
  resolveExecutionWorkspaceMode,
} from "../execution-workspace-policy.js";
import { isUnsafeSessionWorkspaceCwd } from "../session-workspace-cwd.js";
import { assertLowTrustWorkspaceIsolation } from "../low-trust-runtime-containment.js";
import type { TrustPresetResolution } from "../trust-preset-resolver.js";
import {
  createEffectiveRunConfigFingerprints,
  createEffectiveRunConfigSubcategoryFingerprints,
  EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
  type EffectiveRunConfigFingerprints,
  type EffectiveRunConfigSecretManifestEntry,
} from "../effective-run-config-fingerprints.js";

const execFile = promisify(execFileCallback);

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";


export const WORKSPACE_VALIDATION_FAILURE_CODE = "workspace_validation_failed";

const GITHUB_PR_WORKFLOW_SKILL_KEY =
  "paperclipai/bundled/software-development/github-pr-workflow";

const GITHUB_PR_WORKFLOW_SKILL_SLUG = "github-pr-workflow";

const PUSH_CAPABILITY_ENV_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

// Keep this in sync with local adapters that require a git workspace before launch.
const GIT_SENSITIVE_LOCAL_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "grok_local",
  "hermes_local",
  "kimi_local",
  "opencode_local",
  "pi_local",
]);

export class WorkspaceValidationFailure extends Error {
  code = WORKSPACE_VALIDATION_FAILURE_CODE;
  resultJson: Record<string, unknown>;

  constructor(message: string, resultJson: Record<string, unknown>) {
    super(message);
    this.name = "WorkspaceValidationFailure";
    this.resultJson = resultJson;
  }
}

function hasGithubPrWorkflowSkill(desiredSkills: string[]) {
  return desiredSkills.some((skill) => {
    const normalized = skill.trim();
    return (
      normalized === GITHUB_PR_WORKFLOW_SKILL_KEY ||
      normalized === GITHUB_PR_WORKFLOW_SKILL_SLUG ||
      normalized.endsWith(`/${GITHUB_PR_WORKFLOW_SKILL_SLUG}`)
    );
  });
}

export function requiresPushCapabilityPreflight(input: {
  adapterType: string;
  issueId: string | null | undefined;
  explicitRunScopedSkillKeys: string[];
}) {
  return (
    Boolean(input.issueId) &&
    GIT_SENSITIVE_LOCAL_ADAPTER_TYPES.has(input.adapterType) &&
    hasGithubPrWorkflowSkill(input.explicitRunScopedSkillKeys)
  );
}

export function applyPersistedExecutionWorkspaceConfig(input: {
  config: Record<string, unknown>;
  workspaceConfig: ExecutionWorkspaceConfig | null;
  mode: ReturnType<typeof resolveExecutionWorkspaceMode>;
}) {
  const nextConfig = { ...input.config };

  if (input.mode !== "agent_default") {
    if (input.workspaceConfig?.workspaceRuntime === null) {
      delete nextConfig.workspaceRuntime;
    } else if (input.workspaceConfig?.workspaceRuntime) {
      nextConfig.workspaceRuntime = {
        ...input.workspaceConfig.workspaceRuntime,
      };
    }
    if (input.workspaceConfig?.desiredState === null) {
      delete nextConfig.desiredState;
    } else if (input.workspaceConfig?.desiredState) {
      nextConfig.desiredState = input.workspaceConfig.desiredState;
    }
    if (input.workspaceConfig?.serviceStates === null) {
      delete nextConfig.serviceStates;
    } else if (input.workspaceConfig?.serviceStates) {
      nextConfig.serviceStates = { ...input.workspaceConfig.serviceStates };
    }
  }

  if (input.workspaceConfig && input.mode === "isolated_workspace") {
    const nextStrategy = parseObject(nextConfig.workspaceStrategy);
    if (input.workspaceConfig.provisionCommand === null)
      delete nextStrategy.provisionCommand;
    else nextStrategy.provisionCommand = input.workspaceConfig.provisionCommand;
    if (input.workspaceConfig.runtimeProvisionCommand === null)
      delete nextStrategy.runtimeProvisionCommand;
    else
      nextStrategy.runtimeProvisionCommand =
        input.workspaceConfig.runtimeProvisionCommand;
    if (input.workspaceConfig.teardownCommand === null)
      delete nextStrategy.teardownCommand;
    else nextStrategy.teardownCommand = input.workspaceConfig.teardownCommand;
    nextConfig.workspaceStrategy = nextStrategy;
  }

  return nextConfig;
}

export function mergeExecutionWorkspaceMetadataForPersistence(input: {
  existingMetadata: Record<string, unknown> | null | undefined;
  source: string;
  createdByRuntime: boolean;
  strategyType: "project_primary" | "git_worktree";
  configSnapshot: Record<string, unknown> | null;
  shouldReuseExisting: boolean;
  shouldRefreshConfigSnapshot?: boolean;
  workspaceConfigMetadata?: EffectiveRunWorkspaceConfigMetadata | null;
  baseRef: string | null | undefined;
  baseRefSha: string | null | undefined;
}) {
  const base = {
    ...(input.existingMetadata ?? {}),
    source: input.source,
    createdByRuntime: input.createdByRuntime,
  } as Record<string, unknown>;
  if (input.strategyType === "git_worktree") {
    base[GIT_BRANCH_OWNERSHIP_METADATA_KEY] =
      GIT_BRANCH_OWNERSHIP_METADATA_VERSION;
  } else {
    delete base[GIT_BRANCH_OWNERSHIP_METADATA_KEY];
  }

  const existingSnapshot = parseObject(base.baseRefSnapshot);
  if (typeof existingSnapshot.resolvedSha !== "string" && input.baseRefSha) {
    base.baseRefSnapshot = {
      baseRef: input.baseRef ?? null,
      resolvedSha: input.baseRefSha,
    };
  }

  if (input.workspaceConfigMetadata) {
    base[WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY] = {
      version: input.workspaceConfigMetadata.version,
      workspaceHash: input.workspaceConfigMetadata.fingerprint,
      categories: input.workspaceConfigMetadata.categories,
      categoryFingerprints: input.workspaceConfigMetadata.categoryFingerprints,
      lastEvaluatedAt: input.workspaceConfigMetadata.evaluatedAt,
    };
  }

  if (
    (input.shouldReuseExisting && !input.shouldRefreshConfigSnapshot) ||
    !input.configSnapshot
  ) {
    return base;
  }

  return mergeExecutionWorkspaceConfig(base, input.configSnapshot);
}

export function resolveExecutionWorkspaceBranchOwnership(
  executionWorkspace: Pick<
    RealizedExecutionWorkspace,
    "created" | "branchCreatedByRuntime"
  >,
) {
  return executionWorkspace.branchCreatedByRuntime;
}

export function stripWorkspaceRuntimeFromExecutionRunConfig(
  config: Record<string, unknown>,
) {
  const nextConfig = { ...config };
  delete nextConfig.workspaceRuntime;
  return nextConfig;
}

export function buildExecutionWorkspaceConfigSnapshot(
  config: Record<string, unknown>,
  environmentId?: string | null,
): Partial<ExecutionWorkspaceConfig> | null {
  const strategy = parseObject(config.workspaceStrategy);
  const snapshot: Partial<ExecutionWorkspaceConfig> = {};
  // Persist the resolved environment onto the workspace so reused sessions stay on the
  // environment they were created against until the workspace itself is recreated/reset.
  const hasExplicitEnvironmentSelection = environmentId !== undefined;

  if (hasExplicitEnvironmentSelection) {
    snapshot.environmentId = environmentId ?? null;
  }

  if ("workspaceStrategy" in config) {
    snapshot.provisionCommand =
      typeof strategy.provisionCommand === "string"
        ? strategy.provisionCommand
        : null;
    snapshot.runtimeProvisionCommand =
      typeof strategy.runtimeProvisionCommand === "string"
        ? strategy.runtimeProvisionCommand
        : null;
    snapshot.teardownCommand =
      typeof strategy.teardownCommand === "string"
        ? strategy.teardownCommand
        : null;
  }

  if ("workspaceRuntime" in config) {
    const workspaceRuntime = parseObject(config.workspaceRuntime);
    snapshot.workspaceRuntime =
      Object.keys(workspaceRuntime).length > 0 ? workspaceRuntime : null;
  }
  if ("desiredState" in config) {
    snapshot.desiredState =
      config.desiredState === "running" ||
      config.desiredState === "stopped" ||
      config.desiredState === "manual"
        ? config.desiredState
        : null;
  }
  if ("serviceStates" in config) {
    const serviceStates = parseObject(config.serviceStates);
    snapshot.serviceStates =
      Object.keys(serviceStates).length > 0
        ? (Object.fromEntries(
            Object.entries(serviceStates).filter(
              ([, state]) =>
                state === "running" ||
                state === "stopped" ||
                state === "manual",
            ),
          ) as ExecutionWorkspaceConfig["serviceStates"])
        : null;
  }

  const hasSnapshot =
    Object.values(snapshot).some((value) => {
      if (value === null) return false;
      if (typeof value === "object") return Object.keys(value).length > 0;
      return true;
    }) || hasExplicitEnvironmentSelection;
  return hasSnapshot ? snapshot : null;
}

export function stripHostWorkspaceProvisionForLowTrustSandbox(input: {
  config: Record<string, unknown>;
  trustPreset: TrustPresetResolution;
  selectedEnvironmentDriver: string | null | undefined;
}): Record<string, unknown> {
  if (input.trustPreset.kind !== "low_trust_review") return input.config;
  if (input.selectedEnvironmentDriver !== "sandbox") return input.config;

  const workspaceStrategy = parseObject(input.config.workspaceStrategy);
  if (
    typeof workspaceStrategy.provisionCommand !== "string" &&
    typeof workspaceStrategy.runtimeProvisionCommand !== "string"
  )
    return input.config;

  const nextWorkspaceStrategy = { ...workspaceStrategy };
  delete nextWorkspaceStrategy.provisionCommand;
  delete nextWorkspaceStrategy.runtimeProvisionCommand;

  return {
    ...input.config,
    workspaceStrategy: nextWorkspaceStrategy,
  };
}

export async function preflightLowTrustWorkspaceIsolation(input: {
  db?: Db;
  trustPreset: TrustPresetResolution;
  isolatedWorkspacesEnabled: boolean;
  effectiveExecutionWorkspaceMode: string | null | undefined;
  issue: {
    companyId: string;
    id?: string | null;
    projectId?: string | null;
  } | null;
  resolveSelectedEnvironmentDriver: () => Promise<string | null | undefined>;
}): Promise<string | null> {
  if (
    input.trustPreset.kind !== "denied" &&
    input.trustPreset.kind !== "low_trust_review"
  ) {
    return null;
  }

  const selectedEnvironmentDriver =
    input.trustPreset.kind === "low_trust_review"
      ? await input.resolveSelectedEnvironmentDriver()
      : null;

  await assertLowTrustWorkspaceIsolation({
    db: input.db,
    resolution: input.trustPreset,
    isolatedWorkspacesEnabled: input.isolatedWorkspacesEnabled,
    effectiveExecutionWorkspaceMode: input.effectiveExecutionWorkspaceMode,
    selectedEnvironmentDriver,
    issue: input.issue,
  });

  return selectedEnvironmentDriver ?? null;
}

export async function resolveWorkspaceAfterLowTrustPreflight<
  TWorkspace,
>(input: {
  db?: Db;
  trustPreset: TrustPresetResolution;
  isolatedWorkspacesEnabled: boolean;
  effectiveExecutionWorkspaceMode: string | null | undefined;
  issue: {
    companyId: string;
    id?: string | null;
    projectId?: string | null;
  } | null;
  resolveSelectedEnvironmentDriver: () => Promise<string | null | undefined>;
  resolveWorkspace: () => Promise<TWorkspace>;
}): Promise<{
  selectedEnvironmentDriver: string | null;
  workspace: TWorkspace;
}> {
  const selectedEnvironmentDriver = await preflightLowTrustWorkspaceIsolation({
    db: input.db,
    trustPreset: input.trustPreset,
    isolatedWorkspacesEnabled: input.isolatedWorkspacesEnabled,
    effectiveExecutionWorkspaceMode: input.effectiveExecutionWorkspaceMode,
    issue: input.issue,
    resolveSelectedEnvironmentDriver: input.resolveSelectedEnvironmentDriver,
  });

  return {
    selectedEnvironmentDriver,
    workspace: await input.resolveWorkspace(),
  };
}

function deriveRepoNameFromRepoUrl(repoUrl: string | null): string | null {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    const cleanedPath = parsed.pathname.replace(/\/+$/, "");
    const repoName =
      cleanedPath
        .split("/")
        .filter(Boolean)
        .pop()
        ?.replace(/\.git$/i, "") ?? "";
    return repoName || null;
  } catch {
    return null;
  }
}

/**
 * In-flight managed-checkout materializations keyed by target cwd. Two issues on the same
 * project can wake within seconds of each other; without this, both runs raced the same
 * clone target — the loser saw "destination path already exists" and its failure cleanup
 * deleted the winner's in-progress clone, so both runs failed every round.
 */
const managedCheckoutMaterializations = new Map<
  string,
  Promise<{ cwd: string; warning: string | null }>
>();

export async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  projectId: string;
  repoUrl: string | null;
  /** Optional git credential source for cloning private repos; null/absent preserves ambient behavior. */
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const defaultCwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  let cwd = defaultCwd;
  if (input.repoUrl && await fs.stat(path.join(cwd, ".git")).catch(() => null)) {
    const origin = await execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 })
      .then((result) => result.stdout.trim()).catch(() => null);
    if (origin && origin !== input.repoUrl) {
      cwd = `${cwd}-${createHash("sha256").update(input.repoUrl).digest("hex").slice(0, 12)}`;
    }
  }
  const inFlight = managedCheckoutMaterializations.get(cwd);
  if (inFlight) {
    await inFlight;
    // The winner may have cloned a different repository with the same basename.
    return ensureManagedProjectWorkspace(input);
  }
  const attempt = materializeManagedProjectWorkspace(cwd, input).finally(() => {
    managedCheckoutMaterializations.delete(cwd);
  });
  managedCheckoutMaterializations.set(cwd, attempt);
  const result = await attempt;
  if (input.repoUrl) {
    // A different server process can publish a same-name checkout between the
    // initial origin check and the atomic rename. Never adopt its other repo.
    const origin = await execFile("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 })
      .then((value) => value.stdout.trim()).catch(() => null);
    if (origin && origin !== input.repoUrl) {
      if (cwd !== defaultCwd) throw new Error("Managed checkout origin does not match the requested repository");
      return ensureManagedProjectWorkspace(input);
    }
  }
  return result;
}

/** Keep every distinct project repository inside the task's writable/synced root. */
export async function prepareProjectRepositoryWorkspaces(input: {
  cwd: string;
  anchorRepoUrl: string | null;
  workspaces: Array<Pick<typeof projectWorkspaces.$inferSelect, "id" | "repoUrl" | "repoRef"> & { cwd?: string | null }>;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<Array<{ workspaceId: string; cwd: string; repoUrl: string; repoRef: string | null }>> {
  const identity = (url: string) => url.trim().replace(/\.git\/?$/, "").replace(/\/$/, "");
  const seen = new Set(input.anchorRepoUrl ? [identity(input.anchorRepoUrl)] : []);
  const selected = input.workspaces.filter((workspace) => {
    if (!workspace.repoUrl || seen.has(identity(workspace.repoUrl))) return false;
    seen.add(identity(workspace.repoUrl));
    return true;
  });
  const root = path.join(input.cwd, PROJECT_REPOSITORIES_DIR);
  if (selected.length === 0 && !(await fs.lstat(root).catch(() => null))) return [];
  await fs.mkdir(root, { recursive: true });
  if (await fs.realpath(root) !== path.join(await fs.realpath(input.cwd), PROJECT_REPOSITORIES_DIR)) {
    throw new Error("Project repositories directory escapes the task workspace");
  }
  await ensureManagedRepositoriesIgnored(input.cwd);
  const results = [];
  for (const workspace of selected) {
    const repoUrl = workspace.repoUrl!;
    const name = (deriveRepoNameFromRepoUrl(repoUrl) ?? "repo").replace(/[^a-zA-Z0-9_-]/g, "-");
    const key = `${name}-${createHash("sha256").update(JSON.stringify([workspace.id, identity(repoUrl), workspace.repoRef, workspace.cwd ?? null])).digest("hex").slice(0, 12)}`;
    const cwd = path.join(root, key);
    const existing = await fs.lstat(cwd).catch(() => null);
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Invalid project repository checkout path");
    const localSource = workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL
      && await fs.stat(workspace.cwd).then((entry) => entry.isDirectory()).catch(() => false)
      ? workspace.cwd : null;
    const result = await materializeManagedProjectWorkspace(cwd, { repoUrl, repoRef: workspace.repoRef, localSource, resolveGitAuth: input.resolveGitAuth });
    if (result.warning) throw new Error(result.warning);
    results.push({ workspaceId: workspace.id, cwd, repoUrl, repoRef: workspace.repoRef });
  }
  // Retain detached checkout work outside the synchronized repository set.
  const active = new Set(results.map((repo) => path.basename(repo.cwd)));
  for (const entry of await fs.readdir(root)) {
    if (active.has(entry) || entry.startsWith("task-repo-") || entry.includes(".clone-")) continue;
    const retained = path.join(input.cwd, ".paperclip-runtime", "detached-repositories", randomUUID());
    await fs.mkdir(path.dirname(retained), { recursive: true });
    await fs.rename(path.join(root, entry), retained);
  }
  return results;
}

/**
 * Resolve one project workspace row to a usable cwd. The anchor path and each additional
 * referenced project share this step: use the configured cwd when present, otherwise clone or
 * create the managed checkout directory for the project. It throws only when the managed
 * checkout cannot be prepared (for example, a clone failure).
 */
async function resolveConfiguredOrManagedProjectCwd(input: {
  companyId: string;
  projectId: string;
  cwd: string | null;
  repoUrl: string | null;
  resolveGitAuth?: GitRemoteAuthProvider | null;
}): Promise<{ cwd: string; warning: string | null }> {
  const configuredCwd = readNonEmptyString(input.cwd);
  if (configuredCwd && configuredCwd !== REPO_ONLY_CWD_SENTINEL) {
    return { cwd: configuredCwd, warning: null };
  }
  return ensureManagedProjectWorkspace({
    companyId: input.companyId,
    projectId: input.projectId,
    repoUrl: readNonEmptyString(input.repoUrl),
    resolveGitAuth: input.resolveGitAuth ?? null,
  });
}

/**
 * Side-effecting dependencies for {@link resolveAdditionalProjectWorkspace}. The caller injects
 * the real database, filesystem, and managed-checkout helpers. A test injects fakes to exercise
 * the resolution logic without a database or filesystem.
 */
export interface ResolveAdditionalProjectWorkspaceDeps {
  loadProjectWorkspaceRows: (
    companyId: string,
    projectId: string,
  ) => Promise<Array<typeof projectWorkspaces.$inferSelect>>;
  resolveConfiguredOrManagedProjectCwd: typeof resolveConfiguredOrManagedProjectCwd;
  ensureManagedProjectWorkspace: typeof ensureManagedProjectWorkspace;
  directoryHasContents: (cwd: string) => Promise<boolean>;
}

/** Build the real dependencies for {@link resolveAdditionalProjectWorkspace}. */
function defaultAdditionalProjectWorkspaceDeps(
  db: Db,
  resolveGitAuth?: GitRemoteAuthProvider,
): ResolveAdditionalProjectWorkspaceDeps {
  return {
    loadProjectWorkspaceRows: (companyId, projectId) =>
      db
        .select()
        .from(projectWorkspaces)
        .where(
          and(
            eq(projectWorkspaces.companyId, companyId),
            eq(projectWorkspaces.projectId, projectId),
          ),
        )
        .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id)),
    resolveConfiguredOrManagedProjectCwd: (input) =>
      resolveConfiguredOrManagedProjectCwd({
        ...input,
        resolveGitAuth:
          input.resolveGitAuth ??
          resolveGitAuth ??
          createGitRemoteAuthProvider(db, input.companyId),
      }),
    ensureManagedProjectWorkspace: (input) =>
      ensureManagedProjectWorkspace({
        ...input,
        resolveGitAuth:
          input.resolveGitAuth ??
          resolveGitAuth ??
          createGitRemoteAuthProvider(db, input.companyId),
      }),
    // A realized workspace must hold real content. An empty directory gives the agent an empty
    // referenced workspace, so treat an empty directory the same as a missing one.
    directoryHasContents: async (cwd) => {
      const stats = await fs.stat(cwd).catch(() => null);
      if (!stats || !stats.isDirectory()) {
        return false;
      }
      const entries = await fs.readdir(cwd).catch(() => [] as string[]);
      return entries.length > 0;
    },
  };
}

/**
 * Resolve one authorized referenced project to its own workspace cwd. Each additional project
 * lands in its own managed checkout directory, never nested inside the anchor's worktree (the
 * directory isolation invariant lives in {@link resolveManagedProjectWorkspaceDir}).
 *
 * A referenced project must resolve to a directory with real content. The function uses a
 * configured checkout directory that exists, or clones a managed checkout from a workspace row
 * that supplies a repository URL. When no row offers either, the function throws instead of
 * creating an empty managed directory. An empty directory gives the agent an empty referenced
 * workspace and hides the real cause. The caller catches the error and drops only that project.
 * The function also throws when the managed checkout cannot be prepared (for example, a clone
 * failure), so the caller can drop only that project.
 */
export async function resolveAdditionalProjectWorkspace(
  input: {
    companyId: string;
    project: RunReferencedProject;
  },
  deps: ResolveAdditionalProjectWorkspaceDeps,
): Promise<ResolvedAdditionalWorkspace> {
  const { companyId } = input;
  const projectId = input.project.projectId;
  const workspaceRows = await deps.loadProjectWorkspaceRows(
    companyId,
    projectId,
  );
  for (const workspace of workspaceRows) {
    // A row realizes real content only through a configured checkout directory or a repository URL
    // to clone. A row with neither can produce only an empty managed directory, so skip it here.
    const configuredCwd = readNonEmptyString(workspace.cwd);
    const hasConfiguredCwd =
      Boolean(configuredCwd) && configuredCwd !== REPO_ONLY_CWD_SENTINEL;
    if (!hasConfiguredCwd && !readNonEmptyString(workspace.repoUrl)) {
      continue;
    }
    const { cwd } = await deps.resolveConfiguredOrManagedProjectCwd({
      companyId,
      projectId,
      cwd: workspace.cwd,
      repoUrl: workspace.repoUrl,
    });
    // A directory that exists but holds no content is not a realized workspace. Accept the row only
    // when the resolved directory has real content, so an empty directory never masks a missing one.
    if (await deps.directoryHasContents(cwd)) {
      return {
        cwd,
        projectId,
        workspaceId: workspace.id,
        repoUrl: workspace.repoUrl,
        repoRef: workspace.repoRef,
      };
    }
  }
  // No configured checkout resolved to a directory with content. Clone a managed checkout only from a
  // real source: the first workspace row that supplies a repository URL. Without a real source, do
  // not fabricate an empty managed directory and report success. Throw instead, so the caller drops
  // only this referenced project and adds a clear warning.
  const fallbackRow =
    workspaceRows.find((row) => readNonEmptyString(row.repoUrl)) ?? null;
  const fallbackRepoUrl = fallbackRow
    ? readNonEmptyString(fallbackRow.repoUrl)
    : null;
  if (!fallbackRow || !fallbackRepoUrl) {
    throw new Error(
      `Referenced project ${projectId} has no workspace checkout or repository URL to realize.`,
    );
  }
  const managed = await deps.ensureManagedProjectWorkspace({
    companyId,
    projectId,
    repoUrl: fallbackRepoUrl,
  });
  return {
    cwd: managed.cwd,
    projectId,
    workspaceId: fallbackRow.id,
    repoUrl: fallbackRow.repoUrl,
    repoRef: fallbackRow.repoRef,
  };
}

type WorkspaceValidationFailureLike =
  | WorkspaceValidationFailure
  | {
      code: typeof WORKSPACE_VALIDATION_FAILURE_CODE;
      resultJson: Record<string, unknown>;
    };

export function isWorkspaceValidationFailure(
  error: unknown,
): error is WorkspaceValidationFailureLike {
  if (error instanceof WorkspaceValidationFailure) return true;
  const maybe = error as { code?: unknown; resultJson?: unknown } | null;
  return Boolean(
    maybe &&
    maybe.code === WORKSPACE_VALIDATION_FAILURE_CODE &&
    maybe.resultJson &&
    typeof maybe.resultJson === "object" &&
    !Array.isArray(maybe.resultJson),
  );
}

export function isWorkspaceValidationFailedRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "errorCode"> | null | undefined,
) {
  return run?.errorCode === WORKSPACE_VALIDATION_FAILURE_CODE;
}

export function readWorkspaceValidationPayloadFromRun(
  run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson"> | null | undefined,
) {
  return parseObject(parseObject(run?.resultJson).workspaceValidation);
}

function stableStringifyForFingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringifyForFingerprint(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringifyForFingerprint(rec[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintFinalizeWorkspaceBranchValidation(input: {
  issueId: string | null;
  executionWorkspaceId: string;
  inspection: ReturnType<typeof formatManagedGitWorktreeBranchInspection>;
}) {
  const digest = createHash("sha256")
    .update(
      stableStringifyForFingerprint({
        version: 1,
        reason: "git_worktree_branch_incoherence",
        issueId: input.issueId,
        executionWorkspaceId: input.executionWorkspaceId,
        worktreePath: input.inspection.worktreePath
          ? path.resolve(input.inspection.worktreePath)
          : null,
        repoRoot: input.inspection.repoRoot
          ? path.resolve(input.inspection.repoRoot)
          : null,
        expectedBranchName: input.inspection.expectedBranchName,
        actualBranchName: input.inspection.actualBranchName,
        reasonCode: input.inspection.reasonCode,
      }),
    )
    .digest("hex");
  return `workspace_finalize_branch_mismatch:v1:sha256:${digest}`;
}

async function hasGitMetadata(cwd: string | null | undefined) {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return false;
  return fs
    .lstat(path.resolve(normalized, ".git"))
    .then((entry) => entry.isDirectory() || entry.isFile())
    .catch(() => false);
}

async function isGitCheckout(cwd: string | null | undefined) {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return false;
  return execFile("git", ["rev-parse", "--show-toplevel"], { cwd: normalized })
    .then((result) => Boolean(readNonEmptyString(result.stdout)))
    .catch(() => false);
}

async function probeGitWorktreeBase(cwd: string) {
  try {
    const result = await execFile("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      env: { ...process.env, LC_ALL: "C" },
    });
    return { isCheckout: Boolean(readNonEmptyString(result.stdout)), notRepository: false };
  } catch (error) {
    const failure = error as { code?: unknown; signal?: unknown; stderr?: unknown };
    // Git's absence result is only a candidate: damaged metadata can produce
    // the same message. Verify its absence too. Missing Git, permission errors,
    // corruption and I/O failures must remain reportable in Sentry.
    const notRepository = failure.code === 128 && failure.signal == null &&
      typeof failure.stderr === "string" &&
      /^fatal: not a git repository \(or any of the parent directories\): \.git\r?\n?$/.test(failure.stderr) &&
      !process.env.GIT_DIR && !process.env.GIT_WORK_TREE && !process.env.GIT_COMMON_DIR &&
      await hasNoGitMetadataInWorkspaceAncestors(cwd);
    return { isCheckout: false, notRepository };
  }
}

async function hasNoGitMetadataInWorkspaceAncestors(cwd: string): Promise<boolean> {
  try {
    let directory = await fs.realpath(cwd);
    if (!(await fs.stat(directory)).isDirectory()) return false;
    for (;;) {
      // Damaged repositories can produce the same "not a git repository"
      // message as ordinary directories. Retain those failures in Sentry.
      // lstat deliberately recognizes dangling .git links as metadata too.
      for (const name of [".git", "HEAD", "objects", "refs"]) {
        try {
          await fs.lstat(path.join(directory, name));
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) return true;
      directory = parent;
    }
  } catch {
    return false;
  }
}

function sameResolvedPath(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  const leftPath = readNonEmptyString(left);
  const rightPath = readNonEmptyString(right);
  if (!leftPath || !rightPath) return false;
  return path.resolve(leftPath) === path.resolve(rightPath);
}

async function hasGitPushRemote(cwd: string | null | undefined) {
  const normalized = readNonEmptyString(cwd);
  if (!normalized) return false;
  const remoteNames = await execFile("git", ["remote"], { cwd: normalized })
    .then((result) =>
      result.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    )
    .catch(() => []);

  for (const remoteName of remoteNames) {
    const pushUrl = await execFile(
      "git",
      ["remote", "get-url", "--push", remoteName],
      { cwd: normalized },
    )
      .then((result) => readNonEmptyString(result.stdout))
      .catch(() => null);
    if (pushUrl) return true;
  }
  return false;
}

export async function assertGitWorktreeBaseWorkspaceReady(input: {
  requestedExecutionWorkspaceMode: ReturnType<
    typeof resolveExecutionWorkspaceMode
  >;
  config: Record<string, unknown>;
  issue: {
    id: string;
    identifier: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
    executionWorkspaceId?: string | null;
    executionWorkspacePreference?: string | null;
  } | null;
  base: ExecutionWorkspaceInput;
  /**
   * Anchor-resolution facts that `base` alone cannot express: whether the base cwd is the
   * agent-home fallback despite the project having workspaces, and which materialization
   * attempts failed on the way there. Absent means "not a fallback" (legacy callers).
   */
  anchor?: {
    baseCwdFallback?: boolean;
    materializationFailures?: WorkspaceMaterializationFailure[];
    /** Selected database workspace is an explicit local path with no repository URL. */
    localPathOnlyWorkspace?: boolean;
  } | null;
}) {
  if (!input.issue) return;
  if (
    input.requestedExecutionWorkspaceMode !== "isolated_workspace" &&
    input.requestedExecutionWorkspaceMode !== "operator_branch"
  ) {
    return;
  }

  const strategyType = resolveEffectiveWorkspaceStrategyType(
    input.requestedExecutionWorkspaceMode,
    input.config,
  );
  if (strategyType !== "git_worktree") return;

  const issueLabel = input.issue.identifier ?? input.issue.id;
  const remediation =
    "This task needs a project / project workspace or a reusable execution workspace before it can run.";
  const fail = (
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
    connectionFailure?: GitConnectionFailure,
  ) => {
    throw new WorkspaceValidationFailure(message, {
      ...(connectionFailure ? { connectionFailure } : {}),
      workspaceValidation: {
        reason,
        issueId: input.issue!.id,
        issueIdentifier: input.issue!.identifier,
        issueProjectId: input.issue!.projectId,
        issueProjectWorkspaceId: input.issue!.projectWorkspaceId,
        issueExecutionWorkspaceId: input.issue!.executionWorkspaceId ?? null,
        issueExecutionWorkspacePreference:
          input.issue!.executionWorkspacePreference ?? null,
        requestedExecutionWorkspaceMode: input.requestedExecutionWorkspaceMode,
        workspaceStrategyType: strategyType,
        resolvedWorkspaceSource: input.base.source,
        resolvedProjectId: input.base.projectId,
        resolvedProjectWorkspaceId: input.base.workspaceId,
        resolvedWorkspaceCwd: input.base.baseCwd,
        ...extra,
      },
    });
  };

  if (input.base.source === "agent_home") {
    fail(
      "git_worktree_base_agent_home",
      `Issue ${issueLabel} requested ${input.requestedExecutionWorkspaceMode} with git_worktree, but no project or reusable execution workspace was resolved; refusing to create a git worktree from agent fallback cwd "${input.base.baseCwd}". ${remediation}`,
    );
  }

  // Checked before isGitCheckout: when materialization failed and the base cwd is the
  // agent-home fallback, a git checkout at that path would be an unrelated repository —
  // proceeding would build worktrees off the wrong repo, and failing on the checkout probe
  // would mask the real cause (for example a clone that could not authenticate). The reason
  // is reserved for genuine materialization failures; a fallback with no failed attempt
  // (a configured path that is simply unavailable) keeps its accurate reporting below.
  const materializationFailures = input.anchor?.materializationFailures ?? [];
  if (input.anchor?.baseCwdFallback && materializationFailures.length > 0) {
    const failureDetail = `: ${materializationFailures[0].error.replace(/\s+/g, " ")}`;
    const connections = materializationFailures.map((failure) => readConnectionFailure(failure.connectionFailure));
    // Mixed connection/local failures must retain their application-error report.
    const connectionFailure = connections.every((failure) => failure?.provider === "git")
      ? connections[0] as GitConnectionFailure : undefined;
    fail(
      "git_worktree_base_materialization_failed",
      `Issue ${issueLabel} requested ${input.requestedExecutionWorkspaceMode} with git_worktree, but the project workspace checkout could not be prepared${failureDetail}. Repair the project workspace repository URL, clone access, or configured local cwd, then retry.`,
      { baseCwdFallback: true, materializationFailures },
      connectionFailure,
    );
  }

  const checkoutProbe = await probeGitWorktreeBase(input.base.baseCwd);
  if (!checkoutProbe.isCheckout) {
    const knownLocalPathMismatch = checkoutProbe.notRepository &&
      input.anchor?.localPathOnlyWorkspace === true &&
      input.anchor.baseCwdFallback === false && materializationFailures.length === 0 &&
      input.base.source === "project_primary" && Boolean(input.base.projectId) &&
      Boolean(input.base.workspaceId) && !readNonEmptyString(input.base.repoUrl);
    fail(
      "git_worktree_base_not_git_checkout",
      `Issue ${issueLabel} requested ${input.requestedExecutionWorkspaceMode} with git_worktree, but base workspace "${input.base.baseCwd}" is not a git checkout. ${remediation}`,
      knownLocalPathMismatch
        ? { configurationReason: "local_path_requires_git_checkout" }
        : {},
    );
  }

  // A fallback cwd that happens to be a git checkout is still not the configured project
  // workspace — building worktrees there would target an unrelated repository. No
  // materialization attempt failed here (that case failed above); the configured path is
  // simply unavailable, so the message points at the path rather than clone access.
  if (input.anchor?.baseCwdFallback) {
    fail(
      "git_worktree_base_fallback_not_project_workspace",
      `Issue ${issueLabel} requested ${input.requestedExecutionWorkspaceMode} with git_worktree, but the configured project workspace path is not available and the fallback cwd "${input.base.baseCwd}" is not the project workspace checkout. Make the configured project workspace path available on this host, or repair the project workspace configuration, then retry.`,
      { baseCwdFallback: true, materializationFailures },
    );
  }
}

export async function assertPushCapabilityCheckoutValid(input: {
  enabled: boolean;
  issue: {
    id: string;
    identifier: string | null;
  } | null;
  cwd: string | null | undefined;
}) {
  if (!input.enabled || !input.issue) return;
  const cwd = readNonEmptyString(input.cwd);
  if (!cwd) return;
  if (await hasGitPushRemote(cwd)) return;
  throw new WorkspaceValidationFailure(
    `Issue ${input.issue.identifier ?? input.issue.id} requested the GitHub PR workflow, but checkout "${cwd}" has no configured push remote. Bind the run to a writable repo checkout before dispatching the agent.`,
    {
      workspaceValidation: {
        reason: "missing_git_push_remote",
        issueId: input.issue.id,
        issueIdentifier: input.issue.identifier,
        executionWorkspaceCwd: cwd,
        requiredEnvKeys: [...PUSH_CAPABILITY_ENV_KEYS],
      },
    },
  );
}

/**
 * Reconcile the `projectWorkspaceId` for a reused execution workspace.
 *
 * A `reuse_existing` workspace can have been persisted with a null
 * `projectWorkspaceId` (e.g. it was created before its project had a primary
 * project workspace). When we later restore it for a run whose issue now
 * expects a concrete project workspace, backfill the column so the launch
 * guard (`persisted_workspace_missing_project_workspace_id`) stops rejecting
 * it on every requeue — otherwise `reuse_existing` re-binds the same stale
 * record forever and the run crash-loops. Prefer the existing binding when
 * present so we never null out a good value or silently rebind a genuine
 * mismatch (which the guard still surfaces).
 */
export function reconcileReusedExecutionWorkspaceProjectWorkspaceId(
  existingProjectWorkspaceId: string | null | undefined,
  resolvedProjectWorkspaceId: string | null | undefined,
): string | null {
  return existingProjectWorkspaceId ?? resolvedProjectWorkspaceId ?? null;
}

export async function assertGitSensitiveAdapterWorkspaceValid(input: {
  adapterType: string;
  agentId: string;
  issue: {
    id: string;
    identifier: string | null;
    projectId: string | null;
    projectWorkspaceId: string | null;
  } | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
  executionWorkspace: RealizedExecutionWorkspace;
  persistedExecutionWorkspace: ExecutionWorkspace | null;
  executionTarget: unknown;
  environmentDriver?: string | null;
  leaseMetadata?: unknown;
}) {
  if (!GIT_SENSITIVE_LOCAL_ADAPTER_TYPES.has(input.adapterType)) return;

  const executionTargetKind =
    readNonEmptyString(
      (input.executionTarget as { kind?: unknown } | null)?.kind,
    ) ?? "local";
  if (executionTargetKind !== "local") return;

  const issue = input.issue;
  if (!issue) return;

  const environmentDriver =
    readNonEmptyString(input.environmentDriver) ?? "local";
  const leaseMetadata = parseObject(input.leaseMetadata);
  const leaseProviderMetadata = parseObject(leaseMetadata.providerMetadata);
  const leaseRemoteCwd =
    readNonEmptyString(leaseMetadata.remoteCwd) ??
    readNonEmptyString(leaseProviderMetadata.remoteCwd);

  const effectiveCwd = readNonEmptyString(input.executionWorkspace.cwd);
  const persistedCwd = readNonEmptyString(
    input.persistedExecutionWorkspace?.cwd,
  );
  const agentFallbackCwd = resolveDefaultAgentWorkspaceDir(input.agentId);
  const workspaceExpectation =
    Boolean(issue.projectWorkspaceId) ||
    Boolean(input.resolvedWorkspace.workspaceId) ||
    input.executionWorkspace.strategy === "git_worktree";

  const fail = (
    reason: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) => {
    throw new WorkspaceValidationFailure(message, {
      workspaceValidation: {
        reason,
        adapterType: input.adapterType,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        issueProjectId: issue.projectId,
        issueProjectWorkspaceId: issue.projectWorkspaceId,
        resolvedWorkspaceSource: input.resolvedWorkspace.source,
        resolvedProjectId: input.resolvedWorkspace.projectId,
        resolvedProjectWorkspaceId: input.resolvedWorkspace.workspaceId,
        resolvedWorkspaceCwd: input.resolvedWorkspace.cwd,
        executionWorkspaceCwd: effectiveCwd,
        executionWorkspaceStrategy: input.executionWorkspace.strategy,
        executionWorkspaceProjectId: input.executionWorkspace.projectId,
        executionWorkspaceProjectWorkspaceId:
          input.executionWorkspace.workspaceId,
        persistedExecutionWorkspaceId:
          input.persistedExecutionWorkspace?.id ?? null,
        persistedWorkspaceCwd: persistedCwd,
        persistedWorkspaceStrategy:
          input.persistedExecutionWorkspace?.strategyType ?? null,
        persistedProjectId:
          input.persistedExecutionWorkspace?.projectId ?? null,
        persistedProjectWorkspaceId:
          input.persistedExecutionWorkspace?.projectWorkspaceId ?? null,
        persistedProviderRef:
          input.persistedExecutionWorkspace?.providerRef ?? null,
        ...extra,
      },
    });
  };

  if (issue.projectWorkspaceId && !issue.projectId && !input.persistedExecutionWorkspace?.projectId) {
    fail(
      "missing_project_id",
      `Issue ${issue.identifier ?? issue.id} is linked to a project workspace but has no project id; refusing to launch ${input.adapterType} from fallback cwd.`,
    );
  }

  if (!input.executionTarget && environmentDriver !== "local" && leaseRemoteCwd)
    return;

  if (workspaceExpectation && !input.persistedExecutionWorkspace) {
    fail(
      "missing_persisted_execution_workspace",
      `Issue ${issue.identifier ?? issue.id} requires a project execution workspace, but none was persisted before adapter launch.`,
    );
  }

  if (workspaceExpectation && !effectiveCwd) {
    fail(
      "missing_effective_cwd",
      `Issue ${issue.identifier ?? issue.id} expected a project workspace, but no adapter cwd was resolved before launch.`,
    );
  }

  if (
    input.persistedExecutionWorkspace &&
    effectiveCwd &&
    persistedCwd &&
    !sameResolvedPath(effectiveCwd, persistedCwd)
  ) {
    fail(
      "persisted_cwd_mismatch",
      `Issue ${issue.identifier ?? issue.id} resolved adapter cwd "${effectiveCwd}" but persisted execution workspace cwd is "${persistedCwd}".`,
    );
  }

  const expectedProjectWorkspaceId =
    issue.projectWorkspaceId ?? input.resolvedWorkspace.workspaceId ?? null;
  if (
    expectedProjectWorkspaceId &&
    input.persistedExecutionWorkspace &&
    !input.persistedExecutionWorkspace.projectWorkspaceId
  ) {
    fail(
      "persisted_workspace_missing_project_workspace_id",
      `Issue ${issue.identifier ?? issue.id} expected project workspace "${expectedProjectWorkspaceId}" but persisted execution workspace has no project workspace id.`,
    );
  }

  if (
    expectedProjectWorkspaceId &&
    input.persistedExecutionWorkspace?.projectWorkspaceId &&
    input.persistedExecutionWorkspace.projectWorkspaceId !==
      expectedProjectWorkspaceId
  ) {
    fail(
      "project_workspace_mismatch",
      `Issue ${issue.identifier ?? issue.id} expected project workspace "${expectedProjectWorkspaceId}" but persisted execution workspace points at "${input.persistedExecutionWorkspace.projectWorkspaceId}".`,
    );
  }

  if (
    workspaceExpectation &&
    effectiveCwd &&
    sameResolvedPath(effectiveCwd, agentFallbackCwd)
  ) {
    fail(
      "fallback_agent_home_cwd",
      `Issue ${issue.identifier ?? issue.id} expected a project workspace, but ${input.adapterType} would launch from agent fallback cwd "${effectiveCwd}".`,
    );
  }

  if (
    input.persistedExecutionWorkspace?.strategyType === "git_worktree" &&
    input.persistedExecutionWorkspace.providerRef &&
    effectiveCwd &&
    !sameResolvedPath(
      effectiveCwd,
      input.persistedExecutionWorkspace.providerRef,
    )
  ) {
    fail(
      "git_worktree_provider_ref_mismatch",
      `Issue ${issue.identifier ?? issue.id} expected git worktree "${input.persistedExecutionWorkspace.providerRef}" but adapter cwd resolved to "${effectiveCwd}".`,
    );
  }

  if (
    workspaceExpectation &&
    !(input.resolvedWorkspace.localPathOnlyWorkspace === true && input.executionWorkspace.strategy === "project_primary" && !input.executionWorkspace.repoUrl && !input.executionWorkspace.branchName) &&
    effectiveCwd &&
    !(await hasGitMetadata(effectiveCwd))
  ) {
    fail(
      "missing_git_metadata",
      `Issue ${issue.identifier ?? issue.id} expected a git workspace for ${input.adapterType}, but "${effectiveCwd}" has no .git metadata.`,
    );
  }

  const expectedManagedBranchName =
    readNonEmptyString(input.executionWorkspace.branchName) ??
    readNonEmptyString(input.persistedExecutionWorkspace?.branchName);
  if (
    input.persistedExecutionWorkspace?.strategyType === "git_worktree" &&
    effectiveCwd &&
    expectedManagedBranchName
  ) {
    const inspection = await inspectManagedGitWorktreeBranch({
      worktreePath: effectiveCwd,
      expectedBranchName: expectedManagedBranchName,
    });
    if (!inspection.valid) {
      fail(
        "git_worktree_branch_mismatch",
        `Issue ${issue.identifier ?? issue.id} expected git worktree branch "${expectedManagedBranchName}" at "${effectiveCwd}", but ${inspection.reason ?? "the checked-out branch could not be verified"}.`,
        {
          managedGitWorktreeBranch:
            formatManagedGitWorktreeBranchInspection(inspection),
        },
      );
    }
  }
}

/**
 * A single read-only referenced (mentioned) project workspace resolved for a run.
 * The run materializes one entry per authorized additional project, each in its own
 * managed checkout directory. See {@link resolveAdditionalRunWorkspaces}.
 */
export type ResolvedAdditionalWorkspace = {
  cwd: string;
  projectId: string;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
};

/**
 * One project-workspace materialization attempt that failed during anchor resolution — for
 * example a managed `git clone` that could not authenticate against a private repository.
 * Carried on {@link ResolvedWorkspaceForRun} so downstream validation can report the real
 * cause instead of the fallback cwd's symptoms. `repoUrl` and `error` are scrubbed of URL
 * userinfo credentials before they are stored.
 */
export type WorkspaceMaterializationFailure = {
  projectWorkspaceId: string | null;
  repoUrl: string | null;
  error: string;
  connectionFailure?: GitConnectionFailure;
};

export type ResolvedWorkspaceForRun = {
  cwd: string;
  source: "project_primary" | "task_session" | "agent_home";
  projectId: string | null;
  workspaceId: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  workspaceHints: Array<{
    workspaceId: string;
    cwd: string | null;
    repoUrl: string | null;
    repoRef: string | null;
  }>;
  warnings: string[];
  /**
   * True when project workspaces exist for the run but none could be used, so `cwd` is the
   * agent-home fallback rather than a configured or materialized project workspace path. The
   * `source` stays `project_primary` in that case (session migration depends on it), so this
   * flag is the only reliable fallback signal.
   */
  baseCwdFallback: boolean;
  /** Failed materialization attempts behind {@link baseCwdFallback}; empty when every candidate resolved or none was attempted. */
  materializationFailures: WorkspaceMaterializationFailure[];
  /** True only for an explicitly configured local project path without a repository URL. */
  localPathOnlyWorkspace?: boolean;
  /** Current configuration for drift reporting; never an alternative restore source. */
  freshnessSource?: { projectId: string | null; workspaceId: string | null; repoUrl: string | null; repoRef: string | null };
  /**
   * Read-only referenced (mentioned) project workspaces for this run, one per authorized
   * additional project. The array is empty unless the multi-project workspace-sync flag is on
   * ({@link isMultiProjectWorkspaceSyncEnabled}); with the flag off the run resolves the anchor
   * workspace only, exactly as before.
   */
  additionalWorkspaces: ResolvedAdditionalWorkspace[];
  /**
   * Structured record of every referenced project that the run dropped or failed, paired with the
   * layer that dropped it. Run preparation reads this to emit the requested-vs-synced observability
   * log. The human-readable form of each drop already rides {@link ResolvedWorkspaceForRun.warnings}.
   */
  referencedProjectFailures: ReferencedProjectFailure[];
};

/** The anchor workspace shape, before the additional referenced workspaces are attached. */
type ResolvedAnchorWorkspaceForRun = Omit<
  ResolvedWorkspaceForRun,
  "additionalWorkspaces" | "referencedProjectFailures"
>;

/**
 * Assemble the run warnings for the agent-home fallback when a project has workspaces but none
 * produced a usable cwd. Materialization failures (for example a failed managed clone) take
 * priority over the generic "no local cwd configured" note, which previously masked them.
 */
export function buildAnchorFallbackWorkspaceNotes(input: {
  fallbackCwd: string;
  preferredWorkspaceWarning: string | null;
  materializationFailures: WorkspaceMaterializationFailure[];
  missingProjectCwds: string[];
  hasConfiguredProjectCwd: boolean;
}): string[] {
  const warnings: string[] = [];
  if (input.preferredWorkspaceWarning) {
    warnings.push(input.preferredWorkspaceWarning);
  }
  if (input.materializationFailures.length > 0) {
    const first = input.materializationFailures[0];
    const extraFailureCount = input.materializationFailures.length - 1;
    warnings.push(
      extraFailureCount > 0
        ? `Failed to prepare the project workspace checkout (${first.error}), and ${extraFailureCount} other candidate workspace(s) also failed. Using fallback workspace "${input.fallbackCwd}" for this run.`
        : `Failed to prepare the project workspace checkout: ${first.error}. Using fallback workspace "${input.fallbackCwd}" for this run.`,
    );
  }
  if (input.missingProjectCwds.length > 0) {
    const firstMissing = input.missingProjectCwds[0];
    const extraMissingCount = Math.max(0, input.missingProjectCwds.length - 1);
    warnings.push(
      extraMissingCount > 0
        ? `Project workspace path "${firstMissing}" and ${extraMissingCount} other configured path(s) are not available yet. Using fallback workspace "${input.fallbackCwd}" for this run.`
        : `Project workspace path "${firstMissing}" is not available yet. Using fallback workspace "${input.fallbackCwd}" for this run.`,
    );
  } else if (
    input.materializationFailures.length === 0 &&
    !input.hasConfiguredProjectCwd
  ) {
    warnings.push(
      `Project workspace has no local cwd configured. Using fallback workspace "${input.fallbackCwd}" for this run.`,
    );
  }
  return warnings;
}

/**
 * Build the plural workspace list that a run exposes to the agent through the
 * `PAPERCLIP_WORKSPACES_JSON` environment variable. The list joins the anchor
 * project's alternative workspace rows with the read-only referenced (mentioned)
 * project workspaces, so every execution target receives the referenced project
 * paths through the same channel the run already uses for the anchor project.
 *
 * Each referenced entry carries its `projectId` so the agent can tell which
 * mentioned project a path belongs to. The referenced set is empty unless the
 * multi-project workspace-sync flag is on, so the exposed list is byte-for-byte
 * unchanged in the production default.
 */
export function buildRunWorkspaceHints(
  resolved: Pick<
    ResolvedWorkspaceForRun,
    "workspaceHints" | "additionalWorkspaces"
  >,
): Array<Record<string, unknown>> {
  return [
    ...resolved.workspaceHints,
    ...resolved.additionalWorkspaces.map((additional) => ({
      workspaceId: additional.workspaceId,
      cwd: additional.cwd,
      repoUrl: additional.repoUrl,
      repoRef: additional.repoRef,
      projectId: additional.projectId,
    })),
  ];
}

type ProjectWorkspaceCandidate = {
  id: string;
};

export function prioritizeProjectWorkspaceCandidatesForRun<
  T extends ProjectWorkspaceCandidate,
>(rows: T[], preferredWorkspaceId: string | null | undefined): T[] {
  if (!preferredWorkspaceId) return rows;
  const preferredIndex = rows.findIndex(
    (row) => row.id === preferredWorkspaceId,
  );
  if (preferredIndex <= 0) return rows;
  return [
    rows[preferredIndex]!,
    ...rows.slice(0, preferredIndex),
    ...rows.slice(preferredIndex + 1),
  ];
}

/**
 * Environment flag (kill-switch, default ON) that gates whether run preparation
 * consumes the multi-project referenced-project set produced by
 * {@link resolveRunReferencedProjects}. The feature is live by default: an unset
 * value resolves ON. An operator disables the feature with an explicit false
 * value (`"false"`, `"0"`, `"off"`, or `""`). While off, a run materializes only
 * the anchor project's workspace exactly as before — the referenced set is inert.
 */
export const MULTI_PROJECT_WORKSPACE_SYNC_ENV =
  "PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC";

/**
 * True when an environment value explicitly turns a flag off. An unset value is
 * not false — the caller decides the unset default. This is the inverse of
 * {@link isTruthyRuntimeEnvValue} for the kill-switch words plus the empty string.
 */
function isFalsyRuntimeEnvValue(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "false" ||
    normalized === "0" ||
    normalized === "off" ||
    normalized === "no"
  );
}

export function isMultiProjectWorkspaceSyncEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Default ON: an unset value is not false, so the feature is live unless an
  // operator sets an explicit false value as the kill switch (rollback path).
  return !isFalsyRuntimeEnvValue(env[MULTI_PROJECT_WORKSPACE_SYNC_ENV]);
}

/**
 * True when an environment driver runs the workspace on a non-local target. The `ssh`, `sandbox`,
 * and `plugin` drivers each realize the workspace off the host, so a host-local directory path is
 * not present on the target. This mirrors the remote-transport classification in
 * {@link buildWorkspaceRealizationRecord}. The `local` driver (and an unknown/absent driver) is
 * treated as local.
 */
export function isRemoteExecutionEnvironmentDriver(
  driver: string | null | undefined,
): boolean {
  return driver === "ssh" || driver === "sandbox" || driver === "plugin";
}

/**
 * Environment flag (kill-switch, default ON) that gates whether a *remote* run stages the
 * referenced (mentioned) project set into the sandbox. This is a targeted rollback lever: it
 * disables only the remote referenced-project path and never regresses the working local path.
 * The master flag {@link MULTI_PROJECT_WORKSPACE_SYNC_ENV} is the blunt switch that kills both
 * local and remote. The remote path runs when both the master flag and this remote flag are ON —
 * the default state. An unset value resolves ON; an operator disables it with an explicit false
 * value (`"false"`, `"0"`, `"off"`, `"no"`, or `""`). The OFF state fails closed: a remote run
 * runs no referenced-project authorization or staging and reverts to the remote drop path.
 */
export const MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV =
  "PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC_REMOTE";

export function isMultiProjectWorkspaceSyncRemoteEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Default ON: an unset value is not false, so the remote path is live unless an operator sets
  // an explicit false value as the targeted kill switch (rollback path).
  return !isFalsyRuntimeEnvValue(env[MULTI_PROJECT_WORKSPACE_SYNC_REMOTE_ENV]);
}

/**
 * True when an environment driver stages a multi-source remote workspace through the confined
 * sandbox/command runtime. Only the `sandbox` driver asserts per-project confinement on the
 * staging path (`assertSyncOperationsConfined` in `sandbox-managed-runtime`). The `ssh` driver
 * stages without that guard, and the `plugin` driver does not route through the confined command
 * runtime in the workspace-realization step, so both keep dropping referenced projects. A `local`
 * (or unknown) driver is not remote and never reaches this check. This gate is intentionally
 * narrower than {@link isRemoteExecutionEnvironmentDriver}: it names the one transport that
 * confines each staged referenced tree.
 */
export function isConfinedRemoteStagingDriver(
  driver: string | null | undefined,
): boolean {
  return driver === "sandbox";
}

/**
 * Upper bound on how many additional (mentioned) projects a single run may materialize
 * beyond the anchor. Bounds the fan-out of per-project authorization and workspace prep.
 */
export const MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS = 10;

/**
 * Upper bound on how many *available* (same-company, hydrated) candidate projects a single run will
 * *authorize* before the admitted-project cap is applied.
 *
 * This is a fan-out guard distinct from {@link MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS}:
 * the admitted cap counts only projects that were successfully authorized, so on its own it
 * does not bound how many `project:read` decisions a run performs — an adversarial same-company
 * mention flood in which every candidate is denied would authorize every candidate before the
 * admitted cap is ever reached. This limit caps the number of authorization decisions regardless of
 * how many candidates are admitted, so denied mentions cannot force unbounded authorization work.
 * Only available candidates count against it — unavailable mentions are filtered by the company-scoped
 * hydration first and never consume an evaluation slot. It is always at least the admitted cap so the
 * admitted cap remains reachable in the normal (non-flood) case.
 */
export const MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS = 50;

type RunReferencedProjectRecord = Awaited<
  ReturnType<ReturnType<typeof projectService>["listByIds"]>
>[number];

export interface RunReferencedProject {
  projectId: string;
  project: RunReferencedProjectRecord;
}

/**
 * The layer that dropped or failed a referenced project. The run surfacing and the
 * observability log both use these values as the per-failure reason:
 * - `authorization`: the run actor is not authorized to read the project.
 * - `resolution`: the project could not be brought into the run locally (unknown or
 *   unavailable project, cap exceeded, or a workspace clone/prepare failure).
 * - `staging`: the project resolved but failed to stage into the run sandbox (the
 *   downstream remote path; see `sandbox-managed-runtime`).
 */
export type ReferencedProjectFailureReason =
  "authorization" | "resolution" | "staging";

/** One referenced project that a run dropped or failed, with the layer that caused it. */
export interface ReferencedProjectFailure {
  projectId: string;
  reason: ReferencedProjectFailureReason;
  /**
   * The failure message, when the layer that dropped the project produced one. A `staging` failure
   * carries the remote extract or sync error here, so a reader of the run log learns why the project
   * dropped. An `authorization` or `resolution` drop omits this field.
   */
  error?: string;
}

export interface ResolvedRunReferencedProjects {
  /** The anchor (primary) project — retains the existing git-worktree run path; never re-authorized here. */
  anchor: RunReferencedProject | null;
  /** Additional read-only referenced projects that each passed per-project `project:read` authorization. */
  additional: RunReferencedProject[];
  /** Human-readable warnings for every referenced project that was dropped (unavailable, unauthorized, or capped). */
  warnings: string[];
  /** Structured record of every dropped referenced project, paired with the layer that dropped it. */
  failures: ReferencedProjectFailure[];
}

export interface ResolveRunReferencedProjectsOptions {
  companyId: string;
  /** The run actor; every additional project is authorized against this actor. */
  actor: AuthorizationActor;
  issues: Pick<ReturnType<typeof issueService>, "findMentionedProjectIds">;
  projects: Pick<ReturnType<typeof projectService>, "listByIds">;
  access: Pick<ReturnType<typeof authorizationService>, "decide">;
  /** Override the additional-project cap (defaults to {@link MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS}). */
  maxAdditionalProjects?: number;
  /**
   * Override the candidate authorization fan-out cap — the maximum number of *available* candidates
   * that are authorized (defaults to {@link MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS}). Always
   * effectively raised to at least the admitted-project cap so the admitted cap stays reachable.
   */
  maxCandidateEvaluations?: number;
}

/**
 * Produce the deduped, company-scoped, per-project-authorized referenced-project set
 * `[anchor, ...additional]` for a run.
 *
 * The anchor keeps its existing issue/run authorization path and is never re-authorized or
 * inherited by the additional projects. Every additional (mentioned) project must independently
 * pass a fail-closed `project:read` authorization check against the run actor before it is
 * admitted — any non-`allowed` decision, company mismatch, missing/unknown project, or thrown
 * authorization error drops the project and appends a warning (the run always continues).
 *
 * Candidate evaluation is bounded twice, independently: at most
 * {@link ResolveRunReferencedProjectsOptions.maxCandidateEvaluations} *available* candidates are ever
 * hydrated and authorized (a fan-out guard against an adversarial same-company mention flood of denied
 * projects), and at most {@link ResolveRunReferencedProjectsOptions.maxAdditionalProjects} of those are
 * admitted. The evaluation cap bounds hydration as well as authorization: candidates are hydrated and
 * availability-filtered in mention order in bounded batches, and hydration stops as soon as the
 * evaluation window is filled with available candidates (or the mention set is exhausted), so hydration
 * never processes the complete mention set — its cost is bounded by the window, not by mention volume.
 * Availability filtering still runs before a candidate consumes an evaluation slot, so an unavailable
 * mention (foreign-company, deleted, or malformed id) never occupies a slot or displaces a later
 * authorized project. Available candidates beyond the evaluation window are left un-hydrated and dropped
 * with a warning, never triggering an authorization decision.
 */
export async function resolveRunReferencedProjects(
  issueId: string,
  anchorProjectId: string | null,
  opts: ResolveRunReferencedProjectsOptions,
): Promise<ResolvedRunReferencedProjects> {
  const { companyId, actor, issues, projects, access } = opts;
  const warnings: string[] = [];
  const failures: ReferencedProjectFailure[] = [];
  const cap = Math.max(
    0,
    opts.maxAdditionalProjects ?? MAX_RUN_REFERENCED_ADDITIONAL_PROJECTS,
  );
  // The evaluation cap bounds candidate hydration + authorization fan-out. It is always at least the
  // admitted cap so the admitted cap stays reachable in the normal (non-flood) case.
  const evaluationCap = Math.max(
    cap,
    opts.maxCandidateEvaluations ?? MAX_RUN_REFERENCED_CANDIDATE_EVALUATIONS,
  );

  // Company-scoped, deduped, order-preserving mention set (title + description + comment bodies).
  // Run prep counts mentions in comments, so comment bodies are always included.
  const mentionedIds = await issues.findMentionedProjectIds(issueId, {
    includeCommentBodies: true,
  });

  // Anchor wins: it keeps the full git-worktree path and is never re-authorized here, so drop it
  // from the mention set. Preserve mention order while deduping the remaining candidates.
  const allCandidateIds: string[] = [];
  const seen = new Set<string>(anchorProjectId ? [anchorProjectId] : []);
  for (const projectId of mentionedIds) {
    if (seen.has(projectId)) continue;
    seen.add(projectId);
    allCandidateIds.push(projectId);
  }

  // Hydrate + availability-filter candidates in mention order, but never process more of the mention
  // set than the evaluation window needs. Candidates are pulled in bounded batches sized to what the
  // window still needs, and hydration stops as soon as `evaluationCap` *available* candidates are
  // collected (or the mention set is exhausted). This bounds hydration by the evaluation window rather
  // than by mention volume: an adversarial same-company mention flood can neither force an unbounded
  // hydration query nor displace a later authorized project out of the window. `listByIds` filters by
  // company, so each batch both fetches the records and performs availability filtering — a mention that
  // did not resolve inside this company (foreign-company, deleted, or malformed id) is dropped here with
  // a warning and never occupies an evaluation slot. The anchor is co-hydrated with the first batch (it
  // was excluded from `allCandidateIds` above, so it never double-counts) and is never re-authorized.
  const availableCandidates: RunReferencedProject[] = [];
  let hydrationCursor = 0;
  let anchorRecord: RunReferencedProjectRecord | null = null;
  let anchorHydrated = false;
  while (
    availableCandidates.length < evaluationCap &&
    hydrationCursor < allCandidateIds.length
  ) {
    const need = evaluationCap - availableCandidates.length;
    const batchCandidateIds = allCandidateIds.slice(
      hydrationCursor,
      hydrationCursor + need,
    );
    hydrationCursor += batchCandidateIds.length;

    const hydrateIds =
      !anchorHydrated && anchorProjectId
        ? [anchorProjectId, ...batchCandidateIds]
        : batchCandidateIds;
    const hydrated = await projects.listByIds(companyId, hydrateIds);
    const byId = new Map(hydrated.map((project) => [project.id, project]));

    if (!anchorHydrated && anchorProjectId) {
      anchorRecord = byId.get(anchorProjectId) ?? null;
      anchorHydrated = true;
    }

    for (const projectId of batchCandidateIds) {
      const project = byId.get(projectId);
      if (!project) {
        warnings.push(
          `Referenced project ${projectId} was skipped because it is not available in this company.`,
        );
        failures.push({ projectId, reason: "resolution" });
        continue;
      }
      availableCandidates.push({ projectId, project });
    }
  }

  // Hydrate the anchor on its own if the candidate loop never ran (no mentions to co-hydrate it with).
  if (!anchorHydrated && anchorProjectId) {
    const hydrated = await projects.listByIds(companyId, [anchorProjectId]);
    anchorRecord =
      hydrated.find((project) => project.id === anchorProjectId) ?? null;
    anchorHydrated = true;
  }

  const anchor: RunReferencedProject | null =
    anchorRecord && anchorProjectId
      ? { projectId: anchorProjectId, project: anchorRecord }
      : null;

  // The loop already bounds `availableCandidates` to at most `evaluationCap` entries. Any mentions left
  // un-hydrated past the window (the fan-out cap dropped them before hydration/authorization) are
  // surfaced as a warning after the admit loop below. Denied candidates still consume this window (each
  // costs exactly one authorization decision, which is what the cap bounds); unavailable mentions,
  // filtered above, do not.
  const candidates = availableCandidates;
  const unevaluatedCandidateCount = allCandidateIds.length - hydrationCursor;

  // Admit candidates in mention order until the cap of successfully-authorized projects is reached.
  // The cap bounds how many additional projects a run *materializes*, so it is counted against
  // admitted projects only; denied mentions never use a slot.
  const additional: RunReferencedProject[] = [];
  let capReachedAtIndex: number | null = null;
  for (let index = 0; index < candidates.length; index++) {
    if (additional.length >= cap) {
      capReachedAtIndex = index;
      break;
    }

    const { projectId, project } = candidates[index]!;

    let allowed = false;
    try {
      const decision = await access.decide({
        actor,
        action: "project:read",
        resource: { type: "project", companyId, projectId },
        scope: { projectId },
      });
      allowed = decision.allowed === true;
    } catch {
      // Fail-closed: an authorization error never admits a project.
      allowed = false;
    }

    if (!allowed) {
      warnings.push(
        `Referenced project ${projectId} was skipped because it is not authorized for this run.`,
      );
      failures.push({ projectId, reason: "authorization" });
      continue;
    }

    additional.push({ projectId, project });
  }

  // Warn once if the admitted cap stopped us before every available candidate was considered. The
  // skipped count includes both the still-unconsidered evaluated candidates and any available
  // candidates that were dropped before evaluation by the fan-out cap above.
  if (capReachedAtIndex !== null) {
    const skipped =
      candidates.length - capReachedAtIndex + unevaluatedCandidateCount;
    warnings.push(
      `Only the first ${cap} referenced project(s) will be synced for this run; ${skipped} additional referenced project(s) were skipped.`,
    );
  } else if (unevaluatedCandidateCount > 0) {
    // The admitted cap was never reached (e.g. a flood of denied mentions), but the evaluation
    // fan-out cap dropped available candidates before they could be authorized.
    warnings.push(
      `Only the first ${evaluationCap} referenced mention(s) were evaluated for this run; ${unevaluatedCandidateCount} additional referenced mention(s) were skipped without evaluation.`,
    );
  }

  // Record every capped or unevaluated candidate as a per-project resolution failure so the run
  // surfacing and the observability log can reconcile requested against synced. The evaluated
  // candidates past the admitted cap carry a known projectId; the candidates the fan-out cap
  // dropped before hydration carry their id from the ordered mention set.
  if (capReachedAtIndex !== null) {
    for (let index = capReachedAtIndex; index < candidates.length; index++) {
      failures.push({
        projectId: candidates[index]!.projectId,
        reason: "resolution",
      });
    }
  }
  for (const projectId of allCandidateIds.slice(hydrationCursor)) {
    failures.push({ projectId, reason: "resolution" });
  }

  return { anchor, additional, warnings, failures };
}

export interface ResolveAdditionalRunWorkspacesOptions {
  /** Gate that mirrors {@link isMultiProjectWorkspaceSyncEnabled}. When false, the result is empty. */
  enabled: boolean;
  companyId: string;
  /** The run actor; every additional project is authorized against this actor. */
  actor: AuthorizationActor;
  issues: Pick<ReturnType<typeof issueService>, "findMentionedProjectIds">;
  projects: Pick<ReturnType<typeof projectService>, "listByIds">;
  access: Pick<ReturnType<typeof authorizationService>, "decide">;
  /** Resolve one authorized referenced project to its own workspace cwd (injectable for tests). */
  resolveProjectWorkspace: (
    project: RunReferencedProject,
  ) => Promise<ResolvedAdditionalWorkspace>;
  maxAdditionalProjects?: number;
  maxCandidateEvaluations?: number;
  /**
   * True when the run executes on a non-local target (ssh, sandbox, or plugin). A referenced
   * project realizes as a local directory first. On a remote target that local tree reaches the
   * agent only when a confined transport stages it into the sandbox and the remote flag is on
   * (see `targetStagesConfined` and `remoteReferencedSyncEnabled`). Otherwise the run drops the
   * whole referenced set and records it at the staging layer.
   */
  executionTargetIsRemote?: boolean;
  /**
   * True when the remote target stages each referenced tree through the confined sandbox/command
   * runtime (the `sandbox` driver; see {@link isConfinedRemoteStagingDriver}). The gate opens the
   * referenced-project path on a remote target only when this is true. The SSH transport and any
   * unconfined transport keep dropping referenced projects. Ignored on a local target.
   */
  targetStagesConfined?: boolean;
  /**
   * The remote-only kill switch (default ON; see {@link isMultiProjectWorkspaceSyncRemoteEnabled}).
   * When true, a confined remote target stages the referenced set. When false, a remote target
   * fails closed: it runs no referenced-project authorization or staging and reverts to the remote
   * drop path. Ignored on a local target.
   */
  remoteReferencedSyncEnabled?: boolean;
}

/**
 * Resolve the read-only referenced (mentioned) project workspaces for a run.
 *
 * The function is inert until the multi-project workspace-sync flag is on: when `enabled` is
 * false (the production default) or there is no issue, it returns an empty result and performs
 * no authorization or workspace work. When enabled, it authorizes the referenced set through
 * {@link resolveRunReferencedProjects} and resolves each admitted project to its own cwd. Each
 * project resolves in isolation: a per-project failure drops only that project and appends a
 * warning, so one bad clone never aborts the run.
 */
export async function resolveAdditionalRunWorkspaces(
  issueId: string | null,
  anchorProjectId: string | null,
  opts: ResolveAdditionalRunWorkspacesOptions,
): Promise<{
  additionalWorkspaces: ResolvedAdditionalWorkspace[];
  warnings: string[];
  failures: ReferencedProjectFailure[];
}> {
  if (!opts.enabled || !issueId) {
    return { additionalWorkspaces: [], warnings: [], failures: [] };
  }

  // A referenced project realizes as a local directory first. On a remote target the run carries
  // that tree to the agent only when a confined transport stages it into the sandbox and the
  // remote flag is on. The confined sandbox transport asserts per-project confinement on each
  // staged tree (`assertSyncOperationsConfined` in `sandbox-managed-runtime`). The SSH transport
  // does not, so it stays out of scope. When the remote flag is off the run fails closed. In every
  // one of those drop cases the run neither does authorization or clone work it must discard nor
  // exposes an inaccessible referenced path to the agent.
  if (opts.executionTargetIsRemote) {
    const remoteReferencedSyncOpen =
      (opts.remoteReferencedSyncEnabled ?? false) &&
      (opts.targetStagesConfined ?? false);
    if (!remoteReferencedSyncOpen) {
      const mentionedIds = await opts.issues.findMentionedProjectIds(issueId, {
        includeCommentBodies: true,
      });
      // Each distinct non-anchor mention is a referenced project this remote run drops. An SSH
      // target (or the remote flag off) has no confined path to receive the referenced tree, so
      // the run drops the whole set at the staging layer. Record one failure per dropped project
      // so the requested-vs-synced accounting counts the whole referenced set and the run still
      // emits its structured sync log. Warn only when the issue actually mentions a project, so a
      // remote run without any referenced mention stays silent.
      const droppedProjectIds = [
        ...new Set(
          mentionedIds.filter((projectId) => projectId !== anchorProjectId),
        ),
      ];
      return {
        additionalWorkspaces: [],
        warnings:
          droppedProjectIds.length > 0
            ? [
                "Referenced-project workspaces are available only on a local execution target or a confined sandbox target. This run uses a different remote execution target, so no referenced-project workspace was attached.",
              ]
            : [],
        failures: droppedProjectIds.map((projectId) => ({
          projectId,
          reason: "staging" as const,
        })),
      };
    }
    // Fall through: a confined sandbox target with the remote flag on resolves and authorizes the
    // referenced set exactly like a local target. The resolver is driver-agnostic; the confined
    // sandbox transport downstream stages each admitted tree into its own `project-<projectId>`
    // directory. The per-project `project:read` check below still runs against the run actor.
  }

  const referenced = await resolveRunReferencedProjects(
    issueId,
    anchorProjectId,
    {
      companyId: opts.companyId,
      actor: opts.actor,
      issues: opts.issues,
      projects: opts.projects,
      access: opts.access,
      maxAdditionalProjects: opts.maxAdditionalProjects,
      maxCandidateEvaluations: opts.maxCandidateEvaluations,
    },
  );

  const additionalWorkspaces: ResolvedAdditionalWorkspace[] = [];
  const warnings = [...referenced.warnings];
  const failures = [...referenced.failures];
  for (const project of referenced.additional) {
    try {
      additionalWorkspaces.push(await opts.resolveProjectWorkspace(project));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(
        `Referenced project ${project.projectId} was skipped because its workspace could not be prepared: ${reason}`,
      );
      failures.push({ projectId: project.projectId, reason: "resolution" });
    }
  }

  return { additionalWorkspaces, warnings, failures };
}

/** Structured fields for the one requested-vs-synced observability log a run emits at run prep. */
export interface ReferencedProjectRunObservability {
  referenced_projects_requested: number;
  referenced_projects_synced: number;
  referenced_project_failures: Array<{
    project_id: string;
    reason: ReferencedProjectFailureReason;
    /** The failure message for a `staging` drop; absent for an `authorization` or `resolution` drop. */
    error?: string;
  }>;
}

/**
 * Build the requested-vs-synced observability fields for a run's referenced-project set.
 *
 * A run requests one referenced project per authorized mention and syncs the projects that resolve.
 * The requested count is the synced count plus every dropped project, so the two counts and the
 * per-failure reasons together account for the whole referenced set. The human-readable warning for
 * each drop rides the run's surfaced warnings channel; this function produces only the structured
 * log fields, so a run emits exactly one line with a stable field shape.
 */
export function buildReferencedProjectRunObservability(input: {
  syncedProjectIds: readonly string[];
  failures: readonly ReferencedProjectFailure[];
}): ReferencedProjectRunObservability {
  return {
    referenced_projects_requested:
      input.syncedProjectIds.length + input.failures.length,
    referenced_projects_synced: input.syncedProjectIds.length,
    referenced_project_failures: input.failures.map((failure) => ({
      project_id: failure.projectId,
      reason: failure.reason,
      // Carry the error only when the layer produced one, so an authorization or resolution drop
      // stays a two-field entry and a staging drop names its reason.
      ...(failure.error !== undefined ? { error: failure.error } : {}),
    })),
  };
}

export function resolveRuntimeSessionParamsForWorkspace(input: {
  agentId: string;
  previousSessionParams: Record<string, unknown> | null;
  resolvedWorkspace: ResolvedWorkspaceForRun;
}) {
  const { agentId, previousSessionParams, resolvedWorkspace } = input;
  const previousSessionId = readNonEmptyString(
    previousSessionParams?.sessionId,
  );
  const previousCwd = readNonEmptyString(previousSessionParams?.cwd);
  if (!previousSessionId || !previousCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (resolvedWorkspace.source !== "project_primary") {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const projectCwd = readNonEmptyString(resolvedWorkspace.cwd);
  if (!projectCwd) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const fallbackAgentHomeCwd = resolveDefaultAgentWorkspaceDir(agentId);
  if (path.resolve(previousCwd) !== path.resolve(fallbackAgentHomeCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  if (path.resolve(projectCwd) === path.resolve(previousCwd)) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }
  const previousWorkspaceId = readNonEmptyString(
    previousSessionParams?.workspaceId,
  );
  if (
    previousWorkspaceId &&
    resolvedWorkspace.workspaceId &&
    previousWorkspaceId !== resolvedWorkspace.workspaceId
  ) {
    return {
      sessionParams: previousSessionParams,
      warning: null as string | null,
    };
  }

  const migratedSessionParams: Record<string, unknown> = {
    ...(previousSessionParams ?? {}),
    cwd: projectCwd,
  };
  if (resolvedWorkspace.workspaceId)
    migratedSessionParams.workspaceId = resolvedWorkspace.workspaceId;
  if (resolvedWorkspace.repoUrl)
    migratedSessionParams.repoUrl = resolvedWorkspace.repoUrl;
  if (resolvedWorkspace.repoRef)
    migratedSessionParams.repoRef = resolvedWorkspace.repoRef;

  return {
    sessionParams: migratedSessionParams,
    warning:
      `Project workspace "${projectCwd}" is now available. ` +
      `Attempting to resume session "${previousSessionId}" that was previously saved in fallback workspace "${previousCwd}".`,
  };
}

const SESSION_AI_CREDENTIAL_IDENTITY_KEY = "paperclipAiCredentialIdentity";

const SESSION_CONFIGURED_MODEL_KEY = "__paperclipConfiguredModel";

const SESSION_CONFIG_FINGERPRINT_KEY = "__paperclipConfigFingerprint";

const SESSION_CONFIG_FINGERPRINT_VERSION_KEY =
  "__paperclipConfigFingerprintVersion";

const SESSION_CONFIG_CATEGORIES_KEY = "__paperclipConfigCategories";

const SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY =
  "__paperclipConfigCategoryFingerprints";

const PAPERCLIP_SESSION_METADATA_KEYS = new Set([
  SESSION_AI_CREDENTIAL_IDENTITY_KEY,
  SESSION_CONFIGURED_MODEL_KEY,
  SESSION_CONFIG_FINGERPRINT_KEY,
  SESSION_CONFIG_FINGERPRINT_VERSION_KEY,
  SESSION_CONFIG_CATEGORIES_KEY,
  SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY,
]);

const WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY = "configFingerprint";

const EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES = [
  "adapter",
  "adapterConfig",
  "agentRuntimeConfig",
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

type EffectiveRunSessionConfigCategory =
  (typeof EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES)[number];

type EffectiveRunWorkspaceConfigCategory =
  (typeof EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES)[number];

export type EffectiveRunSessionConfigMetadata = {
  aiCredentialIdentity?: string;
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

type WorkspaceConfigFreshnessDecisionAction =
  "create" | "reuse" | "refresh" | "replace";

type ExecutionWorkspaceConfigFreshnessDecision = {
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

type ExecutionWorkspaceReuseProvisioningPolicy = {
  shouldRestoreExistingWorkspace: boolean;
  shouldRefreshWorkspaceConfigSnapshot: boolean;
  shouldPersistLatestWorkspaceConfigMetadata: boolean;
};

type WorkspaceReuseIssueRef =
  | {
      id?: string | null;
      identifier?: string | null;
    }
  | null
  | undefined;

export type ExecutionWorkspaceReuseRequestForIssue = {
  requestedExecutionWorkspaceId: string | null;
  requestedShouldReuseExisting: boolean;
  existingExecutionWorkspaceAvailable: boolean;
};

/**
 * Projectless native runs bind their immutable envelope to the run id even
 * though no project-scoped execution-workspace row exists. Treat that value
 * as a reuse request only when it resolves to a persisted workspace row.
 */
export function resolveNativeRecoveryExecutionWorkspaceBinding(input: {
  bindingId: string | null | undefined;
  persistedWorkspaceFound: boolean;
}): string | null {
  const bindingId = readNonEmptyString(input.bindingId);
  return bindingId && input.persistedWorkspaceFound ? bindingId : null;
}

export function resolveExecutionWorkspaceReuseRequestForIssue(input: {
  issueExecutionWorkspaceId?: string | null;
  issueExecutionWorkspacePreference?: string | null;
  existingExecutionWorkspaceStatus?: string | null;
  requestedExistingBranch?: string | null;
  existingExecutionWorkspaceBranchName?: string | null;
}): ExecutionWorkspaceReuseRequestForIssue {
  const requestedExecutionWorkspaceId = readNonEmptyString(
    input.issueExecutionWorkspaceId,
  );
  // An explicitly pinned existing branch outranks an inherited reuse_existing
  // binding: a persisted workspace on any other branch (or with no recorded
  // branch) is stale for this issue, so dispatch realizes the pinned branch.
  const requestedExistingBranch = readNonEmptyString(
    input.requestedExistingBranch,
  );
  const existingWorkspaceMatchesRequestedBranch =
    requestedExistingBranch === null ||
    readNonEmptyString(input.existingExecutionWorkspaceBranchName) ===
      requestedExistingBranch;
  const requestedShouldReuseExisting =
    input.issueExecutionWorkspacePreference === "reuse_existing" &&
    requestedExecutionWorkspaceId !== null &&
    existingWorkspaceMatchesRequestedBranch;

  return {
    requestedExecutionWorkspaceId,
    requestedShouldReuseExisting,
    existingExecutionWorkspaceAvailable:
      requestedShouldReuseExisting &&
      input.existingExecutionWorkspaceStatus !== null &&
      input.existingExecutionWorkspaceStatus !== undefined &&
      input.existingExecutionWorkspaceStatus !== "archived",
  };
}

export function resolveExecutionWorkspaceReuseProvisioningPolicy(input: {
  requestedShouldReuseExisting: boolean;
  workspaceConfigFreshness: ExecutionWorkspaceConfigFreshnessDecision;
}): ExecutionWorkspaceReuseProvisioningPolicy {
  const shouldRestoreExistingWorkspace = input.requestedShouldReuseExisting;
  const replacementClassDrift =
    input.requestedShouldReuseExisting &&
    input.workspaceConfigFreshness.action === "replace";

  return {
    shouldRestoreExistingWorkspace,
    shouldRefreshWorkspaceConfigSnapshot:
      shouldRestoreExistingWorkspace &&
      !replacementClassDrift &&
      input.workspaceConfigFreshness.shouldRefreshConfigSnapshot,
    shouldPersistLatestWorkspaceConfigMetadata: !replacementClassDrift,
  };
}

function formatInheritedExecutionWorkspaceReuseFailure(input: {
  reason:
    | "inherited_workspace_reuse_failed"
    | "inherited_workspace_reuse_unavailable";
  issueRef: WorkspaceReuseIssueRef;
  runId: string;
  executionWorkspaceId: string | null | undefined;
  workspaceConfigFreshness: ExecutionWorkspaceConfigFreshnessDecision;
  cause?: unknown;
}) {
  const issueLabel =
    input.issueRef?.identifier ?? input.issueRef?.id ?? input.runId;
  const workspaceLabel = input.executionWorkspaceId ?? "unknown workspace";
  const causeMessage =
    input.cause instanceof Error
      ? input.cause.message
      : input.cause != null
        ? String(input.cause)
        : null;
  const remediation =
    input.reason === "inherited_workspace_reuse_failed"
      ? "Inspect the referenced execution workspace restore/provision logs, repair or unarchive the workspace, or intentionally clear the issue's reuse_existing workspace binding before retrying."
      : "Repair or unarchive the referenced execution workspace, or intentionally clear the issue's reuse_existing workspace binding before retrying.";
  const message = causeMessage
    ? `Issue ${issueLabel} requested inherited execution workspace reuse for ${workspaceLabel}, but the workspace could not be restored because ${causeMessage}.`
    : `Issue ${issueLabel} requested inherited execution workspace reuse for ${workspaceLabel}, but the workspace could not be restored.`;

  return `${message} ${remediation}`;
}

export async function provisionExecutionWorkspaceForFreshnessDecision<
  T extends { warnings?: string[] },
>(input: {
  requestedShouldReuseExisting: boolean;
  existingExecutionWorkspaceId?: string | null;
  issueRef: WorkspaceReuseIssueRef;
  runId: string;
  workspaceConfigFreshness: ExecutionWorkspaceConfigFreshnessDecision;
  restoreExistingWorkspace?: (() => Promise<T | null>) | null;
  realizeWorkspace: () => Promise<T>;
}): Promise<{
  executionWorkspace: T;
  reusedExecutionWorkspace: T | null;
  policy: ExecutionWorkspaceReuseProvisioningPolicy;
}> {
  const policy = resolveExecutionWorkspaceReuseProvisioningPolicy({
    requestedShouldReuseExisting: input.requestedShouldReuseExisting,
    workspaceConfigFreshness: input.workspaceConfigFreshness,
  });

  if (!policy.shouldRestoreExistingWorkspace) {
    const executionWorkspace = await input.realizeWorkspace();
    return {
      executionWorkspace,
      reusedExecutionWorkspace: null,
      policy,
    };
  }

  let restored: T | null = null;
  let reuseFailure: string | null = null;
  try {
    restored = (await input.restoreExistingWorkspace?.()) ?? null;
  } catch (error) {
    if (isWorkspaceValidationFailure(error)) {
      throw error;
    }
    reuseFailure = formatInheritedExecutionWorkspaceReuseFailure({
      reason: "inherited_workspace_reuse_failed",
      issueRef: input.issueRef,
      runId: input.runId,
      executionWorkspaceId: input.existingExecutionWorkspaceId,
      workspaceConfigFreshness: input.workspaceConfigFreshness,
      cause: error,
    });
  }

  if (!restored) {
    reuseFailure =
      reuseFailure ??
      formatInheritedExecutionWorkspaceReuseFailure({
        reason: "inherited_workspace_reuse_unavailable",
        issueRef: input.issueRef,
        runId: input.runId,
        executionWorkspaceId: input.existingExecutionWorkspaceId,
        workspaceConfigFreshness: input.workspaceConfigFreshness,
      });
  }

  if (reuseFailure) throw new Error(reuseFailure);
  if (!restored) {
    throw new Error(
      "Expected restored execution workspace after reuse fallback handling",
    );
  }

  return {
    executionWorkspace: restored,
    reusedExecutionWorkspace: restored,
    policy,
  };
}

const EFFECTIVE_RUN_SESSION_CONFIG_CATEGORY_LABELS: Record<
  EffectiveRunSessionConfigCategory,
  string
> = {
  adapter: "adapter",
  adapterConfig: "adapter config",
  agentRuntimeConfig: "agent runtime config",
  instructions: "instructions",
  issueOverrides: "issue overrides",
  workspaceConfig: "workspace config",
  environment: "environment",
  envBindings: "env bindings",
  secrets: "secrets",
  runtimeSkills: "runtime skills",
};

const EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORY_LABELS: Record<
  EffectiveRunWorkspaceConfigCategory,
  string
> = {
  mode: "workspace mode",
  projectWorkspace: "project workspace",
  strategy: "workspace strategy",
  repo: "repo/base ref",
  lifecycleCommands: "workspace lifecycle commands",
  runtimeServices: "runtime services",
  environment: "environment",
  realization: "workspace realization",
};

const WORKSPACE_REPLACEMENT_CONFIG_CATEGORIES =
  new Set<EffectiveRunWorkspaceConfigCategory>([
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
  const rawCategories = Array.isArray(
    sessionParams?.[SESSION_CONFIG_CATEGORIES_KEY],
  )
    ? sessionParams?.[SESSION_CONFIG_CATEGORIES_KEY]
    : [];
  return rawCategories.filter(
    (category): category is EffectiveRunSessionConfigCategory =>
      typeof category === "string" &&
      (EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES as readonly string[]).includes(
        category,
      ),
  );
}

export function readConfigFingerprintFromSessionParams(
  sessionParams: Record<string, unknown> | null | undefined,
) {
  if (!sessionParams) return null;
  const fingerprint = readNonEmptyString(
    sessionParams[SESSION_CONFIG_FINGERPRINT_KEY],
  );
  const version = asNumber(
    sessionParams[SESSION_CONFIG_FINGERPRINT_VERSION_KEY],
    0,
  );
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

function describeEffectiveRunConfigCategories(
  categories: readonly EffectiveRunSessionConfigCategory[],
) {
  return categories
    .map((category) => EFFECTIVE_RUN_SESSION_CONFIG_CATEGORY_LABELS[category])
    .join(", ");
}

function changedEffectiveRunSessionConfigCategories(input: {
  previous: Partial<Record<EffectiveRunSessionConfigCategory, string>>;
  next: Record<EffectiveRunSessionConfigCategory, string>;
}) {
  const changed = EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES.filter(
    (category) => input.previous[category] !== input.next[category],
  );
  return changed.length > 0
    ? changed
    : [...EFFECTIVE_RUN_SESSION_CONFIG_CATEGORIES];
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
      (EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES as readonly string[]).includes(
        category,
      ),
  );
}

function readWorkspaceConfigFingerprintFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  const raw = parseObject(
    metadata?.[WORKSPACE_CONFIG_FINGERPRINT_METADATA_KEY],
  );
  const fingerprint =
    readNonEmptyString(raw.workspaceHash) ??
    readNonEmptyString(raw.fingerprint);
  const version = asNumber(raw.version, 0);
  if (!fingerprint || version <= 0) return null;
  return {
    fingerprint,
    version,
    categories: readWorkspaceConfigCategoriesFromMetadata(raw.categories),
    categoryFingerprints: parseStoredWorkspaceConfigCategoryFingerprints(
      raw.categoryFingerprints,
    ),
  };
}

function describeEffectiveRunWorkspaceConfigCategories(
  categories: readonly EffectiveRunWorkspaceConfigCategory[],
) {
  return categories
    .map((category) => EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORY_LABELS[category])
    .join(", ");
}

function changedEffectiveRunWorkspaceConfigCategories(input: {
  previous: Partial<Record<EffectiveRunWorkspaceConfigCategory, string>>;
  next: Record<EffectiveRunWorkspaceConfigCategory, string>;
}) {
  const changed = EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES.filter(
    (category) => input.previous[category] !== input.next[category],
  );
  return changed.length > 0
    ? changed
    : [...EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORIES];
}

function workspaceConfigFreshnessActionLabel(
  action: WorkspaceConfigFreshnessDecisionAction,
) {
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

export function buildWorkspaceConfigFreshnessOperation(
  input: WorkspaceConfigFreshnessOperationInput,
) {
  if (
    !input.reuseRequested ||
    !input.hasExistingWorkspace ||
    input.decision.reasons.length === 0
  ) {
    return null;
  }

  const changedCategoryLabels = input.decision.changedCategories.map(
    (category) => EFFECTIVE_RUN_WORKSPACE_CONFIG_CATEGORY_LABELS[category],
  );
  const categorySummary =
    changedCategoryLabels.length > 0
      ? ` (${changedCategoryLabels.join(", ")})`
      : "";
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
    system: `[paperclip] ${workspaceConfigFreshnessActionLabel(input.decision.action)} after config freshness check${categorySummary}: ${reasonSummary}\n`,
  };
}

export async function recordWorkspaceConfigFreshnessOperation(
  input: WorkspaceConfigFreshnessOperationInput & {
    recorder: WorkspaceOperationRecorder;
    runId: string;
  },
) {
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
      version:
        typeof record.version === "number" && Number.isFinite(record.version)
          ? record.version
          : readNonEmptyString(record.version),
      provider: readNonEmptyString(record.provider),
      providerVersionRef: readNonEmptyString(record.providerVersionRef),
      outcome:
        record.outcome === "success" || record.outcome === "failure"
          ? record.outcome
          : null,
    };
  });
}

async function hashFileContentsForConfigFingerprint(filePath: string) {
  const contents = await fs.readFile(filePath);
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function isPathInsideRoot(input: { rootPath: string; filePath: string }) {
  const relative = path.relative(input.rootPath, input.filePath);
  return (
    relative === "" ||
    (relative.length > 0 &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative))
  );
}

function resolveRootBoundInstructionsFingerprintPath(input: {
  instructionsFilePath: string | null;
  instructionsRootPath: string | null;
  instructionsEntryFile: string | null;
}):
  | { filePath: string; skippedReason: null }
  | { filePath: null; skippedReason: string | null } {
  if (
    !input.instructionsRootPath ||
    !path.isAbsolute(input.instructionsRootPath)
  ) {
    return {
      filePath: null,
      skippedReason: input.instructionsFilePath
        ? "missing_absolute_root"
        : null,
    };
  }

  const rootPath = path.resolve(input.instructionsRootPath);
  const candidatePath =
    input.instructionsEntryFile ?? input.instructionsFilePath;
  if (!candidatePath)
    return { filePath: null, skippedReason: "missing_entry_file" };

  const resolvedPath = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(rootPath, candidatePath);

  if (!isPathInsideRoot({ rootPath, filePath: resolvedPath })) {
    return { filePath: null, skippedReason: "outside_root" };
  }

  return { filePath: resolvedPath, skippedReason: null };
}

async function resolveInstructionsConfigFingerprintMetadata(
  config: Record<string, unknown>,
) {
  const instructionsFilePath = readNonEmptyString(config.instructionsFilePath);
  const instructionsRootPath = readNonEmptyString(config.instructionsRootPath);
  const instructionsEntryFile = readNonEmptyString(
    config.instructionsEntryFile,
  );
  const resolved = resolveRootBoundInstructionsFingerprintPath({
    instructionsFilePath,
    instructionsRootPath,
    instructionsEntryFile,
  });
  const configuredPath =
    resolved.filePath ??
    instructionsFilePath ??
    (instructionsRootPath && instructionsEntryFile
      ? path.resolve(instructionsRootPath, instructionsEntryFile)
      : null);
  if (!configuredPath && !instructionsRootPath && !instructionsEntryFile)
    return null;

  const metadata: Record<string, unknown> = {
    configured: true,
    bundleMode: readNonEmptyString(config.instructionsBundleMode),
    entryFile: instructionsEntryFile,
    pathKind: configuredPath
      ? path.isAbsolute(configuredPath)
        ? "absolute"
        : "relative"
      : null,
    readPolicy: "root_bound",
  };
  if (resolved.skippedReason)
    metadata.readSkippedReason = resolved.skippedReason;
  if (resolved.filePath) {
    try {
      metadata.contentHash = await hashFileContentsForConfigFingerprint(
        resolved.filePath,
      );
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
  agentIdentityKeyId?: string;
}) {
  const sanitizedSecretManifest = sanitizeSecretManifestForConfigFingerprint(
    input.secretManifest,
  );
  const workspaceConfig = { ...parseObject(input.workspaceConfig) };
  // issues.updatedAt also advances for comments and status changes. Those are
  // wake deltas, not execution-workspace configuration changes, so including
  // the timestamp here makes every comment invalidate an otherwise reusable
  // task session.
  delete workspaceConfig.issueConfigRevisionAt;
  // This row is runtime state, not requested configuration. It is absent
  // before the first reusable run is realized and present on the next turn;
  // fingerprinting that transition would rotate the native session exactly
  // when the warm runner first becomes reusable. The requested/effective mode,
  // project policy, and issue settings remain the configuration compatibility
  // boundary; the reusable row and its evolving generation are state.
  delete workspaceConfig.existingExecutionWorkspace;
  delete workspaceConfig.reusableExecutionWorkspaceConfig;
  // Binding the first realized workspace persists its already-effective mode
  // on the issue. That receipt must not rotate the session on the next turn.
  // requestedMode/effectiveMode still fingerprint mode changes, and all other
  // issue settings remain part of the compatibility boundary.
  const issueSettings = { ...parseObject(workspaceConfig.issueSettings) };
  if (issueSettings.mode === workspaceConfig.requestedMode) delete issueSettings.mode;
  workspaceConfig.issueSettings = Object.keys(issueSettings).length ? issueSettings : null;
  return {
    adapter: {
      adapterType: input.adapterType,
      ...(input.agentIdentityKeyId ? { agentIdentityKeyId: input.agentIdentityKeyId } : {}),
      agentConfigRevision: input.agentConfigRevision,
    },
    adapterConfig: input.effectiveAdapterConfig,
    agentRuntimeConfig: input.agentRuntimeConfig,
    instructions: input.instructions,
    issueOverrides: input.issueOverrides,
    workspaceConfig,
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
  managedAiHome?: string;
  agentRuntimeConfig: unknown;
  issueOverrides: unknown;
  workspaceConfig: unknown;
  environment: unknown;
  environmentEnv: unknown;
  projectEnv: unknown;
  routineEnv: unknown;
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
  runtimeSkills: unknown;
  agentConfigRevision?: unknown;
  agentIdentityKeyId?: string;
}): Promise<EffectiveRunSessionConfigMetadata> {
  const secretManifest = input.secretManifest ?? [];
  const instructions = await resolveInstructionsConfigFingerprintMetadata(
    input.effectiveAdapterConfig,
  );
  const categoryValues = buildSessionConfigCategoryValues({
    adapterType: input.adapterType,
    effectiveAdapterConfig: managedAiSessionFingerprintConfig(input.effectiveAdapterConfig, input.managedAiHome),
    agentRuntimeConfig: input.agentRuntimeConfig,
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
    agentIdentityKeyId: input.agentIdentityKeyId,
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
      runtimeProvisionCommand: snapshot.runtimeProvisionCommand ?? null,
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
  const evaluatedAt =
    input.evaluatedAt instanceof Date
      ? input.evaluatedAt.toISOString()
      : (readNonEmptyString(input.evaluatedAt) ?? new Date().toISOString());
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

  const stored = readWorkspaceConfigFingerprintFromMetadata(
    input.existingWorkspaceMetadata,
  );
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
      inferredFingerprint: stored
        ? null
        : (input.inferredMetadata?.fingerprint ?? null),
      nextFingerprint: null,
      storedFingerprintPresent: Boolean(stored),
    };
  }

  if (!previous) {
    return {
      action: "replace",
      shouldReuseExisting: false,
      shouldRefreshConfigSnapshot: false,
      reasons: [
        "execution workspace configuration fingerprint metadata is missing",
      ],
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
      inferredFingerprint: stored
        ? null
        : (input.inferredMetadata?.fingerprint ?? null),
      nextFingerprint: input.nextMetadata.fingerprint,
      storedFingerprintPresent: Boolean(stored),
    };
  }

  if (previous.fingerprint === input.nextMetadata.fingerprint) {
    return {
      action: "reuse",
      shouldReuseExisting: true,
      shouldRefreshConfigSnapshot: !stored,
      reasons: stored
        ? []
        : ["execution workspace configuration fingerprint metadata is missing"],
      changedCategories: [],
      storedFingerprint: stored?.fingerprint ?? null,
      inferredFingerprint: stored
        ? null
        : (input.inferredMetadata?.fingerprint ?? null),
      nextFingerprint: input.nextMetadata.fingerprint,
      storedFingerprintPresent: Boolean(stored),
    };
  }

  const changedCategories = changedEffectiveRunWorkspaceConfigCategories({
    previous: previous.categoryFingerprints,
    next: input.nextMetadata.categoryFingerprints,
  });
  const replacementRequired = changedCategories.some((category) =>
    WORKSPACE_REPLACEMENT_CONFIG_CATEGORIES.has(category),
  );
  const action: WorkspaceConfigFreshnessDecisionAction = replacementRequired
    ? "replace"
    : "refresh";
  return {
    action,
    shouldReuseExisting: action !== "replace",
    shouldRefreshConfigSnapshot: action === "refresh",
    reasons: [
      `execution workspace configuration changed: ${describeEffectiveRunWorkspaceConfigCategories(changedCategories)}`,
    ],
    changedCategories,
    storedFingerprint: stored?.fingerprint ?? null,
    inferredFingerprint: stored
      ? null
      : (input.inferredMetadata?.fingerprint ?? null),
    nextFingerprint: input.nextMetadata.fingerprint,
    storedFingerprintPresent: Boolean(stored),
  };
}

/** Read server-owned identity before adapter codecs discard unknown metadata. */
export function isTaskSessionCredentialCompatible(
  storedSessionParams: Record<string, unknown> | null | undefined,
  managedAiCredentialIdentity: string | undefined,
): boolean {
  if (!managedAiCredentialIdentity) return true;
  return storedSessionParams?.[SESSION_AI_CREDENTIAL_IDENTITY_KEY] === managedAiCredentialIdentity;
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
    if (configMetadata.aiCredentialIdentity) next[SESSION_AI_CREDENTIAL_IDENTITY_KEY] = configMetadata.aiCredentialIdentity;
    next[SESSION_CONFIG_FINGERPRINT_KEY] = configMetadata.fingerprint;
    next[SESSION_CONFIG_FINGERPRINT_VERSION_KEY] = configMetadata.version;
    next[SESSION_CONFIG_CATEGORIES_KEY] = configMetadata.categories;
    next[SESSION_CONFIG_CATEGORY_FINGERPRINTS_KEY] =
      configMetadata.categoryFingerprints;
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
  compatibleConfigMetadata?: readonly EffectiveRunSessionConfigMetadata[];
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
  const storedConfig = readConfigFingerprintFromSessionParams(
    input.taskSessionParams,
  );
  const taskSessionConfiguredModel = readConfiguredModelFromSessionParams(
    input.taskSessionParams,
  );
  const modelChangedSinceTaskSession = shouldResetTaskSessionForModelChange({
    configuredModel: input.configuredModel,
    taskSessionParams: input.taskSessionParams,
  });
  if (modelChangedSinceTaskSession && taskSessionConfiguredModel) {
    reasons.push(
      `configured model changed from "${taskSessionConfiguredModel}" to "${input.configuredModel}"`,
    );
  }

  let changedCategories: EffectiveRunSessionConfigCategory[] = [];
  if (input.configMetadata) {
    if (!storedConfig && !input.preserveLegacySessionWithoutConfigMetadata) {
      changedCategories = [...input.configMetadata.categories];
      reasons.push(
        "effective run configuration fingerprint metadata is missing",
      );
    } else if (
      storedConfig &&
      storedConfig.version !== input.configMetadata.version
    ) {
      changedCategories = [...input.configMetadata.categories];
      reasons.push(
        `effective run configuration fingerprint version changed from ${storedConfig.version} to ${input.configMetadata.version}`,
      );
    } else if (
      storedConfig &&
      storedConfig.fingerprint !== input.configMetadata.fingerprint &&
      !input.compatibleConfigMetadata?.some(candidate => candidate.version === storedConfig.version && candidate.fingerprint === storedConfig.fingerprint)
    ) {
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

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** Database-bound workspace resolution for a heartbeat service instance. */
export function createHeartbeatWorkspaceResolver(db: Db) {
  async function resolveReusedGitWorkspaceAnchor(input: {
    agent: typeof agents.$inferSelect;
    workspace: ExecutionWorkspace;
    projectId: string | null;
    explicitProjectWorkspaceId: string | null;
    issueId: string | null;
    runId: string;
    responsibleUserId: string | null;
    immutableNativeBinding: boolean;
  }): Promise<ResolvedAnchorWorkspaceForRun> {
    const { workspace, agent } = input;
    // Configuration preparation may have awaited credentials and skills since
    // issueRef was read. Match the ordinary anchor resolver's fresh selection
    // check; only an already-admitted native input owns immutable source scope.
    const currentIssueSource = input.issueId && !input.immutableNativeBinding
      ? await db.select({ projectId: issues.projectId, projectWorkspaceId: issues.projectWorkspaceId }).from(issues)
          .where(and(eq(issues.id, input.issueId), eq(issues.companyId, agent.companyId))).then(rows => rows[0] ?? null)
      : null;
    const sourceProjectId = workspace.projectId;
    const explicitProjectWorkspaceId = currentIssueSource?.projectWorkspaceId ?? input.explicitProjectWorkspaceId;
    const projectWorkspaceRows = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, agent.companyId),
      workspace.projectId ? eq(projectWorkspaces.projectId, workspace.projectId) : sql`false`,
    )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
    const boundProjectWorkspace = projectWorkspaceRows.find(row => row.id === workspace.projectWorkspaceId) ?? null;
    const configuredSource = prioritizeProjectWorkspaceCandidatesForRun(projectWorkspaceRows, explicitProjectWorkspaceId)[0];
    const managedBase = workspace.repoUrl && workspace.projectId ? resolveManagedProjectWorkspaceDir({
      companyId: agent.companyId,
      projectId: workspace.projectId,
      repoName: deriveRepoNameFromRepoUrl(workspace.repoUrl),
    }) : null;
    const candidateBaseCwds = [
      managedBase,
      managedBase && workspace.repoUrl
        ? `${managedBase}-${createHash("sha256").update(workspace.repoUrl).digest("hex").slice(0, 12)}` : null,
    ].filter((value): value is string => Boolean(value));
    const cwd = await resolvePersistedGitWorkspaceSource({
      companyId: agent.companyId,
      projectId: sourceProjectId,
      explicitProjectWorkspaceId,
      workspace,
      boundProjectWorkspace,
      candidateBaseCwds,
      managedSourceRoot: resolvePaperclipInstanceRoot(),
      materializeOriginalRepository: workspace.repoUrl && workspace.projectId ? async () => {
        const original = await ensureManagedProjectWorkspace({
          companyId: agent.companyId,
          projectId: workspace.projectId!,
          repoUrl: workspace.repoUrl,
          resolveGitAuth: createGitRemoteAuthProvider(db, agent.companyId, {
            issueId: input.issueId, heartbeatRunId: input.runId, agentId: agent.id,
            responsibleUserId: input.responsibleUserId,
          }),
        });
        return original.cwd;
      } : undefined,
    });
    return {
      cwd,
      source: "task_session",
      projectId: workspace.projectId,
      workspaceId: workspace.projectWorkspaceId,
      repoUrl: workspace.repoUrl,
      repoRef: workspace.baseRef,
      // Freshness must still expose drift in current project configuration.
      // This snapshot authorizes no filesystem lookup or repository fallback.
      freshnessSource: {
        projectId: workspace.projectId,
        workspaceId: configuredSource?.id ?? null,
        repoUrl: configuredSource?.repoUrl ?? null,
        repoRef: configuredSource?.repoRef ?? null,
      },
      workspaceHints: [],
      warnings: [],
      baseCwdFallback: false,
      materializationFailures: [],
    };
  }

  async function resolveAnchorWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: { useProjectWorkspace?: boolean | null; configuredCwd?: string | null },
  ): Promise<ResolvedAnchorWorkspaceForRun> {
    const issueId =
      readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
    const resolveGitAuth = createGitRemoteAuthProvider(db, agent.companyId, {
      issueId,
      heartbeatRunId: readNonEmptyString(context.executionIdentityRunId),
      responsibleUserId:
        readNonEmptyString(context.responsibleUserId) ??
        readNonEmptyString(context.responsible_user_id),
      agentId: agent.id,
    });
    const contextProjectId = readNonEmptyString(context.projectId);
    const contextProjectWorkspaceId = readNonEmptyString(
      context.projectWorkspaceId,
    );
    const issueProjectRef = issueId
      ? await db
          .select({
            projectId: issues.projectId,
            projectWorkspaceId: issues.projectWorkspaceId,
            workspaceSelection: issues.workspaceSelection,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId)),
          )
          .then((rows) => rows[0] ?? null)
      : null;
    const issueProjectId = issueProjectRef?.projectId ?? null;
    const workspaceSelection = issueProjectRef?.workspaceSelection?.selection;
    const configuredSourceId = workspaceSelection?.kind === "configured_source"
      ? workspaceSelection.projectWorkspaceId : null;
    const preferredProjectWorkspaceId =
      configuredSourceId ?? issueProjectRef?.projectWorkspaceId ?? contextProjectWorkspaceId ?? null;
    const [selectedSource] = preferredProjectWorkspaceId ? await db.select({ projectId: projectWorkspaces.projectId }).from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.id, preferredProjectWorkspaceId), eq(projectWorkspaces.companyId, agent.companyId))) : [];
    const resolvedProjectId = selectedSource?.projectId ?? issueProjectId ?? contextProjectId;
    const forceTaskDirectory = workspaceSelection?.kind === "task_directory";
    const useProjectWorkspace = opts?.useProjectWorkspace !== false;
    const workspaceProjectId = useProjectWorkspace && !forceTaskDirectory ? resolvedProjectId : null;

    const unorderedProjectWorkspaceRows = workspaceProjectId
      ? await db
          .select()
          .from(projectWorkspaces)
          .where(
            and(
              eq(projectWorkspaces.companyId, agent.companyId),
              eq(projectWorkspaces.projectId, workspaceProjectId),
            ),
          )
          .orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id))
      : [];
    const prioritizedWorkspaceRows = prioritizeProjectWorkspaceCandidatesForRun(
      unorderedProjectWorkspaceRows,
      preferredProjectWorkspaceId,
    );
    // A durable source choice names the filesystem authority, not a preference
    // among the project's repositories. Never label another checkout with it.
    const projectWorkspaceRows = configuredSourceId
      ? prioritizedWorkspaceRows.filter((workspace) => workspace.id === configuredSourceId)
      : prioritizedWorkspaceRows;

    const workspaceHints = projectWorkspaceRows.map((workspace) => ({
      workspaceId: workspace.id,
      cwd: readNonEmptyString(workspace.cwd),
      repoUrl: readNonEmptyString(workspace.repoUrl),
      repoRef: readNonEmptyString(workspace.repoRef),
    }));

    if (projectWorkspaceRows.length > 0 || configuredSourceId) {
      const preferredWorkspace = preferredProjectWorkspaceId
        ? (projectWorkspaceRows.find(
            (workspace) => workspace.id === preferredProjectWorkspaceId,
          ) ?? null)
        : null;
      const missingProjectCwds: string[] = [];
      const materializationFailures: WorkspaceMaterializationFailure[] = [];
      let hasConfiguredProjectCwd = false;
      let preferredWorkspaceWarning: string | null = null;
      if (preferredProjectWorkspaceId && !preferredWorkspace) {
        preferredWorkspaceWarning = `Selected project workspace "${preferredProjectWorkspaceId}" is not available on this project.`;
      }
      for (const workspace of projectWorkspaceRows) {
        let projectCwd: string;
        let managedWorkspaceWarning: string | null = null;
        try {
          const resolvedCwd = await resolveConfiguredOrManagedProjectCwd({
            companyId: agent.companyId,
            projectId:
              workspaceProjectId ?? resolvedProjectId ?? workspace.projectId,
            cwd: workspace.cwd,
            repoUrl: workspace.repoUrl,
            resolveGitAuth,
          });
          projectCwd = resolvedCwd.cwd;
          managedWorkspaceWarning = resolvedCwd.warning;
        } catch (error) {
          const scrubbedError = scrubGitCredentialText(
            error instanceof Error ? error.message : String(error),
          );
          const workspaceRepoUrl = readNonEmptyString(workspace.repoUrl);
          const connectionFailure = readGitConnectionFailure(error);
          materializationFailures.push({
            projectWorkspaceId: workspace.id,
            repoUrl: workspaceRepoUrl
              ? scrubGitCredentialText(workspaceRepoUrl)
              : null,
            error: scrubbedError,
            ...(connectionFailure ? { connectionFailure } : {}),
          });
          if (preferredWorkspace?.id === workspace.id) {
            preferredWorkspaceWarning = scrubbedError;
          }
          continue;
        }
        hasConfiguredProjectCwd = true;
        const projectCwdExists = await fs
          .stat(projectCwd)
          .then((stats) => stats.isDirectory())
          .catch(() => false);
        if (projectCwdExists) {
          return {
            cwd: projectCwd,
            source: "project_primary" as const,
            projectId: resolvedProjectId,
            workspaceId: workspace.id,
            repoUrl: workspace.repoUrl,
            repoRef: workspace.repoRef,
            workspaceHints,
            warnings: [
              preferredWorkspaceWarning,
              managedWorkspaceWarning,
            ].filter((value): value is string => Boolean(value)),
            baseCwdFallback: false,
            materializationFailures,
            localPathOnlyWorkspace:
              (workspace.sourceType === "local_path" || workspace.sourceType === "non_git_path") &&
              Boolean(readNonEmptyString(workspace.cwd)) && workspace.cwd !== REPO_ONLY_CWD_SENTINEL &&
              !readNonEmptyString(workspace.repoUrl),
          };
        }
        if (preferredWorkspace?.id === workspace.id) {
          preferredWorkspaceWarning = `Selected project workspace path "${projectCwd}" is not available yet.`;
        }
        missingProjectCwds.push(projectCwd);
      }

      const connections = materializationFailures.map((failure) => readConnectionFailure(failure.connectionFailure));
      const connectionFailure = connections.length > 0 && connections.every((failure) => failure?.provider === "git")
        ? connections[0] as GitConnectionFailure : undefined;
      throw new WorkspaceValidationFailure(
        `Configured project workspace is unavailable: ${preferredWorkspaceWarning ?? materializationFailures[0]?.error ?? missingProjectCwds[0] ?? "source could not be prepared"}. Repair the configured path or repository access, then retry.`,
        {
          ...(connectionFailure ? { connectionFailure } : {}),
          workspaceValidation: {
            reason: materializationFailures.length > 0 ? "git_worktree_base_materialization_failed" : "configured_workspace_unavailable",
            issueId,
            issueProjectId,
            issueProjectWorkspaceId: preferredProjectWorkspaceId,
            resolvedWorkspaceSource: "project_primary",
            resolvedProjectId,
            resolvedProjectWorkspaceId: preferredWorkspace?.id ?? null,
            baseCwdFallback: false,
            materializationFailures,
          },
        },
      );
    }

    const sessionCwd = readNonEmptyString(previousSessionParams?.cwd);
    const sessionCwdLooksUnsafe = isUnsafeSessionWorkspaceCwd(sessionCwd);
    if (!forceTaskDirectory && sessionCwd && !sessionCwdLooksUnsafe) {
      const sessionCwdExists = await fs
        .stat(sessionCwd)
        .then((stats) => stats.isDirectory())
        .catch(() => false);
      if (sessionCwdExists) {
        return {
          cwd: sessionCwd,
          source: "task_session" as const,
          projectId: resolvedProjectId,
          workspaceId: readNonEmptyString(previousSessionParams?.workspaceId),
          repoUrl: readNonEmptyString(previousSessionParams?.repoUrl),
          repoRef: readNonEmptyString(previousSessionParams?.repoRef),
          workspaceHints,
          warnings: [],
          baseCwdFallback: false,
          materializationFailures: [],
        };
      }
    }

    const configuredCwd = forceTaskDirectory ? null
      : opts?.configuredCwd !== undefined ? opts.configuredCwd
      : readNonEmptyString(parseObject(agent.adapterConfig).cwd);
    const cwd = configuredCwd ? path.resolve(configuredCwd)
      : issueId ? await materializeIsolatedTaskDirectory({ companyId: agent.companyId, issueId })
      : resolveDefaultAgentWorkspaceDir(agent.id);
    await fs.mkdir(cwd, { recursive: true });
    const warnings: string[] = [];
    if (sessionCwd && sessionCwdLooksUnsafe) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" points at a system temp root and was rejected as untrusted. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (sessionCwd) {
      warnings.push(
        `Saved session workspace "${sessionCwd}" is not available. Using fallback workspace "${cwd}" for this run.`,
      );
    } else if (resolvedProjectId) {
      warnings.push(
        `No project workspace directory is currently available for this issue. Using fallback workspace "${cwd}" for this run.`,
      );
    } else {
      warnings.push(
        `No project or prior session workspace was available. Using fallback workspace "${cwd}" for this run.`,
      );
    }
    return {
      cwd,
      source: issueId || configuredCwd ? "task_session" as const : "agent_home" as const,
      projectId: null,
      workspaceId: null,
      repoUrl: null,
      repoRef: null,
      workspaceHints,
      warnings,
      baseCwdFallback: false,
      materializationFailures: [],
    };
  }

  /**
   * Resolve the run workspace: the anchor workspace plus, when the multi-project workspace-sync
   * flag is on, the read-only referenced (mentioned) project workspaces. With the flag off (the
   * production default) the anchor path is unchanged and `additionalWorkspaces` is empty.
   */
  async function resolveWorkspaceForRun(
    agent: typeof agents.$inferSelect,
    context: Record<string, unknown>,
    previousSessionParams: Record<string, unknown> | null,
    opts?: {
      useProjectWorkspace?: boolean | null;
      configuredCwd?: string | null;
      executionEnvironmentDriver?: string | null;
      anchorWorkspace?: ResolvedAnchorWorkspaceForRun;
    },
  ): Promise<ResolvedWorkspaceForRun> {
    const anchor = opts?.anchorWorkspace ?? await resolveAnchorWorkspaceForRun(
      agent,
      context,
      previousSessionParams,
      opts,
    );
    if (!isMultiProjectWorkspaceSyncEnabled()) {
      return {
        ...anchor,
        additionalWorkspaces: [],
        referencedProjectFailures: [],
      };
    }

    // Derive the remote-transport facts from the selected environment driver. `executionTargetIsRemote`
    // decides whether the referenced set needs the remote path at all; `targetStagesConfined` decides
    // whether that remote target confines each staged tree (only the sandbox driver does). The remote
    // flag is the targeted kill switch; with it off, a remote run fails closed.
    const executionEnvironmentDriver = opts?.executionEnvironmentDriver ?? null;
    const issueId =
      readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
    const resolveGitAuth = createGitRemoteAuthProvider(db, agent.companyId, {
      issueId,
      heartbeatRunId: readNonEmptyString(context.executionIdentityRunId),
      responsibleUserId:
        readNonEmptyString(context.responsibleUserId) ??
        readNonEmptyString(context.responsible_user_id),
      agentId: agent.id,
    });
    const { additionalWorkspaces, warnings, failures } =
      await resolveAdditionalRunWorkspaces(issueId, anchor.projectId, {
        enabled: true,
        executionTargetIsRemote: isRemoteExecutionEnvironmentDriver(
          executionEnvironmentDriver,
        ),
        targetStagesConfined: isConfinedRemoteStagingDriver(
          executionEnvironmentDriver,
        ),
        remoteReferencedSyncEnabled: isMultiProjectWorkspaceSyncRemoteEnabled(),
        companyId: agent.companyId,
        actor: {
          type: "agent",
          agentId: agent.id,
          companyId: agent.companyId,
          source: "agent_key",
        },
        issues: issueService(db),
        projects: projectService(db),
        access: authorizationService(db),
        resolveProjectWorkspace: (project) =>
          resolveAdditionalProjectWorkspace(
            { companyId: agent.companyId, project },
            defaultAdditionalProjectWorkspaceDeps(db, resolveGitAuth),
          ),
      });

    return {
      ...anchor,
      additionalWorkspaces,
      referencedProjectFailures: failures,
      warnings:
        warnings.length > 0
          ? [...anchor.warnings, ...warnings]
          : anchor.warnings,
    };
  }

  return {
    resolveReusedGitWorkspaceAnchor,
    resolveWorkspaceForRun,
  };
}
