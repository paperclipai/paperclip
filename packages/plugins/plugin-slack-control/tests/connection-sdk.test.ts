import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Connection } from "../src/runtime.js";
import { config } from "./helpers.js";

const endpoint = vi.hoisted(() => ({ url: "" }));
// Use the actual Slack clients and undici transport against a loopback peer.
// Only the API base URL changes; no real credentials or Slack requests are used.
vi.mock("@slack/web-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/web-api")>();
  return { ...actual, WebClient: class extends actual.WebClient {
    constructor(token: string, options: import("@slack/web-api").WebClientOptions) { super(token, { ...options, slackApiUrl: endpoint.url }); }
  } };
});
vi.mock("@slack/socket-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/socket-mode")>();
  return { ...actual, SocketModeClient: class extends actual.SocketModeClient {
    constructor(options: import("@slack/socket-mode").SocketModeOptions) { super({ ...options, clientOptions: { ...options.clientOptions, slackApiUrl: endpoint.url } }); }
  } };
});
import { createSlackConnection } from "../src/connection.js";

let server: Server;
let connection: Connection;
let holdOpen = false;
let pending: ServerResponse | undefined;
let websocket: Socket | undefined;
let hello = true;
let opens = 0;
const sockets = new Set<Socket>();
beforeEach(async () => {
  holdOpen = false; pending = undefined; websocket = undefined; hello = true; opens = 0;
  server = createServer((request, response) => {
    request.resume();
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth.test") response.end(JSON.stringify({ ok: true, team_id: config.workspaceId, bot_id: "BBOT", user_id: "UBOT" }));
    else if (request.url === "/apps.connections.open") {
      opens++;
      if (holdOpen) pending = response;
      else response.end(JSON.stringify({ ok: true, url: endpoint.url.replace("http:", "ws:") + "socket" }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.on("upgrade", (request, socket) => {
    websocket = socket as Socket;
    const accept = createHash("sha1").update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (hello) { const body = Buffer.from('{"type":"hello"}'); socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body])); }
    // Deliberately ignore ping and close frames: teardown must destroy the socket.
    socket.on("data", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  endpoint.url = `http://127.0.0.1:${address.port}/`;
  connection = createSlackConnection(config, "xapp-synthetic", "xoxb-synthetic", vi.fn());
});
afterEach(async () => {
  await connection.stop().catch(() => {});
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
it("cancels actual apps.connections.open before a late response can open a socket", async () => {
  holdOpen = true;
  await connection.start(vi.fn());
  await vi.waitFor(() => expect(pending).toBeDefined());
  await connection.stop();
  await vi.waitFor(() => expect(pending!.destroyed).toBe(true));
  pending!.end(JSON.stringify({ ok: true, url: endpoint.url.replace("http:", "ws:") + "socket" }));
  expect(connection.isConnected()).toBe(false); expect(websocket).toBeUndefined(); expect(opens).toBe(1);
}, 10_000);
it("destroys an upgraded real WebSocket even when the peer ignores its close frame", async () => {
  await connection.start(vi.fn());
  await vi.waitFor(() => expect(connection.isConnected()).toBe(true));
  expect(websocket).toBeDefined();
  await connection.stop();
  // The HTTP server's upgraded peer is half-open; EOF proves the client's raw
  // socket closed even though this deliberately uncooperative peer stays open.
  await vi.waitFor(() => expect(websocket!.readableEnded).toBe(true));
  expect(connection.isConnected()).toBe(false); expect(opens).toBe(1);
}, 10_000);
it("cancels the real SDK hello wait and closes the upgraded socket on shutdown", async () => {
  hello = false;
  await connection.start(vi.fn());
  await vi.waitFor(() => expect(websocket).toBeDefined());
  expect(connection.isConnected()).toBe(false);
  await connection.stop();
  await vi.waitFor(() => expect(websocket!.readableEnded).toBe(true));
  expect(opens).toBe(1);
}, 10_000);
