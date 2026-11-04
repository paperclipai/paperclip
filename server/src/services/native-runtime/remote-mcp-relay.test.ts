import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientRequest, createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { RUNNER_TOOL_SCOPE_TOKEN_HEADER } from "../../vendor/paperclip-runner/index.js";
import { createRemoteMcpRelayToken, forwardRemoteMcpRequest, registerRemoteMcpRelay, remoteMcpRelayUrl } from "./remote-mcp-relay.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

describe("native remote MCP relay", () => {
  it("forwards authenticated bytes to the owned socket and revokes after release", async () => {
    const root = await mkdtemp("/tmp/pc-relay-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, "mcp.sock");
    const token = createRemoteMcpRelayToken();
    let calls = 0;
    const scopeAuthorization = `Bearer ${createRemoteMcpRelayToken()}`;
    const observedScopeHeaders: Array<string | string[] | undefined> = [];
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${token}`);
      expect(req.url).toBe("/mcp");
      observedScopeHeaders.push(req.headers[RUNNER_TOOL_SCOPE_TOKEN_HEADER]);
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => { calls++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(Buffer.concat(chunks).toString()).id, result: { accepted: true } })); });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    let active = true;
    const release = registerRemoteMcpRelay({ runId: "run", socketPath, token, expiresAt: Date.now() + 60_000, authorized: async () => active });
    cleanup.push(release);
    const body = { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "paperclip_finish", arguments: {} } };
    const invoke = (authorization = `Bearer ${token}`) => forwardRemoteMcpRequest({ runId: "run", authorization, scopeAuthorization, body });
    expect((await invoke("Bearer forged")).status).toBe(401);
    const response = await invoke();
    expect(response.status).toBe(200);
    expect(observedScopeHeaders).toEqual([scopeAuthorization]);
    expect(JSON.parse(response.body.toString())).toEqual({ jsonrpc: "2.0", id: 0, result: { accepted: true } });
    active = false;
    expect((await invoke()).status).toBe(403);
    release();
    expect((await invoke()).status).toBe(401);
    expect(calls).toBe(1);
  });

  it("rejects expired/cross-run credentials, duplicate owners and oversized bodies", async () => {
    const token = createRemoteMcpRelayToken();
    cleanup.push(registerRemoteMcpRelay({ runId: "expired", socketPath: "/tmp/unused.sock", token, expiresAt: Date.now() - 1, authorized: async () => true }));
    expect((await forwardRemoteMcpRequest({ runId: "expired", authorization: `Bearer ${token}`, body: {} })).status).toBe(401);
    expect((await forwardRemoteMcpRequest({ runId: "other-run", authorization: `Bearer ${token}`, body: {} })).status).toBe(401);
    const binding = { runId: "bound", socketPath: "/tmp/unused.sock", token, expiresAt: Date.now() + 60_000, authorized: async () => true };
    cleanup.push(registerRemoteMcpRelay(binding));
    expect(() => registerRemoteMcpRelay(binding)).toThrow("already_registered");
    expect((await forwardRemoteMcpRequest({ runId: "bound", authorization: `Bearer ${token}`, body: "x".repeat(1_048_576) })).status).toBe(413);
  });

  it.each([false, true])("settles a timed-out Unix upstream once and closes its socket (headers sent: %s)", async headersSent => {
    const root = await mkdtemp("/tmp/pc-relay-timeout-");
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const socketPath = join(root, "mcp.sock");
    const sockets = new Set<Socket>();
    let calls = 0;
    let closed = 0;
    const server = createServer((req, res) => {
      calls++;
      req.resume();
      if (headersSent) res.write("partial response");
    });
    server.on("connection", socket => {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); closed++; });
    });
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    cleanup.push(() => { for (const socket of sockets) socket.destroy(); });
    const token = createRemoteMcpRelayToken();
    cleanup.push(registerRemoteMcpRelay({ runId: "timeout", socketPath, token, expiresAt: Date.now() + 60_000, authorized: async () => true }));
    const originalSetTimeout = ClientRequest.prototype.setTimeout;
    const timeout = vi.spyOn(ClientRequest.prototype, "setTimeout").mockImplementation(function (this: ClientRequest, milliseconds, callback) {
      expect(milliseconds).toBe(120_000);
      return originalSetTimeout.call(this, 25, callback);
    });
    cleanup.push(() => { timeout.mockRestore(); });
    let settled = 0;
    const result = forwardRemoteMcpRequest({ runId: "timeout", authorization: `Bearer ${token}`, body: {} }).then(response => { settled++; return response; });
    expect(await result).toEqual({ status: headersSent ? 502 : 503, body: Buffer.alloc(0) });
    await vi.waitFor(() => expect(closed).toBe(1));
    expect(calls).toBe(1);
    expect(settled).toBe(1);
    expect(sockets.size).toBe(0);
  });

  it("uses configured HTTPS only, with no authority from inbound hosts", () => {
    expect(remoteMcpRelayUrl("https://relay.example", "run/1")).toBe("https://relay.example/mcp/native-runs/run%2F1");
    for (const origin of ["http://localhost:3100", "https://user:pass@example.test", "https://example.test/path", "https://example.test/?token=secret"]) expect(() => remoteMcpRelayUrl(origin, "run")).toThrow("public_url_required");
  });
});
