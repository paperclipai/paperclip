import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  costEventSeatAttributions,
  costEvents,
  createDb,
  issues,
  projects,
  seats,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { costService } from "../services/costs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres cost attribution tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("costService seat attribution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cost-seat-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEventSeatAttributions);
    await db.delete(costEvents);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(seats);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("attributes cost events to issue owner seat when an issue owner exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const seatId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent One",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(seats).values({
      id: seatId,
      companyId,
      slug: "seat-one",
      name: "Seat One",
      seatType: "individual",
      status: "active",
      operatingMode: "vacant",
      defaultAgentId: null,
    });

    await db.update(agents).set({ seatId, seatRole: "primary_agent" }).where(eq(agents.id, agentId));
    await db.update(seats).set({ defaultAgentId: agentId }).where(eq(seats.id, seatId));

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Seat-owned issue",
      status: "todo",
      priority: "medium",
      ownerSeatId: seatId,
      assigneeAgentId: agentId,
    });

    const svc = costService(db);
    const event = await svc.createEvent(companyId, {
      agentId,
      issueId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      costCents: 12,
      occurredAt: new Date(),
    });

    const attribution = await db.select().from(costEventSeatAttributions).then((rows) => rows[0] ?? null);
    expect(attribution?.costEventId).toBe(event.id);
    expect(attribution?.seatId).toBe(seatId);
    expect(attribution?.attributionSource).toBe("issue_owner_seat");
  });

  it("falls back to the agent seat when no issue owner seat exists", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const seatId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent One",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(seats).values({
      id: seatId,
      companyId,
      slug: "seat-one",
      name: "Seat One",
      seatType: "individual",
      status: "active",
      operatingMode: "vacant",
      defaultAgentId: null,
    });

    await db.update(agents).set({ seatId, seatRole: "primary_agent" }).where(eq(agents.id, agentId));
    await db.update(seats).set({ defaultAgentId: agentId }).where(eq(seats.id, seatId));

    const svc = costService(db);
    const event = await svc.createEvent(companyId, {
      agentId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      costCents: 12,
      occurredAt: new Date(),
    });

    const attribution = await db.select().from(costEventSeatAttributions).then((rows) => rows[0] ?? null);
    expect(attribution?.costEventId).toBe(event.id);
    expect(attribution?.seatId).toBe(seatId);
    expect(attribution?.attributionSource).toBe("agent_seat");
  });

  it("exposes attribution provenance in provider and biller aggregates", async () => {
    const companyId = randomUUID();
    const issueSeatId = randomUUID();
    const agentSeatId = randomUUID();
    const issueAgentId = randomUUID();
    const fallbackAgentId = randomUUID();
    const unattributedAgentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Seat Provenance Project",
      status: "in_progress",
    });

    await db.insert(agents).values([
      {
        id: issueAgentId,
        companyId,
        name: "Issue Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: fallbackAgentId,
        companyId,
        name: "Fallback Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: unattributedAgentId,
        companyId,
        name: "Unattributed Agent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(seats).values([
      {
        id: issueSeatId,
        companyId,
        slug: "issue-seat",
        name: "Issue Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: issueAgentId,
      },
      {
        id: agentSeatId,
        companyId,
        slug: "agent-seat",
        name: "Agent Seat",
        seatType: "individual",
        status: "active",
        operatingMode: "vacant",
        defaultAgentId: fallbackAgentId,
      },
    ]);

    await db.update(agents).set({ seatId: issueSeatId, seatRole: "primary_agent" }).where(eq(agents.id, issueAgentId));
    await db.update(agents).set({ seatId: agentSeatId, seatRole: "primary_agent" }).where(eq(agents.id, fallbackAgentId));

    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Seat-owned issue",
      status: "todo",
      priority: "medium",
      ownerSeatId: issueSeatId,
      assigneeAgentId: issueAgentId,
    });

    const svc = costService(db);
    await svc.createEvent(companyId, {
      agentId: issueAgentId,
      issueId,
      projectId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude",
      inputTokens: 10,
      cachedInputTokens: 0,
      outputTokens: 5,
      costCents: 12,
      occurredAt: new Date(),
    });
    await svc.createEvent(companyId, {
      agentId: fallbackAgentId,
      projectId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude",
      inputTokens: 8,
      cachedInputTokens: 0,
      outputTokens: 4,
      costCents: 7,
      occurredAt: new Date(),
    });
    await svc.createEvent(companyId, {
      agentId: unattributedAgentId,
      projectId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "metered_api",
      model: "claude",
      inputTokens: 6,
      cachedInputTokens: 0,
      outputTokens: 3,
      costCents: 5,
      occurredAt: new Date(),
    });

    const providerRows = await svc.byProvider(companyId);
    const billerRows = await svc.byBiller(companyId);
    const byAgentRows = await svc.byAgent(companyId);
    const byAgentModelRows = await svc.byAgentModel(companyId);
    const byProjectRows = await svc.byProject(companyId);

    expect(providerRows).toHaveLength(1);
    expect(providerRows[0]?.issueOwnerSeatCostCents).toBe(12);
    expect(providerRows[0]?.agentSeatCostCents).toBe(7);
    expect(providerRows[0]?.unattributedCostCents).toBe(5);

    expect(billerRows).toHaveLength(1);
    expect(billerRows[0]?.issueOwnerSeatCostCents).toBe(12);
    expect(billerRows[0]?.agentSeatCostCents).toBe(7);
    expect(billerRows[0]?.unattributedCostCents).toBe(5);

    const issueAgentRow = byAgentRows.find((row) => row.agentId === issueAgentId);
    const fallbackAgentRow = byAgentRows.find((row) => row.agentId === fallbackAgentId);
    const unattributedAgentRow = byAgentRows.find((row) => row.agentId === unattributedAgentId);
    expect(issueAgentRow?.issueOwnerSeatCostCents).toBe(12);
    expect(issueAgentRow?.agentSeatCostCents).toBe(0);
    expect(issueAgentRow?.unattributedCostCents).toBe(0);
    expect(fallbackAgentRow?.issueOwnerSeatCostCents).toBe(0);
    expect(fallbackAgentRow?.agentSeatCostCents).toBe(7);
    expect(fallbackAgentRow?.unattributedCostCents).toBe(0);
    expect(unattributedAgentRow?.issueOwnerSeatCostCents).toBe(0);
    expect(unattributedAgentRow?.agentSeatCostCents).toBe(0);
    expect(unattributedAgentRow?.unattributedCostCents).toBe(5);

    const issueAgentModel = byAgentModelRows.find((row) => row.agentId === issueAgentId);
    const fallbackAgentModel = byAgentModelRows.find((row) => row.agentId === fallbackAgentId);
    const unattributedAgentModel = byAgentModelRows.find((row) => row.agentId === unattributedAgentId);
    expect(issueAgentModel?.issueOwnerSeatCostCents).toBe(12);
    expect(issueAgentModel?.agentSeatCostCents).toBe(0);
    expect(issueAgentModel?.unattributedCostCents).toBe(0);
    expect(fallbackAgentModel?.issueOwnerSeatCostCents).toBe(0);
    expect(fallbackAgentModel?.agentSeatCostCents).toBe(7);
    expect(fallbackAgentModel?.unattributedCostCents).toBe(0);
    expect(unattributedAgentModel?.issueOwnerSeatCostCents).toBe(0);
    expect(unattributedAgentModel?.agentSeatCostCents).toBe(0);
    expect(unattributedAgentModel?.unattributedCostCents).toBe(5);

    expect(byProjectRows).toHaveLength(1);
    expect(byProjectRows[0]?.projectId).toBe(projectId);
    expect(byProjectRows[0]?.issueOwnerSeatCostCents).toBe(12);
    expect(byProjectRows[0]?.agentSeatCostCents).toBe(7);
    expect(byProjectRows[0]?.unattributedCostCents).toBe(5);
  });
});
