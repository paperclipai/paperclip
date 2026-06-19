import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler, isInvalidJsonBodyError } from "../middleware/error-handler.js";

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("exposes raw 500 messages for trusted Cloud tenant imports", () => {
    const req = {
      ...makeReq(),
      method: "POST",
      originalUrl: "/api/companies/import",
      actor: {
        type: "board",
        userId: "cloud-user",
        source: "cloud_tenant",
      },
    } as unknown as Request;
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("portable file references missing upload id");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Internal server error",
      message: "portable file references missing upload id",
    });
    expect(res.err).toBe(err);
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });

  it("returns 400 for malformed JSON request bodies", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new SyntaxError("Unexpected token i in JSON at position 1") as SyntaxError & {
      status: number;
      type: string;
    };
    err.status = 400;
    err.type = "entity.parse.failed";

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Invalid JSON body",
      details: [{ message: err.message, code: "invalid_json" }],
    });
    expect(res.err).toBeUndefined();
  });
});

describe("isInvalidJsonBodyError", () => {
  it("detects entity.parse.failed type", () => {
    const err = Object.assign(new SyntaxError("bad json"), { type: "entity.parse.failed" });
    expect(isInvalidJsonBodyError(err)).toBe(true);
  });

  it("detects status 400 SyntaxError", () => {
    const err = Object.assign(new SyntaxError("bad"), { status: 400 });
    expect(isInvalidJsonBodyError(err)).toBe(true);
  });

  it("detects json in message", () => {
    const err = new SyntaxError("Unexpected JSON token");
    expect(isInvalidJsonBodyError(err)).toBe(true);
  });

  it("returns false for non-SyntaxError", () => {
    expect(isInvalidJsonBodyError(new Error("boom"))).toBe(false);
    expect(isInvalidJsonBodyError(new TypeError("bad type"))).toBe(false);
  });
});
