import { describe, expect, it } from "vitest";

import {
  resolveIssueAssigneeFallback,
  type IssueAssigneeFallbackInput,
} from "../services/issue-assignee-fallback.js";
import type { AgentOrgRow } from "../services/agent-invokability.js";

const COMPANY = "company-1";

const CEO = "ceo-agent";
const CTO = "cto-agent";
const STAFF = "staff-agent";
const CISO = "ciso-agent";

function agent(
  id: string,
  reportsTo: string | null,
  status: AgentOrgRow["status"] = "idle",
): AgentOrgRow {
  return { id, companyId: COMPANY, name: id, reportsTo, status };
}

/** CEO -> CTO -> Staff, CEO -> CISO */
function roster(overrides: Partial<Record<string, AgentOrgRow>> = {}): AgentOrgRow[] {
  const base: Record<string, AgentOrgRow> = {
    [CEO]: agent(CEO, null),
    [CTO]: agent(CTO, CEO),
    [STAFF]: agent(STAFF, CTO),
    [CISO]: agent(CISO, CEO),
  };
  return Object.values({ ...base, ...overrides });
}

function resolve(input: Partial<IssueAssigneeFallbackInput>) {
  return resolveIssueAssigneeFallback({
    companyId: COMPANY,
    companyAgents: roster(),
    ...input,
  });
}

describe("resolveIssueAssigneeFallback", () => {
  it("does not touch an explicit agent assignee", () => {
    expect(resolve({ assigneeAgentId: STAFF })).toEqual({ applied: false, reason: "explicit" });
  });

  it("does not touch an explicit user assignee", () => {
    expect(resolve({ assigneeUserId: "user-1" })).toEqual({ applied: false, reason: "explicit" });
  });

  it("treats empty-string assignees as unassigned", () => {
    const result = resolve({ assigneeAgentId: "", assigneeUserId: "", createdByAgentId: STAFF });
    expect(result).toEqual({ applied: true, assigneeAgentId: CTO, reason: "creator_manager", degraded: false });
  });

  it("rung 1: inherits the parent issue's assignee", () => {
    const result = resolve({ parentAssigneeAgentId: CISO, createdByAgentId: STAFF });
    expect(result).toEqual({ applied: true, assigneeAgentId: CISO, reason: "parent", degraded: false });
  });

  it("rung 2: falls back to the creator's manager when there is no parent", () => {
    const result = resolve({ createdByAgentId: STAFF });
    expect(result).toEqual({ applied: true, assigneeAgentId: CTO, reason: "creator_manager", degraded: false });
  });

  it("skips a non-invokable parent assignee and continues down the ladder", () => {
    const result = resolve({
      parentAssigneeAgentId: CISO,
      createdByAgentId: STAFF,
      companyAgents: roster({ [CISO]: agent(CISO, CEO, "terminated") }),
    });
    expect(result).toEqual({ applied: true, assigneeAgentId: CTO, reason: "creator_manager", degraded: false });
  });

  it("walks past a paused manager to the next invokable ancestor", () => {
    const result = resolve({
      createdByAgentId: STAFF,
      companyAgents: roster({ [CTO]: agent(CTO, CEO, "paused") }),
    });
    expect(result).toEqual({ applied: true, assigneeAgentId: CEO, reason: "creator_manager", degraded: false });
  });

  it("rung 3: assigns the creator when it has no invokable manager", () => {
    // A root-level agent has no manager at all, so the creator itself is the owner.
    const result = resolve({ createdByAgentId: CEO });
    expect(result).toEqual({ applied: true, assigneeAgentId: CEO, reason: "creator", degraded: false });
  });

  it("rung 4: falls back to the company root for a user-created issue with no parent", () => {
    const result = resolve({ createdByAgentId: null });
    expect(result).toEqual({ applied: true, assigneeAgentId: CEO, reason: "company_root", degraded: false });
  });

  it("never returns a terminated agent even when it is the creator", () => {
    // Creator and its direct manager are both terminated: the walk must climb past both
    // and land on the CEO rather than assigning to a terminated agent.
    const result = resolve({
      createdByAgentId: STAFF,
      companyAgents: roster({
        [STAFF]: agent(STAFF, CTO, "terminated"),
        [CTO]: agent(CTO, CEO, "terminated"),
      }),
    });
    expect(result).toEqual({ applied: true, assigneeAgentId: CEO, reason: "creator_manager", degraded: false });
  });

  it("never returns a pending_approval agent", () => {
    const result = resolve({
      parentAssigneeAgentId: CISO,
      createdByAgentId: null,
      companyAgents: roster({ [CISO]: agent(CISO, CEO, "pending_approval") }),
    });
    expect(result).toEqual({ applied: true, assigneeAgentId: CEO, reason: "company_root", degraded: false });
  });

  it("still assigns an owner when a reporting cycle leaves nothing invokable", () => {
    // a -> b -> a, with no root at all. Fail visible: we must not refuse the create just
    // because the org chart is malformed. Deterministic ID sort picks the owner.
    const cyclic = [agent("a", "b"), agent("b", "a")];
    const result = resolve({ createdByAgentId: "a", companyAgents: cyclic });
    expect(result.applied).toBe(true);
    expect(result).toMatchObject({
      applied: true,
      assigneeAgentId: "a",
      degraded: true,
      degradedReason: "no_invokable_owner",
    });
  });

  it("fails VISIBLE, not closed: assigns the root and flags it when nothing is wakeable", () => {
    // The whole roster is terminated. The old behaviour rejected the create outright, which
    // meant a degraded roster produced a company-wide write outage -- precisely when someone
    // needs to file an escalation. An issue that exists with a warning flag beats an issue
    // that was never created.
    const result = resolve({
      createdByAgentId: STAFF,
      companyAgents: roster({
        [CEO]: agent(CEO, null, "terminated"),
        [CTO]: agent(CTO, CEO, "terminated"),
        [STAFF]: agent(STAFF, CTO, "terminated"),
        [CISO]: agent(CISO, CEO, "terminated"),
      }),
    });
    expect(result).toEqual({
      applied: true,
      // The root is still the company's owner of last resort even when it cannot be woken.
      assigneeAgentId: CEO,
      reason: "company_root",
      degraded: true,
      degradedReason: "no_invokable_owner",
      candidatesConsidered: [`creator:${STAFF}`],
    });
  });

  it("assigns a paused root rather than refusing: pausing is reversible", () => {
    const result = resolve({
      createdByAgentId: null,
      companyAgents: roster({
        [CEO]: agent(CEO, null, "paused"),
        [CTO]: agent(CTO, CEO, "paused"),
        [STAFF]: agent(STAFF, CTO, "paused"),
        [CISO]: agent(CISO, CEO, "paused"),
      }),
    });
    expect(result).toMatchObject({
      applied: true,
      assigneeAgentId: CEO,
      degraded: true,
      degradedReason: "no_invokable_owner",
    });
  });

  it("flags, never rejects, a company with zero agents", () => {
    // Zero agents is the bootstrap state of every company, not an impossibility. No owner
    // can be named, so the caller writes the issue unassigned and carries this flag. There
    // is no input on which the resolver tells the caller to refuse the write.
    const result = resolve({ createdByAgentId: null, companyAgents: [] });
    expect(result).toEqual({
      applied: false,
      reason: "no_agents_in_company",
      degradedReason: "no_agents_in_company",
    });
  });

  it("never reports a degraded result without naming an owner", () => {
    // Guards the core invariant: `degraded` must always still carry an assignee, otherwise
    // we would have reintroduced the invisible issue we set out to eliminate.
    const rosters: AgentOrgRow[][] = [
      roster({ [CEO]: agent(CEO, null, "terminated"), [CTO]: agent(CTO, CEO, "terminated"),
        [STAFF]: agent(STAFF, CTO, "terminated"), [CISO]: agent(CISO, CEO, "terminated") }),
      [agent("a", "b"), agent("b", "a")],
      [agent("solo", null, "paused")],
    ];
    for (const companyAgents of rosters) {
      const result = resolve({ createdByAgentId: null, companyAgents });
      expect(result.applied).toBe(true);
      if (result.applied) expect(result.assigneeAgentId).toBeTruthy();
    }
  });

  it("is deterministic: the same input always yields the same owner", () => {
    const input = { parentAssigneeAgentId: null, createdByAgentId: STAFF };
    const first = resolve(input);
    const second = resolve(input);
    const third = resolve(input);
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });

  it("picks a stable root when the roster has several managerless agents", () => {
    const multiRoot = [agent("zzz-root", null), agent("aaa-root", null)];
    const result = resolve({ createdByAgentId: null, companyAgents: multiRoot });
    expect(result).toEqual({ applied: true, assigneeAgentId: "aaa-root", reason: "company_root", degraded: false });
  });
});
