import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const mockBoardAuth = vi.hoisted(() => ({
  findBoardApiKeyByToken: vi.fn(),
  resolveBoardAccess: vi.fn(),
  touchBoardApiKey: vi.fn(),
}));

vi.mock("../services/board-auth.js", () => ({
  boardAuthService: () => mockBoardAuth,
}));

import { actorMiddleware } from "../middleware/auth.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(
      {
        select: vi.fn(),
      } as never,
      { deploymentMode: "authenticated" },
    ),
  );
  app.get("/actor", (req, res) => {
    res.json({
      actorType: req.actor.type,
      userId: req.actor.userId ?? null,
      userName: req.actor.userName ?? null,
      source: req.actor.source ?? null,
      keyId: req.actor.keyId ?? null,
    });
  });
  return app;
}

describe("auth middleware board-key touch handling", () => {
  it("keeps a valid board actor when last-used touch hits a lock timeout", async () => {
    mockBoardAuth.findBoardApiKeyByToken.mockResolvedValue({
      id: "board-key-1",
      userId: "user-1",
    });
    mockBoardAuth.resolveBoardAccess.mockResolvedValue({
      user: { id: "user-1", name: "User One", email: "user@example.com" },
      companyIds: ["company-1"],
      memberships: [],
      isInstanceAdmin: false,
    });
    mockBoardAuth.touchBoardApiKey.mockRejectedValue(
      new Error("canceling statement due to lock timeout"),
    );

    const res = await request(createApp())
      .get("/actor")
      .set("authorization", "Bearer pcp_board_token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      actorType: "board",
      userId: "user-1",
      userName: "User One",
      source: "board_key",
      keyId: "board-key-1",
    });
  });
});
