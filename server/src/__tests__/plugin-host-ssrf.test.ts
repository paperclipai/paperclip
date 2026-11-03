import { describe, expect, it } from "vitest";
import { isPrivateIP } from "../services/plugin-host-services.js";

describe("plugin fetch SSRF guard: isPrivateIP", () => {
  it.each([
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "0.0.0.0",
    // Shared address space / CGNAT (100.64.0.0/10), used by carrier-grade NAT and overlay networks.
    "100.64.0.1",
    "100.100.100.100",
    "100.103.149.19",
    "100.127.255.255",
    "::ffff:100.64.1.2",
    // The hex form the URL parser produces for [::ffff:a.b.c.d] literals.
    "::ffff:6440:1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "::ffff:a00:1",
    "0:0:0:0:0:ffff:c0a8:101",
    "::1",
    "::",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    // NAT64 well-known prefix: DNS64 maps any IPv4 address into it.
    "64:ff9b::7f00:1",
    "64:ff9b::a00:1",
    "64:ff9b::127.0.0.1",
    "64:ff9b:0:0:0:0:a9fe:a9fe",
    "0064:ff9b:0000:0000:0000:0000:0a00:0001",
  ])("refuses %s", (ip) => {
    expect(isPrivateIP(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.1",
    "157.240.1.35",
    "2a03:2880:f12f:83:face:b00c:0:25de",
    // 64:ff9b:1::/48 is the local-use NAT64 prefix, outside the well-known /96.
    "64:ff9b:1::a00:1",
    "2001:db8::1",
    "::ffff:808:808",
  ])("allows %s", (ip) => {
    expect(isPrivateIP(ip)).toBe(false);
  });
});
