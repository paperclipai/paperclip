import { describe, expect, it } from "vitest";

import {
  isTransientDbConnectionError,
  retryOnTransientDbConnectionError,
} from "../middleware/auth.ts";

/** The shape drizzle produces: a wrapper whose `cause` is the driver error. */
function driverConnectionError(code: string): Error {
  const driver = Object.assign(new Error(`write ${code} db.example.internal:5432`), { code });
  return new Error("Failed query: insert into \"companies\" (…)", { cause: driver });
}

describe("isTransientDbConnectionError", () => {
  it("detects a transient connection code anywhere on the cause chain", () => {
    expect(isTransientDbConnectionError(driverConnectionError("CONNECT_TIMEOUT"))).toBe(true);
    expect(isTransientDbConnectionError(driverConnectionError("CONNECTION_CLOSED"))).toBe(true);
    expect(isTransientDbConnectionError(driverConnectionError("CONNECTION_ENDED"))).toBe(true);
    expect(isTransientDbConnectionError(driverConnectionError("CONNECTION_DESTROYED"))).toBe(true);
    const bare = Object.assign(new Error("write CONNECTION_CLOSED host:5432"), {
      code: "CONNECTION_CLOSED",
    });
    expect(isTransientDbConnectionError(bare)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isTransientDbConnectionError(new Error("boom"))).toBe(false);
    const unique = Object.assign(new Error("duplicate key"), { code: "23505" });
    expect(isTransientDbConnectionError(unique)).toBe(false);
    expect(isTransientDbConnectionError(driverConnectionError("28P01"))).toBe(false);
    expect(isTransientDbConnectionError(new Error("outer", { cause: unique }))).toBe(false);
    expect(isTransientDbConnectionError("CONNECTION_CLOSED")).toBe(false);
    expect(isTransientDbConnectionError(undefined)).toBe(false);
  });
});

describe("retryOnTransientDbConnectionError", () => {
  it.each(["CONNECT_TIMEOUT", "CONNECTION_CLOSED"])("retries after %s", async (code) => {
    let calls = 0;
    const result = await retryOnTransientDbConnectionError(async () => {
      calls += 1;
      if (calls === 1) throw driverConnectionError(code);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("survives a pool-wide recycle where the first replay draws another dead socket", async () => {
    // A suspending pooled endpoint kills every pooled socket at once, so
    // the first replay can fail identically to the original attempt.
    let calls = 0;
    const result = await retryOnTransientDbConnectionError(async () => {
      calls += 1;
      if (calls <= 2) throw driverConnectionError("CONNECTION_CLOSED");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
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

  it.each(["CONNECT_TIMEOUT", "CONNECTION_CLOSED"])("propagates %s once the replay budget is spent", async (code) => {
    let calls = 0;
    await expect(
      retryOnTransientDbConnectionError(async () => {
        calls += 1;
        throw driverConnectionError(code);
      }),
    ).rejects.toThrow("Failed query");
    expect(calls).toBe(3);
  });
});
