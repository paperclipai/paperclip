// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/api/client";
import { ApiUnavailableError } from "@/api/response";
import { CommentSubmissionUnknownError } from "./comment-submit-result";
import { classifySendFailure, clearPendingSend, isInlineSendRefusal, showsSendFailureToast, readPendingSend, writePendingSend, PendingSendAccountChangedError } from "./pending-send";

const isText = (value: unknown): value is string => typeof value === "string";

describe("classifySendFailure", () => {
  it.each([
    ["an interrupted account-bound request", new PendingSendAccountChangedError()],
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

describe("isInlineSendRefusal", () => {
  it.each([
    ["Plan mode refusing /swarm", new ApiError("Swarm is not available while the task is in Plan mode", 422, null)],
    ["a 403", new ApiError("Forbidden", 403, null)],
    ["a 409", new ApiError("Conflict", 409, null)],
  ])("is true for %s", (_label, error) => {
    expect(isInlineSendRefusal(error)).toBe(true);
  });

  it.each([
    ["a gateway outage with a 4xx status", new ApiError("x", 400, { error: "tenant_app_unavailable" })],
    ["a 429", new ApiError("x", 429, null)],
    ["a 500", new ApiError("x", 500, null)],
    ["a network drop", new TypeError("Failed to fetch")],
    ["a plain error from the caller", new Error("try again")],
  ])("is false for %s, which keeps its toast", (_label, error) => {
    expect(isInlineSendRefusal(error)).toBe(false);
  });
});

describe("showsSendFailureToast", () => {
  const refusal = new ApiError("Swarm is not available while the task is in Plan mode", 422, null);

  it("leaves a refusal to a composer that explains it inline", () => {
    expect(showsSendFailureToast(refusal, { explainsRefusalInline: true })).toBe(false);
  });

  it("keeps the toast when the sending composer does not explain refusals inline", () => {
    expect(showsSendFailureToast(refusal, undefined)).toBe(true);
    expect(showsSendFailureToast(refusal, { explainsRefusalInline: false })).toBe(true);
  });

  it("keeps the toast for other failures and never for a pending send", () => {
    expect(showsSendFailureToast(new Error("try again"), { explainsRefusalInline: true })).toBe(true);
    expect(showsSendFailureToast(new ApiError("x", 503, null), undefined)).toBe(false);
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

  it.each(["local", "session"] as const)("restores a successfully persisted large request from %s storage", (storage) => {
    const payload = "x".repeat(300_000);
    const record = { idempotencyKey: "large-original-request", payload, createdAt: 5 };
    expect(writePendingSend("large", record, storage)).toBe(true);
    const restored = readPendingSend("large", isText, storage);
    expect(restored?.idempotencyKey).toBe(record.idempotencyKey);
    expect(restored?.payload === payload).toBe(true);
    clearPendingSend("large", record.idempotencyKey, storage);
  });

  it("clears only the matching send when given its key", () => {
    writePendingSend("k", { idempotencyKey: "newer-key-1", payload: "newer", createdAt: 2 });
    clearPendingSend("k", "older-key-1");
    expect(readPendingSend("k", isText)?.payload).toBe("newer");
    clearPendingSend("k", "newer-key-1");
    expect(readPendingSend("k", isText)).toBeNull();
  });
});
