import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
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
      let ordering: string[] = [];
      const query = {
        where: vi.fn(() => query),
        orderBy: vi.fn((...expressions: SQL[]) => {
          ordering = expressions.map(expression => new PgDialect().sqlToQuery(expression).sql);
          return query;
        }),
        limit: vi.fn(async (limit: number) => {
          const result = [...(rows.get(table) ?? [])];
          if (table === environmentLeases) result.sort((left, right) => {
            const a = left as Record<string, unknown>;
            const b = right as Record<string, unknown>;
            for (const expression of ordering) {
              const column = expression.includes('"created_at"') ? "createdAt"
                : expression.includes('"updated_at"') ? "updatedAt" : "id";
              const compare = String(b[column]).localeCompare(String(a[column]));
              if (compare) return compare;
            }
            return 0;
          });
          return result.slice(0, limit);
        }),
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
  it.each(["changed", "removed"])("disconnects the previous viewer when the task computer has %s", async state => {
    const f = fixture();
    const nextEnvironmentId = "77777777-7777-4777-8777-777777777777";
    f.rows.set(environmentLeases, state === "changed" ? [{ ...f.lease, environmentId: nextEnvironmentId }] : []);
    f.rows.set(environments, state === "changed" ? [{ ...f.environment, id: nextEnvironmentId }] : []);
    const response = await request(f.app).post(`${endpoint}/disconnect`).send({ environmentId, owner });
    expect(response.status).toBe(204);
    expect(f.select).toHaveBeenCalledTimes(1); // Task authorization precedes cleanup; no current-computer lookup.
    expect(f.computers.disconnectViewer).toHaveBeenCalledExactlyOnceWith({ companyId, environmentId, owner, userId: "alice" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "computer.disconnected", companyId, entityId: environmentId,
    }));
    for (const action of ["connect", "presence", "preview"]) {
      const input = action === "connect" ? { environmentId }
        : action === "preview" ? { environmentId, port: 5173 } : { environmentId, owner };
      expect((await request(f.app).post(`${endpoint}/${action}`).send(input)).status).toBe(404);
    }
    expect(f.computers.connect).not.toHaveBeenCalled();
    expect(f.computers.renewViewer).not.toHaveBeenCalled();
    expect(f.computers.preview).not.toHaveBeenCalled();
  });

  it.each(["not_found", "forbidden", "conflict"] as const)("preserves scoped disconnect ownership failures (%s)", async code => {
    const f = fixture();
    f.rows.set(environments, []);
    f.computers.disconnectViewer.mockRejectedValue(new ComputerError(code, "Viewer unavailable"));
    const response = await request(f.app).post(`${endpoint}/disconnect`).send({ environmentId, owner });
    expect(response.status).toBe(code === "not_found" ? 404 : code === "forbidden" ? 403 : 409);
    expect(f.computers.disconnectViewer).toHaveBeenCalledExactlyOnceWith({ companyId, environmentId, owner, userId: "alice" });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("authorizes the task and validates the exact owner before requesting stale-viewer cleanup", async () => {
    const foreign = fixture({ issueCompanyId: otherCompanyId });
    expect((await request(foreign.app).post(`${endpoint}/disconnect`).send({ environmentId, owner })).status).toBe(404);
    expect(foreign.computers.disconnectViewer).not.toHaveBeenCalled();
    const agent = fixture({ actor: "agent" });
    expect((await request(agent.app).post(`${endpoint}/disconnect`).send({ environmentId, owner })).status).toBe(403);
    expect(agent.computers.disconnectViewer).not.toHaveBeenCalled();
    const board = fixture();
    expect((await request(board.app).post(`${endpoint}/disconnect`).send({ environmentId, owner: { ...owner, generation: 0 } })).status).toBe(400);
    expect(board.computers.disconnectViewer).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each([true, false])("uses the latest admission despite an older lease's later finalization (latest live=%s)", async latestLive => {
    const f = fixture();
    const older = { ...f.lease, id: "older", createdAt: "2026-10-10T20:00:00Z", updatedAt: "2026-10-10T20:12:00Z" };
    const latest = { ...f.lease, id: "latest", createdAt: "2026-10-10T20:06:00Z", updatedAt: "2026-10-10T20:11:00Z" };
    f.rows.set(environmentLeases, [older, latest]);
    mocks.getLease.mockImplementation(async (id: string) => id === latest.id ? latest : older);
    if (!latestLive) f.computers.preview.mockRejectedValue(new ComputerError("conflict", "Preview owner is not live"));
    const response = await request(f.app).post(`${endpoint}/preview`).send({ environmentId, port: 5173 });
    expect(response.status).toBe(latestLive ? 200 : 409);
    expect(mocks.getLease).toHaveBeenCalledExactlyOnceWith(latest.id);
    expect(mocks.owner).toHaveBeenCalledExactlyOnceWith(latest);
    expect(f.computers.preview).toHaveBeenCalledTimes(1);
    if (!latestLive) expect(response.body.error).toBe("Preview owner is not live");
  });

  it("breaks equal admission timestamps deterministically by lease ID", async () => {
    const f = fixture();
    const first = { ...f.lease, id: "00000000-0000-4000-8000-000000000001", createdAt: "2026-10-10T20:00:00Z" };
    const last = { ...first, id: "00000000-0000-4000-8000-000000000002" };
    f.rows.set(environmentLeases, [first, last]);
    mocks.getLease.mockResolvedValue(last);
    expect((await request(f.app).post(`${endpoint}/preview`).send({ environmentId, port: 5173 })).status).toBe(200);
    expect(mocks.getLease).toHaveBeenCalledExactlyOnceWith(last.id);
  });

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
