import { Agent, createServer, request } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";

/** Test-owned ingress. Each request keeps the backend selected at admission;
 * switching traffic never retries a request or terminates its existing stream. */
export async function startRollingDeploymentProxy(port = 0) {
  let target: URL | undefined;
  const agent = new Agent({ keepAlive: true });
  const sockets = new Set<Socket>();
  const server = createServer((incoming, outgoing) => {
    const selected = target;
    if (!selected) { outgoing.writeHead(503).end(); return; }
    const upstream = request(selected, {
      path: incoming.url ?? "/",
      method: incoming.method,
      headers: { ...incoming.headers, host: selected.host },
      agent,
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
      response.on("error", () => outgoing.destroy());
    });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502).end();
      else outgoing.destroy();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (incoming, socket, head) => {
    if (!target) { socket.destroy(); return; }
    const upstream = request(target, {
      path: incoming.url ?? "/",
      headers: { ...incoming.headers, host: target.host }, agent: false,
    });
    socket.on("error", () => upstream.destroy());
    upstream.on("upgrade", (response, backend, backendHead) => {
      const headers = response.rawHeaders;
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`
        + headers.reduce((text, item, index) => text + (index % 2 ? `${item}\r\n` : `${item}: `), "") + "\r\n");
      if (backendHead.length) socket.write(backendHead);
      if (head.length) backend.write(head);
      backend.on("error", () => socket.destroy());
      socket.on("error", () => backend.destroy());
      backend.on("close", () => socket.destroy());
      socket.on("close", () => backend.destroy());
      backend.pipe(socket).pipe(backend);
    });
    upstream.on("response", response => { response.resume(); socket.destroy(); });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Proxy address unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    routeTo(origin: string) {
      const next = new URL(origin);
      if (next.protocol !== "http:" || next.hostname !== "127.0.0.1" || next.username || next.password) {
        throw new Error("Rolling deployment fixture backends must use loopback HTTP");
      }
      target = next;
    },
    async close() {
      const closed = once(server, "close");
      server.close();
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
