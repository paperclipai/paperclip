import { describe, expect, it, vi } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { resolveLedgerScopeForRun } from "../services/heartbeat.ts";

type IssueRow = { id: string; projectId: string | null; billingCode: string | null };

/**
 * Minimal Drizzle stand-in for the single lookup `resolveLedgerScopeForRun`
 * performs: `db.select({...}).from(issues).where(...)` resolved as a thenable.
 */
type LedgerDb = Parameters<typeof resolveLedgerScopeForRun>[0];

function makeDb(rows: IssueRow[]) {
  const where = vi.fn(() => Promise.resolve(rows));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as LedgerDb, select, from, where };
}

function makeRun(contextSnapshot: Record<string, unknown>) {
  return { id: "run-1", contextSnapshot } as unknown as typeof heartbeatRuns.$inferSelect;
}

describe("resolveLedgerScopeForRun billing code propagation", () => {
  it("carries the issue's billing code onto the ledger scope", async () => {
    const { db } = makeDb([{ id: "issue-1", projectId: "project-1", billingCode: "ACME-42" }]);

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      issueId: "issue-1",
      projectId: "context-project",
    }));

    expect(scope).toEqual({
      issueId: "issue-1",
      projectId: "project-1",
      billingCode: "ACME-42",
    });
  });

  it("resolves a null billing code when the issue has none set", async () => {
    const { db } = makeDb([{ id: "issue-1", projectId: "project-1", billingCode: null }]);

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      issueId: "issue-1",
      projectId: "context-project",
    }));

    expect(scope.billingCode).toBeNull();
    expect(scope.issueId).toBe("issue-1");
  });

  it("resolves a null billing code without querying when the run has no issue in context", async () => {
    const { db, select } = makeDb([]);

    const scope = await resolveLedgerScopeForRun(db, "company-1", makeRun({
      projectId: "context-project",
    }));

    expect(scope).toEqual({
      issueId: null,
      projectId: "context-project",
      billingCode: null,
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("resolves a null billing code when the issue is not visible to the company", async () => {
    const { db } = makeDb([]);

    const scope = await resolveLedgerScopeForRun(db, "other-company", makeRun({
      issueId: "issue-1",
      projectId: "context-project",
    }));

    expect(scope).toEqual({
      issueId: null,
      projectId: "context-project",
      billingCode: null,
    });
  });
});
