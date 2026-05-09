/**
 * Regression test for GLA-1074: PAT must not appear in 502 response body,
 * persisted lastError, or plugin_logs.meta.error when GitHub returns an error
 * that echoes the token verbatim.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SYNTHETIC_PAT = "ghp_SYNTHETICTOKEN1234567890abcdefGHI";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ISSUE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PLUGIN_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SECRET_REF = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const mockRegistry = vi.hoisted(() => ({
  getByKey: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockSecrets = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

const mockIssues = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockStateStore = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecrets,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssues,
}));

vi.mock("../services/plugin-state-store.js", () => ({
  pluginStateStore: () => mockStateStore,
}));

vi.mock("../services/goals.js", () => ({
  goalService: () => ({ list: vi.fn().mockResolvedValue([]) }),
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  logActivity: vi.fn(),
}));

function createApp(insertedLogs: Array<Record<string, unknown>>, upsertCalls: Array<Record<string, unknown>>) {
  const mockDb = {
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => {
        insertedLogs.push(row);
        return Promise.resolve([]);
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: vi.fn((cb: (rows: unknown[]) => unknown) => Promise.resolve(cb([]))),
            })),
          })),
        })),
      })),
    })),
  };

  mockRegistry.upsertCompanySettings.mockImplementation(
    (_pluginId: string, _companyId: string, patch: Record<string, unknown>) => {
      upsertCalls.push(patch);
      return Promise.resolve({ enabled: true, settingsJson: {}, ...patch });
    },
  );

  return (async () => {
    const [{ githubIntegrationRoutes }, { errorHandler }] = await Promise.all([
      import("../routes/github-integration.js"),
      import("../middleware/index.js"),
    ]);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [COMPANY_ID],
      } as typeof req.actor;
      next();
    });
    app.use("/api", githubIntegrationRoutes(mockDb as never));
    app.use(errorHandler);
    return app;
  })();
}

describe("sync-to-github PAT redaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockIssues.getById.mockResolvedValue({
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      identifier: "GLA-1",
      title: "Test issue",
      description: "desc",
      status: "in_progress",
    });

    mockRegistry.getByKey.mockResolvedValue({
      id: PLUGIN_ID,
      pluginKey: "paperclipai.plugin-github-sync",
    });

    mockRegistry.getCompanySettings.mockResolvedValue({
      enabled: true,
      settingsJson: {
        repo: "owner/repo",
        host: "github.com",
        secretRef: SECRET_REF,
        syncedGoalIds: [],
        dryRun: false,
      },
      lastError: null,
    });

    mockSecrets.resolveSecretValue.mockResolvedValue(SYNTHETIC_PAT);

    // No existing GH issue — triggers a POST /issues call.
    mockStateStore.get.mockResolvedValue(null);
  });

  it("does not leak PAT in 502 body, lastError, or plugin_logs when GitHub echoes token in error response", async () => {
    // GitHub returns a 422 whose body verbatim contains the PAT.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: () => Promise.resolve(`Unprocessable Entity: token=${SYNTHETIC_PAT} is not valid`),
        json: () => Promise.resolve({}),
      }),
    );

    const insertedLogs: Array<Record<string, unknown>> = [];
    const upsertCalls: Array<Record<string, unknown>> = [];

    const app = await createApp(insertedLogs, upsertCalls);

    const res = await request(app)
      .post(`/api/issues/${ISSUE_ID}/sync-to-github`)
      .send({});

    expect(res.status).toBe(502);

    // 502 response body must not contain the PAT.
    expect(JSON.stringify(res.body)).not.toContain(SYNTHETIC_PAT);

    // lastError persisted in plugin_company_settings must not contain the PAT.
    const lastErrorUpsert = upsertCalls.find((c) => typeof c["lastError"] === "string");
    expect(lastErrorUpsert).toBeDefined();
    expect(lastErrorUpsert!["lastError"]).not.toContain(SYNTHETIC_PAT);
    expect(lastErrorUpsert!["lastError"]).toContain("[REDACTED]");

    // plugin_logs meta.error must not contain the PAT.
    const errorLog = insertedLogs.find((r) => {
      const meta = r["meta"] as Record<string, unknown> | undefined;
      return r["level"] === "error" && meta && typeof meta["error"] === "string";
    });
    expect(errorLog).toBeDefined();
    const logMeta = errorLog!["meta"] as Record<string, unknown>;
    expect(logMeta["error"]).not.toContain(SYNTHETIC_PAT);
    expect(logMeta["error"]).toContain("[REDACTED]");

    vi.unstubAllGlobals();
  });
});
