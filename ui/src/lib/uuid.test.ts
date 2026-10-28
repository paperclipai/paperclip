import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses getRandomValues when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xff);
        return bytes;
      },
    });

    expect(createUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(createUuid()).toMatch(UUID_V4);
  });

  it("does not use predictable randomness when Web Crypto is unavailable", () => {
    vi.stubGlobal("crypto", {});

    expect(() => createUuid()).toThrow("Secure random number generation is unavailable");
  });
});
