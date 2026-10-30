import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeUnikraftTool } from "../services/connectors/unikraft/client.js";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";

const credential = "unikraft-http-fixture-token";
const servers: Server[] = [], sockets: Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.destroy());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function provider() {
  const received: { method: string; url: string; host: string; contentType?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      received.push({ method: req.method!, url: req.url!, host: req.headers.host!, contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8") });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "success", data: { instances: [] }, op_time_us: 1 }));
    });
  });
  servers.push(server);
  server.on("connection", socket => sockets.push(socket));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // Preserve the real pinned node:http path, including its body serializer.
  // Only the network/TLS leg is a controlled local stand-in.
  const request = (url: string, init: RequestInit) => {
    const endpoint = new URL(url);
    endpoint.protocol = "http:"; endpoint.port = String(port);
    return guardedRemoteHttpFetch(endpoint, init, {
      allowPrivateNetwork: false, lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      socketFactory: target => {
        const socket = connect({ host: "127.0.0.1", port });
        sockets.push(socket);
        Object.defineProperty(socket, "remoteAddress", { get: () => target.address, configurable: true });
        return socket;
      },
      responseTimeoutMs: 5000, error: (message, code) => Object.assign(new Error(message), { code }),
    });
  };
  const call = (toolName: string, parameters: unknown) => executeUnikraftTool({
    binding: { companyId: "company", agentId: "agent" }, connection: { companyId: "company", config: {} },
    headers: { Authorization: `Bearer ${credential}` }, request, toolName, parameters,
    signal: AbortSignal.timeout(3000), deadlineAt: Date.now() + 3000,
  });
  return { call, received };
}

describe("Unikraft production HTTP boundary", () => {
  it.each([
    ["unikraft_get_instance_logs", "GET", { metro: "dal", query: { name: ["web"] }, body: [{ name: "web" }] }],
    ["unikraft_delete_instances", "DELETE", { body: [{ name: "web" }] }],
  ] as const)("sends %s JSON selectors as a %s request body through the pinned transport", async (toolName, method, parameters) => {
    const p = await provider();
    await p.call(toolName, parameters);
    expect(p.received).toHaveLength(1);
    const [received] = p.received;
    expect(received.method).toBe(method);
    expect(received.host).toMatch(new RegExp(`^api\\.${parameters.metro ?? "fra"}\\.unikraft\\.cloud:`));
    expect(received.contentType).toBe("application/json");
    expect(JSON.parse(received.body)).toEqual([{ name: "web" }]);
    if (method === "GET") expect(received.url).toBe("/v1/instances/log?name=web");
  });
});
