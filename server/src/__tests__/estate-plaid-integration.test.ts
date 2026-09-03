import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { Db } from "@paperclipai/db";
import { estateRoutes, type PlaidClient } from "../routes/estate.js";
import { errorHandler } from "../middleware/error-handler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function boardActor(companyId = "company-1") {
  return {
    type: "board" as const,
    source: "local_implicit" as const,
    userId: "user-1",
    companyIds: [companyId],
  };
}

function createApp(db: Db, plaidClient?: PlaidClient | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = boardActor();
    next();
  });
  app.use(estateRoutes(db, plaidClient));
  app.use(errorHandler);
  return app;
}

const NOW = new Date("2026-01-01T00:00:00.000Z");

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "account-1",
    companyId: "company-1",
    userId: "user-1",
    name: "Checking",
    institutionName: "Big Bank",
    accountType: "checking",
    entityId: null,
    plaidAccessToken: "access-sandbox-xxx",
    plaidItemId: "item-123",
    plaidAccountId: "plaid-acct-1",
    balanceCents: "500000",
    balanceUpdatedAt: NOW,
    isManual: false,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePlaidAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "plaid-acct-1",
    name: "Checking",
    balanceCents: 500000,
    accountType: "checking",
    institutionName: "Big Bank",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// POST /estate/integrations/plaid/link-token
// ---------------------------------------------------------------------------

describe("POST /estate/integrations/plaid/link-token", () => {
  it("returns a link token from the Plaid client", async () => {
    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn().mockResolvedValue({
        linkToken: "link-sandbox-token-abc",
        expiration: "2026-01-01T01:00:00Z",
      }),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn(),
    };

    const db = {} as unknown as Db;
    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/link-token")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.linkToken).toBe("link-sandbox-token-abc");
    expect(res.body.expiration).toBe("2026-01-01T01:00:00Z");
    expect(plaidClient.createLinkToken).toHaveBeenCalledWith("user-1");
  });

  it("returns 503 when no Plaid client is configured", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db, null))
      .post("/estate/integrations/plaid/link-token")
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });

  it("returns 403 when actor is not board type", async () => {
    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn(),
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: "agent-1", companyId: "company-1" } as never;
      next();
    });
    app.use(estateRoutes({} as unknown as Db, plaidClient));
    app.use(errorHandler);

    const res = await request(app).post("/estate/integrations/plaid/link-token").send({});
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /estate/integrations/plaid/exchange
// ---------------------------------------------------------------------------

describe("POST /estate/integrations/plaid/exchange", () => {
  it("exchanges token, creates new accounts, and returns them (201)", async () => {
    const acct = makeAccount();
    const plaidAcct = makePlaidAccount();

    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn().mockResolvedValue({
        accessToken: "access-sandbox-xxx",
        itemId: "item-123",
      }),
      getAccountBalances: vi.fn().mockResolvedValue([plaidAcct]),
    };

    // DB: select (no existing account), insert, balance history insert
    let selectCallCount = 0;
    const whereMock = vi.fn().mockImplementation(() => {
      selectCallCount++;
      return Promise.resolve(selectCallCount === 1 ? [] : []);
    });
    const returningMock = vi.fn().mockResolvedValue([{ ...acct, plaidAccessToken: undefined }]);
    const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
    const balanceValuesMock = vi.fn().mockResolvedValue([]);

    let insertCallCount = 0;
    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: whereMock,
      insert: vi.fn().mockImplementation(() => {
        insertCallCount++;
        // first insert = financial account; second = balance history
        if (insertCallCount === 1) {
          return { values: valuesMock };
        }
        return { values: vi.fn().mockResolvedValue([]) };
      }),
    } as unknown as Db;

    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/exchange")
      .send({ publicToken: "public-sandbox-token", companyId: "company-1", institutionName: "Big Bank" });

    expect(res.status).toBe(201);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].plaidAccessToken).toBeUndefined();
    expect(plaidClient.exchangePublicToken).toHaveBeenCalledWith("public-sandbox-token");
    expect(plaidClient.getAccountBalances).toHaveBeenCalledWith("access-sandbox-xxx", "Big Bank");
  });

  it("updates existing account when plaidAccountId matches (200 in accounts list)", async () => {
    const acct = makeAccount();
    const plaidAcct = makePlaidAccount({ balanceCents: 750000 });

    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn().mockResolvedValue({
        accessToken: "access-sandbox-xxx",
        itemId: "item-123",
      }),
      getAccountBalances: vi.fn().mockResolvedValue([plaidAcct]),
    };

    const updatedAcct = { ...acct, balanceCents: "750000", plaidAccessToken: undefined };
    const updateWhereMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([updatedAcct]),
    });

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([acct]), // existing account found
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({ where: updateWhereMock }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/exchange")
      .send({ publicToken: "public-sandbox-token", companyId: "company-1" });

    expect(res.status).toBe(201);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].balanceCents).toBe("750000");
    expect(res.body.accounts[0].plaidAccessToken).toBeUndefined();
  });

  it("returns 400 when publicToken is missing", async () => {
    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn(),
    };
    const db = {} as unknown as Db;
    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/exchange")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when companyId is missing", async () => {
    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn(),
    };
    const db = {} as unknown as Db;
    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/exchange")
      .send({ publicToken: "public-token" });

    expect(res.status).toBe(400);
  });

  it("returns 503 when no Plaid client is configured", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db, null))
      .post("/estate/integrations/plaid/exchange")
      .send({ publicToken: "public-token", companyId: "company-1" });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// POST /estate/integrations/plaid/refresh
// ---------------------------------------------------------------------------

describe("POST /estate/integrations/plaid/refresh", () => {
  it("re-fetches balances and returns updated accounts", async () => {
    const acct = makeAccount();
    const freshPlaid = makePlaidAccount({ balanceCents: 600000 });

    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn().mockResolvedValue([freshPlaid]),
    };

    const updatedAcct = { ...acct, balanceCents: "600000", plaidAccessToken: undefined };
    const updateWhereMock = vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([updatedAcct]),
    });

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([acct]),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnValue({ where: updateWhereMock }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) }),
    } as unknown as Db;

    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/refresh")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(res.body.accounts[0].balanceCents).toBe("600000");
    expect(res.body.accounts[0].plaidAccessToken).toBeUndefined();
    expect(res.body.refreshed).toBe(1);
    expect(plaidClient.getAccountBalances).toHaveBeenCalledWith("access-sandbox-xxx", "Big Bank");
  });

  it("returns empty when no Plaid-linked accounts exist", async () => {
    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn(),
    };

    const db = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Db;

    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/refresh")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(0);
    expect(res.body.refreshed).toBe(0);
    expect(plaidClient.getAccountBalances).not.toHaveBeenCalled();
  });

  it("returns 400 when companyId is missing", async () => {
    const plaidClient: PlaidClient = {
      createLinkToken: vi.fn(),
      exchangePublicToken: vi.fn(),
      getAccountBalances: vi.fn(),
    };
    const db = {} as unknown as Db;

    const res = await request(createApp(db, plaidClient))
      .post("/estate/integrations/plaid/refresh")
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 503 when Plaid client is not configured", async () => {
    const db = {} as unknown as Db;
    const res = await request(createApp(db, null))
      .post("/estate/integrations/plaid/refresh")
      .send({ companyId: "company-1" });

    expect(res.status).toBe(503);
  });
});
