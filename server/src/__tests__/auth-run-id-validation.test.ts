import { describe, expect, it, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { actorMiddleware } from "../middleware/auth.js";

function mockReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    actor: { type: "none", source: "none" },
  } as unknown as Request;
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  };
  return res as unknown as Response;
}

describe("actorMiddleware run ID validation", () => {
  const fakeDb = {} as Parameters<typeof actorMiddleware>[0];

  it("rejects non-UUID X-Paperclip-Run-Id with 400", async () => {
    const middleware = actorMiddleware(fakeDb, { deploymentMode: "local_trusted" });
    const req = mockReq({ "x-paperclip-run-id": "manual-hb-1773752289" });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts valid UUID X-Paperclip-Run-Id", async () => {
    const middleware = actorMiddleware(fakeDb, { deploymentMode: "local_trusted" });
    const req = mockReq({ "x-paperclip-run-id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d" });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.actor.runId).toBe("a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d");
  });

  it("allows requests without X-Paperclip-Run-Id", async () => {
    const middleware = actorMiddleware(fakeDb, { deploymentMode: "local_trusted" });
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  it("rejects 'none' as run ID", async () => {
    const middleware = actorMiddleware(fakeDb, { deploymentMode: "local_trusted" });
    const req = mockReq({ "x-paperclip-run-id": "none" });
    const res = mockRes();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });
});
