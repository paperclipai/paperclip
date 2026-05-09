import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COMPANY_ID = "11111111-2222-3333-4444-555555555555";
const PLUGIN_ID = "ppppppp1-pppp-pppp-pppp-pppppppppppp";
const FAKE_TOKEN = "ghp_fakepat1234567890";

const mockRegistry = vi.hoisted(() => ({
  getByKey: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockSecrets = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

const mockGoals = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockStateStore = vi.hoisted(() => ({}));
const mockIssueSvc = vi.hoisted(() => ({}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecrets,
}));

vi.mock("../services/goals.js", () => ({
  goalService: () => mockGoals,
}));

vi.mock("../services/plugin-state-store.js", () => ({
  pluginStateStore: () => mockStateStore,
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => mockIssueSvc,
}));

vi.mock("../services/index.js", () => ({
  logActivity: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve({}),
    headers: new Headers(),
  } as unknown as Response;
}

async function createApp() {
  vi.resetModules();
  const [{ errorHandler }, { githubIntegrationRoutes }] = await Promise.all([
    import("../middleware/index.js") as Promise<typeof import("../middleware/index.js")>,
    import("../routes/github-integration.js") as Promise<
      typeof import("../routes/github-integration.js")
    >,
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      companyIds: [COMPANY_ID],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", githubIntegrationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function post(
  app: express.Express,
  body: Record<string, unknown>,
): Promise<request.Response> {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const res = await request(`http://127.0.0.1:${addr.port}`)
      .post(`/api/companies/${COMPANY_ID}/integrations/github`)
      .send(body);
    return res;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("POST /integrations/github — token-to-repo handshake", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    mockRegistry.getByKey.mockResolvedValue({ id: PLUGIN_ID });
    mockRegistry.getCompanySettings.mockResolvedValue(null); // no existing config
    mockRegistry.upsertCompanySettings.mockResolvedValue({ enabled: true });

    mockSecrets.getById.mockResolvedValue({ id: SECRET_ID, companyId: COMPANY_ID });
    mockSecrets.resolveSecretValue.mockResolvedValue(FAKE_TOKEN);

    mockGoals.list.mockResolvedValue([]);
  });

  it("saves config when token is authorised on repo (200 handshake)", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(200));

    const app = await createApp();
    const res = await post(app, {
      repo: "owner/new-repo",
      secretRef: SECRET_ID,
      syncedGoalIds: [],
    });

    expect(res.status).toBe(200);
    expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledOnce();
  });

  it("returns 422 and does not persist when token returns 404 on target repo", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(404, '{"message":"Not Found"}'));

    const app = await createApp();
    const res = await post(app, {
      repo: "owner/private-repo",
      secretRef: SECRET_ID,
      syncedGoalIds: [],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not authorised on the configured repo/i);
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("returns 422 and does not persist when token returns 401", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse(401, '{"message":"Bad credentials"}'));

    const app = await createApp();
    const res = await post(app, {
      repo: "owner/some-repo",
      secretRef: SECRET_ID,
      syncedGoalIds: [],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/not authorised on the configured repo/i);
    expect(mockRegistry.upsertCompanySettings).not.toHaveBeenCalled();
  });

  it("skips handshake when repo is unchanged", async () => {
    mockRegistry.getCompanySettings.mockResolvedValue({
      settingsJson: {
        repo: "owner/existing-repo",
        host: "github.com",
        secretRef: SECRET_ID,
        syncedGoalIds: [],
        dryRun: false,
      },
      enabled: true,
    });

    const app = await createApp();
    const res = await post(app, {
      repo: "owner/existing-repo",
      secretRef: SECRET_ID,
      syncedGoalIds: [],
    });

    expect(res.status).toBe(200);
    // fetch should not have been called for the handshake
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockRegistry.upsertCompanySettings).toHaveBeenCalledOnce();
  });

  it("redacts token from 401 error body before surfacing", async () => {
    const leakyBody = `{"message":"Bad credentials for token ${FAKE_TOKEN}"}`;
    mockFetch.mockResolvedValue(makeFetchResponse(401, leakyBody));

    const app = await createApp();
    const res = await post(app, {
      repo: "owner/some-repo",
      secretRef: SECRET_ID,
      syncedGoalIds: [],
    });

    expect(res.status).toBe(422);
    expect(res.body.error).not.toContain(FAKE_TOKEN);
    expect(res.body.error).toContain("[REDACTED]");
  });
});
