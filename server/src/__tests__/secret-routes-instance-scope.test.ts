import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret } from "@paperclipai/shared";

const mockSvc = vi.hoisted(() => ({
  list: vi.fn(),
  listInstance: vi.fn(),
  listProviders: vi.fn(),
  create: vi.fn(),
  createInstance: vi.fn(),
  rotate: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  secretService: () => mockSvc,
  logActivity: mockLogActivity,
  // Other services exported here aren't touched by these tests but the
  // module is barrel-imported so we need to satisfy the surface. Stub
  // them as undefined accessors that throw if accidentally invoked.
}));

vi.mock("../secrets/provider-registry.js", () => ({
  getSecretProvider: vi.fn(),
  listSecretProviders: vi.fn(),
}));

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const NON_ADMIN_USER = "user-1";
const ADMIN_USER = "admin-1";
const SECRET_ID = "11111111-1111-4111-8111-111111111111";

function instanceSecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: SECRET_ID,
    companyId: null as unknown as string,
    name: "gcp_oauth_client_secret",
    provider: "local_encrypted",
    externalRef: null,
    latestVersion: 1,
    description: null,
    createdByAgentId: null,
    createdByUserId: ADMIN_USER,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function companySecret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    ...instanceSecret(),
    companyId: COMPANY_A,
    ...overrides,
  };
}

function adminActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: ADMIN_USER,
    source: "session",
    isInstanceAdmin: true,
    companyIds: [],
    ...overrides,
  };
}

function nonAdminActor(overrides: Record<string, unknown> = {}) {
  return {
    type: "board",
    userId: NON_ADMIN_USER,
    source: "session",
    isInstanceAdmin: false,
    companyIds: [COMPANY_A],
    ...overrides,
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ secretRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/secrets.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", secretRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe.sequential("instance secrets routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects GET /instance/secrets for non-admin board users", async () => {
    const app = await createApp(nonAdminActor());
    const res = await request(app).get("/api/instance/secrets");
    expect(res.status).toBe(403);
    expect(mockSvc.listInstance).not.toHaveBeenCalled();
  });

  it("returns instance-scoped secrets for instance admins", async () => {
    mockSvc.listInstance.mockResolvedValueOnce([instanceSecret()]);
    const app = await createApp(adminActor());
    const res = await request(app).get("/api/instance/secrets");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(mockSvc.listInstance).toHaveBeenCalledOnce();
  });

  it("rejects POST /instance/secrets for non-admin board users", async () => {
    const app = await createApp(nonAdminActor());
    const res = await request(app)
      .post("/api/instance/secrets")
      .send({ name: "x", value: "y" });
    expect(res.status).toBe(403);
    expect(mockSvc.createInstance).not.toHaveBeenCalled();
  });

  it("creates an instance secret and writes a null-companyId activity row", async () => {
    mockSvc.createInstance.mockResolvedValueOnce(instanceSecret());
    const app = await createApp(adminActor());
    const res = await request(app)
      .post("/api/instance/secrets")
      .send({ name: "gcp_oauth_client_secret", value: "secret-material" });
    expect(res.status).toBe(201);
    expect(mockSvc.createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ name: "gcp_oauth_client_secret", value: "secret-material" }),
      expect.objectContaining({ userId: ADMIN_USER }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        companyId: null,
        action: "instance_secret.created",
        entityId: SECRET_ID,
      }),
    );
  });

  it("rotates an instance-scoped secret when caller is instance admin", async () => {
    mockSvc.getById.mockResolvedValueOnce(instanceSecret());
    mockSvc.rotate.mockResolvedValueOnce(instanceSecret({ latestVersion: 2 }));
    const app = await createApp(adminActor());
    const res = await request(app)
      .post(`/api/secrets/${SECRET_ID}/rotate`)
      .send({ value: "new-secret-material" });
    expect(res.status).toBe(200);
    expect(res.body.latestVersion).toBe(2);
    expect(mockLogActivity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ companyId: null, action: "secret.rotated" }),
    );
  });

  it("rejects rotate of an instance-scoped secret when caller is non-admin", async () => {
    mockSvc.getById.mockResolvedValueOnce(instanceSecret());
    const app = await createApp(nonAdminActor());
    const res = await request(app)
      .post(`/api/secrets/${SECRET_ID}/rotate`)
      .send({ value: "new-secret-material" });
    expect(res.status).toBe(403);
    expect(mockSvc.rotate).not.toHaveBeenCalled();
  });

  it("rotates a company-scoped secret with company-access dispatch (existing behaviour preserved)", async () => {
    mockSvc.getById.mockResolvedValueOnce(companySecret());
    mockSvc.rotate.mockResolvedValueOnce(companySecret({ latestVersion: 2 }));
    const app = await createApp(nonAdminActor());
    const res = await request(app)
      .post(`/api/secrets/${SECRET_ID}/rotate`)
      .send({ value: "new" });
    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ companyId: COMPANY_A, action: "secret.rotated" }),
    );
  });
});
