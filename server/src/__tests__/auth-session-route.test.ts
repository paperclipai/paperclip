import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

const mockBoardAuthService = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn(async () => null),
  resolveBoardAccess: vi.fn(),
  touchBoardApiKey: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => mockBoardAuthService,
}));

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createUpdateChain() {
  return {
    set() {
      return {
        where() {
          return Promise.resolve([]);
        },
      };
    },
  };
}

function createDb(selectResults: unknown[][] = []) {
  const pendingSelects = [...selectResults];
  return {
    select: vi.fn(() => createSelectChain(pendingSelects.shift() ?? [])),
    update: vi.fn(() => createUpdateChain()),
  } as any;
}

function createActorApp(deploymentMode: "authenticated" | "local_trusted", db = createDb()) {
  const app = express();
  app.use(
    actorMiddleware(db, {
      deploymentMode,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

const originalJwtSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;

beforeEach(() => {
  vi.clearAllMocks();
  mockBoardAuthService.findBoardApiKeyByToken.mockResolvedValue(null);
  process.env.PAPERCLIP_AGENT_JWT_SECRET = "test-agent-jwt-secret";
});

afterEach(() => {
  if (originalJwtSecret === undefined) {
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  } else {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = originalJwtSecret;
  }
});

describe("actorMiddleware authenticated session profile", () => {
  it("preserves the signed-in user name and email on the board actor", async () => {
    const app = express();
    app.use(
      actorMiddleware(createDb(), {
        deploymentMode: "authenticated",
        resolveSession: async () => ({
          session: { id: "session-1", userId: "user-1" },
          user: {
            id: "user-1",
            name: "User One",
            email: "user@example.com",
          },
        }),
      }),
    );
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });

    const res = await request(app).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userName: "User One",
      userEmail: "user@example.com",
      source: "session",
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });
  });
});

describe("actorMiddleware local trusted auth fallback", () => {
  it("keeps no-auth local requests on the implicit board actor", async () => {
    const res = await request(createActorApp("local_trusted")).get("/actor");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });
  });

  it("does not fall back to local board for invalid bearer auth", async () => {
    const res = await request(createActorApp("local_trusted"))
      .get("/actor")
      .set("Authorization", "Bearer not-a-real-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });

  it("does not fall back to local board for empty bearer auth", async () => {
    const res = await request(createActorApp("local_trusted"))
      .get("/actor")
      .set("Authorization", "Bearer ");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });

  it("does not fall back to local board for unsupported explicit auth schemes", async () => {
    const res = await request(createActorApp("local_trusted"))
      .get("/actor")
      .set("Authorization", "Basic not-supported");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });

  it("does not attach run id to unsupported explicit auth schemes", async () => {
    const res = await request(createActorApp("local_trusted"))
      .get("/actor")
      .set("Authorization", "Basic not-supported")
      .set("X-Paperclip-Run-Id", "run-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });

  it("does not continue past a board key whose user no longer resolves", async () => {
    const db = createDb();
    mockBoardAuthService.findBoardApiKeyByToken.mockResolvedValue({
      id: "board-key-1",
      userId: "deleted-user",
    });
    mockBoardAuthService.resolveBoardAccess.mockResolvedValue({
      user: null,
      companyIds: [],
      memberships: [],
      isInstanceAdmin: false,
    });

    const res = await request(createActorApp("local_trusted", db))
      .get("/actor")
      .set("Authorization", "Bearer board-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("does not fall back to local board when a valid agent JWT has the wrong company", async () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeTruthy();
    const db = createDb([
      [],
      [{ id: "agent-1", companyId: "company-2", status: "idle" }],
    ]);

    const res = await request(createActorApp("local_trusted", db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });

  it("does not fall back to local board when a valid agent JWT resolves to a terminated agent", async () => {
    const token = createLocalAgentJwt("agent-1", "company-1", "claude_local", "run-1");
    expect(token).toBeTruthy();
    const db = createDb([
      [],
      [{ id: "agent-1", companyId: "company-1", status: "terminated" }],
    ]);

    const res = await request(createActorApp("local_trusted", db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });

  it("does not fall back to local board when an API key resolves to a terminated agent", async () => {
    const db = createDb([
      [{ id: "agent-key-1", agentId: "agent-1", companyId: "company-1" }],
      [{ id: "agent-1", companyId: "company-1", status: "terminated" }],
    ]);

    const res = await request(createActorApp("local_trusted", db))
      .get("/actor")
      .set("Authorization", "Bearer agent-api-key");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "none",
      source: "none",
    });
  });
});
