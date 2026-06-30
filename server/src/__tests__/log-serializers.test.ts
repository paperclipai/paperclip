import { describe, expect, it } from "vitest";
import { safeErrSerializer } from "../middleware/log-serializers.js";

describe("safeErrSerializer (SCR-4/SCR-5 un-traced 500 guard)", () => {
  it("captures message, type and stack from a real Error", () => {
    const err = new TypeError("boom");
    const out = safeErrSerializer(err);
    expect(out.message).toBe("boom");
    expect(out.type).toBe("TypeError");
    expect(typeof out.stack).toBe("string");
    expect(out.stack).toContain("boom");
  });

  it("captures driver code/errno from connection-style errors", () => {
    const err = Object.assign(new Error("connection terminated"), {
      code: "CONNECTION_CLOSED",
      errno: -4077,
    });
    const out = safeErrSerializer(err);
    expect(out.code).toBe("CONNECTION_CLOSED");
    expect(out.errno).toBe(-4077);
    expect(out.stack).toContain("connection terminated");
  });

  it("handles the plain error-context shape ({ message, stack, name })", () => {
    const out = safeErrSerializer({
      message: "db exploded",
      name: "PostgresError",
      stack: "PostgresError: db exploded\n    at db.ts:1",
      details: { code: "57P01" },
    });
    expect(out.message).toBe("db exploded");
    expect(out.type).toBe("PostgresError");
    expect(out.stack).toContain("db exploded");
    expect(out.details).toEqual({ code: "57P01" });
  });

  it("never throws on a hostile error with circular refs and throwing getters", () => {
    // This is exactly the shape that took down the log line: a raw connection
    // error whose default serialization could throw must instead degrade safely.
    const hostile: Record<string, unknown> = { message: "raw connection error" };
    hostile.self = hostile; // circular
    Object.defineProperty(hostile, "stack", {
      enumerable: true,
      get() {
        throw new Error("getter blows up");
      },
    });

    let out!: ReturnType<typeof safeErrSerializer>;
    expect(() => {
      out = safeErrSerializer(hostile);
    }).not.toThrow();
    expect(out.message).toBe("<unserializable error>");
  });

  it("degrades safely for null/undefined and primitives", () => {
    expect(safeErrSerializer(null).message).toBe("<no error>");
    expect(safeErrSerializer(undefined).message).toBe("<no error>");
    expect(safeErrSerializer("just a string").message).toBe("just a string");
  });
});
