import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import {
  createDb,
  companies,
  agents,
  companyMemberships,
  companyFastResponses,
  costEvents,
  fastResponseRequests,
  connectionGrants,
  connectionGrantMembers,
  budgetPolicies,
  budgetReservations,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  issueComments,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import {
  enqueueFastResponse,
  supersedeFastResponse,
  fastResponseService,
} from "../services/fast-responses.js";
import {
  fastResponseReceipt,
  type FastResponseOutcome,
} from "../services/fast-response-provider.js";
import { settleConversationTurn } from "../services/agent-conversations.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>,
  db: ReturnType<typeof createDb>,
  home: string;
beforeAll(async () => {
  home = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "paperclip-fast-response-")),
  );
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "fast-response-fixture");
  database = await startEmbeddedPostgresTestDatabase(
    "paperclip-fast-response-db-",
  );
  db = createDb(database.connectionString);
}, 90000);
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});
const outcome: FastResponseOutcome = {
  text: "I’ll check the settings panel’s border styling and work on the fix.",
  receipt: fastResponseReceipt({
    usage: { inputTokens: 80, outputTokens: 16 },
    response: { id: "response-1", body: { usage: { cost: 0.00001 } } },
  }),
};
let sequence = 0;
async function fixture() {
  const companyId = randomUUID(),
    agentId = randomUUID(),
    issueId = randomUUID();
  await db
    .insert(companies)
    .values({
      id: companyId,
      name: "Fast response tests",
      issuePrefix: `FR${++sequence}`,
    });
  await db
    .insert(agents)
    .values({
      id: agentId,
      companyId,
      name: "Alex",
      adapterType: "codex_local",
    });
  await db
    .insert(companyMemberships)
    .values(
      ["alice", "bob"].map((principalId) => ({
        companyId,
        principalId,
        principalType: "user",
        status: "active",
        membershipRole: "owner",
      })),
    );
  const binding = await aiConnectionService(db).save(
    companyId,
    "alice",
    {
      provider: "openrouter",
      method: "api_key",
      name: "Fast key",
      ownership: "shared",
      apiKey: "fixture-key",
      agentIds: [],
      allAgents: true,
    },
    "fixture-key",
  );
  const provider = vi.fn().mockResolvedValue(structuredClone(outcome)),
    service = fastResponseService(db, { provider });
  const config = {
    connectionId: binding.connectionId,
    grantId: binding.grantId,
    enabled: true,
    model: "openai/gpt-oss-120b",
    allowSponsored: true,
  };
  await service.configure(companyId, "alice", config);
  await db
    .insert(issues)
    .values({
      id: issueId,
      companyId,
      title: "Settings panel",
      status: "in_progress",
      assigneeAgentId: agentId,
    });
  const [comment] = await db
    .insert(issueComments)
    .values({
      companyId,
      issueId,
      authorUserId: "alice",
      body: "Fix the border styling",
    })
    .returning();
  const source = {
    companyId,
    agentId,
    issueId,
    responsibleUserId: "alice",
    sourceCommentId: comment.id,
    sourceKey: `comment:${comment.id}`,
    acceptedAt: comment.createdAt,
  };
  const enqueue = async () => {
    await db.transaction((tx) =>
      enqueueFastResponse(tx as unknown as typeof db, source),
    );
    return (
      await db
        .select()
        .from(fastResponseRequests)
        .where(eq(fastResponseRequests.companyId, companyId))
    )[0];
  };
  return {
    companyId,
    agentId,
    issueId,
    comment,
    source,
    config,
    binding,
    provider,
    service,
    enqueue,
  };
}
describe("fast response accepted turns", () => {
  it("starts disabled, and disabled turns have no request or cost", async () => {
    const f = await fixture();
    await db
      .delete(companyFastResponses)
      .where(eq(companyFastResponses.companyId, f.companyId));
    expect(await f.service.settings(f.companyId)).toMatchObject({
      enabled: false,
      allowSponsored: true,
    });
    expect(await f.enqueue()).toBeUndefined();
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("deduplicates concurrent workers and persists provenance without fabricating a run", async () => {
    const f = await fixture();
    const row = await f.enqueue();
    await f.enqueue();
    await Promise.all([f.service.process(row), f.service.process(row)]);
    expect(f.provider).toHaveBeenCalledTimes(1);
    const receipts = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.companyId, f.companyId),
          eq(issueComments.origin, "fast_response"),
        ),
      );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      authorAgentId: f.agentId,
      createdByRunId: null,
      fastResponseRequestId: row.id,
    });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toHaveLength(0);
    await db
      .update(issues)
      .set({
        conversationAgentId: f.agentId,
        conversationUserId: "alice",
        conversationState: "active",
      })
      .where(eq(issues.id, f.issueId));
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.agentId,
        status: "succeeded",
        invocationSource: "on_demand",
        contextSnapshot: { issueId: f.issueId, wakeCommentId: f.comment.id },
      })
      .returning();
    expect(await settleConversationTurn(db, run)).toBe(false);
    const [event] = await db
      .select()
      .from(costEvents)
      .where(eq(costEvents.companyId, f.companyId));
    expect(event).toMatchObject({
      usageKind: "fast_response",
      heartbeatRunId: null,
      costCents: 0.001,
      responsibleUserId: "alice",
    });
    expect(
      (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]
        .status,
    ).toBe("in_progress");
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.fastResponseRequestId, row.id))
      )[0].state,
    ).toBe("settled");
  });
  it.each([
    "reply",
    "cancel",
    "delete",
    "reassign",
    "edit",
    "revoke",
    "reset",
    "stream",
    "board_stream",
  ])(
    "suppresses output after %s but retains its actual cost",
    async (change) => {
      const f = await fixture(),
        row = await f.enqueue();
      if (change === "reset") {
        await db
          .update(fastResponseRequests)
          .set({ sessionGeneration: 0 })
          .where(eq(fastResponseRequests.id, row.id));
        row.sessionGeneration = 0;
      }
      f.provider.mockImplementationOnce(async () => {
        if (change === "reset")
          await db
            .update(issues)
            .set({ conversationSessionGeneration: 1 })
            .where(eq(issues.id, f.issueId));
        if (change === "board_stream")
          await supersedeFastResponse(db, f.companyId, f.comment.id);
        if (change === "stream") {
          const [run] = await db
            .insert(heartbeatRuns)
            .values({
              companyId: f.companyId,
              agentId: f.agentId,
              status: "running",
              invocationSource: "on_demand",
              contextSnapshot: {
                issueId: f.issueId,
                wakeCommentId: f.comment.id,
              },
            })
            .returning();
          await db
            .insert(heartbeatRunEvents)
            .values({
              companyId: f.companyId,
              agentId: f.agentId,
              runId: run.id,
              seq: 1,
              eventType: "item.delta",
              payload: {
                prpEvent: {
                  payload: {
                    kind: "agentMessage",
                    text: "Here is the recommendation",
                  },
                },
              },
            });
        }
        if (change === "reply")
          await db
            .insert(issueComments)
            .values({
              companyId: f.companyId,
              issueId: f.issueId,
              authorAgentId: f.agentId,
              body: "I fixed the border.",
            });
        if (change === "cancel")
          await db
            .update(issues)
            .set({ status: "cancelled" })
            .where(eq(issues.id, f.issueId));
        if (change === "delete")
          await db.delete(issues).where(eq(issues.id, f.issueId));
        if (change === "reassign")
          await db
            .update(issues)
            .set({ assigneeAgentId: null })
            .where(eq(issues.id, f.issueId));
        if (change === "edit")
          await db
            .update(issueComments)
            .set({ body: "Never mind", updatedAt: new Date(Date.now() + 100) })
            .where(eq(issueComments.id, f.comment.id));
        if (change === "revoke")
          await db
            .update(connectionGrants)
            .set({ status: "revoked" })
            .where(eq(connectionGrants.id, f.binding.grantId));
        return structuredClone(outcome);
      });
      await f.service.process(row);
      const [result] = await db
        .select()
        .from(fastResponseRequests)
        .where(eq(fastResponseRequests.id, row.id));
      expect(result).toMatchObject({
        status: "succeeded",
        publicationStatus: "suppressed",
        commentId: null,
      });
      expect(
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.companyId)),
      ).toHaveLength(1);
    },
  );
  it("does not call a provider for expired or denied linked-user turns", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    await db
      .insert(connectionGrantMembers)
      .values({
        companyId: f.companyId,
        grantId: f.binding.grantId,
        subjectType: "user",
        subjectId: "bob",
      });
    expect(await f.service.process(row)).toMatchObject({
      status: "unavailable",
    });
    expect(f.provider).not.toHaveBeenCalled();
    const g = await fixture(),
      expired = await g.enqueue();
    await g.service.process({ ...expired, expiresAt: new Date(0) });
    expect(g.provider).not.toHaveBeenCalled();
  });
  it("never regenerates interrupted attempts and keeps unknown charges reserved", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    f.provider.mockResolvedValueOnce({
      errorCode: "timeout",
      receipt: fastResponseReceipt(),
    });
    await f.service.process(row);
    await f.service.sweepPending();
    expect(f.provider).toHaveBeenCalledTimes(1);
    expect(
      (
        await db
          .select()
          .from(fastResponseRequests)
          .where(eq(fastResponseRequests.id, row.id))
      )[0].status,
    ).toBe("unknown");
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.fastResponseRequestId, row.id))
      )[0].state,
    ).toBe("held");
  });
  it("sponsors accepted unlinked senders using only destination-authorized context", async () => {
    const f = await fixture();
    await db
      .update(issues)
      .set({ title: "PRIVATE INTERNAL TITLE" })
      .where(eq(issues.id, f.issueId));
    const external = {
      ...f.source,
      responsibleUserId: null,
      sponsored: true,
      endpointId: randomUUID(),
    };
    await db.transaction((tx) =>
      enqueueFastResponse(tx as unknown as typeof db, external),
    );
    const [row] = await db
      .select()
      .from(fastResponseRequests)
      .where(eq(fastResponseRequests.companyId, f.companyId));
    const authorizeExternal = vi
      .fn()
      .mockResolvedValue({
        agentName: "Alex",
        message: "Review this border",
        queued: true,
      });
    const service = fastResponseService(db, {
      provider: f.provider,
      authorizeExternal,
    });
    await service.process(row);
    expect(authorizeExternal).toHaveBeenCalled();
    expect(f.provider).toHaveBeenCalledTimes(1);
    const prompt = f.provider.mock.calls[0][0].prompt;
    expect(prompt).toContain("Review this border");
    expect(prompt).toContain('"state":"queued"');
    expect(prompt).not.toContain("PRIVATE INTERNAL TITLE");
    expect(
      (
        await db
          .select()
          .from(costEvents)
          .where(eq(costEvents.companyId, f.companyId))
      )[0],
    ).toMatchObject({ responsibleUserId: null, usageKind: "fast_response" });
  });
  it("never treats a denied linked user as company sponsored", async () => {
    const f = await fixture();
    await db.transaction((tx) =>
      enqueueFastResponse(tx as unknown as typeof db, {
        ...f.source,
        sponsored: true,
        endpointId: randomUUID(),
      }),
    );
    const [row] = await db
      .select()
      .from(fastResponseRequests)
      .where(eq(fastResponseRequests.companyId, f.companyId));
    await f.service.process(row);
    expect(f.provider).not.toHaveBeenCalled();
  });
  it("expires unstarted backlog without an inference attempt", async () => {
    const f = await fixture(),
      row = await f.enqueue();
    await db
      .update(fastResponseRequests)
      .set({ expiresAt: new Date(0) })
      .where(eq(fastResponseRequests.id, row.id));
    await f.service.sweepPending();
    expect(f.provider).not.toHaveBeenCalled();
    expect(
      (
        await db
          .select()
          .from(fastResponseRequests)
          .where(eq(fastResponseRequests.id, row.id))
      )[0],
    ).toMatchObject({ status: "skipped", errorCode: "expired" });
  });
  it("honors the company reservation budget before dispatch", async () => {
    const f = await fixture();
    await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "company", scopeId: f.companyId, windowKind: "calendar_month_utc", amount: 1, reservationCents: "2", notifyEnabled: false });
    const row = await f.enqueue();
    expect(await f.service.process(row)).toMatchObject({ status: "unavailable" });
    expect(f.provider).not.toHaveBeenCalled();
    expect(await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId))).toHaveLength(0);
  });
  it("releases the reservation after a known provider rejection", async () => {
    const f = await fixture(), row = await f.enqueue();
    f.provider.mockResolvedValueOnce({ errorCode: "provider_auth_failed", noProviderWork: true, receipt: { inputTokens: 0, outputTokens: 0, costCents: "0", costStatus: "estimated", providerRequestId: null, pricingProvenance: { source: "unknown" } } });
    await f.service.process(row);
    expect((await db.select().from(budgetReservations).where(eq(budgetReservations.fastResponseRequestId, row.id)))[0].state).toBe("released");
    expect((await db.select().from(costEvents).where(eq(costEvents.companyId, f.companyId)))[0].costCents).toBe(0);
  });
  it("tests the fixed sample without posting a conversation message", async () => {
    const f = await fixture();
    const result = await f.service.test(f.companyId, "alice");
    expect(result.status).toBe("succeeded");
    expect(f.provider.mock.calls[0][0].prompt).toContain("settings panel");
    expect(
      await db
        .select()
        .from(issueComments)
        .where(eq(issueComments.companyId, f.companyId)),
    ).toHaveLength(1);
  });
});
