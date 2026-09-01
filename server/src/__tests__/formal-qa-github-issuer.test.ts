import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  formalQaCheckouts,
  formalQaIssuances,
  formalQaPolicies,
  formalQaPreparations,
  heartbeatRuns,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { formalQaGitHubIssuerService } from "../services/formal-qa-github-issuer.js";
import { formalQaPreparationService } from "../services/formal-qa-preparations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "Paperclip test", GIT_AUTHOR_EMAIL: "paperclip-test@example.test", GIT_COMMITTER_NAME: "Paperclip test", GIT_COMMITTER_EMAIL: "paperclip-test@example.test" },
    encoding: "utf8",
  }).trim();
}
function jsonResponse(body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
}

describeEmbeddedPostgres("Formal-QA trusted GitHub issuer", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => { tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-issuer-"); db = createDb(tempDb.connectionString); }, 20_000);
  afterEach(async () => {
    await db.execute(sql`truncate table formal_qa_preparations cascade`); await db.delete(activityLog); await db.delete(formalQaPolicies); await db.delete(heartbeatRuns); await db.delete(executionWorkspaces); await db.delete(agents); await db.delete(projectWorkspaces); await db.delete(projects); await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture(input: { expired?: boolean } = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-issuer-repo-"));
    const source = path.join(root, "source"); const remote = path.join(root, "origin.git");
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-issuer-home-"));
    tempDirs.push(root, instanceRoot); await mkdir(source, { recursive: true }); git(source, "init");
    await writeFile(path.join(source, "README.md"), "issuer source\n"); git(source, "add", "README.md"); git(source, "commit", "-m", "issuer source");
    git(root, "init", "--bare", remote); git(source, "remote", "add", "origin", remote); git(source, "push", "origin", "HEAD:refs/heads/main");
    const headSha = git(source, "rev-parse", "HEAD"); const treeSha = git(source, "rev-parse", "HEAD^{tree}");
    const companyId = randomUUID(); const projectId = randomUUID(); const projectWorkspaceId = randomUUID(); const reviewerAgentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(projects).values({ id: projectId, companyId, name: "Music Tracker", status: "in_progress" });
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Formal QA", adapterType: "process" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Source checkout", sourceType: "local_path", cwd: source, repoUrl: "https://github.com/vivus-tech/music-tracker.git", isPrimary: true });
    const [policy] = await db.insert(formalQaPolicies).values({ companyId, projectId, projectWorkspaceId, reviewerAgentId, repository: "vivus-tech/music-tracker", requiredWorkflowId: "99", requiredCheckName: "PR Policy", requiredCheckAppId: 15368, enabled: true, createdByUserId: "admin", updatedByUserId: "admin" }).returning();
    const request = input.expired
      ? await db.insert(formalQaPreparations).values({
        companyId, projectId, projectWorkspaceId, repository: "vivus-tech/music-tracker", prNumber: 1902,
        headSha: "0".repeat(40), baseRef: "pending", baseSha: "0".repeat(40), treeSha: "0".repeat(40),
        evidenceSha256: "0".repeat(64), issuerReceiptSha256: "0".repeat(64),
        issuerOperationId: `request:${policy!.id}:v1`, issuedByUserId: "board-user",
        idempotencyKey: "formal-qa:vivus-tech/music-tracker#1902", requestSha256: "a".repeat(64),
        expiresAt: new Date(Date.now() - 1_000), status: "prepared",
      }).returning().then((rows) => ({ preparation: rows[0]! }))
      : await formalQaPreparationService(db).create({ companyId, projectId, projectWorkspaceId, prNumber: 1902, idempotencyKey: "formal-qa:vivus-tech/music-tracker#1902", issuedByUserId: "board-user" });
    return { root, source, remote, instanceRoot, companyId, projectId, projectWorkspaceId, headSha, treeSha, preparationId: request.preparation.id };
  }

  function pull(headSha: string) { return { state: "open", draft: false, merged: false, updated_at: "2026-09-01T00:00:00Z", head: { sha: headSha }, base: { ref: "main", sha: headSha } }; }
  function fakeGitHub(input: { headSha: string; treeSha: string; pullAtBookend?: string; checkSecondConclusion?: string; checkLink?: string; workflowLink?: string; workflowId?: string; appId?: number }) {
    const calls: string[] = []; let pullReads = 0; let checkReads = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push(url); expect(init?.headers).toMatchObject({ authorization: "Bearer scoped-token" });
      if (url.includes("/pulls/1902")) { pullReads += 1; return jsonResponse(pull(pullReads === 1 ? input.headSha : (input.pullAtBookend ?? input.headSha)), { etag: `pull-${pullReads}` }); }
      if (url.includes("/git/commits/")) return jsonResponse({ sha: input.headSha, tree: { sha: input.treeSha } }, { etag: "commit" });
      if (url.includes("/check-runs")) {
        checkReads += 1;
        return jsonResponse({ total_count: 1, check_runs: [{ id: 101, check_suite_id: 201, name: "PR Policy", app: { id: input.appId ?? 15368 }, head_sha: input.headSha, status: "completed", conclusion: checkReads === 2 ? (input.checkSecondConclusion ?? "success") : "success", completed_at: "2026-09-01T00:01:00Z" }] }, input.checkLink ? { link: input.checkLink } : { etag: `checks-${checkReads}` });
      }
      if (url.includes("/actions/runs")) return jsonResponse({ workflow_runs: [{ id: 301, workflow_id: input.workflowId ?? 99, check_suite_id: 201, head_sha: input.headSha, event: "pull_request", status: "completed", conclusion: "success", pull_requests: [{ number: 1902 }] }] }, input.workflowLink ? { link: input.workflowLink } : { etag: "workflow" });
      throw new Error(`unexpected GitHub URL: ${url}`);
    };
    return { calls, fetch };
  }
  function service(f: Awaited<ReturnType<typeof fixture>>, fetch: typeof globalThis.fetch) {
    return formalQaGitHubIssuerService(db, { fetch, tokenProvider: async (input) => { expect(input).toMatchObject({ companyId: f.companyId }); expect(input.responsibleUserId).toMatch(/^(board-user|system:formal-qa-discovery)$/); return "scoped-token"; }, checkoutInstanceRoot: f.instanceRoot, checkoutTestOnlyRemoteUrl: f.remote, checkoutTestOnlyAllowFileProtocol: true });
  }

  it("derives the exact authority from the server policy and persists canonical evidence before a clean-mirror checkout", async () => {
    const f = await fixture(); const fake = fakeGitHub(f); const result = await service(f, fake.fetch).issue({ preparationId: f.preparationId });
    expect(fake.calls).toHaveLength(6);
    expect(result.preparation).toMatchObject({ status: "issued", headSha: f.headSha, treeSha: f.treeSha, repository: "vivus-tech/music-tracker" });
    expect(result.issuance).toMatchObject({ preparationId: f.preparationId, policyVersion: 1, requiredCheckAppId: 15368, checkRunId: "101", checkSuiteId: "201", workflowRunId: "301", workflowId: "99" });
    expect(createHash("sha256").update(result.issuance.evidenceJson!).digest("hex")).toBe(result.issuance.snapshotSha256);
    expect(JSON.parse(result.issuance.evidenceJson!)).toMatchObject({ schema: "paperclip.formal-qa-github-evidence/v2", etags: { pullFirst: "pull-1", pullSecond: "pull-2" } });
    expect(git(result.checkout.checkoutPath, "rev-parse", "HEAD")).toBe(f.headSha);
    expect(await db.select().from(executionWorkspaces)).toEqual([]); expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it("rejects a paginated check listing before it creates an issuance", async () => {
    const f = await fixture(); const fake = fakeGitHub({ ...f, checkLink: '<https://api.github.com/page=2>; rel="next"' });
    await expect(service(f, fake.fetch).issue({ preparationId: f.preparationId })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_required_check_incomplete" } });
    expect(await db.select().from(formalQaIssuances)).toEqual([]); expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });

  it("rejects a paginated workflow listing before it creates an issuance", async () => {
    const f = await fixture(); const fake = fakeGitHub({ ...f, workflowLink: '<https://api.github.com/page=2>; rel="next"' });
    await expect(service(f, fake.fetch).issue({ preparationId: f.preparationId })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_required_workflow_incomplete" } });
    expect(await db.select().from(formalQaIssuances)).toEqual([]); expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });

  it("never refreshes an expired inert request into a new issuance", async () => {
    const f = await fixture({ expired: true });
    const fake = fakeGitHub(f);
    await expect(service(f, fake.fetch).issue({ preparationId: f.preparationId })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: "formal_qa_request_expired" } });
    expect(fake.calls).toEqual([]);
    await expect(service(f, fake.fetch).reconcilePrepared()).resolves.toEqual({ scanned: 0, issued: 0, deferred: 0 });
    await expect(db.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, f.preparationId)))
      .resolves.toEqual([expect.objectContaining({ status: "expired" })]);
  });

  it("terminalizes a semantic duplicate onto its canonical issuance", async () => {
    const f = await fixture();
    const fake = fakeGitHub(f);
    const issuer = service(f, fake.fetch);
    const canonical = await issuer.issue({ preparationId: f.preparationId });
    const duplicate = await formalQaPreparationService(db).create({
      companyId: f.companyId,
      projectId: f.projectId,
      projectWorkspaceId: f.projectWorkspaceId,
      prNumber: 1902,
      idempotencyKey: "formal-qa:vivus-tech/music-tracker#1902:second-controller",
      issuedByUserId: "system:formal-qa-discovery",
    });
    const replay = await issuer.issue({ preparationId: duplicate.preparation.id });
    const callsAfterConvergence = fake.calls.length;
    const replayAgain = await issuer.issue({ preparationId: duplicate.preparation.id });

    expect(replay).toMatchObject({ replayed: true, preparation: { id: canonical.preparation.id }, issuance: { id: canonical.issuance.id } });
    expect(replayAgain).toMatchObject({ replayed: true, preparation: { id: canonical.preparation.id }, issuance: { id: canonical.issuance.id } });
    expect(fake.calls).toHaveLength(callsAfterConvergence);
    await expect(db.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, duplicate.preparation.id)))
      .resolves.toEqual([expect.objectContaining({ status: "superseded", canonicalPreparationId: canonical.preparation.id })]);
  });

  it("reconciles an issued request after checkout materialization failed", async () => {
    const f = await fixture();
    const unavailableRemote = `${f.remote}.unavailable`;
    await rename(f.remote, unavailableRemote);
    const fake = fakeGitHub(f);
    const issuer = service(f, fake.fetch);

    await expect(issuer.issue({ preparationId: f.preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_verification_failed" },
    });
    expect((await db.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, f.preparationId)))[0]?.status).toBe("issued");
    expect((await db.select().from(formalQaCheckouts).where(eq(formalQaCheckouts.preparationId, f.preparationId)))[0]?.status).toBe("creating");
    expect(fake.calls).toHaveLength(6);

    await rename(unavailableRemote, f.remote);
    await expect(issuer.reconcilePrepared()).resolves.toEqual({ scanned: 1, issued: 1, deferred: 0 });
    expect((await db.select().from(formalQaCheckouts).where(eq(formalQaCheckouts.preparationId, f.preparationId)))[0]?.status).toBe("verified");
    // Recovery is bound to the already-persisted issuance and does not repeat
    // mutable GitHub reads or mint a second evidence record.
    expect(fake.calls).toHaveLength(6);
    expect(await db.select().from(formalQaIssuances)).toHaveLength(1);
  });

  it("reconciles an issued request after process loss before checkout receipt creation", async () => {
    const f = await fixture();
    const fake = fakeGitHub(f);
    const issuer = service(f, fake.fetch);
    const result = await issuer.issue({ preparationId: f.preparationId });
    await db.delete(formalQaCheckouts).where(eq(formalQaCheckouts.preparationId, f.preparationId));
    await rm(result.checkout.checkoutPath, { recursive: true, force: true });
    git(path.dirname(result.checkout.checkoutPath), "--git-dir", result.checkout.repoRoot, "worktree", "prune");

    await expect(issuer.reconcilePrepared()).resolves.toEqual({ scanned: 1, issued: 1, deferred: 0 });
    expect((await db.select().from(formalQaCheckouts).where(eq(formalQaCheckouts.preparationId, f.preparationId)))[0]?.status).toBe("verified");
    expect(fake.calls).toHaveLength(6);
    expect(await db.select().from(formalQaIssuances)).toHaveLength(1);
  });

  it("rejects a changed pull request, check rerun failure, lookalike app, and foreign workflow identity", async () => {
    for (const mutation of [
      { pullAtBookend: "f".repeat(40), code: "formal_qa_pull_changed_during_issue" },
      { checkSecondConclusion: "failure", code: "formal_qa_required_check_missing" },
      { appId: 7, code: "formal_qa_required_check_missing" },
      { workflowId: "7", code: "formal_qa_required_workflow_missing" },
    ]) {
      const f = await fixture(); const fake = fakeGitHub({ ...f, ...mutation });
      await expect(service(f, fake.fetch).issue({ preparationId: f.preparationId })).rejects.toMatchObject<HttpError>({ status: 409, details: { code: mutation.code } });
      expect(await db.select().from(formalQaIssuances)).toEqual([]);
      await db.execute(sql`truncate table formal_qa_preparations cascade`); await db.delete(activityLog); await db.delete(formalQaPolicies); await db.delete(agents); await db.delete(projectWorkspaces); await db.delete(projects); await db.delete(companies); await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    }
  });
});
