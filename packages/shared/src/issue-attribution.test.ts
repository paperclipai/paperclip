import { describe, expect, it } from "vitest";
import { deriveOriginatingActor, deriveResponsibleUser } from "./issue-attribution.js";

describe("deriveResponsibleUser", () => {
  it("prefers an explicit responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: "user-responsible",
        createdByUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-responsible",
      source: "explicit",
      isAutoDerived: false,
    });
  });

  it("falls back to the creator user as an auto-derived responsible user", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        createdByUserId: "user-creator",
      }),
    ).toEqual({
      userId: "user-creator",
      source: "creator",
      isAutoDerived: true,
    });
  });

  it("returns none when no human is available", () => {
    expect(
      deriveResponsibleUser({
        responsibleUserId: null,
        createdByUserId: null,
      }),
    ).toEqual({
      userId: null,
      source: "none",
      isAutoDerived: false,
    });
  });
});

describe("deriveOriginatingActor", () => {
  it("prefers the human creator over an explicit responsible user", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: "user-creator",
        createdByAgentId: null,
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-creator" });
  });

  it("attributes an agent-created issue to the transitive responsible user via the agent", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: "agent-claude",
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-responsible", viaAgentId: "agent-claude" });
  });

  it("falls back to the creating agent when no responsible user is known", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: "agent-claude",
        responsibleUserId: null,
      }),
    ).toEqual({ kind: "agent", id: "agent-claude" });
  });

  it("surfaces the responsible user for routine executions with no creator", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: null,
        responsibleUserId: "user-responsible",
      }),
    ).toEqual({ kind: "user", id: "user-responsible" });
  });

  it("returns null when nothing is attributable", () => {
    expect(
      deriveOriginatingActor({
        createdByUserId: null,
        createdByAgentId: null,
        responsibleUserId: null,
      }),
    ).toBeNull();
  });
});
