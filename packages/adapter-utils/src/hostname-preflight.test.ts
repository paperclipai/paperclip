import { describe, expect, it } from "vitest";
import { preflightHostnameLookup, type HostnamePreflightOptions } from "./hostname-preflight.js";

function makeResolver(
  behavior: (host: string) => Promise<Array<{ address: string; family: number }> | undefined>,
) {
  return ((host: string) => behavior(host)) as unknown as HostnamePreflightOptions["resolver"];
}

describe("preflightHostnameLookup", () => {
  it("returns ok:true with addresses when the resolver returns A records", async () => {
    const resolver = makeResolver(async () => [
      { address: "10.0.0.1", family: 4 },
    ]);
    const result = await preflightHostnameLookup("chatgpt.com", { resolver });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe("chatgpt.com");
      expect(result.addresses).toEqual([{ address: "10.0.0.1", family: 4 }]);
    }
  });

  it("returns ok:false with the underlying Node error code on ENOTFOUND", async () => {
    const resolver = makeResolver(async () => {
      const err = new Error("failed to lookup address information: nodename nor servname provided, or not known") as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    });
    const result = await preflightHostnameLookup("chatgpt.com", { resolver });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("lookup_failed");
      expect(result.errorCode).toBe("ENOTFOUND");
      expect(result.message).toMatch(/lookup address information/);
    }
  });

  it("returns ok:false with reason timeout when the resolver hangs past the deadline", async () => {
    const resolver = makeResolver(
      () => new Promise(() => undefined) as unknown as Promise<Array<{ address: string; family: number }>>,
    );
    const result = await preflightHostnameLookup("chatgpt.com", { resolver, timeoutMs: 25 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.message).toMatch(/timeout/i);
    }
  });

  it("returns ok:false with reason empty_result when the resolver yields an empty list", async () => {
    const resolver = makeResolver(async () => []);
    const result = await preflightHostnameLookup("chatgpt.com", { resolver });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("empty_result");
      expect(result.errorCode).toBe("hostname_unresolvable");
    }
  });

  it("returns ok:false for an empty host without invoking the resolver", async () => {
    let called = false;
    const resolver = makeResolver(async () => {
      called = true;
      return [];
    });
    const result = await preflightHostnameLookup("", { resolver });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("lookup_failed");
      expect(result.errorCode).toBe("hostname_empty");
    }
  });
});
