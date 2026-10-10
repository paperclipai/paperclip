import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  agents,
  environmentLeases,
  environments,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  ComputerError,
  type ComputerService,
} from "../modules/computers/index.js";
import { computerRoutes } from "../routes/computers.js";

const mocks = vi.hoisted(() => ({
  experimental: vi.fn(),
  settings: vi.fn(),
  getLease: vi.fn(),
  audit: vi.fn(),
  owner: vi.fn(),
}));
vi.mock("../modules/computers/index.js", async () => {
  const { ComputerError } =
    await import("../modules/computers/domain/ledger.js");
  return {
    ComputerError,
    computerService: () => {
      throw new Error("Inject the computer service");
    },
  };
});
vi.mock("@paperclipai/adapter-utils", () => ({
  resolvePaperclipRunnerIdleTimeoutMs: (value: number | undefined) =>
    value ?? 60_000,
}));
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getExperimental: mocks.experimental,
    get: mocks.settings,
  }),
}));
vi.mock("../services/environments.js", () => ({
  environmentService: () => ({ getLeaseById: mocks.getLease }),
}));
vi.mock("../services/computer-environment-driver.js", () => ({
  computerOwnerFromLease: mocks.owner,
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: mocks.audit }));
vi.mock("../services/authorization.js", () => ({
  responsibleUserAuthzShadowMode: () => false,
}));

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const issueId = "33333333-3333-4333-8333-333333333333";
const environmentId = "44444444-4444-4444-8444-444444444444";
const owner = {
  computerId: "55555555-5555-4555-8555-555555555555",
  ownerId: "66666666-6666-4666-8666-666666666666",
  generation: 2,
};
const endpoint = `/api/issues/${issueId}/computer`;

function fixture(
  options: {
    actor?: "board" | "agent";
    issueCompanyId?: string;
    attachedCompanyId?: string;
    issueMissing?: boolean;
  } = {},
) {
  const issue = options.issueMissing
    ? null
    : {
        id: issueId,
        companyId: options.issueCompanyId ?? companyId,
        assigneeAgentId: null,
      };
  const environment = {
    id: environmentId,
    name: "Boat",
    driver: "computer",
    status: "active",
    config: { runnerIdleTimeoutMs: 30_000 },
    metadata: { computerCompanyId: options.attachedCompanyId ?? companyId },
  };
  const lease = {
    id: "lease",
    environmentId,
    companyId,
    issueId,
    provider: "boat",
    metadata: { computerOwner: owner },
  };
  const rows = new Map<unknown, unknown[]>([
    [issues, issue ? [issue] : []],
    [environmentLeases, [lease]],
    [environments, [environment]],
    [agents, []],
  ]);
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      const query = {
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(async () => rows.get(table) ?? []),
      };
      return query;
    },
  }));
  const computers = {
    connect: vi.fn(async () => ({
      viewerUrl: "https://computer.on.boat.dev/#private",
      expiresAt: "2026-10-10T13:00:00Z",
      owner,
    })),
    renewViewer: vi.fn(),
    disconnectViewer: vi.fn(),
    preview: vi.fn(async () => ({
      url: "https://preview.on.boat.dev/?_token=private",
    })),
  };
  mocks.getLease.mockResolvedValue(lease);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor =
      options.actor === "agent"
        ? ({ type: "agent", agentId: "agent", companyId } as typeof req.actor)
        : ({
            type: "board",
            source: "session",
            userId: "alice",
            companyIds: [companyId],
            memberships: [
              { companyId, status: "active", membershipRole: "member" },
            ],
          } as typeof req.actor);
    next();
  });
  app.use(
    "/api",
    computerRoutes(
      { select } as unknown as Db,
      computers as unknown as ComputerService,
    ),
  );
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(
          error instanceof ZodError
            ? 400
            : ((error as { status?: number }).status ?? 500),
        )
        .json({ error: error instanceof Error ? error.message : "error" });
    },
  );
  return { app, computers, select, rows, environment, lease };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.experimental.mockResolvedValue({ enableBoatEnvironments: true });
  mocks.settings.mockResolvedValue({ defaultEnvironmentId: null });
  mocks.owner.mockReturnValue(owner);
});

describe("Computer routes", () => {
  it("rejects agents and invalid task IDs before looking up a computer", async () => {
    const agent = fixture({ actor: "agent" });
    expect((await request(agent.app).get(endpoint)).status).toBe(403);
    expect(agent.select).not.toHaveBeenCalled();
    const board = fixture();
    expect(
      (await request(board.app).get("/api/issues/not-a-uuid/computer")).status,
    ).toBe(404);
    expect(board.select).not.toHaveBeenCalled();
  });
  it("hides cross-company tasks exactly like missing tasks", async () => {
    const foreign = fixture({ issueCompanyId: otherCompanyId });
    const missing = fixture({ issueMissing: true });
    const a = await request(foreign.app)
      .post(`${endpoint}/connect`)
      .send({ environmentId });
    const b = await request(missing.app)
      .post(`${endpoint}/connect`)
      .send({ environmentId });
    expect(a.status).toBe(404);
    expect(a.body).toEqual(b.body);
    expect(foreign.computers.connect).not.toHaveBeenCalled();
  });
  it("requires a company-bound environment and rejects a posted environment override", async () => {
    const foreign = fixture({ attachedCompanyId: otherCompanyId });
    expect((await request(foreign.app).get(endpoint)).body).toBeNull();
    expect(
      (
        await request(foreign.app)
          .post(`${endpoint}/connect`)
          .send({ environmentId })
      ).status,
    ).toBe(404);
    const f = fixture();
    expect(
      (
        await request(f.app)
          .post(`${endpoint}/connect`)
          .send({ environmentId: otherCompanyId })
      ).status,
    ).toBe(404);
    expect(f.computers.connect).not.toHaveBeenCalled();
  });
  it("returns ephemeral viewer credentials with no-store and no-referrer and audits only IDs", async () => {
    const f = fixture();
    const result = await request(f.app)
      .post(`${endpoint}/connect`)
      .send({ environmentId });
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(f.computers.connect).toHaveBeenCalledWith({
      companyId,
      environmentId,
      userId: "alice",
      idleTimeoutMs: 30_000,
    });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("private");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "computer.connected",
        details: { issueId },
      }),
    );
  });
  it("rejects forged preview owners and derives the owner from the scoped stored lease", async () => {
    const f = fixture();
    expect(
      (
        await request(f.app)
          .post(`${endpoint}/preview`)
          .send({
            environmentId,
            port: 5173,
            owner: { ...owner, generation: 9 },
          })
      ).status,
    ).toBe(400);
    expect(f.computers.preview).not.toHaveBeenCalled();
    const result = await request(f.app)
      .post(`${endpoint}/preview`)
      .send({ environmentId, port: 5173 });
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(f.computers.preview).toHaveBeenCalledWith({
      companyId,
      environmentId,
      owner,
      port: 5173,
    });
  });
  it("disables new connections and previews while preserving authenticated disconnect", async () => {
    mocks.experimental.mockResolvedValue({ enableBoatEnvironments: false });
    const f = fixture();
    expect((await request(f.app).get(endpoint)).body).toBeNull();
    expect(
      (await request(f.app).post(`${endpoint}/connect`).send({ environmentId }))
        .status,
    ).toBe(422);
    expect(
      (
        await request(f.app)
          .post(`${endpoint}/preview`)
          .send({ environmentId, port: 5173 })
      ).status,
    ).toBe(422);
    expect(
      (
        await request(f.app)
          .post(`${endpoint}/disconnect`)
          .send({ environmentId, owner })
      ).status,
    ).toBe(204);
    expect(f.computers.disconnectViewer).toHaveBeenCalledWith({
      companyId,
      environmentId,
      owner,
      userId: "alice",
    });
  });
  it("passes viewer identity to the module and maps ownership errors without exposing credentials", async () => {
    const f = fixture();
    f.computers.renewViewer.mockRejectedValue(
      new ComputerError("forbidden", "Computer viewer belongs to another user"),
    );
    const result = await request(f.app)
      .post(`${endpoint}/presence`)
      .send({ environmentId, owner });
    expect(result.status).toBe(403);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(f.computers.renewViewer).toHaveBeenCalledWith({
      companyId,
      environmentId,
      owner,
      userId: "alice",
    });
  });
});
