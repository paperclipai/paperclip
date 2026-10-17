import { afterEach, describe, expect, it, vi } from "vitest";
import { createUuid } from "./uuid";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("createUuid", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses crypto.randomUUID when available", () => {
    const uuid = "12345678-1234-4123-8123-123456789abc";
    const randomUUID = vi.fn(() => uuid);
    vi.stubGlobal("crypto", { randomUUID });

    expect(createUuid()).toBe(uuid);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("falls back to a v4-shaped id when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {});
    expect(createUuid()).toMatch(UUID_V4);
  });

  it("falls back when crypto itself is missing", () => {
    vi.stubGlobal("crypto", undefined);
    expect(createUuid()).toMatch(UUID_V4);
  });

  it("produces distinct ids", () => {
    vi.stubGlobal("crypto", {});
    const seen = new Set([createUuid(), createUuid(), createUuid()]);
    expect(seen.size).toBe(3);
  });
});
