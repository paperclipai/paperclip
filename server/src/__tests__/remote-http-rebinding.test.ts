import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as netCreateServer, type AddressInfo, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

import { guardedRemoteHttpFetch, type RemoteHttpSocketFactory } from "../services/remote-http-fetch.js";

/**
 * PAP-17098 — DNS-rebinding regression coverage for outbound MCP/OAuth calls.
 *
 * The vulnerability was a TOCTOU: the guard resolved a hostname, approved it,
 * and then handed the *hostname* to global `fetch`, which resolved it a second
 * time. A name server the attacker controls can answer with a public address for
 * the first lookup and a loopback/private/link-local address for the second,
 * pointing the connection at an internal service or the cloud metadata endpoint.
 *
 * These tests model that name server deterministically: `lookup` returns a public
 * address on its first call and `127.0.0.1` on every call after it. Nothing here
 * touches real DNS or the real network — `socketFactory` stands in for the
 * network so a "public" address is a loopback listener that reports itself as
 * public, exactly as it would look to the kernel.
 */

const PUBLIC_ADDRESS = "93.184.216.34";
const REBIND_HOST = "mcp.rebind.test";

type TestServer = {
  server: Server;
  port: number;
  requests: Array<{ url: string; host: string | undefined }>;
  connections: number;
};

const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(handler?: (req: IncomingMessage, res: ServerResponse) => void): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const state = { connections: 0 };
  const server = createServer((req, res) => {
    requests.push({ url: req.url ?? "", host: req.headers.host });
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.on("connection", () => {
    state.connections += 1;
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    requests,
    get connections() {
      return state.connections;
    },
  };
}

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

/**
 * A stand-in for the network: routes whatever address the transport dialled to a
 * loopback listener, and reports `remoteAddress` as the dialled address so the
 * peer check sees what the kernel would have seen.
 */
function routingSocketFactory(routes: Record<string, number>): {
  factory: RemoteHttpSocketFactory;
  dialled: string[];
  sockets: Socket[];
} {
  const dialled: string[] = [];
  const sockets: Socket[] = [];
  const factory: RemoteHttpSocketFactory = (target) => {
    dialled.push(target.address);
    const port = routes[target.address];
    if (port === undefined) throw new Error(`test network has no route to ${target.address}`);
    const socket = netConnect({ host: "127.0.0.1", port });
    openSockets.push(socket);
    sockets.push(socket);
    Object.defineProperty(socket, "remoteAddress", { get: () => target.address, configurable: true });
    return socket;
  };
  return { factory, dialled, sockets };
}

/** Waits for the socket bookkeeping the transport does after it rejects. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** A name server that answers public first and loopback afterwards. */
function rebindingLookup(): { lookup: () => Promise<Array<{ address: string; family: number }>>; calls: () => number } {
  let calls = 0;
  return {
    lookup: async () => {
      calls += 1;
      return calls === 1
        ? [{ address: PUBLIC_ADDRESS, family: 4 }]
        : [{ address: "127.0.0.1", family: 4 }];
    },
    calls: () => calls,
  };
}

describe("guarded remote HTTP fetch (PAP-17098 DNS rebinding)", () => {
  it("turns a platform-fetch DNS cause into the stable DNS code", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND missing.invalid"), {
      code: "ENOTFOUND",
    });
    const unpinnedFetch = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    }) as typeof fetch;

    await expect(guardedRemoteHttpFetch("https://8.8.8.8/mcp", {}, {
      allowPrivateNetwork: true,
      unpinnedFetch,
      error: guardError,
    })).rejects.toMatchObject({
      code: "remote_http_dns_failed",
      message: "Remote MCP connection hostname could not be resolved",
    });
  });

  it("pins the connection to the approved address so a rebind never reaches loopback", async () => {
    const upstream = await startServer();
    const internal = await startServer();
    const dns = rebindingLookup();
    const network = routingSocketFactory({
      [PUBLIC_ADDRESS]: upstream.port,
      "127.0.0.1": internal.port,
    });

    const response = await guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: dns.lookup,
      socketFactory: network.factory,
      error: guardError,
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    // One resolution, and the connection went to the address that resolution
    // approved. The rebind answer is never consulted, so it cannot win a race.
    expect(dns.calls()).toBe(1);
    expect(network.dialled).toEqual([PUBLIC_ADDRESS]);
    expect(upstream.requests).toHaveLength(1);
    expect(internal.connections).toBe(0);
    expect(internal.requests).toHaveLength(0);
  });

  it("keeps the original Host header even though it dialled an IP address", async () => {
    const upstream = await startServer();
    const dns = rebindingLookup();
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: upstream.port });

    await guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, { method: "POST", body: "{}" }, {
      allowPrivateNetwork: false,
      lookup: dns.lookup,
      socketFactory: network.factory,
      error: guardError,
    });

    expect(upstream.requests[0]?.host).toBe(REBIND_HOST);
    expect(upstream.requests[0]?.url).toBe("/mcp");
  });

  it("sends the hostname as TLS SNI rather than the pinned address", async () => {
    // The handshake is never completed: capturing the ClientHello is enough to
    // prove SNI carries the configured hostname, and needs no test certificate.
    const clientHello = new Promise<Buffer>((resolve) => {
      const server = createServer();
      openServers.push(server);
      server.on("connection", (socket) => {
        socket.once("data", (chunk: Buffer) => {
          resolve(chunk);
          socket.destroy();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        const network = routingSocketFactory({ [PUBLIC_ADDRESS]: port });
        void guardedRemoteHttpFetch(`https://${REBIND_HOST}/mcp`, {}, {
          allowPrivateNetwork: false,
          lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
          socketFactory: network.factory,
          error: guardError,
        }).catch(() => {});
      });
    });

    const hello = await clientHello;
    expect(hello.includes(REBIND_HOST)).toBe(true);
    expect(hello.includes(PUBLIC_ADDRESS)).toBe(false);
  });

  it("rejects a peer that turns out to be loopback without writing a request", async () => {
    const internal = await startServer();
    // A rebind below DNS: resolution approved a public address, but the socket
    // lands on loopback anyway. The peer check has to catch it, and has to catch
    // it before any request byte is written.
    const factory: RemoteHttpSocketFactory = () => {
      const socket = netConnect({ host: "127.0.0.1", port: internal.port });
      openSockets.push(socket);
      return socket;
    };

    await expect(guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      socketFactory: factory,
      error: guardError,
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });

    expect(internal.requests).toHaveLength(0);
  });

  it("rejects a hostname whose only resolution is link-local metadata", async () => {
    const internal = await startServer();
    const network = routingSocketFactory({ "169.254.169.254": internal.port });

    await expect(guardedRemoteHttpFetch("http://metadata.rebind.test/latest/meta-data/", {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: "169.254.169.254", family: 4 }],
      socketFactory: network.factory,
      error: guardError,
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });

    expect(network.dialled).toEqual([]);
    expect(internal.requests).toHaveLength(0);
  });

  it("rejects a hostname that resolves to a mix of public and private addresses", async () => {
    await expect(guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "10.1.2.3", family: 4 },
      ],
      socketFactory: () => {
        throw new Error("must not dial");
      },
      error: guardError,
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("does not follow redirects, so the caller re-runs the guard on the next hop", async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/internal" });
      res.end();
    });
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: upstream.port });

    const response = await guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      socketFactory: network.factory,
      error: guardError,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://127.0.0.1:9/internal");
  });

  it("carries an MCP Streamable HTTP exchange, SSE framing included", async () => {
    // The pinned transport replaces `fetch` on the tools/call path, so an MCP
    // JSON-RPC reply delivered as a single SSE event has to survive it intact.
    const upstream = await startServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { method: string };
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: "1", result: { echo: request.method } })}\n\n`);
      });
    });
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: upstream.port });

    const response = await guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: {} }),
    }, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      socketFactory: network.factory,
      error: guardError,
    });

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    await expect(response.text()).resolves.toContain('"echo":"tools/call"');
  });

  it("decodes a compressed response body the way fetch would", async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from(JSON.stringify({ token_endpoint: "https://auth.example/token" }), "utf8")));
    });
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: upstream.port });

    const response = await guardedRemoteHttpFetch(`http://${REBIND_HOST}/.well-known/oauth-authorization-server`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      socketFactory: network.factory,
      error: guardError,
    });

    await expect(response.json()).resolves.toEqual({ token_endpoint: "https://auth.example/token" });
    expect(response.headers.get("content-encoding")).toBeNull();
  });

  it("gives up on a server that accepts the connection and never answers", async () => {
    // Platform `fetch` applied undici's headersTimeout for free. The OAuth
    // callers pass no AbortSignal, so the pinned transport has to own the
    // deadline or a silent server would hold the request open forever.
    const upstream = await startServer(() => {
      /* accept the request and never respond */
    });
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: upstream.port });

    await expect(guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      socketFactory: network.factory,
      responseTimeoutMs: 150,
      error: guardError,
    })).rejects.toMatchObject({ code: "remote_http_response_timeout" });

    // The deadline has to hand back the socket, not just the request handler:
    // a bounded call that still leaks a descriptor per silent peer is the same
    // exhaustion bug wearing a timer.
    expect(upstream.requests).toHaveLength(1);
    await flush();
    expect(network.sockets.map((socket) => socket.destroyed)).toEqual([true]);
  });

  it("gives up on a peer that dribbles response headers forever", async () => {
    // This is why the headers deadline is a hard timer rather than
    // `req.setTimeout`: an idle timeout never fires against this peer, because
    // every trickled header line resets it.
    const raw = netCreateServer((socket) => {
      socket.write("HTTP/1.1 200 OK\r\n");
      const beat = setInterval(() => socket.write("x-pad: keepalive\r\n"), 25);
      const stop = () => clearInterval(beat);
      socket.on("close", stop);
      socket.on("error", stop);
    });
    await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
    const port = (raw.address() as AddressInfo).port;
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: port });

    try {
      await expect(guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
        allowPrivateNetwork: false,
        lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
        socketFactory: network.factory,
        responseTimeoutMs: 150,
        error: guardError,
      })).rejects.toMatchObject({ code: "remote_http_response_timeout" });

      await flush();
      expect(network.sockets.map((socket) => socket.destroyed)).toEqual([true]);
    } finally {
      await new Promise<void>((resolve) => raw.close(() => resolve()));
    }
  });

  it("gives up on a response body that stalls midway", async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"partial":');
      // never finishes the body
    });
    const network = routingSocketFactory({ [PUBLIC_ADDRESS]: upstream.port });

    const response = await guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      socketFactory: network.factory,
      responseTimeoutMs: 150,
      error: guardError,
    });

    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toMatchObject({ code: "remote_http_response_timeout" });
    await flush();
    expect(network.sockets.map((socket) => socket.destroyed)).toEqual([true]);
  });

  it("falls over to the next approved address when the first is unreachable", async () => {
    // Pinning must not cost the failover `fetch` gave a multi-homed host: one
    // dead A record should not take the connection down with it.
    const upstream = await startServer();
    const dead = await startServer();
    // Close the listener so the address is routable but refuses connections.
    await new Promise<void>((resolve) => dead.server.close(() => resolve()));
    const network = routingSocketFactory({
      "93.184.216.35": dead.port,
      [PUBLIC_ADDRESS]: upstream.port,
    });

    const response = await guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [
        { address: "93.184.216.35", family: 4 },
        { address: PUBLIC_ADDRESS, family: 4 },
      ],
      socketFactory: network.factory,
      error: guardError,
    });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(network.dialled).toEqual(["93.184.216.35", PUBLIC_ADDRESS]);
  });

  it("fails closed instead of falling over when a peer fails the address check", async () => {
    // Failover covers unreachable addresses only. A peer that answers from an
    // unapproved address is the rebinding defence firing, and must not be
    // retried past.
    const internal = await startServer();
    const upstream = await startServer();
    const dialled: string[] = [];
    const factory: RemoteHttpSocketFactory = (target) => {
      dialled.push(target.address);
      const socket = netConnect({ host: "127.0.0.1", port: internal.port });
      openSockets.push(socket);
      return socket;
    };

    await expect(guardedRemoteHttpFetch(`http://${REBIND_HOST}/mcp`, {}, {
      allowPrivateNetwork: false,
      lookup: async () => [
        { address: "93.184.216.35", family: 4 },
        { address: PUBLIC_ADDRESS, family: 4 },
      ],
      socketFactory: factory,
      error: guardError,
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });

    expect(dialled).toEqual(["93.184.216.35"]);
    expect(internal.requests).toHaveLength(0);
    expect(upstream.requests).toHaveLength(0);
  });

  it("still refuses a private IP literal before any transport runs", async () => {
    await expect(guardedRemoteHttpFetch("http://169.254.169.254/latest/meta-data/", {}, {
      allowPrivateNetwork: false,
      error: guardError,
      unpinnedFetch: async () => {
        throw new Error("must not fetch");
      },
      socketFactory: () => {
        throw new Error("must not dial");
      },
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("uses platform fetch for a public IP literal, where nothing can be re-resolved", async () => {
    const calls: string[] = [];
    const response = await guardedRemoteHttpFetch("https://93.184.216.34/mcp", { method: "POST" }, {
      allowPrivateNetwork: false,
      error: guardError,
      unpinnedFetch: async (input, init) => {
        calls.push(`${init?.method} ${String(input)} ${init?.redirect}`);
        return new Response("{}", { status: 200 });
      },
      socketFactory: () => {
        throw new Error("must not dial");
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["POST https://93.184.216.34/mcp manual"]);
  });

  it("uses platform fetch for an allowed private IP literal", async () => {
    const calls: string[] = [];
    const response = await guardedRemoteHttpFetch("http://127.0.0.1:9/mcp", {}, {
      allowPrivateNetwork: true,
      error: guardError,
      unpinnedFetch: async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      },
      socketFactory: () => {
        throw new Error("must not dial");
      },
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual(["http://127.0.0.1:9/mcp"]);
  });

  it("never invokes platform fetch for a link-local literal in private mode", async () => {
    const calls: string[] = [];
    await expect(guardedRemoteHttpFetch("http://169.254.169.254/latest/meta-data/", {}, {
      allowPrivateNetwork: true,
      error: guardError,
      unpinnedFetch: async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      },
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    expect(calls).toEqual([]);
  });

  it("pins an allowed private hostname and rejects a link-local peer before request bytes", async () => {
    const internal = await startServer();
    const factory: RemoteHttpSocketFactory = () => {
      const socket = netConnect({ host: "127.0.0.1", port: internal.port });
      openSockets.push(socket);
      Object.defineProperty(socket, "remoteAddress", { get: () => "169.254.169.254", configurable: true });
      return socket;
    };

    await expect(guardedRemoteHttpFetch("http://lan-service.example/mcp", {}, {
      allowPrivateNetwork: true,
      lookup: async () => [{ address: "10.0.0.8", family: 4 }],
      socketFactory: factory,
      error: guardError,
      unpinnedFetch: async () => {
        throw new Error("hostnames must remain pinned");
      },
    })).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    expect(internal.requests).toHaveLength(0);
  });
});
