import { getTableName } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { issueService } from "../services/issues.ts";

// Safety characterization. Execute the real selector with a recording
// query double, never a DB, adapter, approval resolver or live evidence issue.
// This double serves named projections; it does NOT execute SQL predicates,
// establish authorization, or prove transactional status+wake atomicity.
function fixture(input: {
  blockerStatus?: string;
  interaction?: Record<string, unknown>;
  approvalStatus?: string;
} = {}) {
  const interaction = input.interaction ? {
    id: "confirmation-1", companyId: "company-1", issueId: "dependent-1",
    kind: "request_confirmation", status: "pending", resolverPolicy: "human_only",
    addresseeUserId: "human-1", target: { type: "issue", issueId: "dependent-1" },
    continuationPolicy: "none", ...input.interaction,
  } : null;
  const approval = input.approvalStatus ? {
    id: "approval-1", companyId: "company-1", status: input.approvalStatus,
    payload: { issueId: "dependent-1", requestedAction: "merge_and_deploy" },
  } : null;
  const untouched = structuredClone({ interaction, approval });
  const reads: string[] = [];
  const db = {
    select: vi.fn((projection: Record<string, unknown> = {}) => ({
      from: (table: Parameters<typeof getTableName>[0]) => {
        const name = getTableName(table);
        reads.push(name);
        let rows: unknown[];
        if (name === "issues") rows = [{ id: "blocker-1", companyId: "company-1" }];
        else if (name === "issue_relations" && "blockerStatus" in projection) rows = [{
          issueId: "dependent-1", blockerIssueId: "blocker-1",
          blockerStatus: input.blockerStatus ?? "done", blockerExecutionWorkspaceId: null,
        }];
        else if (name === "issue_relations" && "assigneeAgentId" in projection) rows = [{
          id: "dependent-1", status: "blocked", assigneeAgentId: "agent-1",
          blockedTransitionAt: new Date("2026-10-05T00:00:00Z"),
        }];
        else if (name === "issue_thread_interactions") rows = interaction ? [interaction] : [];
        else if (name === "approvals") rows = approval ? [approval] : [];
        else if (name === "issue_approvals") rows = approval ? [{
          issueId: "dependent-1", approvalId: approval.id, ...approval,
        }] : [];
        else throw new Error(`Unmodeled selector read: ${name}/${Object.keys(projection).join(",")}`);
        const query = {
          innerJoin: (_table: unknown, _condition: unknown) => query,
          leftJoin: (_table: unknown, _condition: unknown) => query,
          where: (_condition: unknown) => query,
          limit: (_count: number) => query,
          then: (resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(rows).then(resolve, reject),
        };
        return query;
      },
    })),
    update: vi.fn(() => { throw new Error("Selector must not mutate gate rows"); }),
    delete: vi.fn(() => { throw new Error("Selector must not delete gate rows"); }),
    insert: vi.fn(() => { throw new Error("Selector must not replace gate rows"); }),
  };
  return {
    select: () => issueService(db as any).listWakeableBlockedDependents("blocker-1"),
    reads,
    assertPreserved: () => {
      expect({ interaction, approval }).toEqual(untouched);
      expect(db.update).not.toHaveBeenCalled();
      expect(db.delete).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
    },
  };
}

describe("dependency-ready selector human-gate safety (mock-only diagnostic)", () => {
  it("retains ordinary dependency recovery without a human wait", async () => {
    const f = fixture();
    expect(await f.select()).toEqual([expect.objectContaining({
      id: "dependent-1", assigneeAgentId: "agent-1", blockerIssueIds: ["blocker-1"],
    })]);
    f.assertPreserved();
  });

  it.each(["in_progress", "cancelled"])("does not treat %s blockers as resolved", async (blockerStatus) => {
    const f = fixture({ blockerStatus });
    expect(await f.select()).toEqual([]);
    f.assertPreserved();
  });

  it.each(["none", "wake_assignee_on_accept"])(
    "characterizes selector candidates despite pending human confirmation (%s)", async (continuationPolicy) => {
      const f = fixture({ interaction: { continuationPolicy } });
      const candidates = await f.select();
      f.assertPreserved();
      // continuationPolicy is delivery behavior, not authorization to proceed.
      // Characterize the selector, not an authorization writer: it currently
      // ignores human gates. These candidates must NEVER authorize restoration.
      expect(candidates.map((candidate) => candidate.id)).toEqual(["dependent-1"]);
      expect(f.reads).not.toContain("issue_thread_interactions");
      expect(f.reads).not.toContain("approvals");
      expect(f.reads).not.toContain("issue_approvals");
    },
  );

  it.each(["pending", "revision_requested"])(
    "characterizes selector candidates despite a %s formal approval", async (approvalStatus) => {
      const f = fixture({ approvalStatus });
      const candidates = await f.select();
      f.assertPreserved();
      // Characterize the selector, not an authorization writer: it currently
      // ignores human gates. These candidates must NEVER authorize restoration.
      expect(candidates.map((candidate) => candidate.id)).toEqual(["dependent-1"]);
      expect(f.reads).not.toContain("issue_thread_interactions");
      expect(f.reads).not.toContain("approvals");
      expect(f.reads).not.toContain("issue_approvals");
    },
  );
});
