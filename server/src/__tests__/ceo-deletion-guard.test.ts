import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

/**
 * CEO deletion protection and self-deletion prevention guards.
 * Tests agentService.terminate() and agentService.remove().
 */

function createMockDb(agentRows: Record<string, unknown>[]) {
  const selectChain = {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        groupBy: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) =>
            Promise.resolve(cb(agentRows)),
          ),
        }),
        then: vi.fn().mockImplementation((cb: (r: unknown[]) => unknown) =>
          Promise.resolve(cb(agentRows)),
        ),
      }),
    }),
  };
  return {
    select: vi.fn().mockReturnValue(selectChain),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockReturnValue({
            then: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    transaction: vi.fn(),
  } as any;
}

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1", companyId: "c1", name: "Test", role: "engineer",
    title: null, icon: null, status: "running", reportsTo: null,
    capabilities: null, adapterType: "claude_local", adapterConfig: {},
    runtimeConfig: {}, budgetMonthlyCents: 0, spentMonthlyCents: 0,
    pauseReason: null, pausedAt: null, permissions: { canCreateAgents: false },
    lastHeartbeatAt: null, metadata: null, createdAt: new Date(),
    updatedAt: new Date(), urlKey: "test", ...overrides,
  };
}

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(), and: vi.fn(), desc: vi.fn(), gte: vi.fn(),
  inArray: vi.fn(), lt: vi.fn(), ne: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn(), join: vi.fn() }),
}));

vi.mock("@paperclipai/db", () => ({
  agents: { id: "a.id", companyId: "a.cid", reportsTo: "a.rt" },
  agentConfigRevisions: { agentId: "x" }, agentApiKeys: { agentId: "x" },
  agentRuntimeState: { agentId: "x" }, agentTaskSessions: { agentId: "x" },
  agentWakeupRequests: { agentId: "x" }, costEvents: { agentId: "x" },
  heartbeatRunEvents: { agentId: "x" }, heartbeatRuns: { agentId: "x" },
}));

vi.mock("@paperclipai/shared", () => ({
  isUuidLike: vi.fn(() => true),
  normalizeAgentUrlKey: vi.fn((s: string) => s),
}));

vi.mock("../redaction.js", () => ({
  REDACTED_EVENT_VALUE: "[REDACTED]",
  sanitizeRecord: vi.fn((r: unknown) => r),
}));

vi.mock("./agent-permissions.js", () => ({
  normalizeAgentPermissions: vi.fn((p: unknown) => p ?? { canCreateAgents: false }),
}));

const { agentService } = await import("../services/agents.js");

describe("CEO deletion protection", () => {
  describe("terminate", () => {
    it("throws when target is CEO", async () => {
      const svc = agentService(createMockDb([makeAgent({ id: "ceo", role: "ceo" })]));
      await expect(svc.terminate("ceo")).rejects.toThrow(HttpError);
      await expect(svc.terminate("ceo")).rejects.toThrow(/Cannot terminate the CEO/);
    });

    it("throws on self-termination", async () => {
      const svc = agentService(createMockDb([makeAgent({ id: "a1" })]));
      await expect(svc.terminate("a1", "a1")).rejects.toThrow(/cannot terminate itself/);
    });

    it("returns null for missing agent", async () => {
      const svc = agentService(createMockDb([]));
      expect(await svc.terminate("x")).toBeNull();
    });

    it("allows non-CEO by different agent", async () => {
      const svc = agentService(createMockDb([makeAgent({ id: "a1" })]));
      await expect(svc.terminate("a1", "a2")).resolves.not.toThrow();
    });
  });

  describe("remove", () => {
    it("throws when target is CEO", async () => {
      const svc = agentService(createMockDb([makeAgent({ id: "ceo", role: "ceo" })]));
      await expect(svc.remove("ceo")).rejects.toThrow(HttpError);
      await expect(svc.remove("ceo")).rejects.toThrow(/Cannot delete the CEO/);
    });

    it("throws on self-deletion", async () => {
      const svc = agentService(createMockDb([makeAgent({ id: "a1" })]));
      await expect(svc.remove("a1", "a1")).rejects.toThrow(/cannot delete itself/);
    });

    it("returns null for missing agent", async () => {
      const svc = agentService(createMockDb([]));
      expect(await svc.remove("x")).toBeNull();
    });
  });
});
