import { describe, expect, it } from "vitest";
import {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
} from "./errors.js";

// ============================================================================
// HttpError
// ============================================================================

describe("HttpError", () => {
  it("is an instance of Error", () => {
    const err = new HttpError(400, "bad");
    expect(err).toBeInstanceOf(Error);
  });

  it("sets status and message", () => {
    const err = new HttpError(404, "not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("not found");
  });

  it("stores optional details", () => {
    const err = new HttpError(422, "invalid", { field: "name" });
    expect(err.details).toEqual({ field: "name" });
  });

  it("details is undefined when not provided", () => {
    const err = new HttpError(500, "server error");
    expect(err.details).toBeUndefined();
  });
});

// ============================================================================
// badRequest
// ============================================================================

describe("badRequest", () => {
  it("returns HttpError with status 400", () => {
    const err = badRequest("missing field");
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.message).toBe("missing field");
  });

  it("passes details through", () => {
    const err = badRequest("invalid", { hint: "check format" });
    expect(err.details).toEqual({ hint: "check format" });
  });
});

// ============================================================================
// unauthorized
// ============================================================================

describe("unauthorized", () => {
  it("returns HttpError with status 401", () => {
    const err = unauthorized();
    expect(err.status).toBe(401);
  });

  it("defaults message to 'Unauthorized'", () => {
    const err = unauthorized();
    expect(err.message).toBe("Unauthorized");
  });

  it("accepts a custom message", () => {
    const err = unauthorized("token expired");
    expect(err.message).toBe("token expired");
  });
});

// ============================================================================
// forbidden
// ============================================================================

describe("forbidden", () => {
  it("returns HttpError with status 403", () => {
    expect(forbidden().status).toBe(403);
  });

  it("defaults message to 'Forbidden'", () => {
    expect(forbidden().message).toBe("Forbidden");
  });

  it("accepts a custom message", () => {
    expect(forbidden("access denied").message).toBe("access denied");
  });
});

// ============================================================================
// notFound
// ============================================================================

describe("notFound", () => {
  it("returns HttpError with status 404", () => {
    expect(notFound().status).toBe(404);
  });

  it("defaults message to 'Not found'", () => {
    expect(notFound().message).toBe("Not found");
  });

  it("accepts a custom message", () => {
    expect(notFound("issue not found").message).toBe("issue not found");
  });
});

// ============================================================================
// conflict
// ============================================================================

describe("conflict", () => {
  it("returns HttpError with status 409", () => {
    const err = conflict("already exists");
    expect(err.status).toBe(409);
    expect(err.message).toBe("already exists");
  });

  it("passes details through", () => {
    const err = conflict("checked out", { by: "agent-1" });
    expect(err.details).toEqual({ by: "agent-1" });
  });
});

// ============================================================================
// unprocessable
// ============================================================================

describe("unprocessable", () => {
  it("returns HttpError with status 422", () => {
    const err = unprocessable("validation failed");
    expect(err.status).toBe(422);
    expect(err.message).toBe("validation failed");
  });

  it("passes details through", () => {
    const err = unprocessable("invalid schema", { errors: ["field required"] });
    expect(err.details).toEqual({ errors: ["field required"] });
  });
});
