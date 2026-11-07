import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createServer as createNetServer, connect as netConnect, type AddressInfo, type Server as NetServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
} from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const testToolActionSigningSecret = "test-tool-action-signing-secret";

type Db = ReturnType<typeof createDb>;

type Socks5ConnectRecord = {
  atyp: number;
  targetHost: string;
  targetPort: number;
};

type Socks5TestProxy = {
  server: NetServer;
  port: number;
  connections: Socks5ConnectRecord[];
  close: () => Promise<void>;
};

function createSocks5TestProxy(targetPortMap?: Record<string, number>): Promise<Socks5TestProxy> {
  return new Promise((resolve, reject) => {
    const connections: Socks5ConnectRecord[] = [];
    const openSockets: Socket[] = [];

    const server = createNetServer((clientSocket) => {
      openSockets.push(clientSocket);
      let stage: "greeting" | "connect" | "piping" = "greeting";

      clientSocket.on("error", () => {});

      clientSocket.on("data", (chunk) => {
        if (stage === "greeting") {
          if (chunk[0] !== 0x05) {
            clientSocket.destroy();
            return;
          }
          clientSocket.write(Buffer.from([0x05, 0x00]));
          stage = "connect";
          return;
        }

        if (stage === "connect") {
          if (chunk[0] !== 0x05 || chunk[1] !== 0x01) {
            clientSocket.destroy();
            return;
          }
          const atyp = chunk[3];
          let targetHost = "";
          let offset = 4;

          if (atyp === 0x01) {
            targetHost = `${chunk[offset]}.${chunk[offset + 1]}.${chunk[offset + 2]}.${chunk[offset + 3]}`;
            offset += 4;
          } else if (atyp === 0x03) {
            const len = chunk[offset];
            offset += 1;
            targetHost = chunk.subarray(offset, offset + len).toString("utf8");
            offset += len;
          } else if (atyp === 0x04) {
            targetHost = "ipv6";
            offset += 16;
          } else {
            clientSocket.destroy();
            return;
          }

          const targetPort = chunk.readUInt16BE(offset);
          connections.push({ atyp, targetHost, targetPort });

          const destPort = targetPortMap?.[targetHost] ?? targetPort;
          const destSocket = netConnect({ host: "127.0.0.1", port: destPort }, () => {
            clientSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            stage = "piping";
            clientSocket.pipe(destSocket);
            destSocket.pipe(clientSocket);
          });

          openSockets.push(destSocket);
          destSocket.on("error", () => clientSocket.destroy());
        }
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        port,
        connections,
        close: async () => {
          for (const s of openSockets) s.destroy();
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
    server.on("error", reject);
  });
}

type McpTestServer = {
  server: Server;
  port: number;
  requests: Array<{ method: string; url: string; body: unknown; authorization?: string }>;
  close: () => Promise<void>;
};

const OAUTH_ACCESS_TOKEN = "proxied-access-token";

function createMcpTestServer(options: { oauth?: boolean } = {}): Promise<McpTestServer> {
  return new Promise((resolve, reject) => {
    const requests: McpTestServer["requests"] = [];
    let origin = "";
    const sendJson = (res: ServerResponse, status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      let bodyText = "";
      for await (const chunk of req) bodyText += chunk;
      let body: unknown = null;
      try {
        body = JSON.parse(bodyText);
      } catch {
        if (bodyText) body = Object.fromEntries(new URLSearchParams(bodyText));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body, authorization: req.headers.authorization });

      if (options.oauth) {
        if (req.method === "GET" && req.url === "/.well-known/oauth-protected-resource/mcp") {
          sendJson(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
          return;
        }
        if (req.method === "GET" && req.url === "/.well-known/oauth-authorization-server") {
          sendJson(res, 200, {
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            registration_endpoint: `${origin}/register`,
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
          return;
        }
        if (req.method === "POST" && req.url === "/register") {
          const requested = body as Record<string, unknown>;
          sendJson(res, 201, { ...requested, client_id: "proxied-client" });
          return;
        }
        if (req.method === "POST" && req.url === "/token") {
          sendJson(res, 200, { access_token: OAUTH_ACCESS_TOKEN, token_type: "Bearer", refresh_token: "proxied-refresh-token", expires_in: 3600 });
          return;
        }
        if (req.url === "/mcp" && req.headers.authorization !== `Bearer ${OAUTH_ACCESS_TOKEN}`) {
          res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` });
          res.end();
          return;
        }
      }

      if (req.method === "POST" && body && typeof body === "object") {
        const payload = body as Record<string, unknown>;
        if (payload.method === "tools/list") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? "1",
              result: {
                tools: [
                  {
                    name: "echo_tool",
                    description: "Echo test tool",
                    inputSchema: {
                      type: "object",
                      properties: { text: { type: "string" } },
                    },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (payload.method === "tools/call") {
          const params = payload.params as Record<string, unknown> | undefined;
          const args = params?.arguments as Record<string, unknown> | undefined;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: payload.id ?? "1",
              result: {
                content: [{ type: "text", text: `proxied:${args?.text ?? "ok"}` }],
              },
            }),
          );
          return;
        }
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      origin = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        requests,
        close: async () => {
          await new Promise<void>((res) => server.close(() => res()));
        },
      });
    });
    server.on("error", reject);
  });
}

const guardError = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("SOCKS5 proxy guard", () => {
  it("rejects a proxy that is not socks5h or carries credentials", async () => {
    for (const proxy of ["http://proxy.example.test:1080", "socks5://proxy.example.test:1080", "not a url", "socks5h://user:secret@proxy.example.test:1080"]) {
      await expect(
        guardedRemoteHttpFetch("https://mcp.example.test/mcp", {}, { error: guardError, proxy }),
      ).rejects.toMatchObject({ code: "mcp_remote_proxy_invalid" });
    }
  });

  it("denies a proxy in a private network when private networks are not allowed, before opening a socket", async () => {
    const socketFactory = vi.fn();
    await expect(
      guardedRemoteHttpFetch("https://mcp.example.test/mcp", {}, {
        allowPrivateNetwork: false,
        error: guardError,
        proxy: "socks5h://10.0.0.5:1080",
        socketFactory,
      }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("denies a target hostname that resolves here to a link-local address, before opening a socket", async () => {
    const socketFactory = vi.fn();
    await expect(
      guardedRemoteHttpFetch("http://metadata.internal.test/latest/meta-data", {}, {
        allowPrivateNetwork: true,
        error: guardError,
        proxy: "socks5h://203.0.113.10:1080",
        lookup: async (hostname) =>
          hostname === "metadata.internal.test" ? [{ address: "169.254.169.254", family: 4 }] : [{ address: "203.0.113.10", family: 4 }],
        socketFactory,
      }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("leaves a target hostname that does not resolve here to the proxy", async () => {
    const socketFactory = vi.fn(() => { throw new Error("proxy dialled"); });
    await expect(
      guardedRemoteHttpFetch("http://mcp.behind-proxy.test/mcp", {}, {
        allowPrivateNetwork: true,
        error: guardError,
        proxy: "socks5h://203.0.113.10:1080",
        lookup: async (hostname) => {
          if (hostname === "203.0.113.10") return [{ address: "203.0.113.10", family: 4 }];
          throw new Error("ENOTFOUND");
        },
        socketFactory,
      }),
    ).rejects.toThrow();
    expect(socketFactory).toHaveBeenCalled();
  });

  it("rejects a target hostname longer than SOCKS5 can carry, before opening a socket", async () => {
    const socketFactory = vi.fn();
    const hostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.test`;
    await expect(
      guardedRemoteHttpFetch(`http://${hostname}/mcp`, {}, {
        allowPrivateNetwork: true,
        error: guardError,
        proxy: "socks5h://203.0.113.10:1080",
        lookup: async () => { throw new Error("ENOTFOUND"); },
        socketFactory,
      }),
    ).rejects.toMatchObject({ code: "mcp_remote_url_invalid" });
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("completes HTTPS through the tunnel and checks the certificate against the target hostname", async () => {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-socks-tls-"));
    const key = join(directory, "target.key");
    const certificate = join(directory, "target.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
      "-days", "1", "-subj", "/CN=secure.remote.test", "-addext", "subjectAltName=DNS:secure.remote.test"], { stdio: "ignore" });
    const server = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const tunnel = await createSocks5TestProxy({ "secure.remote.test": port, "other.remote.test": port });
    const previousCertificates = getCACertificates("default");
    setDefaultCACertificates([...previousCertificates, await readFile(certificate, "utf8")]);
    const options = { allowPrivateNetwork: true, error: guardError, proxy: `socks5h://127.0.0.1:${tunnel.port}`,
      lookup: async () => { throw new Error("ENOTFOUND"); } };
    try {
      const response = await guardedRemoteHttpFetch(`https://secure.remote.test:${port}/mcp`, {}, options);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(tunnel.connections[0]).toEqual({ atyp: 0x03, targetHost: "secure.remote.test", targetPort: port });

      // The same certificate does not name this host, so the handshake fails.
      await expect(guardedRemoteHttpFetch(`https://other.remote.test:${port}/mcp`, {}, options))
        .rejects.toMatchObject({ code: "remote_http_connect_failed" });
    } finally {
      setDefaultCACertificates(previousCertificates);
      await tunnel.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps the guard for a literal target address", async () => {
    const proxy = "socks5h://127.0.0.1:1080";
    await expect(
      guardedRemoteHttpFetch("http://169.254.169.254/latest/meta-data", {}, { allowPrivateNetwork: true, error: guardError, proxy }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
    await expect(
      guardedRemoteHttpFetch("http://10.0.0.1/mcp", {}, { allowPrivateNetwork: false, error: guardError, proxy }),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});

describeEmbeddedPostgres("remote MCP connection through a SOCKS5 proxy", () => {
  let testDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let mcpServer: McpTestServer | null = null;
  let proxy: Socks5TestProxy | null = null;

  beforeAll(async () => {
    testDb = await startEmbeddedPostgresTestDatabase("paperclip-socks-test-");
    db = createDb(testDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await testDb?.cleanup();
  });

  afterEach(async () => {
    await mcpServer?.close();
    await proxy?.close();
    mcpServer = null;
    proxy = null;
  });

  async function createCompany() {
    const [company] = await db.insert(companies).values({
      name: "Proxy company",
      issuePrefix: `P${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    }).returning();
    return company!;
  }

  it("refreshes the catalog and calls a tool through the proxy, which resolves the target hostname", async () => {
    mcpServer = await createMcpTestServer();
    proxy = await createSocks5TestProxy({ "mcp.remote.test": mcpServer.port });
    const company = await createCompany();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Proxy agent", role: "engineer", adapterType: "process" }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Proxy issue", status: "in_progress" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent!.id, contextSnapshot: { issueId: issue!.id }, status: "running" }).returning();
    const accessSvc = toolAccessService(db);
    const profile = await accessSvc.createProfile(company.id, { profileKey: "proxy-agent", name: "Proxy agent", status: "active", defaultAction: "allow" });
    await accessSvc.bindProfile(profile.id, { targetType: "agent", targetId: agent!.id, priority: 100 });
    const connection = await accessSvc.createConnection(company.id, {
      name: "Proxied remote",
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      config: { url: `http://mcp.remote.test:${mcpServer.port}/mcp`, proxy: `socks5h://127.0.0.1:${proxy.port}` },
      transportConfig: {},
      connectionPurpose: "tool",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
    });

    const refreshed = await accessSvc.refreshCatalog(connection.id);

    expect(refreshed.catalog.map((entry) => entry.toolName)).toEqual(["echo_tool"]);
    expect(proxy.connections[0]).toEqual({ atyp: 0x03, targetHost: "mcp.remote.test", targetPort: mcpServer.port });

    const gateway = createToolGatewayService(db, { toolActionSigningSecret: testToolActionSigningSecret });
    const session = await gateway.createSession({ companyId: company.id, agentId: agent!.id, runId: run!.id });
    const echoTool = (await gateway.listToolsForSession(session.token)).find((tool) => tool.upstreamToolName === "echo_tool");
    const connectionsBeforeCall = proxy.connections.length;
    const result = await gateway.executeTool({ sessionToken: session.token, tool: echoTool!.name, parameters: { text: "hello" } });

    expect(JSON.stringify(result)).toContain("proxied:hello");
    expect(proxy.connections.length).toBeGreaterThan(connectionsBeforeCall);
    expect(proxy.connections.at(-1)?.targetHost).toBe("mcp.remote.test");
  });

  it("sends the Composio account calls of a connection through its proxy", async () => {
    const managed: string[][] = [];
    const composio = createServer(async (req, res) => {
      let bodyText = "";
      for await (const chunk of req) bodyText += chunk;
      const request = JSON.parse(bodyText);
      const toolkits = request.params.arguments.toolkits as { name: string; action: string }[];
      managed.push(toolkits.map((toolkit) => toolkit.action));
      const results = Object.fromEntries(toolkits.map((toolkit) => [toolkit.name, toolkit.action === "add"
        ? { redirect_url: "https://connect.composio.dev/link/test" }
        : { toolkit: toolkit.name, accounts: [] }]));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { data: { results } } } }));
    });
    await new Promise<void>((resolve) => composio.listen(0, "127.0.0.1", resolve));
    const composioPort = (composio.address() as AddressInfo).port;
    try {
      proxy = await createSocks5TestProxy({ "composio.remote.test": composioPort });
      const company = await createCompany();
      const userId = randomUUID();
      await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: userId, membershipRole: "admin", status: "active" });
      const [app] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Composio", type: "mcp_http", metadata: { sourceTemplateKey: "composio" } }).returning();
      const [connection] = await db.insert(toolConnections).values({
        companyId: company.id, applicationId: app!.id, uid: randomUUID(), name: "Proxied Composio", transport: "mcp_remote",
        authKind: "none", credentialPolicy: "shared", status: "active", enabled: true,
        config: { sourceTemplateKey: "composio", url: `http://composio.remote.test:${composioPort}/mcp`, proxy: `socks5h://127.0.0.1:${proxy.port}` },
      }).returning();
      await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection!.id, kind: "organization", isDefault: true, status: "active" });
      await db.insert(toolCatalogEntries).values({ companyId: company.id, connectionId: connection!.id, name: "COMPOSIO_MANAGE_CONNECTIONS", toolName: "COMPOSIO_MANAGE_CONNECTIONS", versionHash: "v1", status: "active", riskLevel: "destructive" });
      const access = toolAccessService(db, { composioAppToolkits: ["circleback_mcp"] });

      const result = await access.setupComposioApp(connection!.id, "circleback_mcp", { action: "start" }, { actorType: "user", actorId: userId });

      expect(result).toMatchObject({ status: "authorization_required" });
      expect(managed).toEqual([["list"], ["add"]]);
      expect(proxy.connections.length).toBeGreaterThanOrEqual(2);
      expect(proxy.connections.every((connect) => connect.targetHost === "composio.remote.test" && connect.atyp === 0x03)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => composio.close(() => resolve()));
    }
  });

  it("discovers OAuth, registers a client and exchanges the code through the proxy", async () => {
    mcpServer = await createMcpTestServer({ oauth: true });
    proxy = await createSocks5TestProxy();
    const company = await createCompany();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "board-user", status: "active", membershipRole: "admin" });
    const accessSvc = toolAccessService(db);
    const connection = await accessSvc.createConnection(company.id, {
      name: "Proxied OAuth remote",
      transport: "mcp_remote",
      config: { url: `http://127.0.0.1:${mcpServer.port}/mcp`, proxy: `socks5h://127.0.0.1:${proxy.port}` },
      transportConfig: {},
      connectionPurpose: "tool",
      authKind: "oauth",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
    });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const redirectUri = "https://paperclip.proxy.test/api/tools/oauth/callback";

    const start = await accessSvc.startOAuth(company.id, connection.id, { redirectUri, actor });
    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get("client_id")).toBe("proxied-client");

    await accessSvc.completeOAuthCallback({
      state: authorizationUrl.searchParams.get("state")!,
      code: "proxied-code",
      iss: `http://127.0.0.1:${mcpServer.port}`,
      redirectUri,
      actor,
    });

    const paths = mcpServer.requests.map((entry) => `${entry.method} ${entry.url}`);
    expect(paths).toEqual(expect.arrayContaining([
      "GET /.well-known/oauth-protected-resource/mcp",
      "GET /.well-known/oauth-authorization-server",
      "POST /register",
      "POST /token",
    ]));
    expect(mcpServer.requests.find((entry) => entry.url === "/token")?.body).toMatchObject({ grant_type: "authorization_code", code: "proxied-code" });
    expect(mcpServer.requests.some((entry) => entry.url === "/mcp" && entry.authorization === `Bearer ${OAUTH_ACCESS_TOKEN}`)).toBe(true);
    expect(proxy.connections.length).toBe(mcpServer.requests.length);
    expect(proxy.connections.every((entry) => entry.targetHost === "127.0.0.1" && entry.targetPort === mcpServer!.port)).toBe(true);
  });

  it("connects directly when the connection names no proxy", async () => {
    mcpServer = await createMcpTestServer();
    proxy = await createSocks5TestProxy();
    const company = await createCompany();
    const accessSvc = toolAccessService(db);
    const connection = await accessSvc.createConnection(company.id, {
      name: "Direct remote",
      transport: "mcp_remote",
      config: { url: `http://127.0.0.1:${mcpServer.port}/mcp` },
      transportConfig: {},
      connectionPurpose: "tool",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
    });

    await accessSvc.refreshCatalog(connection.id);

    expect(mcpServer.requests.length).toBeGreaterThan(0);
    expect(proxy.connections).toEqual([]);
  });

  it("fails without a direct request when the proxy cannot be reached", async () => {
    mcpServer = await createMcpTestServer();
    proxy = await createSocks5TestProxy();
    const unreachablePort = proxy.port;
    await proxy.close();
    proxy = null;
    const company = await createCompany();
    const accessSvc = toolAccessService(db);
    const connection = await accessSvc.createConnection(company.id, {
      name: "Unreachable proxy",
      transport: "mcp_remote",
      config: { url: `http://127.0.0.1:${mcpServer.port}/mcp`, proxy: `socks5h://127.0.0.1:${unreachablePort}` },
      transportConfig: {},
      connectionPurpose: "tool",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
    });

    await expect(accessSvc.refreshCatalog(connection.id)).rejects.toThrow();
    expect(mcpServer.requests).toEqual([]);
  });

  it("rejects an invalid proxy, or a private proxy in a public deployment, when the connection is saved", async () => {
    const company = await createCompany();
    const save = (svc: ReturnType<typeof toolAccessService>, proxyUrl: string) => svc.createConnection(company.id, {
      name: "Rejected proxy",
      transport: "mcp_remote",
      config: { url: "https://mcp.example.test/mcp", proxy: proxyUrl },
      transportConfig: {},
      connectionPurpose: "tool",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      credentialSecretRefs: [],
    });

    await expect(save(toolAccessService(db), "socks5://proxy.example.test:1080")).rejects.toMatchObject({
      details: expect.objectContaining({ code: "mcp_remote_proxy_invalid" }),
    });
    await expect(save(toolAccessService(db), "socks5h://user:secret@proxy.example.test:1080")).rejects.toMatchObject({
      details: expect.objectContaining({ code: "mcp_remote_proxy_invalid" }),
    });
    const publicSvc = toolAccessService(db, { deploymentMode: "authenticated", deploymentExposure: "public" });
    await expect(save(publicSvc, "socks5h://127.0.0.1:1080")).rejects.toMatchObject({
      details: expect.objectContaining({ code: "remote_http_private_endpoint" }),
    });
  });
});
