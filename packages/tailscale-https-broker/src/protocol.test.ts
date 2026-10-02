import { describe, expect, it } from "vitest";
import { ProtocolError, decodeRequest, MAX_REQUEST_BYTES } from "./protocol.js";

const RUNTIME = "2af79bb1-ecc5-4410-8438-091be135a921";

function frame(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("decodeRequest", () => {
  it("decodes a valid reserve request", () => {
    const req = decodeRequest(
      frame({
        v: 1,
        op: "reserve",
        requestId: "req-1",
        runtimeId: RUNTIME,
        listeners: [
          { purpose: "app", port: 42010 },
          { purpose: "vite_hmr", port: 52010 },
        ],
      }),
    );
    expect(req).toEqual({
      op: "reserve",
      requestId: "req-1",
      runtimeId: RUNTIME,
      listeners: [
        { purpose: "app", port: 42010 },
        { purpose: "vite_hmr", port: 52010 },
      ],
    });
  });

  it("decodes expose, remove, and list", () => {
    expect(
      decodeRequest(frame({ v: 1, op: "list", requestId: "r" })).op,
    ).toBe("list");
    const rm = decodeRequest(
      frame({ v: 1, op: "remove", requestId: "r", runtimeId: RUNTIME, handle: "a".repeat(20) }),
    );
    expect(rm.op).toBe("remove");
    const expose = decodeRequest(
      frame({ v: 1, op: "expose", requestId: "r", runtimeId: RUNTIME, handle: "a".repeat(20) }),
    );
    expect(expose.op).toBe("expose");
  });

  it("rejects unsupported protocol version", () => {
    expect(() => decodeRequest(frame({ v: 2, op: "list", requestId: "r" }))).toThrow(ProtocolError);
    try {
      decodeRequest(frame({ v: 2, op: "list", requestId: "r" }));
    } catch (e) {
      expect((e as ProtocolError).code).toBe("unsupported_version");
    }
  });

  it("rejects unknown operations and unknown fields", () => {
    expect(() => decodeRequest(frame({ v: 1, op: "reset", requestId: "r" }))).toThrow(/unknown operation/);
    expect(() =>
      decodeRequest(frame({ v: 1, op: "list", requestId: "r", extra: 1 })),
    ).toThrow(/unknown field/);
  });

  it("rejects duplicate keys", () => {
    expect(() => decodeRequest('{"v":1,"op":"list","op":"expose","requestId":"r"}')).toThrow(/duplicate/);
  });

  it("rejects a non-UUID runtimeId and out-of-canonical ports", () => {
    expect(() =>
      decodeRequest(frame({ v: 1, op: "reserve", requestId: "r", runtimeId: "not-a-uuid", listeners: [{ purpose: "app", port: 42010 }] })),
    ).toThrow(/runtime/);
    expect(() =>
      decodeRequest(frame({ v: 1, op: "reserve", requestId: "r", runtimeId: RUNTIME, listeners: [{ purpose: "app", port: "42010" }] })),
    ).toThrow();
  });

  it("rejects duplicate ports/purposes and too many listeners", () => {
    expect(() =>
      decodeRequest(frame({ v: 1, op: "reserve", requestId: "r", runtimeId: RUNTIME, listeners: [{ purpose: "app", port: 42010 }, { purpose: "app", port: 42010 }] })),
    ).toThrow(/duplicate/);
    expect(() =>
      decodeRequest(frame({ v: 1, op: "reserve", requestId: "r", runtimeId: RUNTIME, listeners: [{ purpose: "app", port: 42010 }, { purpose: "vite_hmr", port: 52010 }, { purpose: "app", port: 42011 }] })),
    ).toThrow(/too many/);
  });

  it("rejects HMR-only and mismatched app/HMR reservations", () => {
    expect(() => decodeRequest(frame({
      v: 1,
      op: "reserve",
      requestId: "r",
      runtimeId: RUNTIME,
      listeners: [{ purpose: "vite_hmr", port: 52000 }],
    }))).toThrow(/app listener/);
    expect(() => decodeRequest(frame({
      v: 1,
      op: "reserve",
      requestId: "r",
      runtimeId: RUNTIME,
      listeners: [
        { purpose: "app", port: 42000 },
        { purpose: "vite_hmr", port: 52001 },
      ],
    }))).toThrow(/companion/);
  });

  it("rejects oversized frames", () => {
    const big = "x".repeat(MAX_REQUEST_BYTES + 1);
    expect(() =>
      decodeRequest(frame({ v: 1, op: "list", requestId: "r", pad: big })),
    ).toThrow(/size limit|unknown field/);
  });

  it("rejects invalid handles on remove", () => {
    expect(() =>
      decodeRequest(frame({ v: 1, op: "remove", requestId: "r", runtimeId: RUNTIME, handle: "short" })),
    ).toThrow();
  });
});
