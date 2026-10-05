import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as netConnect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { ghFetch, gitHubPrivateEndpointAllowlist } from "../services/github-fetch.js";
import type { RemoteHttpSocketFactory } from "../services/remote-http-fetch.js";

/**
 * Every GitHub hostname the server fetches came from content a company member
 * or an agent supplied: a skill import source, a catalog origin, a portable
 * company bundle. The server resolves it and connects, so an unguarded fetch
 * would let that text instruct the server to read a service only it can see —
 * a database on the private network behind it, or the cloud metadata endpoint —
 * and hand the body back to whoever asked.
 *
 * Nothing here touches real DNS or the real network: `lookup` is the name
 * server's answer and `socketFactory` stands in for the network, so an address
 * the guard calls private is a loopback listener that reports itself as that
 * address, exactly as the kernel would.
 */

const ENTERPRISE_HOST = "ghe.internal.test";
const PRIVATE_ADDRESS = "10.0.0.5";
const METADATA_ADDRESS = "169.254.169.254";

const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function startServer(handler?: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    if (handler) {
      handler(req, res);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("# Enterprise skill\n");
  });
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/** Routes whatever address the transport dialled to a loopback listener. */
function routingSocketFactory(routes: Record<string, number>) {
  const dialled: string[] = [];
  const factory: RemoteHttpSocketFactory = (target) => {
    dialled.push(target.address);
    const port = routes[target.address];
    if (port === undefined) throw new Error(`test network has no route to ${target.address}`);
    const socket = netConnect({ host: "127.0.0.1", port });
    openSockets.push(socket);
    Object.defineProperty(socket, "remoteAddress", { get: () => target.address, configurable: true });
    return socket;
  };
  return { factory, dialled };
}

describe("ghFetch endpoint guard", () => {
  it("refuses a GitHub Enterprise hostname that resolves onto the private network", async () => {
    await expect(ghFetch(`http://${ENTERPRISE_HOST}/api/v3/repos/acme/skills`, undefined, {
      lookup: async () => [{ address: PRIVATE_ADDRESS, family: 4 }],
      socketFactory: () => {
        throw new Error("the guard must refuse before anything is dialled");
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "GitHub source URL cannot resolve to private or reserved network addresses",
      details: { code: "remote_http_private_endpoint" },
    });
  });

  it("refuses the cloud metadata address even when its origin is allowlisted", async () => {
    await expect(ghFetch(`http://${METADATA_ADDRESS}/latest/meta-data/`, undefined, {
      privateEndpointAllowlist: new Set([`http://${METADATA_ADDRESS}`]),
      socketFactory: () => {
        throw new Error("the guard must refuse before anything is dialled");
      },
    })).rejects.toMatchObject({
      status: 422,
      message: "GitHub source URL cannot target private or reserved network addresses",
      details: { code: "remote_http_private_endpoint" },
    });
  });

  it("reaches an operator-allowlisted enterprise origin at the address it approved", async () => {
    const upstream = await startServer();
    const network = routingSocketFactory({ [PRIVATE_ADDRESS]: upstream.port });

    const response = await ghFetch(`http://${ENTERPRISE_HOST}/raw/acme/skills/main/SKILL.md`, undefined, {
      privateEndpointAllowlist: gitHubPrivateEndpointAllowlist(`http://${ENTERPRISE_HOST}`),
      lookup: async () => [{ address: PRIVATE_ADDRESS, family: 4 }],
      socketFactory: network.factory,
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("# Enterprise skill\n");
    expect(network.dialled).toEqual([PRIVATE_ADDRESS]);
  });

  it("hands a redirect back instead of following it", async () => {
    const upstream = await startServer((_req, res) => {
      res.writeHead(302, { location: `http://${METADATA_ADDRESS}/latest/meta-data/` });
      res.end();
    });
    const network = routingSocketFactory({ [PRIVATE_ADDRESS]: upstream.port });

    const response = await ghFetch(`http://${ENTERPRISE_HOST}/raw/acme/skills/main/SKILL.md`, undefined, {
      privateEndpointAllowlist: new Set([`http://${ENTERPRISE_HOST}`]),
      lookup: async () => [{ address: PRIVATE_ADDRESS, family: 4 }],
      socketFactory: network.factory,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`http://${METADATA_ADDRESS}/latest/meta-data/`);
    expect(network.dialled).toEqual([PRIVATE_ADDRESS]);
  });

  it("refuses a source URL that is not http or https", async () => {
    await expect(ghFetch("ftp://github.com/acme/skills")).rejects.toMatchObject({
      status: 422,
      message: "GitHub source URL must use http or https",
    });
  });

  it("keeps only bare origins in the operator allowlist", () => {
    expect([...gitHubPrivateEndpointAllowlist(
      `http://${ENTERPRISE_HOST} , https://GHE.Internal.Test:8443 , https://ghe.internal.test/api , not-a-url , ftp://ghe.internal.test`,
    )]).toEqual([
      `http://${ENTERPRISE_HOST}`,
      "https://ghe.internal.test:8443",
    ]);
  });
});
