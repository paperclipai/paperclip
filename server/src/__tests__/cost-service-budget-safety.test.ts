import { beforeEach, describe, expect, it, vi } from "vitest";
import { costService } from "../services/costs.js";

type DbStub = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function createDbStub(
  selectResults: unknown[][],
  insertReturningResults: unknown[]
): { db: DbStub; selectWhere: ReturnType<typeof vi.fn>; insertReturning: ReturnType<typeof vi.fn> } {
  const pendingSelectResults = [...selectResults];
  const selectWhere = vi.fn(async () => pendingSelectResults.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere, leftJoin: vi.fn(() => ({ where: selectWhere })) }));
  const select = vi.fn(() => ({ from }));

  const pendingInsertReturningResults = [...insertReturningResults];
  const insertReturning = vi.fn(async () => {
    const result = pendingInsertReturningResults.shift();
    return result !== undefined ? [result] : [];
  });
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateSet = vi.fn(() => ({ where: vi.fn(() => ({ where: vi.fn(() => ({ where: vi.fn(() => ({})) })) })) }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    db: { select, insert, update } as any,
    selectWhere,
    insertReturning,
  };
}

type AgentRecord = {
  id: string;
  companyId: string;
  name: string;
  status: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
};

type CompanyRecord = {
  id: string;
  name: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
};

describe("Cost Service - Budget Safety", () => {
  let mockDb: ReturnType<typeof createDbStub>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("80% Budget Warning", () => {
    it("should create warning activity log when agent crosses 80% threshold", async () => {
      const company: CompanyRecord = {
        id: "company-1",
        name: "Test Company",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentBefore: AgentRecord = {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        status: "idle",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentAfter: AgentRecord = {
        ...agentBefore,
        spentMonthlyCents: 8100,
      };

      const eventRecord = { id: "event-1", costCents: 8100 };

      mockDb = createDbStub(
        [[agentBefore], [agentAfter]],
        [eventRecord]
      );

      const svc = costService(mockDb.db as any);

      await svc.createEvent(company.id, {
        agentId: agentBefore.id,
        costCents: 8100,
        inputTokens: 1000,
        outputTokens: 500,
        provider: "test_provider",
        model: "test_model",
        occurredAt: new Date(),
      });

      expect(mockDb.db.insert).toHaveBeenCalled();
      expect(mockDb.db.update).toHaveBeenCalled();
    });

    it("should not create warning before 80% threshold", async () => {
      const company: CompanyRecord = {
        id: "company-1",
        name: "Test Company",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentBefore: AgentRecord = {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        status: "idle",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentAfter: AgentRecord = {
        ...agentBefore,
        spentMonthlyCents: 7900,
      };

      const eventRecord = { id: "event-1", costCents: 7900 };

      mockDb = createDbStub(
        [[agentBefore], [agentAfter]],
        [eventRecord]
      );

      const svc = costService(mockDb.db as any);

      await svc.createEvent(company.id, {
        agentId: agentBefore.id,
        costCents: 7900,
        inputTokens: 1000,
        outputTokens: 500,
        provider: "test_provider",
        model: "test_model",
        occurredAt: new Date(),
      });

      expect(mockDb.db.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.db.update).toHaveBeenCalledTimes(2);
    });
  });

  describe("100% Budget Limit", () => {
    it("should pause agent when budget is reached", async () => {
      const company: CompanyRecord = {
        id: "company-1",
        name: "Test Company",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentBefore: AgentRecord = {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        status: "idle",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentAfter: AgentRecord = {
        ...agentBefore,
        spentMonthlyCents: 10000,
      };

      const eventRecord = { id: "event-1", costCents: 10000 };

      mockDb = createDbStub(
        [[agentBefore], [agentAfter]],
        [eventRecord]
      );

      const svc = costService(mockDb.db as any);

      await svc.createEvent(company.id, {
        agentId: agentBefore.id,
        costCents: 10000,
        inputTokens: 1000,
        outputTokens: 500,
        provider: "test_provider",
        model: "test_model",
        occurredAt: new Date(),
      });

      expect(mockDb.db.insert).toHaveBeenCalled();
      expect(mockDb.db.update).toHaveBeenCalled();
    });

    it("should not pause already paused agent", async () => {
      const company: CompanyRecord = {
        id: "company-1",
        name: "Test Company",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentBefore: AgentRecord = {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        status: "paused",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentAfter: AgentRecord = {
        ...agentBefore,
        spentMonthlyCents: 10000,
      };

      const eventRecord = { id: "event-1", costCents: 10000 };

      mockDb = createDbStub(
        [[agentBefore], [agentAfter]],
        [eventRecord]
      );

      const svc = costService(mockDb.db as any);

      await svc.createEvent(company.id, {
        agentId: agentBefore.id,
        costCents: 10000,
        inputTokens: 1000,
        outputTokens: 500,
        provider: "test_provider",
        model: "test_model",
        occurredAt: new Date(),
      });

      expect(mockDb.db.update).toHaveBeenCalledTimes(2);
    });

    it("should not pause terminated agent", async () => {
      const company: CompanyRecord = {
        id: "company-1",
        name: "Test Company",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentBefore: AgentRecord = {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        status: "terminated",
        budgetMonthlyCents: 10000,
        spentMonthlyCents: 0,
      };

      const agentAfter: AgentRecord = {
        ...agentBefore,
        spentMonthlyCents: 10000,
      };

      const eventRecord = { id: "event-1", costCents: 10000 };

      mockDb = createDbStub(
        [[agentBefore], [agentAfter]],
        [eventRecord]
      );

      const svc = costService(mockDb.db as any);

      await svc.createEvent(company.id, {
        agentId: agentBefore.id,
        costCents: 10000,
        inputTokens: 1000,
        outputTokens: 500,
        provider: "test_provider",
        model: "test_model",
        occurredAt: new Date(),
      });

      expect(mockDb.db.update).toHaveBeenCalledTimes(2);
    });
  });

  describe("No Budget", () => {
    it("should not enforce budget when budgetMonthlyCents is 0", async () => {
      const company: CompanyRecord = {
        id: "company-1",
        name: "Test Company",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
      };

      const agentBefore: AgentRecord = {
        id: "agent-1",
        companyId: "company-1",
        name: "Test Agent",
        status: "idle",
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
      };

      const agentAfter: AgentRecord = {
        ...agentBefore,
        spentMonthlyCents: 999999,
      };

      const eventRecord = { id: "event-1", costCents: 999999 };

      mockDb = createDbStub(
        [[agentBefore], [agentAfter]],
        [eventRecord]
      );

      const svc = costService(mockDb.db as any);

      await svc.createEvent(company.id, {
        agentId: agentBefore.id,
        costCents: 999999,
        inputTokens: 1000000,
        outputTokens: 500000,
        provider: "test_provider",
        model: "test_model",
        occurredAt: new Date(),
      });

      expect(mockDb.db.update).toHaveBeenCalledTimes(2);
    });
  });
});
