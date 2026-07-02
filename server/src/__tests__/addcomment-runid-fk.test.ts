import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres addComment run-id FK tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Regression coverage: addComment must never raise a raw FK 500 when handed a
// stale/foreign/malformed createdByRunId. Unknown run-ids are demoted to NULL
// so the comment (and audit trail) is preserved.
describeEmbeddedPostgres("addComment createdByRunId hardening", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-addcomment-runid-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "AddComment RunId Co",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "ARC-1",
      title: "addComment run-id FK hardening",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  async function seedRun(companyId: string) {
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Run Owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    return { agentId, runId };
  }

  it("demotes an unknown (but well-formed) run-id to NULL instead of throwing FK 500", async () => {
    const { issueId } = await seedIssue();
    const ghostRunId = randomUUID(); // valid UUID, no matching heartbeat_runs row

    const comment = await issueService(db).addComment(issueId, "status update", {
      runId: ghostRunId,
    });

    expect(comment).toBeTruthy();
    expect(comment?.createdByRunId).toBeNull();

    const [persisted] = await db.select().from(issueComments);
    expect(persisted.createdByRunId).toBeNull();
    expect(persisted.body).toBe("status update");
  });

  it("demotes a malformed (non-UUID) run-id to NULL instead of throwing 22P02", async () => {
    const { issueId } = await seedIssue();

    const comment = await issueService(db).addComment(issueId, "another update", {
      runId: "not-a-uuid",
    });

    expect(comment).toBeTruthy();
    expect(comment?.createdByRunId).toBeNull();
  });

  it("preserves a valid existing run-id", async () => {
    const { companyId, issueId } = await seedIssue();
    const { runId } = await seedRun(companyId);

    const comment = await issueService(db).addComment(issueId, "real run update", {
      runId,
    });

    expect(comment?.createdByRunId).toBe(runId);
  });
});
