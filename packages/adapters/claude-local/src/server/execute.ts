import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_ENDPOINTS, isThirdPartyModel, resolveProviderLabel } from "../index.js";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";
import {
  asString,
  asNumber,
  asBoolean,
  asStringArray,
  parseObject,
  parseJson,
  buildPaperclipEnv,
  readPaperclipRuntimeSkillEntries,
  joinPromptSections,
  redactEnvForLogs,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  renderTemplate,
  runChildProcess,
} from "@paperclipai/adapter-utils/server-utils";
import {
  parseClaudeStreamJson,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  isClaudeMaxTurnsResult,
  isClaudeUnknownSessionError,
} from "./parse.js";
import { resolveClaudeDesiredSkillNames } from "./skills.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create a tmpdir with `.claude/skills/` containing symlinks to skills from
 * the repo's `skills/` directory, so `--add-dir` makes Claude Code discover
 * them as proper registered skills.
 */
async function buildSkillsDir(config: Record<string, unknown>): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-skills-"));
  const target = path.join(tmp, ".claude", "skills");
  await fs.mkdir(target, { recursive: true });
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredNames = new Set(
    resolveClaudeDesiredSkillNames(
      config,
      availableEntries,
    ),
  );
  for (const entry of availableEntries) {
    if (!desiredNames.has(entry.key)) continue;
    await fs.symlink(
      entry.source,
      path.join(target, entry.runtimeName),
    );
  }
  return tmp;
}

interface ClaudeExecutionInput {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  authToken?: string;
}

interface ClaudeRuntimeConfig {
  command: string;
  cwd: string;
  workspaceId: string | null;
  workspaceRepoUrl: string | null;
  workspaceRepoRef: string | null;
  env: Record<string, string>;
  timeoutSec: number;
  graceSec: number;
  extraArgs: string[];
}

function buildLoginResult(input: {
  proc: RunProcessResult;
  loginUrl: string | null;
}) {
  return {
    exitCode: input.proc.exitCode,
    signal: input.proc.signal,
    timedOut: input.proc.timedOut,
    stdout: input.proc.stdout,
    stderr: input.proc.stderr,
    loginUrl: input.loginUrl,
  };
}

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function resolveClaudeBillingType(env: Record<string, string>): "api" | "subscription" {
  // Claude uses API-key auth when ANTHROPIC_API_KEY is present; otherwise rely on local login/session auth.
  return hasNonEmptyEnvValue(env, "ANTHROPIC_API_KEY") ? "api" : "subscription";
}

async function buildClaudeRuntimeConfig(input: ClaudeExecutionInput): Promise<ClaudeRuntimeConfig> {
  const { runId, agent, config, context, authToken } = input;

  const command = asString(config.command, "claude");
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceStrategy = asString(workspaceContext.strategy, "");
  const workspaceId = asString(workspaceContext.workspaceId, "") || null;
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "") || null;
  const workspaceRepoRef = asString(workspaceContext.repoRef, "") || null;
  const workspaceBranch = asString(workspaceContext.branchName, "") || null;
  const workspaceWorktreePath = asString(workspaceContext.worktreePath, "") || null;
  const agentHome = asString(workspaceContext.agentHome, "") || null;
  const workspaceHints = Array.isArray(context.paperclipWorkspaces)
    ? context.paperclipWorkspaces.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServiceIntents = Array.isArray(context.paperclipRuntimeServiceIntents)
    ? context.paperclipRuntimeServiceIntents.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimeServices = Array.isArray(context.paperclipRuntimeServices)
    ? context.paperclipRuntimeServices.filter(
        (value): value is Record<string, unknown> => typeof value === "object" && value !== null,
      )
    : [];
  const runtimePrimaryUrl = asString(context.paperclipRuntimePrimaryUrl, "");
  const configuredCwd = asString(config.cwd, "");
  const useConfiguredInsteadOfAgentHome = workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  await ensureAbsoluteDirectory(cwd, { createIfMissing: true });

  const envConfig = parseObject(config.env);
  const hasExplicitApiKey =
    typeof envConfig.PAPERCLIP_API_KEY === "string" && envConfig.PAPERCLIP_API_KEY.trim().length > 0;
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;

  const wakeTaskId =
    (typeof context.taskId === "string" && context.taskId.trim().length > 0 && context.taskId.trim()) ||
    (typeof context.issueId === "string" && context.issueId.trim().length > 0 && context.issueId.trim()) ||
    null;
  const wakeReason =
    typeof context.wakeReason === "string" && context.wakeReason.trim().length > 0
      ? context.wakeReason.trim()
      : null;
  const wakeCommentId =
    (typeof context.wakeCommentId === "string" && context.wakeCommentId.trim().length > 0 && context.wakeCommentId.trim()) ||
    (typeof context.commentId === "string" && context.commentId.trim().length > 0 && context.commentId.trim()) ||
    null;
  const approvalId =
    typeof context.approvalId === "string" && context.approvalId.trim().length > 0
      ? context.approvalId.trim()
      : null;
  const approvalStatus =
    typeof context.approvalStatus === "string" && context.approvalStatus.trim().length > 0
      ? context.approvalStatus.trim()
      : null;
  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  if (wakeTaskId) {
    env.PAPERCLIP_TASK_ID = wakeTaskId;
  }
  if (wakeReason) {
    env.PAPERCLIP_WAKE_REASON = wakeReason;
  }
  if (wakeCommentId) {
    env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;
  }
  if (approvalId) {
    env.PAPERCLIP_APPROVAL_ID = approvalId;
  }
  if (approvalStatus) {
    env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;
  }
  if (linkedIssueIds.length > 0) {
    env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");
  }
  if (effectiveWorkspaceCwd) {
    env.PAPERCLIP_WORKSPACE_CWD = effectiveWorkspaceCwd;
  }
  if (workspaceSource) {
    env.PAPERCLIP_WORKSPACE_SOURCE = workspaceSource;
  }
  if (workspaceStrategy) {
    env.PAPERCLIP_WORKSPACE_STRATEGY = workspaceStrategy;
  }
  if (workspaceId) {
    env.PAPERCLIP_WORKSPACE_ID = workspaceId;
  }
  if (workspaceRepoUrl) {
    env.PAPERCLIP_WORKSPACE_REPO_URL = workspaceRepoUrl;
  }
  if (workspaceRepoRef) {
    env.PAPERCLIP_WORKSPACE_REPO_REF = workspaceRepoRef;
  }
  if (workspaceBranch) {
    env.PAPERCLIP_WORKSPACE_BRANCH = workspaceBranch;
  }
  if (workspaceWorktreePath) {
    env.PAPERCLIP_WORKSPACE_WORKTREE_PATH = workspaceWorktreePath;
  }
  if (agentHome) {
    env.AGENT_HOME = agentHome;
  }
  if (workspaceHints.length > 0) {
    env.PAPERCLIP_WORKSPACES_JSON = JSON.stringify(workspaceHints);
  }
  if (runtimeServiceIntents.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICE_INTENTS_JSON = JSON.stringify(runtimeServiceIntents);
  }
  if (runtimeServices.length > 0) {
    env.PAPERCLIP_RUNTIME_SERVICES_JSON = JSON.stringify(runtimeServices);
  }
  if (runtimePrimaryUrl) {
    env.PAPERCLIP_RUNTIME_PRIMARY_URL = runtimePrimaryUrl;
  }

  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }

  if (!hasExplicitApiKey && authToken) {
    env.PAPERCLIP_API_KEY = authToken;
  }

  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  await ensureCommandResolvable(command, cwd, runtimeEnv);

  const timeoutSec = asNumber(config.timeoutSec, 0);
  const graceSec = asNumber(config.graceSec, 20);
  const extraArgs = (() => {
    const fromExtraArgs = asStringArray(config.extraArgs);
    if (fromExtraArgs.length > 0) return fromExtraArgs;
    return asStringArray(config.args);
  })();

  return {
    command,
    cwd,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  };
}

export async function runClaudeLogin(input: {
  runId: string;
  agent: AdapterExecutionContext["agent"];
  config: Record<string, unknown>;
  context?: Record<string, unknown>;
  authToken?: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}) {
  const onLog = input.onLog ?? (async () => {});
  const runtime = await buildClaudeRuntimeConfig({
    runId: input.runId,
    agent: input.agent,
    config: input.config,
    context: input.context ?? {},
    authToken: input.authToken,
  });

  const proc = await runChildProcess(input.runId, runtime.command, ["login"], {
    cwd: runtime.cwd,
    env: runtime.env,
    timeoutSec: runtime.timeoutSec,
    graceSec: runtime.graceSec,
    onLog,
  });

  const loginMeta = detectClaudeLoginRequired({
    parsed: null,
    stdout: proc.stdout,
    stderr: proc.stderr,
  });

  return buildLoginResult({
    proc,
    loginUrl: loginMeta.loginUrl,
  });
}

// ----------------------------------------------------------------------------
// Per-agent worktree provisioning (freemymemories/local-customizations)
//
// When adapterConfig.worktreeEnabled === true, the adapter provisions a
// fresh git worktree per wake, pre-sets git identity + GH_TOKEN from the
// macOS keychain, and (on session exit) pushes the branch + opens a PR.
// Cleans up the worktree/branch regardless of exit code.
//
// Design plan: /Users/openclaw/.claude/plans/okay-this-is-clearly-luminous-goblet.md
// (Layer 5 — Modified `claude_local` adapter).
//
// Agent's HEARTBEAT no longer needs any git plumbing — the cwd is already
// inside `<wkt>/_workspaces/<slug>/` on a task-scoped branch, and the
// adapter opens the PR on exit. Direct pushes to master/main are blocked
// by a separate user-global PreToolUse hook (Layer 3).
// ----------------------------------------------------------------------------

interface WorktreeConfig {
  enabled: boolean;
  agentSlug: string;
  agentName: string;
  gitEmail: string;
  primaryRepo: string;
  secondaryRepo: string | null;
  primaryBase: string;
  secondaryBase: string | null;
  autoMergeLabel: string;
  keychainService: string;
}

interface ProvisionedWorktree {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  base: string;
  isPrimary: boolean;
}

interface WorktreeProvisionResult {
  config: WorktreeConfig;
  primary: ProvisionedWorktree;
  secondary: ProvisionedWorktree | null;
  patToken: string | null;
  sessionCwd: string;
  envAdditions: Record<string, string>;
}

function parseWorktreeConfig(config: Record<string, unknown>): WorktreeConfig | null {
  const enabled = asBoolean(config.worktreeEnabled, false);
  if (!enabled) return null;
  const agentSlug = asString(config.agentSlug, "").trim();
  const primaryRepo = asString(config.primaryRepo, "").trim();
  if (!agentSlug || !primaryRepo) return null;
  return {
    enabled: true,
    agentSlug,
    agentName: asString(config.agentName, agentSlug),
    gitEmail: asString(config.gitEmail, `${agentSlug}@freemymemories.com`),
    primaryRepo,
    secondaryRepo: asString(config.secondaryRepo, "").trim() || null,
    primaryBase: asString(config.primaryBase, "master"),
    secondaryBase: asString(config.secondaryBase, "").trim() || null,
    autoMergeLabel: asString(config.autoMergeLabel, "auto-merge:approved"),
    keychainService: asString(config.keychainService, "paperclip.github.pat."),
  };
}

function sanitizeBranchName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

function runGit(repoOrWkt: string, args: string[], allowFail = false): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", ["-C", repoOrWkt, ...args], {
    encoding: "utf-8",
  });
  const ok = res.status === 0;
  if (!ok && !allowFail) {
    // caller will decide; we don't throw here
  }
  return { ok, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

function readKeychainPat(service: string, account = "paperclip"): string | null {
  const res = spawnSync("security", ["find-generic-password", "-a", account, "-s", service, "-w"], {
    encoding: "utf-8",
  });
  if (res.status !== 0) return null;
  const token = (res.stdout || "").trim();
  return token.length > 0 ? token : null;
}

function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  // Accept git@github.com:owner/repo(.git) or https://github.com/owner/repo(.git)
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

async function provisionWorktrees(
  wkCfg: WorktreeConfig,
  taskId: string | null,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<WorktreeProvisionResult | null> {
  const rawBranch = `${wkCfg.agentSlug}-${taskId && taskId.trim().length > 0 ? taskId.trim() : Date.now()}`;
  const branch = sanitizeBranchName(rawBranch);
  if (!branch) {
    await onLog("stderr", `[paperclip-worktree] Could not derive a branch name from slug="${wkCfg.agentSlug}" taskId="${taskId}"; aborting worktree provisioning.\n`);
    return null;
  }

  const worktreesRoot = path.join(os.homedir(), ".paperclip-worktrees");
  await fs.mkdir(worktreesRoot, { recursive: true });

  const primaryPath = path.join(worktreesRoot, branch);
  const secondaryBranch = wkCfg.secondaryRepo ? `${branch}-ios` : null;
  const secondaryPath = wkCfg.secondaryRepo ? path.join(worktreesRoot, `${branch}-ios`) : null;

  // Pre-clean any stale worktree/branch from a prior aborted run (idempotent).
  const cleanupStale = (repo: string, wkt: string, br: string) => {
    runGit(repo, ["worktree", "remove", wkt, "--force"], true);
    runGit(repo, ["branch", "-D", br], true);
  };
  cleanupStale(wkCfg.primaryRepo, primaryPath, branch);
  if (wkCfg.secondaryRepo && secondaryPath && secondaryBranch) {
    cleanupStale(wkCfg.secondaryRepo, secondaryPath, secondaryBranch);
  }

  // Fetch latest so origin/<base> is fresh. Non-fatal on failure.
  runGit(wkCfg.primaryRepo, ["fetch", "origin", wkCfg.primaryBase], true);
  if (wkCfg.secondaryRepo && wkCfg.secondaryBase) {
    runGit(wkCfg.secondaryRepo, ["fetch", "origin", wkCfg.secondaryBase], true);
  }

  // Create primary worktree from origin/<base>.
  const primaryAdd = runGit(wkCfg.primaryRepo, [
    "worktree", "add", "-b", branch, primaryPath, `origin/${wkCfg.primaryBase}`,
  ], true);
  if (!primaryAdd.ok) {
    await onLog("stderr", `[paperclip-worktree] Failed to create primary worktree at ${primaryPath} on origin/${wkCfg.primaryBase}: ${primaryAdd.stderr}\n`);
    return null;
  }

  let secondary: ProvisionedWorktree | null = null;
  if (wkCfg.secondaryRepo && secondaryPath && secondaryBranch) {
    const base = wkCfg.secondaryBase || "main";
    const secAdd = runGit(wkCfg.secondaryRepo, [
      "worktree", "add", "-b", secondaryBranch, secondaryPath, `origin/${base}`,
    ], true);
    if (!secAdd.ok) {
      await onLog("stderr", `[paperclip-worktree] Failed to create secondary worktree at ${secondaryPath} on origin/${base}: ${secAdd.stderr}. Proceeding without secondary.\n`);
      // Don't fail the spawn — continue with primary only.
    } else {
      secondary = {
        repoRoot: wkCfg.secondaryRepo,
        worktreePath: secondaryPath,
        branch: secondaryBranch,
        base,
        isPrimary: false,
      };
    }
  }

  const patToken = readKeychainPat(`${wkCfg.keychainService}${wkCfg.agentSlug}`);
  if (!patToken) {
    await onLog(
      "stderr",
      `[paperclip-worktree] Warning: no keychain PAT found for service="${wkCfg.keychainService}${wkCfg.agentSlug}" (account=paperclip). Agent will run without GH_TOKEN.\n`,
    );
  }

  // cwd for the Claude Code session — inside the primary worktree at the agent's workspace.
  const sessionCwd = path.join(primaryPath, "_workspaces", wkCfg.agentSlug);
  try {
    await fs.mkdir(sessionCwd, { recursive: true });
  } catch {
    // If the dir genuinely can't be created (e.g. file conflict), fall back to the worktree root.
  }

  const envAdditions: Record<string, string> = {
    GIT_AUTHOR_NAME: wkCfg.agentName,
    GIT_COMMITTER_NAME: wkCfg.agentName,
    GIT_AUTHOR_EMAIL: wkCfg.gitEmail,
    GIT_COMMITTER_EMAIL: wkCfg.gitEmail,
    PAPERCLIP_WORKTREE: primaryPath,
    PAPERCLIP_IOS_WORKTREE: secondary ? secondary.worktreePath : "",
    PAPERCLIP_AGENT_SLUG: wkCfg.agentSlug,
    PAPERCLIP_PRIMARY_REPO: wkCfg.primaryRepo,
    PAPERCLIP_SECONDARY_REPO: wkCfg.secondaryRepo || "",
  };
  if (patToken) {
    envAdditions.GH_TOKEN = patToken;
    envAdditions.GITHUB_TOKEN = patToken;
  }

  await onLog(
    "stdout",
    `[paperclip-worktree] Provisioned branch="${branch}" primary=${primaryPath}${secondary ? ` secondary=${secondary.worktreePath}` : ""} cwd=${sessionCwd} pat=${patToken ? "yes" : "no"}\n`,
  );

  return {
    config: wkCfg,
    primary: {
      repoRoot: wkCfg.primaryRepo,
      worktreePath: primaryPath,
      branch,
      base: wkCfg.primaryBase,
      isPrimary: true,
    },
    secondary,
    patToken,
    sessionCwd,
    envAdditions,
  };
}

async function finalizeWorktree(
  wkt: ProvisionedWorktree,
  wkCfg: WorktreeConfig,
  patToken: string | null,
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
): Promise<void> {
  try {
    // 1. Detect commits: compare HEAD to origin/<base>.
    const headRes = runGit(wkt.worktreePath, ["rev-parse", "HEAD"], true);
    const baseRes = runGit(wkt.repoRoot, ["rev-parse", `origin/${wkt.base}`], true);
    const hasCommits = headRes.ok && baseRes.ok && headRes.stdout.length > 0 && headRes.stdout !== baseRes.stdout;

    if (hasCommits) {
      // 2. Push the branch.
      const push = runGit(wkt.worktreePath, ["push", "origin", wkt.branch], true);
      if (!push.ok) {
        await onLog("stderr", `[paperclip-worktree] Push failed for ${wkt.branch}: ${push.stderr}\n`);
      } else {
        await onLog("stdout", `[paperclip-worktree] Pushed ${wkt.branch} to origin.\n`);

        // 3. Extract owner/repo from origin remote.
        const remote = runGit(wkt.worktreePath, ["remote", "get-url", "origin"], true);
        const ownerRepo = remote.ok ? parseGitHubOwnerRepo(remote.stdout) : null;
        if (!ownerRepo) {
          await onLog("stderr", `[paperclip-worktree] Could not parse owner/repo from origin remote "${remote.stdout}"; skipping PR creation.\n`);
        } else {
          // WORKTREE_PATCH_V1.1: check if agent already opened a PR on this branch.
          // Agents use ship / open-rollup-pr / open-vault-pr skills to open rich-body
          // PRs during the session. The adapter PR-on-exit is a safety net for sessions
          // that crashed or didn't open one. If a PR already exists, skip creation.
          const ghEnv: NodeJS.ProcessEnv = { ...process.env };
          if (patToken) {
            ghEnv.GH_TOKEN = patToken;
            ghEnv.GITHUB_TOKEN = patToken;
          }
          const existingRes = spawnSync(
            "gh",
            [
              "pr", "list",
              "--repo", `${ownerRepo.owner}/${ownerRepo.repo}`,
              "--head", wkt.branch,
              "--state", "open",
              "--json", "number",
              "--limit", "1",
            ],
            { encoding: "utf-8", cwd: wkt.worktreePath, env: ghEnv },
          );
          let existingPrNumber: number | null = null;
          if (existingRes.status === 0 && existingRes.stdout) {
            try {
              const parsed = JSON.parse(existingRes.stdout) as Array<{ number: number }>;
              if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.number === "number") {
                existingPrNumber = parsed[0].number;
              }
            } catch {
              // Malformed JSON — fall through to create path.
            }
          }

          if (existingPrNumber !== null) {
            await onLog(
              "stdout",
              `[paperclip-worktree] PR already exists on ${wkt.branch} (#${existingPrNumber}), skipping create.\n`,
            );
          } else {
            // First commit subject for PR title.
            const subj = runGit(wkt.worktreePath, ["log", "-1", "--pretty=%s", `origin/${wkt.base}..HEAD`], true);
            const firstSubj = subj.ok && subj.stdout.length > 0
              ? subj.stdout.split("\n")[0]
              : `${wkCfg.agentName}: ${wkt.branch}`;
            const title = firstSubj.length > 200 ? firstSubj.slice(0, 197) + "..." : firstSubj;
            const body = [
              `⚠️ This PR was created by the Paperclip adapter on session exit because no PR was opened during the agent session. Review context may be incomplete. Check the assigned issue for full context.`,
              "",
              "---",
              "",
              `Automated PR from \`${wkCfg.agentName}\` session.`,
              "",
              `- Branch: \`${wkt.branch}\``,
              `- Base: \`${wkt.base}\``,
              `- Worktree: \`${wkt.worktreePath}\``,
              "",
              `Adapter-created on session exit. Label \`${wkCfg.autoMergeLabel}\` applied for the DIY auto-merge workflow.`,
            ].join("\n");

            const ghArgs = [
              "pr", "create",
              "--repo", `${ownerRepo.owner}/${ownerRepo.repo}`,
              "--base", wkt.base,
              "--head", wkt.branch,
              "--title", title,
              "--body", body,
              "--label", wkCfg.autoMergeLabel,
            ];
            const ghRes = spawnSync("gh", ghArgs, { encoding: "utf-8", cwd: wkt.worktreePath, env: ghEnv });
            if (ghRes.status === 0) {
              await onLog("stdout", `[paperclip-worktree] Opened PR on ${ownerRepo.owner}/${ownerRepo.repo}: ${(ghRes.stdout || "").trim()}\n`);
            } else {
              await onLog("stderr", `[paperclip-worktree] gh pr create failed (exit ${ghRes.status}): ${(ghRes.stderr || "").trim()}\n`);
            }
          }
        }
      }
    } else {
      await onLog("stdout", `[paperclip-worktree] No commits on ${wkt.branch}; skipping push + PR.\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip-worktree] finalize error for ${wkt.branch}: ${msg}\n`);
  } finally {
    // 4. Cleanup — always.
    const rm = runGit(wkt.repoRoot, ["worktree", "remove", wkt.worktreePath, "--force"], true);
    if (!rm.ok) {
      await onLog("stderr", `[paperclip-worktree] worktree remove warning for ${wkt.worktreePath}: ${rm.stderr}\n`);
    }
    runGit(wkt.repoRoot, ["branch", "-D", wkt.branch], true);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn, authToken } = ctx;

  const promptTemplate = asString(
    config.promptTemplate,
    "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  );
  const model = asString(config.model, "");
  const effort = asString(config.effort, "");
  const chrome = asBoolean(config.chrome, false);
  const maxTurns = asNumber(config.maxTurnsPerRun, 0);
  const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  const instructionsFileDir = instructionsFilePath ? `${path.dirname(instructionsFilePath)}/` : "";
  const commandNotes = instructionsFilePath
    ? [
        `Injected agent instructions via --append-system-prompt-file ${instructionsFilePath} (with path directive appended)`,
      ]
    : [];

  const runtimeConfig = await buildClaudeRuntimeConfig({
    runId,
    agent,
    config,
    context,
    authToken,
  });
  const {
    command,
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    env,
    timeoutSec,
    graceSec,
    extraArgs,
  } = runtimeConfig;
  let cwd = runtimeConfig.cwd;

  // --- Pre-spawn: per-agent worktree provisioning (Layer 5) -----------------
  // Read adapterConfig.worktreeEnabled and friends. If opted in, create a
  // per-task worktree, override cwd, inject git identity + keychain PAT.
  // Safe: any error in this block logs + no-ops (does not abort the spawn).
  let worktreeResult: WorktreeProvisionResult | null = null;
  try {
    const wkCfg = parseWorktreeConfig(config);
    if (wkCfg) {
      const taskId =
        (typeof context.taskId === "string" && context.taskId.trim()) ||
        (typeof context.issueId === "string" && context.issueId.trim()) ||
        null;
      worktreeResult = await provisionWorktrees(wkCfg, taskId, onLog);
      if (worktreeResult) {
        cwd = worktreeResult.sessionCwd;
        for (const [k, v] of Object.entries(worktreeResult.envAdditions)) {
          env[k] = v;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await onLog("stderr", `[paperclip-worktree] Pre-spawn provisioning threw: ${msg}. Falling back to default cwd/env.\n`);
    worktreeResult = null;
  }

  // Auto-inject provider env vars for third-party models (e.g., MiniMax)
  const isThirdParty = model ? isThirdPartyModel(model) : false;
  const providerLabel = isThirdParty ? resolveProviderLabel(model) : "anthropic";
  if (isThirdParty) {
    const providerUrl = PROVIDER_ENDPOINTS[model];
    if (providerUrl && !env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = providerUrl;
    }
    if (!env.ANTHROPIC_MODEL) env.ANTHROPIC_MODEL = model;
    if (!env.ANTHROPIC_DEFAULT_SONNET_MODEL) env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    if (!env.ANTHROPIC_DEFAULT_OPUS_MODEL) env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    if (!env.ANTHROPIC_DEFAULT_HAIKU_MODEL) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    if (!env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    if (!env.API_TIMEOUT_MS) env.API_TIMEOUT_MS = "3000000";
  } else {
    delete env.ANTHROPIC_API_KEY;
  }

  const effectiveEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const billingType = resolveClaudeBillingType(effectiveEnv);
  const skillsDir = await buildSkillsDir(config);

  // Check for workspace-local skills directory (agent-specific skills)
  // Skills must be in <workspace>/.claude/skills/ for Claude Code to discover them
  const workspaceClaudeSkillsDir = path.join(cwd, ".claude", "skills");
  let hasWorkspaceSkills = false;
  try {
    const stat = await fs.stat(workspaceClaudeSkillsDir);
    hasWorkspaceSkills = stat.isDirectory();
  } catch {
    // Directory doesn't exist, that's fine
  }

  // When instructionsFilePath is configured, create a combined temp file that
  // includes both the file content and the path directive, so we only need
  // --append-system-prompt-file (Claude CLI forbids using both flags together).
  let effectiveInstructionsFilePath: string | undefined = instructionsFilePath;
  if (instructionsFilePath) {
    try {
      const instructionsContent = await fs.readFile(instructionsFilePath, "utf-8");
      const pathDirective = `\nThe above agent instructions were loaded from ${instructionsFilePath}. Resolve any relative file references from ${instructionsFileDir}.`;
      const combinedPath = path.join(skillsDir, "agent-instructions.md");
      await fs.writeFile(combinedPath, instructionsContent + pathDirective, "utf-8");
      effectiveInstructionsFilePath = combinedPath;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stderr",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
      effectiveInstructionsFilePath = undefined;
    }
  }

  const runtimeSessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId = asString(runtimeSessionParams.sessionId, runtime.sessionId ?? "");
  const runtimeSessionCwd = asString(runtimeSessionParams.cwd, "");
  const canResumeSession =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 || path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const sessionId = canResumeSession ? runtimeSessionId : null;
  if (runtimeSessionId && !canResumeSession) {
    await onLog(
      "stdout",
      `[paperclip] Claude session "${runtimeSessionId}" was saved for cwd "${runtimeSessionCwd}" and will not be resumed in "${cwd}".\n`,
    );
  }
  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const renderedPrompt = renderTemplate(promptTemplate, templateData);
  const renderedBootstrapPrompt =
    !sessionId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";
  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const prompt = joinPromptSections([
    renderedBootstrapPrompt,
    sessionHandoffNote,
    renderedPrompt,
  ]);
  const promptMetrics = {
    promptChars: prompt.length,
    bootstrapPromptChars: renderedBootstrapPrompt.length,
    sessionHandoffChars: sessionHandoffNote.length,
    heartbeatPromptChars: renderedPrompt.length,
  };

  const buildClaudeArgs = (resumeSessionId: string | null) => {
    const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
    args.push("--setting-sources", "user,project,local"); // Load CLAUDE.md from workspace
    if (resumeSessionId) args.push("--resume", resumeSessionId);
    if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    if (chrome) args.push("--chrome");
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
    if (effectiveInstructionsFilePath) {
      args.push("--append-system-prompt-file", effectiveInstructionsFilePath);
    }
    args.push("--add-dir", skillsDir);
    if (hasWorkspaceSkills) {
      // Add workspace root so Claude Code finds <cwd>/.claude/skills/
      args.push("--add-dir", cwd);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    return args;
  };

  const parseFallbackErrorMessage = (proc: RunProcessResult) => {
    const stderrLine =
      proc.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? "";

    if ((proc.exitCode ?? 0) === 0) {
      return "Failed to parse claude JSON output";
    }

    return stderrLine
      ? `Claude exited with code ${proc.exitCode ?? -1}: ${stderrLine}`
      : `Claude exited with code ${proc.exitCode ?? -1}`;
  };

  const runAttempt = async (resumeSessionId: string | null) => {
    const args = buildClaudeArgs(resumeSessionId);
    if (onMeta) {
      await onMeta({
        adapterType: "claude_local",
        command,
        cwd,
        commandArgs: args,
        commandNotes,
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics,
        context,
      });
    }

    const proc = await runChildProcess(runId, command, args, {
      cwd,
      env,
      stdin: prompt,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
    });

    const parsedStream = parseClaudeStreamJson(proc.stdout);
    const parsed = parsedStream.resultJson ?? parseJson(proc.stdout);
    return { proc, parsedStream, parsed };
  };

  const toAdapterResult = (
    attempt: {
      proc: RunProcessResult;
      parsedStream: ReturnType<typeof parseClaudeStreamJson>;
      parsed: Record<string, unknown> | null;
    },
    opts: { fallbackSessionId: string | null; clearSessionOnMissingSession?: boolean },
  ): AdapterExecutionResult => {
    const { proc, parsedStream, parsed } = attempt;
    const loginMeta = detectClaudeLoginRequired({
      parsed,
      stdout: proc.stdout,
      stderr: proc.stderr,
    });
    const errorMeta =
      loginMeta.loginUrl != null
        ? {
            loginUrl: loginMeta.loginUrl,
          }
        : undefined;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: "timeout",
        errorMeta,
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    if (!parsed) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        errorMessage: parseFallbackErrorMessage(proc),
        errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
        errorMeta,
        resultJson: {
          stdout: proc.stdout,
          stderr: proc.stderr,
        },
        clearSession: Boolean(opts.clearSessionOnMissingSession),
      };
    }

    const usage =
      parsedStream.usage ??
      (() => {
        const usageObj = parseObject(parsed.usage);
        return {
          inputTokens: asNumber(usageObj.input_tokens, 0),
          cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
          outputTokens: asNumber(usageObj.output_tokens, 0),
        };
      })();

    const resolvedSessionId =
      parsedStream.sessionId ??
      (asString(parsed.session_id, opts.fallbackSessionId ?? "") || opts.fallbackSessionId);
    const resolvedSessionParams = resolvedSessionId
      ? ({
        sessionId: resolvedSessionId,
        cwd,
        ...(workspaceId ? { workspaceId } : {}),
        ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
        ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
      } as Record<string, unknown>)
      : null;
    const clearSessionForMaxTurns = isClaudeMaxTurnsResult(parsed);

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage:
        (proc.exitCode ?? 0) === 0
          ? null
          : describeClaudeFailure(parsed) ?? `Claude exited with code ${proc.exitCode ?? -1}`,
      errorCode: loginMeta.requiresLogin ? "claude_auth_required" : null,
      errorMeta,
      usage,
      sessionId: resolvedSessionId,
      sessionParams: resolvedSessionParams,
      sessionDisplayId: resolvedSessionId,
      provider: providerLabel,
      biller: providerLabel,
      model: parsedStream.model || asString(parsed.model, model),
      billingType,
      costUsd: parsedStream.costUsd ?? asNumber(parsed.total_cost_usd, 0),
      resultJson: parsed,
      summary: parsedStream.summary || asString(parsed.result, ""),
      clearSession: clearSessionForMaxTurns || Boolean(opts.clearSessionOnMissingSession && !resolvedSessionId),
    };
  };

  try {
    const initial = await runAttempt(sessionId ?? null);
    if (
      sessionId &&
      !initial.proc.timedOut &&
      (initial.proc.exitCode ?? 0) !== 0 &&
      initial.parsed &&
      isClaudeUnknownSessionError(initial.parsed)
    ) {
      await onLog(
        "stdout",
        `[paperclip] Claude resume session "${sessionId}" is unavailable; retrying with a fresh session.\n`,
      );
      const retry = await runAttempt(null);
      return toAdapterResult(retry, { fallbackSessionId: null, clearSessionOnMissingSession: true });
    }

    return toAdapterResult(initial, { fallbackSessionId: runtimeSessionId || runtime.sessionId });
  } finally {
    fs.rm(skillsDir, { recursive: true, force: true }).catch(() => {});

    // --- Post-completion: worktree push + PR + cleanup (Layer 5) -----------
    // Always runs (regardless of exit code). Never throws — each finalize has
    // its own try/catch/finally so cleanup still happens on push/PR failure.
    if (worktreeResult) {
      try {
        await finalizeWorktree(worktreeResult.primary, worktreeResult.config, worktreeResult.patToken, onLog);
        if (worktreeResult.secondary) {
          await finalizeWorktree(worktreeResult.secondary, worktreeResult.config, worktreeResult.patToken, onLog);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await onLog("stderr", `[paperclip-worktree] Post-completion error (non-fatal): ${msg}\n`);
      }
    }
  }
}
