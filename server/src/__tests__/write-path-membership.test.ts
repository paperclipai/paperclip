import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

// Tests that verify the write-path membership/role checks restored by Fix 1.
// `assertCompanyAccess` (in authz.ts) must reject viewer-role users and
// inactive members on non-safe HTTP methods (POST/PUT/PATCH/DELETE), even when
// `hasCompanyAccess` would let them through the 404 oracle gate.

const companyId = "11111111-1111-4111-8111-111111111111";
const goalId = "22222222-2222-4222-8222-222222222222";

const baseGoal = {
  id: goalId,
  companyId,
  level: "company" as const,
  title: "Q3 goal",
  description: null,
  parentId: null,
  ownerAgentId: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackGoalCreated: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/goals.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/goals.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { goalRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { ...actor };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function resetMocks() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockGoalService)) mock.mockReset();
  mockGoalService.list.mockImplementation(async () => []);
  mockGoalService.getById.mockImplementation(async () => ({ ...baseGoal }));
  mockGoalService.create.mockImplementation(async () => ({ ...baseGoal }));
  mockGoalService.update.mockImplementation(async () => ({ ...baseGoal }));
  mockGoalService.remove.mockImplementation(async () => ({ ...baseGoal }));
  mockLogActivity.mockImplementation(async () => undefined);
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
}

describe.sequential("write-path membership checks (viewer / inactive)", () => {
  beforeEach(() => {
    resetMocks();
  });

  describe("viewer role", () => {
    const viewerActor = {
      type: "board" as const,
      userId: "viewer-user",
      companyIds: [companyId],
      source: "session" as const,
      isInstanceAdmin: false,
      memberships: [
        { companyId, status: "active", membershipRole: "viewer" },
      ],
    };

    it("rejects PATCH on a goal with 403 'Viewer access is read-only'", async () => {
      const app = await createApp(viewerActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/goals/${goalId}`).send({ title: "New title" }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Viewer access is read-only");
      expect(mockGoalService.update).not.toHaveBeenCalled();
    });

    it("rejects DELETE on a goal with 403 'Viewer access is read-only'", async () => {
      const app = await createApp(viewerActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/goals/${goalId}`),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Viewer access is read-only");
      expect(mockGoalService.remove).not.toHaveBeenCalled();
    });

    it("rejects POST (create) on a company's goals with 403 'Viewer access is read-only'", async () => {
      const app = await createApp(viewerActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${companyId}/goals`)
          .send({ level: "company", title: "New goal" }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("Viewer access is read-only");
      expect(mockGoalService.create).not.toHaveBeenCalled();
    });

    it("still permits GET on the same goal (read-only access is preserved)", async () => {
      const app = await createApp(viewerActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).get(`/api/goals/${goalId}`),
      );

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(goalId);
      expect(mockGoalService.getById).toHaveBeenCalledWith(goalId);
    });
  });

  describe("inactive membership", () => {
    const inactiveActor = {
      type: "board" as const,
      userId: "ex-employee",
      companyIds: [companyId],
      source: "session" as const,
      isInstanceAdmin: false,
      memberships: [
        { companyId, status: "removed", membershipRole: "editor" },
      ],
    };

    it("rejects PATCH on a goal with 403 'User does not have active company access'", async () => {
      const app = await createApp(inactiveActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/goals/${goalId}`).send({ title: "New title" }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("User does not have active company access");
      expect(mockGoalService.update).not.toHaveBeenCalled();
    });

    it("rejects DELETE on a goal with 403 'User does not have active company access'", async () => {
      const app = await createApp(inactiveActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).delete(`/api/goals/${goalId}`),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("User does not have active company access");
      expect(mockGoalService.remove).not.toHaveBeenCalled();
    });

    it("rejects POST on a company's goals with 403 'User does not have active company access'", async () => {
      const app = await createApp(inactiveActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl)
          .post(`/api/companies/${companyId}/goals`)
          .send({ level: "company", title: "New goal" }),
      );

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("User does not have active company access");
      expect(mockGoalService.create).not.toHaveBeenCalled();
    });
  });

  describe("active editor (sanity check)", () => {
    const editorActor = {
      type: "board" as const,
      userId: "editor-user",
      companyIds: [companyId],
      source: "session" as const,
      isInstanceAdmin: false,
      memberships: [
        { companyId, status: "active", membershipRole: "editor" },
      ],
    };

    it("allows PATCH on a goal", async () => {
      const app = await createApp(editorActor);
      const res = await requestApp(app, (baseUrl) =>
        request(baseUrl).patch(`/api/goals/${goalId}`).send({ title: "New title" }),
      );

      expect(res.status).toBe(200);
      expect(mockGoalService.update).toHaveBeenCalledWith(goalId, { title: "New title" });
    });
  });
});
