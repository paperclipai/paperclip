import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import { formalQaCheckoutService, formalQaCheckoutTestOnly } from "../services/formal-qa-checkouts.js";
import { formalQaPreparationService } from "../services/formal-qa-preparations.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("formal-QA checkout Git transport boundary", () => {
  it("enables HTTPS only for the exact production fetch while retaining deny-by-default protocols", () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);

    expect(formalQaCheckoutTestOnly.exactFetchInvocation({
      authConfigArgs: ["-c", "http.https://github.com/.extraHeader=Authorization: Basic REDACTED"],
      exactCommits: [headSha, baseSha],
    })).toEqual([
      "/usr/bin/git",
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "protocol.file.allow=never",
      "-c", "protocol.allow=never",
      "-c", "core.attributesfile=/dev/null",
      "-c", "http.https://github.com/.extraHeader=Authorization: Basic REDACTED",
      "-c", "protocol.https.allow=always",
      "fetch", "--no-tags", "--no-write-fetch-head", "origin", headSha, baseSha,
    ]);
  });

  it("does not widen unsafe transports in the production fetch invocation", () => {
    const invocation = formalQaCheckoutTestOnly.exactFetchInvocation({ exactCommits: ["a".repeat(40)] });
    expect(invocation).toContain("protocol.allow=never");
    expect(invocation).toContain("protocol.file.allow=never");
    expect(invocation).not.toContain("protocol.file.allow=always");
    expect(invocation.some((arg) => /^protocol\.(?:ext|ssh|git)\.allow=always$/.test(arg))).toBe(false);
  });
});

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

describeEmbeddedPostgres("formal-QA exact checkout boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-checkouts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`truncate table formal_qa_preparations cascade`);
    await db.delete(activityLog);
    await db.delete(formalQaPolicies);
    await db.delete(agents);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeRepository() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-repo-"));
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-home-"));
    const source = path.join(root, "source");
    const remote = path.join(root, "origin.git");
    const marker = path.join(root, "local-filter-ran");
    const filterScript = path.join(root, "local-filter.sh");
    tempDirs.push(root, instanceRoot);
    await mkdir(source, { recursive: true });
    git(source, "init");
    await writeFile(filterScript, `#!/bin/sh\nprintf x > ${marker}\ncat\n`);
    await chmod(filterScript, 0o700);
    git(source, "config", "filter.paperclip-local-test.smudge", filterScript);
    await writeFile(path.join(source, "README.md"), "exact source\n");
    await writeFile(path.join(source, ".gitattributes"), "README.md filter=paperclip-local-test\n");
    git(source, "add", "README.md");
    git(source, "commit", "-m", "exact source");
    git(root, "init", "--bare", remote);
    git(source, "remote", "add", "origin", remote);
    git(source, "push", "origin", "HEAD:refs/heads/main");
    const headSha = git(source, "rev-parse", "HEAD");
    const treeSha = git(source, "rev-parse", "HEAD^{tree}");
    return { root, source, remote, instanceRoot, headSha, treeSha, marker };
  }

  async function seed(input: { cwd: string; headSha: string; treeSha: string }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const preparationId = randomUUID();
    const reviewerAgentId = randomUUID();
    const policyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Music Tracker", status: "in_progress" });
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "Formal QA", adapterType: "process" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Source checkout",
      sourceType: "local_path",
      cwd: input.cwd,
      repoUrl: "git@github.com:vivus-tech/music-tracker.git",
      isPrimary: true,
    });
    await db.insert(formalQaPolicies).values({
      id: policyId, companyId, projectId, projectWorkspaceId, reviewerAgentId,
      repository: "vivus-tech/music-tracker", requiredWorkflowId: "99", requiredCheckName: "PR Policy",
      requiredCheckAppId: 15368, enabled: true, createdByUserId: "admin", updatedByUserId: "admin",
    });
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.insert(formalQaPreparations).values({
      id: preparationId,
      companyId,
      projectId,
      projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      prNumber: 1902,
      headSha: "0".repeat(40),
      baseRef: "pending",
      baseSha: "0".repeat(40),
      treeSha: "0".repeat(40),
      evidenceSha256: "0".repeat(64),
      issuerReceiptSha256: "0".repeat(64),
      issuerOperationId: `request:${policyId}:v1`,
      issuedByUserId: "board-user",
      idempotencyKey: "sealed-operation-1902",
      requestKey: "sealed-operation-1902",
      generation: 1,
      predecessorPreparationId: null,
      requestSha256: "c".repeat(64),
      expiresAt,
      status: "prepared",
    });
    const evidenceJson = JSON.stringify({ schema: "test", headSha: input.headSha });
    const snapshotSha256 = createHash("sha256").update(evidenceJson).digest("hex");
    await db.update(formalQaPreparations).set({
      headSha: input.headSha,
      baseRef: "main",
      baseSha: input.headSha,
      treeSha: input.treeSha,
      evidenceSha256: snapshotSha256,
      issuerReceiptSha256: snapshotSha256,
      issuerOperationId: `github-pr:vivus-tech/music-tracker#1902@${input.headSha}:policy:${policyId}:v1`,
      requestSha256: "d".repeat(64),
      expiresAt,
      status: "issued",
      updatedAt: new Date(Date.now() + 1),
    }).where(eq(formalQaPreparations.id, preparationId));
    await db.insert(formalQaIssuances).values({
      preparationId,
      policyId,
      policyVersion: 1,
      companyId,
      projectId,
      projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      prNumber: "1902",
      headSha: input.headSha,
      baseRef: "main",
      baseSha: input.headSha,
      treeSha: input.treeSha,
      requiredCheckName: "PR Policy",
      requiredCheckAppId: 15368,
      checkRunId: "1001",
      checkSuiteId: "2001",
      workflowRunId: "3001",
      workflowId: "99",
      evidenceJson,
      snapshotSha256,
    });
    return { companyId, projectId, projectWorkspaceId, preparationId };
  }

  it("creates one detached, registered exact checkout without an execution workspace or heartbeat run", async () => {
    const fixture = await makeRepository();
    const { companyId, preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });

    expect(await db.select({ cwd: projectWorkspaces.cwd }).from(projectWorkspaces)).toEqual([{ cwd: fixture.root }]);

    const result = await service.materialize({ preparationId });

    expect(result.replayed).toBe(false);
    expect(result.checkout.companyId).toBe(companyId);
    expect(result.checkout.checkoutPath).toBe(path.join(
      fixture.instanceRoot,
      "formal-qa-checkouts",
      companyId,
      preparationId,
    ));
    expect(git(result.checkout.checkoutPath, "rev-parse", "HEAD")).toBe(fixture.headSha);
    expect(git(result.checkout.checkoutPath, "rev-parse", "HEAD^{tree}")).toBe(fixture.treeSha);
    expect(() => git(result.checkout.checkoutPath, "symbolic-ref", "--quiet", "HEAD")).toThrow();
    expect(git(result.checkout.checkoutPath, "status", "--porcelain", "--untracked-files=all")).toBe("");
    await expect(access(fixture.marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await db.select().from(executionWorkspaces)).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it("replays only the same untampered exact checkout and rejects a dirty checkout", async () => {
    const fixture = await makeRepository();
    const { preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });
    const created = await service.materialize({ preparationId });
    const replayed = await service.materialize({ preparationId });
    expect(replayed.replayed).toBe(true);
    expect(replayed.checkout.id).toBe(created.checkout.id);

    await writeFile(path.join(created.checkout.checkoutPath, "tampered.txt"), "no\n");
    await expect(service.materialize({ preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_verification_failed" },
    });
  });

  it("honors live policy disablement before creating or replaying a checkout", async () => {
    const fixture = await makeRepository();
    const { preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });
    await db.update(formalQaPolicies).set({
      enabled: false,
      version: sql`${formalQaPolicies.version} + 1`,
      updatedAt: new Date(Date.now() + 1_000),
    });
    await expect(service.materialize({ preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_policy_revoked" },
    });
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });

  it("rejects both a board-prepared authority and an issued authority without a matching GitHub issuance", async () => {
    const fixture = await makeRepository();
    const { preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });

    const [issued] = await db.select().from(formalQaPreparations).where(eq(formalQaPreparations.id, preparationId));
    const prepared = await formalQaPreparationService(db).create({
      companyId: issued!.companyId,
      projectId: issued!.projectId,
      projectWorkspaceId: issued!.projectWorkspaceId,
      prNumber: 1903,
      idempotencyKey: "board-prepared-only",
      issuedByUserId: "board-user",
    });
    await expect(service.materialize({ preparationId: prepared.preparation.id })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_issuance_missing" },
    });
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);

    await db.delete(formalQaIssuances);
    await expect(service.materialize({ preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_issuance_missing" },
    });
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });

  it("recovers a durable creating receipt after worktree creation was interrupted", async () => {
    const fixture = await makeRepository();
    const ids = await seed({ ...fixture, cwd: fixture.root });
    const checkoutPath = path.join(fixture.instanceRoot, "formal-qa-checkouts", ids.companyId, ids.preparationId);
    await mkdir(path.dirname(checkoutPath), { recursive: true });
    const digest = createHash("sha256").update(JSON.stringify({
      preparationId: ids.preparationId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      headSha: fixture.headSha,
      treeSha: fixture.treeSha,
      repoRoot: path.join(fixture.instanceRoot, "formal-qa-mirrors", createHash("sha256").update("vivus-tech/music-tracker").digest("hex")),
      checkoutPath,
    })).digest("hex");
    await db.insert(formalQaCheckouts).values({
      preparationId: ids.preparationId,
      companyId: ids.companyId,
      projectId: ids.projectId,
      projectWorkspaceId: ids.projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      repoRoot: path.join(fixture.instanceRoot, "formal-qa-mirrors", createHash("sha256").update("vivus-tech/music-tracker").digest("hex")),
      checkoutPath,
      headSha: fixture.headSha,
      treeSha: fixture.treeSha,
      checkoutSha256: digest,
      status: "creating",
    });
    // This simulates process loss after Git succeeded but before the receipt
    // could be marked verified. The retry must reconcile, not deadlock.
    const mirrorRoot = path.join(fixture.instanceRoot, "formal-qa-mirrors", createHash("sha256").update("vivus-tech/music-tracker").digest("hex"));
    await mkdir(path.dirname(mirrorRoot), { recursive: true });
    git(path.dirname(mirrorRoot), "init", "--bare", mirrorRoot);
    git(mirrorRoot, "remote", "add", "origin", fixture.remote);
    git(mirrorRoot, "-c", "protocol.file.allow=always", "fetch", "origin", fixture.headSha);
    git(mirrorRoot, "worktree", "add", "--detach", checkoutPath, fixture.headSha);

    const result = await formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true })
      .materialize({ preparationId: ids.preparationId });

    expect(result.replayed).toBe(false);
    expect(result.checkout.status).toBe("verified");
    expect(git(checkoutPath, "rev-parse", "HEAD")).toBe(fixture.headSha);
  });

  it("database-rejects a tenant mutation after checkout verification", async () => {
    const fixture = await makeRepository();
    const { companyId, preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });
    const created = await service.materialize({ preparationId });
    const otherCompanyId = randomUUID();
    await db.insert(companies).values({
      id: otherCompanyId,
      name: "Other company",
      issuePrefix: `O${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.update(formalQaCheckouts).set({ companyId: otherCompanyId })
      .where(eq(formalQaCheckouts.id, created.checkout.id))
      .then(
        () => { throw new Error("checkout tenant mutation unexpectedly succeeded"); },
        (error: { cause?: { message?: string } }) => {
          expect(error.cause?.message).toContain("formal_qa_checkout_immutable");
        },
      );
    expect(companyId).not.toBe(otherCompanyId);
  });

  it("fails closed for an absent object and a tree mismatch while ignoring the untrusted workspace origin", async () => {
    const fixture = await makeRepository();
    const missing = await seed({ ...fixture, cwd: fixture.root, headSha: "f".repeat(40) });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });
    await expect(service.materialize({ preparationId: missing.preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_verification_failed" },
    });

    await db.execute(sql`truncate table formal_qa_preparations cascade`);
    const treeMismatch = await seed({ ...fixture, cwd: fixture.root, treeSha: "f".repeat(40) });
    await expect(service.materialize({ preparationId: treeMismatch.preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_source_mismatch" },
    });

    await db.execute(sql`truncate table formal_qa_preparations cascade`);
    const originMismatch = await seed({ ...fixture, cwd: fixture.root });
    await expect(service.materialize({ preparationId: originMismatch.preparationId })).resolves.toMatchObject({
      checkout: { headSha: fixture.headSha },
    });
  });

  it("rejects a symlinked instance root before creating any checkout", async () => {
    const fixture = await makeRepository();
    const { preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const linkedRoot = `${fixture.instanceRoot}-link`;
    tempDirs.push(linkedRoot);
    await symlink(fixture.instanceRoot, linkedRoot);
    const service = formalQaCheckoutService(db, { instanceRoot: linkedRoot, testOnlyRemoteUrl: fixture.remote, testOnlyAllowFileProtocol: true });

    await expect(service.materialize({ preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_path_untrusted" },
    });
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });
});
