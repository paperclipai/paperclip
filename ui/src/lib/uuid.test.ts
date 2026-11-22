import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createUuid", () => {
  it("uses crypto.randomUUID when the browser exposes it", () => {
    const randomUUID = vi.fn(() => "11111111-1111-4111-8111-111111111111");
    vi.stubGlobal("crypto", { randomUUID });

    expect(createUuid()).toBe("11111111-1111-4111-8111-111111111111");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("builds an RFC 4122 version 4 id from getRandomValues on plain HTTP origins", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });

    const value = createUuid();

    expect(value).toMatch(UUID_V4_PATTERN);
    expect(value).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
  });

  it("still returns a version 4 id when no crypto API exists", () => {
    vi.stubGlobal("crypto", undefined);

    const first = createUuid();
    const second = createUuid();

    expect(first).toMatch(UUID_V4_PATTERN);
    expect(second).toMatch(UUID_V4_PATTERN);
    expect(first).not.toBe(second);
  });
});
