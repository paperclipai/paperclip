import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { secretRoutes } from "../routes/secrets.js";

const {
  listProvidersMock,
  listSecretsMock,
  createSecretMock,
  getSecretByIdMock,
  rotateSecretMock,
  updateSecretMock,
  removeSecretMock,
  logActivityMock,
} = vi.hoisted(() => ({
  listProvidersMock: vi.fn(),
  listSecretsMock: vi.fn(),
  createSecretMock: vi.fn(),
  getSecretByIdMock: vi.fn(),
  rotateSecretMock: vi.fn(),
  updateSecretMock: vi.fn(),
  removeSecretMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  secretService: vi.fn(() => ({
    listProviders: listProvidersMock,
    list: listSecretsMock,
    create: createSecretMock,
    getById: getSecretByIdMock,
    rotate: rotateSecretMock,
    update: updateSecretMock,
    remove: removeSecretMock,
  })),
  logActivity: logActivityMock,
}));

function createApp(actor: Record<string, unknown> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "session",
      userId: "user-1",
      companyIds: ["company-1"],
      isInstanceAdmin: false,
      ...actor,
    };
    next();
  });
  app.use("/api", secretRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("secret route authorization", () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.PAPERCLIP_SECRETS_PROVIDER;
  });

  it("rejects secret listing outside the board actor company scope", async () => {
    const res = await request(createApp()).get("/api/companies/company-2/secrets");

    expect(res.status).toBe(403);
    expect(listSecretsMock).not.toHaveBeenCalled();
  });

  it("rejects secret creation for agent actors even within their own company", async () => {
    const res = await request(
      createApp({
        type: "agent",
        agentId: "agent-1",
        companyId: "company-1",
        userId: undefined,
      }),
    )
      .post("/api/companies/company-1/secrets")
      .send({
        name: "OPENAI_API_KEY",
        value: "super-secret",
      });

    expect(res.status).toBe(403);
    expect(createSecretMock).not.toHaveBeenCalled();
  });

  it("allows scoped board actors to list secret providers for their company", async () => {
    listProvidersMock.mockReturnValue([{ id: "local_encrypted", label: "Local encrypted" }]);

    const res = await request(createApp()).get("/api/companies/company-1/secret-providers");

    expect(res.status).toBe(200);
    expect(listProvidersMock).toHaveBeenCalledOnce();
    expect(res.body).toEqual([{ id: "local_encrypted", label: "Local encrypted" }]);
  });
});
