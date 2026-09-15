import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: async () => {}, subscribe: () => {} };
    },
  } as any;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  ));
});

async function startLoopbackServer() {
  const responseBody = JSON.stringify({ ok: true });
  const server = await new Promise<Server>((resolve) => {
    const srv = createServer((req, res) => {
      expect(req.headers.host).toMatch(/^127\.0\.0\.1:/);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(responseBody);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not expose a TCP port");
  return { url: `http://127.0.0.1:${address.port}/health`, responseBody };
}

function handlersForCapabilities(capabilities: string[]) {
  const services = buildHostServices({} as never, "plugin-record-id", "test.plugin", createEventBusStub(), undefined, {
    manifest: { id: "test.plugin", capabilities } as any,
  });
  return createHostClientHandlers({
    pluginId: "test.plugin",
    capabilities,
    services,
  });
}

describe("plugin http.fetch private-network capability", () => {
  it("blocks private-network targets when the plugin has only http.outbound", async () => {
    const { url } = await startLoopbackServer();
    const handlers = handlersForCapabilities(["http.outbound"]);

    await expect(handlers["http.fetch"]({ url })).rejects.toThrow(/http\.private-network/);
  });

  it("allows private-network targets when the plugin declares http.private-network", async () => {
    const { url, responseBody } = await startLoopbackServer();
    const handlers = handlersForCapabilities(["http.outbound", "http.private-network"]);

    await expect(handlers["http.fetch"]({ url })).resolves.toMatchObject({
      status: 200,
      body: responseBody,
    });
  });

  it("still rejects non-http protocols", async () => {
    const handlers = handlersForCapabilities(["http.outbound", "http.private-network"]);

    await expect(handlers["http.fetch"]({ url: "file:///etc/passwd" })).rejects.toThrow(
      /only http: and https: are permitted/,
    );
  });
});
