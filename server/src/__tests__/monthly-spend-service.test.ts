import { beforeEach, describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.ts";
import { agentService } from "../services/agents.ts";

function createSelectSequenceDb(results: unknown[]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pending.shift() ?? []))),
  };

  return {
    db: {
      select: vi.fn(() => chain),
    },
  };
}

describe("monthly spend hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recomputes company spentMonthlyCents from the current utc month instead of returning stale stored values", async () => {
    const dbStub = createSelectSequenceDb([
      [{
        id: "company-1",
        name: "Paperclip",
        description: null,
        status: "active",
        issuePrefix: "PAP",
        issueCounter: 1,
        budgetMonthlyCents: 5000,
        spentMonthlyCents: 999999,
        requireBoardApprovalForNewAgents: false,
        brandColor: null,
        logoAssetId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      [{
        companyId: "company-1",
        spentMonthlyCents: 420,
      }],
    ]);

    const companies = companyService(dbStub.db as any);
    const [company] = await companies.list();

    expect(company.spentMonthlyCents).toBe(420);
  });

  it("recomputes agent spentMonthlyCents from the current utc month instead of returning stale stored values", async () => {
    const dbStub = createSelectSequenceDb([
      [{
        id: "agent-1",
        companyId: "company-1",
        name: "Budget Agent",
        role: "general",
        title: null,
        reportsTo: null,
        capabilities: null,
        adapterType: "claude-local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 5000,
        spentMonthlyCents: 999999,
        metadata: null,
        permissions: null,
        status: "idle",
        pauseReason: null,
        pausedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      [{
        id: "agent-1",
        companyId: "company-1",
        name: "Budget Agent",
        role: "general",
        title: null,
        reportsTo: null,
        capabilities: null,
        adapterType: "claude-local",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 5000,
        spentMonthlyCents: 999999,
        metadata: null,
        permissions: null,
        status: "idle",
        pauseReason: null,
        pausedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      [{
        agentId: "agent-1",
        spentMonthlyCents: 175,
      }],
    ]);

    const agents = agentService(dbStub.db as any);
    const agent = await agents.getById("agent-1");

    expect(agent?.spentMonthlyCents).toBe(175);
  });

  it("keeps raw secret-bearing agent config available for non-read service flows", async () => {
    const dbStub = createSelectSequenceDb([
      [{
        id: "agent-1",
        companyId: "company-1",
        name: "Budget Agent",
        role: "general",
        title: null,
        reportsTo: null,
        capabilities: null,
        adapterType: "claude-local",
        adapterConfig: {
          apiKey: "sk_live_secret",
          nested: {
            authToken: "token-123",
          },
          secretRef: {
            type: "secret_ref",
            secretId: "secret-1",
          },
        },
        runtimeConfig: {
          env: {
            API_KEY: "env-secret",
          },
        },
        budgetMonthlyCents: 5000,
        spentMonthlyCents: 999999,
        metadata: {
          privateNote: "keep-me-raw",
        },
        permissions: null,
        status: "idle",
        pauseReason: null,
        pausedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      [{
        agentId: "agent-1",
        spentMonthlyCents: 175,
      }],
    ]);

    const agents = agentService(dbStub.db as any);
    const agent = await agents.getById("agent-1");

    expect(agent?.adapterConfig).toEqual({
      apiKey: "sk_live_secret",
      nested: {
        authToken: "token-123",
      },
      secretRef: {
        type: "secret_ref",
        secretId: "secret-1",
      },
    });
    expect(agent?.runtimeConfig).toEqual({
      env: {
        API_KEY: "env-secret",
      },
    });
    expect(agent?.metadata).toEqual({
      privateNote: "keep-me-raw",
    });
  });
});
