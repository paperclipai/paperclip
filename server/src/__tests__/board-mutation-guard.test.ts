import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { boardMutationGuard, buildAllowedBoardOrigins } from "../middleware/board-mutation-guard.js";

function createApp(
  actorType: "board" | "agent",
  boardSource: "session" | "local_implicit" = "session",
  allowedOrigins?: string[],
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actorType === "board"
      ? { type: "board", userId: "board", source: boardSource }
      : { type: "agent", agentId: "agent-1" };
    next();
  });
  app.use(boardMutationGuard({ allowedOrigins }));
  app.post("/mutate", (_req, res) => {
    res.status(204).end();
  });
  app.get("/read", (_req, res) => {
    res.status(204).end();
  });
  return app;
}

describe("boardMutationGuard", () => {
  it("builds allowed hostname origins with the server port for browser requests", () => {
    const origins = buildAllowedBoardOrigins({
      allowedHostnames: ["dotta-macbook-pro", "paperclip.example.com:8443"],
      serverPort: 3100,
    });

    expect(origins).toContain("http://dotta-macbook-pro");
    expect(origins).toContain("https://dotta-macbook-pro");
    expect(origins).toContain("http://dotta-macbook-pro:3100");
    expect(origins).toContain("https://dotta-macbook-pro:3100");
    expect(origins).toContain("http://paperclip.example.com:8443");
    expect(origins).toContain("https://paperclip.example.com:8443");
    expect(origins).not.toContain("http://paperclip.example.com:8443:3100");
  });

  it("allows safe methods for board actor", async () => {
    const app = createApp("board");
    const res = await request(app).get("/read");
    expect(res.status).toBe(204);
  });

  it("blocks board mutations without trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board mutation requires trusted browser origin" });
  });

  it("allows local implicit board mutations without origin", async () => {
    const app = createApp("board", "local_implicit");
    const res = await request(app).post("/mutate").send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows board mutations from trusted origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "http://localhost:3100")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows board mutations from trusted referer origin", async () => {
    const app = createApp("board");
    const res = await request(app)
      .post("/mutate")
      .set("Referer", "http://localhost:3100/issues/abc")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows configured public origins even when host header differs", async () => {
    const app = createApp("board", "session", ["https://paperclip.example.com"]);
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1:3100")
      .set("Origin", "https://paperclip.example.com")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("allows configured hostname origins when the browser includes the Paperclip port", async () => {
    const app = createApp(
      "board",
      "session",
      buildAllowedBoardOrigins({
        allowedHostnames: ["dotta-macbook-pro"],
        serverPort: 3100,
      }),
    );
    const res = await request(app)
      .post("/mutate")
      .set("Host", "127.0.0.1:3100")
      .set("Origin", "http://dotta-macbook-pro:3100")
      .send({ ok: true });
    expect(res.status).toBe(204);
  });

  it("blocks unlisted external origins when explicit origins are configured", async () => {
    const app = createApp("board", "session", ["https://paperclip.example.com"]);
    const res = await request(app)
      .post("/mutate")
      .set("Origin", "https://evil.example.com")
      .send({ ok: true });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Board mutation requires trusted browser origin" });
  });

  it("does not block authenticated agent mutations", async () => {
    const middleware = boardMutationGuard();
    const req = {
      method: "POST",
      actor: { type: "agent", agentId: "agent-1" },
      header: () => undefined,
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
