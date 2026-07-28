import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  bumpIssueVersions,
  IssueVersionConflictError,
  runIssueMutation,
  versionedIssuePatch,
} from "../services/issue-versioning.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("issue versioning service", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  async function createIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Versioning test company",
      issuePrefix: `V${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Versioned issue",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  async function issueById(issueId: string) {
    return await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-versioning-service-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows one of two concurrent writes for the same expected version", async () => {
    const { issueId } = await createIssue();
    const writes = await Promise.allSettled([
      runIssueMutation(db, {
        issueId,
        expectedVersion: 1,
        mutate: async () => ({ issuePatch: { title: "First write" }, result: "first" }),
      }),
      runIssueMutation(db, {
        issueId,
        expectedVersion: 1,
        mutate: async () => ({ issuePatch: { title: "Second write" }, result: "second" }),
      }),
    ]);

    const fulfilled = writes.filter((write) => write.status === "fulfilled");
    const rejected = writes.filter((write) => write.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const conflict = rejected[0]?.reason;
    expect(conflict).toBeInstanceOf(IssueVersionConflictError);
    if (!(conflict instanceof IssueVersionConflictError)) {
      throw new Error("Expected an issue version conflict");
    }
    expect(conflict.currentVersion).toBe(2);
    expect((await issueById(issueId))?.version).toBe(2);
  });

  it("returns the current version on stale conflict", async () => {
    const { issueId } = await createIssue();
    await runIssueMutation(db, {
      issueId,
      mutate: async () => ({ result: undefined }),
    });

    await expect(
      runIssueMutation(db, {
        issueId,
        expectedVersion: 1,
        mutate: async () => ({ result: undefined }),
      }),
    ).rejects.toMatchObject({
      message: "Issue version conflict",
      currentVersion: 2,
    });
  });

  it("rolls back callback writes when the mutation throws or its final update fails", async () => {
    const first = await createIssue();
    await expect(
      runIssueMutation(db, {
        issueId: first.issueId,
        mutate: async (tx) => {
          await tx
            .update(companies)
            .set({ description: "should roll back" })
            .where(eq(companies.id, first.companyId));
          throw new Error("mutation failed");
        },
      }),
    ).rejects.toThrow("mutation failed");
    expect((await issueById(first.issueId))?.version).toBe(1);

    const second = await createIssue();
    await expect(
      runIssueMutation(db, {
        issueId: second.issueId,
        mutate: async (tx) => {
          await tx
            .update(companies)
            .set({ description: "should also roll back" })
            .where(eq(companies.id, second.companyId));
          await tx.delete(issues).where(eq(issues.id, second.issueId));
          return { result: undefined };
        },
      }),
    ).rejects.toThrow("Locked issue version update returned no row");
    expect((await issueById(second.issueId))?.version).toBe(1);
  });

  it("increments exactly once for a compound callback", async () => {
    const { companyId, issueId } = await createIssue();
    const mutation = await runIssueMutation(db, {
      issueId,
      expectedVersion: 1,
      mutate: async (tx) => {
        await tx
          .update(companies)
          .set({ description: "compound mutation" })
          .where(eq(companies.id, companyId));
        return {
          issuePatch: { title: "Compound mutation complete" },
          result: { companyUpdated: true },
        };
      },
    });

    expect(mutation).toMatchObject({
      issue: { id: issueId, title: "Compound mutation complete", version: 2 },
      result: { companyUpdated: true },
    });
  });

  it("increments an unheadered legacy mutation", async () => {
    const { issueId } = await createIssue();
    const mutation = await runIssueMutation(db, {
      issueId,
      mutate: async () => ({ result: "legacy mutation" }),
    });

    expect(mutation).toMatchObject({
      issue: { id: issueId, version: 2 },
      result: "legacy mutation",
    });
  });

  it("increments each distinct issue once for a bulk parent-version bump", async () => {
    const first = await createIssue();
    const second = await createIssue();

    const updatedIds = await bumpIssueVersions(db, [
      first.issueId,
      second.issueId,
      first.issueId,
    ]);

    expect(new Set(updatedIds)).toEqual(new Set([first.issueId, second.issueId]));
    expect((await issueById(first.issueId))?.version).toBe(2);
    expect((await issueById(second.issueId))?.version).toBe(2);
  });

  it("inserts a stop-relay comment within the parent's single version transition", async () => {
    const { companyId, issueId: parentId } = await createIssue();
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      parentId,
      title: "Blocked child",
      status: "blocked",
      priority: "medium",
    });
    const service = issueService(db);
    const child = await issueById(childId);
    if (!child) throw new Error("Expected child issue");

    const relay = await service.addStopRelayCommentIfNeeded(child);

    expect(relay).toMatchObject({
      parent: { id: parentId, version: 2 },
      comment: { issueId: parentId, authorType: "system" },
    });
    expect((await issueById(parentId))?.version).toBe(2);
    await expect(service.addStopRelayCommentIfNeeded(child)).resolves.toBeNull();
    expect((await issueById(parentId))?.version).toBe(2);
    expect(
      await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(eq(issueComments.issueId, parentId)),
    ).toHaveLength(1);
  });

  it("returns null for a missing issue and joins a supplied transaction", async () => {
    await expect(
      runIssueMutation(db, {
        issueId: randomUUID(),
        mutate: async () => ({ result: "missing" }),
      }),
    ).resolves.toBeNull();

    const { issueId } = await createIssue();
    await db.transaction(async (tx) => {
      const mutation = await runIssueMutation(tx, {
        issueId,
        mutate: async () => ({ issuePatch: { title: "Joined transaction" }, result: true }),
      });
      expect(mutation).toMatchObject({ issue: { version: 2 }, result: true });
    });
    expect((await issueById(issueId))?.title).toBe("Joined transaction");
  });

  it("joins checkout adoption to a conditional issue update", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Checkout CAS company",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Conditional checkout update",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const service = issueService(db);

    const result = await db.transaction(async (tx) => {
      const ownership = await service.assertCheckoutOwnerInTransaction(issueId, agentId, runId, 1, tx);
      return service.update(issueId, {
        ...ownership.issuePatch,
        title: "Updated atomically",
        expectedVersion: 1,
      }, tx);
    });

    expect(result).toMatchObject({
      title: "Updated atomically",
      checkoutRunId: runId,
      executionRunId: runId,
      version: 2,
    });
  });

  it("rejects terminal same-run checkout owners", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Invalid same-run company",
      issuePrefix: `I${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Invalid same-run agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "cancelled",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Invalid same-run checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
    });
    const service = issueService(db);

    await expect(
      db.transaction(async (tx) =>
        service.assertCheckoutOwnerInTransaction(issueId, agentId, runId, 1, tx)
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await issueById(issueId))?.version).toBe(1);
  });

  it("joins checkout adoption to conditional comment deletion", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Comment CAS company",
      issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Commenter",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Conditional comment delete",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorType: "agent",
      authorAgentId: agentId,
      body: "Delete atomically",
    });
    const service = issueService(db);

    const result = await db.transaction(async (tx) => {
      const ownership = await service.assertCheckoutOwnerInTransaction(issueId, agentId, runId, 1, tx);
      return service.tombstoneCommentVersioned(
        commentId,
        { actorType: "agent", agentId, runId },
        { expectedVersion: 1, dbOrTx: tx, issuePatch: ownership.issuePatch },
      );
    });

    expect(result).toMatchObject({
      issue: {
        checkoutRunId: runId,
        executionRunId: runId,
        version: 2,
      },
      comment: {
        id: commentId,
        deletedAt: expect.any(Date),
      },
    });
  });

  it("honors managed isolated-workspace enablement during updates", async () => {
    const originalManagedConfig = process.env.PAPERCLIP_MANAGED_CONFIG;
    const { issueId } = await createIssue();
    try {
      process.env.PAPERCLIP_MANAGED_CONFIG = JSON.stringify({
        v: 1,
        mode: "cloud",
        catalogVersion: "2026.720.0",
        features: { enableIsolatedWorkspaces: true },
        plugins: { autoInstall: [] },
      });

      const updated = await issueService(db).update(issueId, {
        executionWorkspacePreference: "reuse_existing",
      });

      expect(updated?.executionWorkspacePreference).toBe("reuse_existing");
    } finally {
      if (originalManagedConfig === undefined) {
        delete process.env.PAPERCLIP_MANAGED_CONFIG;
      } else {
        process.env.PAPERCLIP_MANAGED_CONFIG = originalManagedConfig;
      }
    }
  });

  it("overrides prohibited version and updatedAt values in versioned patches", () => {
    const now = new Date("2026-07-23T09:00:00.000Z");
    // @ts-expect-error Issue mutation patches cannot set version or updatedAt.
    const patch = versionedIssuePatch({ title: "Safe patch", version: 99, updatedAt: new Date(0) }, now);

    expect(patch.updatedAt).toBe(now);
    expect(patch.version).not.toBe(99);
  });
});
