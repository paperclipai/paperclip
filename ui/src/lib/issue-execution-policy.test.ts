import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema, type IssueExecutionPolicy } from "@paperclipai/shared";
import { buildExecutionPolicy, stageParticipantValues } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGE_ID = "00000000-0000-4000-8000-000000000002";
const PARTICIPANT_ID = "00000000-0000-4000-8000-000000000003";

describe("reading execution policy defaults", () => {
  it.each([
    {},
    { authorizationPolicy: { trustPreset: "standard" } },
    { monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" } },
    { stages: [{ type: "review" }] },
  ])("reads schema-valid omitted collections without changing the input: %j", (input) => {
    expect(issueExecutionPolicySchema.safeParse(input).success).toBe(true);
    const before = structuredClone(input);
    expect(stageParticipantValues(input as IssueExecutionPolicy, "review")).toEqual([]);
    expect(stageParticipantValues(input as IssueExecutionPolicy, "approval")).toEqual([]);
    expect(input).toEqual(before);
  });

  it("retains configured reviewers when an unrelated stage omits participants", () => {
    const policy = {
      stages: [
        { type: "approval" },
        { id: STAGE_ID, type: "review", participants: [
          { id: PARTICIPANT_ID, type: "agent", agentId: AGENT_ID },
          { type: "user", userId: "board-reviewer" },
        ] },
      ],
    } as IssueExecutionPolicy;
    expect(stageParticipantValues(policy, "review")).toEqual([`agent:${AGENT_ID}`, "user:board-reviewer"]);
    expect(stageParticipantValues(policy, "approval")).toEqual([]);
  });
});

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

  it("adds reviewers to a policy with omitted stages and retains other policy fields", () => {
    const existingPolicy = {
      authorizationPolicy: { trustPreset: "standard" },
      maxReviewRounds: 4,
      monitor: { nextCheckAt: "2099-01-01T00:00:00.000Z" },
    } as IssueExecutionPolicy;
    const before = structuredClone(existingPolicy);
    const policy = buildExecutionPolicy({ existingPolicy, reviewerValues: [`agent:${AGENT_ID}`], approverValues: [] });
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy).toMatchObject(before);
    expect(stageParticipantValues(policy, "review")).toEqual([`agent:${AGENT_ID}`]);
    expect(existingPolicy).toEqual(before);
  });

  it("keeps stage and participant identities and governance fields when editing reviewers", () => {
    const existingPolicy: IssueExecutionPolicy = {
      mode: "normal", commentRequired: true, maxReviewRounds: 4,
      authorizationPolicy: { trustPreset: "standard" },
      stages: [{ id: STAGE_ID, type: "review", approvalsNeeded: 1, participants: [
        { id: PARTICIPANT_ID, type: "agent", agentId: AGENT_ID, userId: null },
      ] }],
    };
    const policy = buildExecutionPolicy({
      existingPolicy, reviewerValues: [`agent:${AGENT_ID}`, "user:board-reviewer"], approverValues: [],
    });
    expect(policy).toMatchObject({
      authorizationPolicy: existingPolicy.authorizationPolicy,
      maxReviewRounds: 4,
      stages: [{ id: STAGE_ID, participants: [
        existingPolicy.stages[0].participants[0],
        { type: "user", userId: "board-reviewer" },
      ] }],
    });
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
  });

  it("does not remove authorization settings when the last reviewer is removed", () => {
    const existingPolicy = {
      mode: "normal", commentRequired: true, stages: [],
      authorizationPolicy: { trustPreset: "standard" },
    } as IssueExecutionPolicy;
    expect(buildExecutionPolicy({ existingPolicy, reviewerValues: [], approverValues: [] }))
      .toEqual(existingPolicy);
  });

  it.each([
    { maxReviewRounds: 4 },
    { maxReviewRounds: 4, stages: [{ id: STAGE_ID, type: "review", participants: [
      { id: PARTICIPANT_ID, type: "user", userId: "board-reviewer" },
    ] }] },
  ])("retains an independent review-round limit when no participants remain: %j", (existingPolicy) => {
    expect(buildExecutionPolicy({ existingPolicy: existingPolicy as IssueExecutionPolicy, reviewerValues: [], approverValues: [] }))
      .toEqual({ mode: "normal", commentRequired: true, stages: [], maxReviewRounds: 4 });
  });

  it("still clears a policy with no participants, monitor, or other settings", () => {
    expect(buildExecutionPolicy({
      existingPolicy: { mode: "normal", commentRequired: true, stages: [] },
      reviewerValues: [], approverValues: [],
    })).toBeNull();
  });

  it.each([{ stages: {} }, { stages: [null] }, { stages: [{ type: "review", participants: {} }] }])(
    "refuses to manufacture a replacement for a malformed policy: %j", (input) => {
      expect(() => buildExecutionPolicy({ existingPolicy: input as unknown as IssueExecutionPolicy,
        reviewerValues: [], approverValues: [] })).toThrow();
    },
  );
});
