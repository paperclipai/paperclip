import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issueComments, issues, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { issueService } from "../issues.js";
import { performStaleRunCleanup } from "./service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale-run cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("performStaleRunCleanup (integration)", () => {
  it("force-fails stale runs, resets agents, and posts comments", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("stale-run-cleanup-");
    const db = createDb(tempDb.connectionString);
    const issuesSvc = issueService(db);

    // Seed company + agent
    const [company] = await db
      .insert(companies)
      .values({ name: "TestCo" })
      .returning();

    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "TestAgent",
        status: "running",
        adapterType: "claude_local",
        metadata: { consecutiveErrorCount: 3 },
      })
      .returning();

    // Seed issue linked to the run via execution_run_id
    const [issue] = await db
      .insert(issues)
      .values({
        companyId: company.id,
        title: "Test Issue",
        status: "in_progress",
        assigneeAgentId: agent.id,
      })
      .returning();

    const staleTime = new Date(Date.now() - 31 * 60 * 1000);

    // Seed running heartbeat run with old updatedAt
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: company.id,
        agentId: agent.id,
        status: "running",
        updatedAt: staleTime,
        contextSnapshot: { issueId: issue.id },
      })
      .returning();

    // Link issue execution_run_id to the run
    await db
      .update(issues)
      .set({ executionRunId: run.id })
      .where(eq(issues.id, issue.id));

    const result = await performStaleRunCleanup(db, issuesSvc, {
      staleMinutes: 30,
    });

    expect(result.scanned).toBe(1);
    expect(result.forceFailed).toEqual([run.id]);
    expect(result.adapterSwitched).toEqual([agent.id]);
    expect(result.commentsPosted).toBe(2); // cleanup + adapter switch

    // Verify run is failed
    const runRows = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, run.id));
    expect(runRows[0]?.status).toBe("failed");

    // Verify agent is idle and adapter switched
    const agentRows = await db.select().from(agents).where(eq(agents.id, agent.id));
    expect(agentRows[0]?.status).toBe("idle");
    expect(agentRows[0]?.adapterType).toBe("opencode_local");

    // Verify comments posted
    const commentRows = await db
      .select()
      .from(issueComments)
      .where(eq(issueComments.issueId, issue.id))
      .orderBy(issueComments.createdAt);
    expect(commentRows.length).toBe(2);
    expect(commentRows[0]?.body).toContain("force-failed");
    expect(commentRows[1]?.body).toContain("Auto-recovery");

    await tempDb.cleanup();
  });

  it("returns empty result when no stale runs", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("stale-run-cleanup-");
    const db = createDb(tempDb.connectionString);
    const issuesSvc = issueService(db);

    const result = await performStaleRunCleanup(db, issuesSvc, {
      staleMinutes: 30,
    });
    expect(result.scanned).toBe(0);
    expect(result.forceFailed).toEqual([]);

    await tempDb.cleanup();
  });

  it("skips fresh runs", async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("stale-run-cleanup-");
    const db = createDb(tempDb.connectionString);
    const issuesSvc = issueService(db);

    const [company] = await db
      .insert(companies)
      .values({ name: "TestCo2" })
      .returning();

    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "TestAgent2",
        status: "running",
        adapterType: "claude_local",
      })
      .returning();

    await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      status: "running",
      updatedAt: new Date(),
    });

    const result = await performStaleRunCleanup(db, issuesSvc, {
      staleMinutes: 30,
    });
    expect(result.scanned).toBe(0);

    await tempDb.cleanup();
  });
});
