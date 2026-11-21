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
  CONSENT_VALUE_DIGEST_VERSION,
  changeConsentGateService,
  consentValueDigest,
  skillChangeTargetKey,
} from "../services/change-consent-gate.js";

const PROPOSED_VALUES = { instructions: "Tighten the workflow." };

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
      expectedValueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
      requiresHumanResolver: false,
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
        target: {
          type: "custom",
          key: targetKey,
          revisionId: "proposal-v1",
          proposedValues: PROPOSED_VALUES,
          valueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
          digestVersion: CONSENT_VALUE_DIGEST_VERSION,
        },
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
      expectedValueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
      requiresHumanResolver: false,
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
        target: {
          type: "custom",
          key: targetKey,
          revisionId: "proposal-v1",
          proposedValues: PROPOSED_VALUES,
          valueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
          digestVersion: CONSENT_VALUE_DIGEST_VERSION,
        },
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
      expectedValueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
      requiresHumanResolver: false,
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
        target: {
          type: "custom",
          key: targetKey,
          revisionId: "proposal-v1",
          proposedValues: PROPOSED_VALUES,
          valueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
          digestVersion: CONSENT_VALUE_DIGEST_VERSION,
        },
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
      expectedValueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
      requiresHumanResolver: false,
    })).resolves.toBe(true);

    await expect(changeConsentGateService(db).assertConsented({
      companyId,
      actorAgentId: coachId,
      actorRunId: randomUUID(),
      targetKeys: [targetKey],
      expectedValueDigest: consentValueDigest(targetKey, PROPOSED_VALUES),
      requiresHumanResolver: false,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "reflection_coach_mutation_gate_required" },
    });
  });

  async function seedLegacySkillCard(ctx: {
    companyId: string;
    coachId: string;
    sourceRunId: string;
    proposalIssueId: string;
    skillId: string;
  }) {
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: ctx.companyId,
      issueId: ctx.proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId: ctx.sourceRunId,
      createdByAgentId: ctx.coachId,
      payload: {
        version: 1,
        prompt: "Apply this Reflection Coach skill diff?",
        detailsMarkdown: "```diff\n+Tighten the workflow.\n```",
        target: { type: "custom", key: `reflection-coach:company-skill:${ctx.skillId}`, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
    });
  }

  it("still resolves legacy Reflection Coach target keys, and fails them closed without a digest", async () => {
    const ctx = await seedGateFixture();
    await seedLegacySkillCard(ctx);

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.coachId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_VALUES),
      requiresHumanResolver: false,
    })).rejects.toMatchObject({
      status: 403,
      details: { code: "consent_value_digest_absent" },
    });
  });

  it("redeems a legacy digest-less card under the warn kill switch", async () => {
    const ctx = await seedGateFixture();
    await seedLegacySkillCard(ctx);

    const previous = process.env.PAPERCLIP_CONSENT_VALUE_DIGEST;
    process.env.PAPERCLIP_CONSENT_VALUE_DIGEST = "warn";
    try {
      await expect(changeConsentGateService(db).assertConsented({
        companyId: ctx.companyId,
        actorAgentId: ctx.coachId,
        actorRunId: randomUUID(),
        targetKeys: [ctx.targetKey],
        expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_VALUES),
        requiresHumanResolver: false,
      })).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_CONSENT_VALUE_DIGEST;
      else process.env.PAPERCLIP_CONSENT_VALUE_DIGEST = previous;
    }
  });
});
