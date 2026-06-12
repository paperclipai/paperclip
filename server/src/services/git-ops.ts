import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { executionWorkspaces, issues, projects } from "@paperclipai/db";
import { gitOpsProjectPolicySchema, type GitOpsProjectPolicy } from "@paperclipai/shared";
import { conflict, forbidden, HttpError, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { gitHubApiBase, ghFetch } from "./github-fetch.js";
import { issueService } from "./issues.js";
import { secretService } from "./secrets.js";

// Bound the credentialed push and the GitHub REST calls so a hung network peer
// cannot pin an Express worker indefinitely.
const GITOPS_PUSH_TIMEOUT_MS = 30_000;
const GITOPS_GITHUB_TIMEOUT_MS = 10_000;

// A git branch name we are willing to hand to `git push` as a refspec. Rejects
// leading-dash (option injection), whitespace, and other shell/ref-unsafe input
// even though the value originates from a DB row, because that row is writable
// by the agent via the execution-workspace update API.
const SAFE_BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

// ---------------------------------------------------------------------------
// Git-ops proxy service
//
// The reason this whole phase exists: a fork-scoped GitHub token must NEVER
// enter the agent's process environment, argv, or worktree. Agents commit
// locally (credential-free) and then call two server endpoints — push and PR —
// that perform the credentialed git/GitHub work here, server-side, and return
// only sanitized results. The token is resolved from a company secret inside
// this module and lives only in the push subprocess env for the brief push.
// ---------------------------------------------------------------------------

const GITOPS_ERROR = {
  noWorkspace: "no_workspace",
  notConfigured: "not_configured",
  invalidBranch: "invalid_branch",
  pushFailed: "push_failed",
  pushTimeout: "push_timeout",
  githubApiError: "github_api_error",
} as const;

export interface GitOpsRemote {
  host: string;
  owner: string;
  repo: string;
}

export interface HardenedGitPushInput {
  cwd: string;
  remoteUrl: string;
  branchName: string;
  host: string;
  hooksDir: string;
}

export interface HardenedGitPushInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

// Pure builder for the hardened `git push` invocation. Extracted so the exact
// hardening surface can be asserted in tests without spawning git. The token
// is supplied separately (env) and is intentionally absent from `args`.
export function buildHardenedGitPushInvocation(
  input: HardenedGitPushInput,
  token: string,
): HardenedGitPushInvocation {
  const args = [
    // Reset any inherited/global/repo-level credential helpers. Command-line
    // `-c` entries are applied after config files, and an empty value resets
    // the accumulated list — so an agent-written `.git/config` credential
    // helper in the worktree cannot run with our token. Our helper is appended
    // immediately after and is therefore the only one git will consult.
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=${gitOpsCredentialHelperPath(input.hooksDir)}`,
    // An agent-authored pre-push hook in the worktree would otherwise execute
    // inside this process — with the token in env. Point hooksPath at an empty
    // dir to neutralize all hooks for this push.
    "-c",
    `core.hooksPath=${input.hooksDir}`,
    "-c",
    "credential.useHttpPath=false",
    "push",
    input.remoteUrl,
    `${input.branchName}:${input.branchName}`,
  ];

  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // Global/system git config is ignored so a host-level `url.insteadOf` or
    // credential helper cannot redirect or intercept this push.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    // Never block on an interactive prompt; fail closed instead.
    GIT_TERMINAL_PROMPT: "0",
    // Consumed only by our credential helper (CREDENTIAL_HELPER_SCRIPT).
    GITOPS_TOKEN: token,
    GITOPS_EXPECTED_HOST: input.host,
  };

  return { command: "git", args, env };
}

function gitOpsCredentialHelperPath(hooksDir: string) {
  // The credential helper lives alongside the empty hooks dir, under the same
  // per-push temp root, so a single cleanup removes both.
  return path.join(path.dirname(hooksDir), "credential-helper.sh");
}

// Credential helper script. It emits credentials ONLY for the exact expected
// host over https. Git feeds the effective protocol/host on stdin, so if a
// `url.insteadOf` rewrite (or anything else) changed the host, this prints
// nothing and the push fails closed — the token is never sent to another host.
const CREDENTIAL_HELPER_SCRIPT = `#!/bin/sh
[ "$1" = "get" ] || exit 0
host=""
protocol=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  key=\${line%%=*}
  val=\${line#*=}
  case "$key" in
    host) host=$val ;;
    protocol) protocol=$val ;;
  esac
done
[ "$protocol" = "https" ] || exit 0
[ "$host" = "$GITOPS_EXPECTED_HOST" ] || exit 0
printf 'username=x-access-token\\n'
printf 'password=%s\\n' "$GITOPS_TOKEN"
`;

interface PushFn {
  (input: { cwd: string; remoteUrl: string; branchName: string; host: string; token: string }): Promise<void>;
}

type FetchFn = typeof ghFetch;

export interface GitOpsServiceDeps {
  push?: PushFn;
  fetch?: FetchFn;
}

// The ONLY place a credentialed `git push` is spawned. Creates a private temp
// root (empty hooks dir + credential helper), runs the hardened push, and
// always cleans up. Throws a sanitized HttpError on failure — raw git output
// is logged server-side but never returned to the caller.
async function runHardenedGitPush(input: {
  cwd: string;
  remoteUrl: string;
  branchName: string;
  host: string;
  token: string;
}): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-gitops-"));
  const hooksDir = path.join(tempRoot, "hooks");
  try {
    await fs.mkdir(hooksDir, { recursive: true });
    const helperPath = gitOpsCredentialHelperPath(hooksDir);
    await fs.writeFile(helperPath, CREDENTIAL_HELPER_SCRIPT, { mode: 0o700 });

    const invocation = buildHardenedGitPushInvocation(
      { cwd: input.cwd, remoteUrl: input.remoteUrl, branchName: input.branchName, host: input.host, hooksDir },
      input.token,
    );

    const result = await new Promise<{ code: number | null; stderr: string; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, {
        cwd: input.cwd,
        stdio: ["ignore", "ignore", "pipe"],
        env: invocation.env,
      });
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, GITOPS_PUSH_TIMEOUT_MS);
      child.stderr?.on("data", (chunk) => {
        if (stderr.length < 8192) stderr += String(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr, timedOut });
      });
    });

    if (result.timedOut) {
      logger.warn({ branch: input.branchName }, "git-ops push timed out");
      throw new HttpError(504, "Push to the fork timed out", { code: GITOPS_ERROR.pushTimeout });
    }
    if (result.code !== 0) {
      logger.warn(
        { exitCode: result.code, branch: input.branchName },
        `git-ops push failed: ${result.stderr.trim().slice(0, 500)}`,
      );
      throw new HttpError(502, "Push to the fork failed", {
        code: GITOPS_ERROR.pushFailed,
        exitCode: result.code,
      });
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function parseGitOpsRemote(remoteUrl: string): GitOpsRemote | null {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { host, owner, repo };
}

export interface GitOpsContext {
  issueId: string;
  companyId: string;
  branchName: string;
  cwd: string;
  policy: GitOpsProjectPolicy;
  remote: GitOpsRemote;
  token: string;
}

export interface GitOpsActor {
  agentId: string;
  companyId: string;
}

export function gitOpsService(db: Db, deps: GitOpsServiceDeps = {}) {
  const secrets = secretService(db);
  const issuesSvc = issueService(db);
  const pushImpl: PushFn = deps.push ?? runHardenedGitPush;
  const fetchImpl: FetchFn = deps.fetch ?? ghFetch;

  // Resolves everything needed for a git-ops action and enforces the security
  // boundary. The actor MUST be the issue's assignee agent. Push/PR targets
  // come exclusively from project config + the issue's execution workspace —
  // never from agent input.
  async function resolveContext(issueRef: string, actor: GitOpsActor): Promise<GitOpsContext> {
    // Resolve through the issue service so a UUID OR an identifier ("HIVE-1")
    // both work and an unknown value yields 404 — never a raw pg uuid-cast 500.
    // All downstream queries use the canonical issue.id from here on.
    const issue = await issuesSvc.getById(issueRef);
    if (!issue) throw notFound("Issue not found");
    const issueId = issue.id;
    if (issue.companyId !== actor.companyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (!issue.assigneeAgentId || issue.assigneeAgentId !== actor.agentId) {
      throw forbidden("Only the assigned agent can run git-ops for this issue");
    }
    if (!issue.projectId) {
      throw conflict("Git-ops is not configured for this project", { code: GITOPS_ERROR.notConfigured });
    }

    const project = await db
      .select({ executionWorkspacePolicy: projects.executionWorkspacePolicy })
      .from(projects)
      .where(eq(projects.id, issue.projectId))
      .then((rows) => rows[0] ?? null);
    const rawPolicy = (project?.executionWorkspacePolicy as Record<string, unknown> | null | undefined)?.gitOps;
    const parsedPolicy = gitOpsProjectPolicySchema.safeParse(rawPolicy);
    if (!parsedPolicy.success) {
      throw conflict("Git-ops is not configured for this project", { code: GITOPS_ERROR.notConfigured });
    }
    const policy = parsedPolicy.data;

    const remote = parseGitOpsRemote(policy.remoteUrl);
    if (!remote) {
      throw conflict("Git-ops remote URL is invalid", { code: GITOPS_ERROR.notConfigured });
    }

    const workspace = await db
      .select({
        cwd: executionWorkspaces.cwd,
        branchName: executionWorkspaces.branchName,
      })
      .from(executionWorkspaces)
      .where(
        and(
          eq(executionWorkspaces.sourceIssueId, issueId),
          eq(executionWorkspaces.strategyType, "git_worktree"),
          eq(executionWorkspaces.status, "active"),
        ),
      )
      .orderBy(desc(executionWorkspaces.openedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!workspace?.cwd || !workspace.branchName) {
      throw conflict("No active git worktree for this issue", { code: GITOPS_ERROR.noWorkspace });
    }
    // The branch name reaches `git push` as a refspec positional. Even though it
    // comes from a DB row, that row is agent-writable, so validate it here.
    if (workspace.branchName.length > 255 || !SAFE_BRANCH_NAME.test(workspace.branchName)) {
      throw conflict("Workspace branch name is not push-safe", { code: GITOPS_ERROR.invalidBranch });
    }

    const secret = await secrets.getByName(actor.companyId, policy.tokenSecretName);
    if (!secret) {
      throw conflict("Git-ops token secret is not configured", { code: GITOPS_ERROR.notConfigured });
    }
    // No binding context is passed, so resolution is purely server-internal and
    // does NOT require (or create) an env binding. This is the mechanism that
    // keeps the token off the agent.
    const token = await secrets.resolveSecretValue(actor.companyId, secret.id, "latest");

    return {
      issueId,
      companyId: issue.companyId,
      branchName: workspace.branchName,
      cwd: workspace.cwd,
      policy,
      remote,
      token,
    };
  }

  async function pushIssueBranch(issueId: string, actor: GitOpsActor): Promise<{ branch: string }> {
    const ctx = await resolveContext(issueId, actor);
    await pushImpl({
      cwd: ctx.cwd,
      remoteUrl: ctx.policy.remoteUrl,
      branchName: ctx.branchName,
      host: ctx.remote.host,
      token: ctx.token,
    });
    return { branch: ctx.branchName };
  }

  function githubHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "paperclip-git-ops",
    };
  }

  async function findOpenPullRequest(ctx: GitOpsContext): Promise<string | null> {
    const apiBase = gitHubApiBase(ctx.remote.host);
    const headParam = encodeURIComponent(`${ctx.remote.owner}:${ctx.branchName}`);
    const baseParam = encodeURIComponent(ctx.policy.baseBranch);
    const url = `${apiBase}/repos/${ctx.remote.owner}/${ctx.remote.repo}/pulls?head=${headParam}&base=${baseParam}&state=open`;
    const res = await fetchImpl(url, {
      headers: githubHeaders(ctx.token),
      signal: AbortSignal.timeout(GITOPS_GITHUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new HttpError(502, "GitHub API request failed", {
        code: GITOPS_ERROR.githubApiError,
        status: res.status,
      });
    }
    const list = (await res.json()) as Array<{ html_url?: string }>;
    return Array.isArray(list) && list[0]?.html_url ? list[0].html_url : null;
  }

  async function openIssuePullRequest(
    issueId: string,
    actor: GitOpsActor,
    input: { title: string; body?: string | null; draft?: boolean },
  ): Promise<{ prUrl: string; branch: string; created: boolean }> {
    const ctx = await resolveContext(issueId, actor);

    // Push first — the PR cannot reference commits the fork doesn't have yet.
    await pushImpl({
      cwd: ctx.cwd,
      remoteUrl: ctx.policy.remoteUrl,
      branchName: ctx.branchName,
      host: ctx.remote.host,
      token: ctx.token,
    });

    // Idempotency: return the existing open PR for this branch if one exists.
    const existing = await findOpenPullRequest(ctx);
    if (existing) {
      await persistPrUrl(ctx.issueId, existing);
      return { prUrl: existing, branch: ctx.branchName, created: false };
    }

    const apiBase = gitHubApiBase(ctx.remote.host);
    const res = await fetchImpl(`${apiBase}/repos/${ctx.remote.owner}/${ctx.remote.repo}/pulls`, {
      method: "POST",
      headers: { ...githubHeaders(ctx.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        title: input.title,
        head: ctx.branchName,
        base: ctx.policy.baseBranch,
        body: input.body ?? undefined,
        draft: input.draft ?? undefined,
      }),
      signal: AbortSignal.timeout(GITOPS_GITHUB_TIMEOUT_MS),
    });

    if (res.status === 422) {
      // Lost a race (or an open PR already exists) — fall back to lookup.
      const fallback = await findOpenPullRequest(ctx);
      if (fallback) {
        await persistPrUrl(ctx.issueId, fallback);
        return { prUrl: fallback, branch: ctx.branchName, created: false };
      }
      throw new HttpError(502, "GitHub rejected the pull request", {
        code: GITOPS_ERROR.githubApiError,
        status: 422,
      });
    }
    if (!res.ok) {
      throw new HttpError(502, "GitHub API request failed", {
        code: GITOPS_ERROR.githubApiError,
        status: res.status,
      });
    }
    const created = (await res.json()) as { html_url?: string };
    if (!created.html_url) {
      // 2xx but no URL — a malformed success body, not an HTTP error status.
      throw new HttpError(502, "GitHub did not return a pull request URL", {
        code: GITOPS_ERROR.githubApiError,
      });
    }
    await persistPrUrl(ctx.issueId, created.html_url);
    return { prUrl: created.html_url, branch: ctx.branchName, created: true };
  }

  async function persistPrUrl(issueId: string, prUrl: string): Promise<void> {
    // Direct column write on purpose: setting pr_url does not change status, so
    // routing through issueService.update() (status transitions, workspace
    // cleanup hook, activity log) would add side effects with no benefit here.
    await db.update(issues).set({ prUrl, updatedAt: new Date() }).where(eq(issues.id, issueId));
  }

  return { resolveContext, pushIssueBranch, openIssuePullRequest };
}

export type GitOpsService = ReturnType<typeof gitOpsService>;
