import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { withNativeBootstrapLifetimeQuorum } from "./native-quota-bootstrap-quorum.js";

const suite = process.platform === "win32" ? describe.skip : describe;
async function bind(port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
  return server;
}
const close = (server: Server) => new Promise<void>(resolve => server.close(() => resolve()));
async function bindPrivate(): Promise<Server> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await bind(49_152 + Math.floor(Math.random() * (65_536 - 49_152))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error; }
  }
  throw new Error("could not reserve a private-range test port");
}
suite("native bootstrap lifetime quorum", () => {
  it("holds two acquired ports until the commit callback settles", async () => {
    const reserved = await Promise.all([bindPrivate(), bindPrivate(), bindPrivate()]);
    const ports = reserved.map(server => (server.address() as { port: number }).port);
    await Promise.all(reserved.map(close));
    const result = await withNativeBootstrapLifetimeQuorum(ports, async () => {
      await expect(bind(ports[0])).rejects.toMatchObject({ code: "EADDRINUSE" });
      await expect(bind(ports[1])).rejects.toMatchObject({ code: "EADDRINUSE" });
      return "committed";
    });
    expect(result).toEqual({ acquired: true, value: "committed" });
    const available = await bind(ports[0]); await close(available);
  });
  it("refuses a held quorum without calling the action", async () => {
    const held = await Promise.all([bindPrivate(), bindPrivate(), bindPrivate()]);
    try {
      const ports = held.map(server => (server.address() as { port: number }).port);
      let called = false;
      expect(await withNativeBootstrapLifetimeQuorum(ports, async () => { called = true; })).toEqual({ acquired: false });
      expect(called).toBe(false);
    } finally { await Promise.all(held.map(close)); }
  });
});
