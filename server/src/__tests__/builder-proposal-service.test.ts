import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { proposalService } from "../services/builder/proposal-service.js";
import {
  _resetBuilderToolExtensions,
  registerBuilderTool,
} from "../services/builder/tool-registry.js";
import { defineMutationTool } from "../services/builder/tools/mutation-tool.js";

// The proposal service performs read-modify-write on the proposal store and
// also calls activity-log + the originating tool's `apply()`. We mock those
// pieces so this test is hermetic.

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(async () => undefined),
  setPluginEventBus: vi.fn(),
}));

const mockProposals = new Map<string, Record<string, unknown>>();
function seedProposal(p: Record<string, unknown>): void {
  mockProposals.set(p.id as string, p);
}

vi.mock("../services/builder/proposal-store.js", () => {
  return {
    builderProposalStore: () => ({
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
    }),
  };
});

const companyId = "44444444-4444-4444-8444-444444444444";
const sessionId = "55555555-5555-4555-8555-555555555555";

afterEach(() => {
  _resetBuilderToolExtensions();
  mockProposals.clear();
});

describe("proposalService", () => {
  it("dispatches apply() to the matching mutation tool", async () => {
    const apply = vi.fn(async () => ({ summary: "ran", entityId: "ent-1", entityType: "thing" }));
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

    const svc = proposalService({} as unknown as Db);
    const result = await svc.apply(companyId, "p1", "user-1");

    expect(apply).toHaveBeenCalledOnce();
    expect((apply.mock.calls[0][0] as Record<string, unknown>).foo).toBe("bar");
    expect((result as { status: string } | null)?.status).toBe("applied");
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

    const svc = proposalService({} as unknown as Db);
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

    const svc = proposalService({} as unknown as Db);
    const result = await svc.reject(companyId, "p3", "user-1");

    expect(apply).not.toHaveBeenCalled();
    expect((result as { status: string } | null)?.status).toBe("rejected");
  });
});
