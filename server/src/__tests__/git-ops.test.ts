import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  executionWorkspaces,
  issues,
  projects,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import {
  buildHardenedGitPushInvocation,
  gitOpsService,
  parseGitOpsRemote,
} from "../services/git-ops.js";

// ---------------------------------------------------------------------------
// Pure, DB-free tests for the hardening surface and remote parsing. These
// guard the security-critical invariants of the SOLE git-push site.
// ---------------------------------------------------------------------------
describe("buildHardenedGitPushInvocation", () => {
  const base = {
    cwd: "/work/issue-42",
    remoteUrl: "https://github.com/Moyal17/paperclip.git",
    branchName: "issue/PRC-42-fix",
    host: "github.com",
    hooksDir: "/tmp/paperclip-gitops-xyz/hooks",
  };

  it("keeps the token out of argv and only in the push subprocess env", () => {
    const token = "ghp_sekrit_value";
    const { command, args, env } = buildHardenedGitPushInvocation(base, token);

    expect(command).toBe("git");
    expect(args.join(" ")).not.toContain(token);
    expect(JSON.stringify(args)).not.toContain(token);
    expect(env.GITOPS_TOKEN).toBe(token);
    expect(env.GITOPS_EXPECTED_HOST).toBe("github.com");
  });

  it("applies every hardening flag", () => {
    const { args, env } = buildHardenedGitPushInvocation(base, "t");

    // Leading credential.helper reset clears inherited/repo helpers, then ours.
    const resetIdx = args.findIndex((a, i) => args[i - 1] === "-c" && a === "credential.helper=");
    expect(resetIdx).toBeGreaterThan(-1);
    expect(args.some((a) => a.startsWith("credential.helper=") && a.endsWith("credential-helper.sh"))).toBe(true);
    // The reset must precede our helper so the list ends with only ours.
    const helperIdx = args.findIndex((a) => a.startsWith("credential.helper=") && a.endsWith(".sh"));
    expect(resetIdx).toBeLessThan(helperIdx);

    expect(args.some((a) => a === `core.hooksPath=${base.hooksDir}`)).toBe(true);
    expect(args.some((a) => a === "credential.useHttpPath=false")).toBe(true);
    expect(args.slice(-3)).toEqual(["push", base.remoteUrl, `${base.branchName}:${base.branchName}`]);

    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.GIT_CONFIG_SYSTEM).toBe("/dev/null");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("parseGitOpsRemote", () => {
  it("extracts host/owner/repo and strips .git", () => {
    expect(parseGitOpsRemote("https://github.com/Moyal17/paperclip.git")).toEqual({
      host: "github.com",
      owner: "Moyal17",
      repo: "paperclip",
    });
  });
  it("rejects non-https and malformed urls", () => {
    expect(parseGitOpsRemote("git@github.com:Moyal17/paperclip.git")).toBeNull();
    expect(parseGitOpsRemote("https://github.com/Moyal17")).toBeNull();
    expect(parseGitOpsRemote("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Embedded-pg integration tests: authz, workspace/config resolution, PR
// idempotency, and pr_url persistence. git push and the GitHub API are faked.
// ---------------------------------------------------------------------------
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres git-ops tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const REMOTE_URL = "https://github.com/Moyal17/paperclip.git";
const TOKEN_SECRET_NAME = "github-fork-pat";
const PR_URL = "https://github.com/Moyal17/paperclip/pull/7";

describeEmbeddedPostgres("gitOpsService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-git-ops-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("git-ops");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(executionWorkspaces);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(projects);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  interface Fixture {
    companyId: string;
    agentId: string;
    issueId: string;
    branchName: string;
    cwd: string;
  }

  async function seed(
    options: { gitOps?: boolean; withWorkspace?: boolean; assignToOther?: boolean; branchName?: string } = {},
  ): Promise<Fixture> {
    const { gitOps = true, withWorkspace = true, assignToOther = false } = options;
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Hive Co",
      issuePrefix: "HIVE",
      requireBoardApprovalForNewAgents: false,
    });

    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Implementor" });

    const otherAgentId = randomUUID();
    if (assignToOther) {
      await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other" });
    }

    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip",
      executionWorkspacePolicy: gitOps
        ? { gitOps: { remoteUrl: REMOTE_URL, baseBranch: "master", tokenSecretName: TOKEN_SECRET_NAME } }
        : {},
    });

    if (gitOps) {
      await secretService(db).create(companyId, {
        name: TOKEN_SECRET_NAME,
        provider: "local_encrypted",
        value: "ghp_fork_token",
      });
    }

    const issueId = randomUUID();
    const branchName = options.branchName ?? "issue/HIVE-1-add-widget";
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Add widget",
      assigneeAgentId: assignToOther ? otherAgentId : agentId,
    });

    const cwd = "/work/HIVE-1";
    if (withWorkspace) {
      await db.insert(executionWorkspaces).values({
        id: randomUUID(),
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "HIVE-1 worktree",
        status: "active",
        cwd,
        branchName,
      });
    }

    return { companyId, agentId, issueId, branchName, cwd };
  }

  it("pushes the resolved worktree branch with the server-held token", async () => {
    const fx = await seed();
    const push = vi.fn(async () => {});
    const svc = gitOpsService(db, { push });

    const result = await svc.pushIssueBranch(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId });

    expect(result).toEqual({ branch: fx.branchName });
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({
      cwd: fx.cwd,
      remoteUrl: REMOTE_URL,
      branchName: fx.branchName,
      host: "github.com",
      token: "ghp_fork_token",
    });
  });

  it("opens a PR and persists pr_url on the issue", async () => {
    const fx = await seed();
    const push = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, [])) // no existing open PR
      .mockResolvedValueOnce(jsonResponse(201, { html_url: PR_URL })); // created
    const svc = gitOpsService(db, { push, fetch: fetchImpl });

    const result = await svc.openIssuePullRequest(
      fx.issueId,
      { agentId: fx.agentId, companyId: fx.companyId },
      { title: "Add widget", body: "Implements the widget." },
    );

    expect(result).toEqual({ prUrl: PR_URL, branch: fx.branchName, created: true });
    expect(push).toHaveBeenCalledTimes(1);

    const stored = await db
      .select({ prUrl: issues.prUrl })
      .from(issues)
      .where(eq(issues.id, fx.issueId))
      .then((rows) => rows[0]);
    expect(stored?.prUrl).toBe(PR_URL);
  });

  it("is idempotent — returns the existing open PR without creating a new one", async () => {
    const fx = await seed();
    const push = vi.fn(async () => {});
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, [{ html_url: PR_URL }]));
    const svc = gitOpsService(db, { push, fetch: fetchImpl });

    const result = await svc.openIssuePullRequest(
      fx.issueId,
      { agentId: fx.agentId, companyId: fx.companyId },
      { title: "Add widget" },
    );

    expect(result).toEqual({ prUrl: PR_URL, branch: fx.branchName, created: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // GET only, no POST
  });

  it("rejects an agent that is not the issue assignee", async () => {
    const fx = await seed({ assignToOther: true });
    const svc = gitOpsService(db, { push: vi.fn(async () => {}) });

    await expect(
      svc.pushIssueBranch(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an agent from another company", async () => {
    const fx = await seed();
    const svc = gitOpsService(db, { push: vi.fn(async () => {}) });

    await expect(
      svc.pushIssueBranch(fx.issueId, { agentId: fx.agentId, companyId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("returns 409 no_workspace when no active git worktree exists", async () => {
    const fx = await seed({ withWorkspace: false });
    const svc = gitOpsService(db, { push: vi.fn(async () => {}) });

    await expect(svc.pushIssueBranch(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }))
      .rejects.toMatchObject({ status: 409, details: { code: "no_workspace" } });
  });

  it("returns 409 not_configured when the project has no git-ops policy", async () => {
    const fx = await seed({ gitOps: false });
    const svc = gitOpsService(db, { push: vi.fn(async () => {}) });

    await expect(svc.pushIssueBranch(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }))
      .rejects.toMatchObject({ status: 409, details: { code: "not_configured" } });
  });

  it("surfaces a sanitized 502 without raw output on GitHub API failure", async () => {
    const fx = await seed();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, []))
      .mockResolvedValueOnce(jsonResponse(500, { message: "boom" }));
    const svc = gitOpsService(db, { push: vi.fn(async () => {}), fetch: fetchImpl });

    await expect(
      svc.openIssuePullRequest(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }, { title: "x" }),
    ).rejects.toMatchObject({ status: 502, details: { code: "github_api_error", status: 500 } });
  });

  it("returns 404 (not a pg 500) for an unknown non-uuid issue ref", async () => {
    const fx = await seed();
    const svc = gitOpsService(db, { push: vi.fn(async () => {}) });

    await expect(
      svc.pushIssueBranch("ZZZ-404", { agentId: fx.agentId, companyId: fx.companyId }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a push-unsafe branch name before any push", async () => {
    const fx = await seed({ branchName: "--upload-pack=evil" });
    const push = vi.fn(async () => {});
    const svc = gitOpsService(db, { push });

    await expect(svc.pushIssueBranch(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }))
      .rejects.toMatchObject({ status: 409, details: { code: "invalid_branch" } });
    expect(push).not.toHaveBeenCalled();
  });

  it("attaches an abort timeout signal to GitHub API calls", async () => {
    const fx = await seed();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, []))
      .mockResolvedValueOnce(jsonResponse(201, { html_url: PR_URL }));
    const svc = gitOpsService(db, { push: vi.fn(async () => {}), fetch: fetchImpl });

    await svc.openIssuePullRequest(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }, { title: "x" });

    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("does not mislabel a malformed 2xx PR body with an http error status", async () => {
    const fx = await seed();
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        String(url).includes("state=open") ? jsonResponse(200, []) : jsonResponse(201, {}), // 2xx but no html_url
      ),
    );
    const svc = gitOpsService(db, { push: vi.fn(async () => {}), fetch: fetchImpl });

    const err = await svc
      .openIssuePullRequest(fx.issueId, { agentId: fx.agentId, companyId: fx.companyId }, { title: "x" })
      .catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.details.code).toBe("github_api_error");
    expect(err.details.status).toBeUndefined();
  });
});
