import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  formalQaCheckouts,
  formalQaIssuances,
  formalQaPreparations,
  heartbeatRuns,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { formalQaGitHubIssuerService } from "../services/formal-qa-github-issuer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Paperclip test",
      GIT_AUTHOR_EMAIL: "paperclip-test@example.test",
      GIT_COMMITTER_NAME: "Paperclip test",
      GIT_COMMITTER_EMAIL: "paperclip-test@example.test",
    },
    encoding: "utf8",
  }).trim();
}

function jsonResponse(body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

describeEmbeddedPostgres("Formal-QA trusted GitHub issuer", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-issuer-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(formalQaCheckouts);
    await db.delete(formalQaIssuances);
    await db.delete(formalQaPreparations);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-issuer-repo-"));
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-issuer-home-"));
    tempDirs.push(root, instanceRoot);
    git(root, "init");
    git(root, "remote", "add", "origin", "git@github.com:vivus-tech/music-tracker.git");
    await writeFile(path.join(root, "README.md"), "issuer source\\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "issuer source");
    const headSha = git(root, "rev-parse", "HEAD");
    const treeSha = git(root, "rev-parse", "HEAD^{tree}");
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Music Tracker", status: "in_progress" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Source checkout",
      sourceType: "local_path",
      cwd: root,
      repoUrl: "https://github.com/vivus-tech/music-tracker.git",
      isPrimary: true,
    });
    return { root, instanceRoot, companyId, projectId, projectWorkspaceId, headSha, treeSha };
  }

  function pull(headSha: string) {
    return {
      state: "open",
      draft: false,
      merged: false,
      updated_at: "2026-09-01T00:00:00Z",
      head: { sha: headSha },
      base: { ref: "main", sha: headSha },
    };
  }

  function issuer(input: { headSha: string; treeSha: string; pullAtBookend?: string; checkLink?: string }) {
    const calls: string[] = [];
    let pullReads = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect(init?.headers).toMatchObject({ authorization: "Bearer scoped-token" });
      if (url.includes("/pulls/1902")) {
        pullReads += 1;
        return jsonResponse(pull(pullReads === 1 ? input.headSha : (input.pullAtBookend ?? input.headSha)));
      }
      if (url.includes("/git/commits/")) return jsonResponse({ sha: input.headSha, tree: { sha: input.treeSha } });
      if (url.includes("/check-runs")) {
        return jsonResponse({
          total_count: 1,
          check_runs: [{
            id: 101,
            name: "PR Policy",
            app: { slug: "github-actions" },
            head_sha: input.headSha,
            status: "completed",
            conclusion: "success",
            completed_at: "2026-09-01T00:01:00Z",
          }],
        }, input.checkLink ? { link: input.checkLink } : undefined);
      }
      throw new Error(`unexpected GitHub URL: ${url}`);
    };
    return { calls, fetch };
  }

  async function issue(service: ReturnType<typeof formalQaGitHubIssuerService>, f: Awaited<ReturnType<typeof fixture>>) {
    return service.issue({
      companyId: f.companyId,
      projectId: f.projectId,
      projectWorkspaceId: f.projectWorkspaceId,
      prNumber: 1902,
      idempotencyKey: "formal-qa:vivus-tech/music-tracker#1902",
      issuedByUserId: "board-user",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      policy: {
        repository: "vivus-tech/music-tracker",
        requiredCheckName: "PR Policy",
        requiredCheckAppSlug: "github-actions",
      },
    });
  }

  it("derives the exact PR head and required-check evidence from GitHub before sealing a detached checkout", async () => {
    const f = await fixture();
    const fake = issuer(f);
    const service = formalQaGitHubIssuerService(db, {
      fetch: fake.fetch,
      tokenProvider: async (input) => {
        expect(input).toMatchObject({ companyId: f.companyId, projectId: f.projectId, projectWorkspaceId: f.projectWorkspaceId, issuedByUserId: "board-user" });
        return "scoped-token";
      },
      checkoutInstanceRoot: f.instanceRoot,
    });

    const result = await issue(service, f);

    expect(fake.calls).toHaveLength(4);
    expect(result.preparation.status).toBe("issued");
    expect(result.preparation.headSha).toBe(f.headSha);
    expect(result.issuance).toMatchObject({
      preparationId: result.preparation.id,
      repository: "vivus-tech/music-tracker",
      headSha: f.headSha,
      treeSha: f.treeSha,
      requiredCheckName: "PR Policy",
      requiredCheckAppSlug: "github-actions",
      checkRunId: "101",
    });
    expect(git(result.checkout.checkoutPath, "rev-parse", "HEAD")).toBe(f.headSha);
    expect(git(result.checkout.checkoutPath, "status", "--porcelain", "--untracked-files=all")).toBe("");
    expect(await db.select().from(executionWorkspaces)).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it("fails closed before persistence when GitHub says the required check result is paginated", async () => {
    const f = await fixture();
    const fake = issuer({ ...f, checkLink: '<https://api.github.com/page=2>; rel="next"' });
    const service = formalQaGitHubIssuerService(db, {
      fetch: fake.fetch,
      tokenProvider: async () => "scoped-token",
      checkoutInstanceRoot: f.instanceRoot,
    });

    await expect(issue(service, f)).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_required_check_incomplete" },
    });
    expect(await db.select().from(formalQaPreparations)).toEqual([]);
    expect(await db.select().from(formalQaIssuances)).toEqual([]);
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });

  it("fails closed when the PR changes between the GitHub bookend reads", async () => {
    const f = await fixture();
    const fake = issuer({ ...f, pullAtBookend: "f".repeat(40) });
    const service = formalQaGitHubIssuerService(db, {
      fetch: fake.fetch,
      tokenProvider: async () => "scoped-token",
      checkoutInstanceRoot: f.instanceRoot,
    });

    await expect(issue(service, f)).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_pull_changed_during_issue" },
    });
    expect(await db.select().from(formalQaPreparations)).toEqual([]);
    expect(await db.select().from(formalQaIssuances)).toEqual([]);
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });
});
