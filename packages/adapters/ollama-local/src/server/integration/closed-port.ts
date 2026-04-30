import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Bind a loopback port, close it immediately, and return the URL. A fetch
 * against this URL will hit ECONNREFUSED almost instantly on every
 * supported platform, which is our deterministic way to exercise the
 * adapter's connection-refused error mapping in CI.
 *
 * Prefer this over a made-up port number: Node's undici rejects some ports
 * with "bad port" and falls back to a long connect-timeout on others (e.g.
 * WSL2 returns UND_ERR_CONNECT_TIMEOUT instead of ECONNREFUSED).
 */
export async function closedLoopbackUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return `http://127.0.0.1:${port}`;
}
