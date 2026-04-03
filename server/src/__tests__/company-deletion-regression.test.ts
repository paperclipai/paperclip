import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.ts";

/**
 * HAP-4 behavioral regression: exercises companyService.remove() via a mock
 * DB that records every table passed to tx.delete(). After calling remove(),
 * asserts the critical FK ordering constraints.
 *
 * This calls the real service code and captures the actual delete order.
 */

const DRIZZLE_NAME = Symbol.for("drizzle:Name");

function getTableName(table: unknown): string {
  return String((table as Record<symbol, unknown>)[DRIZZLE_NAME] ?? "unknown");
}

function createTrackingMock() {
  const deleteLog: string[] = [];
  let companyRows: Array<{ id: string; name: string }> = [{ id: "c1", name: "Test" }];

  const deleteFn = (table: unknown) => {
    const name = getTableName(table);
    deleteLog.push(name);
    const rows = name === "companies" ? companyRows : undefined;
    return {
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
      returning: vi.fn().mockResolvedValue(rows),
    };
  };

  const tx = {
    delete: vi.fn(deleteFn),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  const db = {
    transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  return { db, deleteLog, tx, setCompanyRows: (r: typeof companyRows) => { companyRows = r; } };
}

describe("companyService.remove() behavioral FK ordering (HAP-4)", () => {
  let tracking: ReturnType<typeof createTrackingMock>;

  beforeEach(() => {
    tracking = createTrackingMock();
    vi.clearAllMocks();
  });

  async function runRemove(id = "c1") {
    return companyService(tracking.db as never).remove(id);
  }

  it("feedback_votes deleted before issues (issue_id FK, no onDelete)", async () => {
    await runRemove();
    const fv = tracking.deleteLog.indexOf("feedback_votes");
    const is = tracking.deleteLog.indexOf("issues");
    expect(fv).toBeGreaterThanOrEqual(0);
    expect(is).toBeGreaterThanOrEqual(0);
    expect(fv).toBeLessThan(is);
  });

  it("budget_incidents deleted before approvals (approval_id FK, no onDelete)", async () => {
    await runRemove();
    const bi = tracking.deleteLog.indexOf("budget_incidents");
    const ap = tracking.deleteLog.indexOf("approvals");
    expect(bi).toBeGreaterThanOrEqual(0);
    expect(ap).toBeGreaterThanOrEqual(0);
    expect(bi).toBeLessThan(ap);
  });

  it("budget_incidents deleted before budget_policies (policy_id FK, no onDelete)", async () => {
    await runRemove();
    const bi = tracking.deleteLog.indexOf("budget_incidents");
    const bp = tracking.deleteLog.indexOf("budget_policies");
    expect(bi).toBeGreaterThanOrEqual(0);
    expect(bp).toBeGreaterThanOrEqual(0);
    expect(bi).toBeLessThan(bp);
  });

  it("projects deleted before goals", async () => {
    await runRemove();
    const pr = tracking.deleteLog.indexOf("projects");
    const gl = tracking.deleteLog.indexOf("goals");
    expect(pr).toBeGreaterThanOrEqual(0);
    expect(gl).toBeGreaterThanOrEqual(0);
    expect(pr).toBeLessThan(gl);
  });

  it("all 10 accepted hard-blocker tables are in the delete sequence", async () => {
    await runRemove();
    const required = [
      "company_skills", "budget_policies", "budget_incidents", "feedback_votes",
      "issue_read_states", "issue_inbox_archives", "workspace_operations",
      "workspace_runtime_services", "documents", "document_revisions",
    ];
    for (const t of required) {
      expect(tracking.deleteLog).toContain(t);
    }
  });

  it("companies is the last table deleted", async () => {
    await runRemove();
    expect(tracking.deleteLog[tracking.deleteLog.length - 1]).toBe("companies");
  });

  it("returns deleted company on success", async () => {
    const result = await runRemove();
    expect(result).toEqual({ id: "c1", name: "Test" });
  });

  it("returns null when company not found", async () => {
    tracking.setCompanyRows([]);
    const result = await runRemove();
    expect(result).toBeNull();
  });
});
