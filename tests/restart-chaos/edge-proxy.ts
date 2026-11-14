/**
 * `--k15-overlap-seconds`: the wave's stable port in front of the serving deploy generation, as the hosting
 * platform's edge is in front of its containers. Each server of such a wave listens on its own loopback port;
 * the proxy forwards new connections to the current one. A K15 switches the target once the next generation is
 * ready, while the old server keeps its open connections until it is stopped, as a rolling deploy does.
 */
import net from "node:net";

export interface EdgeProxy {
  readonly port: number;
  /** The backend port new connections go to. */
  target: number;
  close(): Promise<void>;
}

export async function startEdgeProxy(port: number, target: number): Promise<EdgeProxy> {
  const sockets = new Set<net.Socket>();
  const proxy: EdgeProxy = { port, target, close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
  const server = net.createServer(client => {
    const upstream = net.connect(proxy.target, "127.0.0.1");
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      // A backend that is gone or restarting refuses the connection: the client sees a reset, as at the edge.
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return proxy;
}
