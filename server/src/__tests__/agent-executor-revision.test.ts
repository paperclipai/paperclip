/**
 * Phase-4 4b-4 — Agent.executor change creates Config-Revision with changedKey 'executor'.
 *
 * Spec aus Plan § 4b-1: Agent-Update mit executor=hermes erzeugt Config-Revision
 * mit changedKey 'executor'. Ohne diese Revision waere ein Executor-Flip nicht
 * auditierbar (Memory-Pattern feedback_codex_subagent_default + Privilege-Matrix).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping agent-executor-revision tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent.executor config-revision (Phase-4 4b-4)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-executor-revision-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent(initialExecutor: "hermes" | "mc-dispatch") {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "test-co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "test-agent",
      role: "engineer",
      status: "running",
      executor: initialExecutor,
      adapterType: "codex_local",
    });
    return agentId;
  }

  it("updating executor mc-dispatch -> hermes creates revision with changedKey 'executor'", async () => {
    const agentId = await seedCompanyAndAgent("mc-dispatch");
    const svc = agentService(db);

    await svc.update(
      agentId,
      { executor: "hermes" },
      { recordRevision: { source: "test", createdByUserId: "user-1" } },
    );

    const revisions = await db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));

    expect(revisions.length).toBe(1);
    expect(revisions[0]?.changedKeys).toContain("executor");
  });

  it("no revision when executor unchanged", async () => {
    const agentId = await seedCompanyAndAgent("mc-dispatch");
    const svc = agentService(db);

    await svc.update(
      agentId,
      { executor: "mc-dispatch" },
      { recordRevision: { source: "test", createdByUserId: "user-1" } },
    );

    const revisions = await db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));

    expect(revisions.length).toBe(0);
  });

  it("update without recordRevision metadata creates no revision even on executor change", async () => {
    const agentId = await seedCompanyAndAgent("mc-dispatch");
    const svc = agentService(db);

    await svc.update(agentId, { executor: "hermes" });

    const revisions = await db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));

    expect(revisions.length).toBe(0);
  });

  it("multiple field changes including executor list all changed keys", async () => {
    const agentId = await seedCompanyAndAgent("mc-dispatch");
    const svc = agentService(db);

    await svc.update(
      agentId,
      { executor: "hermes", title: "Phase-4 worker" },
      { recordRevision: { source: "test", createdByUserId: "user-1" } },
    );

    const revisions = await db
      .select()
      .from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));

    expect(revisions.length).toBe(1);
    const changedKeys = revisions[0]?.changedKeys;
    expect(changedKeys).toContain("executor");
    expect(changedKeys).toContain("title");
  });
});
