import { describe, expect, it } from "vitest";
import { describeThrownValue } from "./describe-thrown-value.js";

describe("describeThrownValue", () => {
  it("keeps the message of an Error", () => {
    expect(describeThrownValue(new Error("pod not found"))).toBe("pod not found");
    expect(describeThrownValue(new TypeError(""))).toBe("");
  });

  it("names the cause of a ws ErrorEvent-like rejection", () => {
    class ErrorEvent {
      readonly type = "error";
      readonly message = "Unexpected server response: 403";
      readonly error = new Error("Unexpected server response: 403");
      readonly target = { url: "wss://cluster.example.test/exec" };
    }
    expect(describeThrownValue(new ErrorEvent())).toBe("ErrorEvent: Unexpected server response: 403");
  });

  it("reads status fields from a plain object and a nested body", () => {
    expect(describeThrownValue({ statusCode: 401, body: { reason: "Unauthorized", message: "token expired" } }))
      .toBe("401: token expired: Unauthorized");
    expect(describeThrownValue({ code: "ECONNRESET" })).toBe("ECONNRESET");
  });

  it("never serializes other fields of the object", () => {
    const rejected = {
      message: "exec failed",
      request: { headers: { Authorization: "Bearer synthetic-secret-token" } },
    };
    const text = describeThrownValue(rejected);
    expect(text).toBe("exec failed");
    expect(text).not.toContain("synthetic-secret-token");
  });

  it("returns a bounded single line", () => {
    const text = describeThrownValue({ message: `line one\nline two ${"x".repeat(1000)}` });
    expect(text).not.toContain("\n");
    expect(text.length).toBe(500);
    expect(text.endsWith("...")).toBe(true);
  });

  it("does not throw when a field getter throws", () => {
    const hostile = {
      get message(): string {
        throw new Error("getter failed");
      },
      code: "EPIPE",
    };
    expect(describeThrownValue(hostile)).toBe("EPIPE");
  });

  it("describes an object with no text fields without printing [object Object]", () => {
    expect(describeThrownValue({})).toBe("Unknown error (no message)");
    class SocketClosed {}
    expect(describeThrownValue(new SocketClosed())).toBe("SocketClosed (no message)");
  });

  it("formats primitives as before", () => {
    expect(describeThrownValue("boom")).toBe("boom");
    expect(describeThrownValue(42)).toBe("42");
    expect(describeThrownValue(undefined)).toBe("undefined");
    expect(describeThrownValue(null)).toBe("null");
  });
});
