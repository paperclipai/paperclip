import { describe, expect, it } from "vitest";

import { parseTailscaleDnsName } from "./tailscale-hostname.js";

describe("parseTailscaleDnsName", () => {
  it("normalizes the local node MagicDNS hostname", () => {
    expect(parseTailscaleDnsName({ Self: { DNSName: "Branch-Runner.tail123.ts.net." } }))
      .toBe("branch-runner.tail123.ts.net");
  });

  it("rejects missing, single-label, and injected hostnames", () => {
    expect(() => parseTailscaleDnsName({})).toThrow(/Self\.DNSName/);
    expect(() => parseTailscaleDnsName({ Self: { DNSName: "localhost" } })).toThrow(/invalid/);
    expect(() => parseTailscaleDnsName({ Self: { DNSName: "host/evil.ts.net" } })).toThrow(/invalid/);
  });
});
