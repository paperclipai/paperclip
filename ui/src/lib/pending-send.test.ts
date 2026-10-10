// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { ApiUnavailableError } from "@/api/response";
import { CommentSubmissionUnknownError } from "./comment-submit-result";
import { classifySendFailure, clearPendingSend, readPendingSend, writePendingSend } from "./pending-send";

const isText = (value: unknown): value is string => typeof value === "string";

describe("classifySendFailure", () => {
  it.each([
    ["a lost comment receipt", new CommentSubmissionUnknownError()],
    ["a gateway outage with a 4xx status", new ApiError("x", 400, { error: "tenant_app_unavailable" })],
    ["a 503", new ApiError("x", 503, null)],
    ["a 500 that may have committed", new ApiError("x", 500, null)],
    ["a 429", new ApiError("x", 429, null)],
    ["a network drop", new TypeError("Failed to fetch")],
    ["an HTML proxy page", new ApiUnavailableError(502)],
  ])("keeps %s pending", (_label, error) => {
    expect(classifySendFailure(error)).toBe("pending");
  });

  it.each([
    ["a 403", new ApiError("Forbidden", 403, null)],
    ["a 409", new ApiError("Conflict", 409, null)],
    ["a 422", new ApiError("Invalid", 422, null)],
    ["a plain error from the caller", new Error("try again")],
  ])("rejects %s", (_label, error) => {
    expect(classifySendFailure(error)).toBe("rejected");
  });
});

describe("pending-send records", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a record and validates its payload", () => {
    expect(writePendingSend("k", { idempotencyKey: "key-12345", payload: "body", createdAt: 5 })).toBe(true);
    expect(readPendingSend("k", isText)).toEqual({ idempotencyKey: "key-12345", payload: "body", createdAt: 5 });
    expect(readPendingSend("k", (value): value is number => typeof value === "number")).toBeNull();
    expect(readPendingSend("other", isText)).toBeNull();
  });

  it("clears only the matching send when given its key", () => {
    writePendingSend("k", { idempotencyKey: "newer-key-1", payload: "newer", createdAt: 2 });
    clearPendingSend("k", "older-key-1");
    expect(readPendingSend("k", isText)?.payload).toBe("newer");
    clearPendingSend("k", "newer-key-1");
    expect(readPendingSend("k", isText)).toBeNull();
  });
});
