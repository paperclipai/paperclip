import { afterEach, describe, expect, it } from "vitest";
import { createUuid, installRandomUuidPolyfill } from "./uuid";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const native = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
const proto = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), "randomUUID");

function simulateInsecureContext() {
  // Insecure contexts expose crypto.getRandomValues but not crypto.randomUUID.
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined, configurable: true, writable: true });
}

afterEach(() => {
  delete (globalThis.crypto as { randomUUID?: unknown }).randomUUID;
  if (native) Object.defineProperty(globalThis.crypto, "randomUUID", native);
  else if (!proto) throw new Error("test environment has no crypto.randomUUID to restore");
});

describe("randomUUID outside a secure context", () => {
  it("installs a v4 polyfill so bare crypto.randomUUID() calls stop throwing", () => {
    simulateInsecureContext();
    expect(() => crypto.randomUUID()).toThrow(TypeError);
    installRandomUuidPolyfill();
    const ids = new Set(Array.from({ length: 100 }, () => crypto.randomUUID()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(V4);
    expect(createUuid()).toMatch(V4); // must not recurse through the polyfill
  });

  it("leaves a native randomUUID alone", () => {
    const before = crypto.randomUUID;
    installRandomUuidPolyfill();
    expect(crypto.randomUUID).toBe(before);
  });
});
