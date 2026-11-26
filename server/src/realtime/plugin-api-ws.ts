import { ServerResponse, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { validateHeaderName, validateHeaderValue } from "node:http";
import type { Request, Response } from "express";

export const pluginApiUpgrade = Symbol("pluginApiUpgrade");
type UpgradeRequest = IncomingMessage & {
  paperclipWebSocketHandled?: boolean;
  [pluginApiUpgrade]?: { socket: Socket; head: Buffer };
};

/** Reuse the full HTTP authentication/company pipeline for plugin upgrades. */
export function setupPluginApiWebSocketServer(server: Server, handler: RequestListener) {
  server.on("upgrade", (request: UpgradeRequest, socket: Socket, head: Buffer) => {
    if (request.paperclipWebSocketHandled || !/^\/api\/plugins\/[^/]+\/api\//.test(request.url ?? "")) return;
    request.paperclipWebSocketHandled = true;
    socket.on("error", () => socket.destroy());
    if (request.method !== "GET" || request.headers.upgrade?.toLowerCase() !== "websocket"
      || request.headers["content-length"] || request.headers["transfer-encoding"]) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    request[pluginApiUpgrade] = { socket, head };
    const response = new ServerResponse(request);
    response.assignSocket(socket);
    response.setHeader("Connection", "close");
    response.once("finish", () => socket.end());
    handler(request, response);
  });
}

/** Only worker-selected WSS targets and credentials reach the upstream. */
export function proxyPluginApiWebSocket(
  req: Request,
  res: Response,
  target: { url: string; headers?: Record<string, string> },
  available: () => boolean,
) {
  const upgrade = (req as UpgradeRequest)[pluginApiUpgrade];
  if (!upgrade || upgrade.socket.destroyed) return;
  const { socket, head } = upgrade;
  let url: URL;
  try {
    url = new URL(target.url);
    if (url.protocol !== "wss:" || url.username || url.password || url.hash) throw new Error();
    for (const [name, value] of Object.entries(target.headers ?? {})) { validateHeaderName(name); validateHeaderValue(name, value); }
    // A plugin may supply upstream authorization, never browser cookies/origin.
    if (Object.keys(target.headers ?? {}).some(key => /^(cookie|origin|host|connection|upgrade|sec-websocket-|x-forwarded-)/i.test(key))) throw new Error();
  } catch {
    res.status(502).json({ error: "Plugin connection unavailable" });
    return;
  }
  url.protocol = "https:";
  const headers: Record<string, string | string[]> = { ...target.headers, Connection: "Upgrade", Upgrade: "websocket" };
  for (const name of ["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]) {
    if (req.headers[name]) headers[name] = req.headers[name]!;
  }
  let connected = false;
  let upstream: Duplex | undefined;
  const fail = () => {
    if (!connected && !socket.destroyed && !res.headersSent) res.status(502).json({ error: "Plugin connection unavailable" });
    else socket.destroy();
  };
  let connection: ReturnType<typeof httpsRequest>;
  try { connection = httpsRequest(url, { method: "GET", headers, timeout: 15_000 }); }
  catch { fail(); return; }
  const cleanup = () => { clearInterval(watch); clearTimeout(lifetime); connection.destroy(); upstream?.destroy(); };
  // Periodic reconnect reauthorizes the browser through HTTP; it also bounds
  // how long a removed membership or changed plugin binding can retain access.
  const lifetime = setTimeout(() => socket.destroy(), 5 * 60_000);
  const watch = setInterval(() => { if (!available()) socket.destroy(); }, 5_000);
  lifetime.unref();
  watch.unref();
  socket.once("close", cleanup);
  connection.on("timeout", () => { connection.destroy(); fail(); });
  connection.on("error", fail);
  connection.on("response", response => { response.destroy(); fail(); });
  connection.on("upgrade", (response, remote, remoteHead) => {
    upstream = remote;
    if (socket.destroyed || !available() || response.statusCode !== 101) { remote.destroy(); fail(); return; }
    connected = true;
    connection.setTimeout(0);
    socket.setTimeout(0);
    res.detachSocket(socket);
    // Express request accounting must observe the lifetime of the upgraded stream.
    socket.once("close", () => res.emit("close"));
    let handshake = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n";
    for (const name of ["sec-websocket-accept", "sec-websocket-protocol", "sec-websocket-extensions"]) {
      const value = response.headers[name];
      if (typeof value === "string") handshake += `${name}: ${value}\r\n`;
    }
    socket.write(handshake + "\r\n");
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    remote.on("error", () => socket.destroy());
    remote.once("close", () => socket.destroy());
    socket.pipe(remote).pipe(socket);
  });
  connection.end();
}
