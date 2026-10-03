import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUuidOrFallback } from "./random-uuid";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("randomUuidOrFallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delegates to crypto.randomUUID when it is available", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "b1b7c3d4-1111-4222-8333-444455556666" });
    expect(randomUuidOrFallback()).toBe("b1b7c3d4-1111-4222-8333-444455556666");
  });

  it("falls back to an RFC 4122 version 4 UUID when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    const first = randomUuidOrFallback();
    const second = randomUuidOrFallback();
    expect(first).toMatch(UUID_V4_RE);
    expect(second).toMatch(UUID_V4_RE);
    expect(first).not.toBe(second);
  });
});
