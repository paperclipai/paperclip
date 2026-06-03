import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, workflowDeliverables, workflowRuns, workflows } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workProductService } from "../services/work-products.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres workflow deliverable tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("workflow deliverables pagination", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-workflow-deliverables-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(workflowDeliverables);
    await db.delete(workflowRuns);
    await db.delete(workflows);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("applies workflow audience filters before pagination", async () => {
    const companyId = randomUUID();
    const workflowId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-06-02T12:00:00.000Z");
    const earlier = new Date("2026-06-02T11:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(workflows).values({
      id: workflowId,
      companyId,
      title: "Brief generator",
      status: "active",
      runnerType: "google_adk",
      runnerConfig: {},
      pipelineDefinition: {
        entrypoint: "agent.py",
        generatedAt: now.toISOString(),
        phases: [],
      },
      pipelineSourceHash: "hash-1",
    });

    await db.insert(workflowRuns).values({
      id: runId,
      companyId,
      workflowId,
      status: "succeeded",
      inputMarkdown: "generate",
      createdAt: earlier,
      updatedAt: now,
    });

    await db.insert(workflowDeliverables).values([
      {
        id: randomUUID(),
        companyId,
        workflowId,
        workflowRunId: runId,
        title: "Agent-only result",
        summary: null,
        audience: "agent",
        contentType: "text/markdown; charset=utf-8",
        contentBody: "# agent",
        byteSize: 7,
        originalFilename: "agent.md",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: randomUUID(),
        companyId,
        workflowId,
        workflowRunId: runId,
        title: "Human result",
        summary: null,
        audience: "human",
        contentType: "text/markdown; charset=utf-8",
        contentBody: "# human",
        byteSize: 7,
        originalFilename: "human.md",
        createdAt: earlier,
        updatedAt: earlier,
      },
    ]);

    const svc = workProductService(db);
    const items = await svc.listDeliverablesForCompany(companyId, {
      audience: "human",
      limit: 1,
      offset: 0,
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      sourceKind: "workflow",
      title: "Human result",
      audience: "human",
    });
  });
});
