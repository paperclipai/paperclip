import { describe, expect, it, vi } from "vitest";
import { createApprovalSchema } from "@paperclipai/shared";
import { evaluateMachineRecheckPredicate } from "./approval-recheck.ts";
import { approvalService } from "./approvals.ts";

describe("machine-condition board asks", () => {
  it("rejects creation without a recheck predicate or human judgement declaration", () => {
    const result = createApprovalSchema.safeParse({
      type: "request_board_approval",
      payload: { title: "Approve release" },
    });
    expect(result.success).toBe(false);
  });

  it("produces disproof evidence for a synthetically cleared condition", async () => {
    const result = await evaluateMachineRecheckPredicate({
      kind: "machine",
      probe: {
        kind: "command",
        command: [process.execPath, "-e", "process.exit(0)"],
        expectedExitCode: 1,
      },
    });

    expect(result.cleared).toBe(true);
    expect(result.note).toContain("disproof");
    expect(result.note).toContain("expected green exit 1");
  });

  it("auto-rejects a synthetically cleared open machine-condition ask with disproof", async () => {
    const approval = {
      id: "approval-1",
      type: "request_board_approval",
      status: "pending",
      payload: {
        recheckPredicate: {
          kind: "machine",
          probe: {
            kind: "command",
            command: [process.execPath, "-e", "process.exit(0)"],
            expectedExitCode: 1,
          },
        },
      },
    };
    const set = vi.fn(() => ({
      where: () => ({ returning: async () => [{ ...approval, status: "rejected" }] }),
    }));
    const db = {
      select: () => ({ from: () => ({ where: async () => [approval] }) }),
      update: () => ({ set }),
    };

    const result = await approvalService(db as any).sweepOpenMachineConditions();

    expect(result).toEqual({ evaluated: 1, rejected: 1 });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({
      status: "rejected",
      decisionNote: expect.stringContaining("disproof"),
    }));
  });
});
