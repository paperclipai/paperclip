import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
  createRuntimeApiProbe,
  getRuntimeApiInstanceToken,
  rankRuntimeApiCandidatesByBindAddress,
  resolveRuntimeApiUrl,
  RUNTIME_API_INSTANCE_HEADER,
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
});

describe("runtime API reachability resolution", () => {
  // Mirrors a tailnet-bound host whose short machine name also exists in the
  // cloud provider's internal DNS: both names are allow-listed, but only the
  // tailnet name resolves to the address the server actually bound.
  const BIND_HOST = "100.108.64.76";
  const PORT = 3100;

  const lookupHost = async (hostname: string): Promise<string[]> => {
    if (hostname === "good-name") return ["100.108.64.76"];
    if (hostname === "unreachable-name") return ["10.0.0.4"];
    return [];
  };

  const probeOnlyGoodName = async (origin: string): Promise<boolean> =>
    origin === "http://good-name:3100";

  it("picks the allowed hostname that resolves to the bind address and answers a probe", async () => {
    const resolved = await resolveRuntimeApiUrl({
      allowedHostnames: ["unreachable-name", "good-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeOrigin: probeOnlyGoodName,
    });

    expect(resolved.url).toBe("http://good-name:3100");
    expect(resolved.reason).toBe("probe");
    // The known-wrong name must never be probed before the working one.
    expect(resolved.probed.map((entry) => entry.url)).not.toContain("http://unreachable-name:3100");
  });

  it("is not order-dependent: swapping the allowed hostnames yields the same URL", async () => {
    const forward = await resolveRuntimeApiUrl({
      allowedHostnames: ["unreachable-name", "good-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeOrigin: probeOnlyGoodName,
    });
    const reversed = await resolveRuntimeApiUrl({
      allowedHostnames: ["good-name", "unreachable-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeOrigin: probeOnlyGoodName,
    });

    expect(reversed.url).toBe(forward.url);
    expect(reversed.url).toBe("http://good-name:3100");
  });

  it("puts the reachable origin first in the candidate list it returns", async () => {
    const resolved = await resolveRuntimeApiUrl({
      allowedHostnames: ["unreachable-name", "good-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeOrigin: probeOnlyGoodName,
    });

    expect(resolved.candidates[0]).toBe("http://good-name:3100");
    expect(resolved.candidates).toContain("http://unreachable-name:3100");
  });

  it("keeps the resolve-ranked order when no candidate answers", async () => {
    const resolved = await resolveRuntimeApiUrl({
      allowedHostnames: ["unreachable-name", "good-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeOrigin: async () => false,
    });

    expect(resolved.reason).toBe("unreachable-fallback");
    expect(resolved.url).toBe("http://good-name:3100");
    expect(resolved.probed.every((entry) => entry.reachable === false)).toBe(true);
  });

  it("stops probing once the budget is spent instead of stalling startup", async () => {
    let clock = 0;
    const resolved = await resolveRuntimeApiUrl({
      allowedHostnames: ["unreachable-name", "good-name", "no-such-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeBudgetMs: 1_000,
      now: () => clock,
      probeOrigin: async () => {
        clock += 1_500;
        return false;
      },
    });

    // The top-ranked candidate is always probed; the rest are dropped once the
    // budget is gone, so a fully dead list costs one timeout instead of N.
    expect(resolved.probed).toHaveLength(1);
    expect(resolved.probed[0]?.url).toBe("http://good-name:3100");
    expect(resolved.skipped).toEqual([
      // The bind address itself is also a candidate, and ranks alongside the
      // allowed hostname that resolves to it.
      "http://100.108.64.76:3100",
      "http://no-such-name:3100",
      "http://unreachable-name:3100",
    ]);
    expect(resolved.reason).toBe("unreachable-fallback");
    expect(resolved.url).toBe("http://good-name:3100");
  });

  it("honors an explicit public base URL without probing", async () => {
    const probeOrigin = async (): Promise<boolean> => {
      throw new Error("probe must not run when a public base URL is configured");
    };

    const resolved = await resolveRuntimeApiUrl({
      authPublicBaseUrl: "https://paperclip.example.com/base/path",
      allowedHostnames: ["unreachable-name", "good-name"],
      bindHost: BIND_HOST,
      port: PORT,
      networkInterfacesMap: {},
      lookupHost,
      probeOrigin,
    });

    expect(resolved.url).toBe("https://paperclip.example.com");
    expect(resolved.reason).toBe("explicit-public-base-url");
    expect(resolved.probed).toEqual([]);
  });

  it("leaves candidate order alone for a wildcard bind, where DNS carries no signal", async () => {
    const ranked = await rankRuntimeApiCandidatesByBindAddress({
      candidates: ["http://unreachable-name:3100", "http://good-name:3100"],
      bindHost: "0.0.0.0",
      lookupHost,
    });

    expect(ranked.map((entry) => entry.url)).toEqual([
      "http://unreachable-name:3100",
      "http://good-name:3100",
    ]);
  });

  it("does not stall ranking when a resolver never answers", async () => {
    // `dns.lookup` has no timeout of its own, and the probe budget only covers
    // probing. A wedged resolver must degrade to "unknown", not hang startup.
    const ranked = await rankRuntimeApiCandidatesByBindAddress({
      candidates: ["http://wedged-resolver-name:3100", `http://${BIND_HOST}:3100`],
      bindHost: BIND_HOST,
      lookupHost: () => new Promise<string[]>(() => {}),
      lookupTimeoutMs: 10,
    });

    expect(ranked.map((entry) => entry.url)).toEqual([
      `http://${BIND_HOST}:3100`,
      "http://wedged-resolver-name:3100",
    ]);
    expect(ranked[1]?.addresses).toEqual([]);
  });

  it("ranks a name that does not resolve above one that resolves off the bind address", async () => {
    const ranked = await rankRuntimeApiCandidatesByBindAddress({
      candidates: ["http://unreachable-name:3100", "http://no-such-name:3100"],
      bindHost: BIND_HOST,
      lookupHost,
    });

    expect(ranked.map((entry) => entry.url)).toEqual([
      "http://no-such-name:3100",
      "http://unreachable-name:3100",
    ]);
  });
});

describe("runtime API probe identity", () => {
  // An allow-listed hostname can resolve to a machine running something else
  // entirely. "A listener answered" is therefore not enough to promote an origin
  // to PAPERCLIP_API_URL: agents send bearer tokens there, so the probe has to
  // establish that the responder is this process.
  const servers: http.Server[] = [];

  const startListener = async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> => {
    const server = http.createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it("accepts an origin that answers with this process's instance token", async () => {
    const origin = await startListener((_req, res) => {
      res.setHeader(RUNTIME_API_INSTANCE_HEADER, getRuntimeApiInstanceToken());
      res.writeHead(200).end("{}");
    });

    const probe = createRuntimeApiProbe(600, getRuntimeApiInstanceToken());
    expect(await probe(origin)).toBe(true);
  });

  it("accepts our own listener even when it rejects the probe unauthenticated", async () => {
    // The header is set ahead of any authorization decision, so tightening auth
    // on /api/health must not make this server look unreachable to itself.
    const origin = await startListener((_req, res) => {
      res.setHeader(RUNTIME_API_INSTANCE_HEADER, getRuntimeApiInstanceToken());
      res.writeHead(401).end("unauthorized");
    });

    const probe = createRuntimeApiProbe(600, getRuntimeApiInstanceToken());
    expect(await probe(origin)).toBe(true);
  });

  it("rejects an unrelated HTTP service that answers on a candidate origin", async () => {
    const origin = await startListener((_req, res) => {
      res.writeHead(200).end("hello from something else");
    });

    const probe = createRuntimeApiProbe(600, getRuntimeApiInstanceToken());
    expect(await probe(origin)).toBe(false);
  });

  it("rejects another Paperclip process listening on a candidate origin", async () => {
    const origin = await startListener((_req, res) => {
      res.setHeader(RUNTIME_API_INSTANCE_HEADER, "a-different-paperclip-process");
      res.writeHead(200).end("{}");
    });

    const probe = createRuntimeApiProbe(600, getRuntimeApiInstanceToken());
    expect(await probe(origin)).toBe(false);
  });

  it("falls back to the ranked pick when only a foreign listener answers", async () => {
    // End to end: a stranger on the wrong name must not be promoted just because
    // it replies. Ranking still decides, and the reason records that nothing of
    // ours answered.
    const foreign = await startListener((_req, res) => {
      res.writeHead(200).end("hello from something else");
    });

    const resolved = await resolveRuntimeApiUrl({
      allowedHostnames: ["unreachable-name", "good-name"],
      bindHost: "100.108.64.76",
      port: 3100,
      networkInterfacesMap: {},
      lookupHost: async (hostname) => {
        if (hostname === "good-name") return ["100.108.64.76"];
        if (hostname === "unreachable-name") return ["10.0.0.4"];
        return [];
      },
      probeOrigin: createRuntimeApiProbe(600, getRuntimeApiInstanceToken()),
      probeTimeoutMs: 600,
    });

    expect(foreign).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(resolved.reason).toBe("unreachable-fallback");
    expect(resolved.url).toBe("http://good-name:3100");
  });
});
