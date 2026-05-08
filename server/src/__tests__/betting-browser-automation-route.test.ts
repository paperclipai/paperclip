import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockExecute = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  resolveSecretValue: vi.fn(),
  getByName: vi.fn(),
}));

vi.mock("../services/betting-browser-automation.js", () => ({
  DEFAULT_BBA_CHROMIUM_PROFILE: "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile",
  bettingBrowserAutomationService: () => ({
    execute: mockExecute,
  }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

async function createApp() {
  const [{ errorHandler }, { bettingBrowserAutomationRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/betting-browser-automation.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", status: "active", membershipRole: "member" }],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", bettingBrowserAutomationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildPayload() {
  return {
    issueId: "issue-1",
    loginUsername: { secretName: "BBA_USERNAME" },
    loginPassword: { secretName: "BBA_PASSWORD" },
    bookmakerConfig: {
      bookmaker: "Casa Pariurilor",
      baseUrl: "https://example.test",
      loginUrl: "https://example.test/login",
      username: { selectors: ["#user"] },
      password: { selectors: ["#pass"] },
      loginSubmit: { selectors: ["button[type=submit]"] },
      selectionButton: { selectors: ["text={{selection}}"] },
      stakeInput: { selectors: ["input[name=stake]"] },
      reviewButton: { selectors: ["text=Review"] },
    },
    bet: {
      matchLabel: "PSV vs Ajax",
      market: "1X2",
      selection: "PSV",
      selectionHint: "PSV Eindhoven",
      odds: 1.82,
      stake: 50,
      eventUrl: "https://example.test/events/psv-ajax",
    },
    riskControls: {
      maxStakePerBet: 100,
      maxTotalStakePerSession: 250,
    },
  };
}

describe("betting browser automation route", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockExecute.mockResolvedValue({ status: "awaiting_confirmation" });
  });

  it("parses typed execution options before invoking the service", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/betting-browser-automation/execute")
      .send({
        ...buildPayload(),
        bookmakerConfig: {
          ...buildPayload().bookmakerConfig,
          historyUrl: "https://example.test/account/history",
          historyReady: { selectors: ["text=My Bets"] },
          historySelection: { selectors: ["text=PSV history row"] },
        },
        execution: {
          browserName: "chromium",
          userDataDir: "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile",
          skipLogin: true,
          headless: false,
          startUrl: "https://example.test/preauth-home",
          sessionTimeoutMs: 60_000,
          pageTimeoutMs: 30_000,
          actionDelayMinMs: 3_000,
          actionDelayMaxMs: 15_000,
          retryDelayMinMs: 20_000,
          retryDelayMaxMs: 30_000,
          minClickIntervalMs: 3_000,
          sessionLabel: "casa-live",
          finalConfirmation: {
            confirmed: true,
            confirmedBy: "ceo",
            approvedOdds: 1.85,
            oddsDriftTolerancePct: 5,
          },
        },
      });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      companyId: "company-1",
      execution: {
        browserName: "chromium",
        userDataDir: "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile",
        skipLogin: true,
        headless: false,
        startUrl: "https://example.test/preauth-home",
        sessionTimeoutMs: 60_000,
        pageTimeoutMs: 30_000,
        actionDelayMinMs: 3_000,
        actionDelayMaxMs: 15_000,
        retryDelayMinMs: 20_000,
        retryDelayMaxMs: 30_000,
        minClickIntervalMs: 3_000,
        sessionLabel: "casa-live",
        finalConfirmation: {
          confirmed: true,
          confirmedBy: "ceo",
          approvedOdds: 1.85,
          oddsDriftTolerancePct: 5,
        },
      },
      bookmakerConfig: expect.objectContaining({
        historyUrl: "https://example.test/account/history",
        historyReady: { selectors: ["text=My Bets"] },
        historySelection: { selectors: ["text=PSV history row"] },
      }),
      bet: expect.objectContaining({
        selectionHint: "PSV Eindhoven",
        eventUrl: "https://example.test/events/psv-ajax",
      }),
    }));
  });

  it("forces chromium persistent-profile execution for pre-authenticated sessions", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/betting-browser-automation/execute")
      .send({
        ...buildPayload(),
        execution: {
          browserName: "firefox",
          userDataDir: "C:\\tmp\\wrong-profile",
          skipLogin: true,
        },
      });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({
        browserName: "chromium",
        userDataDir: "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile",
        skipLogin: true,
      }),
    }));
  });

  it("fills the default chromium profile when pre-auth execution omits userDataDir", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/betting-browser-automation/execute")
      .send({
        ...buildPayload(),
        execution: {
          skipLogin: true,
        },
      });

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      execution: expect.objectContaining({
        browserName: "chromium",
        userDataDir: "C:\\Users\\thepr\\.paperclip\\bba-playwright-profile",
        skipLogin: true,
      }),
    }));
  });

  it("rejects invalid execution.browserName values at the API boundary", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/betting-browser-automation/execute")
      .send({
        ...buildPayload(),
        execution: {
          browserName: "webkit",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/execution\.browserName/i);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects non-boolean execution flags before they reach the service", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/betting-browser-automation/execute")
      .send({
        ...buildPayload(),
        execution: {
          skipLogin: "true",
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/execution\.skipLogin/i);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("rejects non-boolean final confirmation flags before they reach the service", async () => {
    const app = await createApp();
    const res = await request(app)
      .post("/api/companies/company-1/betting-browser-automation/execute")
      .send({
        ...buildPayload(),
        execution: {
          finalConfirmation: {
            confirmed: "false",
          },
        },
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/execution\.finalConfirmation\.confirmed/i);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
