import { describe, expect, it } from "vitest";
import {
  evaluateAgentInvokability,
  listInvalidOrgChainDescendantIds,
  type AgentOrgRow,
} from "../services/agent-invokability.ts";

function agent(partial: Partial<AgentOrgRow> & Pick<AgentOrgRow, "id">): AgentOrgRow {
  return {
    companyId: "company-1",
    name: partial.id,
    reportsTo: null,
    status: "active",
    ...partial,
  };
}

describe("agent invokability", () => {
  it("blocks active descendants under a terminated manager as invalid-org-chain", () => {
    const rows = [
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
    ];

    const result = evaluateAgentInvokability(rows[2], rows);

    expect(result).toMatchObject({
      invokable: false,
      reason: "manager_terminated",
      invalidOrgChain: true,
      details: {
        managerId: "ceo",
        reportingChainAgentIds: ["cto", "ceo"],
      },
    });
  });

  it("reports missing managers and cycles as invalid-org-chain", () => {
    const missingManager = [agent({ id: "coder", reportsTo: "missing" })];
    expect(evaluateAgentInvokability(missingManager[0], missingManager)).toMatchObject({
      invokable: false,
      reason: "manager_missing",
      invalidOrgChain: true,
    });

    const cycle = [
      agent({ id: "a", reportsTo: "b" }),
      agent({ id: "b", reportsTo: "a" }),
    ];
    expect(evaluateAgentInvokability(cycle[0], cycle)).toMatchObject({
      invokable: false,
      reason: "reporting_cycle",
      invalidOrgChain: true,
    });
  });

  it("lists non-terminated descendants made invalid by a terminated root", () => {
    const rows = [
      agent({ id: "ceo", status: "terminated" }),
      agent({ id: "cto", reportsTo: "ceo" }),
      agent({ id: "coder", reportsTo: "cto" }),
      agent({ id: "old-coder", reportsTo: "cto", status: "terminated" }),
      agent({ id: "other-root" }),
    ];

    expect(listInvalidOrgChainDescendantIds("ceo", rows).sort()).toEqual(["coder", "cto"]);
  });
});
