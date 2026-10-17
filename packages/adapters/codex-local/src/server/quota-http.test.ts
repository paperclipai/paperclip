import { readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, globalAgent } from "node:https";
import { connect, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuotaResponse } from "./quota-http.js";

vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https")>();
  const { readFileSync } = await import("node:fs");
  const ca = readFileSync(new URL("./__fixtures__/quota-tls.pem", import.meta.url));
  return { ...https, Agent: class extends https.Agent {
    constructor(options: ConstructorParameters<typeof https.Agent>[0]) { super({ ...options, ca }); }
  } };
});

describe("OpenAI quota transport", () => {
  const pem = readFileSync(new URL("./__fixtures__/quota-tls.pem", import.meta.url));
  let status = 200;
  let body = "{}";
  let stall = false;
  let requests = 0;
  let tunnels = 0;
  let receivedAuthorization: string | undefined;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); };
  const provider = createServer({ key: pem, cert: pem }, (req, res) => {
    requests++;
    receivedAuthorization = req.headers.authorization;
    res.writeHead(status, { location: "https://example.invalid/must-not-follow" });
    if (!stall) res.end(body);
  });
  const proxy = createHttpServer();
  let endpoint: string;
  let proxyUrl: string;
  provider.on("connection", track);
  proxy.on("connection", track);
  proxy.on("connect", (_req, client, head) => {
    tunnels++;
    const upstream = connect((provider.address() as { port: number }).port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    track(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  beforeAll(async () => {
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve));
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    endpoint = `https://127.0.0.1:${(provider.address() as { port: number }).port}/usage`;
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  });
  beforeEach(() => {
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]) vi.stubEnv(key, "");
    status = 200; body = "{}"; stall = false; requests = 0; tunnels = 0;
  });
  afterEach(() => { vi.unstubAllEnvs(); for (const socket of sockets) socket.destroy(); });
  afterAll(async () => {
    await Promise.all([provider, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  });

  it.each(["HTTPS_PROXY", "https_proxy"])("uses %s without NODE_USE_ENV_PROXY and retains TLS", async key => {
    vi.stubEnv(key, proxyUrl);
    const response = await fetchQuotaResponse(endpoint, { Authorization: "Bearer fixture" });
    expect(await response.json()).toEqual({});
    expect(tunnels).toBe(1);
    expect(receivedAuthorization).toBe("Bearer fixture");
    expect((await import("node:https")).globalAgent).toBe(globalAgent);
  });

  it("honors lowercase proxy precedence", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    vi.stubEnv("https_proxy", proxyUrl);
    expect((await fetchQuotaResponse(endpoint, {})).ok).toBe(true);
    expect(tunnels).toBe(1);
  });

  it("rejects a TLS hostname mismatch through the proxy", async () => {
    vi.stubEnv("HTTPS_PROXY", proxyUrl);
    await expect(fetchQuotaResponse(endpoint.replace("127.0.0.1", "wrongname.invalid"), {})).rejects.toMatchObject({ kind: "network" });
    expect(requests).toBe(0);
  });

  it.each(["NO_PROXY", "no_proxy"])("bypasses the configured proxy via %s", async key => {
    vi.stubEnv("HTTPS_PROXY", proxyUrl);
    vi.stubEnv(key, "127.0.0.1");
    expect((await fetchQuotaResponse(endpoint, {})).ok).toBe(true);
    expect(requests).toBe(1);
    expect(tunnels).toBe(0);
  });

  it("does not follow redirects or forward credentials to another host", async () => {
    status = 302;
    expect((await fetchQuotaResponse(endpoint, { Authorization: "Bearer fixture" })).status).toBe(302);
    expect(requests).toBe(1);
  });

  it("bounds error bodies and rejects oversized success responses", async () => {
    body = "x".repeat(1024 * 1024 + 1);
    await expect(fetchQuotaResponse(endpoint, {})).rejects.toMatchObject({ kind: "unavailable" });
    status = 401;
    expect((await (await fetchQuotaResponse(endpoint, {})).text()).length).toBe(4000);
  });

  it("bounds a stalled response and accepts caller cancellation", async () => {
    stall = true;
    await expect(fetchQuotaResponse(endpoint, {}, undefined, 30)).rejects.toMatchObject({ kind: "network" });
    await expect(fetchQuotaResponse(endpoint, {}, AbortSignal.abort())).rejects.toMatchObject({ kind: "network" });
  });

  it("redacts invalid proxy credentials", async () => {
    vi.stubEnv("HTTPS_PROXY", "invalid://fixture-secret:password@proxy");
    await expect(fetchQuotaResponse(endpoint, {})).rejects.toMatchObject({ kind: "network", message: expect.not.stringContaining("fixture-secret") });
  });
});
