import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  changeConsentGateService,
  skillChangeTargetKey,
} from "../services/change-consent-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("changeConsentGateService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reflection-coach-gate-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedGateFixture() {
    const companyId = randomUUID();
    const coachId = randomUUID();
    const sourceRunId = randomUUID();
    const proposalIssueId = randomUUID();
    const skillId = randomUUID();
    const targetKey = skillChangeTargetKey(skillId);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: coachId,
      companyId,
      name: "Reflection Coach",
      role: "general",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: { canCreateSkills: true },
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: coachId,
      status: "succeeded",
    });
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review Reflection Coach proposal",
      status: "in_review",
      priority: "medium",
      identifier: "PAP-1",
      issueNumber: 1,
      createdByAgentId: coachId,
    });

    return { companyId, coachId, sourceRunId, proposalIssueId, skillId, targetKey };
  }

  it("rejects Reflection Coach skill mutation without an accepted bound interaction", async () => {
    const { companyId, coachId, targetKey } = await seedGateFixture();

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  it("rejects accepted interactions from the same run as the apply mutation", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: sourceRunId,
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  it("allows a previous-run accepted interaction with a displayed diff for the bound target", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });
    const actorRunId = randomUUID();

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId,
      targetKeys: [targetKey],
    })).resolves.toBe(true);

    const [stored] = await db
      .select({ result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));

    expect(stored?.result).toMatchObject({
      consumedByRunId: actorRunId,
      outcome: "accepted",
      version: 1,
    });
    expect((stored?.result as { consumedAt?: unknown } | undefined)?.consumedAt).toEqual(expect.any(String));
  });

  it("rejects reusing an accepted interaction after it is consumed by a mutation", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, targetKey } = await seedGateFixture();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: targetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).resolves.toBe(true);

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  it("allows legacy Reflection Coach target keys for durable accepted interactions", async () => {
    const { companyId, coachId, sourceRunId, proposalIssueId, skillId, targetKey } = await seedGateFixture();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId: proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId,
      createdByAgentId: coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: `reflection-coach:company-skill:${skillId}`, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
    })).resolves.toBe(true);
  });
});
