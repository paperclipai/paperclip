import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll, afterEach, beforeAll } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildRecallSnippet,
  resolveRunRecallLimit,
  searchRunRecall,
  tokenizeRunRecallQuery,
} from "../services/run-recall.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run recall tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("run recall query", () => {
  it("tokenizes, dedupes, and floors tiny tokens", () => {
    expect(tokenizeRunRecallQuery("  ")).toEqual([]);
    expect(tokenizeRunRecallQuery("a I")).toEqual([]);
    expect(tokenizeRunRecallQuery("Deploy  deploy   FAILED")).toEqual(["deploy", "failed"]);
    expect(tokenizeRunRecallQuery("(timeout!)")).toEqual(["timeout"]);
    expect(tokenizeRunRecallQuery("aa bb cc dd ee ff gg hh ii jj kk")).toHaveLength(8);
  });

  it("clamps limits to the bounded window", () => {
    expect(resolveRunRecallLimit(undefined)).toBe(50);
    expect(resolveRunRecallLimit(Number.NaN)).toBe(50);
    expect(resolveRunRecallLimit(0)).toBe(1);
    expect(resolveRunRecallLimit(10_000)).toBe(200);
  });

  it("builds bounded snippets around the first hit", () => {
    expect(buildRecallSnippet("short", ["short"])).toBe("short");
    const text = `${"x".repeat(500)}needle${"y".repeat(500)}`;
    const snippet = buildRecallSnippet(text, ["needle"]);
    expect(snippet).toContain("needle");
    expect(snippet.length).toBeLessThanOrEqual(242);
    expect(buildRecallSnippet("no hit here", ["zzz"])).toContain("no hit here");
  });
});

describeEmbeddedPostgres("searchRunRecall", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-recall-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Recall",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Recall agent", role: "engineer" });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deploy outage",
      status: "todo",
      priority: "medium",
    });
    return { companyId, agentId, issueId };
  }

  it("finds runs by error text and result summary with snippets", async () => {
    const { companyId, agentId, issueId } = await seed();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "failed",
      error: "connection reset while pushing the release artifact",
      errorCode: "E_CONN",
      contextSnapshot: { issueId },
    });
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      resultJson: { summary: "release artifact published without errors" },
      contextSnapshot: { issueId },
    });

    const result = await searchRunRecall(db, { companyId, query: "release artifact" });
    expect(result.query).toBe("release artifact");
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]?.snippet.toLowerCase()).toContain("release artifact");

    const failed = await searchRunRecall(db, { companyId, query: "connection reset" });
    expect(failed.runs).toHaveLength(1);
    expect(failed.runs[0]?.matchedField).toBe("error");
    expect(failed.runs[0]?.status).toBe("failed");
    expect(failed.runs[0]?.issueId).toBe(issueId);
  });

  it("filters by agent and status", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other", role: "engineer" });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", error: "recall needle" });
    await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, status: "failed", error: "recall needle" });

    const scoped = await searchRunRecall(db, { companyId, query: "recall needle", agentId });
    expect(scoped.runs).toHaveLength(1);
    expect(scoped.runs[0]?.agentId).toBe(agentId);

    const byStatus = await searchRunRecall(db, { companyId, query: "recall needle", status: "succeeded" });
    expect(byStatus.runs).toHaveLength(0);
  });

  it("finds activity entries and isolates companies", async () => {
    const { companyId, agentId } = await seed();
    const other = await seed();
    await db.insert(activityLog).values({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "heartbeat.run_failed",
      entityType: "heartbeat_run",
      entityId: "run-1",
      agentId,
    });
    await db.insert(activityLog).values({
      companyId: other.companyId,
      actorType: "agent",
      actorId: other.agentId,
      action: "heartbeat.run_failed",
      entityType: "heartbeat_run",
      entityId: "run-9",
      agentId: other.agentId,
    });

    const result = await searchRunRecall(db, { companyId, query: "heartbeat run_failed" });
    expect(result.activity).toHaveLength(1);
    expect(result.activity[0]?.entityId).toBe("run-1");
    expect(result.runs).toHaveLength(0);
  });

  it("treats SQL wildcard characters as literals", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", error: "50_percent complete" });
    const literal = await searchRunRecall(db, { companyId, query: "50_percent" });
    expect(literal.runs).toHaveLength(1);
    const wildcard = await searchRunRecall(db, { companyId, query: "50%percent" });
    expect(wildcard.runs).toHaveLength(0);
  });

  it("returns empty results for blank queries", async () => {
    const { companyId } = await seed();
    await expect(searchRunRecall(db, { companyId, query: "  " })).resolves.toEqual({
      query: "",
      runs: [],
      activity: [],
    });
  });
});
