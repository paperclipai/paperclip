import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { executeDaytonaTool } from "../services/daytona.js";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";

const organizationId = randomUUID(), sandboxId = randomUUID();
const credential = "daytona-http-fixture-key";
const servers: Server[] = [], sockets: Socket[] = [];
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.destroy());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function provider(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  stallIdentity = false) {
  const calls: string[] = [], errors: unknown[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url!);
    if (req.url === "/health") { res.end("ok"); return; }
    const json = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.url === "/api/api-keys/current" && !stallIdentity) { json({ organizationId }); return; }
    if (req.url === `/api/sandbox/${sandboxId}`) {
      json({ id: sandboxId, organizationId, toolboxProxyUrl: "https://proxy.app.daytona.io/toolbox" }); return;
    }
    Promise.resolve(handler(req, res)).catch(error => { errors.push(error); res.statusCode = 500; res.end(); });
  });
  servers.push(server);
  server.on("connection", socket => sockets.push(socket));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  // Preserve the real pinned node:http path, including its body serializer and
  // abort handling. Only the network/TLS leg is a controlled local stand-in.
  const request = (url: string, init: RequestInit) => {
    const endpoint = new URL(url);
    endpoint.protocol = "http:"; endpoint.hostname = "daytona-boundary.test"; endpoint.port = String(port);
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
  const call = (toolName: string, parameters: unknown, budgetMs = 3000) => executeDaytonaTool({
    binding: { companyId: "company", agentId: "agent" }, connection: { companyId: "company", config: {} },
    headers: { Authorization: `Bearer ${credential}` }, request, toolName, parameters,
    signal: AbortSignal.timeout(budgetMs), deadlineAt: Date.now() + budgetMs,
  });
  return { call, calls, errors, health: () => fetch(`http://127.0.0.1:${port}/health`) };
}

describe("Daytona production HTTP boundary", () => {
  it.each([false, true])("sends valid multipart bytes through the pinned transport (bulk=%s)", async bulk => {
    const bytes = Buffer.from([0, 255, 1, 13, 10]);
    const p = await provider(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${credential}`);
      expect(req.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const form = await new Response(body, { headers: { "Content-Type": req.headers["content-type"]! } }).formData();
      expect(Buffer.from(await (form.get(bulk ? "files" : "file") as Blob).arrayBuffer())).toEqual(bytes);
      if (bulk) expect(body.toString("latin1")).toContain('filename="/workspace/binary.bin"');
      res.setHeader("Content-Type", "application/json"); res.end('{"uploaded":true}');
    });
    await expect(p.call(bulk ? "daytona_toolbox_upload_files" : "daytona_toolbox_upload_file", {
      sandboxId,
      ...(bulk ? { files: [{ path: "/workspace/binary.bin", contentBase64: bytes.toString("base64") }] }
        : { query: { path: "/workspace/binary.bin" }, body: { file: bytes.toString("base64") } }),
    })).resolves.toEqual({ uploaded: true });
    expect(p.errors).toEqual([]);
  });

  it("encodes audit filter objects using the documented bracket keys", async () => {
    const p = await provider((req, res) => {
      const url = new URL(req.url!, "http://provider.test");
      expect(url.searchParams.get("createdAt[gte]")).toBe("2026-10-01T00:00:00Z");
      expect(url.searchParams.get("actorId[eq]")).toBe("actor");
      expect(url.searchParams.get("statusCode[gte]")).toBe("400");
      expect(url.searchParams.has("createdAt")).toBe(false);
      res.setHeader("Content-Type", "application/json"); res.end("[]");
    });
    await expect(p.call("daytona_api_get_organization_audit_logs", { path: { organizationId },
      query: { createdAt: { gte: "2026-10-01T00:00:00Z" }, actorId: { eq: "actor" }, statusCode: { gte: 400 } },
    })).resolves.toEqual([]);
    expect(p.errors).toEqual([]);
  });

  it.each(["identity", "body"])("honors a total deadline during %s without blocking unrelated requests", async phase => {
    const p = await provider((_req, res) => {
      if (phase === "body") {
        res.setHeader("Content-Type", "application/json"); res.write('{"pending":');
        // A dribbling body defeats idle timeouts but must not renew the action budget.
        const timer = setInterval(() => res.write(" "), 10);
        res.on("close", () => clearInterval(timer));
      }
    }, phase === "identity");
    const pending = expect(p.call("daytona_api_create_sandbox", { body: { name: "deadline" } }, 300))
      .rejects.toMatchObject({ status: 504, details: { code: "daytona_deadline_exceeded" } });
    expect(await (await p.health()).text()).toBe("ok");
    await pending;
    expect(p.calls.filter(url => url === "/api/sandbox")).toHaveLength(phase === "identity" ? 0 : 1);
    expect(p.errors).toEqual([]);
  });
});
