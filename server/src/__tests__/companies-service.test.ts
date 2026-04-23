import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  financeEvents,
  heartbeatRuns,
  issueLabels,
  labels,
  issues,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres company service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("company service remove", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-companies-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issueLabels);
    await db.delete(labels);
    await db.delete(financeEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes finance, label, and routine rows before parent company records", async () => {
    const companyId = randomUUID();
    const labelId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const costEventId = randomUUID();
    const routineId = randomUUID();
    const triggerId = randomUUID();
    const routineRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Delete Test Co",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Cleanup Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(labels).values({
      id: labelId,
      companyId,
      name: "cleanup",
      color: "#123456",
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `D${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}-1`,
      title: "Delete dependency issue",
      status: "open",
      source: "manual",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      issueId: issueId,
      invocationSource: "assignment",
      status: "completed",
    });

    await db.insert(costEvents).values({
      id: costEventId,
      companyId,
      agentId,
      heartbeatRunId: runId,
      provider: "anthropic",
      model: "claude-sonnet",
      costCents: 42,
      occurredAt: new Date("2026-04-17T12:00:00.000Z"),
    });

    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: runId,
      costEventId,
      eventKind: "usage_charge",
      biller: "anthropic",
      amountCents: 42,
      occurredAt: new Date("2026-04-17T12:00:00.000Z"),
    });

    await db.insert(issueLabels).values({
      issueId,
      labelId,
      companyId,
    });

    await db.insert(routines).values({
      id: routineId,
      companyId,
      title: "Cleanup routine",
      description: "Routine dependent on a company issue",
      parentIssueId: issueId,
    });

    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "manual",
      enabled: true,
    });

    await db.insert(routineRuns).values({
      id: routineRunId,
      companyId,
      routineId,
      triggerId,
      source: "manual",
      status: "received",
      linkedIssueId: issueId,
    });

    const removed = await companyService(db).remove(companyId);

    expect(removed?.id).toBe(companyId);
    await expect(db.select().from(companies)).resolves.toHaveLength(0);
    await expect(db.select().from(agents)).resolves.toHaveLength(0);
    await expect(db.select().from(heartbeatRuns)).resolves.toHaveLength(0);
    await expect(db.select().from(costEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(financeEvents)).resolves.toHaveLength(0);
    await expect(db.select().from(routines)).resolves.toHaveLength(0);
    await expect(db.select().from(routineTriggers)).resolves.toHaveLength(0);
    await expect(db.select().from(routineRuns)).resolves.toHaveLength(0);
  });
});
