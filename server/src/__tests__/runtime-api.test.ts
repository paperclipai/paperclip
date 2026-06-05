import { describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
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

  it("pins the primary runtime URL to the loopback bind even when an allowed hostname exists (PRO-33)", () => {
    // Regression: a local_trusted server binds 127.0.0.1 only; the tailnet name is
    // merely a Host-header allowlist entry and is unreachable, so it must not become
    // the primary PAPERCLIP_API_URL (which previously caused connection-refused loops).
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["wwwsolowaytechcom.tail9c73fe.ts.net"],
        bindHost: "127.0.0.1",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("still prefers an allowed hostname when bound to a non-loopback interface", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["runtime-host.example.test"],
        bindHost: "100.65.116.95",
        port: 3100,
      }),
    ).toBe("http://runtime-host.example.test:3100");
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
