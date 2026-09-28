import { describe, expect, it } from "vitest";
import { executionGrantApprovalDetails } from "../execution-grant-details.js";
import { createApprovalSchema, resubmitApprovalSchema } from "./approval.js";
import { requestConfirmationPayloadSchema } from "./issue.js";

const request = {
  version: 1 as const,
  executorAgentId: "11111111-1111-4111-8111-111111111111",
  targetAgentId: "22222222-2222-4222-8222-222222222222",
  operation: "agent_config:update" as const,
  targetRevisionId: null,
  targetUpdatedAt: "2026-09-27T00:00:00Z",
  requestBody: { name: "Chief of staff" },
  requestHash: "a".repeat(64),
  expiresAt: "2026-09-28T00:00:00Z",
  policyVersion: 1,
};

const detailsMarkdown = executionGrantApprovalDetails(request);
const interaction = { version: 1, prompt: "Approve?", executionGrant: request, detailsMarkdown };
const board = { type: "request_board_approval" as const, payload: { executionGrant: request, detailsMarkdown } };

describe("execution grant approval payloads", () => {
  it("accepts the exact displayed request in interaction and board decisions", () => {
    expect(requestConfirmationPayloadSchema.safeParse(interaction).success).toBe(true);
    expect(createApprovalSchema.safeParse(board).success).toBe(true);
    expect(resubmitApprovalSchema.safeParse({ payload: board.payload }).success).toBe(true);
  });

  it("accepts safe adapter and runtime settings with managed secret references", () => {
    const safeRequest = { ...request, requestBody: {
      adapterConfig: { engine: "cli", env: { OPENAI_API_KEY: {
        type: "secret_ref", secretId: "33333333-3333-4333-8333-333333333333",
      } } },
      runtimeConfig: { aiConnection: {
        mode: "responsible_user", provider: "openai", method: "subscription",
      } },
    } };
    const details = executionGrantApprovalDetails(safeRequest);
    expect(requestConfirmationPayloadSchema.safeParse({ ...interaction,
      executionGrant: safeRequest, detailsMarkdown: details }).success).toBe(true);
    expect(createApprovalSchema.safeParse({ ...board, payload: {
      executionGrant: safeRequest, detailsMarkdown: details,
    } }).success).toBe(true);
  });

  it("binds a hostile displayed value to the exact approved request", () => {
    const hostileRequest = { ...request, requestBody: {
      name: '```\n# Harmless change\n<img src=x onerror=alert(1)>',
    } };
    const details = executionGrantApprovalDetails(hostileRequest);
    expect(requestConfirmationPayloadSchema.safeParse({ ...interaction,
      executionGrant: hostileRequest, detailsMarkdown: details }).success).toBe(true);
    expect(requestConfirmationPayloadSchema.safeParse({ ...interaction,
      executionGrant: hostileRequest, detailsMarkdown }).success).toBe(false);
  });

  it.each([
    ["interaction", (payload: unknown) => requestConfirmationPayloadSchema.safeParse(payload).success,
      (executionGrant: unknown, details: string) => ({ ...interaction, executionGrant, detailsMarkdown: details })],
    ["board creation", (payload: unknown) => createApprovalSchema.safeParse(payload).success,
      (executionGrant: unknown, details: string) => ({ ...board, payload: { executionGrant, detailsMarkdown: details } })],
    ["board resubmission", (payload: unknown) => resubmitApprovalSchema.safeParse(payload).success,
      (executionGrant: unknown, details: string) => ({ payload: { executionGrant, detailsMarkdown: details } })],
  ] as const)("rejects hidden or undisplayed grant content at %s", (_name, parse, wrap) => {
    expect(parse(wrap({ ...request, requestBody: { adapterConfig: { apiKey: "secret" } } }, detailsMarkdown)))
      .toBe(false);
    expect(parse(wrap({ ...request, hiddenSecret: "secret" }, detailsMarkdown))).toBe(false);
    expect(parse(wrap({ ...request, requestBody: { name: "Changed" } }, detailsMarkdown))).toBe(false);
    expect(parse(wrap({ ...request, requestBody: { adapterConfig: {
      env: { OPENAI_API_KEY: "plaintext-secret" },
    } } }, detailsMarkdown))).toBe(false);
    expect(parse(wrap({ ...request, requestBody: { runtimeConfig: {
      debug: { providerTrace: "raw" },
    } } }, detailsMarkdown))).toBe(false);
  });
});
