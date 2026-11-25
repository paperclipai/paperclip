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

describeToolGatewayEmbeddedPostgres("tool gateway service: action approvals", () => {
  const h = createToolGatewayDbHarness();
  let db!: ReturnType<typeof createDb>;
  beforeAll(() => { db = h.db; });

  it("gates write tools with an action request and executes only stored reviewed arguments once", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));

    const notified = vi.fn();
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.toolAction, notified);
    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "short" },
    })).rejects.toMatchObject({
      reasonCode: "approval_required",
      details: { instructions: expect.stringContaining("A human approval card was posted on task") },
    });

    unsubscribe();
    expect(notified).toHaveBeenCalledTimes(1);

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "short" },
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(await db.select().from(toolActionRequests)).toHaveLength(1);

    const [actionRequest] = await db.select().from(toolActionRequests);
    expect(actionRequest).toMatchObject({
      status: "pending",
      issueId: session.issueId,
      approvalId: null,
    });
    expect(actionRequest.signedArguments).toEqual(expect.any(String));

    // PAP-10896: the prosumer card preview must be plain language — no tool/risk vocab,
    // no "Arguments reviewed for execution:" header, and no raw JSON code block.
    const preview = actionRequest.previewMarkdown ?? "";
    expect(preview).not.toMatch(/Tool:/);
    expect(preview).not.toMatch(/Risk:/);
    expect(preview).not.toMatch(/Arguments reviewed for execution:/);
    expect(preview).not.toMatch(/```/);
    expect(preview).toContain("Remote fixture update note");
    expect(preview).not.toContain("checking with you first");
    expect(preview).not.toContain("\n\n");
    // The humanized field label is surfaced (body → "Body"), the raw key is not.
    expect(preview).toContain("**Body:** short");

    const [interaction] = await db.select().from(issueThreadInteractions);
    expect(interaction).toMatchObject({
      kind: "request_confirmation",
      status: "pending",
      issueId: session.issueId,
    });
    // The board-only formal-approval interaction may keep the technical block.
    const interactionDetails =
      (interaction.payload as { detailsMarkdown?: string } | null)?.detailsMarkdown ?? "";
    expect(interactionDetails).toMatch(/Tool: `mcp-remote-fixture:update_note`/);
    expect(interactionDetails).toMatch(/Risk: `write`/);
    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation).toMatchObject({
      status: "awaiting_approval",
      approvalState: "pending",
      toolName: "mcp-remote-fixture:update_note",
      resultSummary: null,
    });

    await db.update(issueThreadInteractions).set({
      status: "accepted",
      resolvedByUserId: "board-user",
      resolvedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(issueThreadInteractions.id, interaction.id));

    const result = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      approvedActionRequestId: actionRequest.id,
      parameters: { noteId: "n1", body: "this tampered body must not execute" },
    });
    expect(result.status).toBe("completed");
    expect((result.result as { data?: { bodyLength?: number } }).data?.bodyLength).toBe("short".length);

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      approvedActionRequestId: actionRequest.id,
      parameters: { noteId: "n1", body: "short" },
    })).rejects.toMatchObject({ reasonCode: "action_not_approved" });
  });

  it("approves a pending action request directly from the review queue and preserves signed arguments", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    // Real runner calls carry immutable identity in their signed approval.
    await initializeRunIdentity(db, {
      companyId: company.id, runId: run.id, issueId: issue.id,
      responsibleUserId: null, cause: "company_default",
    });
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "reviewed body" },
    })).rejects.toMatchObject({ reasonCode: "approval_required" });

    const [actionRequest] = await db.select().from(toolActionRequests);
    const approved = await gateway.approveActionRequest({
      companyId: company.id,
      actionRequestId: actionRequest.id,
      actor: { userId: "board-user" },
    });
    expect(approved).toMatchObject({
      status: "executed",
      resolvedByUserId: "board-user",
      resultSummary: expect.stringContaining("bodyLength"),
    });

    // The server carries out the approved call itself with no interactive
    // caller left to raise timeoutMs, so it must get the full 60s headroom
    // rather than the 10s interactive default.
    const [executedEvent] = await db.select().from(toolCallEvents).where(and(
      eq(toolCallEvents.actionRequestId, actionRequest.id),
      eq(toolCallEvents.reasonCode, "approved_action_executed"),
    ));
    expect(executedEvent?.metadata).toMatchObject({ timeoutMs: 60_000 });

    const result = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "reviewed body" },
    });
    expect(result.status).toBe("replayed");
    expect((result.result as { data?: { bodyLength?: number } }).data?.bodyLength).toBe("reviewed body".length);

    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation).toMatchObject({
      status: "succeeded",
      approvalState: "approved",
    });
    const [consumed] = await db.select().from(toolActionRequests);
    expect(consumed.status).toBe("executed");
  });

  it.each([
    { method: "managed", errorCode: "github_access_denied", sourceKey: "github" },
    { method: "managed", errorCode: "github_app_installation_suspended", sourceKey: "github" },
    { method: "managed", errorCode: "github_repo_outside_app_installations", sourceKey: "github" },
    { method: "mcp-key", errorCode: "github_access_denied", sourceKey: "github" },
    { method: "foreign", errorCode: "github_access_denied", sourceKey: "github" },
    { method: "managed", errorCode: "tool_error", sourceKey: "github" },
    { method: "mcp-key", errorCode: "tool_execution_failed", sourceKey: "github" },
    { method: "managed", errorCode: "tool_error", sourceKey: "notion" },
    { method: "foreign", errorCode: "tool_error", sourceKey: "github" },
  ])("tells the agent how to recover from $errorCode with $method access and $sourceKey identity", async ({ method, errorCode, sourceKey }) => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const wakeup = vi.fn(async (agentId: string, input: any) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload }).returning();
      return wake as any;
    });
    const deliveries = toolActionDeliveryService(db, { wakeup });
    const gateway = createTestToolGatewayService(db, { onToolActionSettled: deliveries.deliver });
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "n1", body: "repo" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests);
    await gateway.approveActionRequest({ companyId: company.id, actionRequestId: request.id, actor: { userId: "reviewer" } });
    // Record the outcome staging saw: GitHub's integration 403 on the approved
    // create_repository call, classified as github_access_denied.
    const denied = "failed to create repository: POST https://api.github.com/user/repos: 403 Resource not accessible by integration []";
    const connectionCompany = method === "foreign" ? (await createRunFixture(db)).company : company;
    const { connection } = await createRemoteMcpToolFixture(db, connectionCompany.id);
    await db.update(toolConnections).set({ config: { ...connection.config,
      sourceTemplateKey: sourceKey, connectionMethodKey: method === "foreign" ? "managed" : method } }).where(eq(toolConnections.id, connection.id));
    await db.update(toolActionRequests).set({ status: "failed" }).where(eq(toolActionRequests.id, request.id));
    await db.update(toolInvocations).set({
      connectionId: connection.id, applicationId: connection.applicationId,
      status: "failed", toolName: "mcp.app-gallery-github-connection:create-repository",
      errorCode, errorMessage: denied,
    }).where(eq(toolInvocations.id, request.invocationId));
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.interactionId!));
    await db.update(issueThreadInteractions).set({ result: { ...(interaction.result as object), toolAction: {
      ...((interaction.result as any)?.toolAction ?? {}), status: "failed", errorCode, errorMessage: denied,
    } } as any }).where(eq(issueThreadInteractions.id, interaction.id));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await deliveries.deliverForRun({ companyId: company.id, runId: run.id });

    expect(wakeup).toHaveBeenCalledTimes(1);
    const payload = wakeup.mock.calls[0][1].payload;
    const instructions: string = payload.toolAction.instructions;
    // Retrying or re-approving hits the same GitHub refusal.
    const outsideApp = errorCode === "github_repo_outside_app_installations";
    const suspendedApp = errorCode === "github_app_installation_suspended";
    const trustedGitHubDenial = outsideApp || suspendedApp || errorCode === "github_access_denied" || (sourceKey === "github" && method !== "foreign");
    if (outsideApp) {
      expect(instructions).toMatch(/do not retry/i);
      expect(instructions).toMatch(/not installed/i);
      expect(instructions).toMatch(/install the Paperclip GitHub App.*refresh access.*retry/i);
      expect(instructions).not.toMatch(/select Refresh access|Add More Repos on GitHub/i);
    } else if (suspendedApp) {
      expect(instructions).toMatch(/do not retry/i);
      expect(instructions).toMatch(/suspended/i);
      expect(instructions).toMatch(/unsuspend/i);
      expect(instructions).toContain("Refresh access");
    } else {
      expect(instructions).toMatch(trustedGitHubDenial ? /do not retry.*until GitHub access is repaired/i : /did not complete successfully/);
      // Concrete next step the agent can relay to the user.
      if (!trustedGitHubDenial) {
        expect(instructions).not.toMatch(/GitHub App|Refresh access|replace.*token/);
      } else if (method === "managed") {
        expect(instructions).toContain("github.com/new");
        expect(instructions).toMatch(/Refresh access/);
      } else if (method === "mcp-key") {
        expect(instructions).toMatch(/token.*permissions/i);
        expect(instructions).toMatch(/replace.*token/i);
        expect(instructions).not.toMatch(/GitHub App|Refresh access/);
      } else {
        expect(instructions).toMatch(/authentication method/);
        expect(instructions).not.toMatch(/GitHub App|Refresh access/);
      }
    }
    expect(payload.paperclipAgentMessage.text).toContain(instructions);
    // Provider text stays in the untrusted result, not in trusted instructions.
    expect(instructions).not.toContain("Resource not accessible");
    expect(payload.paperclipAgentMessage.untrustedToolResults[0].error).toContain("Resource not accessible");
  });

  it("commits one human decision and delivers once after the original run yields, including after service restart", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const wakeup = vi.fn(async (agentId: string, input: any) => {
      const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload }).returning();
      return wake as any;
    });
    const deliveries = toolActionDeliveryService(db, { wakeup });
    const gateway = createTestToolGatewayService(db, { onToolActionSettled: deliveries.deliver });
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "n1", body: "receipt" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests);
    await gateway.approveActionRequest({ companyId: company.id, actionRequestId: request.id, actor: { userId: "reviewer" } });
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.interactionId!));
    expect(interaction).toMatchObject({ issueId: issue.id, status: "accepted", resolvedByUserId: "reviewer", result: { outcome: "accepted", toolAction: { status: "executed", rememberedAction: false } } });
    const nativeResponses = await materializeNativeInteractionResponses({ db, companyId: company.id, issueId: issue.id, runId: randomUUID(), agentId: agent.id, interactionIds: [interaction.id] });
    expect(nativeResponses).toMatchObject([{ interactionId: interaction.id, response: { status: "accepted", result: { toolAction: { status: "executed", resultSummary: expect.stringContaining("bodyLength") } } } }]);
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(toolActionDeliveries))[0].deliveredAt).toBeNull();
    await deliveries.deliverForRun({ companyId: company.id, runId: run.id });
    expect(wakeup).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    const restarted = toolActionDeliveryService(db, { wakeup });
    await deliveries.deliverForRun({ companyId: randomUUID(), runId: run.id });
    await deliveries.deliverForRun({ companyId: company.id, runId: randomUUID() });
    expect(wakeup).not.toHaveBeenCalled();
    // The original executor's terminal cleanup must deliver a review that was
    // approved while it was running, without waiting for the scheduler sweep.
    await deliveries.deliverForRun({ companyId: company.id, runId: run.id });
    expect(wakeup).toHaveBeenCalledTimes(1);
    await Promise.all([restarted.sweepPending(), deliveries.sweepPending()]);
    await gateway.approveActionRequest({ companyId: company.id, actionRequestId: request.id, actor: { userId: "second-reviewer" } });
    await restarted.sweepPending();
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup.mock.calls[0][1].payload.toolAction).toMatchObject({ executionStatus: "executed", resultSummary: expect.stringContaining("bodyLength"), instructions: expect.stringContaining("Do not call it again") });
    expect((await db.select().from(toolActionDeliveries))[0].deliveredAt).not.toBeNull();
    expect((await db.select().from(toolActionRequests))[0].decidedByUserId).toBe("reviewer");
    const message = wakeup.mock.calls[0][1].payload.paperclipAgentMessage;
    expect(message.text).toContain("Do not call it again");
    expect(message.text).not.toContain("bodyLength");
    expect(message.untrustedToolResults).toMatchObject([{ actionRequestId: request.id, resultSummary: expect.stringContaining("bodyLength") }]);
  });

  it("waits for all reviews, then delivers both outcomes in one durable continuation", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const wakeup = vi.fn(async (agentId: string, input: any) => (await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload }).returning())[0] as any);
    const delivery = toolActionDeliveryService(db, { wakeup });
    const gateway = createTestToolGatewayService(db, { onToolActionSettled: delivery.deliver });
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    for (const noteId of ["one", "two"]) await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId, body: "reviewed body" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const requests = await db.select().from(toolActionRequests);
    expect(requests).toHaveLength(2);
    await expect(issueService(db).update(issue.id, { status: "done", actorAgentId: agent.id })).rejects.toThrow("waiting for a connection review");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    await gateway.approveActionRequest({ companyId: company.id, actionRequestId: requests[0].id, actor: { userId: "reviewer" } });
    expect(wakeup).not.toHaveBeenCalled();
    expect((await db.select().from(issueThreadInteractions)).filter(row => row.status === "pending")).toHaveLength(1);
    await expect(gateway.declineActionRequest({ companyId: company.id, issueId: issue.id, interactionId: requests[0].interactionId!, actionRequestId: requests[1].id, actor: { userId: "reviewer" } })).rejects.toThrow("does not belong to this interaction");
    await gateway.declineActionRequest({ companyId: company.id, issueId: issue.id, interactionId: requests[1].interactionId!, actionRequestId: requests[1].id, reason: "Not needed", actor: { userId: "reviewer" } });
    await delivery.sweepPending();
    expect(wakeup).toHaveBeenCalledTimes(1);
    const payload = wakeup.mock.calls[0][1].payload;
    expect(payload.interactionIds).toHaveLength(2);
    expect(new Set(payload.toolActions.map((action: any) => action.executionStatus))).toEqual(new Set(["executed", "rejected"]));
    expect((await db.select().from(toolActionDeliveries)).every(row => row.deliveredAt)).toBe(true);
    const native = await materializeNativeInteractionResponses({ db, companyId: company.id, issueId: issue.id, runId: randomUUID(), agentId: agent.id, interactionIds: payload.interactionIds });
    expect(native).toHaveLength(2);
  });

  it("keeps reviewed results from different source runs in separate non-coalescing wakes", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    const [secondRun] = await db.insert(heartbeatRuns).values({ companyId: company.id,
      agentId: agent.id, status: "running", contextSnapshot: { issueId: issue.id } }).returning();
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const gateway = createTestToolGatewayService(db);
    for (const sourceRun of [run, secondRun]) {
      const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: sourceRun.id });
      await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: sourceRun.id, body: "separate origin" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    }
    const requests = await db.select().from(toolActionRequests);
    for (const action of requests) await gateway.declineActionRequest({ companyId: company.id, issueId: issue.id,
      interactionId: action.interactionId!, actionRequestId: action.id, actor: { userId: "reviewer" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.companyId, company.id));
    const wakeup = vi.fn(async (agentId: string, input: any) => (await db.insert(agentWakeupRequests).values({ companyId: company.id,
      agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload }).returning())[0] as any);
    await toolActionDeliveryService(db, { wakeup }).sweepPending();
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(new Set(wakeup.mock.calls.map(([, input]) => input.payload.sourceRunId))).toEqual(new Set([run.id, secondRun.id]));
    for (const [, input] of wakeup.mock.calls) {
      expect(input.allowRunCoalescing).toBe(false);
      expect(input.payload.toolActionRequestIds).toHaveLength(1);
    }
    expect((await db.select().from(toolActionDeliveries)).every(row => row.deliveredAt)).toBe(true);
  });

  it("bounds many outcomes and recovers their full-result reference after wake commit", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    for (let n = 0; n < 12; n++) {
      await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: `note-${n}`, body: "review me" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    }
    const requests = await db.select().from(toolActionRequests);
    for (const request of requests) await gateway.declineActionRequest({ companyId: company.id, actionRequestId: request.id, actor: { userId: "reviewer" }, reason: "😀\n\\".repeat(4000) });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, run.id));
    const wakeup = vi.fn(async (agentId: string, input: any) => {
      await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId, source: input.source, idempotencyKey: input.idempotencyKey, payload: input.payload });
      throw new Error("crash after durable wake commit");
    });
    const delivery = toolActionDeliveryService(db, { wakeup });
    await expect(delivery.sweepPending()).rejects.toThrow("crash after durable wake commit");
    await delivery.sweepPending();
    expect(wakeup).toHaveBeenCalledTimes(1);
    const payload = wakeup.mock.calls[0][1].payload;
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(32_768);
    expect(payload.toolActions.length).toBeLessThanOrEqual(8);
    expect(payload.interactionIds.length).toBe(payload.toolActions.length);
    expect(payload.toolActionOutcomeCount).toBe(12);
    expect(payload.paperclipAgentMessage.text).toContain(payload.toolActionResultsUrl);
    expect((await db.select().from(toolActionDeliveries)).every(row => row.deliveredAt)).toBe(true);
    // The reference retains all outcomes and their full notes, not just snippets.
    expect((await db.select().from(issueThreadInteractions)).every(row => JSON.stringify(row.result).length > 12_000)).toBe(true);
  });

  it("retires a former assignee's continuation after reassignment", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "reassigned" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests);
    await gateway.declineActionRequest({ companyId: company.id, actionRequestId: request.id, actor: { userId: "reviewer" } });
    const [replacement] = await db.insert(agents).values({ companyId: company.id, name: "Replacement", role: "engineer", adapterType: "process" }).returning();
    await db.update(issues).set({ assigneeAgentId: replacement.id }).where(eq(issues.id, issue.id));
    const wakeup = vi.fn();
    const delivery = toolActionDeliveryService(db, { wakeup });
    await delivery.sweepPending();
    expect((await db.select().from(toolActionDeliveries))[0].deliveredAt).not.toBeNull();
    expect(await delivery.sweepPending()).toEqual({ scanned: 0, delivered: 0 });
    expect(wakeup).not.toHaveBeenCalled();
  });

  it("recovers expired reviews beyond a full batch of approvals that cannot recover", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "expire" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests);
    await db.update(toolActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(toolActionRequests.id, request.id));
    const [originalInvocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request.invocationId));
    const blockedInvocations = Array.from({ length: 101 }, (_, i) => ({ ...originalInvocation,
      id: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`, approvalState: "approved" as const, idempotencyKey: null,
    }));
    await db.insert(toolInvocations).values(blockedInvocations);
    await db.insert(toolActionRequests).values(blockedInvocations.map((invocation, i) => ({
      ...request, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      invocationId: invocation.id, interactionId: null, status: "approved" as const,
      signedArguments: signToolArguments({ invocationId: invocation.id, toolName: invocation.toolName,
        canonicalArguments: canonicalToolArguments({ noteId: "blocked" }), executionOnApprove: true,
        signingSecret: testToolActionSigningSecret }),
    })));
    const recover = vi.spyOn(gateway, "approveActionRequest").mockRejectedValue(new Error("Unavailable approval dependency"));
    expect(await gateway.sweepActionReviews()).toEqual({ scanned: 102 });
    expect(recover).toHaveBeenCalledTimes(101);
    const [settled] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, request.interactionId!));
    expect(settled.status).toBe("expired");
  });

  it("settles expired reviews and interrupted execution without replaying an uncertain external action", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "expire" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [expiring] = await db.select().from(toolActionRequests);
    await db.update(toolActionRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(toolActionRequests.id, expiring.id));
    await gateway.sweepActionReviews();
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("expired");
    expect(await materializeNativeInteractionResponses({ db, companyId: company.id, issueId: issue.id, runId: randomUUID(), agentId: agent.id, interactionIds: [expiring.interactionId!] })).toMatchObject([{ response: { status: "expired", executionStatus: "expired" } }]);
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "uncertain" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const pending = (await db.select().from(toolActionRequests)).find(row => row.status === "pending")!;
    await commitToolActionReview(db, { companyId: company.id, actionRequestId: pending.id, decision: "approved", actor: { userId: "reviewer" } });
    await db.update(toolActionRequests).set({ status: "executing", updatedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(toolActionRequests.id, pending.id));
    await db.update(toolInvocations).set({ status: "executing" }).where(eq(toolInvocations.id, pending.invocationId));
    await gateway.sweepActionReviews();
    const [result] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!));
    expect(result).toMatchObject({ status: "accepted", result: { toolAction: { status: "failed", errorCode: "tool_execution_outcome_unknown" } } });
    // Simulate a crash before the feed projection was saved, then repair it.
    await db.update(issueThreadInteractions).set({ result: { version: 1, outcome: "accepted", toolAction: { version: 1, status: "executing", updatedAt: new Date().toISOString() } } }).where(eq(issueThreadInteractions.id, pending.interactionId!));
    await gateway.sweepActionReviews();
    const [reconciled] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, pending.interactionId!));
    expect(reconciled.result).toMatchObject({ toolAction: { status: "failed", errorCode: "tool_execution_outcome_unknown" } });
    expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(0);
  });

  it("remembers a read action atomically, allows changed arguments, and preserves explicit denials and definition review", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    const [project] = await db.insert(projects).values({ companyId: company.id, name: "Reviewed project" }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, issue.id));
    await grantLegacyPluginTools(db, company.id, "fixture");
    const { connection, catalogEntry } = await createRemoteMcpToolFixture(db, company.id);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask about reads", policyType: "require_approval", selectors: { connectionId: connection.id } });
    let calls = 0;
    const gateway = createTestToolGatewayService(db, { remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/call") calls++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Roadmap and meeting notes" }] } }), { headers: { "content-type": "application/json" } });
    } });
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    const tool = (await gateway.listToolsForSession(session.token)).find(t => t.connectionId === connection.id)!;
    const call = (limit: number) => gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: { limit } });
    await expect(call(10)).rejects.toMatchObject({ reasonCode: "approval_required" });
    await expect(call(10)).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(calls).toBe(0);
    const requests = await db.select().from(toolActionRequests);
    expect(requests).toHaveLength(1);
    const [interaction] = await db.select().from(issueThreadInteractions);
    expect(interaction.payload).toMatchObject({ supersedeOnUserComment: false, toolAction: { risk: "read", rememberActionScope: expect.any(String) } });
    const approve = () => gateway.approveActionRequest({ companyId: company.id, actionRequestId: requests[0].id, rememberAction: true, actor: { userId: "reviewer" } });
    await Promise.all([approve(), approve()]);
    expect(calls).toBe(1);
    const rules = await db.select().from(toolPolicies).where(eq(toolPolicies.policyType, "trust_rule"));
    expect(rules).toHaveLength(1);
    expect(rules[0].selectors).toMatchObject({ agentId: agent.id, projectId: project.id, connectionId: connection.id, toolName: tool.name });
    await call(20);
    expect(calls).toBe(2);
    const [otherAgent] = await db.insert(agents).values({ companyId: company.id, name: "Other agent", role: "engineer", adapterType: "process" }).returning();
    for (const boundary of [{ agentId: agent.id, projectId: null }, { agentId: otherAgent.id, projectId: project.id }]) {
      const [otherIssue] = await db.insert(issues).values({ companyId: company.id, title: "Other scope", status: "in_progress", assigneeAgentId: boundary.agentId, projectId: boundary.projectId }).returning();
      const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: boundary.agentId, invocationSource: "assignment", status: "running", contextSnapshot: { issueId: otherIssue.id } }).returning();
      const otherSession = await gateway.createSession({ companyId: company.id, agentId: boundary.agentId, runId: otherRun.id });
      await expect(gateway.executeTool({ sessionToken: otherSession.token, tool: tool.name, parameters: { limit: 25 } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    }
    expect(calls).toBe(2);
    const [deny] = await db.insert(toolPolicies).values({ companyId: company.id, name: "Explicit denial", policyType: "block", priority: 999, selectors: { connectionId: connection.id } }).returning();
    await expect(call(30)).rejects.toMatchObject({ status: 403 });
    expect(calls).toBe(2);
    await db.delete(toolPolicies).where(eq(toolPolicies.id, deny.id));
    await db.update(toolCatalogEntries).set({ versionHash: "changed-definition" }).where(eq(toolCatalogEntries.id, catalogEntry.id));
    await expect(call(40)).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(calls).toBe(2);
  });

  it("rolls back approval when remembered permission cannot be saved", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values({ companyId: company.id, name: "Ask first", policyType: "require_approval", selectors: { toolName: "mcp-remote-fixture:update_note" } });
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "n1" } })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [request] = await db.select().from(toolActionRequests);
    // This internal fixture has no connection and cannot grant action-wide access.
    await expect(gateway.approveActionRequest({ companyId: company.id, actionRequestId: request.id, rememberAction: true, actor: { userId: "reviewer" } })).rejects.toThrow();
    expect((await db.select().from(toolActionRequests))[0].status).toBe("pending");
    expect((await db.select().from(issueThreadInteractions))[0].status).toBe("pending");
    expect((await db.select().from(toolActionDeliveries))[0].deliveredAt).toBeNull();
    expect(await db.select().from(toolCallEvents).where(eq(toolCallEvents.reasonCode, "approved_action_executed"))).toHaveLength(0);
  });

  it("refuses to approve an action request through a different interaction", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "reviewed body" },
    })).rejects.toMatchObject({ reasonCode: "approval_required" });

    const [actionRequest] = await db.select().from(toolActionRequests);
    await expect(gateway.approveActionRequest({
      companyId: company.id,
      issueId: issue.id,
      interactionId: randomUUID(),
      actionRequestId: actionRequest.id,
      actor: { userId: "board-user" },
    })).rejects.toMatchObject({ reasonCode: "action_context_mismatch" });

    const [stillPending] = await db.select().from(toolActionRequests);
    expect(stillPending.status).toBe("pending");
  });

  it("prevents another run from consuming an approved action request by id", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const originatingSession = await gateway.createSession(runSessionInput(company, agent, run));

    await expect(gateway.executeTool({
      sessionToken: originatingSession.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "reviewed body" },
    })).rejects.toMatchObject({ reasonCode: "approval_required" });

    const [actionRequest] = await db.select().from(toolActionRequests);
    const now = new Date();
    await db
      .update(issueThreadInteractions)
      .set({ status: "accepted", resolvedByUserId: "board-user", resolvedAt: now })
      .where(eq(issueThreadInteractions.id, actionRequest.interactionId!));
    await db
      .update(toolActionRequests)
      .set({ status: "approved", resolvedByUserId: "board-user", decidedAt: now, resolvedAt: now })
      .where(eq(toolActionRequests.id, actionRequest.id));

    const [otherRun] = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: { issueId: issue.id },
    }).returning();
    const otherSession = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: otherRun.id });

    await expect(gateway.executeTool({
      sessionToken: otherSession.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "reviewed body" },
      approvedActionRequestId: actionRequest.id,
    })).rejects.toMatchObject({ reasonCode: "action_scope_mismatch" });

    const [stillApproved] = await db.select().from(toolActionRequests);
    expect(stillApproved.status).toBe("approved");
  });

  it("executes an approved identical-args race once and returns the winner result", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    const parameters = { noteId: "n1", body: "race body" };

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters,
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [actionRequest] = await db.select().from(toolActionRequests);
    const now = new Date();
    await db.update(toolActionRequests).set({ status: "approved", decidedAt: now, resolvedAt: now }).where(eq(toolActionRequests.id, actionRequest.id));

    const [first, second] = await Promise.all([
      gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters }),
      gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters }),
    ]);
    expect(first.status).toBe("replayed");
    expect(second.status).toBe("replayed");
    expect(first.result).toEqual(second.result);
    const executionEvents = await db.select().from(toolCallEvents).where(and(
      eq(toolCallEvents.actionRequestId, actionRequest.id),
      eq(toolCallEvents.reasonCode, "approved_action_executed"),
    ));
    expect(executionEvents).toHaveLength(1);
  });

  it("refuses to execute an approved action after its issue closes", async () => {
    const { company, agent, issue, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    const parameters = { noteId: "n1", body: "post-close body" };

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters,
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [actionRequest] = await db.select().from(toolActionRequests);
    const now = new Date();
    await db.update(toolActionRequests).set({ status: "approved", decidedAt: now, resolvedAt: now }).where(eq(toolActionRequests.id, actionRequest.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issue.id));

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters,
    })).rejects.toMatchObject({ reasonCode: "action_issue_closed" });

    const [settled] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, actionRequest.id));
    expect(settled?.status).toBe("expired");
    const executionEvents = await db.select().from(toolCallEvents).where(and(
      eq(toolCallEvents.actionRequestId, actionRequest.id),
      eq(toolCallEvents.reasonCode, "approved_action_executed"),
    ));
    expect(executionEvents).toHaveLength(0);
  });

  it("keeps pre-execute-on-approve approved requests inert", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    const parameters = { noteId: "n1", body: "legacy" };
    await expect(gateway.executeTool({ sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [actionRequest] = await db.select().from(toolActionRequests);
    const [invocation] = await db.select().from(toolInvocations);
    const legacySignature = signToolArguments({
      invocationId: invocation.id,
      toolName: invocation.toolName,
      canonicalArguments: canonicalToolArguments(parameters),
      signingSecret: testToolActionSigningSecret,
    });
    await db.update(toolActionRequests).set({ signedArguments: legacySignature }).where(eq(toolActionRequests.id, actionRequest.id));

    const approved = await gateway.approveActionRequest({
      companyId: company.id,
      actionRequestId: actionRequest.id,
      actor: { userId: "board-user" },
    });
    expect(approved.status).toBe("approved");
    const [parkedInvocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, invocation.id));
    expect(parkedInvocation.status).toBe("awaiting_approval");

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters,
    })).rejects.toMatchObject({ reasonCode: "legacy_approved_action_inert" });

    const [settledRequest] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, actionRequest.id));
    const [settledInvocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, invocation.id));
    expect(settledRequest.status).toBe("failed");
    expect(settledInvocation.status).toBe("failed");
    expect(settledInvocation.errorCode).toBe("legacy_approved_action_inert");
    expect(settledInvocation.idempotencyKey).toBeNull();

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters,
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    expect(await db.select().from(toolActionRequests)).toHaveLength(2);
  });

  it("does not let a stale legacy consumer overwrite the winning approved execution", async () => {
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));

    let observeLegacyClaim!: () => void;
    const legacyClaimObserved = new Promise<void>((resolve) => {
      observeLegacyClaim = resolve;
    });
    let releaseLegacyClaim!: () => void;
    const legacyClaimBlocked = new Promise<void>((resolve) => {
      releaseLegacyClaim = resolve;
    });
    const gateway = createTestToolGatewayService(db, {
      beforeLegacyApprovedActionClaim: async () => {
        observeLegacyClaim();
        await legacyClaimBlocked;
      },
    });
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    const parameters = { noteId: "n1", body: "legacy race" };

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters,
    })).rejects.toMatchObject({ reasonCode: "approval_required" });
    const [actionRequest] = await db.select().from(toolActionRequests);
    const [invocation] = await db.select().from(toolInvocations);
    const currentSignature = actionRequest.signedArguments!;
    const legacySignature = signToolArguments({
      invocationId: invocation.id,
      toolName: invocation.toolName,
      canonicalArguments: canonicalToolArguments(parameters),
      signingSecret: testToolActionSigningSecret,
    });
    await db
      .update(toolActionRequests)
      .set({ signedArguments: legacySignature })
      .where(eq(toolActionRequests.id, actionRequest.id));
    await gateway.approveActionRequest({
      companyId: company.id,
      actionRequestId: actionRequest.id,
      actor: { userId: "board-user" },
    });

    const staleAttempt = gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      approvedActionRequestId: actionRequest.id,
      parameters,
    }).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await legacyClaimObserved;

    // Simulate a concurrent repair that restores the current signed envelope
    // after the stale consumer has read the legacy envelope but before it owns
    // the approved -> executing claim.
    await db
      .update(toolActionRequests)
      .set({ signedArguments: currentSignature, updatedAt: new Date() })
      .where(and(
        eq(toolActionRequests.id, actionRequest.id),
        eq(toolActionRequests.status, "approved"),
      ));
    const winner = await gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      approvedActionRequestId: actionRequest.id,
      parameters,
    });
    expect(winner.status).toBe("completed");

    releaseLegacyClaim();
    const stale = await staleAttempt;
    expect(stale).toMatchObject({
      status: "rejected",
      error: { reasonCode: "action_already_consumed" },
    });

    const [settledRequest] = await db
      .select()
      .from(toolActionRequests)
      .where(eq(toolActionRequests.id, actionRequest.id));
    const [settledInvocation] = await db
      .select()
      .from(toolInvocations)
      .where(eq(toolInvocations.id, invocation.id));
    expect(settledRequest.status).toBe("executed");
    expect(settledInvocation).toMatchObject({
      status: "succeeded",
      errorCode: null,
      errorMessage: null,
    });
    expect(settledInvocation.idempotencyKey).not.toBeNull();
  });

  it("does not leave unsigned action requests pending when signing is unavailable", async ({ onTestFinished }) => {
    vi.stubEnv("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET", "");
    const { company, agent, run } = await createRunFixture(db);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db, { toolActionSigningSecret: " " });
    const session = await gateway.createSession(runSessionInput(company, agent, run));
    const keyDirectory = await mkdtemp(join(tmpdir(), "tool-gateway-signing-failure-"));
    onTestFinished(() => rm(keyDirectory, { recursive: true, force: true }));
    const keyFile = join(keyDirectory, "master.key");
    await writeFile(keyFile, "corrupt-fixture-master-key", { mode: 0o600 });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "");
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", keyFile);

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "reviewed body" },
    })).rejects.toMatchObject({ reasonCode: "signing_secret_unconfigured" });

    const [actionRequest] = await db.select().from(toolActionRequests);
    expect(actionRequest).toMatchObject({
      status: "cancelled",
      signedArguments: null,
    });
    const [invocation] = await db.select().from(toolInvocations);
    expect(invocation).toMatchObject({
      status: "failed",
      errorCode: "signing_secret_unconfigured",
    });
  });

  it("explains how to recover when an approval-required session has no task", async () => {
    const company = await db.insert(companies).values({
      name: `Gateway ${randomUUID()}`,
      issuePrefix: `TG${randomUUID().slice(0, 6).toUpperCase()}`,
    }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: `Gateway Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const run = await db.insert(heartbeatRuns).values({
      companyId: company.id,
      agentId: agent.id,
      invocationSource: "assignment",
      status: "running",
      contextSnapshot: {},
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolPolicies).values(reviewNotePolicyRow(company));
    const gateway = createTestToolGatewayService(db);
    const session = await gateway.createSession(runSessionInput(company, agent, run));

    await expect(gateway.executeTool({
      sessionToken: session.token,
      tool: "mcp-remote-fixture:update_note",
      parameters: { noteId: "n1", body: "no task" },
    })).rejects.toMatchObject({
      reasonCode: "approval_path_missing",
      details: {
        instructions: "This session is not attached to a task, so an approval card cannot be posted. Re-run this action from a run that has the task checked out.",
      },
    });
  });
});
