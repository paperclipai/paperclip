import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invites, instanceUserRoles } from "@paperclipai/db";
import {
  accessRoutes,
  claimInitialInstanceAdmin,
} from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

function createClaimTxStub(existingUserId: string | null = null) {
  const execute = vi.fn().mockResolvedValue([]);
  const returning = vi.fn().mockResolvedValue([
    {
      id: "role-1",
      userId: "user-1",
      role: "instance_admin",
      createdAt: new Date("2026-04-06T00:00:00.000Z"),
      updatedAt: new Date("2026-04-06T00:00:00.000Z"),
    },
  ]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const select = vi.fn(() => ({
    from(table: unknown) {
      return {
        where: vi.fn().mockResolvedValue(
          table === instanceUserRoles && existingUserId
            ? [{ userId: existingUserId }]
            : [],
        ),
      };
    },
  }));

  return {
    execute,
    select,
    insert,
  } as any;
}

function createApp(
  actor: Record<string, unknown>,
  db: Record<string, unknown>,
  deploymentMode: "local_trusted" | "authenticated" = "authenticated",
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode,
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("claimInitialInstanceAdmin", () => {
  it("locks instance admin roles before checking and inserting", async () => {
    const tx = createClaimTxStub();

    const result = await claimInitialInstanceAdmin(tx, "user-1");

    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "claimed",
      role: {
        userId: "user-1",
        role: "instance_admin",
      },
    });
  });

  it("returns already_claimed when another admin exists", async () => {
    const tx = createClaimTxStub("user-existing");

    const result = await claimInitialInstanceAdmin(tx, "user-1");

    expect(tx.insert).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: "already_claimed",
      existingUserId: "user-existing",
    });
  });
});

describe("bootstrap claim routes", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("claims the first instance admin from the browser", async () => {
    const tx = createClaimTxStub();
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ claimed: true, userId: "user-1" });
  });

  it("rejects bootstrap claim once another instance admin exists", async () => {
    const tx = createClaimTxStub("user-existing");
    const db = {
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const app = createApp(
      {
        type: "board",
        userId: "user-2",
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app).post("/api/bootstrap/claim").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Initial instance admin has already been claimed");
  });

  it("keeps bootstrap invite acceptance as fallback but rejects it after claim", async () => {
    const invite = {
      id: "invite-1",
      companyId: null,
      inviteType: "bootstrap_ceo",
      allowedJoinTypes: "human",
      defaultsPayload: null,
      expiresAt: new Date("2099-04-06T00:10:00.000Z"),
      invitedByUserId: null,
      tokenHash: "hash",
      revokedAt: null,
      acceptedAt: null,
      createdAt: new Date("2099-04-06T00:00:00.000Z"),
      updatedAt: new Date("2099-04-06T00:00:00.000Z"),
    };
    const tx = createClaimTxStub("user-existing");
    const db = {
      select: vi.fn(() => ({
        from(table: unknown) {
          return {
            where: vi.fn().mockResolvedValue(table === invites ? [invite] : []),
          };
        },
      })),
      transaction: vi.fn(async (callback) => callback(tx)),
    };
    const app = createApp(
      {
        type: "board",
        userId: "user-2",
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Initial instance admin has already been claimed");
  });
});
