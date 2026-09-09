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
  finishRunRecallMatch,
  resolveRunRecallLimit,
  searchRunRecall,
  tokenizeRunRecallQuery,
  type RunRecallRunRow,
} from "../services/run-recall.js";
import type { RunRecallRunMatch } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run recall tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("run recall query", () => {  it("tokenizes, dedupes, and floors tiny tokens", () => {
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

function finishAll(
  result: { rows: RunRecallRunRow[] },
  query: string,
): RunRecallRunMatch[] {
  const tokens = tokenizeRunRecallQuery(query);
  const matches: RunRecallRunMatch[] = [];
  for (const row of result.rows) {
    const match = finishRunRecallMatch(row, tokens);
    if (match) matches.push(match);
  }
  return matches;
}

describeEmbeddedPostgres("searchRunRecall", () => {  let db!: ReturnType<typeof createDb>;
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
    const matches = finishAll(result, "release artifact");
    expect(matches).toHaveLength(2);
    expect(matches[0]?.snippet.toLowerCase()).toContain("release artifact");

    const failed = await searchRunRecall(db, { companyId, query: "connection reset" });
    const failedMatches = finishAll(failed, "connection reset");
    expect(failedMatches).toHaveLength(1);
    expect(failedMatches[0]?.matchedField).toBe("error");
    expect(failedMatches[0]?.status).toBe("failed");
    expect(failedMatches[0]?.issueId).toBe(issueId);
  });

  it("keeps issue-only matches with an issue field", async () => {
    const { companyId, agentId, issueId } = await seed();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "succeeded",
      contextSnapshot: { issueId },
    });

    const result = await searchRunRecall(db, { companyId, query: "outage" });
    const matches = finishAll(result, "outage");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedField).toBe("issue");
    expect(matches[0]?.issueIdentifier).not.toBeNull();
  });

  it("matches each result field independently", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      status: "failed",
      resultJson: { summary: "all quiet", message: "connection reset downstream" },
    });

    const result = await searchRunRecall(db, { companyId, query: "connection reset" });
    const matches = finishAll(result, "connection reset");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.matchedField).toBe("resultMessage");
  });

  it("drops rows left without a hit after redaction", () => {
    const row = {
      id: "run-1",
      status: "failed",
      agentId: "agent-1",
      agentName: null,
      issueId: null,
      issueIdentifier: null,
      issueTitle: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      error: "[REDACTED]",
      errorCode: null,
      resultSummary: null,
      resultResult: null,
      resultMessage: null,
      resultError: null,
    } satisfies RunRecallRunRow;
    expect(finishRunRecallMatch(row, ["needle"])).toBeNull();
    expect(
      finishRunRecallMatch({ ...row, error: "needle in plain text" }, ["needle"])?.matchedField,
    ).toBe("error");
  });

  it("filters by agent and status", async () => {
    const { companyId, agentId } = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId, name: "Other", role: "engineer" });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", error: "recall needle" });
    await db.insert(heartbeatRuns).values({ companyId, agentId: otherAgentId, status: "failed", error: "recall needle" });

    const scoped = await searchRunRecall(db, { companyId, query: "recall needle", agentId });
    const scopedMatches = finishAll(scoped, "recall needle");
    expect(scopedMatches).toHaveLength(1);
    expect(scopedMatches[0]?.agentId).toBe(agentId);

    const byStatus = await searchRunRecall(db, { companyId, query: "recall needle", status: "succeeded" });
    expect(finishAll(byStatus, "recall needle")).toHaveLength(0);
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
    expect(result.rows).toHaveLength(0);
  });

  it("finds activity by actor type", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "nightly.sweep",
      entityType: "company",
      entityId: companyId,
      agentId,
    });

    const result = await searchRunRecall(db, { companyId, query: "nightly system" });
    expect(result.activity).toHaveLength(1);
    expect(result.activity[0]?.action).toBe("nightly.sweep");
  });

  it("treats SQL wildcard characters as literals", async () => {
    const { companyId, agentId } = await seed();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed", error: "50_percent complete" });
    const literal = await searchRunRecall(db, { companyId, query: "50_percent" });
    expect(finishAll(literal, "50_percent")).toHaveLength(1);
    const wildcard = await searchRunRecall(db, { companyId, query: "50%percent" });
    expect(finishAll(wildcard, "50%percent")).toHaveLength(0);
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
