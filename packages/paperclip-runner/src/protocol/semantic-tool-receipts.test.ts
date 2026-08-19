import { describe, expect, it } from "vitest";

import { validatePrpEvent, type PrpEvent } from "./replay-contract.js";
import {
  createPrpBudgetStopReason,
  createPrpSemanticToolInputEnvelope,
  createPrpSemanticToolResultEnvelope,
  semanticAuthorizationBoundaryForCode,
} from "./semantic-tool-receipts.js";

const correlation = {
  runId: "run_receipt_test",
  normalizedSessionId: "session_receipt_test",
  turnId: "turn_receipt_test",
  itemId: "item_receipt_test",
};

describe("PRP provider-neutral semantic receipts", () => {
  it("digests raw content and retains only allowlisted references", () => {
    const envelope = createPrpSemanticToolInputEnvelope({
      operationId: "get_task_context",
      callId: "call_receipt_test",
      correlation,
      content: { authorization: "Bearer secret-token", apiKey: "do-not-emit" },
      references: [{ kind: "task", id: "issue_receipt_test" }],
    });

    expect(envelope.content).toMatchObject({
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      redactionDisposition: "digest_only",
      references: [{ kind: "task", id: "issue_receipt_test" }],
    });
    expect(JSON.stringify(envelope)).not.toContain("secret-token");
    expect(JSON.stringify(envelope)).not.toContain("do-not-emit");
  });

  it("gives exact retries the same operation receipt without provider identifiers", () => {
    const base = {
      operationId: "write_document",
      correlation,
      idempotencyKey: "write_once",
      content: { revisionId: "revision_1" },
      outcome: "succeeded" as const,
      code: "ok",
      retryable: false,
      authorizationBoundary: "revision" as const,
    };
    const first = createPrpSemanticToolResultEnvelope({ ...base, callId: "call_first" });
    const retry = createPrpSemanticToolResultEnvelope({ ...base, callId: "call_retry" });

    expect(retry.operationReceiptId).toBe(first.operationReceiptId);
    expect(retry.operationReceiptId).toMatch(/^semantic_receipt:[a-f0-9]{32}$/);
    expect(retry).not.toHaveProperty("provider");
  });

  it("validates semantic input/result events and a terminal stop receipt", () => {
    const input = createPrpSemanticToolInputEnvelope({
      operationId: "get_task_context",
      callId: "call_receipt_test",
      correlation,
      content: {},
    });
    const result = createPrpSemanticToolResultEnvelope({
      operationId: "get_task_context",
      callId: "call_receipt_test",
      correlation,
      content: {},
      outcome: "succeeded",
      code: "ok",
      retryable: false,
      authorizationBoundary: "active_task",
    });

    expect(validatePrpEvent(event("mcp_app.tool_input", input)).ok).toBe(true);
    expect(validatePrpEvent(event("mcp_app.tool_result", result)).ok).toBe(true);
    expect(
      createPrpBudgetStopReason({
        receiptId: "stop_receipt_test",
        kind: "cost",
        code: "run_cost_limit",
        retryable: true,
        decisionId: "decision_receipt_test",
        limitClass: "run_cost",
        aggregate: { unit: "usd_micros", observed: 100, limit: 100, window: "run" },
      }),
    ).toMatchObject({
      schema: "paperclip.prp.stop_reason.v1",
      kind: "cost",
      decisionId: "decision_receipt_test",
    });
  });

  it("maps denial and conflict codes onto protocol authorization boundaries", () => {
    expect(semanticAuthorizationBoundaryForCode("company_scope_denied")).toBe("company");
    expect(semanticAuthorizationBoundaryForCode("actor_role_denied")).toBe("actor");
    expect(semanticAuthorizationBoundaryForCode("document_revision_conflict")).toBe("revision");
    expect(semanticAuthorizationBoundaryForCode("approval_required")).toBe("governed_action");
  });
});

function event(
  eventType: "mcp_app.tool_input" | "mcp_app.tool_result",
  semanticTool: ReturnType<typeof createPrpSemanticToolInputEnvelope>,
): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `${eventType}:receipt_test`,
    sourceSeq: eventType === "mcp_app.tool_input" ? 1 : 2,
    sourceInstanceId: "runner_receipt_test",
    sourceKind: "runner",
    runId: correlation.runId,
    normalizedSessionId: correlation.normalizedSessionId,
    turnId: correlation.turnId,
    itemId: correlation.itemId,
    eventType,
    schemaVersion: 1,
    priority: 1,
    emittedAt: "2026-08-11T12:00:00.000Z",
    payload: { semantic_tool: semanticTool },
  } as PrpEvent;
}
