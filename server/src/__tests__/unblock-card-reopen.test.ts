import { describe, expect, it, vi } from "vitest";
import { ensureUnblockBlockerCard } from "../services/heartbeat.js";

// TSMC-21870. Third and last instance of one defect: a machine-minted card's collapse key is
// scoped to the card being OPEN, so closing it re-arms the minter. Guards and recovery
// escalations were fixed by reopening; `Unblock:` cards had only a 24h timer.
//
// Measured 2026-08-26, 5.5h after the first two fixes: GUARD cards fell 44 -> 1 and
// escalations 87 -> 0, while Unblock cards became 77% of everything minted. TWO source
// issues produced 50 of 91; TSMC-21884 alone minted 29.

const SOURCE = {
  id: "src-1", companyId: "co-1", identifier: "TSMC-21884",
  projectId: null, projectWorkspaceId: null, executionWorkspaceSettings: null,
  workMode: null, assigneeAgentId: "agent-1", assigneeUserId: null,
};

function svc(overrides: Record<string, unknown> = {}) {
  return {
    create: vi.fn(async () => ({ id: "new-card", status: "todo" })),
    addComment: vi.fn(async () => undefined),
    update: vi.fn(async () => ({ id: "closed-card", status: "todo" })),
    ...overrides,
  } as never;
}

// Stub the dedup lookup to report an identical card that just went terminal.
vi.mock("../services/meta-issue-dedup.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findReusableMetaIssue: vi.fn(async () => ({
    outcome: "terminal_suppressed" as const,
    issue: { id: "closed-card", status: "cancelled" },
  })),
}));

describe("ensureUnblockBlockerCard — closed-card handling", () => {
  it("REOPENS the closed card instead of minting a replacement", async () => {
    const s = svc();
    const result = await ensureUnblockBlockerCard({} as never, s, {
      sourceIssue: SOURCE, blocker: "LinkedIn approval still pending", runId: "run-1",
    });

    expect(result.outcome).toBe("reused");
    expect((s as never as { update: ReturnType<typeof vi.fn> }).update)
      .toHaveBeenCalledWith("closed-card", expect.objectContaining({ status: "todo" }));
    // The whole point: no new card.
    expect((s as never as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it("records WHY it reopened, so the history stays on one card", async () => {
    const s = svc();
    await ensureUnblockBlockerCard({} as never, s, {
      sourceIssue: SOURCE, blocker: "LinkedIn approval still pending", runId: "run-1",
    });
    const body = (s as never as { addComment: ReturnType<typeof vi.fn> }).addComment.mock.calls[0][1] as string;
    expect(body).toContain("after this card was closed");
    expect(body).toContain("LinkedIn approval still pending");
    expect(body).toContain("TSMC-21884");
  });

  it("falls back to the suppression contract when the reopen fails — never swallows the report", async () => {
    const s = svc({ update: vi.fn(async () => { throw new Error("card unreachable"); }) });
    const result = await ensureUnblockBlockerCard({} as never, s, {
      sourceIssue: SOURCE, blocker: "still blocked", runId: "run-1",
    });
    expect(result.outcome).toBe("terminal_suppressed");
  });
});
