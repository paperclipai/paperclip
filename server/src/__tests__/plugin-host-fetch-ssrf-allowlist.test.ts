import { describe, expect, it } from "vitest";
import { validateAndResolveFetchUrl } from "../services/plugin-host-services.js";

// These cases use loopback/literal IPs, which Node's dns.lookup resolves
// without any network round-trip, so the guard is exercised deterministically.
describe("plugin fetch SSRF guard — private-host allowlist", () => {
  const HONCHO = "127.0.0.1:18820";

  it("blocks a loopback target by default (no allowlist)", async () => {
    await expect(
      validateAndResolveFetchUrl("http://127.0.0.1:18820/v3/workspaces"),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("allows an exact allowlisted host:port and pins the resolved IP", async () => {
    const target = await validateAndResolveFetchUrl(
      "http://127.0.0.1:18820/v3/workspaces",
      new Set([HONCHO]),
    );
    expect(target.resolvedAddress).toBe("127.0.0.1");
    expect(target.hostHeader).toBe(HONCHO);
    expect(target.useTls).toBe(false);
  });

  it("matches host:port exactly — a different port stays blocked", async () => {
    await expect(
      validateAndResolveFetchUrl(
        "http://127.0.0.1:9999/x",
        new Set([HONCHO]),
      ),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("is case-insensitive on the host header", async () => {
    const target = await validateAndResolveFetchUrl(
      "http://127.0.0.1:18820/x",
      new Set(["127.0.0.1:18820"]),
    );
    expect(target.resolvedAddress).toBe("127.0.0.1");
  });

  it("still enforces the protocol whitelist regardless of allowlist", async () => {
    await expect(
      validateAndResolveFetchUrl("ftp://127.0.0.1:18820/x", new Set([HONCHO])),
    ).rejects.toThrow(/Disallowed protocol/);
  });
});
