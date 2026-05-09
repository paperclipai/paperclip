import { describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
  isPrivateOrLoopbackHost,
} from "../runtime-api.js";

describe("runtime API discovery", () => {
  it("prefers the explicit public base URL for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "https://paperclip.example.com/base/path",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("https://paperclip.example.com");
  });

  it("builds ordered callback candidates from explicit, allowed, bind, and interface hosts", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: null,
        allowedHostnames: ["198.51.100.10", "runtime-host.example.test", "203.0.113.42"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {
          en0: [
            {
              address: "203.0.113.42",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "203.0.113.42/24",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
          ],
          lo0: [
            {
              address: "127.0.0.1",
              family: "IPv4",
              internal: true,
              netmask: "255.0.0.0",
              cidr: "127.0.0.1/8",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "http://198.51.100.10:3102",
      "http://runtime-host.example.test:3102",
      "http://203.0.113.42:3102",
    ]);
  });

  it("tries the preferred API URL before derived callback candidates", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        preferredApiUrl: "https://agent-entry.example.test/base/path",
        authPublicBaseUrl: "https://paperclip.example.test/app",
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "https://agent-entry.example.test",
      "https://paperclip.example.test",
      "https://198.51.100.10:3102",
    ]);
  });

  it("adds host.docker.internal when the explicit base URL is loopback", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "http://127.0.0.1:3102",
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3102",
      "http://host.docker.internal:3102",
    ]);
  });

  it("prefers serverPublicBaseUrl over allowedHostnames for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        serverPublicBaseUrl: "https://webhook.tiknas.com/api/v1",
        authPublicBaseUrl: null,
        allowedHostnames: ["198.51.100.10"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("https://webhook.tiknas.com");
  });

  it("returns https origin without port for an external allowed hostname", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["webhook.tiknas.com"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("https://webhook.tiknas.com");
  });

  it("returns http origin with port for a private RFC1918 allowed hostname", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["192.168.1.10"],
        bindHost: "0.0.0.0",
        port: 3100,
      }),
    ).toBe("http://192.168.1.10:3100");
  });

  it("returns http origin with port when only a loopback bindHost is configured", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: [],
        bindHost: "127.0.0.1",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("prefers usable interface hosts and skips link-local addresses", () => {
    expect(
      collectReachableInterfaceHosts({
        networkInterfacesMap: {
          en0: [
            {
              address: "fe80::1",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff:ffff::",
              cidr: "fe80::1/64",
              mac: "00:00:00:00:00:00",
              scopeid: 1,
            },
            {
              address: "192.168.6.178",
              family: "IPv4",
              internal: false,
              netmask: "255.255.252.0",
              cidr: "192.168.6.178/22",
              mac: "00:00:00:00:00:00",
            },
            {
              address: "fd7a:115c:a1e0::8a3a:a11d",
              family: "IPv6",
              internal: false,
              netmask: "ffff:ffff:ffff::",
              cidr: "fd7a:115c:a1e0::8a3a:a11d/48",
              mac: "00:00:00:00:00:00",
              scopeid: 0,
            },
          ],
          en1: [
            {
              address: "169.254.10.20",
              family: "IPv4",
              internal: false,
              netmask: "255.255.0.0",
              cidr: "169.254.10.20/16",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      "192.168.6.178",
      "fd7a:115c:a1e0::8a3a:a11d",
    ]);
  });
});

describe("isPrivateOrLoopbackHost", () => {
  it("returns true for RFC1918 and loopback addresses", () => {
    expect(isPrivateOrLoopbackHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("10.255.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("172.31.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.1.10")).toBe(true);
    expect(isPrivateOrLoopbackHost("192.168.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHost("::1")).toBe(true);
  });

  it("returns true for link-local addresses", () => {
    expect(isPrivateOrLoopbackHost("169.254.1.1")).toBe(true);
    expect(isPrivateOrLoopbackHost("169.254.255.255")).toBe(true);
    expect(isPrivateOrLoopbackHost("fe80::1")).toBe(true);
  });

  it("returns true for IPv6 unique local addresses (ULA, fc00::/7)", () => {
    expect(isPrivateOrLoopbackHost("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fd00::1")).toBe(true);
    expect(isPrivateOrLoopbackHost("fd7a:115c::1")).toBe(true);
    // Tailscale CGNAT IPv6 from TIK-1329 audit finding
    expect(isPrivateOrLoopbackHost("fd7a:115c:a1e0::8a3a:a11d")).toBe(true);
  });

  it("returns false for public internet addresses and external hostnames", () => {
    expect(isPrivateOrLoopbackHost("webhook.tiknas.com")).toBe(false);
    expect(isPrivateOrLoopbackHost("198.51.100.10")).toBe(false);
    expect(isPrivateOrLoopbackHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHost("203.0.113.42")).toBe(false);
    expect(isPrivateOrLoopbackHost("2001:db8::1")).toBe(false);
  });
});
