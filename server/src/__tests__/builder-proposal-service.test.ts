import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { proposalService } from "../services/builder/proposal-service.js";
import { logActivity } from "../services/activity-log.js";
import {
  _resetBuilderToolExtensions,
  registerBuilderTool,
} from "../services/builder/tool-registry.js";
import { defineMutationTool } from "../services/builder/tools/mutation-tool.js";

const mockLoggerWarn = vi.hoisted(() => vi.fn());

// The proposal service performs read-modify-write on the proposal store and
// also calls activity-log + the originating tool's `apply()`. We mock those
// pieces so this test is hermetic.

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
  setPluginEventBus: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: mockLoggerWarn,
  },
}));

const mockProposals = new Map<string, Record<string, unknown>>();
function seedProposal(p: Record<string, unknown>): void {
  mockProposals.set(p.id as string, p);
}

vi.mock("../services/builder/proposal-store.js", () => {
  const defaultStore = {
    getById: vi.fn(async (_companyId: string, id: string) => mockProposals.get(id) ?? null),
    list: vi.fn(),
    pendingCount: vi.fn(),
    markApplied: vi.fn(async (id: string, decidedByUserId: string) => {
      const p = mockProposals.get(id);
      if (!p) return null;
      const next = { ...p, status: "applied", decidedByUserId, decidedAt: new Date() };
      mockProposals.set(id, next);
      return next;
    }),
    markRejected: vi.fn(async (id: string, decidedByUserId: string) => {
      const p = mockProposals.get(id);
      if (!p) return null;
      const next = { ...p, status: "rejected", decidedByUserId, decidedAt: new Date() };
      mockProposals.set(id, next);
      return next;
    }),
    markFailed: vi.fn(async (id: string, decidedByUserId: string, reason: string) => {
      const p = mockProposals.get(id);
      if (!p) return null;
      const next = {
        ...p,
        status: "failed",
        decidedByUserId,
        decidedAt: new Date(),
        failureReason: reason,
      };
      mockProposals.set(id, next);
      return next;
    }),
  };

  return {
    builderProposalStore: (db?: { __builderProposalStoreOverrides?: Record<string, unknown> }) => ({
      ...defaultStore,
      ...(db?.__builderProposalStoreOverrides ?? {}),
    }),
  };
});

const companyId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  _resetBuilderToolExtensions();
  mockProposals.clear();
  mockLoggerWarn.mockReset();
});

describe("proposalService", () => {
  it("blocks direct apply for approval-governed proposals", async () => {
    const apply = vi.fn(async () => ({ summary: "ran", entityId: "ent-0", entityType: "thing" }));
    const tool = defineMutationTool({
      name: "governed_thing",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      source: "test_extension0",
      buildPayload: () => ({}),
      summarize: () => "governed thing",
      apply,
      approvalType: "set_budget",
    });
    registerBuilderTool(tool);

    seedProposal({
      id: "p-governed",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "governed_thing",
      payload: {},
      status: "approved",
      approvalId: "approval-1",
    });

    const mockDb = {
      transaction: vi.fn(async (fn) => fn(mockDb)),
    } as unknown as Db;
    const svc = proposalService(mockDb);

    await expect(svc.apply(companyId, "p-governed", "user-1")).rejects.toThrow(
      "This proposal is approval-governed and must be resolved from the Approvals queue",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("dispatches apply() to the matching mutation tool", async () => {
    const apply = vi.fn(async () => ({
      summary: "ran",
      entityId: "ent-1",
      entityType: "thing",
      details: { surfaced: true },
    }));
    const tool = defineMutationTool({
      name: "do_thing",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      source: "test_extension",
      buildPayload: () => ({}),
      summarize: () => "do thing",
      apply,
    });
    registerBuilderTool(tool);

    seedProposal({
      id: "p1",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "do_thing",
      payload: { foo: "bar" },
      status: "pending",
    });

    const mockDb = {
      transaction: vi.fn(async (fn) => fn(mockDb)),
    } as unknown as Db;
    const svc = proposalService(mockDb);
    const result = await svc.apply(companyId, "p1", "user-1");

    expect(apply).toHaveBeenCalledOnce();
    expect((apply.mock.calls[0][0] as Record<string, unknown>).foo).toBe("bar");
    expect((result as { status: string } | null)?.status).toBe("applied");
    expect((result as { applyResult?: { details?: { surfaced?: boolean } } }).applyResult?.details?.surfaced).toBe(true);
  });

  it("persists only auditDetails to the activity log", async () => {
    const apply = vi.fn(async () => ({
      summary: "ran",
      entityId: "ent-2",
      entityType: "thing",
      details: { surfaced: true, token: "raw-secret" },
      auditDetails: { surfaced: true },
    }));
    const tool = defineMutationTool({
      name: "do_safe_thing",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      source: "test_extension",
      buildPayload: () => ({}),
      summarize: () => "do safe thing",
      apply,
    });
    registerBuilderTool(tool);

    seedProposal({
      id: "p-safe",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "do_safe_thing",
      payload: {},
      status: "pending",
    });

    const mockDb = {
      transaction: vi.fn(async (fn) => fn(mockDb)),
    } as unknown as Db;
    const svc = proposalService(mockDb);
    const result = await svc.apply(companyId, "p-safe", "user-1");

    expect((result as { applyResult?: { details?: { token?: string } } }).applyResult?.details?.token).toBe("raw-secret");
    expect(logActivity).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        details: expect.objectContaining({
          proposalId: "p-safe",
          surfaced: true,
        }),
      }),
    );
    expect(logActivity).not.toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        details: expect.objectContaining({
          token: "raw-secret",
        }),
      }),
    );
  });

  it("marks the proposal failed when no matching tool exists", async () => {
    seedProposal({
      id: "p2",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "ghost_tool",
      payload: {},
      status: "pending",
    });

    const mockDb = {
      transaction: vi.fn(async (fn) => fn(mockDb)),
    } as unknown as Db;
    const svc = proposalService(mockDb);
    await expect(svc.apply(companyId, "p2", "user-1")).rejects.toThrow(/No registered applier/);
  });

  it("rejects pending proposals without invoking the applier", async () => {
    const apply = vi.fn();
    const tool = defineMutationTool({
      name: "no_op",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      source: "test_extension2",
      buildPayload: () => ({}),
      summarize: () => "no op",
      apply,
    });
    registerBuilderTool(tool);

    seedProposal({
      id: "p3",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "no_op",
      payload: {},
      status: "pending",
    });

    const mockDb = {
      transaction: vi.fn(async (fn) => fn(mockDb)),
    } as unknown as Db;
    const svc = proposalService(mockDb);
    const result = await svc.reject(companyId, "p3", "user-1");

    expect(apply).not.toHaveBeenCalled();
    expect((result as { status: string } | null)?.status).toBe("rejected");
  });

  it("surfaces failed concurrent re-fetches without marking the proposal failed", async () => {
    const apply = vi.fn(async () => ({ summary: "ran", entityId: "ent-1", entityType: "thing" }));
    const tool = defineMutationTool({
      name: "concurrent_thing",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      source: "test_extension3",
      buildPayload: () => ({}),
      summarize: () => "concurrent thing",
      apply,
    });
    registerBuilderTool(tool);

    seedProposal({
      id: "p4",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "concurrent_thing",
      payload: {},
      status: "pending",
    });

    const outerGetById = vi
      .fn()
      .mockResolvedValueOnce(mockProposals.get("p4"))
      .mockRejectedValueOnce(new Error("transient read failure"));
    const markFailed = vi.fn();
    const txDb = {
      __builderProposalStoreOverrides: {
        markApplied: vi.fn(async () => null),
      },
    };
    const mockDb = {
      __builderProposalStoreOverrides: {
        getById: outerGetById,
        markFailed,
      },
      transaction: vi.fn(async (fn) => fn(txDb)),
    } as unknown as Db;

    const svc = proposalService(mockDb);
    await expect(svc.apply(companyId, "p4", "user-1")).rejects.toThrow(
      "concurrent apply: could not fetch current proposal",
    );

    expect(markFailed).not.toHaveBeenCalled();
  });

  it("preserves the original applier error when markFailed also fails", async () => {
    const apply = vi.fn(async () => {
      throw new Error("apply exploded");
    });
    const tool = defineMutationTool({
      name: "failing_thing",
      description: "x",
      parametersSchema: { type: "object" },
      capability: "test",
      source: "test_extension4",
      buildPayload: () => ({}),
      summarize: () => "failing thing",
      apply,
    });
    registerBuilderTool(tool);

    seedProposal({
      id: "p5",
      companyId,
      sessionId,
      messageId: "m1",
      kind: "failing_thing",
      payload: {},
      status: "pending",
    });

    const txDb = {
      __builderProposalStoreOverrides: {
        markFailed: vi.fn(async () => {
          throw new Error("markFailed exploded");
        }),
      },
    };
    const mockDb = {
      __builderProposalStoreOverrides: txDb.__builderProposalStoreOverrides,
      transaction: vi.fn(async (fn) => fn(mockDb)),
    } as unknown as Db;

    const svc = proposalService(mockDb);

    await expect(svc.apply(companyId, "p5", "user-1")).rejects.toThrow("apply exploded");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "p5",
        originalReason: "apply exploded",
      }),
      "builder proposal markFailed failed",
    );
  });
});
