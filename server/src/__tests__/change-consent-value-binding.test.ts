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
  agentProfileChangeTargetKey,
  canonicalizeConsentValues,
  changeConsentGateService,
  consentValueDigest,
} from "../services/change-consent-gate.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type ProfilePatch = {
  name?: string;
  role?: string;
  title?: string;
  capabilities?: string;
};

function renderProposedDiff(before: ProfilePatch, after: ProfilePatch) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const lines = keys.flatMap((key) => {
    const from = before[key as keyof ProfilePatch];
    const to = after[key as keyof ProfilePatch];
    if (from === to) return [];
    return [`-${key}: ${from ?? "(unset)"}`, `+${key}: ${to ?? "(unset)"}`];
  });
  return ["```diff", ...lines, "```"].join("\n");
}

describeEmbeddedPostgres("change consent gate: binding approvals to displayed values", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-consent-value-binding-");
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

  async function seedFixture() {
    const companyId = randomUUID();
    const proposerId = randomUUID();
    const victimId = randomUUID();
    const sourceRunId = randomUUID();
    const proposalIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "The Workshop",
      issuePrefix: "THE",
      defaultResponsibleUserId: "local-board",
    });
    await db.insert(agents).values({
      id: proposerId,
      companyId,
      name: "Proposer",
      role: "general",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agents).values({
      id: victimId,
      companyId,
      name: "Builder",
      role: "engineer",
      title: "Build Engineer",
      capabilities: "builds things",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: proposerId,
      status: "succeeded",
    });
    await db.insert(issues).values({
      id: proposalIssueId,
      companyId,
      title: "Review profile change proposal",
      status: "in_review",
      priority: "medium",
      identifier: "ISS-1",
      issueNumber: 1,
      createdByAgentId: proposerId,
    });

    return { companyId, proposerId, victimId, sourceRunId, proposalIssueId };
  }

  async function raiseAcceptedCard(ctx: {
    companyId: string;
    proposerId: string;
    victimId: string;
    sourceRunId: string;
    proposalIssueId: string;
    displayedBefore: ProfilePatch;
    displayedAfter: ProfilePatch;
  }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: ctx.companyId,
      issueId: ctx.proposalIssueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      sourceRunId: ctx.sourceRunId,
      createdByAgentId: ctx.proposerId,
      payload: {
        version: 1,
        prompt: "Apply this profile change?",
        detailsMarkdown: renderProposedDiff(ctx.displayedBefore, ctx.displayedAfter),
        target: {
          type: "custom",
          key: agentProfileChangeTargetKey(ctx.victimId),
          revisionId: "proposal-v1",
          proposedValues: ctx.displayedAfter as Record<string, unknown>,
          valueDigest: consentValueDigest(
            agentProfileChangeTargetKey(ctx.victimId),
            ctx.displayedAfter as Record<string, unknown>,
          ),
          digestVersion: CONSENT_VALUE_DIGEST_VERSION,
        },
      },
      result: { version: 1, outcome: "accepted" },
      resolvedByUserId: "local-board",
      resolvedAt: new Date(),
    });
    return interactionId;
  }

  async function applyProfilePatch(ctx: {
    companyId: string;
    proposerId: string;
    victimId: string;
    actorRunId: string;
    patch: ProfilePatch;
  }) {
    const targetKey = agentProfileChangeTargetKey(ctx.victimId);
    await changeConsentGateService(db).assertConsented({
      companyId: ctx.companyId,
      actorAgentId: ctx.proposerId,
      actorRunId: ctx.actorRunId,
      targetKeys: [targetKey],
      expectedValueDigest: consentValueDigest(targetKey, ctx.patch as Record<string, unknown>),
      requiresHumanResolver: false,
    });
    await db.update(agents).set({ ...ctx.patch, updatedAt: new Date() }).where(eq(agents.id, ctx.victimId));
  }

  async function readProfile(victimId: string) {
    const [row] = await db
      .select({
        name: agents.name,
        role: agents.role,
        title: agents.title,
        capabilities: agents.capabilities,
      })
      .from(agents)
      .where(eq(agents.id, victimId));
    return row;
  }

  describe("approvals are bound to the values they displayed", () => {
    it("refuses an approval redeemed for values the human never saw", async () => {
      const ctx = await seedFixture();

      const displayedBefore: ProfilePatch = { title: "Build Engineer" };
      const displayedAfter: ProfilePatch = { title: "Senior Build Engineer" };
      const interactionId = await raiseAcceptedCard({ ...ctx, displayedBefore, displayedAfter });
      const profileBefore = await readProfile(ctx.victimId);

      const neverDisplayed: ProfilePatch = {
        name: "Administrator",
        role: "admin",
        title: "Owner",
        capabilities: "unrestricted",
      };
      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: neverDisplayed,
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_mismatch" },
      });

      expect(await readProfile(ctx.victimId)).toEqual(profileBefore);

      const [stored] = await db
        .select({ payload: issueThreadInteractions.payload, result: issueThreadInteractions.result })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId));
      expect(stored?.result).toMatchObject({ outcome: "accepted" });
      expect((stored?.result as { consumedAt?: unknown }).consumedAt).toBeUndefined();
      expect((stored?.result as { consumedByRunId?: unknown }).consumedByRunId).toBeUndefined();

      const details = (stored?.payload as { detailsMarkdown: string }).detailsMarkdown;
      expect(details).toContain("+title: Senior Build Engineer");
      expect(details).not.toContain("capabilities:");

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: displayedAfter,
      })).resolves.toBeUndefined();
      expect(await readProfile(ctx.victimId)).toMatchObject({ title: "Senior Build Engineer" });
    });

    it("refuses a card whose displayed diff is unrelated boilerplate", async () => {
      const ctx = await seedFixture();

      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: ctx.sourceRunId,
        createdByAgentId: ctx.proposerId,
        payload: {
          version: 1,
          prompt: "Apply this profile change?",
          detailsMarkdown: "- no material change\n- formatting only",
          target: {
            type: "custom",
            key: agentProfileChangeTargetKey(ctx.victimId),
            revisionId: "proposal-v1",
          },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "local-board",
        resolvedAt: new Date(),
      });
      const profileBefore = await readProfile(ctx.victimId);

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { name: "Administrator", role: "admin" },
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_absent" },
      });

      expect(await readProfile(ctx.victimId)).toEqual(profileBefore);
    });

    it("refuses a digest transplanted from another target's card", async () => {
      const ctx = await seedFixture();
      const sameValues: ProfilePatch = { title: "Senior Build Engineer" };
      const victimKey = agentProfileChangeTargetKey(ctx.victimId);
      const proposerKey = agentProfileChangeTargetKey(ctx.proposerId);

      expect(consentValueDigest(proposerKey, sameValues as Record<string, unknown>))
        .not.toEqual(consentValueDigest(victimKey, sameValues as Record<string, unknown>));

      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: ctx.sourceRunId,
        createdByAgentId: ctx.proposerId,
        payload: {
          version: 1,
          prompt: "Apply this profile change?",
          detailsMarkdown: renderProposedDiff({ title: "Build Engineer" }, sameValues),
          target: {
            type: "custom",
            key: victimKey,
            revisionId: "proposal-v1",
            proposedValues: sameValues,
            valueDigest: consentValueDigest(proposerKey, sameValues as Record<string, unknown>),
            digestVersion: CONSENT_VALUE_DIGEST_VERSION,
          },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "local-board",
        resolvedAt: new Date(),
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: sameValues,
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_mismatch" },
      });
    });

    it("refuses a card whose digest version is not recognized", async () => {
      const ctx = await seedFixture();
      const values: ProfilePatch = { title: "Senior Build Engineer" };
      const targetKey = agentProfileChangeTargetKey(ctx.victimId);

      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId: ctx.companyId,
        issueId: ctx.proposalIssueId,
        kind: "request_confirmation",
        status: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        sourceRunId: ctx.sourceRunId,
        createdByAgentId: ctx.proposerId,
        payload: {
          version: 1,
          prompt: "Apply this profile change?",
          detailsMarkdown: renderProposedDiff({ title: "Build Engineer" }, values),
          target: {
            type: "custom",
            key: targetKey,
            revisionId: "proposal-v1",
            proposedValues: values,
            valueDigest: consentValueDigest(targetKey, values as Record<string, unknown>),
            digestVersion: 2,
          },
        },
        result: { version: 1, outcome: "accepted" },
        resolvedByUserId: "local-board",
        resolvedAt: new Date(),
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: values,
      })).rejects.toMatchObject({
        status: 403,
        details: { code: "consent_value_digest_absent" },
      });
    });

    it("picks the card bound to this write when several are accepted for one target", async () => {
      const ctx = await seedFixture();

      const wanted: ProfilePatch = { title: "Senior Build Engineer" };
      const matching = await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: wanted,
      });
      const other = await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: { title: "Principal Engineer" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: wanted,
      })).resolves.toBeUndefined();

      const rows = await db
        .select({ id: issueThreadInteractions.id, result: issueThreadInteractions.result })
        .from(issueThreadInteractions);
      const consumedIds = rows
        .filter((row) => (row.result as { consumedAt?: unknown }).consumedAt !== undefined)
        .map((row) => row.id);
      expect(consumedIds).toEqual([matching]);
      expect(rows.find((row) => row.id === other)?.result).toMatchObject({ outcome: "accepted" });
    });
  });

  describe("consent value digest", () => {
    const targetKey = "agent:11111111-1111-1111-1111-111111111111:profile";

    it("is independent of key order", () => {
      expect(consentValueDigest(targetKey, { name: "A", role: "b" }))
        .toEqual(consentValueDigest(targetKey, { role: "b", name: "A" }));
    });

    it("distinguishes a null from an absent field", () => {
      expect(consentValueDigest(targetKey, { title: null }))
        .not.toEqual(consentValueDigest(targetKey, {}));
      expect(canonicalizeConsentValues({ title: null })).toEqual('{"title":null}');
      expect(canonicalizeConsentValues({ title: undefined })).toEqual("{}");
    });

    it("treats a whitespace-only edit as a value change", () => {
      expect(consentValueDigest(targetKey, { title: "Owner" }))
        .not.toEqual(consentValueDigest(targetKey, { title: "Owner " }));
    });

    it("binds the digest to its target key", () => {
      expect(consentValueDigest(targetKey, { title: "Owner" }))
        .not.toEqual(consentValueDigest(`${targetKey}x`, { title: "Owner" }));
    });

    it("refuses values that do not canonicalize predictably", () => {
      expect(() => consentValueDigest(targetKey, { when: new Date() })).toThrow();
      expect(() => consentValueDigest(targetKey, { size: Number.NaN })).toThrow();
    });
  });

  describe("existing guarantees that must survive the fix", () => {
    it("still requires a card raised in a previous run", async () => {
      const ctx = await seedFixture();
      await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: { title: "Senior Build Engineer" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: ctx.sourceRunId,
        patch: { title: "Senior Build Engineer" },
      })).rejects.toMatchObject({ status: 403 });
    });

    it("still refuses a second redemption of the same card", async () => {
      const ctx = await seedFixture();
      await raiseAcceptedCard({
        ...ctx,
        displayedBefore: { title: "Build Engineer" },
        displayedAfter: { title: "Senior Build Engineer" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { title: "Senior Build Engineer" },
      })).resolves.toBeUndefined();

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { title: "Senior Build Engineer" },
      })).rejects.toMatchObject({ status: 403 });
    });

    it("still refuses a card raised for a different agent's profile", async () => {
      const ctx = await seedFixture();
      await raiseAcceptedCard({
        ...ctx,
        victimId: ctx.proposerId, // card is about a different target
        displayedBefore: { title: "Proposer" },
        displayedAfter: { title: "Proposer II" },
      });

      await expect(applyProfilePatch({
        companyId: ctx.companyId,
        proposerId: ctx.proposerId,
        victimId: ctx.victimId,
        actorRunId: randomUUID(),
        patch: { title: "Senior Build Engineer" },
      })).rejects.toMatchObject({ status: 403 });
    });
  });
});
