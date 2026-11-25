import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return {
    ...actual,
    lookup: vi.fn((host: string, opts: unknown) => {
      if (host === "mixed-dns-public-first.test") {
        return Promise.resolve([{ address: "203.0.113.7", family: 4 }, { address: "192.168.1.5", family: 4 }]);
      }
      if (host === "mixed-dns-private-first.test") {
        return Promise.resolve([{ address: "192.168.1.5", family: 4 }, { address: "203.0.113.7", family: 4 }]);
      }
      return actual.lookup(host, opts as never);
    }),
  };
});

vi.mock("../middleware/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

import { logger } from "../middleware/logger.js";
import { buildHostServices, validateAndResolveFetchUrl } from "../services/plugin-host-services.js";

type Manifest = { capabilities: string[] };

function servicesFor(manifest?: Manifest) {
  const eventBusStub = {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn() };
    },
  } as never;
  return buildHostServices({} as never, "plugin-record-id", "paperclip.local-privileged-bridge", eventBusStub, undefined, {
    manifest: manifest as never,
  });
}

async function listenOnLoopback(handler: (body: string) => Promise<string>): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      void handler(body).then((response) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(response);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("plugin http.fetch private-network guard (SMI-233)", () => {
  it("rejects a loopback URL when the plugin has no manifest at all (fail-closed)", async () => {
    const services = servicesFor(undefined);
    await expect(services.http.fetch({ url: "http://127.0.0.1:9/health" })).rejects.toThrow(
      /private\/reserved ranges/,
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ pluginKey: "paperclip.local-privileged-bridge" }),
      expect.stringContaining("http.private-network"),
    );
  });

  it("rejects an RFC1918 URL when the manifest lacks http.private-network", async () => {
    const services = servicesFor({ capabilities: ["http.outbound"] });
    await expect(services.http.fetch({ url: "http://172.17.0.1:3721/" })).rejects.toThrow(
      /All resolved IPs for 172\.17\.0\.1 are in private\/reserved ranges/,
    );
  });

  it("cannot be unlocked from request data — a smuggled allowPrivateNetwork flag does nothing", async () => {
    const services = servicesFor({ capabilities: ["http.outbound"] });
    await expect(
      services.http.fetch({
        url: "http://172.17.0.1:3721/",
        init: { allowPrivateNetwork: true } as unknown as Record<string, unknown>,
      }),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("keeps denying link-local and cloud-metadata addresses even with the capability", async () => {
    const services = servicesFor({ capabilities: ["http.outbound", "http.private-network"] });
    await expect(
      services.http.fetch({ url: "http://169.254.169.254/latest/meta-data/" }),
    ).rejects.toThrow(/private\/reserved ranges/);
  });

  it("reports landsOnPrivateAddress from the connected address, not from every DNS answer", async () => {
    const publicFirst = await validateAndResolveFetchUrl("http://mixed-dns-public-first.test/", {
      allowPrivateNetwork: true,
    });
    expect(publicFirst.resolvedAddress).toBe("203.0.113.7");
    expect(publicFirst.landsOnPrivateAddress).toBe(false);

    const privateFirst = await validateAndResolveFetchUrl("http://mixed-dns-private-first.test/", {
      allowPrivateNetwork: true,
    });
    expect(privateFirst.resolvedAddress).toBe("192.168.1.5");
    expect(privateFirst.landsOnPrivateAddress).toBe(true);
  });

  it("still enforces the protocol whitelist even with the capability granted", async () => {
    const services = servicesFor({ capabilities: ["http.outbound", "http.private-network"] });
    await expect(services.http.fetch({ url: "ftp://127.0.0.1:21/" })).rejects.toThrow(
      /Disallowed protocol/,
    );
  });

  it("without the capability, zero requests reach a real loopback server and the call rejects", async () => {
    let hits = 0;
    const { server, port } = await listenOnLoopback(async () => {
      hits += 1;
      return "{}";
    });
    try {
      const services = servicesFor({ capabilities: ["http.outbound"] });
      await expect(
        services.http.fetch({ url: `http://127.0.0.1:${port}/bridge`, init: { method: "POST", body: "x=1" } }),
      ).rejects.toThrow(/private\/reserved ranges/);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });

  it("with the capability, the POST is delivered to a real loopback server and the response round-trips", async () => {
    let receivedBody = "";
    const { server, port } = await listenOnLoopback(async (body) => {
      receivedBody = body;
      return JSON.stringify({ ok: true, echo: body });
    });
    try {
      const services = servicesFor({ capabilities: ["http.outbound", "http.private-network"] });
      const response = await services.http.fetch({
        url: `http://127.0.0.1:${port}/deliver`,
        init: { method: "POST", body: JSON.stringify({ action: "restart", approved: true }) },
      });
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body);
      expect(payload).toEqual({ ok: true, echo: JSON.stringify({ action: "restart", approved: true }) });
      expect(receivedBody).toBe(JSON.stringify({ action: "restart", approved: true }));
    } finally {
      server.close();
    }
  });

  it("audit-logs the private-network fetch when the allowance is actually used", async () => {
    const { server, port } = await listenOnLoopback(async () => "{}");
    try {
      const services = servicesFor({ capabilities: ["http.outbound", "http.private-network"] });
      await services.http.fetch({ url: `http://127.0.0.1:${port}/log` });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ pluginId: "plugin-record-id", pluginKey: "paperclip.local-privileged-bridge" }),
        "plugin http.fetch allowed to private/reserved address via http.private-network capability",
      );
    } finally {
      server.close();
    }
  });

  it("strips secret-bearing query and userinfo parts from the audit log URL", async () => {
    const { server, port } = await listenOnLoopback(async () => "{}");
    try {
      const services = servicesFor({ capabilities: ["http.outbound", "http.private-network"] });
      await services.http.fetch({ url: `http://127.0.0.1:${port}/deliver?token=supersecret&action=restart` });
      const call = vi.mocked(logger.info).mock.calls.find(([, message]) =>
        String(message).includes("allowed to private/reserved address"),
      );
      expect(call).toBeDefined();
      const loggedUrl = (call?.[0] as { url?: string }).url;
      expect(loggedUrl).toBeDefined();
      expect(loggedUrl).not.toContain("supersecret");
      expect(loggedUrl).toBe(`http://127.0.0.1:${port}/deliver`);
    } finally {
      server.close();
    }
  });
});
