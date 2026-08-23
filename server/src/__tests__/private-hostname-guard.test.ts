import { describe, expect, it, vi } from "vitest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

const unknownHostname = "blocked-host.invalid";

function runGuard(
  opts: {
    enabled: boolean;
    allowedHostnames?: string[];
    bindHost?: string;
    networkInterfacesMap?: NodeJS.Dict<NodeJS.NetworkInterfaceInfo[]>;
  },
  input: {
    host?: string;
    path?: string;
    accepts?: string;
  } = {},
) {
  const middleware = privateHostnameGuard({
    enabled: opts.enabled,
    allowedHostnames: opts.allowedHostnames ?? [],
    bindHost: opts.bindHost ?? "0.0.0.0",
    networkInterfacesMap: opts.networkInterfacesMap ?? {},
  });
  const req = {
    path: input.path ?? "/api/health",
    header: (name: string) => (name.toLowerCase() === "host" ? input.host : undefined),
    accepts: () => input.accepts ?? "json",
  } as any;
  const res = {
    status: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    send: vi.fn(),
    json: vi.fn(),
  } as any;
  const next = vi.fn();
  middleware(req, res, next);
  return { res, next };
}

function allowInternalInterfaceMap(): NodeJS.Dict<NodeJS.NetworkInterfaceInfo[]> {
  return {
    eth0: [
      {
        address: "10.42.0.42",
        family: "IPv4",
        internal: false,
        netmask: "255.255.255.0",
        cidr: "10.42.0.42/24",
        mac: "00:00:00:00:00:00",
      },
    ],
  };
}

function createAppOpts(opts: {
  enabled: boolean;
  allowedHostnames?: string[];
  bindHost?: string;
  networkInterfacesMap?: NodeJS.Dict<NodeJS.NetworkInterfaceInfo[]>;
}) {
  return {
    enabled: opts.enabled,
    allowedHostnames: opts.allowedHostnames ?? [],
    bindHost: opts.bindHost ?? "0.0.0.0",
    networkInterfacesMap: opts.networkInterfacesMap ?? {},
  };
}

describe("privateHostnameGuard", () => {
  it("allows requests when disabled", async () => {
    const { next } = runGuard(createAppOpts({ enabled: false }), { host: "dotta-macbook-pro:3100" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows loopback hostnames", async () => {
    const { next } = runGuard(createAppOpts({ enabled: true }), { host: "localhost:3100" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows explicitly configured hostnames", async () => {
    const { next } = runGuard(
      createAppOpts({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] }),
      { host: "dotta-macbook-pro:3100" },
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows discovered internal interface hosts without a manual Host override", async () => {
    const { next } = runGuard(createAppOpts({
      enabled: true,
      networkInterfacesMap: allowInternalInterfaceMap(),
    }), { host: "10.42.0.42:8000" });
    expect(next).toHaveBeenCalledOnce();
  });

  it("blocks unknown hostnames with a static remediation command", async () => {
    const { next, res } = runGuard(
      createAppOpts({ enabled: true, allowedHostnames: ["some-other-host"] }),
      { host: `${unknownHostname}:3100` },
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    // The remediation command carries a static `<host>` placeholder. It never
    // interpolates the request Host header into the command.
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("run npx paperclipai allowed-hostname <host>"),
      }),
    );
    expect(JSON.stringify(res.json.mock.calls)).not.toContain(unknownHostname);
  });

  it("blocks unknown hostnames on page routes with a static plain-text remediation command", async () => {
    const { next, res } = runGuard(
      createAppOpts({
        enabled: true,
        allowedHostnames: ["some-other-host"],
        bindHost: "0.0.0.0",
      }),
      {
        host: `${unknownHostname}:3100`,
        path: "/dashboard",
        accepts: "html",
      },
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("run npx paperclipai allowed-hostname <host>"),
    );
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining(unknownHostname));
  }, 20_000);

  it("does not reflect a hostile Host header into the remediation command", async () => {
    // An unauthenticated requester can send an invalid Host header that holds
    // shell metacharacters. `extractHostname` falls back to the raw header when
    // URL parsing fails. The 403 guidance must not echo that value, so an
    // operator or an agent cannot paste an attacker-controlled span into a
    // shell. Use a harmless, nonexistent command name inside the span.
    const hostileHost = "evil$(echo marker)host";
    const { res } = runGuard(
      createAppOpts({ enabled: true, allowedHostnames: ["some-other-host"] }),
      { host: hostileHost },
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("run npx paperclipai allowed-hostname <host>"),
      }),
    );
    const payload = JSON.stringify(res.json.mock.calls);
    expect(payload).not.toContain("evil");
    expect(payload).not.toContain("$(");
    expect(payload).not.toContain("marker");
  });
});
