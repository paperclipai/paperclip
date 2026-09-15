import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { adoptRunSourceIssue } from "../services/run-source-issue.js";
import { observeCrossIssueInfluence } from "../services/cross-issue-influence-limit.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("adoptRunSourceIssue against PostgreSQL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-source-issue-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(contextSnapshot: Record<string, unknown> | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Checkout Coder",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "board-user",
      contextSnapshot,
    });

    return { companyId, agentId, runId };
  }

  async function readContext(runId: string) {
    const row = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    return row?.contextSnapshot ?? null;
  }

  it("gives an unscoped run its checked-out issue", async () => {
    const { companyId, agentId, runId } = await seedRun(null);
    const issueId = randomUUID();

    await expect(adoptRunSourceIssue(db, { runId, agentId, companyId, issueId })).resolves.toBe(true);
    expect(await readContext(runId)).toMatchObject({ issueId, source: "issue.checkout.self" });
  });

  it("keeps the rest of an existing context snapshot", async () => {
    const { companyId, agentId, runId } = await seedRun({ triggeredBy: "board", actorId: "board-user" });
    const issueId = randomUUID();

    await adoptRunSourceIssue(db, { runId, agentId, companyId, issueId });

    // A merge, not a replacement: whatever the wake recorded must survive.
    expect(await readContext(runId)).toMatchObject({
      triggeredBy: "board",
      actorId: "board-user",
      issueId,
    });
  });

  it("never replaces a source issue the run already has", async () => {
    const firstIssueId = randomUUID();
    const { companyId, agentId, runId } = await seedRun({ issueId: firstIssueId });

    await expect(
      adoptRunSourceIssue(db, { runId, agentId, companyId, issueId: randomUUID() }),
    ).resolves.toBe(false);
    expect(await readContext(runId)).toMatchObject({ issueId: firstIssueId });
  });

  it("treats a taskId as an existing source issue", async () => {
    // readRunSourceIssueId accepts either spelling, so adopting over a taskId
    // would silently move the run's source.
    const taskId = randomUUID();
    const { companyId, agentId, runId } = await seedRun({ taskId });

    await expect(
      adoptRunSourceIssue(db, { runId, agentId, companyId, issueId: randomUUID() }),
    ).resolves.toBe(false);
    expect(await readContext(runId)).toMatchObject({ taskId });
  });

  it("refuses to adopt for an agent that does not own the run", async () => {
    const { companyId, runId } = await seedRun(null);

    await expect(
      adoptRunSourceIssue(db, { runId, agentId: randomUUID(), companyId, issueId: randomUUID() }),
    ).resolves.toBe(false);
    expect(await readContext(runId)).toBeNull();
  });

  it("refuses to adopt across a company boundary", async () => {
    const { agentId, runId } = await seedRun(null);

    await expect(
      adoptRunSourceIssue(db, { runId, agentId, companyId: randomUUID(), issueId: randomUUID() }),
    ).resolves.toBe(false);
    expect(await readContext(runId)).toBeNull();
  });

  it("lets only one of two concurrent adoptions win", async () => {
    const { companyId, agentId, runId } = await seedRun(null);
    const first = randomUUID();
    const second = randomUUID();

    // The no-overwrite rule has to hold under concurrency, which is why the
    // null test lives in the WHERE clause rather than in a prior read.
    const results = await Promise.all([
      adoptRunSourceIssue(db, { runId, agentId, companyId, issueId: first }),
      adoptRunSourceIssue(db, { runId, agentId, companyId, issueId: second }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const context = (await readContext(runId)) as { issueId?: string } | null;
    expect([first, second]).toContain(context?.issueId);
  });

  it("unblocks a write to the adopted issue that would otherwise be refused", async () => {
    const { companyId, agentId, runId } = await seedRun(null);
    const issueId = randomUUID();
    const input = {
      companyId,
      runId,
      agentId,
      targetIssueId: issueId,
      kind: "comment" as const,
    };

    // This is the bug in one assertion: before adoption the run cannot write to
    // the very issue it is about to check out.
    await expect(observeCrossIssueInfluence(db, input)).rejects.toThrow();

    await adoptRunSourceIssue(db, { runId, agentId, companyId, issueId });

    // Same-issue writes return null - allowed, and not counted against the cap.
    await expect(observeCrossIssueInfluence(db, input)).resolves.toBeNull();
  });
});
