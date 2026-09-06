import { describe, expect, it } from "vitest";

import {
  isTransientDbConnectionError,
  retryOnTransientDbConnectionError,
} from "../middleware/auth.ts";

/** The shape drizzle produces: a wrapper whose `cause` is the driver error. */
function driverClosedError(code: string): Error {
  const driver = Object.assign(new Error(`write ${code} db.example.internal:5432`), { code });
  return new Error("Failed query: insert into \"companies\" (…)", { cause: driver });
}

describe("isTransientDbConnectionError", () => {
  it("detects a closed-connection code anywhere on the cause chain", () => {
    expect(isTransientDbConnectionError(driverClosedError("CONNECTION_CLOSED"))).toBe(true);
    expect(isTransientDbConnectionError(driverClosedError("CONNECTION_ENDED"))).toBe(true);
    expect(isTransientDbConnectionError(driverClosedError("CONNECTION_DESTROYED"))).toBe(true);
    const bare = Object.assign(new Error("write CONNECTION_CLOSED host:5432"), {
      code: "CONNECTION_CLOSED",
    });
    expect(isTransientDbConnectionError(bare)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isTransientDbConnectionError(new Error("boom"))).toBe(false);
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(isTransientDbConnectionError(unique)).toBe(false);
    expect(isTransientDbConnectionError(new Error("outer", { cause: unique }))).toBe(false);
    expect(isTransientDbConnectionError("CONNECTION_CLOSED")).toBe(false);
    expect(isTransientDbConnectionError(undefined)).toBe(false);
  });
});

describe("retryOnTransientDbConnectionError", () => {
  it("retries exactly once after a transient closed connection", async () => {
    let calls = 0;
    const result = await retryOnTransientDbConnectionError(async () => {
      calls += 1;
      if (calls === 1) throw driverClosedError("CONNECTION_CLOSED");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("propagates a non-transient failure without retrying", async () => {
    let calls = 0;
    await expect(
      retryOnTransientDbConnectionError(async () => {
        calls += 1;
        throw new Error("constraint violation");
      }),
    ).rejects.toThrow("constraint violation");
    expect(calls).toBe(1);
  });

  it("propagates the second failure when the retry also dies", async () => {
    let calls = 0;
    await expect(
      retryOnTransientDbConnectionError(async () => {
        calls += 1;
        throw driverClosedError("CONNECTION_CLOSED");
      }),
    ).rejects.toThrow("Failed query");
    expect(calls).toBe(2);
  });
});
