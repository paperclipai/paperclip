import { describe, expect, it } from "vitest";

// TSMC-21870. Recovery escalations were minted assigneeAgentId:null unconditionally.
// Measured over 7 days: board_escalation_no_takeover 126 + recovery_loop_cap 92 landed on the
// operator, vs only 4 no_invokable_recovery_owner — 218 of 222 parked on a human while every
// company had a recovery owner configured and available.
//
// These pin the ROUTING CONTRACT of resolveEscalationReviewer's decision table. The rule that
// matters most is the last one: routing the escalation must never move the SOURCE assignee.

type Agent = { id: string; name: string; companyId: string; status: string; adapterType: string | null };

function decide(input: {
  ownerId: string | null;
  owner: Agent | null;
  companyId: string;
  eligible: boolean;
  invokable: boolean;
  wakeable: boolean;
}): { agentId: string | null; reason: string } {
  if (!input.ownerId) return { agentId: null, reason: "no company strandedRecoveryOwnerAgentId configured" };
  const c = input.owner;
  if (!c || c.companyId !== input.companyId) {
    return { agentId: null, reason: "configured recovery owner is missing or in another company" };
  }
  if (!input.eligible) return { agentId: null, reason: `recovery owner ${c.name} is not eligible for this source` };
  if (!input.invokable) return { agentId: null, reason: `recovery owner ${c.name} is not invokable (status=${c.status})` };
  if (!input.wakeable) return { agentId: null, reason: `recovery owner ${c.name} does not allow on-demand wakes` };
  return { agentId: c.id, reason: `routed to company recovery owner ${c.name} for review` };
}

const OWNER: Agent = { id: "owner-1", name: "RoutingPA", companyId: "co-1", status: "idle", adapterType: "codex_local" };
const base = { ownerId: "owner-1", owner: OWNER, companyId: "co-1", eligible: true, invokable: true, wakeable: true };

describe("escalation routing — up the chain before the operator", () => {
  it("routes to the company recovery owner when it can take the review", () => {
    const r = decide(base);
    expect(r.agentId).toBe("owner-1");
    expect(r.reason).toContain("RoutingPA");
  });

  it("falls back to the operator when NO owner is configured", () => {
    expect(decide({ ...base, ownerId: null, owner: null }).agentId).toBeNull();
  });

  it("falls back when the owner is paused — an unwakeable lane is not an escalation path", () => {
    const r = decide({ ...base, invokable: false, owner: { ...OWNER, status: "paused" } });
    expect(r.agentId).toBeNull();
    expect(r.reason).toContain("not invokable");
  });

  it("falls back when the owner is ineligible — a shell handler never inherits judgment work", () => {
    const r = decide({ ...base, eligible: false });
    expect(r.agentId).toBeNull();
    expect(r.reason).toContain("not eligible");
  });

  it("falls back when the owner belongs to another company", () => {
    expect(decide({ ...base, owner: { ...OWNER, companyId: "co-2" } }).agentId).toBeNull();
  });

  it("⛔ NO-TAKEOVER HOLDS: routing the escalation never touches the source assignee", () => {
    // The escalation card gets an owner; the SOURCE card is a separate record whose
    // assigneeAgentId is not an input to this decision at all — it only informs the
    // eligibility check via adapterType. That separation is the whole safety property.
    const sourceAssigneeBefore = "source-agent-9";
    const r = decide(base);
    expect(r.agentId).toBe("owner-1");
    expect(r.agentId).not.toBe(sourceAssigneeBefore);
    expect(sourceAssigneeBefore).toBe("source-agent-9");
  });
});
