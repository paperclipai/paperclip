import net from "node:net";
import { describe, expect, it } from "vitest";
import { checkPort } from "./net.js";

// ============================================================================
// checkPort
// ============================================================================

describe("checkPort", () => {
  it("reports a free port as available", async () => {
    // Find a free port by binding to 0, note the port, then release it
    const tempServer = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      tempServer.once("error", reject);
      tempServer.listen(0, "127.0.0.1", () => {
        const addr = tempServer.address() as net.AddressInfo;
        tempServer.close(() => resolve(addr.port));
      });
    });

    const result = await checkPort(port);
    expect(result.available).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("reports an occupied port as unavailable", async () => {
    // Start a server to occupy a port
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });

    try {
      const result = await checkPort(port);
      expect(result.available).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain(String(port));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("includes an error message for an occupied port", async () => {
    const server = net.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        resolve((server.address() as net.AddressInfo).port);
      });
    });

    try {
      const result = await checkPort(port);
      expect(typeof result.error).toBe("string");
      expect((result.error ?? "").length).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
