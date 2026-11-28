import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("createUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when it is available", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID });
    expect(createUuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("falls back to a v4 UUID built from getRandomValues when randomUUID is missing (plain-HTTP origin)", () => {
    // On a non-secure origin the browser exposes crypto.getRandomValues but
    // not crypto.randomUUID. The fallback must still produce valid v4 ids.
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256;
        return bytes;
      },
    });
    const first = createUuid();
    const second = createUuid();
    expect(first).toMatch(UUID_V4_PATTERN);
    expect(second).toMatch(UUID_V4_PATTERN);
  });

  it("still returns a v4-shaped id when WebCrypto is absent entirely", () => {
    vi.stubGlobal("crypto", undefined);
    expect(createUuid()).toMatch(UUID_V4_PATTERN);
  });
});
