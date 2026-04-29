import { describe, expect, it, vi } from "vitest";
import { acceptanceCriteriaService } from "../services/acceptance-criteria.ts";

function createCriterionRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-04-29T00:00:00.000Z");
  return {
    id: "criterion-1",
    companyId: "company-1",
    issueId: "issue-1",
    text: "Acceptance criterion",
    state: "pending",
    notes: null,
    position: 0,
    evidenceWorkProductId: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdByRunId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    resolvedByRunId: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function buildSelectChain(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  return { from, where };
}

describe("acceptanceCriteriaService.createForIssue", () => {
  it("appends a criterion at the next position when none provided", async () => {
    const insertedRow = createCriterionRow({ position: 3 });

    const countSelect = buildSelectChain([{ count: 2 }]);
    const maxSelect = buildSelectChain([{ maxPosition: 2 }]);
    const txSelect = vi.fn()
      .mockImplementationOnce(() => ({ from: countSelect.from }))
      .mockImplementationOnce(() => ({ from: maxSelect.from }));

    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = { select: txSelect, insert: txInsert };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "company-1", { text: "  Ship it  " });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: "company-1",
        issueId: "issue-1",
        text: "Ship it",
        state: "pending",
        position: 3,
      }),
    );
    expect(result.id).toBe("criterion-1");
    expect(result.state).toBe("pending");
  });

  it("rejects creation when issue already has the per-issue maximum", async () => {
    const countSelect = buildSelectChain([{ count: 50 }]);
    const txSelect = vi.fn(() => ({ from: countSelect.from }));
    const tx = { select: txSelect, insert: vi.fn() };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);

    await expect(svc.createForIssue("issue-1", "company-1", { text: "x" })).rejects.toThrow(
      /maximum/,
    );
  });

  it("stamps resolution metadata when created already in a resolved state", async () => {
    const insertedRow = createCriterionRow({ state: "met" });

    const countSelect = buildSelectChain([{ count: 0 }]);
    const maxSelect = buildSelectChain([{ maxPosition: null }]);
    const txSelect = vi.fn()
      .mockImplementationOnce(() => ({ from: countSelect.from }))
      .mockImplementationOnce(() => ({ from: maxSelect.from }));

    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = { select: txSelect, insert: txInsert };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);
    await svc.createForIssue("issue-1", "company-1", {
      text: "Build PR opened",
      state: "met",
      actor: { userId: "user-7" },
    });

    const insertedValues = insertValues.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedValues.state).toBe("met");
    expect(insertedValues.resolvedByUserId).toBe("user-7");
    expect(insertedValues.resolvedAt).toBeInstanceOf(Date);
  });
});

describe("acceptanceCriteriaService.setState", () => {
  it("clears resolution fields when transitioning back to pending", async () => {
    const existing = createCriterionRow({
      state: "met",
      resolvedAt: new Date("2026-04-28T00:00:00.000Z"),
      resolvedByUserId: "user-1",
    });
    const after = createCriterionRow({ state: "pending" });

    const select = buildSelectChain([existing]);
    const txSelect = vi.fn(() => ({ from: select.from }));
    const updateReturning = vi.fn(async () => [after]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = { select: txSelect, update: txUpdate };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);
    const result = await svc.setState("criterion-1", { state: "pending" });

    const patch = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.state).toBe("pending");
    expect(patch.resolvedAt).toBeNull();
    expect(patch.resolvedByAgentId).toBeNull();
    expect(patch.resolvedByUserId).toBeNull();
    expect(patch.resolvedByRunId).toBeNull();
    expect(result.state).toBe("pending");
  });

  it("stamps resolution fields when transitioning to met", async () => {
    const existing = createCriterionRow({ state: "pending" });
    const after = createCriterionRow({ state: "met" });

    const select = buildSelectChain([existing]);
    const txSelect = vi.fn(() => ({ from: select.from }));
    const updateReturning = vi.fn(async () => [after]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = { select: txSelect, update: txUpdate };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);
    await svc.setState("criterion-1", {
      state: "met",
      actor: { agentId: "agent-9", runId: "run-3" },
    });

    const patch = updateSet.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(patch.state).toBe("met");
    expect(patch.resolvedByAgentId).toBe("agent-9");
    expect(patch.resolvedByRunId).toBe("run-3");
    expect(patch.resolvedAt).toBeInstanceOf(Date);
  });

  it("rejects evidence belonging to a different issue", async () => {
    const existing = createCriterionRow();
    const evidence = {
      id: "wp-1",
      companyId: "company-1",
      issueId: "issue-OTHER",
    };

    const select = buildSelectChain([existing]);
    const evidenceSelect = buildSelectChain([evidence]);
    const txSelect = vi.fn()
      .mockImplementationOnce(() => ({ from: select.from }))
      .mockImplementationOnce(() => ({ from: evidenceSelect.from }));

    const tx = { select: txSelect, update: vi.fn() };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);
    await expect(
      svc.setState("criterion-1", { state: "met", evidenceWorkProductId: "wp-1" }),
    ).rejects.toThrow(/does not belong/);
  });
});

describe("acceptanceCriteriaService.bulkCreateForIssue", () => {
  it("inserts each text at incrementing positions and trims input", async () => {
    const countSelect = buildSelectChain([{ count: 1 }]);
    const maxSelect = buildSelectChain([{ maxPosition: 4 }]);
    const txSelect = vi.fn()
      .mockImplementationOnce(() => ({ from: countSelect.from }))
      .mockImplementationOnce(() => ({ from: maxSelect.from }));

    const insertedRows = [
      createCriterionRow({ id: "c1", text: "a", position: 5 }),
      createCriterionRow({ id: "c2", text: "b", position: 6 }),
    ];
    const insertReturning = vi.fn(async () => insertedRows);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = { select: txSelect, insert: txInsert };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => callback(tx));

    const svc = acceptanceCriteriaService({ transaction } as any);
    const result = await svc.bulkCreateForIssue("issue-1", "company-1", ["  a  ", "", "b"]);

    const valuesArg = insertValues.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(valuesArg).toHaveLength(2);
    expect(valuesArg[0]).toMatchObject({ text: "a", position: 5, state: "pending" });
    expect(valuesArg[1]).toMatchObject({ text: "b", position: 6, state: "pending" });
    expect(result).toHaveLength(2);
  });

  it("returns an empty array when all texts are blank", async () => {
    const transaction = vi.fn();
    const svc = acceptanceCriteriaService({ transaction } as any);
    const result = await svc.bulkCreateForIssue("issue-1", "company-1", ["", "  "]);
    expect(result).toEqual([]);
    expect(transaction).not.toHaveBeenCalled();
  });
});
