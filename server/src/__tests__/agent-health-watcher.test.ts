import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentRuntimeState,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createAgentHealthWatcher } from "../services/agent-health-watcher.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent health watcher tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent health watcher", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-health-watcher-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "GStack",
      issuePrefix: "GST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CTO",
      role: "cto",
      status: "error",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      pauseReason: "adapter crashed",
      updatedAt: new Date("2026-05-13T09:00:00.000Z"),
    });

    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "codex_local",
      lastError: "adapter timeout",
      stateJson: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      issueNumber: 26,
      identifier: "GST-26",
      title: "CEO standup",
      status: "in_progress",
      priority: "high",
    });

    return { companyId, agentId, issueId };
  }

  it("posts one alert after threshold and one recovery comment after status clears", async () => {
    const { agentId, issueId } = await seedFixture();
    let now = new Date("2026-05-13T09:06:00.000Z");

    const watcher = createAgentHealthWatcher(db, {
      errorThresholdMs: 5 * 60 * 1_000,
      now: () => now,
    });

    await watcher.tick();

    const firstPassComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));

    expect(firstPassComments).toHaveLength(1);
    expect(firstPassComments[0]?.body).toContain("Adapter health alert");
    expect(firstPassComments[0]?.body).toContain("CTO (cto)");
    expect(firstPassComments[0]?.body).toContain("adapter timeout");
    expect(firstPassComments[0]?.body).toContain(`/agents/${agentId}`);

    now = new Date("2026-05-13T09:16:00.000Z");
    await watcher.tick();

    const secondPassComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(secondPassComments).toHaveLength(1);

    await db
      .update(agents)
      .set({ status: "running", updatedAt: now })
      .where(eq(agents.id, agentId));

    await watcher.tick();

    const recoveredComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));

    expect(recoveredComments).toHaveLength(2);
    expect(recoveredComments[1]?.body).toContain("Adapter health recovered");

    await db
      .update(agents)
      .set({ status: "error", updatedAt: new Date("2026-05-13T09:17:00.000Z") })
      .where(eq(agents.id, agentId));

    now = new Date("2026-05-13T09:20:00.000Z");
    await watcher.tick();

    const belowThresholdComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(belowThresholdComments).toHaveLength(2);

    now = new Date("2026-05-13T09:23:00.000Z");
    await watcher.tick();

    const retriggerComments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(retriggerComments).toHaveLength(3);
    expect(retriggerComments[2]?.body).toContain("Adapter health alert");

    const alerts = retriggerComments.filter((comment) => comment.body.includes("Adapter health alert"));
    expect(alerts).toHaveLength(2);

    const recordsForIssue = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), eq(issueComments.authorType, "system")));
    expect(recordsForIssue).toHaveLength(3);
  });
});
