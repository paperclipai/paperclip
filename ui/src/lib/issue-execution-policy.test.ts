import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema, type IssueExecutionPolicy } from "@paperclipai/shared";
import { buildExecutionPolicy } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });

  it("configures an approved review to return to the executor before approval", () => {
    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
      reviewOnApprove: "return_to_executor",
    });

    expect(policy?.stages[0]).toMatchObject({
      type: "review",
      onApprove: "return_to_executor",
    });
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("resets return-to-executor when the following approval stage is removed", () => {
    const existingPolicy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
      reviewOnApprove: "return_to_executor",
    });
    const policy = buildExecutionPolicy({
      existingPolicy,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: [],
    });

    expect(policy?.stages[0]).toMatchObject({
      type: "review",
      onApprove: "advance",
    });
  });

  it("preserves issue-level authorization and review controls", () => {
    const reviewPreset = {
      id: "low_trust_review" as const,
      version: 1 as const,
      rawOutputDisposition: "quarantine" as const,
    };
    const authorizationPolicy = {
      trustPreset: "low_trust_review" as const,
      reviewPreset,
      trustBoundary: {
        mode: "low_trust_review" as const,
        companyId: "company-1",
      },
    };
    const existingPolicy: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: false,
      reviewPreset,
      authorizationPolicy,
      stages: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          type: "review",
          approvalsNeeded: 1,
          participants: [{
            id: "00000000-0000-4000-8000-000000000011",
            type: "agent",
            agentId: AGENT_ID,
            userId: null,
          }],
        },
        {
          id: "00000000-0000-4000-8000-000000000012",
          type: "approval",
          approvalsNeeded: 1,
          participants: [{
            id: "00000000-0000-4000-8000-000000000013",
            type: "user",
            agentId: null,
            userId: "local-board",
          }],
        },
      ],
    };

    const policy = buildExecutionPolicy({
      existingPolicy,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
      reviewOnApprove: "return_to_executor",
    });

    expect(policy).toMatchObject({
      commentRequired: false,
      reviewPreset,
      authorizationPolicy,
      stages: [
        { type: "review", onApprove: "return_to_executor" },
        { type: "approval" },
      ],
    });

    expect(buildExecutionPolicy({
      existingPolicy,
      reviewerValues: [],
      approverValues: [],
    })).toMatchObject({
      stages: [],
      reviewPreset,
      authorizationPolicy,
    });
  });
});
