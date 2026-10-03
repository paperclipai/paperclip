import { describe, expect, it } from "vitest";
import {
  buildRuntimeApiCandidateUrls,
  choosePrimaryRuntimeApiUrl,
  collectReachableInterfaceHosts,
  localRuntimeApiCallsEnabled,
  resolveLocalRuntimeApiUrl,
  runtimeCanReachLocalApi,
} from "../runtime-api.js";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";

const LOOPBACK_IPV4 = {
  address: "127.0.0.1",
  family: "IPv4",
  internal: true,
  netmask: "255.0.0.0",
  cidr: "127.0.0.1/8",
  mac: "00:00:00:00:00:00",
} as const;

const LOOPBACK_IPV6 = {
  address: "::1",
  family: "IPv6",
  internal: true,
  netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
  cidr: "::1/128",
  mac: "00:00:00:00:00:00",
  scopeid: 0,
} as const;

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

  it("leads the candidate list with the opt-in local API URL", () => {
    expect(
      buildRuntimeApiCandidateUrls({
        localApiUrl: "http://127.0.0.1:3100",
        preferredApiUrl: "https://paperclip.example.test",
        authPublicBaseUrl: "https://paperclip.example.test",
        allowedHostnames: ["paperclip.example.test"],
        bindHost: "0.0.0.0",
        port: 3100,
        networkInterfacesMap: {},
      }),
    ).toEqual([
      "http://127.0.0.1:3100",
      "https://paperclip.example.test",
      "https://paperclip.example.test:3100",
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

describe("local runtime API opt-in", () => {
  it("stays disabled by default so existing deployments keep the public origin", () => {
    expect(localRuntimeApiCallsEnabled({})).toBe(false);
    expect(
      resolveLocalRuntimeApiUrl({ bindHost: "0.0.0.0", port: 3100, env: {} }),
    ).toBeNull();
  });

  it("accepts the common truthy spellings and rejects everything else", () => {
    for (const value of ["true", "TRUE", " 1 ", "yes"]) {
      expect(
        localRuntimeApiCallsEnabled({ PAPERCLIP_ALLOW_LOCAL_API_CALLS: value }),
      ).toBe(true);
    }
    for (const value of ["false", "0", "no", "", "maybe"]) {
      expect(
        localRuntimeApiCallsEnabled({ PAPERCLIP_ALLOW_LOCAL_API_CALLS: value }),
      ).toBe(false);
    }
  });

  it("derives a loopback origin on the real listen port for a wildcard bind host", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("keeps IPv6 loopback for an ::1 bind host, the only address that listener answers on", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "::1",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
      }),
    ).toBe("http://[::1]:3100");
  });

  it("keeps IPv4 loopback for an :: bind host on a dual-stack host", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "::",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
        networkInterfacesMap: { lo: [LOOPBACK_IPV4, LOOPBACK_IPV6] },
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("falls back to IPv6 loopback for a wildcard bind on an IPv6-only host", () => {
    // That host has no 127.0.0.0/8 interface at all, so 127.0.0.1 would be an
    // address agents cannot connect to and the opt-in would simply not work.
    for (const bindHost of ["::", ""]) {
      expect(
        resolveLocalRuntimeApiUrl({
          bindHost,
          port: 3100,
          env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
          networkInterfacesMap: { lo: [LOOPBACK_IPV6] },
        }),
      ).toBe("http://[::1]:3100");
    }
  });

  it("keeps the name for a localhost bind rather than guessing which address it resolved to", () => {
    // `server.listen(port, "localhost")` resolves the name and binds the single
    // address that lookup returned — which can be ::1 on a dual-stack host that
    // also has IPv4 loopback. Picking an address here would be a guess at that
    // resolution; handing back the name lets the agent resolve it the same way.
    for (const interfaces of [
      { lo: [LOOPBACK_IPV4, LOOPBACK_IPV6] },
      { lo: [LOOPBACK_IPV6] },
      { lo: [LOOPBACK_IPV4] },
    ]) {
      expect(
        resolveLocalRuntimeApiUrl({
          bindHost: "localhost",
          port: 3100,
          env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
          networkInterfacesMap: interfaces,
        }),
      ).toBe("http://localhost:3100");
    }
  });

  it("keeps IPv4 loopback for an 0.0.0.0 bind host, which answers on IPv4 only", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
        networkInterfacesMap: { lo: [LOOPBACK_IPV6] },
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("derives no origin for a specific non-loopback bind host rather than downgrading to cleartext", () => {
    // Deriving http://198.51.100.10:3100 would hand agents an origin that carries
    // their bearer key off the host in cleartext, downgrading an HTTPS deployment.
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "198.51.100.10",
        port: 3100,
        env: { PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true" },
      }),
    ).toBeNull();
  });

  it("honors an explicit HTTPS override and normalizes it to an origin", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: {
          PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
          PAPERCLIP_LOCAL_API_URL: "https://198.51.100.10:3100/api/",
        },
      }),
    ).toBe("https://198.51.100.10:3100");
  });

  it("honors an explicit loopback HTTP override, which never leaves the host", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: {
          PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
          PAPERCLIP_LOCAL_API_URL: "http://127.0.0.1:4000",
        },
      }),
    ).toBe("http://127.0.0.1:4000");
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: {
          PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
          PAPERCLIP_LOCAL_API_URL: "http://[::1]:4000",
        },
      }),
    ).toBe("http://[::1]:4000");
  });

  it("rejects a cleartext non-loopback override unless the operator acknowledges it", () => {
    const env = {
      PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
      PAPERCLIP_LOCAL_API_URL: "http://198.51.100.10:3100",
    };
    expect(
      resolveLocalRuntimeApiUrl({ bindHost: "0.0.0.0", port: 3100, env }),
    ).toBe("http://127.0.0.1:3100");
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: { ...env, PAPERCLIP_LOCAL_API_ALLOW_INSECURE_HTTP: "true" },
      }),
    ).toBe("http://198.51.100.10:3100");
  });

  it("rejects an override whose scheme cannot serve API calls", () => {
    for (const value of ["file:///tmp/api", "ftp://198.51.100.10:3100"]) {
      expect(
        resolveLocalRuntimeApiUrl({
          bindHost: "0.0.0.0",
          port: 3100,
          env: {
            PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
            PAPERCLIP_LOCAL_API_URL: value,
          },
        }),
      ).toBe("http://127.0.0.1:3100");
    }
  });

  it("falls back to the derived origin when the override is malformed", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: {
          PAPERCLIP_ALLOW_LOCAL_API_CALLS: "true",
          PAPERCLIP_LOCAL_API_URL: "not a url",
        },
      }),
    ).toBe("http://127.0.0.1:3100");
  });

  it("ignores an override when the opt-in is off", () => {
    expect(
      resolveLocalRuntimeApiUrl({
        bindHost: "0.0.0.0",
        port: 3100,
        env: { PAPERCLIP_LOCAL_API_URL: "http://198.51.100.10:3100" },
      }),
    ).toBeNull();
  });
});

describe("local runtime API reachability", () => {
  it("treats an absent or local execution target on a local adapter as reachable", () => {
    expect(
      runtimeCanReachLocalApi({ adapterType: "claude_local" }),
    ).toBe(true);
    expect(
      runtimeCanReachLocalApi({
        adapterType: "codex_local",
        executionTargetKind: "local",
      }),
    ).toBe(true);
  });

  // Classification for every adapter Paperclip ships. `true` means the agent
  // process runs on the Paperclip host and may be handed the local origin.
  //
  // This is deliberately spelled out against BUILTIN_ADAPTER_TYPES rather than
  // against the implementation's own set: asserting a hand-written list matches
  // the list it was copied from only proves it agrees with itself. A new adapter
  // fails the completeness check below until someone classifies it here, which
  // is the point — an unclassified adapter must not quietly inherit a loopback
  // origin, and the credentials that ride on it, by default.
  const ADAPTER_REACHABILITY: Record<string, boolean> = {
    claude_local: true,
    codex_local: true,
    cursor: true,
    gemini_local: true,
    grok_local: true,
    hermes_local: true,
    kimi_local: true,
    opencode_local: true,
    paperclip_runner: true,
    pi_local: true,
    process: true,
    // Runs on hardware the operator does not control, or on another host
    // reached over HTTP. The server's local origin resolves there to the wrong
    // machine, losing every status update, comment, and runtime-tools call —
    // and pointing scoped credentials at whatever does answer on that port.
    acpx_local: false, // retired tombstone; never executes
    cursor_cloud: false,
    hermes_gateway: false,
    http: false, // invokes an operator-supplied remote `url`
    openclaw_gateway: false,
  };

  it("classifies every built-in adapter type", () => {
    expect(new Set(Object.keys(ADAPTER_REACHABILITY))).toEqual(BUILTIN_ADAPTER_TYPES);
  });

  it("only treats adapters that run on the Paperclip host as reachable", () => {
    for (const [adapterType, reachable] of Object.entries(ADAPTER_REACHABILITY)) {
      expect(runtimeCanReachLocalApi({ adapterType }), adapterType).toBe(reachable);
    }
  });

  it("rejects an unknown adapter type rather than assuming it is local", () => {
    expect(runtimeCanReachLocalApi({ adapterType: "some_future_cloud_adapter" })).toBe(false);
    expect(runtimeCanReachLocalApi({})).toBe(false);
  });

  it("rejects a remote execution target even for a local adapter", () => {
    expect(
      runtimeCanReachLocalApi({
        adapterType: "claude_local",
        executionTargetKind: "remote",
      }),
    ).toBe(false);
  });
});
