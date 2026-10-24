import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkPort } from "../utils/net.js";

type Listener = { server: net.Server; port: number; host: string };

async function listenOn(host: string): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("unexpected server address shape"));
        return;
      }
      resolve({ server, port: address.port, host });
    });
  });
}

function close(listener: Listener): Promise<void> {
  return new Promise((resolve) => listener.server.close(() => resolve()));
}

describe("checkPort", () => {
  const openListeners: Listener[] = [];

  afterEach(async () => {
    await Promise.all(openListeners.splice(0).map(close));
  });

  it("returns available=true for a free port on the default host", async () => {
    const tmp = await listenOn("127.0.0.1");
    const freePort = tmp.port;
    await close(tmp);

    const result = await checkPort(freePort);
    expect(result.available).toBe(true);
  });

  it("returns available=false when the port is bound on the requested host", async () => {
    const listener = await listenOn("127.0.0.1");
    openListeners.push(listener);

    const result = await checkPort(listener.port, "127.0.0.1");
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/already in use/);
  });

  it("treats distinct loopback hosts independently", async () => {
    let ipv6: Listener;
    try {
      ipv6 = await listenOn("::1");
    } catch {
      return;
    }
    openListeners.push(ipv6);

    const ipv4Result = await checkPort(ipv6.port, "127.0.0.1");
    expect(ipv4Result.available).toBe(true);

    const ipv6Result = await checkPort(ipv6.port, "::1");
    expect(ipv6Result.available).toBe(false);
  });
});
