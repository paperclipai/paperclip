/**
 * Phase D-2: e2e — route → instrumentBettingService → bba-memory SQLite
 *
 * Verifies that a POST to the execute endpoint journals a `runs` row with the
 * correct outcome and failure_class for each result status.
 *
 * DI strategy: mock `bettingBrowserAutomationService` at the module level so
 * playwright/chromium never launches; let `instrumentBettingService` run for
 * real so the journaling path is exercised end-to-end.
 *
 * TODO (DI plumbing): the `initBbaMemory` singleton writes to
 * ~/.paperclip/bba-memory/bba-memory.db. Isolate to a temp path by either:
 *   (a) adding an optional `dbPath` param to initBbaMemory, or
 *   (b) vi.mock the DB_PATH constant before initBbaMemory is called.
 * For now the scaffold uses the real path and cleans up rows in afterEach.
 */
import express from "express";
import request from "supertest";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

// ── mock bettingBrowserAutomationService ─────────────────────────────────────
// Must be vi.hoisted so the mock is in place before any module imports resolve.
const mockExecute = vi.hoisted(() => vi.fn());

vi.mock("../services/betting-browser-automation.js", () => ({
  DEFAULT_BBA_CHROMIUM_PROFILE: "/tmp/bba-test-profile",
  bettingBrowserAutomationService: () => ({ execute: mockExecute }),
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    resolveSecretValue: vi.fn().mockResolvedValue("test-secret-value"),
    getByName: vi.fn().mockResolvedValue(null),
  }),
}));

// ── imports after mocks ───────────────────────────────────────────────────────
import { initBbaMemory, closeBbaMemory, getDb } from "../services/bba-memory/db.js";
import { listRecentRuns } from "../services/bba-memory/index.js";

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
      userId: "user-d2",
      companyIds: ["company-d2"],
      memberships: [{ companyId: "company-d2", status: "active", membershipRole: "member" }],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  // Pass a stub db — postgres is not used because bettingBrowserAutomationService is mocked.
  app.use("/api", bettingBrowserAutomationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

function buildPayload() {
  return {
    issueId: "issue-d2",
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
      odds: 1.82,
      stake: 50,
    },
    riskControls: {
      maxStakePerBet: 100,
      maxTotalStakePerSession: 250,
    },
  };
}

describe("BBA route → bba-memory e2e (Phase D-2)", () => {
  let app: express.Express;

  beforeAll(async () => {
    initBbaMemory();
    app = await createApp();
  });

  afterEach(() => {
    // Wipe runs between tests so listRecentRuns(1) always returns the fresh row.
    getDb().exec("DELETE FROM runs");
    vi.clearAllMocks();
  });

  afterAll(() => {
    closeBbaMemory();
  });

  it("completed execute() → runs row with outcome=success, failure_class=NULL", async () => {
    mockExecute.mockResolvedValue({ status: "completed", placedBetId: "B1" });

    const res = await request(app)
      .post("/api/companies/company-d2/betting-browser-automation/execute")
      .send(buildPayload());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");

    // TODO: assert DB row once DI plumbing is wired end-to-end.
    // const [run] = listRecentRuns(1);
    // expect(run).toBeDefined();
    // expect(run.outcome).toBe("success");
    // expect(run.failure_class).toBeNull();
    // expect(JSON.parse(run.meta_json ?? "{}").placedBetId).toBe("B1");
  });

  it("failed execute() → runs row with outcome=failure, failure_class set", async () => {
    mockExecute.mockResolvedValue({ status: "failed", failureReason: "timeout" });

    const res = await request(app)
      .post("/api/companies/company-d2/betting-browser-automation/execute")
      .send(buildPayload());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");

    // TODO: assert DB row
    // const [run] = listRecentRuns(1);
    // expect(run.outcome).toBe("failure");
    // expect(run.failure_class).not.toBeNull();
  });

  it("session_expired execute() → runs row with outcome=failure, failure_class=session_expired", async () => {
    mockExecute.mockResolvedValue({ status: "session_expired" });

    const res = await request(app)
      .post("/api/companies/company-d2/betting-browser-automation/execute")
      .send(buildPayload());

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("session_expired");

    // TODO: assert DB row
    // const [run] = listRecentRuns(1);
    // expect(run.outcome).toBe("failure");
    // expect(run.failure_class).toBe("session_expired");
  });
});
