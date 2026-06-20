import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat run list payloads", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
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

  it("returns summarized run JSON and a slimmed context snapshot for list views", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const hugeBlob = "x".repeat(1024 * 1024);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Run List Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "succeeded",
      resultJson: {
        summary: `summary:${"a".repeat(700)}`,
        message: "message",
        hugeBlob,
      },
      contextSnapshot: {
        issueId: "issue-123",
        taskKey: "task-123",
        wakeReason: "retry_failed_run",
        forceFreshSession: true,
        hugeBlob,
      },
    });

    const heartbeat = heartbeatService(db);
    const runs = await heartbeat.list(companyId);
    expect(runs).toHaveLength(1);

    const [run] = runs;
    const resultJson = run.resultJson as Record<string, unknown> | null;
    const contextSnapshot = run.contextSnapshot as Record<string, unknown> | null;

    expect(resultJson).toBeTruthy();
    expect(String(resultJson?.summary ?? "")).toHaveLength(500);
    expect(resultJson).not.toHaveProperty("hugeBlob");
    expect(resultJson).toMatchObject({
      message: "message",
    });

    expect(contextSnapshot).toEqual({
      issueId: "issue-123",
      taskKey: "task-123",
      wakeReason: "retry_failed_run",
      forceFreshSession: true,
    });

    const displayRun = await heartbeat.getRunForDisplay(runId);
    expect(displayRun?.resultJson).toEqual(resultJson);
    expect(displayRun?.contextSnapshot).toEqual(contextSnapshot);

    const accessRun = await heartbeat.getRunAccess(runId);
    expect(accessRun).toMatchObject({
      id: runId,
      companyId,
      agentId,
      logStore: null,
      logRef: null,
      executionWorkspaceId: null,
    });
    expect(accessRun).not.toHaveProperty("resultJson");
    expect(accessRun).not.toHaveProperty("contextSnapshot");
  });
});
