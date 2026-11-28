import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "./random-uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("randomUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses crypto.randomUUID when the browser exposes it", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID });
    expect(randomUuid()).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("falls back to getRandomValues in an insecure context and stays a valid v4 UUID", () => {
    // Plain-http origins expose getRandomValues but not randomUUID.
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = 0xff;
        return bytes;
      },
    });
    const id = randomUuid();
    expect(id).toMatch(UUID_V4);
    expect(id).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
  });

  it("produces distinct ids across calls on the fallback path", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
        return bytes;
      },
    });
    const first = randomUuid();
    const second = randomUuid();
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(first).not.toBe(second);
  });

  it("refuses to generate predictable ids without a CSPRNG", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => randomUuid()).toThrow(/Secure random number generation is unavailable/);
  });
});
