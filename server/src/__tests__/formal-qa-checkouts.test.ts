import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  executionWorkspaces,
  formalQaCheckouts,
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
import { formalQaCheckoutService } from "../services/formal-qa-checkouts.js";

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

describeEmbeddedPostgres("formal-QA exact checkout boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-formal-qa-checkouts-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(formalQaCheckouts);
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

  async function makeRepository() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-repo-"));
    const instanceRoot = await mkdtemp(path.join(os.tmpdir(), "paperclip-formal-qa-home-"));
    tempDirs.push(root, instanceRoot);
    git(root, "init");
    git(root, "remote", "add", "origin", "git@github.com:vivus-tech/music-tracker.git");
    await writeFile(path.join(root, "README.md"), "exact source\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "exact source");
    const headSha = git(root, "rev-parse", "HEAD");
    const treeSha = git(root, "rev-parse", "HEAD^{tree}");
    return { root, instanceRoot, headSha, treeSha };
  }

  async function seed(input: { cwd: string; headSha: string; treeSha: string }) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const preparationId = randomUUID();
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
      cwd: input.cwd,
      repoUrl: "git@github.com:vivus-tech/music-tracker.git",
      isPrimary: true,
    });
    await db.insert(formalQaPreparations).values({
      id: preparationId,
      companyId,
      projectId,
      projectWorkspaceId,
      repository: "vivus-tech/music-tracker",
      prNumber: 1902,
      headSha: input.headSha,
      baseRef: "main",
      baseSha: input.headSha,
      treeSha: input.treeSha,
      evidenceSha256: "a".repeat(64),
      issuerReceiptSha256: "b".repeat(64),
      issuerOperationId: "operation-1902",
      issuedByUserId: "board-user",
      idempotencyKey: "sealed-operation-1902",
      requestSha256: "c".repeat(64),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return { companyId, preparationId };
  }

  it("creates one detached, registered exact checkout without an execution workspace or heartbeat run", async () => {
    const fixture = await makeRepository();
    const { companyId, preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot });

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
    expect(await db.select().from(executionWorkspaces)).toEqual([]);
    expect(await db.select().from(heartbeatRuns)).toEqual([]);
  });

  it("replays only the same untampered exact checkout and rejects a dirty checkout", async () => {
    const fixture = await makeRepository();
    const { preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot });
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

  it("fails closed for an absent object, a tree mismatch, and an origin mismatch", async () => {
    const fixture = await makeRepository();
    const missing = await seed({ ...fixture, cwd: fixture.root, headSha: "0".repeat(40) });
    const service = formalQaCheckoutService(db, { instanceRoot: fixture.instanceRoot });
    await expect(service.materialize({ preparationId: missing.preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_verification_failed" },
    });

    await db.delete(formalQaPreparations);
    const treeMismatch = await seed({ ...fixture, cwd: fixture.root, treeSha: "f".repeat(40) });
    await expect(service.materialize({ preparationId: treeMismatch.preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_source_mismatch" },
    });

    await db.delete(formalQaPreparations);
    git(fixture.root, "remote", "set-url", "origin", "git@github.com:other/repository.git");
    const originMismatch = await seed({ ...fixture, cwd: fixture.root });
    await expect(service.materialize({ preparationId: originMismatch.preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_repository_mismatch" },
    });
  });

  it("rejects a symlinked instance root before creating any checkout", async () => {
    const fixture = await makeRepository();
    const { preparationId } = await seed({ ...fixture, cwd: fixture.root });
    const linkedRoot = `${fixture.instanceRoot}-link`;
    tempDirs.push(linkedRoot);
    await symlink(fixture.instanceRoot, linkedRoot);
    const service = formalQaCheckoutService(db, { instanceRoot: linkedRoot });

    await expect(service.materialize({ preparationId })).rejects.toMatchObject<HttpError>({
      status: 409,
      details: { code: "formal_qa_checkout_path_untrusted" },
    });
    expect(await db.select().from(formalQaCheckouts)).toEqual([]);
  });
});
