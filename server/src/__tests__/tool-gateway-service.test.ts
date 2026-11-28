import * as injectionPreventionModule from "../services/prompt-injection-prevention.js";
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { toolGatewayRoutes } from "../routes/tool-gateway.js";
import { toolReviewProjectionService } from "../services/tool-review-projection.js";
import { registerToolReviewProjectionWork } from "../services/tool-review-projection-work.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { registerToolReviewInterruptionWork } from "../services/tool-review-interruption-work.js";
import { writeToolReviewChange } from "../services/tool-review-work-notifications.js";
import { deleteCompany } from "../services/company-deletion.js";
import { subscribeDeliveryWork } from "../services/delivery-work-notifications.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import type { RequestConfirmationPayload } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  toolActionDeliveries,
  agents,
  approvals,
  companies,
  companySecretBindings,
  companySecrets,
  companyMemberships,
  toolConnectionInstalls,
  issueComments,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issues,
  projects,
  issueThreadInteractions,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolAccessAuditEvents,
  toolActionRequests,
  toolCallEvents,
  toolGatewaySessions,
  toolInvocations,
  toolPolicies,
  toolRateLimitCounters,
} from "@paperclipai/db";
import type { PluginToolDispatcher } from "../services/plugin-tool-dispatcher.js";
import type { VercelConnectClient } from "../services/vercel-connect.js";
import { initializeRunIdentity, reserveSteeredIdentity, reconcileSteeredIdentity } from "../services/run-identity.js";
import { issueService } from "../services/issues.js";
import { approvalService } from "../services/approvals.js";
import { commitToolActionReview } from "../services/tool-action-review.js";
import { bindVerifiedToolApprovalArguments, claimToolTestApproval, releaseToolApproval, startToolInvocation } from "../services/tool-approval-execution.js";
import { materializeNativeInteractionResponses } from "../services/native-runtime/native-interaction-bridge.js";
import { toolActionDeliveryService } from "../services/tool-action-delivery.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  createToolGatewayService,
  ToolGatewayHttpError,
} from "../services/tool-gateway.js";
import { canonicalToolArguments, readSignedToolArgumentsPayload, signToolArguments, summarizeToolValue, toolRequestIdentityHash } from "../services/tool-content-guards.js";
import { useGoogleMcpTransport } from "./helpers/google-workspace-transport.js";

import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerToolReviewRecoveryWork } from "../services/tool-review-recovery-work.js";
import { registerToolReviewExpiryWork } from "../services/tool-review-expiry-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { grantLegacyPluginTools } from "./helpers/legacy-plugin-tools.js";

import {
  createRemoteMcpToolFixture,
  createRunFixture,
  createTestToolGatewayService,
  createToolGatewayDbHarness,
  describeToolGatewayEmbeddedPostgres,
  fakePluginDispatcher,
  readPolicyRow,
  reviewNotePolicyRow,
  runSessionInput,
  testToolActionSigningSecret,
  type ToolGatewayServiceOptions,
} from "./helpers/tool-gateway-service-harness.js";

describeToolGatewayEmbeddedPostgres("tool gateway service", () => {
  const h = createToolGatewayDbHarness();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = h.db; });
  const clearFixtures = () => h.clearFixtures();

  describe("pending review expiry worker", () => {
    let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
    let gateway: ReturnType<typeof createToolGatewayService>;
    let fixture: Awaited<ReturnType<typeof createRunFixture>>;
    let draining: boolean;
    const errors: unknown[] = [];

    beforeEach(async () => {
      await Promise.all(Array.from({ length: 6 }, () => db.execute(sql`select pg_sleep(0.01)`)));
      fixture = await createRunFixture(db);
      await db.insert(toolPolicies).values(reviewNotePolicyRow(fixture.company));
      gateway = createTestToolGatewayService(db);
      draining = false; errors.length = 0;
      h.setStopReviewWorker(stopWorker);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
    });
    async function stopWorker() {
      await coordinator?.stop(); coordinator = undefined;
      vi.useRealTimers(); vi.restoreAllMocks();
      await db.execute(sql`drop trigger if exists sleep_review_fail on tool_invocations`);
      await db.execute(sql`drop trigger if exists sleep_projection_fail on issue_thread_interactions`);
      await db.execute(sql`drop function if exists sleep_projection_fail()`);
      await db.execute(sql`drop function if exists sleep_review_fail()`);
      await db.execute(sql`drop sequence if exists sleep_review_failure_attempt`);
      expect(errors).toEqual([]);
    }
    async function start() {
      coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
        canReconcile: () => true, onError: error => errors.push(error) });
      await registerToolReviewExpiryWork(coordinator, gateway, () => !draining).ready;
    }
    async function settle(ms = 60_000) {
      await vi.advanceTimersByTimeAsync(ms);
      if (!draining) await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0), { timeout: 5000 });
    }
    async function quiet() {
      await settle(); expect(coordinator!.nextWakeAt()).toBeNull();
      const selects = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute");
      await settle(60 * 60_000);
      expect(selects).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
      selects.mockRestore(); executes.mockRestore();
    }
    async function request(service = gateway, source = db, context = fixture) {
      const before = new Set((await source.select({ id: toolActionRequests.id }).from(toolActionRequests)
        .where(eq(toolActionRequests.companyId, context.company.id))).map(row => row.id));
      const session = await service.createSession(runSessionInput(context.company, context.agent, context.run));
      const noteId = randomUUID();
      await expect(service.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note",
        parameters: { noteId, body: "Awaiting a human" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
      const rows = (await source.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, context.company.id)))
        .filter(row => !before.has(row.id));
      expect(rows).toHaveLength(1);
      // This worker group exercises explicit deadlines. Ordinary human tool
      // reviews have no implicit expiry; give this fixture its intended hour.
      const [pending] = await writeToolReviewChange(source, context.company.id, tx => tx.update(toolActionRequests)
        .set({ expiresAt: new Date(Date.now() + 60 * 60_000) }).where(eq(toolActionRequests.id, rows[0].id)).returning());
      return pending;
    }
    async function expectExpired(id: string, invocationId: string) {
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, id)))[0].status).toBe("expired");
      expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, invocationId)))[0])
        .toMatchObject({ status: "failed", errorCode: "action_expired" });
      expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toEqual([]);
    }

    async function testRequest(provider: NonNullable<ToolGatewayServiceOptions["remoteHttpRequest"]>, rateLimited = false) {
      await db.insert(companyMemberships).values({ companyId: fixture.company.id, principalType: "user",
        principalId: "board", status: "active", membershipRole: "owner" });
      const remote = await createRemoteMcpToolFixture(db, fixture.company.id);
      await db.update(toolCatalogEntries).set({ isReadOnly: false, riskLevel: "write" })
        .where(eq(toolCatalogEntries.id, remote.catalogEntry.id));
      await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: "Review connected writes",
        policyType: "require_approval", priority: 10, selectors: { connectionId: remote.connection.id } });
      if (rateLimited) await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: "One reviewed test call",
        policyType: "rate_limit", priority: 1, selectors: { connectionId: remote.connection.id },
        config: { limit: 1, windowSeconds: 3600, keyBy: ["agent", "tool"] } });
      gateway = createTestToolGatewayService(db, { remoteHttpRequest: provider });
      const result = await gateway.executeTestCall({ companyId: fixture.company.id, connectionId: remote.connection.id,
        agentId: fixture.agent.id, userId: "board", toolName: "needs_input", parameters: { value: "reviewed" } });
      expect(result.decision).toBe("ask_first");
      const [pending] = await db.select().from(toolActionRequests);
      return { pending, remote };
    }
    function providerFixture() {
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const started = new Promise<void>(resolve => { entered = resolve; });
      const provider = vi.fn(async (_url: string, init: RequestInit) => {
        const payload = JSON.parse(String(init.body));
        expect(payload.method).toBe("tools/call");
        entered(); await gate;
        return Response.json({ jsonrpc: "2.0", id: payload.id,
          result: { content: [{ type: "text", text: "Saved once" }] } });
      });
      return { provider, release, started };
    }

    describe("tool review projection worker", () => {
      async function startProjection() {
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
          canReconcile: () => true, onError: error => errors.push(error) });
        await registerToolReviewProjectionWork(coordinator, { sweep: gateway.repairActionReviewProjections, companies: gateway.actionReviewProjectionCompanies }, () => !draining).ready;
      }
      async function savedOutcome(pending: Awaited<ReturnType<typeof request>>, source = db,
        status: "executed" | "failed" | "expired" | "cancelled" = "executed") {
        await writeToolReviewChange(source, pending.companyId, async tx => {
          await tx.update(toolInvocations).set({ status: status === "executed" ? "succeeded" : "failed",
            errorCode: status === "executed" ? null : "saved_failure", errorMessage: null,
            resultSummary: { summary: "Durable result" }, completedAt: new Date() })
            .where(eq(toolInvocations.id, pending.invocationId));
          await tx.update(toolActionRequests).set({ status, updatedAt: new Date() })
            .where(eq(toolActionRequests.id, pending.id));
        });
      }
      async function acceptedCard(pending: Awaited<ReturnType<typeof request>>) {
        expect(pending.interactionId).not.toBeNull();
        await db.update(issueThreadInteractions).set({ status: "accepted", result: { version: 1, outcome: "accepted" } })
          .where(eq(issueThreadInteractions.id, pending.interactionId!));
      }
      async function projection(pending: Awaited<ReturnType<typeof request>>) {
        const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!));
        return (row.result as { toolAction?: { status: string; resultSummary: string; errorCode: string | null } } | null)?.toolAction;
      }

      it("becomes quiet with configuration and repairs a real foreground approval without replay", async () => {
        await startProjection(); await quiet();
        const pending = await request();
        await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
        await quiet(); expect(await projection(pending)).toMatchObject({ status: "executed" });
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(1);
        const before = (await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_updated"))).length;
        await gateway.repairActionReviewProjections();
        expect((await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_updated"))).length).toBe(before);
      });

      it("keeps projection scans scoped to the company whose review changed", async () => {
        const other = await createRunFixture(db);
        await db.insert(toolPolicies).values(reviewNotePolicyRow(other.company));
        const foreign = await request(gateway, db, other);
        await gateway.approveActionRequest({ companyId: other.company.id, actionRequestId: foreign.id, actor: { userId: "board" } });
        await startProjection(); await quiet();
        const before = await projection(foreign);
        const reads: Array<{ query: string; params: unknown[] }> = [];
        const debug = db.$client.options.debug;
        db.$client.options.debug = (_id, query, params) => {
          if (/^select/i.test(query) && query.includes('"tool_action_requests"') && query.includes("coalesce("))
            reads.push({ query, params: [...params] });
        };
        try {
          for (let index = 0; index < 3; index++) {
            const pending = await request();
            await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
            await settle(1500); expect(await projection(pending)).toMatchObject({ status: "executed" });
          }
        } finally { db.$client.options.debug = debug; }
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads) {
          expect(read.query).toContain('"tool_action_requests"."company_id" =');
          expect(read.params).toContain(fixture.company.id);
          expect(read.params).not.toContain(other.company.id);
        }
        expect(await projection(foreign)).toEqual(before); await quiet();
      });

      it("uses one candidate scan for a committed company hint with matching retained history", async () => {
        const pending = await request();
        await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
        await startProjection(); await quiet();
        const reads: string[] = [];
        const debug = db.$client.options.debug;
        db.$client.options.debug = (_id, query) => {
          if (/^select/i.test(query) && query.includes('"tool_action_requests"') && query.includes("coalesce(")) reads.push(query);
        };
        try {
          await writeToolReviewChange(db, pending.companyId, async tx => {
            await tx.update(toolActionRequests).set({ updatedAt: new Date() }).where(eq(toolActionRequests.id, pending.id));
          });
          await settle();
          expect(reads).toHaveLength(1);
          await quiet();
          expect(reads).toHaveLength(1);
          reads.length = 0;
          expect(await gateway.repairActionReviewProjections(fixture.company.id)).toMatchObject({ scanned: 0, retry: false });
          expect(reads).toHaveLength(1);
        } finally { db.$client.options.debug = debug; }
      });

      it("backs off unresolved cards to five minutes and clears the retry after settlement", async () => {
        const pending = await request();
        await savedOutcome(pending, db, "failed");
        await startProjection();
        for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
          const next = coordinator!.nextWakeAt();
          expect(next).not.toBeNull();
          expect(next! - Date.now()).toBeGreaterThan(delay - 1500);
          expect(next! - Date.now()).toBeLessThanOrEqual(delay);
          await settle(next! - Date.now() + 100);
        }
        expect(await projection(pending)).toBeUndefined();
        await acceptedCard(pending);
        await writeToolReviewChange(db, pending.companyId, async tx => {
          await tx.update(toolActionRequests).set({ updatedAt: new Date() }).where(eq(toolActionRequests.id, pending.id));
        });
        await settle();
        expect(await projection(pending)).toMatchObject({ status: "failed" });
        await quiet();
      });

      it("does not wake projection repair for ordinary confirmation creation, replacement, or cancellation", async () => {
        await startProjection(); await quiet();
        const interactions = issueThreadInteractionService(db);
        const scope = { id: fixture.issue.id, companyId: fixture.company.id };
        const [recipient] = await db.insert(agents).values({ companyId: fixture.company.id,
          name: "Plan recipient", role: "engineer", adapterType: "process" }).returning();
        const input = { kind: "request_confirmation" as const, addresseeAgentId: recipient.id,
          payload: { version: 1 as const, prompt: "Approve this plan?" } };
        const signal = vi.fn();
        const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.toolReviewProjection, signal);
        const reads: string[] = [];
        const debug = db.$client.options.debug;
        db.$client.options.debug = (_id, query) => {
          if (/^select/i.test(query) && query.includes('"tool_action_requests"') && query.includes("coalesce(")) reads.push(query);
        };
        try {
          const first = await interactions.create(scope, input, { agentId: fixture.agent.id });
          const second = await interactions.create(scope, input, { agentId: fixture.agent.id });
          const cancelled = await interactions.cancelPendingForDeletedAddressee(fixture.company.id, recipient.id);
          expect(cancelled.map(row => row.id)).toEqual([second.id]);
          expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, first.id)))[0].status).toBe("expired");
          await settle();
          expect(signal).not.toHaveBeenCalled();
          expect(reads).toEqual([]);
          await quiet();
        } finally { unsubscribe(); db.$client.options.debug = debug; }
      });

      it.each(["executed", "failed", "expired", "cancelled"] as const)("reconstructs a saved %s result after restart and leaves terminal history quiet", async status => {
        const pending = await request(); await acceptedCard(pending); await savedOutcome(pending, db, status);
        await startProjection(); await quiet();
        expect(await projection(pending)).toMatchObject({ status: status === "cancelled" ? "expired" : status,
          resultSummary: "Durable result", errorCode: status === "executed" ? null : "saved_failure" });
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toEqual([]);
      });

      it("retains a first terminal write during drain without passive scans", async () => {
        const pending = await request(); await acceptedCard(pending);
        await startProjection(); await quiet(); draining = true;
        await savedOutcome(pending); await settle();
        const reads = vi.spyOn(db, "select");
        await settle(60 * 60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        expect(await projection(pending)).toBeUndefined();
        draining = false; await settle(); await quiet();
        expect(await projection(pending)).toMatchObject({ status: "executed" });
      });

      it.each([false, true])("waits for the outer outcome transaction (rollback %s)", async rollback => {
        const pending = await request(); await acceptedCard(pending); await startProjection(); await quiet();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const aborted = new Error("fixture rollback");
        const running = db.transaction(async tx => {
          await savedOutcome(pending, tx as unknown as typeof db);
          entered(); await gate; if (rollback) throw aborted;
        }).catch(error => { if (error !== aborted) throw error; });
        await ready;
        try { await vi.advanceTimersByTimeAsync(60_000); expect(await projection(pending)).toBeUndefined(); }
        finally { release(); await running; }
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(idleWorkSnapshot().active).toBe(0);
          if (rollback) expect(await projection(pending)).toBeUndefined();
          else expect(await projection(pending)).toMatchObject({ status: "executed" });
        }, { timeout: 5000 });
        await quiet();
      });

      it("retries a failed projection through drain without executing the saved action", async () => {
        const pending = await request(); await acceptedCard(pending); await savedOutcome(pending);
        await db.execute(sql`create function sleep_projection_fail() returns trigger language plpgsql as $$
          begin raise exception 'projection fixture failure'; end $$`);
        await db.execute(sql`create trigger sleep_projection_fail before update on issue_thread_interactions
          for each row when (new.result->'toolAction'->>'status' = 'executed') execute function sleep_projection_fail()`);
        await startProjection(); expect(errors.length).toBeGreaterThan(0); errors.length = 0;
        expect(await projection(pending)).toBeUndefined();
        draining = true;
        await db.execute(sql`drop trigger sleep_projection_fail on issue_thread_interactions`);
        await settle(60 * 60_000); draining = false;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          expect(await projection(pending)).toMatchObject({ status: "executed" });
        }, { timeout: 5000 });
        await quiet();
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toEqual([]);
      });

      it("backs off a failing company while another company's projection completes", async () => {
        const other = await createRunFixture(db);
        await db.insert(toolPolicies).values(reviewNotePolicyRow(other.company));
        const foreign = await request(gateway, db, other); await acceptedCard(foreign); await savedOutcome(foreign, db, "failed");
        await db.execute(sql`create function sleep_projection_fail() returns trigger language plpgsql as $$
          begin raise exception 'company projection fixture failure'; end $$`);
        await db.execute(sql`create trigger sleep_projection_fail before update on issue_thread_interactions
          for each row when (new.result->'toolAction'->>'status' = 'failed') execute function sleep_projection_fail()`);
        await startProjection(); expect(errors).toHaveLength(1); errors.length = 0;
        const retryAt = coordinator!.nextWakeAt(); expect(retryAt).not.toBeNull();
        const pending = await request(); await acceptedCard(pending); await savedOutcome(pending);
        await request(gateway, db, other);
        await settle(5000);
        expect(await projection(pending)).toMatchObject({ status: "executed" });
        expect(await projection(foreign)).toBeUndefined();
        expect(errors).toEqual([]); expect(coordinator!.nextWakeAt()).toBe(retryAt);
        await db.execute(sql`drop trigger sleep_projection_fail on issue_thread_interactions`);
        await settle(); await quiet();
        expect(await projection(foreign)).toMatchObject({ status: "failed" });
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toEqual([]);
      });

      it("rechecks the projection under lock when foreground repair wins the race", async () => {
        const pending = await request(); await acceptedCard(pending); await savedOutcome(pending);
        const transaction = db.transaction.bind(db);
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const intercepted = vi.spyOn(db, "transaction").mockImplementationOnce(async callback => {
          entered(); await gate; return transaction(callback);
        });
        const repair = gateway.repairActionReviewProjections();
        await ready;
        try { await gateway.repairActionReviewProjections(); } finally { release(); }
        await repair; intercepted.mockRestore();
        const updates = await db.select().from(activityLog).where(and(eq(activityLog.companyId, fixture.company.id),
          eq(activityLog.action, "issue.thread_interaction_updated")));
        expect(updates).toHaveLength(1);
        expect(await projection(pending)).toMatchObject({ status: "executed" });
        await startProjection(); await quiet();
      });

      async function projectionBacklog(count: number) {
        const pending = await request(); await acceptedCard(pending); await savedOutcome(pending, db, "failed");
        const [template] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!));
        const cards = Array.from({ length: count - 1 }, () => ({ ...template, id: randomUUID(), idempotencyKey: randomUUID() }));
        if (cards.length) await db.insert(issueThreadInteractions).values(cards);
        const requests = cards.map((card, index) => ({ ...pending,
          id: `ffffffff-ffff-4fff-afff-${String(index).padStart(12, "0")}`,
          interactionId: card.id, status: "failed" as const }));
        if (requests.length) await db.insert(toolActionRequests).values(requests);
        const cardByRequest = new Map([pending, ...requests].map(row => [row.id, row.interactionId!]));
        const reflect = async (id: string) => {
          await db.update(issueThreadInteractions).set({ result: sql`${issueThreadInteractions.result}
            || ${JSON.stringify({ toolAction: { status: "failed" } })}::jsonb` })
            .where(eq(issueThreadInteractions.id, cardByRequest.get(id)!));
        };
        return { cardByRequest, reflect };
      }

      it("bounds a projection worker pass and continues its saved backlog", async () => {
        await projectionBacklog(501);
        await startProjection();
        const projected = async () => (await db.select().from(issueThreadInteractions))
          .filter(card => (card.result as { toolAction?: { status: string } } | null)?.toolAction?.status === "failed").length;
        expect(await projected()).toBe(500);
        expect(coordinator!.nextWakeAt()).not.toBeNull();
        await settle(2000); await quiet();
        expect(await projected()).toBe(501);
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toEqual([]);
      });

      it("clears an abandoned projection cursor after empty reconstruction before the next write", async () => {
        const backlog = await projectionBacklog(3);
        const service = toolReviewProjectionService(db, input => backlog.reflect(input.actionRequestId));
        expect(await service.sweep(fixture.company.id, { maxRows: 1 })).toMatchObject({ scanned: 1, truncated: true });
        for (const id of backlog.cardByRequest.keys()) await backlog.reflect(id);
        expect(await service.companies(fixture.company.id)).toEqual([]);
        const firstId = [...backlog.cardByRequest.keys()].sort()[0]!;
        await db.update(issueThreadInteractions).set({ result: sql`${issueThreadInteractions.result} - 'toolAction'` })
          .where(eq(issueThreadInteractions.id, backlog.cardByRequest.get(firstId)!));
        expect(await service.sweep(fixture.company.id, { maxRows: 500 })).toMatchObject({ scanned: 1, retry: false });
      });

      it.each(["abort", "drain"] as const)("stops projection between rows on %s and resumes without losing cards", async mode => {
        const backlog = await projectionBacklog(5), controller = new AbortController();
        const seen: string[] = []; let admitted = true;
        const service = toolReviewProjectionService(db, async input => {
          seen.push(input.actionRequestId); await backlog.reflect(input.actionRequestId);
          if (seen.length === 1) { if (mode === "abort") controller.abort(); else admitted = false; }
        });
        expect(await service.sweep(fixture.company.id, { maxRows: 500, signal: controller.signal, shouldContinue: () => admitted }))
          .toMatchObject({ scanned: 1, retry: true, truncated: true });
        expect(seen).toHaveLength(1);
        admitted = true;
        expect(await service.sweep(fixture.company.id, { maxRows: 500 })).toMatchObject({ scanned: 4, retry: false });
        expect(new Set(seen).size).toBe(5);
      });

      it.each(["unprojectable", "failed"] as const)("continues beyond a full %s page before revisiting it", async mode => {
        const backlog = await projectionBacklog(501);
        const blocked = new Set([...backlog.cardByRequest.keys()].sort().slice(0, 500)), seen: string[] = [];
        const service = toolReviewProjectionService(db, async input => {
          seen.push(input.actionRequestId);
          if (blocked.has(input.actionRequestId)) { if (mode === "failed") throw new Error("saved card unavailable"); return; }
          await backlog.reflect(input.actionRequestId);
        });
        const first = service.sweep(fixture.company.id, { maxRows: 500 });
        if (mode === "failed") await expect(first).rejects.toBeInstanceOf(AggregateError);
        else expect(await first).toMatchObject({ scanned: 500, retry: true, truncated: true });
        expect(seen).toHaveLength(500); seen.length = 0;
        expect(await service.sweep(fixture.company.id, { maxRows: 500 })).toMatchObject({ scanned: 1, retry: true, truncated: false });
        expect(seen).toHaveLength(1); expect(blocked.has(seen[0]!)).toBe(false);
      });

      it("does not starve later pages behind a card that cannot yet reflect its outcome", async () => {
        const pending = await request(); await savedOutcome(pending, db, "failed");
        const [template] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!));
        const copies = Array.from({ length: 101 }, () => ({ ...template, id: randomUUID(), idempotencyKey: randomUUID(),
          status: "accepted" as const, result: { version: 1 as const, outcome: "accepted" as const } }));
        await db.insert(issueThreadInteractions).values(copies);
        await db.insert(toolActionRequests).values(copies.map((card, index) => ({ ...pending,
          id: `ffffffff-ffff-4fff-afff-${String(index).padStart(12, "0")}`,
          interactionId: card.id, status: "failed" as const })));
        await startProjection();
        expect(coordinator!.nextWakeAt()).not.toBeNull();
        const cards = await db.select().from(issueThreadInteractions);
        expect(cards.filter(card => (card.result as { toolAction?: { status: string } } | null)?.toolAction?.status === "failed")).toHaveLength(101);
        await db.update(issueThreadInteractions).set({ addresseeAgentId: fixture.agent.id }).where(eq(issueThreadInteractions.id, pending.interactionId!));
        await issueThreadInteractionService(db).cancelPendingForDeletedAddressee(fixture.company.id, fixture.agent.id);
        await settle(); await quiet();
        expect(await projection(pending)).toMatchObject({ status: "failed" });
      });

      it.each([false, true])("reactivates when an administrative card mutation overwrites a settled projection (legacy %s)", async legacy => {
        const pending = await request();
        if (legacy) {
          const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!));
          const payload = { ...card.payload } as RequestConfirmationPayload;
          delete payload.toolAction; delete payload.target;
          await db.update(issueThreadInteractions).set({ payload }).where(eq(issueThreadInteractions.id, pending.interactionId!));
        }
        await db.update(issueThreadInteractions).set({ addresseeAgentId: fixture.agent.id,
          result: { version: 1, outcome: "accepted" } }).where(eq(issueThreadInteractions.id, pending.interactionId!));
        await savedOutcome(pending, db, "failed"); await startProjection(); await quiet();
        expect(await projection(pending)).toMatchObject({ status: "failed" });
        await issueThreadInteractionService(db).cancelPendingForDeletedAddressee(fixture.company.id, fixture.agent.id);
        await settle(); await quiet();
        expect(await projection(pending)).toMatchObject({ status: "failed", errorCode: "saved_failure" });
      });
    });

    describe("interrupted review recovery worker", () => {
      async function startInterruption() {
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
          canReconcile: () => true, onError: error => errors.push(error) });
        await registerToolReviewInterruptionWork(coordinator, gateway, () => !draining).ready;
      }
      async function settle(ms = 60_000) {
        await vi.advanceTimersByTimeAsync(ms);
        if (!draining) await vi.waitFor(async () => {
          // Finish real SQL before following an armed coalescing/retry deadline.
          // Do not jump across a future business deadline while waiting for I/O.
          if (idleWorkSnapshot().active > 0) {
            await db.execute(sql`select pg_sleep(0.01)`);
            const next = coordinator!.nextWakeAt();
            if (next !== null && next <= Date.now() + 30_000) {
              await vi.advanceTimersByTimeAsync(Math.max(0, next - Date.now()));
            }
          }
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 5000 });
      }
      async function quiet() {
        await settle(); expect(coordinator!.nextWakeAt()).toBeNull();
        const selects = vi.spyOn(db, "select"), executes = vi.spyOn(db, "execute");
        await settle(60 * 60_000);
        expect(selects).not.toHaveBeenCalled(); expect(executes).not.toHaveBeenCalled();
        selects.mockRestore(); executes.mockRestore();
      }
      async function savedClaim(source = db, age = 0) {
        const pending = await request();
        const claimedAt = new Date(Date.now() - age);
        await writeToolReviewChange(source, fixture.company.id, async tx => {
          await tx.update(toolInvocations).set({ status: "executing", startedAt: claimedAt, updatedAt: claimedAt })
            .where(eq(toolInvocations.id, pending.invocationId));
          await tx.update(toolActionRequests).set({ status: "executing", updatedAt: claimedAt })
            .where(eq(toolActionRequests.id, pending.id));
        });
        return { ...pending, updatedAt: claimedAt };
      }
      async function unknown(pending: Awaited<ReturnType<typeof request>>) {
        expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("failed");
        expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0])
          .toMatchObject({ status: "failed", errorCode: "tool_execution_outcome_unknown" });
      }

      it("coalesces sequential review writes into one interruption scan per window", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
        const previous = db.$client.options.debug;
        const scans: string[] = [];
        db.$client.options.debug = (_connection, query) => {
          if (query.includes('from "tool_action_requests"') && query.includes('"updated_at" <=')) scans.push(query);
        };
        try {
          await startInterruption();
          const firstPassAt = Date.now();
          expect(scans).toHaveLength(1);
          for (let i = 0; i < 10; i++) {
            await request();
            await vi.advanceTimersByTimeAsync(1);
            // Let each previous pass finish; overlapping calls already coalesce.
            await db.execute(sql`select pg_sleep(0.01)`);
          }
          expect(scans).toHaveLength(1);
          expect(coordinator!.nextWakeAt()).toBe(firstPassAt + 30_000);
          await vi.advanceTimersByTimeAsync(30_000);
          await vi.waitFor(() => {
            expect(scans).toHaveLength(2);
            expect(idleWorkSnapshot().active).toBe(0);
            expect(coordinator!.nextWakeAt()).toBeNull();
          });
          await quiet();
          expect(scans).toHaveLength(2);
        } finally { db.$client.options.debug = previous; }
      });

      it("keeps a loaded stale-claim deadline ahead of review notification coalescing", async () => {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: false });
        const pending = await savedClaim(db, 10 * 60_000 - 500);
        const deadline = pending.updatedAt.getTime() + 10 * 60_000;
        await startInterruption();
        expect(coordinator!.nextWakeAt()).toBe(deadline);
        await request();
        await vi.advanceTimersByTimeAsync(1);
        await db.execute(sql`select pg_sleep(0.01)`);
        expect(coordinator!.nextWakeAt()).toBe(deadline);
        await vi.advanceTimersByTimeAsync(499);
        await vi.waitFor(async () => { await unknown(pending); });
        expect(Date.now()).toBeLessThan(deadline + 1000);
        await quiet();
      });

      it("arms from a real execution claim and disarms after the provider result", async () => {
        await startInterruption(); await quiet();
        const remote = providerFixture();
        const { pending } = await testRequest(remote.provider);
        const running = gateway.approveActionRequest({ companyId: fixture.company.id,
          actionRequestId: pending.id, actor: { userId: "board" } });
        await Promise.race([remote.started, running]);
        try {
          await settle();
          const [claim] = await db.select().from(toolActionRequests);
          expect(claim.status).toBe("executing");
          expect(coordinator!.nextWakeAt()).toBe(claim.updatedAt.getTime() + 10 * 60_000);
          const reads = vi.spyOn(db, "select");
          await settle(60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        } finally { remote.release(); }
        await running; await quiet();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("executed");
        expect(remote.provider).toHaveBeenCalledTimes(1);
      });

      it("reconstructs the saved deadline and quarantines only when due", async () => {
        const pending = await savedClaim(); await startInterruption();
        expect(coordinator!.nextWakeAt()).toBe(pending.updatedAt.getTime() + 10 * 60_000);
        await settle(9 * 60_000);
        expect((await db.select().from(toolActionRequests))[0].status).toBe("executing");
        await settle(2 * 60_000); await unknown(pending); await quiet();
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toEqual([]);
      });

      it.each(["succeeded", "failed", "denied", "timed_out", "rate_limited", "cancelled"] as const)("preserves a saved %s invocation while repairing the request", async status => {
        const pending = await savedClaim(db, 11 * 60_000);
        const completedAt = new Date(Date.now() - 5 * 60_000);
        await db.update(toolInvocations).set({ status, completedAt, resultSummary: { summary: "Saved provider result" },
          errorCode: status === "succeeded" ? null : "saved_provider_failure" }).where(eq(toolInvocations.id, pending.invocationId));
        await startInterruption(); await quiet();
        expect((await db.select().from(toolActionRequests))[0]).toMatchObject({
          status: status === "succeeded" ? "executed" : "failed", resolvedAt: completedAt });
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({ status, completedAt,
          errorCode: status === "succeeded" ? null : "saved_provider_failure", resultSummary: { summary: "Saved provider result" } });
      });

      it("retains a first claim committed during drain without passive database scans", async () => {
        await startInterruption(); await quiet(); draining = true;
        const pending = await savedClaim(); await settle();
        const reads = vi.spyOn(db, "select");
        await settle(60 * 60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        draining = false; await settle(); await unknown(pending); await quiet();
      });

      it.each([false, true])("waits for outer execution commit (rollback %s)", async rollback => {
        const pending = await request(); await startInterruption(); await quiet();
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const aborted = new Error("fixture rollback");
        const running = db.transaction(async tx => {
          await writeToolReviewChange(tx as unknown as typeof db, fixture.company.id, async nested => {
            await nested.update(toolActionRequests).set({ status: "executing", updatedAt: new Date() })
              .where(eq(toolActionRequests.id, pending.id));
          });
          entered(); await gate; if (rollback) throw aborted;
        }).catch(error => { if (error !== aborted) throw error; });
        await ready;
        try {
          await vi.advanceTimersByTimeAsync(11 * 60_000);
          expect((await db.select().from(toolActionRequests))[0].status).toBe("pending");
        } finally { release(); await running; }
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          if (rollback) expect((await db.select().from(toolActionRequests))[0].status).toBe("pending");
          else await unknown(pending);
          expect(idleWorkSnapshot().active).toBe(0);
        }, { timeout: 5000 });
        await quiet();
      });

      it("rolls back both outcome rows on failure and retries after drain", async () => {
        const pending = await savedClaim(db, 11 * 60_000);
        await db.execute(sql`create function sleep_review_fail() returns trigger language plpgsql as $$
          begin raise exception 'interruption fixture failure'; end $$`);
        await db.execute(sql`create trigger sleep_review_fail before update on tool_invocations
          for each row when (new.error_code = 'tool_execution_outcome_unknown') execute function sleep_review_fail()`);
        await startInterruption(); expect(errors.length).toBeGreaterThan(0); errors.length = 0;
        expect((await db.select().from(toolActionRequests))[0].status).toBe("executing");
        expect((await db.select().from(toolInvocations))[0].status).toBe("executing");
        draining = true;
        await db.execute(sql`drop trigger sleep_review_fail on tool_invocations`);
        await settle(60 * 60_000);
        draining = false;
        await vi.waitFor(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
          await unknown(pending);
        }, { timeout: 5000 });
        await quiet();
      });

      it("rechecks a changed claim after selecting a stale candidate", async () => {
        const pending = await savedClaim(db, 11 * 60_000);
        const transaction = db.transaction.bind(db);
        let entered!: () => void, release!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const intercepted = vi.spyOn(db, "transaction").mockImplementationOnce(async callback => {
          entered(); await gate; return transaction(callback);
        });
        const sweep = gateway.settleInterruptedActionReviews();
        await ready;
        const updatedAt = new Date();
        try {
          await writeToolReviewChange(db, fixture.company.id, tx => tx.update(toolActionRequests).set({ updatedAt })
            .where(eq(toolActionRequests.id, pending.id)));
        } finally { release(); }
        await sweep; intercepted.mockRestore();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("executing");
        await startInterruption();
        expect(coordinator!.nextWakeAt()).toBe(updatedAt.getTime() + 10 * 60_000);
      });

      it("settles more than one page of interrupted claims", async () => {
        const pending = await savedClaim(db, 11 * 60_000);
        await db.insert(toolActionRequests).values(Array.from({ length: 101 }, () => ({ ...pending,
          id: randomUUID(), interactionId: null, status: "executing" as const })));
        await startInterruption(); await quiet();
        const rows = await db.select().from(toolActionRequests);
        expect(rows).toHaveLength(102); expect(rows.every(row => row.status === "failed")).toBe(true);
      });
    });

    describe("approved review recovery worker", () => {
      async function startRecovery() {
        coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !draining,
          canReconcile: () => true, onError: error => errors.push(error) });
        await registerToolReviewRecoveryWork(coordinator, gateway, () => !draining).ready;
      }
      const approve = (pending: Awaited<ReturnType<typeof request>>, source = db) => commitToolActionReview(source, {
        companyId: fixture.company.id, actionRequestId: pending.id, decision: "approved", actor: { userId: "board" },
      });
      async function executed(pending: Awaited<ReturnType<typeof request>>) {
        expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("executed");
        expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0].status).toBe("succeeded");
      }

      it("is quiet while configured idle and executes a committed approval once", async () => {
        await startRecovery(); await quiet();
        const pending = await request(); await approve(pending); await settle();
        await executed(pending); await quiet();
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(1);
      });

      it("does not scan another company's approved backlog after review writes", async () => {
        const other = await createRunFixture(db);
        await db.insert(toolPolicies).values(reviewNotePolicyRow(other.company));
        const foreign = await request(gateway, db, other);
        await db.update(toolActionRequests).set({ signedArguments: signToolArguments({
          invocationId: foreign.invocationId, toolName: "mcp-remote-fixture:update_note",
          canonicalArguments: canonicalToolArguments({ noteId: "legacy", body: "inert" }),
          signingSecret: testToolActionSigningSecret,
        }) }).where(eq(toolActionRequests.id, foreign.id));
        await commitToolActionReview(db, { companyId: other.company.id, actionRequestId: foreign.id,
          decision: "approved", actor: { userId: "board" } });
        await startRecovery(); await quiet();
        const reads: Array<{ query: string; params: unknown[] }> = [];
        const debug = db.$client.options.debug;
        db.$client.options.debug = (_id, query, params) => {
          if (/^select/i.test(query) && query.includes('"tool_action_requests"') &&
            query.includes('"tool_action_requests"."status" =') && params.includes("approved"))
            reads.push({ query, params: [...params] });
        };
        try {
          for (let index = 0; index < 3; index++) {
            const pending = await request(); await settle(1500);
            await approve(pending); await settle(1500); await executed(pending);
          }
        } finally { db.$client.options.debug = debug; }
        expect(reads.length).toBeGreaterThan(0);
        for (const read of reads) {
          expect(read.query).toContain('"tool_action_requests"."company_id" =');
          expect(read.params).toContain(fixture.company.id);
          expect(read.params).not.toContain(other.company.id);
        }
        expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, foreign.id)))[0].status).toBe("approved");
        expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, foreign.invocationId)))[0].status).toBe("awaiting_approval");
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(3);
        await quiet();
      });

      it.each(["foreground", "recovery"] as const)("preserves the admitted rate slot for an agent action through %s approval", async mode => {
        await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: "One reviewed note",
          policyType: "rate_limit", priority: 1, selectors: { toolName: "mcp-remote-fixture:update_note" },
          config: { limit: 1, windowSeconds: 3600, keyBy: ["agent", "tool"] } });
        const pending = await request();
        const counters = await db.select().from(toolRateLimitCounters);
        expect(counters).toHaveLength(1); expect(counters[0].remaining).toBe(0);
        if (mode === "foreground") {
          await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
          await startRecovery();
        } else { await approve(pending); await startRecovery(); }
        await settle(); await executed(pending); await quiet();
        expect(await db.select().from(toolRateLimitCounters)).toEqual(counters);
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(1);
      });

      it.each(["new", "increased"] as const)("spends the newly available slot of a %s rate rule during approved recovery", async change => {
        const rate = { companyId: fixture.company.id, name: "Changed reviewed-note limit",
          policyType: "rate_limit" as const, priority: 1, selectors: { toolName: "mcp-remote-fixture:update_note" },
          config: { limit: 2, windowSeconds: 3600, keyBy: ["agent", "tool"] } };
        const original = change === "increased" ? (await db.insert(toolPolicies).values(rate).returning())[0] : null;
        const first = await request(), second = await request();
        if (original) {
          await db.update(toolPolicies).set({ config: { ...rate.config, limit: 3 }, updatedAt: new Date() })
            .where(eq(toolPolicies.id, original.id));
        } else {
          await db.insert(toolPolicies).values({ ...rate, config: { ...rate.config, limit: 1 } });
        }
        await approve(first); await approve(second);
        await startRecovery(); await settle(); await quiet();
        const requests = await db.select().from(toolActionRequests);
        expect(requests.filter(row => row.status === "executed")).toHaveLength(1);
        expect(requests.filter(row => row.status === "failed")).toHaveLength(1);
        const invocations = await db.select().from(toolInvocations);
        expect(invocations.filter(row => row.errorCode === "rate_limited")).toHaveLength(1);
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(1);
        const counters = await db.select().from(toolRateLimitCounters);
        expect(counters).toHaveLength(1);
        expect(counters[0]).toMatchObject({ limit: change === "increased" ? 3 : 1, remaining: 0 });
      });

      it.each([
        ...["agent", "test-tab"].flatMap(origin => ["valid", "new-rate", "invalid-signature", "foreign-hash", "foreground-rate", "foreground-invalid-signature", "foreground-foreign-hash", "foreground-modern-review-hash"]
          .map(state => ({ origin, state }))),
      ])("recovers historical preview-hash approval ($origin, $state)", async ({ origin, state }) => {
        const remoteCall = providerFixture(); remoteCall.release();
        const parameters = { value: "reviewed", apiKey: "synthetic-historical-approval-key" };
        const foreground = state.startsWith("foreground-");
        if (foreground) await db.insert(toolPolicies).values({ companyId: fixture.company.id,
          name: "Already admitted historical action", policyType: "rate_limit", priority: 1,
          selectors: {}, config: { limit: 1, windowSeconds: 3600, keyBy: ["company", "tool"] } });
        const pending = origin === "agent" ? await agentRequest(remoteCall.provider, parameters)
          : (await testRequest(remoteCall.provider, false, parameters)).pending;
        const [originalInvocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId));
        const payload = readSignedToolArgumentsPayload({ signedArguments: pending.signedArguments,
          invocationId: pending.invocationId, toolName: originalInvocation.toolName, signingSecret: testToolActionSigningSecret })!;
        expect(payload).not.toBeNull();
        const legacyHash = summarizeToolValue(payload.arguments).sha256!;
        const completeHash = toolRequestIdentityHash(payload.arguments, testToolActionSigningSecret);
        expect(legacyHash).not.toBe(completeHash);
        const storedHash = state.endsWith("foreign-hash") ? "e".repeat(64) : legacyHash;
        await db.update(toolInvocations).set({ argumentsHash: storedHash }).where(eq(toolInvocations.id, pending.invocationId));
        await db.update(toolActionRequests).set({ canonicalArgumentsHash: state === "foreground-modern-review-hash" ? completeHash : legacyHash,
          ...(["invalid-signature", "foreground-invalid-signature"].includes(state) ? { signedArguments: "unreadable-old-signature" } : {}),
        }).where(eq(toolActionRequests.id, pending.id));
        if (state === "new-rate") await db.insert(toolPolicies).values({ companyId: fixture.company.id,
          name: "New admission for historical approval", policyType: "rate_limit", priority: 1,
          selectors: {}, config: { limit: 1, windowSeconds: 3600, keyBy: ["company", "tool"] } });
        const counters = foreground ? await db.select().from(toolRateLimitCounters) : [];
        if (foreground) {
          expect(counters).toEqual([expect.objectContaining({ remaining: 0 })]);
          const approval = gateway.approveActionRequest({ companyId: fixture.company.id,
            actionRequestId: pending.id, actor: { userId: "board" } });
          if (state === "foreground-invalid-signature") await expect(approval).rejects.toMatchObject({ reasonCode: "action_request_invalidated" });
          else if (state === "foreground-foreign-hash" && origin === "agent") await expect(approval).rejects.toMatchObject({ reasonCode: "rate_limited" });
          else await approval;
        } else await approve(pending);
        await startRecovery(); await settle();
        if (state === "valid" || state === "new-rate" || state === "foreground-rate" || state === "foreground-modern-review-hash") {
          await executed(pending);
          expect((await db.select().from(toolInvocations))[0].argumentsHash).toBe(completeHash);
          expect(remoteCall.provider).toHaveBeenCalledOnce();
          expect(JSON.parse(String(remoteCall.provider.mock.calls[0][1].body)).params.arguments).toEqual(parameters);
          if (state === "new-rate") expect(await db.select().from(toolRateLimitCounters))
            .toEqual([expect.objectContaining({ limit: 1, remaining: 0 })]);
        } else {
          expect((await db.select().from(toolActionRequests))[0].status)
            .toBe(["invalid-signature", "foreground-invalid-signature"].includes(state) ? "cancelled"
              : state === "foreground-foreign-hash" && origin === "agent" ? "pending" : "failed");
          expect((await db.select().from(toolInvocations))[0].argumentsHash).toBe(storedHash);
          expect(remoteCall.provider).not.toHaveBeenCalled();
        }
        if (foreground) expect(await db.select().from(toolRateLimitCounters)).toEqual(counters);
        await quiet();
      });

      it("does not rebind historical arguments after the execution claim is replaced", async () => {
        const remoteCall = providerFixture(); remoteCall.release();
        const pending = await agentRequest(remoteCall.provider, { value: "reviewed", apiKey: "synthetic-stale-claim-key" });
        const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId));
        const payload = readSignedToolArgumentsPayload({ signedArguments: pending.signedArguments,
          invocationId: invocation.id, toolName: invocation.toolName, signingSecret: testToolActionSigningSecret })!;
        const preview = summarizeToolValue(payload.arguments).sha256;
        const verified = toolRequestIdentityHash(payload.arguments, testToolActionSigningSecret);
        await db.update(toolInvocations).set({ argumentsHash: preview }).where(eq(toolInvocations.id, invocation.id));
        await db.update(toolActionRequests).set({ canonicalArgumentsHash: preview }).where(eq(toolActionRequests.id, pending.id));
        await approve(pending);
        const claim = (await claimToolTestApproval(db, pending.id, invocation.id))!;
        expect(claim).not.toBeNull();
        await db.update(toolActionRequests).set({ updatedAt: new Date(claim.claimedAt.getTime() + 1) })
          .where(eq(toolActionRequests.id, pending.id));
        expect(await bindVerifiedToolApprovalArguments(db, claim, { preview, verified })).toBe(false);
        expect((await db.select().from(toolInvocations))[0].argumentsHash).toBe(preview);
        expect(remoteCall.provider).not.toHaveBeenCalled();
      });

      it("reconstructs a saved approved action after restart", async () => {
        const pending = await request(); await approve(pending);
        await startRecovery(); await settle(); await executed(pending); await quiet();
      });

      it("retries a failed approval dispatch only while the approved action remains unresolved", async () => {
        const pending = await request(); await approve(pending);
        const recover = vi.spyOn(gateway, "approveActionRequest").mockRejectedValue(new Error("Recovery dependency unavailable"));
        await startRecovery();
        expect(recover).toHaveBeenCalledTimes(1); expect(coordinator!.nextWakeAt()).not.toBeNull();
        await settle(10_000); expect(recover).toHaveBeenCalledTimes(1);
        recover.mockRestore(); await settle(); await executed(pending); await quiet();
      });

      it("preserves a failed company's retry across writes while another company executes", async () => {
        const pending = await request(); await approve(pending);
        const original = gateway.approveActionRequest.bind(gateway);
        const dispatch = vi.spyOn(gateway, "approveActionRequest").mockImplementation(async input => {
          if (input.companyId === fixture.company.id) throw new Error("Company dependency unavailable");
          return original(input);
        });
        await startRecovery();
        expect(dispatch).toHaveBeenCalledTimes(1);
        const retryAt = coordinator!.nextWakeAt();
        expect(retryAt).not.toBeNull();
        const later = await request(); await approve(later);
        const other = await createRunFixture(db);
        await db.insert(toolPolicies).values(reviewNotePolicyRow(other.company));
        const foreign = await request(gateway, db, other);
        await commitToolActionReview(db, { companyId: other.company.id, actionRequestId: foreign.id,
          decision: "approved", actor: { userId: "board" } });
        await settle(5000); await executed(foreign);
        expect(dispatch.mock.calls.filter(([input]) => input.companyId === fixture.company.id)).toHaveLength(1);
        expect(coordinator!.nextWakeAt()).toBe(retryAt);
        dispatch.mockRestore();
        await settle(); await executed(pending); await executed(later); await quiet();
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(3);
      });

      it("disarms a failed company's recovery after company deletion commits", async () => {
        const pending = await request(); await approve(pending);
        const dispatch = vi.spyOn(gateway, "approveActionRequest").mockRejectedValue(new Error("Company dependency unavailable"));
        await startRecovery(); expect(coordinator!.nextWakeAt()).not.toBeNull();
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, fixture.run.id));
        await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" })
          .where(eq(agents.id, fixture.agent.id));
        await deleteCompany(db, fixture.company.id);
        await settle(1500);
        expect(coordinator!.nextWakeAt()).toBeNull();
        expect(dispatch).toHaveBeenCalledTimes(1); await quiet();
      });

      it.each([null, "unreadable-old-signature"])("settles an approved invalid signature (%s) without recurring recovery", async signedArguments => {
        const pending = await request(); await approve(pending);
        await db.update(toolActionRequests).set({ signedArguments }).where(eq(toolActionRequests.id, pending.id));
        const dispatch = vi.spyOn(gateway, "approveActionRequest");
        await startRecovery(); await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("cancelled");
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({
          status: "failed", errorCode: "action_request_invalidated",
        });
        expect(dispatch).not.toHaveBeenCalled(); await quiet();
      });

      it.each(["rejected", "cancelled"])("settles a %s formal approval without recurring recovery", async status => {
        const pending = await request(); await approve(pending);
        const [formal] = await db.insert(approvals).values({ companyId: fixture.company.id,
          type: "request_board_approval", status, payload: {} }).returning();
        await db.update(toolActionRequests).set({ approvalId: formal.id }).where(eq(toolActionRequests.id, pending.id));
        const dispatch = vi.spyOn(gateway, "approveActionRequest");
        await startRecovery(); await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("cancelled");
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({
          status: "denied", errorCode: "formal_approval_unavailable",
        });
        expect(dispatch).not.toHaveBeenCalled(); await quiet();
      });

      it.each([false, true])("parks a formal approval until its decision commits (rollback %s)", async rollback => {
        const pending = await request(); await approve(pending);
        const [formal] = await db.insert(approvals).values({ companyId: fixture.company.id,
          type: "request_board_approval", status: "pending", payload: {} }).returning();
        await db.update(toolActionRequests).set({ approvalId: formal.id }).where(eq(toolActionRequests.id, pending.id));
        await startRecovery(); await quiet();
        let release!: () => void, staged!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { staged = resolve; });
        const aborted = new Error("formal approval rollback fixture");
        const writing = db.transaction(async tx => {
          await approvalService(tx as unknown as typeof db).approve(formal.id, "board");
          staged(); await gate; if (rollback) throw aborted;
        }).catch(error => { if (error !== aborted) throw error; });
        await Promise.race([ready, writing]);
        try {
          await vi.advanceTimersByTimeAsync(60_000);
          expect((await db.select().from(toolActionRequests))[0].status).toBe("approved");
          expect((await db.select().from(toolInvocations))[0].status).toBe("awaiting_approval");
        } finally { release(); }
        await writing; await settle();
        if (rollback) {
          expect((await db.select().from(toolActionRequests))[0].status).toBe("approved"); await quiet();
          await approvalService(db).approve(formal.id, "board"); await settle();
        }
        await executed(pending); await quiet();
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(1);
      });

      it.each(["reject", "cancel"] as const)("wakes a parked revision-requested formal approval on %s", async decision => {
        const pending = await request(); await approve(pending);
        const [formal] = await db.insert(approvals).values({ companyId: fixture.company.id,
          type: "request_board_approval", status: "revision_requested", payload: {} }).returning();
        await db.update(toolActionRequests).set({ approvalId: formal.id }).where(eq(toolActionRequests.id, pending.id));
        await startRecovery(); await quiet();
        const service = approvalService(db);
        if (decision === "cancel") await service.cancel(formal.id, "Cancelled by user");
        else await service.reject(formal.id, "board");
        await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("cancelled");
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({ status: "denied", errorCode: "formal_approval_unavailable" });
        await quiet();
      });

      it("retains approved work when the signing key is temporarily unavailable", async () => {
        const pending = await request(); await approve(pending);
        vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "");
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "invalid-master-key");
        gateway = createToolGatewayService(db);
        await startRecovery();
        expect(coordinator!.nextWakeAt()).not.toBeNull();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("approved");
        expect((await db.select().from(toolInvocations))[0].status).toBe("awaiting_approval");
        vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", testToolActionSigningSecret);
        await settle(); await executed(pending); await quiet();
      });

      it("does not accept another company's formal approval", async () => {
        const pending = await request(); await approve(pending);
        const other = await createRunFixture(db);
        const [formal] = await db.insert(approvals).values({ companyId: other.company.id,
          type: "request_board_approval", status: "approved", payload: {} }).returning();
        await db.update(toolActionRequests).set({ approvalId: formal.id }).where(eq(toolActionRequests.id, pending.id));
        await startRecovery(); await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("cancelled");
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({ status: "denied", errorCode: "formal_approval_unavailable" });
        expect((await db.select().from(approvals))[0]).toEqual(formal);
        await quiet();
      });

      it("quarantines a mismatched request without modifying another company's invocation", async () => {
        const pending = await request(); await approve(pending);
        const [invocation] = await db.select().from(toolInvocations);
        const other = await createRunFixture(db);
        await db.update(toolActionRequests).set({ companyId: other.company.id }).where(eq(toolActionRequests.id, pending.id));
        await startRecovery(); await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("failed");
        expect((await db.select().from(toolInvocations))[0]).toEqual(invocation);
        await quiet();
      });

      it("repairs completed agent history without executing the action again", async () => {
        const pending = await request();
        await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
        await executed(pending);
        const [invocation] = await db.select().from(toolInvocations);
        await db.update(toolActionRequests).set({ status: "approved", signedArguments: "unreadable-old-signature" })
          .where(eq(toolActionRequests.id, pending.id));
        await startRecovery(); await settle(); await executed(pending); await quiet();
        expect((await db.select().from(toolInvocations))[0]).toEqual(invocation);
        expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(1);
      });

      it("keeps deliberately inert legacy approvals quiet", async () => {
        const pending = await request();
        await db.update(toolActionRequests).set({ signedArguments: signToolArguments({
          invocationId: pending.invocationId, toolName: "mcp-remote-fixture:update_note",
          canonicalArguments: canonicalToolArguments({ noteId: "legacy", body: "inert" }),
          signingSecret: testToolActionSigningSecret,
        }) }).where(eq(toolActionRequests.id, pending.id));
        await approve(pending); await startRecovery(); await quiet();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("approved");
        expect((await db.select().from(toolInvocations))[0].status).toBe("awaiting_approval");
      });

      it.each([false, true])("waits for the outer approval transaction (rollback %s)", async rollback => {
        await startRecovery(); const pending = await request();
        let release!: () => void, staged!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { staged = resolve; });
        const aborted = new Error("approval rollback fixture");
        const writing = db.transaction(async tx => {
          await approve(pending, tx as unknown as typeof db); staged(); await gate;
          if (rollback) throw aborted;
        }).catch(error => { if (error !== aborted) throw error; });
        await Promise.race([ready, writing]);
        try {
          await vi.advanceTimersByTimeAsync(60_000);
          expect((await db.select().from(toolActionRequests))[0].status).toBe("pending");
        } finally { release(); }
        await writing; await settle();
        if (rollback) expect((await db.select().from(toolActionRequests))[0].status).toBe("pending");
        else await executed(pending);
        await quiet();
      });

      it("retains the first approval during drain without passive queries", async () => {
        await startRecovery(); await quiet(); draining = true;
        const pending = await request(); await approve(pending); await settle();
        const reads = vi.spyOn(db, "select");
        await settle(60 * 60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
        draining = false; await settle(); await executed(pending); await quiet();
      });

      async function testRequest(provider: NonNullable<ToolGatewayServiceOptions["remoteHttpRequest"]>, rateLimited = false, parameters: Record<string, unknown> = { value: "reviewed" }) {
        await db.insert(companyMemberships).values({ companyId: fixture.company.id, principalType: "user",
          principalId: "board", status: "active", membershipRole: "owner" });
        const remote = await createRemoteMcpToolFixture(db, fixture.company.id);
        await db.update(toolCatalogEntries).set({ isReadOnly: false, riskLevel: "write" })
          .where(eq(toolCatalogEntries.id, remote.catalogEntry.id));
        await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: "Review connected writes",
          policyType: "require_approval", priority: 10, selectors: { connectionId: remote.connection.id } });
        if (rateLimited) await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: "One reviewed test call",
          policyType: "rate_limit", priority: 1, selectors: { connectionId: remote.connection.id },
          config: { limit: 1, windowSeconds: 3600, keyBy: ["agent", "tool"] } });
        gateway = createTestToolGatewayService(db, { remoteHttpRequest: provider });
        const result = await gateway.executeTestCall({ companyId: fixture.company.id, connectionId: remote.connection.id,
          agentId: fixture.agent.id, userId: "board", toolName: "needs_input", parameters });
        expect(result.decision).toBe("ask_first");
        const [pending] = await db.select().from(toolActionRequests);
        return { pending, remote };
      }
      function providerFixture() {
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const provider = vi.fn(async (_url: string, init: RequestInit) => {
          const payload = JSON.parse(String(init.body));
          expect(payload.method).toBe("tools/call");
          entered(); await gate;
          return Response.json({ jsonrpc: "2.0", id: payload.id,
            result: { content: [{ type: "text", text: "Saved once" }] } });
        });
        return { provider, release, started };
      }

      it.each(["foreground", "recovery"] as const)("retries a Test-tab %s approval after a real pre-dispatch database timeout", async mode => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider); await approve(pending);
        const preparationDb = createDb(h.connectionString, {
          maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0,
        });
        const preparingGateway = createTestToolGatewayService(preparationDb, { remoteHttpRequest: remoteCall.provider });
        let unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>(resolve => { unlock = resolve; });
        const acquired = new Promise<void>(resolve => { locked = resolve; });
        const lock = db.transaction(async tx => {
          await tx.execute(sql`lock table tool_policies in access exclusive mode`);
          locked(); await gate;
        });
        await acquired;
        try {
          await preparationDb.execute(sql`set lock_timeout = '2s'`);
          const attempting = mode === "foreground"
            ? preparingGateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } })
            : preparingGateway.recoverApprovedActionReviews(fixture.company.id);
          // Observe the real committed claim while its subsequent policy read
          // is blocked. Provider execution has not started.
          void attempting.catch(() => undefined);
          await vi.waitFor(async () => {
            expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("executing");
          });
          if (mode === "foreground") await expect(attempting).rejects.toMatchObject({ cause: { code: "55P03" } });
          else expect(await attempting).toEqual({ scanned: 1, retry: true });
          expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0])
            .toMatchObject({ status: "approved", signedArguments: pending.signedArguments });
          expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0])
            .toMatchObject({ status: "awaiting_approval", startedAt: null });
          expect(remoteCall.provider).not.toHaveBeenCalled();
        } finally { unlock(); await lock; await preparationDb.$client.end({ timeout: 1 }); }
        await startRecovery(); await settle(); await executed(pending); await quiet();
        expect(remoteCall.provider).toHaveBeenCalledOnce();
      }, 15_000);

      async function agentRequest(provider: NonNullable<ToolGatewayServiceOptions["remoteHttpRequest"]>, parameters: Record<string, unknown> = { value: "reviewed" }) {
        const remote = await createRemoteMcpToolFixture(db, fixture.company.id);
        await db.update(toolCatalogEntries).set({ isReadOnly: false, riskLevel: "write" })
          .where(eq(toolCatalogEntries.id, remote.catalogEntry.id));
        await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: "Review agent writes",
          policyType: "require_approval", selectors: { connectionId: remote.connection.id } });
        gateway = createTestToolGatewayService(db, { remoteHttpRequest: provider });
        const session = await gateway.createSession(runSessionInput(fixture.company, fixture.agent, fixture.run));
        const tool = (await gateway.listToolsForSession(session.token)).find(t => t.connectionId === remote.connection.id)!;
        await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters }))
          .rejects.toMatchObject({ reasonCode: "approval_required" });
        const [pending] = await db.select().from(toolActionRequests);
        return pending;
      }

      it.each(["foreground", "recovery"] as const)("retries an agent-origin %s approval after a real pre-dispatch database timeout", async mode => {
        const remoteCall = providerFixture(); remoteCall.release();
        const pending = await agentRequest(remoteCall.provider); await approve(pending);
        const preparationDb = createDb(h.connectionString, {
          maxConnections: 1, idleTimeoutSeconds: 0, maxLifetimeSeconds: 0,
        });
        const preparingGateway = createTestToolGatewayService(preparationDb, { remoteHttpRequest: remoteCall.provider });
        let unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>(resolve => { unlock = resolve; });
        const acquired = new Promise<void>(resolve => { locked = resolve; });
        const lock = db.transaction(async tx => {
          await tx.execute(sql`lock table tool_policies in access exclusive mode`);
          locked(); await gate;
        });
        await acquired;
        try {
          await preparationDb.execute(sql`set lock_timeout = '2s'`);
          const attempting = mode === "foreground"
            ? preparingGateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } })
            : preparingGateway.recoverApprovedActionReviews(fixture.company.id);
          // Observe the real committed claim while its subsequent policy read
          // is blocked. Provider execution has not started.
          void attempting.catch(() => undefined);
          await vi.waitFor(async () => {
            expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("executing");
          });
          if (mode === "foreground") expect(await attempting).toMatchObject({ status: "approved" });
          else expect(await attempting).toEqual({ scanned: 1, retry: true });
          expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0])
            .toMatchObject({ status: "approved", signedArguments: pending.signedArguments });
          expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0])
            .toMatchObject({ status: "awaiting_approval", startedAt: null });
          expect(remoteCall.provider).not.toHaveBeenCalled();
        } finally { unlock(); await lock; await preparationDb.$client.end({ timeout: 1 }); }
        await startRecovery(); await settle(); await executed(pending); await quiet();
        expect(remoteCall.provider).toHaveBeenCalledOnce();
      }, 15_000);

      it("refuses agent dispatch after preparation loses its claim", async () => {
        const remoteCall = providerFixture(); remoteCall.release();
        const pending = await agentRequest(remoteCall.provider); await approve(pending);
        let unlock!: () => void, locked!: () => void;
        const gate = new Promise<void>(resolve => { unlock = resolve; });
        const acquired = new Promise<void>(resolve => { locked = resolve; });
        const lock = db.transaction(async tx => {
          // Pause tool discovery before admission locks the invocation. Revocation
          // cannot legitimately take that lock from an in-flight admission.
          await tx.execute(sql`lock table tool_catalog_entries in access exclusive mode`);
          locked(); await gate;
        });
        await acquired;
        const attempting = gateway.approveActionRequest({ companyId: fixture.company.id,
          actionRequestId: pending.id, actor: { userId: "board" } });
        void attempting.catch(() => undefined);
        let successor!: NonNullable<Awaited<ReturnType<typeof claimToolTestApproval>>>;
        try {
          await vi.waitFor(async () => {
            expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("executing");
          });
          const [claimed] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id));
          expect(await releaseToolApproval(db, { actionRequestId: pending.id,
            invocationId: pending.invocationId, claimedAt: claimed.updatedAt })).toBe(true);
          await vi.advanceTimersByTimeAsync(10);
          successor = (await claimToolTestApproval(db, pending.id, pending.invocationId))!;
          expect(successor).not.toBeNull();
          expect(successor.claimedAt.getTime()).toBeGreaterThan(claimed.updatedAt.getTime());
        } finally { unlock(); await lock; }
        expect(await attempting).toMatchObject({ status: "executing" });
        expect(remoteCall.provider).not.toHaveBeenCalled();
        expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0])
          .toMatchObject({ status: "awaiting_approval", startedAt: null });
        expect(await releaseToolApproval(db, successor)).toBe(true);
        await startRecovery(); await settle(); await executed(pending); await quiet();
        expect(remoteCall.provider).toHaveBeenCalledOnce();
      });

      it("does not retry an agent provider error as a preparation failure", async () => {
        const provider = vi.fn(async () => { throw new Error("Provider outcome is unknown"); });
        const pending = await agentRequest(provider); await approve(pending);
        await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
        expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("failed");
        expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0].startedAt).not.toBeNull();
        await startRecovery(); await quiet();
        expect(provider).toHaveBeenCalledOnce();
      });

      it.each(["started", "reclaimed", "mismatched", "prior_dispatch"] as const)("refuses to release a Test-tab preparation claim with %s ownership evidence", async state => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider); await approve(pending);
        const claim = await claimToolTestApproval(db, pending.id, pending.invocationId);
        expect(claim).not.toBeNull();
        if (state === "started") expect(await startToolInvocation(db, pending.invocationId, claim!)).toBe(true);
        if (state === "reclaimed") await db.update(toolActionRequests)
          .set({ updatedAt: new Date(claim!.claimedAt.getTime() + 1000) }).where(eq(toolActionRequests.id, pending.id));
        if (state === "prior_dispatch") await db.update(toolInvocations)
          .set({ startedAt: new Date() }).where(eq(toolInvocations.id, pending.invocationId));
        const beforeRequest = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0];
        const beforeInvocation = (await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0];
        expect(await releaseToolApproval(db, state === "mismatched" ? { ...claim!, invocationId: randomUUID() } : claim!)).toBe(false);
        expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0]).toEqual(beforeRequest);
        expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0]).toEqual(beforeInvocation);
        expect(remoteCall.provider).not.toHaveBeenCalled();
      });

      it("rolls a Test-tab preparation release back with its transaction and invalidates the released claim", async () => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider); await approve(pending);
        const claim = await claimToolTestApproval(db, pending.id, pending.invocationId);
        expect(claim).not.toBeNull();
        await expect(db.transaction(async tx => {
          expect(await releaseToolApproval(tx as unknown as typeof db, claim!)).toBe(true);
          throw new Error("release rollback");
        })).rejects.toThrow("release rollback");
        expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("executing");
        expect(await releaseToolApproval(db, claim!)).toBe(true);
        expect(await startToolInvocation(db, pending.invocationId, claim!)).toBe(false);
        await startRecovery(); await settle(); await executed(pending); await quiet();
        expect(remoteCall.provider).toHaveBeenCalledOnce();
      });

      it.each(["foreground", "recovery"] as const)("claims a Test-tab action once when %s wins", async winner => {
        const remoteCall = providerFixture();
        const { pending } = await testRequest(remoteCall.provider);
        let running: Promise<unknown>;
        if (winner === "foreground") {
          await startRecovery();
          running = gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
        } else {
          await approve(pending);
          running = startRecovery();
        }
        await Promise.race([remoteCall.started, running]);
        try {
          await vi.advanceTimersByTimeAsync(60_000);
          await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
          expect(remoteCall.provider).toHaveBeenCalledTimes(1);
        } finally { remoteCall.release(); }
        await running; await settle(); await executed(pending); await quiet();
        expect(remoteCall.provider).toHaveBeenCalledTimes(1);
      });

      it.each(["foreground", "recovery"] as const)("preserves the admitted rate slot for a Test-tab action through %s approval", async mode => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider, true);
        const counters = await db.select().from(toolRateLimitCounters);
        expect(counters).toHaveLength(1); expect(counters[0].remaining).toBe(0);
        if (mode === "foreground") {
          await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
          await startRecovery();
        } else { await approve(pending); await startRecovery(); }
        await settle(); await executed(pending); await quiet();
        expect(await db.select().from(toolRateLimitCounters)).toEqual(counters);
        expect(remoteCall.provider).toHaveBeenCalledOnce();
      });

      it("repairs completed Test-tab history without sending the request again", async () => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider);
        await gateway.approveActionRequest({ companyId: fixture.company.id, actionRequestId: pending.id, actor: { userId: "board" } });
        await executed(pending);
        await db.update(toolActionRequests).set({ status: "approved", signedArguments: "unreadable-old-signature" })
          .where(eq(toolActionRequests.id, pending.id));
        remoteCall.provider.mockClear();
        await startRecovery(); await settle(); await executed(pending); await quiet();
        expect(remoteCall.provider).not.toHaveBeenCalled();
      });

      it.each(["pending", "authorized", "cancelled"] as const)("settles inconsistent Test-tab %s history without replay", async status => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider); await approve(pending);
        await db.update(toolInvocations).set({ status }).where(eq(toolInvocations.id, pending.invocationId));
        await startRecovery(); await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe(status === "cancelled" ? "cancelled" : "failed");
        expect((await db.select().from(toolInvocations))[0]).toMatchObject(status === "cancelled"
          ? { status: "cancelled" }
          : { status: "failed", errorCode: "tool_recovery_state_invalid" });
        await quiet(); expect(remoteCall.provider).not.toHaveBeenCalled();
      });

      it("does not replay an interrupted legacy Test-tab invocation", async () => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider);
        await approve(pending);
        await db.update(toolInvocations).set({ status: "executing", startedAt: new Date(Date.now() - 11 * 60_000) })
          .where(eq(toolInvocations.id, pending.invocationId));
        await startRecovery(); await settle();
        expect((await db.select().from(toolActionRequests))[0].status).toBe("executing");
        await gateway.sweepActionReviews({ includeApproved: false, includeExpiry: false });
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({ status: "failed", errorCode: "tool_execution_outcome_unknown" });
        await quiet(); expect(remoteCall.provider).not.toHaveBeenCalled();
      });

      it.each(["always", "once"])("does not replay a Test-tab call when persisting its external result fails %s", async mode => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending } = await testRequest(remoteCall.provider);
        await approve(pending);
        await db.execute(sql`create sequence sleep_review_failure_attempt`);
        await db.execute(sql.raw(`create function sleep_review_fail() returns trigger language plpgsql as $$
          begin
            if ${mode === "always" ? "true" : "nextval('sleep_review_failure_attempt') = 1"} then
              raise exception 'approval result fixture failure';
            end if;
            return new;
          end $$`));
        await db.execute(sql`create trigger sleep_review_fail before update on tool_action_requests
          for each row when (new.status in ('executed', 'failed')) execute function sleep_review_fail()`);
        try {
          await startRecovery();
          expect((await db.select().from(toolActionRequests))[0].status).toBe("executing");
          expect((await db.select().from(toolInvocations))[0].status).toBe("executing");
          expect(remoteCall.provider).toHaveBeenCalledTimes(1);
        } finally {
          await db.execute(sql`drop trigger sleep_review_fail on tool_action_requests`);
        }
        await settle();
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        await gateway.sweepActionReviews({ includeApproved: false, includeExpiry: false });
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({ status: "failed", errorCode: "tool_execution_outcome_unknown" });
        await quiet(); expect(remoteCall.provider).toHaveBeenCalledTimes(1);
      });

      it("revalidates the reviewed Test-tab target before recovery dispatch", async () => {
        const remoteCall = providerFixture(); remoteCall.release();
        const { pending, remote } = await testRequest(remoteCall.provider);
        await approve(pending);
        await db.update(toolCatalogEntries).set({ versionHash: "changed-after-review" }).where(eq(toolCatalogEntries.id, remote.catalogEntry.id));
        await startRecovery(); await settle();
        expect((await db.select().from(toolInvocations))[0]).toMatchObject({ status: "failed", errorCode: "approved_tool_target_changed" });
        await quiet(); expect(remoteCall.provider).not.toHaveBeenCalled();
      });
    });

    async function requestWithExpiry(expiresAt: Date, context = fixture) {
      return db.transaction(async tx => {
        const source = tx as unknown as typeof db;
        const pending = await request(createTestToolGatewayService(source), source, context);
        const [saved] = await tx.update(toolActionRequests).set({ expiresAt })
          .where(eq(toolActionRequests.id, pending.id)).returning();
        return saved;
      });
    }

    it("keeps signing and human resolution reads scoped to their company", async () => {
      const other = await createRunFixture(db);
      await db.insert(toolPolicies).values(reviewNotePolicyRow(other.company));
      const foreign = await request(gateway, db, other);
      await start(); await settle(1);
      const reads: Array<{ query: string; params: unknown[] }> = [];
      const debug = db.$client.options.debug;
      db.$client.options.debug = (_id, query, params) => {
        if (/^select/i.test(query) && query.includes('"tool_action_requests"') &&
          (query.includes('min(') || query.includes('"expires_at" <=') || query.includes('"expires_at" is not null'))) reads.push({ query, params: [...params] });
      };
      try {
        for (let index = 0; index < 3; index++) {
          const pending = await request(); await settle(1000);
          await commitToolActionReview(db, { companyId: fixture.company.id, actionRequestId: pending.id,
            decision: "rejected", actor: { userId: "reviewer" } });
          await settle(1000);
        }
      } finally { db.$client.options.debug = debug; }
      expect(reads.length).toBeGreaterThan(0);
      for (const read of reads) {
        expect(read.query).toContain('"tool_action_requests"."company_id" =');
        expect(read.params).toContain(fixture.company.id);
        expect(read.params).not.toContain(other.company.id);
      }
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, foreign.id)))[0].status).toBe("pending");
      expect(coordinator!.nextWakeAt()).toBe(foreign.expiresAt!.getTime());
    });

    it("reads one indexed deadline from a large company backlog on repeated reloads", async () => {
      const pending = await request();
      const foreignContext = await createRunFixture(db);
      await db.insert(toolPolicies).values(reviewNotePolicyRow(foreignContext.company));
      const foreign = await requestWithExpiry(new Date(Date.now() + 1000), foreignContext);
      await db.execute(sql`insert into tool_action_requests
        (company_id, invocation_id, canonical_arguments_hash, canonical_arguments_summary, expires_at)
        select ${fixture.company.id}, ${pending.invocationId}, 'backlog', '{}'::jsonb,
          ${pending.expiresAt!.toISOString()}::timestamptz + n * interval '1 second'
        from generate_series(1, 12000) n`);
      await db.execute(sql`insert into tool_action_requests
        (company_id, invocation_id, canonical_arguments_hash, canonical_arguments_summary, expires_at)
        select ${foreignContext.company.id}, ${foreign.invocationId}, 'foreign backlog', '{}'::jsonb,
          ${foreign.expiresAt!.toISOString()}::timestamptz - n * interval '1 second'
        from generate_series(1, 12000) n`);
      await db.insert(toolActionRequests).values([
        { ...pending, id: randomUUID(), interactionId: null, expiresAt: null },
        { ...pending, id: randomUUID(), interactionId: null, status: "rejected", expiresAt: new Date(0) },
      ]);
      await db.execute(sql`analyze tool_action_requests`);
      const reads: Array<{ query: string; params: unknown[] }> = [];
      const debug = db.$client.options.debug;
      db.$client.options.debug = (_id, query, params) => {
        if (/^select/i.test(query) && query.includes('"tool_action_requests"')) reads.push({ query, params: [...params] });
      };
      try {
        for (let i = 0; i < 3; i++) {
          expect(await gateway.actionReviewExpiryDeadlines(fixture.company.id)).toEqual([
            { companyId: fixture.company.id, dueAt: pending.expiresAt!.getTime() },
          ]);
        }
      } finally { db.$client.options.debug = debug; }
      expect(reads).toHaveLength(3);
      type Plan = { "Node Type": string; "Actual Rows": number; "Actual Loops": number;
        "Rows Removed by Filter"?: number; "Rows Removed by Index Recheck"?: number; Plans?: Plan[] };
      const scannedRows = (plan: Plan): number =>
        (/Scan/.test(plan["Node Type"]) ? (plan["Actual Rows"] + (plan["Rows Removed by Filter"] ?? 0)
          + (plan["Rows Removed by Index Recheck"] ?? 0)) * plan["Actual Loops"] : 0)
        + (plan.Plans ?? []).reduce((count, child) => count + scannedRows(child), 0);
      for (const read of reads) {
        const [result] = await db.$client.unsafe(
          `explain (analyze, buffers, format json) ${read.query}`,
          read.params as Parameters<typeof db.$client.unsafe>[1],
        );
        const plan = result["QUERY PLAN"][0].Plan as Plan;
        expect(scannedRows(plan), JSON.stringify(plan)).toBeLessThanOrEqual(1);
      }
      expect(await gateway.actionReviewExpiryDeadlines(randomUUID())).toEqual([]);
      expect(await gateway.actionReviewExpiryDeadlines()).toEqual(expect.arrayContaining([
        { companyId: fixture.company.id, dueAt: pending.expiresAt!.getTime() },
        { companyId: foreignContext.company.id, dueAt: foreign.expiresAt!.getTime() - 12_000_000 },
      ]));
    });

    it("preserves a five-second deadline and an earlier committed replacement", async () => {
      await start(); await quiet();
      const later = await requestWithExpiry(new Date(Date.now() + 120_000)); await settle(1);
      expect(coordinator!.nextWakeAt()).toBe(later.expiresAt!.getTime());
      const earlier = await requestWithExpiry(new Date(Date.now() + 5000)); await settle(1);
      expect(coordinator!.nextWakeAt()).toBe(earlier.expiresAt!.getTime());
      await settle(6000); await expectExpired(earlier.id, earlier.invocationId);
      expect(coordinator!.nextWakeAt()).toBe(later.expiresAt!.getTime());
      await settle(120_000); await expectExpired(later.id, later.invocationId); await quiet();
    });

    it("limits due expiry reads to the company whose deadline arrived", async () => {
      const other = await createRunFixture(db);
      await db.insert(toolPolicies).values(reviewNotePolicyRow(other.company));
      const foreign = await request(gateway, db, other);
      const due = await requestWithExpiry(new Date(Date.now() + 5000));
      await start(); await settle(1);
      const reads: Array<{ query: string; params: unknown[] }> = [];
      const debug = db.$client.options.debug;
      db.$client.options.debug = (_id, query, params) => {
        if (/^select/i.test(query) && query.includes('"tool_action_requests"') &&
          (query.includes('min(') || query.includes('"expires_at" <=') || query.includes('"expires_at" is not null'))) reads.push({ query, params: [...params] });
      };
      try { await settle(6000); } finally { db.$client.options.debug = debug; }
      expect(reads.some(read => read.query.includes('"expires_at" <='))).toBe(true);
      expect(reads.some(read => read.query.includes('"expires_at" is not null'))).toBe(true);
      for (const read of reads) {
        expect(read.query).toContain('"tool_action_requests"."company_id" =');
        expect(read.params).toContain(fixture.company.id);
        expect(read.params).not.toContain(other.company.id);
      }
      await expectExpired(due.id, due.invocationId);
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, foreign.id)))[0].status).toBe("pending");
      expect(coordinator!.nextWakeAt()).toBe(foreign.expiresAt!.getTime());
    });

    it("removes cached review deadlines after company deletion commits", async () => {
      await request(); await start(); await settle(1);
      expect(coordinator!.nextWakeAt()).not.toBeNull();
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, fixture.run.id));
      await db.update(agents).set({ status: "terminated", lifecycleState: "terminated" })
        .where(eq(agents.id, fixture.agent.id));
      expect(await deleteCompany(db, fixture.company.id)).toMatchObject({ id: fixture.company.id });
      await quiet();
      expect(await gateway.actionReviewExpiryDeadlines()).toEqual([]);
    });

    it("is quiet when configured idle, wakes on signing, expires the review and card, then stays quiet with history", async () => {
      await start(); await quiet();
      const pending = await request();
      await settle(); expect(coordinator!.nextWakeAt()).toBe(pending.expiresAt!.getTime());
      const reads = vi.spyOn(db, "select");
      await settle(5 * 60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
      await settle(60 * 60_000);
      await expectExpired(pending.id, pending.invocationId);
      expect((await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!)))[0].status).toBe("expired");
      await quiet();
    });

    it.each(["approved", "rejected"] as const)("disarms when a human resolves the last review as %s", async decision => {
      await start(); const pending = await request(); await settle();
      await commitToolActionReview(db, { companyId: fixture.company.id, actionRequestId: pending.id,
        decision, actor: { userId: "reviewer" } });
      await quiet();
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe(decision);
    });

    it.each([false, true])("observes outer transaction settlement (rollback %s)", async rollback => {
      await start(); await quiet();
      let release!: () => void, staged!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { staged = resolve; });
      const aborted = new Error("rollback fixture");
      const writing = db.transaction(async tx => {
        const scoped = tx as unknown as typeof db;
        await request(createTestToolGatewayService(scoped), scoped);
        staged(); await gate;
        if (rollback) throw aborted;
      }).catch(error => { if (error !== aborted) throw error; });
      await Promise.race([ready, writing]);
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await db.select().from(toolActionRequests)).toEqual([]);
      } finally { release(); }
      await writing; await settle();
      if (rollback) await quiet();
      else {
        expect(coordinator!.nextWakeAt()).toBe(await gateway.nextActionReviewExpiryAt());
        await settle(60 * 60_000); await quiet();
      }
    });

    it("reconstructs saved expiry on restart", async () => {
      const pending = await request();
      await start(); await settle();
      expect(coordinator!.nextWakeAt()).toBe(pending.expiresAt!.getTime());
      await coordinator!.stop(); coordinator = undefined;
      await settle(60 * 60_000);
      await start(); await settle();
      await expectExpired(pending.id, pending.invocationId); await quiet();
    });

    it("retains the first write through drain and enforces approval expiry before cleanup resumes", async () => {
      await start(); await quiet(); draining = true;
      const pending = await request(); await settle();
      const reads = vi.spyOn(db, "select");
      await settle(2 * 60 * 60_000); expect(reads).not.toHaveBeenCalled(); reads.mockRestore();
      await expect(commitToolActionReview(db, { companyId: fixture.company.id, actionRequestId: pending.id,
        decision: "approved", actor: { userId: "reviewer" } })).rejects.toThrow("This review has expired");
      draining = false; await settle();
      await expectExpired(pending.id, pending.invocationId); await quiet();
    });

    it("preserves a signing write arriving during an empty deadline read", async () => {
      let release!: () => void, reading!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const ready = new Promise<void>(resolve => { reading = resolve; });
      const actual = gateway.actionReviewExpiryDeadlines.bind(gateway);
      vi.spyOn(gateway, "actionReviewExpiryDeadlines").mockImplementationOnce(async () => {
        const deadline = await actual(); reading(); await gate; return deadline;
      });
      const starting = start(); await ready;
      let pending: Awaited<ReturnType<typeof request>>;
      try { pending = await request(); } finally { release(); }
      await starting; await settle();
      expect(coordinator!.nextWakeAt()).toBe(pending!.expiresAt!.getTime());
    });

    it("leaves unsigned requests without a saved expiry alone", async () => {
      const pending = await request();
      await db.update(toolActionRequests).set({ expiresAt: null, signedArguments: null })
        .where(eq(toolActionRequests.id, pending.id));
      await start(); await quiet();
      expect((await db.select().from(toolActionRequests))[0].status).toBe("pending");
    });

    it("expires all overdue pages without replaying approved or interrupted actions", async () => {
      const pending = await request();
      const past = new Date(Date.now() - 1000);
      await db.update(toolActionRequests).set({ expiresAt: past }).where(eq(toolActionRequests.id, pending.id));
      await db.insert(toolActionRequests).values(Array.from({ length: 101 }, () => ({
        ...pending, id: randomUUID(), interactionId: null, expiresAt: past,
      })));
      const passes = vi.spyOn(gateway, "sweepExpiredActionReviewsForCompany");
      await start(); await quiet();
      const results = await Promise.all(passes.mock.results.map(result => result.value));
      expect(results.length).toBeGreaterThan(1);
      expect(results.every(result => result.scanned <= 100)).toBe(true);
      const rows = await db.select().from(toolActionRequests);
      expect(rows).toHaveLength(102);
      expect(rows.every(row => row.status === "expired")).toBe(true);
    });

    it("rolls expiry back when invocation settlement fails, then retries the complete transition", async () => {
      const pending = await request(); await start(); await settle();
      await db.execute(sql`create function sleep_review_fail() returns trigger language plpgsql as $$
        begin raise exception 'expiry settlement fixture failure'; end $$`);
      await db.execute(sql`create trigger sleep_review_fail before update on tool_invocations
        for each row when (new.error_code = 'action_expired') execute function sleep_review_fail()`);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
      expect((await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, pending.id)))[0].status).toBe("pending");
      expect((await db.select().from(toolInvocations).where(eq(toolInvocations.id, pending.invocationId)))[0].status).toBe("awaiting_approval");
      await db.execute(sql`drop trigger sleep_review_fail on tool_invocations`);
      expect(errors.every(error => error instanceof AggregateError && error.errors.every(
        failure => (failure as { cause?: Error }).cause?.message === "expiry settlement fixture failure"))).toBe(true);
      errors.length = 0;
      await settle(); await expectExpired(pending.id, pending.invocationId); await quiet();
    });
  });
});
