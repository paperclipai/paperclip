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
import { AUTHORITY_WIDENING_PERMISSION_KEYS, PERMISSION_KEYS } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  AGENT_PROFILE_AUTHORITY_CONSENT_FIELDS,
  CONSENT_VALUE_DIGEST_VERSION,
  agentInstructionsChangeTargetKey,
  agentProfileChangeTargetKey,
  changeConsentGateService,
  consentValueDigest,
  consentValuesTouchAuthorityField,
  isAgentProfileChangeTargetKey,
  touchesAgentProfileAuthorityConsentFields,
} from "../services/change-consent-gate.js";
import { resolveInteractionPolicy } from "../services/issue-thread-interactions.js";


describe("role authority field classification", () => {
  it("classifies role as an authority field and the cosmetic fields as not", () => {
    expect([...AGENT_PROFILE_AUTHORITY_CONSENT_FIELDS]).toEqual(["role"]);
    expect(touchesAgentProfileAuthorityConsentFields({ role: "ceo" })).toBe(true);
    expect(touchesAgentProfileAuthorityConsentFields({ title: "Chief Executive Officer" })).toBe(false);
    expect(touchesAgentProfileAuthorityConsentFields({ name: "Jarvis", capabilities: [] })).toBe(false);
  });

  it("treats an explicit null role as a change to the authority field", () => {
    expect(touchesAgentProfileAuthorityConsentFields({ role: null })).toBe(true);
  });

  it("only matches the agent-profile target key", () => {
    const agentId = randomUUID();
    expect(isAgentProfileChangeTargetKey(agentProfileChangeTargetKey(agentId))).toBe(true);
    expect(isAgentProfileChangeTargetKey(`agent:${agentId}:instructions`)).toBe(false);
    expect(isAgentProfileChangeTargetKey(`reflection-coach:agent-description:${agentId}`)).toBe(false);
  });

  it("reads the authority flag from the bound proposedValues", () => {
    const targetKey = agentProfileChangeTargetKey(randomUUID());
    expect(consentValuesTouchAuthorityField(targetKey, { role: "ceo" })).toBe(true);
    expect(consentValuesTouchAuthorityField(targetKey, { title: "CEO" })).toBe(false);
    expect(consentValuesTouchAuthorityField(targetKey, null)).toBe(false);
    expect(consentValuesTouchAuthorityField(`agent:${randomUUID()}:instructions`, { role: "ceo" })).toBe(false);
  });

  it("records the grant that can reach an authority field as authority widening", () => {
    expect([...AUTHORITY_WIDENING_PERMISSION_KEYS]).toEqual(["agents:configure"]);
    for (const key of AUTHORITY_WIDENING_PERMISSION_KEYS) {
      expect(PERMISSION_KEYS).toContain(key);
    }
  });
});

describe("raise-time resolver policy", () => {
  const governance = {};

  function policyFor(proposedValues: Record<string, unknown>, targetKey: string) {
    return resolveInteractionPolicy({
      kind: "request_confirmation",
      requested: "anyone",
      governance,
      hasToolAction: false,
      hasSecretProposal: false,
      hasAuthorityFieldProposal: consentValuesTouchAuthorityField(targetKey, proposedValues),
    });
  }

  it("forces human_only for a card that proposes a role change, overriding anyone", () => {
    const policy = policyFor({ role: "ceo" }, agentProfileChangeTargetKey(randomUUID()));

    expect(policy.effectiveResolverPolicy).toBe("human_only");
    expect(policy.effectiveResolverPolicySource).toBe("governed_action");
    expect(policy.requestedResolverPolicy).toBe("anyone");
  });

  it("leaves a title-only card on the ordinary consent path", () => {
    const policy = policyFor({ title: "Chief Executive Officer" }, agentProfileChangeTargetKey(randomUUID()));

    expect(policy.effectiveResolverPolicy).toBe("anyone");
    expect(policy.effectiveResolverPolicySource).toBe("requested");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("redeem-time human-resolver requirement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-role-authority-");
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

  const PROPOSED_ROLE_CHANGE = { role: "ceo" };
  const PROPOSED_TITLE_CHANGE = { title: "Senior Build Engineer" };

  async function seedFixture() {
    const companyId = randomUUID();
    const actorAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const sourceRunId = randomUUID();
    const issueId = randomUUID();
    const targetKey = agentProfileChangeTargetKey(actorAgentId);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values([
      {
        id: actorAgentId,
        companyId,
        name: "Ambitious Seat",
        role: "general",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: peerAgentId,
        companyId,
        name: "Obliging Peer",
        role: "general",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: actorAgentId,
      status: "succeeded",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Promote the seat",
      status: "in_review",
      priority: "medium",
      identifier: "PAP-1",
      issueNumber: 1,
      createdByAgentId: actorAgentId,
    });

    return { companyId, actorAgentId, peerAgentId, sourceRunId, issueId, targetKey };
  }

  async function insertAcceptedCard(ctx: {
    companyId: string;
    issueId: string;
    actorAgentId: string;
    sourceRunId: string;
    targetKey: string;
    resolvedByUserId: string | null;
    resolvedByAgentId: string | null;
    effectiveResolverPolicy: "anyone" | "human_only";
    proposedValues?: Record<string, unknown>;
  }) {
    const proposedValues = ctx.proposedValues ?? PROPOSED_ROLE_CHANGE;
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: ctx.companyId,
      issueId: ctx.issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      effectiveResolverPolicy: ctx.effectiveResolverPolicy,
      sourceRunId: ctx.sourceRunId,
      createdByAgentId: ctx.actorAgentId,
      payload: {
        version: 1,
        prompt: "Apply this profile change?",
        detailsMarkdown: "```diff\n-role: general\n+role: ceo\n```",
        target: {
          type: "custom",
          key: ctx.targetKey,
          revisionId: "proposal-v1",
          proposedValues,
          valueDigest: consentValueDigest(ctx.targetKey, proposedValues),
          digestVersion: CONSENT_VALUE_DIGEST_VERSION,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: ctx.resolvedByUserId,
      resolvedByAgentId: ctx.resolvedByAgentId,
      resolvedAt: new Date(),
    });
    return interactionId;
  }

  it("refuses a role change whose approval was resolved by an agent", async () => {
    const ctx = await seedFixture();
    await insertAcceptedCard({
      ...ctx,
      resolvedByUserId: null,
      resolvedByAgentId: ctx.peerAgentId,
      effectiveResolverPolicy: "anyone",
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_ROLE_CHANGE),
      requiresHumanResolver: true,
    })).rejects.toMatchObject({
      status: 403,
      details: {
        code: "consent_authority_field_requires_human_resolver",
        authorityFields: ["role"],
      },
    });
  });

  it("leaves the refused card accepted and unconsumed so a human can still rule on it", async () => {
    const ctx = await seedFixture();
    const interactionId = await insertAcceptedCard({
      ...ctx,
      resolvedByUserId: null,
      resolvedByAgentId: ctx.peerAgentId,
      effectiveResolverPolicy: "anyone",
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_ROLE_CHANGE),
      requiresHumanResolver: true,
    })).rejects.toMatchObject({ status: 403 });

    const [stored] = await db
      .select({ status: issueThreadInteractions.status, result: issueThreadInteractions.result })
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId));

    expect(stored?.status).toBe("accepted");
    expect(stored?.result).not.toMatchObject({ consumedByRunId: expect.any(String) });
  });

  it("allows a role change whose approval a person resolved", async () => {
    const ctx = await seedFixture();
    await insertAcceptedCard({
      ...ctx,
      resolvedByUserId: "board-user",
      resolvedByAgentId: null,
      effectiveResolverPolicy: "human_only",
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_ROLE_CHANGE),
      requiresHumanResolver: true,
    })).resolves.toBe(true);
  });

  it("accepts a human-resolved card raised under an older `anyone` policy", async () => {
    const ctx = await seedFixture();
    await insertAcceptedCard({
      ...ctx,
      resolvedByUserId: "board-user",
      resolvedByAgentId: null,
      effectiveResolverPolicy: "anyone",
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_ROLE_CHANGE),
      requiresHumanResolver: true,
    })).resolves.toBe(true);
  });

  it("does not disturb a title-only change resolved by an agent", async () => {
    const ctx = await seedFixture();
    await insertAcceptedCard({
      ...ctx,
      resolvedByUserId: null,
      resolvedByAgentId: ctx.peerAgentId,
      effectiveResolverPolicy: "anyone",
      proposedValues: PROPOSED_TITLE_CHANGE,
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_TITLE_CHANGE),
      requiresHumanResolver: false,
    })).resolves.toBe(true);
  });

  it("refuses a title-only card when the write being made is a role change", async () => {
    const ctx = await seedFixture();
    await insertAcceptedCard({
      ...ctx,
      resolvedByUserId: "board-user",
      resolvedByAgentId: null,
      effectiveResolverPolicy: "human_only",
      proposedValues: PROPOSED_TITLE_CHANGE,
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [ctx.targetKey],
      expectedValueDigest: consentValueDigest(ctx.targetKey, PROPOSED_ROLE_CHANGE),
      requiresHumanResolver: true,
    })).rejects.toMatchObject({ status: 403 });
  });

  it("redeems an instruction card that carries no value digest", async () => {
    const ctx = await seedFixture();
    const instructionsTargetKey = agentInstructionsChangeTargetKey(ctx.actorAgentId);
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId: ctx.companyId,
      issueId: ctx.issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      effectiveResolverPolicy: "anyone",
      sourceRunId: ctx.sourceRunId,
      createdByAgentId: ctx.actorAgentId,
      payload: {
        version: 1,
        prompt: "Apply this instruction change?",
        detailsMarkdown: "```diff\n-old line\n+new line\n```",
        target: { type: "custom", key: instructionsTargetKey, revisionId: "proposal-v1" },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "board-user",
      resolvedByAgentId: null,
      resolvedAt: new Date(),
    });

    await expect(changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.actorAgentId,
      actorRunId: randomUUID(),
      targetKeys: [instructionsTargetKey],
      expectedValueDigest: null,
      requiresHumanResolver: false,
    })).resolves.toBe(true);
  });
});
