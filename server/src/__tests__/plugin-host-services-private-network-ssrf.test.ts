import { describe, expect, it, vi } from "vitest";

const lookupMock = vi.fn();

vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const { validateAndResolveFetchUrl } = await import("../services/plugin-host-services.js");

describe("plugin http.fetch SSRF guard — private-network allowlist", () => {
  it("still rejects a private IP target when no host is approved (default-deny unchanged)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.1.204", family: 4 }]);

    await expect(validateAndResolveFetchUrl("http://ha.tieredint.com/api/states")).rejects.toThrow(
      /private\/reserved ranges/,
    );
  });

  it("still rejects a private IP target when the approved set is empty", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.1.204", family: 4 }]);

    await expect(
      validateAndResolveFetchUrl("http://ha.tieredint.com/api/states", new Set()),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("allows a private IP target when its exact hostname is approved", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.1.204", family: 4 }]);

    const target = await validateAndResolveFetchUrl(
      "http://ha.tieredint.com/api/states",
      new Set(["ha.tieredint.com"]),
    );
    expect(target.resolvedAddress).toBe("10.0.1.204");
  });

  it("does not approve a different hostname than the one in the allowlist (exact match only)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.1.204", family: 4 }]);

    await expect(
      validateAndResolveFetchUrl("http://other.tieredint.com/api/states", new Set(["ha.tieredint.com"])),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("does not approve a subdomain or suffix of an allowlisted host (no implicit wildcarding)", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.1.204", family: 4 }]);

    await expect(
      validateAndResolveFetchUrl("http://evil.ha.tieredint.com/api/states", new Set(["ha.tieredint.com"])),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("matches the approved host case-insensitively", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "10.0.1.204", family: 4 }]);

    const target = await validateAndResolveFetchUrl(
      "http://HA.TieredInt.com/api/states",
      new Set(["ha.tieredint.com"]),
    );
    expect(target.resolvedAddress).toBe("10.0.1.204");
  });

  it("leaves a public-IP target unaffected by the allowlist either way", async () => {
    lookupMock.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const target = await validateAndResolveFetchUrl("http://example.com/", new Set());
    expect(target.resolvedAddress).toBe("93.184.216.34");
  });
});
