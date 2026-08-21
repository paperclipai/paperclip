import { describe, expect, it } from "vitest";
import { isBlockedOwnerStillAuthorized } from "../services/routable-blocked.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  reportsTo: string | null;
};

function agent(id: string, reportsTo: string | null = null, status = "active"): TestAgent {
  return { id, companyId: "company-1", name: `agent-${id}`, status, reportsTo };
}

describe("isBlockedOwnerStillAuthorized", () => {
  it("rejects board, missing, and malformed owners", () => {
    const companyAgents = [agent("owner")];
    expect(isBlockedOwnerStillAuthorized({ owner: "board", createdByAgentId: null, companyAgents })).toBe(false);
    expect(isBlockedOwnerStillAuthorized({ owner: null, createdByAgentId: null, companyAgents })).toBe(false);
    expect(isBlockedOwnerStillAuthorized({ owner: undefined, createdByAgentId: null, companyAgents })).toBe(false);
    expect(isBlockedOwnerStillAuthorized({ owner: { userId: "u1" }, createdByAgentId: null, companyAgents })).toBe(false);
    expect(isBlockedOwnerStillAuthorized({ owner: { agentId: "" }, createdByAgentId: null, companyAgents })).toBe(false);
  });

  it("rejects an owner agent that is not in the company roster", () => {
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "ghost" },
        createdByAgentId: null,
        companyAgents: [agent("owner")],
      }),
    ).toBe(false);
  });

  it("rejects a non-invokable owner", () => {
    const companyAgents = [agent("owner", null, "paused")];
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "owner" },
        createdByAgentId: null,
        companyAgents,
      }),
    ).toBe(false);
  });

  it("allows an owner when there is no agent creator", () => {
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "owner" },
        createdByAgentId: null,
        companyAgents: [agent("owner")],
      }),
    ).toBe(true);
  });

  it("allows the creator to name itself as owner", () => {
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "creator" },
        createdByAgentId: "creator",
        companyAgents: [agent("creator")],
      }),
    ).toBe(true);
  });

  it("allows the owner while it remains the creator's reporting-line manager", () => {
    const companyAgents = [agent("owner"), agent("creator", "owner")];
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "owner" },
        createdByAgentId: "creator",
        companyAgents,
      }),
    ).toBe(true);
  });

  it("rejects the owner once the reporting line moves away", () => {
    const companyAgents = [agent("owner"), agent("creator", null)];
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "owner" },
        createdByAgentId: "creator",
        companyAgents,
      }),
    ).toBe(false);
  });

  it("rejects the owner when the creator reports to a different manager", () => {
    const companyAgents = [agent("owner"), agent("other"), agent("creator", "other")];
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "owner" },
        createdByAgentId: "creator",
        companyAgents,
      }),
    ).toBe(false);
  });

  it("rejects when the creator itself is no longer invokable", () => {
    const companyAgents = [agent("owner"), agent("creator", "owner", "terminated")];
    expect(
      isBlockedOwnerStillAuthorized({
        owner: { agentId: "owner" },
        createdByAgentId: "creator",
        companyAgents,
      }),
    ).toBe(false);
  });
});
