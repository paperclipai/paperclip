import { Agent, createServer, request, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";

/** Transparent, non-retrying S3 fault boundary. Preserve signed Host headers. */
export async function startRollingStorageProxy(endpoint: string) {
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
    throw new Error("Storage fault injection requires a loopback service");
  }
  let uploads: "pass" | "hold" | "reject" = "pass";
  const held = new Map<ServerResponse, (reject: boolean) => void>();
  const sockets = new Set<Socket>();
  const agent = new Agent({ keepAlive: true });
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === "PUT" && uploads === "reject") {
      incoming.resume();
      outgoing.writeHead(503).end();
      return;
    }
    const upstream = request(target, { method: incoming.method, path: incoming.url, headers: incoming.headers, agent }, response => {
      response.on("error", () => outgoing.destroy());
      const release = (reject: boolean) => {
        held.delete(outgoing);
        if (reject) { response.resume(); outgoing.writeHead(503).end(); }
        else { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); }
      };
      if (incoming.method === "PUT" && uploads === "hold") {
        held.set(outgoing, release);
        outgoing.on("close", () => { held.delete(outgoing); response.destroy(); });
      } else release(false);
    });
    upstream.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502).end(); else outgoing.destroy(); });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableFinished) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Storage proxy did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    get heldUploads() { return held.size; },
    holdUploads() { uploads = "hold"; },
    rejectUploads() {
      uploads = "reject";
      for (const release of held.values()) release(true);
      held.clear();
    },
    resumeUploads() { uploads = "pass"; for (const release of held.values()) release(false); },
    async close() {
      const closed = once(server, "close"); server.close(); agent.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
