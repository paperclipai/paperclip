import { describe, expect, it } from "vitest";
import { decodeRunEventPayload, encodeRunEventPayload } from "./run-event-payload.js";

describe("run-event JSONB payload codec", () => {
  it("leaves ordinary payloads and literal escape sequences unchanged", () => {
    const payload = { prpEvent: { payload: { output: "virtual:\\u0000file.js", emoji: "🧪" } } };
    const encoded = encodeRunEventPayload(payload);
    expect(encoded).toBe(JSON.stringify(payload));
    expect(decodeRunEventPayload(encoded)).toEqual(payload);
    expect(decodeRunEventPayload(payload)).toBe(payload);
  });

  it("round-trips NULs in nested strings, arrays and keys without leaking its sidecar", () => {
    const payload = {
      prpEvent: {
        sourceKind: "runner",
        payload: { output: "../\u0000virtual:/file.js", items: [null, true, 1, "\u0000"] },
      },
      "\u0000key": "a",
      "\\u0000key": "b",
    };
    const encoded = encodeRunEventPayload(payload);
    const stored = JSON.parse(encoded);
    expect(stored.prpEvent.sourceKind).toBe("runner");
    expect(stored.prpEvent.payload.output).toBe("../\\u0000virtual:/file.js");
    // No actual NUL survives anywhere in the object sent to PostgreSQL.
    function assertNoNul(value: unknown): void {
      if (typeof value === "string") expect(value).not.toContain("\u0000");
      if (value !== null && typeof value === "object") {
        for (const [key, entry] of Object.entries(value)) {
          expect(key).not.toContain("\u0000");
          assertNoNul(entry);
        }
      }
    }
    assertNoNul(stored);
    expect(decodeRunEventPayload(encoded)).toEqual(payload);
    expect(decodeRunEventPayload(stored)).toEqual(payload);
  });

  it("preserves caller-owned keys that collide with the storage marker", () => {
    for (const value of ["not JSON", '{"forged":true}', null, { nested: "\u0000" }]) {
      const payload = { $paperclipRunEventJsonV1: value, output: "original" };
      expect(decodeRunEventPayload(encodeRunEventPayload(payload))).toEqual(payload);
    }
  });
});
