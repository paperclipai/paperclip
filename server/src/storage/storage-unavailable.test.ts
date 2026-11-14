import { describe, expect, it } from "vitest";
import { recordS3BodyFailure, withS3FailureDiagnostics } from "./s3-failure.js";
import { isStorageUnavailableError } from "./storage-unavailable.js";

function s3Error(name: string, status?: number, code?: string) {
  return Object.assign(new Error(name), { name, ...(code ? { code } : {}),
    $metadata: status === undefined ? {} : { httpStatusCode: status, attempts: 3 } });
}

async function recorded(error: unknown, signal?: AbortSignal) {
  return withS3FailureDiagnostics("put_object", async () => { throw error; }, signal).catch(thrown => thrown);
}

function sdkAbort() {
  const aborted = new Error("Request aborted");
  aborted.name = "AbortError";
  return aborted;
}

describe("storage unavailability", () => {
  it.each([
    ["503 ServiceUnavailable", s3Error("ServiceUnavailable", 503)],
    ["503 SlowDown", s3Error("SlowDown", 503)],
    ["429 throttling", s3Error("TooManyRequests", 429)],
    ["500 InternalError", s3Error("InternalError", 500)],
    ["408 RequestTimeout", s3Error("RequestTimeout", 408)],
    ["a reset recorded under its error name", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["a refused connection without a status", s3Error("Error", undefined, "ECONNREFUSED")],
    ["400 ExpiredToken", s3Error("ExpiredToken", 400)],
    ["403 ExpiredToken", s3Error("ExpiredToken", 403)],
    ["403 InvalidAccessKeyId", s3Error("InvalidAccessKeyId", 403)],
    ["403 SignatureDoesNotMatch", s3Error("SignatureDoesNotMatch", 403)],
  ])("treats %s from the store as unavailable", async (_label, error) => {
    expect(isStorageUnavailableError(await recorded(error))).toBe(true);
  });

  it.each([
    ["404 NoSuchKey", s3Error("NoSuchKey", 404)],
    ["403 AccessDenied", s3Error("AccessDenied", 403)],
    ["a credential source that could not load a key", s3Error("CredentialsProviderError")],
    ["a credential code without a store status", s3Error("ExpiredToken")],
    ["412 PreconditionFailed", s3Error("PreconditionFailed", 412)],
    ["an ordinary error", new Error("adapter crashed")],
  ])("does not treat %s as an outage", async (_label, error) => {
    expect(isStorageUnavailableError(await recorded(error))).toBe(false);
  });

  it("treats a download body reset after a 200 response as unavailable", () => {
    const reset = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
    recordS3BodyFailure(reset, { $metadata: { httpStatusCode: 200, requestId: "req-1" } });
    expect(isStorageUnavailableError(reset)).toBe(true);
  });

  it("treats a storage call its deadline aborted as unavailable (storage chaos ST2)", async () => {
    const deadline = AbortSignal.timeout(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(isStorageUnavailableError(await recorded(sdkAbort(), deadline))).toBe(true);
  });

  it("does not treat a run's own Stop abort as a storage outage", async () => {
    const stop = new AbortController();
    stop.abort(new Error("Cancelled by a board operator"));
    expect(isStorageUnavailableError(await recorded(sdkAbort(), stop.signal))).toBe(false);
    expect(isStorageUnavailableError(await recorded(sdkAbort()))).toBe(false);
  });

  it("requires the failure to come from a storage call", () => {
    expect(isStorageUnavailableError(s3Error("ServiceUnavailable", 503))).toBe(false);
    expect(isStorageUnavailableError(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe(false);
  });
});
