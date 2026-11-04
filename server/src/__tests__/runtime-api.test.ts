import { describe, expect, it } from "vitest";
import { once } from "node:events";
import {
  buildRuntimeApiCandidateUrls,
  chooseLocalRuntimeApiUrl,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
  resolveLocalRuntimeApiUrl,
} from "../runtime-api.js";
import { createPaperclipHttpServer } from "../http/server.js";
import { registerRunnerPrpAuthority, runnerPrpWebSocketInternals } from "../realtime/runner-prp-ws.js";
import type { DurablePrpControlPlane } from "../vendor/paperclip-runner/index.js";

describe("runtime API discovery", () => {
  it.each([
    ["127.0.0.1", "http://127.0.0.1:3218"],
    ["0.0.0.0", "http://127.0.0.1:3218"],
    ["::", "http://[::1]:3218"],
    ["::1", "http://[::1]:3218"],
    ["2001:db8::123", "http://[2001:db8::123]:3218"],
    ["[::1]", "http://[::1]:3218"],
    ["192.0.2.12", "http://192.0.2.12:3218"],
  ])("uses listener host %s and its selected port for local runtime transport", (bindHost, expected) => {
    expect(chooseLocalRuntimeApiUrl({ bindHost, port: 3218 })).toBe(expected);
  });

  it("registers private runner WebSocket transport alongside a public HTTPS callback origin", async () => {
    const input = {
      authPublicBaseUrl: "https://callbacks.example.test",
      allowedHostnames: ["callbacks.example.test"],
      bindHost: "127.0.0.1",
      port: 3218,
    };
    expect(choosePrimaryRuntimeApiUrl(input)).toBe("https://callbacks.example.test");
    const server = createPaperclipHttpServer((_req, response) => response.end("ready"), {
      apiUrl: chooseLocalRuntimeApiUrl(input),
    });
    const runId = "00000000-0000-4000-8000-000000000887";
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const registration = await registerRunnerPrpAuthority({
        companyId: "company-1", runId,
        authority: {} as DurablePrpControlPlane,
      });
      try {
        expect(registration.connectUrl).toBe(`${resolveLocalRuntimeApiUrl().replace("http:", "ws:")}/api/runner/v1/connect/${runId}`);
      } finally {
        await registration.release();
      }
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      runnerPrpWebSocketInternals.resetForTests();
    }
  });

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

  it("prefers the loopback bind host over allowed hostnames for the primary runtime URL", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: null,
        allowedHostnames: ["192.168.1.50"],
        bindHost: "127.0.0.1",
        port: 3100,
      }),
    ).toBe("http://127.0.0.1:3100");
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

  it("ignores a public base URL that has no scheme instead of returning the string \"null\"", () => {
    expect(
      choosePrimaryRuntimeApiUrl({
        authPublicBaseUrl: "runtime-host.example.test:3100",
        allowedHostnames: ["runtime-host.example.test"],
        bindHost: "0.0.0.0",
        port: 3102,
      }),
    ).toBe("http://runtime-host.example.test:3102");
  });

  it("builds candidates without throwing when the public base URL has no scheme", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        authPublicBaseUrl: "runtime-host.example.test:3100",
        allowedHostnames: ["runtime-host.example.test"],
        bindHost: "0.0.0.0",
        port: 3102,
        networkInterfacesMap: {},
      }),
    ).toEqual(["http://runtime-host.example.test:3102"]);
  });
});
