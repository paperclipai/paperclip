import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { errorHandler } from "../middleware/index.js";

const accessServiceMock = vi.hoisted(() => ({
  isInstanceAdmin: vi.fn(),
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));
const logActivityMock = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => accessServiceMock,
  agentService: () => ({
    getById: vi.fn(),
  }),
  boardAuthService: () => ({
    createChallenge: vi.fn(),
    resolveBoardAccess: vi.fn(),
    assertCurrentBoardKey: vi.fn(),
    revokeBoardApiKey: vi.fn(),
  }),
  deduplicateAgentName: vi.fn(),
  logActivity: logActivityMock,
  notifyHireApproved: vi.fn(),
}));

type QueryHooks = {
  onSet?: (value: unknown) => void;
  onValues?: (value: unknown) => void;
};

function createQuery(rows: unknown[], hooks: QueryHooks = {}) {
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    set: vi.fn((value: unknown) => {
      hooks.onSet?.(value);
      return query;
    }),
    values: vi.fn((value: unknown) => {
      hooks.onValues?.(value);
      return query;
    }),
    returning: vi.fn(() => query),
    then(resolve: (value: unknown[]) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(rows).then(resolve, reject);
    },
  };
  return query;
}

function createDbStub() {
  const updateMock = vi.fn();
  const invite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: "user-1",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([invite]);
            },
          };
        },
      };
    },
    update(...args: unknown[]) {
      updateMock(...args);
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };

  return { db, updateMock };
}

function createApp(db: Record<string, unknown>) {
  return createAppWithActor(db, {
    type: "board",
    source: "session",
    userId: "user-1",
    companyIds: ["company-1"],
    memberships: [
      {
        companyId: "company-1",
        membershipRole: "owner",
        status: "active",
      },
    ],
  });
}

function createAppWithActor(db: Record<string, unknown>, actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

function createDirectHumanInviteDbStub() {
  const insertedValues: unknown[] = [];
  const updateValues: unknown[] = [];
  const invite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { human: { role: "owner" } },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: "inviter-user",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };
  const createdJoinRequest = {
    id: "join-1",
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "human",
    status: "pending_approval",
    requestIp: "::ffff:127.0.0.1",
    requestingUserId: "invitee-user",
    requestEmailSnapshot: "invitee@example.com",
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretHash: null,
    claimSecretExpiresAt: null,
    claimSecretConsumedAt: null,
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-03-07T00:01:00.000Z"),
    updatedAt: new Date("2026-03-07T00:01:00.000Z"),
  };
  const approvedJoinRequest = {
    ...createdJoinRequest,
    status: "approved",
    approvedByUserId: "inviter-user",
    approvedAt: new Date("2026-03-07T00:02:00.000Z"),
    updatedAt: new Date("2026-03-07T00:02:00.000Z"),
  };
  const selectResponses = [
    [invite],
    [{ email: "invitee@example.com" }],
    [],
  ];
  const updateResponses = [[], [approvedJoinRequest]];
  const insertResponses = [[createdJoinRequest]];

  const db = {
    select() {
      return createQuery(selectResponses.shift() ?? []);
    },
    update() {
      return createQuery(updateResponses.shift() ?? [], {
        onSet: (value) => updateValues.push(value),
      });
    },
    insert() {
      return createQuery(insertResponses.shift() ?? [], {
        onValues: (value) => insertedValues.push(value),
      });
    },
    transaction(callback: (tx: unknown) => unknown) {
      return callback(db);
    },
  };

  return { db, insertedValues, updateValues };
}

function createAcceptedHumanInviteReplayDbStub() {
  const updateValues: unknown[] = [];
  const invite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { human: { role: "operator" } },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: "inviter-user",
    revokedAt: null,
    acceptedAt: new Date("2026-03-07T00:05:00.000Z"),
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:05:00.000Z"),
  };
  const pendingJoinRequest = {
    id: "join-1",
    inviteId: "invite-1",
    companyId: "company-1",
    requestType: "human",
    status: "pending_approval",
    requestIp: "::ffff:127.0.0.1",
    requestingUserId: "invitee-user",
    requestEmailSnapshot: "invitee@example.com",
    agentName: null,
    adapterType: null,
    capabilities: null,
    agentDefaultsPayload: null,
    claimSecretHash: null,
    claimSecretExpiresAt: null,
    claimSecretConsumedAt: null,
    createdAgentId: null,
    approvedByUserId: null,
    approvedAt: null,
    rejectedByUserId: null,
    rejectedAt: null,
    createdAt: new Date("2026-03-07T00:01:00.000Z"),
    updatedAt: new Date("2026-03-07T00:01:00.000Z"),
  };
  const replayedJoinRequest = {
    ...pendingJoinRequest,
    requestIp: "::ffff:127.0.0.1",
    updatedAt: new Date("2026-03-07T00:06:00.000Z"),
  };
  const approvedJoinRequest = {
    ...replayedJoinRequest,
    status: "approved",
    approvedByUserId: "inviter-user",
    approvedAt: new Date("2026-03-07T00:07:00.000Z"),
    updatedAt: new Date("2026-03-07T00:07:00.000Z"),
  };
  const selectResponses = [
    [invite],
    [pendingJoinRequest],
    [{ email: "invitee@example.com" }],
    [pendingJoinRequest],
  ];
  const updateResponses = [[replayedJoinRequest], [approvedJoinRequest]];

  const db = {
    select() {
      return createQuery(selectResponses.shift() ?? []);
    },
    update() {
      return createQuery(updateResponses.shift() ?? [], {
        onSet: (value) => updateValues.push(value),
      });
    },
    insert: vi.fn(),
    transaction(callback: (tx: unknown) => unknown) {
      return callback(db);
    },
  };

  return { db, updateValues };
}

describe("POST /invites/:token/accept", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not consume a human invite when the signed-in user is already a company member", async () => {
    const { db, updateMock } = createDbStub();
    const app = createApp(db);

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("You already belong to this company");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("grants company access immediately for a human invite", async () => {
    const { db, insertedValues, updateValues } = createDirectHumanInviteDbStub();
    const app = createAppWithActor(db, {
      type: "board",
      source: "session",
      userId: "invitee-user",
      companyIds: [],
      memberships: [],
    });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("approved");
    expect(insertedValues).toEqual([
      expect.objectContaining({
        inviteId: "invite-1",
        companyId: "company-1",
        requestType: "human",
        status: "pending_approval",
        requestingUserId: "invitee-user",
        requestEmailSnapshot: "invitee@example.com",
      }),
    ]);
    expect(updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          acceptedAt: expect.any(Date),
        }),
        expect.objectContaining({
          status: "approved",
          approvedByUserId: "inviter-user",
          approvedAt: expect.any(Date),
        }),
      ]),
    );
    expect(accessServiceMock.ensureMembership).toHaveBeenCalledWith(
      "company-1",
      "user",
      "invitee-user",
      "owner",
      "active",
    );
    expect(accessServiceMock.setPrincipalGrants).toHaveBeenCalledWith(
      "company-1",
      "user",
      "invitee-user",
      expect.arrayContaining([
        expect.objectContaining({ permissionKey: "users:invite" }),
        expect.objectContaining({ permissionKey: "users:manage_permissions" }),
      ]),
      "inviter-user",
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "join.approved",
        entityId: "join-1",
        details: expect.objectContaining({ source: "human_invite_accept" }),
      }),
    );
  });

  it("replays a consumed human invite for the same user and repairs company access", async () => {
    const { db, updateValues } = createAcceptedHumanInviteReplayDbStub();
    const app = createAppWithActor(db, {
      type: "board",
      source: "session",
      userId: "invitee-user",
      companyIds: [],
      memberships: [],
    });

    const res = await request(app)
      .post("/api/invites/pcp_invite_test/accept")
      .send({ requestType: "human" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("approved");
    expect(updateValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestIp: expect.any(String),
          updatedAt: expect.any(Date),
        }),
        expect.objectContaining({
          status: "approved",
          approvedByUserId: "inviter-user",
          approvedAt: expect.any(Date),
        }),
      ]),
    );
    expect(updateValues).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ acceptedAt: expect.any(Date) })]),
    );
    expect(accessServiceMock.ensureMembership).toHaveBeenCalledWith(
      "company-1",
      "user",
      "invitee-user",
      "operator",
      "active",
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "join.request_replayed",
        entityId: "join-1",
        details: expect.objectContaining({ inviteReplay: true }),
      }),
    );
    expect(logActivityMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "join.approved",
        entityId: "join-1",
        details: expect.objectContaining({ source: "human_invite_accept" }),
      }),
    );
  });
});
