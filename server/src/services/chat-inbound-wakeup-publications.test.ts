import { randomUUID } from "node:crypto";
import type { agentWakeupRequests, chatActions } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import { createDurableChatWakeupRequest } from "./durable-chat-wakeup.js";
import {
  inboundWakePublicationKey,
  inboundWakePublicationText,
  parseInboundWakePublicationKey,
  resolveInboundWakeReceipt,
} from "./chat-inbound-wakeup-publications.js";

function fixture() {
  const action = {
    id: randomUUID(),
    companyId: randomUUID(),
    endpointId: randomUUID(),
    conversationId: randomUUID(),
    deliveryId: randomUUID(),
    principalId: randomUUID(),
    kind: "inbound_wakeup",
    providerActionId: "inbound_wakeup:source",
    status: "processed",
    createdAt: new Date(),
    updatedAt: new Date(),
    result: null,
    payload: {
      version: 1,
      agentId: randomUUID(),
      issueId: randomUUID(),
      commentId: randomUUID(),
      sessionGeneration: 1,
      requestedByActorType: "user",
      requestedByActorId: "owner",
    },
  } satisfies typeof chatActions.$inferSelect;
  const trusted = createDurableChatWakeupRequest({
    id: action.id,
    companyId: action.companyId,
    agentId: action.payload.agentId,
    issueId: action.payload.issueId,
    commentId: action.payload.commentId,
    requestedByActorType: "user",
    requestedByActorId: "owner",
    requestedAt: action.createdAt,
    authorize: async () => {},
  });
  const receipt = {
    id: action.id,
    companyId: action.companyId,
    agentId: action.payload.agentId,
    source: "assignment",
    triggerDetail: "system",
    reason: "PRIVATE scheduler reason",
    payload: {
      issueId: action.payload.issueId,
      wakeCommentId: action.payload.commentId,
    },
    status: "deferred_issue_execution",
    runId: null,
    requestedByActorType: "user",
    requestedByActorId: "owner",
    idempotencyKey: trusted.idempotencyKey,
    coalescedCount: 0,
    requestedAt: new Date(),
    claimedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    error: "PRIVATE error with token",
  } satisfies typeof agentWakeupRequests.$inferSelect;
  return { action, receipt };
}

describe("durable inbound queue notice", () => {
  it("projects only a committed deferred receipt and closed text", () => {
    const { action, receipt } = fixture();
    expect(resolveInboundWakeReceipt(action, receipt, receipt)).toEqual({
      ownerId: receipt.id,
      state: "queued",
      runId: null,
    });
    expect(resolveInboundWakeReceipt(action, null, receipt)).toBeNull();
    expect(inboundWakePublicationText("queued")).toBe(
      "Your follow-up is queued.",
    );
    expect(inboundWakePublicationText("not_started")).toBe(
      "This follow-up was not started. Open the task in Paperclip for details.",
    );
    expect(inboundWakePublicationText("removed")).toBe(
      "This queued message was removed.",
    );
  });

  it.each([
    { status: "queued" },
    { status: "processing" },
    { idempotencyKey: "caller marker" },
    { requestedByActorId: "someone-else" },
    { companyId: randomUUID() },
    { agentId: randomUUID() },
    { payload: { issueId: randomUUID() } },
  ])("rejects absent admission or mismatched receipt %j", (patch) => {
    const { action, receipt } = fixture();
    const changed = { ...receipt, ...patch };
    expect(resolveInboundWakeReceipt(action, changed, changed)).toBeNull();
  });

  it("coalesces only one hop into the same actor's exact issue and source comment", () => {
    const { action, receipt } = fixture();
    const owner = { ...receipt, id: randomUUID() };
    const child = {
      ...receipt,
      status: "coalesced",
      payload: { ...receipt.payload, coalescedIntoWakeupRequestId: owner.id },
    };
    expect(resolveInboundWakeReceipt(action, child, owner)?.ownerId).toBe(
      owner.id,
    );
    expect(
      resolveInboundWakeReceipt(action, child, {
        ...owner,
        requestedByActorId: "other",
      }),
    ).toBeNull();
    expect(
      resolveInboundWakeReceipt(action, child, {
        ...owner,
        payload: {
          ...owner.payload,
          coalescedIntoWakeupRequestId: randomUUID(),
        },
      }),
    ).toBeNull();
    expect(
      resolveInboundWakeReceipt(action, child, {
        ...owner,
        payload: { issueId: action.payload.issueId },
      }),
    ).toBeNull();
  });

  it("distinguishes pre-run rejection from a run that actually started", () => {
    const { action, receipt } = fixture();
    const cancelled = { ...receipt, status: "cancelled" };
    expect(resolveInboundWakeReceipt(action, cancelled, cancelled)?.state).toBe(
      "not_started",
    );
    const started = { ...cancelled, runId: randomUUID() };
    expect(resolveInboundWakeReceipt(action, started, started)).toBeNull();
    const promoted = { ...receipt, status: "queued", runId: randomUUID() };
    expect(resolveInboundWakeReceipt(action, promoted, promoted)).toEqual({
      ownerId: receipt.id,
      state: "promoted",
      runId: promoted.runId,
    });
  });

  it("parses only the exact closed UUID lane key", () => {
    const { action, receipt } = fixture();
    const key = inboundWakePublicationKey(
      receipt.id,
      "queued",
      action.endpointId,
      action.conversationId,
    );
    expect(parseInboundWakePublicationKey(key)).toEqual({
      wakeId: receipt.id,
      state: "queued",
      endpointId: action.endpointId,
      conversationId: action.conversationId,
    });
    expect(parseInboundWakePublicationKey(`${key}:forged`)).toBeNull();
    expect(
      parseInboundWakePublicationKey("wake:not-a-uuid:queued:any:where"),
    ).toBeNull();
  });

  it("keeps removed-source cleanup distinct from the surviving batch's execution", () => {
    const { action, receipt } = fixture();
    const promoted = {
      ...receipt,
      status: "claimed",
      runId: randomUUID(),
      payload: { issueId: action.payload.issueId },
    };
    expect(resolveInboundWakeReceipt(action, promoted, promoted)).toBeNull();
    expect(resolveInboundWakeReceipt(action, promoted, promoted, true)).toEqual(
      { ownerId: receipt.id, state: "removed", runId: promoted.runId },
    );
    expect(
      resolveInboundWakeReceipt(
        action,
        { ...promoted, requestedByActorId: "other" },
        promoted,
        true,
      ),
    ).toBeNull();
  });
});
