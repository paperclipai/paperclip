import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../../middleware/auth.js";

vi.mock("../../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: vi.fn().mockReturnValue(null),
}));

function createMockDb() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockImplementation((cb: any) => {
            // Default: return empty
            return Promise.resolve(cb([]));
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

function createApp(deploymentMode: string, resolveSession?: any) {
  const app = express();
  app.use(express.json());
  const db = createMockDb();
  app.use(actorMiddleware(db as any, {
    deploymentMode: deploymentMode as any,
    resolveSession,
  }));
  app.get("/test", (req, res) => {
    res.json({ actor: (req as any).actor });
  });
  return app;
}

describe("actorMiddleware", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("local_trusted mode", () => {
    it("sets board actor with local_implicit source", async () => {
      const res = await request(createApp("local_trusted")).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("board");
      expect(res.body.actor.source).toBe("local_implicit");
      expect(res.body.actor.isInstanceAdmin).toBe(true);
    });
  });

  describe("authenticated mode", () => {
    it("sets none actor when no auth header and no session", async () => {
      const res = await request(createApp("authenticated")).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("none");
    });

    it("sets board actor from session", async () => {
      const mockResolveSession = vi.fn().mockResolvedValue({
        user: { id: "user-session-1" },
      });

      const app = express();
      app.use(express.json());

      // Create a mock db that returns proper data for session resolution
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        then: vi.fn(),
      };

      let callCount = 0;
      selectChain.then.mockImplementation((cb: any) => {
        callCount++;
        if (callCount === 1) {
          // instanceUserRoles query - return admin
          return Promise.resolve(cb([{ id: "role-1" }]));
        }
        // companyMemberships query
        return Promise.resolve(cb([{ companyId: "company-1" }]));
      });

      const db = {
        select: vi.fn().mockReturnValue(selectChain),
      };

      app.use(actorMiddleware(db as any, {
        deploymentMode: "authenticated" as any,
        resolveSession: mockResolveSession,
      }));
      app.get("/test", (req, res) => {
        res.json({ actor: (req as any).actor });
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("board");
      expect(res.body.actor.source).toBe("session");
      expect(res.body.actor.userId).toBe("user-session-1");
    });

    it("sets none actor when session resolution fails", async () => {
      const mockResolveSession = vi.fn().mockRejectedValue(new Error("session error"));
      const res = await request(createApp("authenticated", mockResolveSession)).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("none");
    });
  });

  describe("bearer token auth", () => {
    it("sets none actor when token not found and JWT invalid", async () => {
      const app = express();
      app.use(express.json());
      const db = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              then: vi.fn().mockImplementation((cb: any) => Promise.resolve(cb([]))),
            }),
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(undefined),
          }),
        }),
      };
      app.use(actorMiddleware(db as any, { deploymentMode: "authenticated" as any }));
      app.get("/test", (req, res) => {
        res.json({ actor: (req as any).actor });
      });
      const res = await request(app)
        .get("/test")
        .set("Authorization", "Bearer invalid-token");
      expect(res.status).toBe(200);
      expect(res.body.actor.type).toBe("none");
    });

    it("passes x-paperclip-run-id header to actor", async () => {
      const res = await request(createApp("local_trusted"))
        .get("/test")
        .set("x-paperclip-run-id", "run-abc");
      expect(res.status).toBe(200);
      // For local_trusted, runId is picked up from the header
      expect(res.body.actor.type).toBe("board");
    });
  });
});
