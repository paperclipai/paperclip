import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  goals,
  instanceSettings,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import type { PluginEvent } from "@paperclipai/plugin-sdk";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import {
  logActivity,
  publishPluginDomainEvent,
  setPluginEventBus,
} from "../services/activity-log.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * TWX-1107: the Telegram plugin routes a decision notification by reading the
 * resolved decision owner off the `issue.interaction.created` plugin event. This
 * test pins the contract end-to-end: an agent-created child issue resolves the
 * decision owner to the root human initiator, and that initiator is carried into
 * the emitted plugin event payload the notification plugin consumes.
 */
describeEmbeddedPostgres("initiator-aware decision routing events", () => {
  let db!: ReturnType<typeof createDb>;
  let interactionsSvc!: ReturnType<typeof issueThreadInteractionService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const captured: PluginEvent[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decision-routing-events-");
    db = createDb(tempDb.connectionString);
    interactionsSvc = issueThreadInteractionService(db);
    setPluginEventBus({
      emit: async (event: PluginEvent) => {
        captured.push(event);
        return { errors: [] };
      },
    } as never);
  }, 20_000);

  afterEach(async () => {
    captured.length = 0;
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(goals);
    await db.delete(companyMemberships);
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    // Drain any in-flight async event dispatch before tearing down the bus.
    await new Promise((resolve) => setTimeout(resolve, 10));
    setPluginEventBus(null as never);
    await tempDb?.cleanup();
  });

  it("routes the interaction.created event to the root human initiator", async () => {
    const companyId = randomUUID();
    const goalId = randomUUID();
    const rootIssueId = randomUUID();
    const childIssueId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Initiator-aware Telegram routing",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Backend",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The root human initiator holds an active, write-capable membership, so the
    // gated ancestor resolver (TWX-1112) targets them.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "jonas-user",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      goalId,
      title: "Jonas requested the root work",
      status: "in_progress",
      priority: "medium",
      createdByUserId: "jonas-user",
    });
    await db.insert(issues).values({
      id: childIssueId,
      companyId,
      goalId,
      parentId: rootIssueId,
      title: "Agent-created child work",
      status: "in_progress",
      priority: "medium",
      createdByAgentId: agentId,
    });

    // The agent raises a decision on its own child issue.
    const interaction = await interactionsSvc.create({
      id: childIssueId,
      companyId,
    }, {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Approve the implementation?",
      },
    }, {
      agentId,
    });

    // Decision owner resolves to the originating human, not the agent.
    expect(interaction.targetUserId).toBe("jonas-user");

    // Mirror the route handler that fans the interaction out to plugins.
    await logActivity(db, {
      companyId,
      actorType: "agent",
      actorId: agentId,
      agentId,
      action: "issue.thread_interaction_created",
      entityType: "issue",
      entityId: childIssueId,
      details: {
        interactionId: interaction.id,
        interactionKind: interaction.kind,
        interactionStatus: interaction.status,
        continuationPolicy: interaction.continuationPolicy,
        targetUserId: interaction.targetUserId ?? null,
      },
    });

    const event = captured.find((e) => e.eventType === "issue.interaction.created");
    expect(event).toBeDefined();
    expect(event?.companyId).toBe(companyId);
    expect(event?.entityId).toBe(childIssueId);
    // The notification (Telegram) plugin reads this to route to the initiator.
    expect((event?.payload as Record<string, unknown>).targetUserId).toBe("jonas-user");
  });

  it("publishPluginDomainEvent is inert without a configured bus", async () => {
    setPluginEventBus(null as never);
    expect(() => publishPluginDomainEvent({
      eventId: randomUUID(),
      eventType: "issue.interaction.created",
      occurredAt: new Date().toISOString(),
      actorId: "agent-1",
      actorType: "agent",
      entityId: "issue-1",
      entityType: "issue",
      companyId: "company-1",
      payload: { targetUserId: "jonas-user" },
    })).not.toThrow();
    // Restore the capturing bus for any later assertions.
    setPluginEventBus({
      emit: async (event: PluginEvent) => {
        captured.push(event);
        return { errors: [] };
      },
    } as never);
  });
});
