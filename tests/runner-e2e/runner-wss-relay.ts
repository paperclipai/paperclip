import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { allowsRunnerUpgrade } from "./runner-wss-tunnel.js";

/** Local side of a single persistent test relay; never forwards ordinary HTTP. */
export function createRunnerWssRelay(registryDirectory: string) {
  const server = http.createServer((_request, response) => {
    response.writeHead(404); response.end();
  });
  server.on("upgrade", async (request, socket, head) => {
    socket.on("error", () => undefined);
    const match = /^\/([a-f0-9-]{36})(\/api\/runner\/v1\/connect\/[A-Za-z0-9_-]+)$/.exec(request.url ?? "");
    if (!match || !allowsRunnerUpgrade(request.method, match[2])) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return;
    }
    try {
      const registration = JSON.parse(await readFile(path.join(registryDirectory, `${match[1]}.json`), "utf8"));
      if (!Number.isInteger(registration.port) || registration.port < 1024 || registration.port > 65535) throw new Error("Invalid relay registration");
      const upstream = net.connect(registration.port, "127.0.0.1");
      socket.on("close", () => upstream.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      upstream.on("connect", () => {
        const headers = Object.entries(request.headers).filter(([name]) => name !== "host")
          .flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).filter(v => v !== undefined).map(v => `${name}: ${v}`));
        upstream.write(`GET ${match[2]} HTTP/1.1\r\nHost: 127.0.0.1:${registration.port}\r\n${headers.join("\r\n")}\r\n\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
    } catch {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    }
  });
  return server;
}
