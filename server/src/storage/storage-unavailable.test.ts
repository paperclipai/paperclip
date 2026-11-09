import { describe, expect, it } from "vitest";
import { recordStorageFailure } from "./failure-diagnostics.js";
import { isStorageUnavailableError } from "./storage-unavailable.js";

function s3Error(name: string, status?: number, code?: string) {
  return Object.assign(new Error(name), { name, ...(code ? { code } : {}),
    $metadata: status === undefined ? {} : { httpStatusCode: status } });
}

describe("storage unavailability", () => {
  it.each([
    ["503 ServiceUnavailable", s3Error("ServiceUnavailable", 503)],
    ["503 SlowDown", s3Error("SlowDown", 503)],
    ["429 throttling", s3Error("TooManyRequests", 429)],
    ["500 InternalError", s3Error("InternalError", 500)],
    ["a reset without a status", s3Error("Error", undefined, "ECONNRESET")],
  ])("treats %s from the store as unavailable", (_label, error) => {
    expect(isStorageUnavailableError(error)).toBe(true);
  });

  it.each([
    ["404 NoSuchKey", s3Error("NoSuchKey", 404)],
    ["403 AccessDenied", s3Error("AccessDenied", 403)],
    ["412 PreconditionFailed", s3Error("PreconditionFailed", 412)],
    ["an ordinary error", new Error("adapter crashed")],
  ])("does not treat %s as an outage", (_label, error) => {
    expect(isStorageUnavailableError(error)).toBe(false);
  });

  it("treats a storage call the per-operation deadline aborted as unavailable (storage chaos ST2)", () => {
    const aborted = Object.assign(new Error("Request aborted"), { name: "AbortError",
      cause: new DOMException("The operation was aborted due to timeout", "TimeoutError") });
    expect(isStorageUnavailableError(aborted)).toBe(true);
  });

  it("does not treat a run's own Stop abort as a storage outage", () => {
    const stopped = Object.assign(new Error("Request aborted"), { name: "AbortError", cause: new Error("Cancelled by a board operator") });
    expect(isStorageUnavailableError(stopped)).toBe(false);
    expect(isStorageUnavailableError(Object.assign(new Error("Request aborted"), { name: "AbortError" }))).toBe(false);
  });

  it("reads the recorded storage diagnostics first", () => {
    const error = new Error("body reset");
    recordStorageFailure(error, { provider: "s3", operation: "read_object_body", errorCode: "ECONNRESET",
      httpStatus: null, requestId: null, attempts: 1 });
    expect(isStorageUnavailableError(error)).toBe(true);
    const denied = new Error("denied");
    recordStorageFailure(denied, { provider: "s3", operation: "put_object", errorCode: "AccessDenied",
      httpStatus: 403, requestId: null, attempts: 1 });
    expect(isStorageUnavailableError(denied)).toBe(false);
  });
});
