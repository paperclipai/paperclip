import { describe, expect, it } from "vitest";
import {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
} from "../errors.js";

// ============================================================================
// HttpError class
// ============================================================================

describe("HttpError", () => {
  it("is an instance of Error", () => {
    const err = new HttpError(500, "Internal Server Error");
    expect(err).toBeInstanceOf(Error);
  });

  it("is an instance of HttpError", () => {
    const err = new HttpError(500, "Internal Server Error");
    expect(err).toBeInstanceOf(HttpError);
  });

  it("sets status on the instance", () => {
    const err = new HttpError(418, "I'm a teapot");
    expect(err.status).toBe(418);
  });

  it("sets message on the instance", () => {
    const err = new HttpError(500, "Something broke");
    expect(err.message).toBe("Something broke");
  });

  it("sets details when provided", () => {
    const details = { field: "email", reason: "invalid" };
    const err = new HttpError(400, "Validation failed", details);
    expect(err.details).toEqual(details);
  });

  it("details is undefined when not provided", () => {
    const err = new HttpError(404, "Not found");
    expect(err.details).toBeUndefined();
  });

  it("accepts any serializable value as details", () => {
    const err1 = new HttpError(400, "msg", "string details");
    expect(err1.details).toBe("string details");

    const err2 = new HttpError(400, "msg", 42);
    expect(err2.details).toBe(42);

    const err3 = new HttpError(400, "msg", ["a", "b"]);
    expect(err3.details).toEqual(["a", "b"]);
  });
});

// ============================================================================
// badRequest — 400
// ============================================================================

describe("badRequest", () => {
  it("returns an HttpError with status 400", () => {
    const err = badRequest("Bad input");
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
  });

  it("sets the provided message", () => {
    const err = badRequest("Field is required");
    expect(err.message).toBe("Field is required");
  });

  it("sets details when provided", () => {
    const details = { field: "name" };
    const err = badRequest("Validation error", details);
    expect(err.details).toEqual(details);
  });

  it("details is undefined when not provided", () => {
    const err = badRequest("Bad input");
    expect(err.details).toBeUndefined();
  });
});

// ============================================================================
// unauthorized — 401
// ============================================================================

describe("unauthorized", () => {
  it("returns an HttpError with status 401", () => {
    const err = unauthorized();
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
  });

  it("defaults message to 'Unauthorized'", () => {
    const err = unauthorized();
    expect(err.message).toBe("Unauthorized");
  });

  it("accepts a custom message", () => {
    const err = unauthorized("Token expired");
    expect(err.message).toBe("Token expired");
  });
});

// ============================================================================
// forbidden — 403
// ============================================================================

describe("forbidden", () => {
  it("returns an HttpError with status 403", () => {
    const err = forbidden();
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
  });

  it("defaults message to 'Forbidden'", () => {
    const err = forbidden();
    expect(err.message).toBe("Forbidden");
  });

  it("accepts a custom message", () => {
    const err = forbidden("Insufficient permissions");
    expect(err.message).toBe("Insufficient permissions");
  });
});

// ============================================================================
// notFound — 404
// ============================================================================

describe("notFound", () => {
  it("returns an HttpError with status 404", () => {
    const err = notFound();
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
  });

  it("defaults message to 'Not found'", () => {
    const err = notFound();
    expect(err.message).toBe("Not found");
  });

  it("accepts a custom message", () => {
    const err = notFound("Issue not found");
    expect(err.message).toBe("Issue not found");
  });
});

// ============================================================================
// conflict — 409
// ============================================================================

describe("conflict", () => {
  it("returns an HttpError with status 409", () => {
    const err = conflict("Already exists");
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
  });

  it("sets the provided message", () => {
    const err = conflict("Resource already exists");
    expect(err.message).toBe("Resource already exists");
  });

  it("sets details when provided", () => {
    const details = { existingId: "abc123" };
    const err = conflict("Duplicate entry", details);
    expect(err.details).toEqual(details);
  });

  it("details is undefined when not provided", () => {
    const err = conflict("Conflict");
    expect(err.details).toBeUndefined();
  });
});

// ============================================================================
// unprocessable — 422
// ============================================================================

describe("unprocessable", () => {
  it("returns an HttpError with status 422", () => {
    const err = unprocessable("Validation failed");
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(422);
  });

  it("sets the provided message", () => {
    const err = unprocessable("Cannot process entity");
    expect(err.message).toBe("Cannot process entity");
  });

  it("sets details when provided", () => {
    const details = [{ path: "email", issue: "invalid format" }];
    const err = unprocessable("Validation failed", details);
    expect(err.details).toEqual(details);
  });

  it("details is undefined when not provided", () => {
    const err = unprocessable("Unprocessable");
    expect(err.details).toBeUndefined();
  });
});
