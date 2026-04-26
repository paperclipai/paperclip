import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { NextFunction, Request, Response } from "express";

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: vi.fn().mockReturnValue(null),
}));

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackErrorHandlerCrash: vi.fn(),
}));

import { HttpError } from "../errors.js";
import { errorHandler } from "./error-handler.js";

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    originalUrl: "/api/test",
    body: { foo: "bar" },
    params: {},
    query: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { status, json, __errorContext: undefined } as unknown as Response & { json: typeof json; status: typeof status };
}

const next: NextFunction = vi.fn() as unknown as NextFunction;

// ============================================================================
// errorHandler — HttpError (client errors < 500)
// ============================================================================

describe("errorHandler — HttpError client errors", () => {
  it("responds with the HttpError status code", () => {
    const res = makeRes();
    errorHandler(new HttpError(400, "bad input"), makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("responds with the HttpError message", () => {
    const res = makeRes();
    errorHandler(new HttpError(404, "not found"), makeReq(), res, next);
    const jsonFn = (res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json;
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ error: "not found" }));
  });

  it("includes details in the response when HttpError has details", () => {
    const res = makeRes();
    const details = { field: "name", message: "required" };
    errorHandler(new HttpError(422, "unprocessable", details), makeReq(), res, next);
    const jsonFn = (res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json;
    expect(jsonFn).toHaveBeenCalledWith(
      expect.objectContaining({ details }),
    );
  });

  it("omits details key when HttpError has no details", () => {
    const res = makeRes();
    errorHandler(new HttpError(403, "forbidden"), makeReq(), res, next);
    const jsonFn = (res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json;
    const call = jsonFn.mock.calls[0][0];
    expect(call).not.toHaveProperty("details");
  });

  it("handles 401 unauthorized", () => {
    const res = makeRes();
    errorHandler(new HttpError(401, "Unauthorized"), makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

// ============================================================================
// errorHandler — HttpError server errors (>= 500)
// ============================================================================

describe("errorHandler — HttpError server errors", () => {
  it("responds with 500 status for HttpError 500", () => {
    const res = makeRes();
    errorHandler(new HttpError(500, "internal error"), makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("responds with 503 status for HttpError 503", () => {
    const res = makeRes();
    errorHandler(new HttpError(503, "service unavailable"), makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

// ============================================================================
// errorHandler — ZodError
// ============================================================================

describe("errorHandler — ZodError", () => {
  it("responds with 400 for ZodError", () => {
    const res = makeRes();
    const zodError = new ZodError([{ code: "invalid_type", path: ["name"], message: "Required", expected: "string", received: "undefined" }]);
    errorHandler(zodError, makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("includes 'Validation error' message for ZodError", () => {
    const res = makeRes();
    const zodError = new ZodError([]);
    errorHandler(zodError, makeReq(), res, next);
    const jsonFn = (res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json;
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ error: "Validation error" }));
  });

  it("includes zod error details in the response", () => {
    const res = makeRes();
    const issues = [{ code: "invalid_type" as const, path: ["email"], message: "Invalid email", expected: "string" as const, received: "undefined" as const }];
    const zodError = new ZodError(issues);
    errorHandler(zodError, makeReq(), res, next);
    const jsonFn = (res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json;
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ details: expect.any(Array) }));
  });
});

// ============================================================================
// errorHandler — generic errors (non-HttpError, non-ZodError)
// ============================================================================

describe("errorHandler — generic Error", () => {
  it("responds with 500 for a generic Error", () => {
    const res = makeRes();
    errorHandler(new Error("something broke"), makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("returns 'Internal server error' message for generic Error", () => {
    const res = makeRes();
    errorHandler(new Error("oops"), makeReq(), res, next);
    const jsonFn = (res.status as ReturnType<typeof vi.fn>).mock.results[0].value.json;
    expect(jsonFn).toHaveBeenCalledWith(expect.objectContaining({ error: "Internal server error" }));
  });

  it("handles non-Error thrown values (string)", () => {
    const res = makeRes();
    errorHandler("string error", makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("handles non-Error thrown values (number)", () => {
    const res = makeRes();
    errorHandler(42, makeReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
