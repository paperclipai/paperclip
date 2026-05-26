import { describe, expect, it } from "vitest";

import {
  commentHasProofBlock,
  descriptionHasAcceptanceField,
  evaluatePostflightProofGuard,
  evaluatePreflightAcceptanceGuard,
  isWithinGrandfatherWindow,
  readEnforcementWindowFromEnv,
} from "../services/definition-of-done.js";

describe("descriptionHasAcceptanceField", () => {
  it("matches bold markdown header", () => {
    expect(descriptionHasAcceptanceField("**Acceptance:**\n- X")).toBe(true);
  });
  it("matches plain leading", () => {
    expect(descriptionHasAcceptanceField("Acceptance: X\nY")).toBe(true);
  });
  it("matches h2 header", () => {
    expect(descriptionHasAcceptanceField("## Acceptance:\n- X")).toBe(true);
  });
  it("rejects descriptions without an Acceptance line", () => {
    expect(
      descriptionHasAcceptanceField("Some context\nnothing structured here"),
    ).toBe(false);
  });
  it("rejects null/empty", () => {
    expect(descriptionHasAcceptanceField(null)).toBe(false);
    expect(descriptionHasAcceptanceField("")).toBe(false);
    expect(descriptionHasAcceptanceField("   ")).toBe(false);
  });
});

describe("commentHasProofBlock", () => {
  it("matches `Proof:` plain", () => {
    expect(commentHasProofBlock("Proof: test passed")).toBe(true);
  });
  it("matches `**Proof:**` bold", () => {
    expect(commentHasProofBlock("**Proof:**\n- output here")).toBe(true);
  });
  it("rejects bodies without Proof", () => {
    expect(commentHasProofBlock("looks fine")).toBe(false);
  });
});

describe("evaluatePreflightAcceptanceGuard", () => {
  const baseExisting = {
    description: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
  };
  const baseActor = {
    actorType: "user" as const,
    actorId: "local-board",
    agentId: null,
  };

  it("allows when assigneeAgentId is not being changed", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: baseExisting,
      requestedAssigneeAgentId: undefined,
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows clearing the assignee", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: { ...baseExisting, assigneeAgentId: "agent-x" },
      requestedAssigneeAgentId: null,
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows no-op reassignment to same agent", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: { ...baseExisting, assigneeAgentId: "agent-x" },
      requestedAssigneeAgentId: "agent-x",
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows self-assignment by the acting agent", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: baseExisting,
      requestedAssigneeAgentId: "agent-self",
      actor: {
        actorType: "agent",
        actorId: "agent-self",
        agentId: "agent-self",
      },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows reassignment to the original creator agent (author self-assignment)", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: { ...baseExisting, createdByAgentId: "agent-author" },
      requestedAssigneeAgentId: "agent-author",
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks reassignment to a new agent when description lacks Acceptance", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: { ...baseExisting, description: "no structure" },
      requestedAssigneeAgentId: "agent-new",
      actor: baseActor,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(422);
      expect(result.error).toMatch(/Acceptance/);
    }
  });

  it("allows reassignment when description has Acceptance", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: { ...baseExisting, description: "**Acceptance:**\n- X" },
      requestedAssigneeAgentId: "agent-new",
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows reassignment of a board-owned issue without Acceptance (board hand-off)", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: {
        ...baseExisting,
        assigneeAgentId: null,
        assigneeUserId: "local-board",
        description: null,
      },
      requestedAssigneeAgentId: "agent-new",
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });

  it("uses requested description when included in the same PATCH", () => {
    const result = evaluatePreflightAcceptanceGuard({
      existing: { ...baseExisting, description: "old without acceptance" },
      requestedDescription: "Acceptance: new structure",
      requestedAssigneeAgentId: "agent-new",
      actor: baseActor,
    });
    expect(result.allowed).toBe(true);
  });
});

describe("evaluatePostflightProofGuard", () => {
  const baseCtx = {
    existingAssigneeAgentId: "agent-A",
    existingCreatedAt: new Date("2026-05-26T00:00:00Z"),
    transitioningToDone: true,
  } as const;

  it("allows when not transitioning to done", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      transitioningToDone: false,
      latestAssigneeComment: null,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows when there is no agent assignee", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      existingAssigneeAgentId: null,
      latestAssigneeComment: null,
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks when no Proof comment exists", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      latestAssigneeComment: null,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.status).toBe(422);
      expect(result.error).toMatch(/Proof/);
    }
  });

  it("blocks when latest comment is from a different agent", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      latestAssigneeComment: {
        body: "Proof: I reviewed",
        authorAgentId: "agent-B",
      },
    });
    expect(result.allowed).toBe(false);
  });

  it("blocks when latest assignee comment lacks Proof: prefix", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      latestAssigneeComment: {
        body: "I'm done",
        authorAgentId: "agent-A",
      },
    });
    expect(result.allowed).toBe(false);
  });

  it("allows when latest assignee comment contains Proof:", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      latestAssigneeComment: {
        body: "Proof: ran the tests, all green",
        authorAgentId: "agent-A",
      },
    });
    expect(result.allowed).toBe(true);
  });

  it("allows when derived author matches assignee", () => {
    const result = evaluatePostflightProofGuard({
      ...baseCtx,
      latestAssigneeComment: {
        body: "**Proof:** see logs",
        authorAgentId: null,
        derivedAuthorAgentId: "agent-A",
      },
    });
    expect(result.allowed).toBe(true);
  });
});

describe("isWithinGrandfatherWindow", () => {
  it("returns false when no enforcement window is configured", () => {
    expect(
      isWithinGrandfatherWindow(new Date("2026-01-01"), undefined),
    ).toBe(false);
  });

  it("returns true for items created before startAt and inside the 7-day window", () => {
    expect(
      isWithinGrandfatherWindow(new Date("2026-01-01T00:00:00Z"), {
        startAt: new Date("2026-05-26T00:00:00Z"),
        grandfatherDays: 7,
        now: new Date("2026-05-29T00:00:00Z"),
      }),
    ).toBe(true);
  });

  it("returns false past the 7-day grace", () => {
    expect(
      isWithinGrandfatherWindow(new Date("2026-01-01T00:00:00Z"), {
        startAt: new Date("2026-05-26T00:00:00Z"),
        grandfatherDays: 7,
        now: new Date("2026-06-10T00:00:00Z"),
      }),
    ).toBe(false);
  });

  it("returns false for issues created after enforcement startAt", () => {
    expect(
      isWithinGrandfatherWindow(new Date("2026-05-27T00:00:00Z"), {
        startAt: new Date("2026-05-26T00:00:00Z"),
        grandfatherDays: 7,
        now: new Date("2026-05-28T00:00:00Z"),
      }),
    ).toBe(false);
  });
});

describe("readEnforcementWindowFromEnv", () => {
  it("returns nulls when env vars are unset", () => {
    const w = readEnforcementWindowFromEnv({});
    expect(w.startAt).toBeNull();
    expect(w.grandfatherDays).toBe(7);
  });

  it("parses valid ISO date and grandfather days", () => {
    const w = readEnforcementWindowFromEnv({
      PAPERCLIP_DOD_GUARD_ENFORCEMENT_START_AT: "2026-05-26T19:30:00Z",
      PAPERCLIP_DOD_GUARD_GRANDFATHER_DAYS: "10",
    });
    expect(w.startAt?.toISOString()).toBe("2026-05-26T19:30:00.000Z");
    expect(w.grandfatherDays).toBe(10);
  });

  it("falls back to defaults when env values are garbage", () => {
    const w = readEnforcementWindowFromEnv({
      PAPERCLIP_DOD_GUARD_ENFORCEMENT_START_AT: "not-a-date",
      PAPERCLIP_DOD_GUARD_GRANDFATHER_DAYS: "abc",
    });
    expect(w.startAt).toBeNull();
    expect(w.grandfatherDays).toBe(7);
  });
});
